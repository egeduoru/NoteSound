import type {
  MusicSourceAdapter,
  ProviderSearchPage,
  Track,
} from "../../types/music";
import { deduplicateTracks, normalizeText } from "../../lib/normalize";
import { safeHttps } from "../../services/search/normalize";

const API = "https://www.googleapis.com/youtube/v3/";
const cache = new Map<string, { at: number; result: ProviderSearchPage }>();
const details = new Map<string, Track>();
const failedVideos = new Map<string, number>();
const TTL = 15 * 60_000;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
// JavaScript's \b only recognizes ASCII word characters, so use Unicode edges.
const titleMarker = (pattern: string) =>
  new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${pattern})(?=$|[^\\p{L}\\p{N}])`, "iu");
const nonSongTitle = titleMarker(
  "react(?:ions?|s|ing|ed)?|reviews?|tutorials?|interviews?|lessons?|backstage|behind[\\s-]+the[\\s-]+scenes|making[\\s-]+of|teasers?|trailers?|snippets?|previews?|shorts|реакци(?:я|и|ю|й|ей|ями)|обзор(?:ы|а|ов|ом)?|разбор(?:ы|а|ов|ом)?|интервью|урок(?:и|а|ов|ом)?|туториал(?:ы|а)?|б[эе]кстейдж|закулисье|тизер(?:ы|а)?|трейлер(?:ы|а)?|сниппет(?:ы|а)?|превью|фрагмент(?:ы|а)?|отрыв(?:ок|ки|ка)|анонс(?:ы|а)?",
);
const officialTitle = titleMarker("official|официальн(?:ый|ое|ая|ые)");
const recordingVersions = [
  titleMarker("remix|ремикс"),
  titleMarker("live|концерт(?:ный|ная|ное|е)?"),
  titleMarker("cover|кавер"),
  titleMarker("acoustic|акустик(?:а|и)?|акустическ(?:ий|ая|ое|ие)"),
  titleMarker("karaoke|караоке"),
  titleMarker("instrumentals?|инструментал(?:ьн(?:ый|ая|ое|ые))?"),
  titleMarker("slowed"),
  titleMarker("sped[\\s-]*up"),
  titleMarker("nightcore|найткор"),
];
export const hasYouTubeKey = () =>
  !!import.meta.env.VITE_YOUTUBE_API_KEY?.trim();
export class YouTubeSearchError extends Error {
  constructor(
    public code:
      "missing_key" | "quota" | "credentials" | "network" | "response",
    message: string,
  ) {
    super(message);
    this.name = "YouTubeSearchError";
  }
}
export function reportYouTubeAvailability(videoId: string, available: boolean) {
  if (available) failedVideos.delete(videoId);
  else failedVideos.set(videoId, Date.now());
}
export function youtubeVideoId(track: Track) {
  return track.sourceId === "youtube" && /^youtube:[\w-]{11}$/.test(track.id)
    ? track.id.slice(8)
    : null;
}
export function parseDuration(value: unknown): number {
  const match = text(value).match(
    /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/,
  );
  return match
    ? Number(match[1] || 0) * 86400 +
        Number(match[2] || 0) * 3600 +
        Number(match[3] || 0) * 60 +
        Number(match[4] || 0)
    : 0;
}
function decode(value: string) {
  return value.replace(
    /&(amp|quot|apos|lt|gt|#39|#x27);/g,
    (_, entity: string) =>
      ({
        amp: "&",
        quot: '"',
        apos: "'",
        lt: "<",
        gt: ">",
        "#39": "'",
        "#x27": "'",
      })[entity] || "",
  );
}
export function parseYouTubeVideo(value: unknown): Track | null {
  const raw = record(value),
    snippet = record(raw.snippet),
    status = record(raw.status),
    content = record(raw.contentDetails);
  const id = text(raw.id),
    rawTitle = decode(text(snippet.title)).slice(0, 500),
    channel = decode(text(snippet.channelTitle)).slice(0, 250);
  const duration = parseDuration(content.duration);
  const isTopicChannel = /\s- Topic$/i.test(channel);
  if (
    !/^[\w-]{11}$/.test(id) ||
    !rawTitle ||
    !channel ||
    status.embeddable !== true ||
    status.privacyStatus !== "public" ||
    snippet.categoryId !== "10" ||
    (snippet.liveBroadcastContent && snippet.liveBroadcastContent !== "none") ||
    duration < 40 ||
    duration > 7200 ||
    record(content.contentRating).ytRating === "ytAgeRestricted"
  )
    return null;
  if (!isTopicChannel && nonSongTitle.test(rawTitle.normalize("NFKC")))
    return null;
  const split = rawTitle.match(/^(.{1,180}?)\s+[-–—]\s+(.+)$/);
  const artist = split?.[1] || channel.replace(/\s*[-–—]\s*Topic$/i, "");
  const title = (split?.[2] || rawTitle)
    .replace(
      /\s*\((?:official\s*(?:audio|music\s*video|video)|официальн(?:ый|ое)\s*(?:клип|видео|аудио))\)\s*/gi,
      " ",
    )
    .trim();
  const thumbs = record(snippet.thumbnails);
  return {
    id: `youtube:${id}`,
    sourceId: "youtube",
    platformId: id,
    title,
    artist,
    album: channel,
    duration,
    artwork:
      safeHttps(record(thumbs.high).url) ||
      safeHttps(record(thumbs.medium).url) ||
      `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    genres: ["music"],
    playback: { kind: "youtube", videoId: id },
    playbackMode: "embedded",
    externalUrl: `https://www.youtube.com/watch?v=${id}`,
    metadata: {
      channelTitle: channel,
      originalTitle: rawTitle,
      publication: isTopicChannel
        ? "topic"
        : officialTitle.test(rawTitle)
          ? "official_title"
          : "music",
    },
    license: {
      name: "YouTube · официальный видеоплеер",
      url: "https://www.youtube.com/t/terms",
      download: false,
    },
  };
}
const comparable = (value: string) =>
  normalizeText(value).replace(
    /[103457]/g,
    (digit) =>
      ({ "1": "i", "0": "o", "3": "e", "4": "a", "5": "s", "7": "t" })[digit]!,
  );
