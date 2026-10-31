import type { MusicSourceAdapter, Track } from "../../types/music";
import { getDiscoveryApiUrl } from "../../lib/runtime-config";

type DiscoverySource = "public" | "deezer";
type DiscoveryTrack = Track & { streamAccess: "provider_stream" | "preview" };
interface DiscoveryOptions {
  base?: string;
  fetcher?: typeof fetch;
}
class DiscoveryRequestError extends Error {
  readonly code: "rate" | "network";
  constructor(
    public status: number,
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "DiscoveryRequestError";
    this.code = status === 429 ? "rate" : "network";
  }
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");

function publicHttps(value: unknown) {
  try {
    const url = new URL(text(value));
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host)
      ? host.split(".").map(Number)
      : null;
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      url.href.length > 4096 ||
      host === "localhost" ||
      /\.(?:localhost|local|internal)$/.test(host) ||
      host.startsWith("[") ||
      (ipv4 &&
        (ipv4[0] === 0 ||
          ipv4[0] === 10 ||
          ipv4[0] === 127 ||
          ipv4[0] >= 224 ||
          (ipv4[0] === 169 && ipv4[1] === 254) ||
          (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
          (ipv4[0] === 192 && ipv4[1] === 168)))
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function apiBase(value: string) {
  if (value === "/") return "";
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname))
      )
    )
      return null;
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

const configuredBase = getDiscoveryApiUrl();
export const discoveryEnabled = apiBase(configuredBase) !== null;