export function rankYouTubeTracks(tracks: Track[], query: string) {
  const words = comparable(query).split(" ").filter(Boolean);
  const score = (track: Track) => {
    const label = comparable(`${track.title} ${track.artist}`);
    return (
      words.reduce((n, word) => n + (label.includes(word) ? 12 : 0), 0) +
      (track.metadata?.publication === "topic"
        ? 15
        : track.metadata?.publication === "official_title"
          ? 10
          : 0) -
      (recordingVersions.some(
        (version) => version.test(track.title) && !version.test(query),
      )
        ? 18
        : 0)
    );
  };
  return deduplicateTracks([...tracks].sort((a, b) => score(b) - score(a)));
}
function abort(signal?: AbortSignal) {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException("Поиск отменён", "AbortError");
}
export function createYouTubeProvider(
  getKey: () => string = () =>
    import.meta.env.VITE_YOUTUBE_API_KEY?.trim() || "",
  fetcher: typeof fetch = (...args) => fetch(...args),
): MusicSourceAdapter & {
  searchPage: (
    query: string,
    options?: { pageToken?: string; signal?: AbortSignal },
  ) => Promise<ProviderSearchPage>;
} {
  async function request(
    endpoint: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ) {
    abort(signal);
    const key = getKey();
    if (!key)
      throw new YouTubeSearchError(
        "missing_key",
        "Поиск YouTube ещё не настроен: владельцу приложения нужно добавить ключ YouTube Data API v3. Вход в Google пользователю не требуется.",
      );
    const url = new URL(endpoint, API);
    Object.entries({ ...params, key }).forEach(([k, v]) =>
      url.searchParams.set(k, v),
    );
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException("Время ожидания YouTube истекло", "TimeoutError"),
        ),
      9000,
    );
    try {
      const response = await fetcher(url.href, {
        signal: controller.signal,
        credentials: "omit",
        referrerPolicy: "strict-origin-when-cross-origin",
      });
      const payload = record(await response.json());
      if (!response.ok) {
        const error = record(payload.error),
          reasons = (Array.isArray(error.errors) ? error.errors : []).map(
            (item) => text(record(item).reason),
          );
        if (
          reasons.some((reason) => /quota|dailyLimit|rateLimit/i.test(reason))
        )
          throw new YouTubeSearchError(
            "quota",
            "Лимит поиска YouTube исчерпан. Сохранённые записи можно открыть по ссылке; новые запросы попробуйте позже.",
          );
        if (
          response.status === 400 ||
          response.status === 401 ||
          response.status === 403
        )
          throw new YouTubeSearchError(
            "credentials",
            "YouTube отклонил ключ или настройки доступа. Владельцу нужно проверить включение API и разрешённые адреса сайта.",
          );
        throw new YouTubeSearchError(
          "response",
          `YouTube временно недоступен (HTTP ${response.status}).`,
        );
      }
      return payload;
    } catch (error) {
      abort(signal);
      if (error instanceof YouTubeSearchError) throw error;
      throw new YouTubeSearchError(
        "network",
        controller.signal.aborted
          ? "YouTube не ответил вовремя. Повторите поиск."
          : "Не удалось связаться с YouTube. Проверьте интернет и повторите поиск.",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }
  const provider: MusicSourceAdapter & {
    searchPage: (
      query: string,
      options?: { pageToken?: string; signal?: AbortSignal },
    ) => Promise<ProviderSearchPage>;
  } = {
    id: "youtube",
    name: "YouTube",
    status: getKey() ? "experimental" : "authentication_required",
    playbackModes: ["embedded"],
    async searchPage(query, options = {}) {
      abort(options.signal);
      const normalized = query
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 300);
      if (!normalized) return { tracks: [] };
      if (!getKey()) {
        provider.status = "authentication_required";
        throw new YouTubeSearchError(
          "missing_key",
          "Поиск YouTube ещё не настроен: добавьте ключ YouTube Data API v3 при публикации. Откройте настройки NoteSound для инструкции.",
        );
      }
      const cacheKey = `${getKey().slice(-6)}:${normalizeText(normalized)}:${options.pageToken || ""}`;
      const hit = cache.get(cacheKey);
      if (hit && Date.now() - hit.at < TTL) return hit.result;
      const params: Record<string, string> = {
        part: "snippet",
        type: "video",
        q: normalized,
        videoCategoryId: "10",
        videoEmbeddable: "true",
        videoSyndicated: "true",
        maxResults: "20",
        order: "relevance",
        safeSearch: "moderate",
        relevanceLanguage: "ru",
      };
      if (options.pageToken) params.pageToken = options.pageToken;
      const results = await request("search", params, options.signal);
      const items = Array.isArray(results.items) ? results.items : [];
      const ids = items
        .map((item) => text(record(record(item).id).videoId))
        .filter((id) => /^[\w-]{11}$/.test(id));
      const videos = ids.length
        ? await request(
            "videos",
            {
              part: "snippet,contentDetails,status",
              id: [...new Set(ids)].join(","),
            },
            options.signal,
          )
        : { items: [] };
      abort(options.signal);
      const tracks = rankYouTubeTracks(
        (Array.isArray(videos.items) ? videos.items : [])
          .map(parseYouTubeVideo)
          .filter((track): track is Track => !!track),
        normalized,
      );
      for (const track of tracks) details.set(track.id, track);
      const result: ProviderSearchPage = {
        tracks,
        nextPageToken: text(results.nextPageToken) || undefined,
      };
      if (cache.size >= 80) cache.delete(cache.keys().next().value!);
      cache.set(cacheKey, { at: Date.now(), result });
      provider.status = "available";
      return result;
    },
    async searchTracks(query, signal) {
      return (await provider.searchPage(query, { signal })).tracks;
    },
    async getTrackDetails(id, signal) {
      abort(signal);
      if (!/^youtube:[\w-]{11}$/.test(id)) return null;
      if (details.has(id)) return details.get(id)!;
      const payload = await request(
        "videos",
        { part: "snippet,contentDetails,status", id: id.slice(8) },
        signal,
      );
      const track = parseYouTubeVideo(
        (Array.isArray(payload.items) ? payload.items : [])[0],
      );
      if (track) details.set(id, track);
      return track;
    },
    async resolveStream(_track, signal) {
      abort(signal);
      return null;
    },
    async checkAvailability(track, signal) {
      abort(signal);
      const id = youtubeVideoId(track);
      return (
        !!id &&
        track.playback?.kind === "youtube" &&
        track.playback.videoId === id &&
        (!failedVideos.has(id) || Date.now() - failedVideos.get(id)! > 300_000)
      );
    },
    async getSimilarTracks(track, signal) {
      return provider.searchTracks(track.artist, signal);
    },
    async supportsDownload() {
      return false;
    },
  };
  return provider;
}
export const youtubeAdapter = createYouTubeProvider();