export function createDiscoveryProvider(
  source: DiscoverySource,
  options: DiscoveryOptions = {},
): MusicSourceAdapter {
  const base = apiBase(options.base ?? configuredBase);
  const fetcher =
    options.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const sourceName =
    source === "public"
      ? "Публичный музыкальный каталог"
      : "Deezer · фрагменты";
  const validId = (id: string) =>
    new RegExp(`^${source}:[A-Za-z0-9_-]{1,200}$`).test(id);
  const cache = new Map<string, DiscoveryTrack>();
  const cooldowns = new Map<string, number>();

  function decode(value: unknown, allowAudio = false): DiscoveryTrack | null {
    const raw = object(value);
    const id = text(raw.id),
      title = text(raw.title),
      artist = text(raw.artist);
    const access = source === "public" ? "provider_stream" : "preview";
    if (
      raw.sourceId !== source ||
      !validId(id) ||
      !title.trim() ||
      title.length > 500 ||
      !artist.trim() ||
      artist.length > 500 ||
      typeof raw.duration !== "number" ||
      !Number.isFinite(raw.duration) ||
      raw.duration < 0 ||
      raw.duration > 86400 ||
      raw.streamAccess !== access ||
      raw.playbackMode !== "audio"
    )
      return null;
    const track: DiscoveryTrack = {
      id,
      sourceId: source,
      sourceName: text(raw.sourceName).slice(0, 120) || sourceName,
      title,
      artist,
      duration: raw.duration,
      album: text(raw.album).slice(0, 500) || undefined,
      artwork: publicHttps(raw.artwork),
      externalUrl: publicHttps(raw.externalUrl),
      genres: Array.isArray(raw.genres)
        ? raw.genres
            .filter(
              (genre): genre is string =>
                typeof genre === "string" && genre.length <= 100,
            )
            .slice(0, 20)
        : [],
      availability:
        raw.availability === "unavailable"
          ? "unavailable"
          : raw.availability === "available"
            ? "available"
            : "unknown",
      playbackMode: "audio",
      streamAccess: access,
      rights: {
        status: "unknown",
        basis: "none",
        allowMix: false,
        allowTelegramDelivery: false,
      },
      license: {
        name:
          text(object(raw.license).name).slice(0, 200) ||
          "Поток предоставлен источником",
        download: false,
      },
    };
    if (allowAudio && track.availability !== "unavailable") {
      const audio = object(raw.audioSource),
        url = publicHttps(audio.url);
      const expiresAt =
        typeof audio.expiresAt === "number" && Number.isFinite(audio.expiresAt)
          ? audio.expiresAt
          : undefined;
      if (url && (expiresAt === undefined || expiresAt > Date.now()))
        track.audioSource = { url, cors: audio.cors === true, expiresAt };
    }
    return track;
  }

  function remember(track: DiscoveryTrack) {
    cache.delete(track.id);
    cache.set(track.id, track);
    while (cache.size > 200) cache.delete(cache.keys().next().value!);
    return track;
  }

  async function request(
    path: string,
    signal?: AbortSignal,
    requestSource = source,
  ) {
    if (signal?.aborted) throw signal.reason;
    const budget = path.startsWith("track/") ? "playback" : "metadata";
    const remaining = Math.ceil(
      ((cooldowns.get(budget) ?? 0) - Date.now()) / 1000,
    );
    const rateError = (seconds: number) =>
      new DiscoveryRequestError(
        429,
        `${sourceName}: слишком много запросов. Повторите через ${seconds} с.`,
        seconds,
      );
    if (remaining > 0) throw rateError(remaining);
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    let rejectAbort: (reason: unknown) => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException(
            "Поиск источника занял слишком много времени.",
            "TimeoutError",
          ),
        ),
      10000,
    );
    try {
      return await Promise.race([
        (async () => {
          const response = await fetcher(
            `${base}/api/discovery/${requestSource}/${path}`,
            {
              signal: controller.signal,
              credentials: "omit",
              headers: { Accept: "application/json" },
            },
          );
          if (response.status === 429) {
            const value = response.headers.get("retry-after");
            const seconds =
              value && /^\d+$/.test(value.trim())
                ? Number(value)
                : value
                  ? Math.ceil((Date.parse(value) - Date.now()) / 1000)
                  : 60;
            const wait = Math.min(
              300,
              Math.max(1, Number.isFinite(seconds) ? seconds : 60),
            );
            cooldowns.set(budget, Date.now() + wait * 1000);
            throw rateError(wait);
          }
          if (!response.ok)
            throw new DiscoveryRequestError(
              response.status,
              `${sourceName}: источник временно недоступен (${response.status}).`,
            );
          return object(await response.json());
        })(),
        aborted,
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", onAbort);
    }
  }

  async function details(id: string, signal?: AbortSignal) {
    if (signal?.aborted) throw signal.reason;
    if (base === null || !validId(id)) return null;
    const payload = await request(`track/${encodeURIComponent(id)}`, signal);
    const track = decode(payload.track, true);
    return track?.id === id ? remember(track) : null;
  }

  const provider: MusicSourceAdapter = {
    id: source,
    name: sourceName,
    status: base === null ? "unavailable" : "available",
    playbackModes: ["audio"],
    async searchTracks(query, signal) {
      if (signal?.aborted) throw signal.reason;
      if (base === null) return [];
      const normalized = query
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 200);
      if (!normalized) return [];
      const payload = await request(
        `search?q=${encodeURIComponent(normalized)}`,
        signal,
      );
      if (!Array.isArray(payload.tracks))
        throw new Error(`${sourceName}: некорректный ответ поиска.`);
      const unique = new Map<string, DiscoveryTrack>();
      for (const raw of payload.tracks.slice(0, 100)) {
        const track = decode(raw);
        if (track) unique.set(track.id, remember(track));
      }
      return [...unique.values()];
    },
    getTrackDetails: details,
    async getTrack(id, signal) {
      if (signal?.aborted) throw signal.reason;
      return validId(id) && cache.has(id)
        ? cache.get(id)!
        : details(id, signal);
    },
    async resolveStream(track, signal) {
      if (track.sourceId !== source || !validId(track.id)) return null;
      let fresh: DiscoveryTrack | null;
      try {
        fresh = await details(track.id, signal);
      } catch (error) {
        if (
          source !== "public" ||
          signal?.aborted ||
          !(error instanceof DiscoveryRequestError) ||
          error.status !== 404
        )
          throw error;
        // The server's source map is ephemeral. Restore this exact identity
        // through ordinary search, never substitute another recording.
        const query = `${track.artist} ${track.title}`
          .normalize("NFKC")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 160);
        const matches = await provider.searchTracks(query, signal);
        if (!matches.some((match) => match.id === track.id)) return null;
        fresh = await details(track.id, signal);
      }
      if (!fresh?.audioSource) return null;
      Object.assign(track, fresh);
      return fresh.audioSource.url;
    },
    async getPlayableSource(id, signal) {
      const fresh = await details(id, signal);
      return fresh?.audioSource
        ? { ...fresh.audioSource, allowMix: false }
        : null;
    },
    async checkAvailability(track, signal) {
      if (signal?.aborted) throw signal.reason;
      return (
        base !== null &&
        decode(track) !== null &&
        track.availability !== "unavailable"
      );
    },
    async supportsDownload() {
      return false;
    },
    async getSimilarTracks(track, signal) {
      return provider.searchTracks(track.artist, signal);
    },
    async getRelatedArtists(artist, signal) {
      if (signal?.aborted) throw signal.reason;
      if (base === null) return [];
      if (artist.length > 160 || /\p{Cc}/u.test(artist)) return [];
      const name = artist.normalize("NFKC").trim().replace(/\s+/gu, " ");
      if (!name) return [];
      const payload = await request(
        `related?artist=${encodeURIComponent(name)}`,
        signal,
        "deezer",
      );
      if (!Array.isArray(payload.artists))
        throw new Error("Некорректный ответ подбора похожих исполнителей.");
      const seen = new Set([name.toLocaleLowerCase("ru")]);
      return payload.artists.slice(0, 12).flatMap((value) => {
        if (
          typeof value !== "string" ||
          value.length > 160 ||
          /\p{Cc}/u.test(value)
        )
          return [];
        const result = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
        const identity = result.toLocaleLowerCase("ru");
        if (!result || seen.has(identity)) return [];
        seen.add(identity);
        return [result];
      });
    },
  };
  return provider;
}

export const publicCatalogAdapter = createDiscoveryProvider("public");
export const deezerAdapter = createDiscoveryProvider("deezer");
