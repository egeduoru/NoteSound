import type { MusicSourceAdapter, Track } from "../../types/music";
import { deduplicateTracks } from "../../lib/normalize";
export { normalizeHitmozPayload as parseHitmozPayload } from "../../../server/catalog-model.mjs";

type AudioSource = NonNullable<Track["audioSource"]> & { allowMix?: boolean };
export class MusicCatalogError extends Error {
  constructor(
    public code: "disabled" | "network" | "format" | "auth" | "rate",
    message: string,
  ) {
    super(message);
    this.name = "MusicCatalogError";
  }
}
interface CatalogOptions {
  apiUrl?: string;
  fetcher?: typeof fetch;
  getInitData?: () => string;
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
function https(value: unknown) {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443")
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
function apiBase(value: string) {
  if (value === "/") return "";
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
function decodeTrack(
  value: unknown,
  source: "hitmoz" | "licensed",
): Track | null {
  const raw = record(value),
    rights = record(raw.rights),
    license = record(raw.license);
  const id = text(raw.id),
    title = text(raw.title),
    artist = text(raw.artist);
  if (
    raw.sourceId !== source ||
    !new RegExp(`^${source}:[\\w-]{1,200}$`).test(id) ||
    !title ||
    title.length > 500 ||
    !artist ||
    artist.length > 500 ||
    typeof raw.duration !== "number" ||
    !Number.isFinite(raw.duration) ||
    raw.duration < 0 ||
    raw.duration > 86400
  )
    return null;
  const confirmed =
    rights.status === "confirmed" &&
    ["cc0", "license"].includes(text(rights.basis)) &&
    !!text(rights.evidence);
  const track: Track = {
    id,
    sourceId: source,
    sourceName:
      source === "hitmoz"
        ? "Hitmoz"
        : text(raw.sourceName) || "Разрешённый аудиокаталог",
    title,
    artist,
    duration: raw.duration,
    genres: Array.isArray(raw.genres)
      ? raw.genres
          .filter((g): g is string => typeof g === "string")
          .slice(0, 20)
      : [],
    artwork: https(raw.artwork),
    externalUrl: https(raw.externalUrl),
    popularity:
      typeof raw.popularity === "number" && Number.isFinite(raw.popularity)
        ? raw.popularity
        : undefined,
    availability:
      raw.availability === "unavailable" ? "unavailable" : "unknown",
    playbackMode:
      confirmed && raw.playbackMode === "audio" ? "audio" : "metadata",
    rights: {
      status: confirmed
        ? "confirmed"
        : rights.status === "denied"
          ? "denied"
          : "unknown",
      basis: confirmed ? (rights.basis as "cc0" | "license") : "none",
      allowMix: false,
      evidence: confirmed ? text(rights.evidence) : undefined,
    },
    license: {
      name: text(license.name) || "Права не подтверждены",
      download: false,
    },
  };
  const cue = record(raw.cuePoints);
  if (
    confirmed &&
    ["manual", "licensed_metadata", "analysis"].includes(text(cue.cueSource)) &&
    typeof cue.cueConfidence === "number" &&
    cue.cueConfidence >= 0 &&
    cue.cueConfidence <= 1
  ) {
    track.cuePoints = {
      cueConfidence: cue.cueConfidence,
      cueSource: cue.cueSource as "manual" | "licensed_metadata" | "analysis",
    };
    if (
      typeof cue.cueInSeconds === "number" &&
      cue.cueInSeconds >= 0 &&
      cue.cueInSeconds < track.duration
    )
      track.cuePoints.cueInSeconds = cue.cueInSeconds;
    if (
      typeof cue.cueOutSeconds === "number" &&
      cue.cueOutSeconds > 0 &&
      cue.cueOutSeconds <= track.duration
    )
      track.cuePoints.cueOutSeconds = cue.cueOutSeconds;
  }
  return track;
}
export function createRemoteCatalogProvider(
  source: "hitmoz" | "licensed",
  options: CatalogOptions = {},
) {
  const configured = options.apiUrl ?? import.meta.env.VITE_MUSIC_API_URL ?? "";
  const base = configured ? apiBase(configured) : null;
  const fetcher =
    options.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const getInitData =
    options.getInitData ??
    (() =>
      typeof window !== "undefined"
        ? window.Telegram?.WebApp?.initData || ""
        : "");
  const cache = new Map<string, { at: number; tracks: Track[] }>(),
    details = new Map<string, Track>();
  let sessionToken = "",
    sessionExpiresAt = 0,
    sessionInitData = "";
  let authenticationRequired: boolean | undefined;
  let sessionRequest: Promise<void> | undefined;
  async function sessionHeaders(
    signal: AbortSignal,
    refresh = false,
  ): Promise<Record<string, string>> {
    const initData = getInitData();
    if (!initData) return {};
    if (sessionInitData !== initData) {
      sessionToken = "";
      sessionExpiresAt = 0;
      authenticationRequired = undefined;
      sessionInitData = initData;
      sessionRequest = undefined;
    }
    if (refresh) {
      sessionToken = "";
      sessionExpiresAt = 0;
      authenticationRequired = undefined;
    }
    if (authenticationRequired === false) return {};
    if (sessionToken && sessionExpiresAt > Date.now() + 1000)
      return { "X-NoteSound-Session": sessionToken };
    if (!sessionRequest)
      sessionRequest = (async () => {
        const response = await fetcher(`${base}/api/auth/session`, {
          signal,
          credentials: "omit",
          headers: { "X-Telegram-Init-Data": initData },
          referrerPolicy: "strict-origin-when-cross-origin",
        });
        const payload = record(await response.json());
        if (!response.ok)
          throw new MusicCatalogError(
            response.status === 401
              ? "auth"
              : response.status === 429
                ? "rate"
                : "network",
            text(payload.message) ||
              "Не удалось проверить сеанс Telegram. Откройте приложение заново.",
          );
        if (payload.authenticationRequired === false) {
          authenticationRequired = false;
          return;
        }
        const token = text(payload.sessionToken),
          expires = payload.expiresAt;
        if (
          !token ||
          token.length > 2048 ||
          typeof expires !== "number" ||
          !Number.isFinite(expires) ||
          expires <= Date.now() ||
          expires > Date.now() + 86400000
        )
          throw new MusicCatalogError(
            "format",
            "Сервер вернул некорректный сеанс.",
          );
        if (getInitData() !== initData)
          throw new DOMException("Профиль изменился", "AbortError");
        sessionToken = token;
        sessionExpiresAt = expires;
        authenticationRequired = true;
      })().finally(() => {
        sessionRequest = undefined;
      });
    await sessionRequest;
    return sessionToken ? { "X-NoteSound-Session": sessionToken } : {};
  }
  async function request(
    path: string,
    params: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted)
      throw signal.reason ?? new DOMException("Запрос отменён", "AbortError");
    if (base === null)
      throw new MusicCatalogError(
        "disabled",
        "Сервер музыкального каталога ещё не подключён.",
      );
    const controller = new AbortController(),
      cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const query = new URLSearchParams({ ...params, source });
      let headers = await sessionHeaders(controller.signal);
      let response = await fetcher(`${base}/api/catalog/${path}?${query}`, {
        signal: controller.signal,
        credentials: "omit",
        headers,
        referrerPolicy: "strict-origin-when-cross-origin",
      });
      if (response.status === 401 && getInitData() && sessionToken) {
        headers = await sessionHeaders(controller.signal, true);
        response = await fetcher(`${base}/api/catalog/${path}?${query}`, {
          signal: controller.signal,
          credentials: "omit",
          headers,
          referrerPolicy: "strict-origin-when-cross-origin",
        });
      }
      const payload = record(await response.json());
      if (!response.ok)
        throw new MusicCatalogError(
          response.status === 401
            ? "auth"
            : response.status === 429
              ? "rate"
              : "network",
          text(payload.message) || "Сервер каталога временно недоступен.",
        );
      return payload;
    } catch (error) {
      if (signal?.aborted)
        throw signal.reason ?? new DOMException("Запрос отменён", "AbortError");
      if (error instanceof MusicCatalogError) throw error;
      throw new MusicCatalogError(
        "network",
        "Не удалось связаться с музыкальным каталогом. Повторите попытку.",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }
  async function list(path: string, query: string, signal?: AbortSignal) {
    const key = `${path}:${query.toLocaleLowerCase()}`,
      hit = cache.get(key);
    if (signal?.aborted)
      throw signal.reason ?? new DOMException("Запрос отменён", "AbortError");
    if (base === null) return [];
    const ttl = path === "top" ? 900000 : 300000;
    if (hit && Date.now() - hit.at < ttl) return hit.tracks;
    const payload = await request(path, query ? { q: query } : {}, signal);
    if (payload.enabled === false) {
      provider.status = "restricted";
      throw new MusicCatalogError(
        "disabled",
        text(payload.warning) ||
          "Источник отключён до подтверждения разрешения.",
      );
    }
    if (!Array.isArray(payload.tracks))
      throw new MusicCatalogError(
        "format",
        "Формат ответа музыкального каталога изменился.",
      );
    const tracks = deduplicateTracks(
      payload.tracks
        .map((value) => decodeTrack(value, source))
        .filter((track): track is Track => !!track),
    );
    for (const track of tracks) details.set(track.id, track);
    while (cache.size >= 80) cache.delete(cache.keys().next().value!);
    while (details.size > 2000) details.delete(details.keys().next().value!);
    cache.set(key, { at: Date.now(), tracks });
    provider.status = "available";
    return tracks;
  }
  const provider: MusicSourceAdapter & {
    getTopTracks: (signal?: AbortSignal) => Promise<Track[]>;
    getTrack: (id: string, signal?: AbortSignal) => Promise<Track | null>;
    getPlayableSource: (
      id: string,
      signal?: AbortSignal,
    ) => Promise<AudioSource | null>;
  } = {
    id: source,
    name:
      source === "hitmoz"
        ? "Hitmoz · подключаемый каталог"
        : "Разрешённый аудиокаталог",
    status: base === null ? "unavailable" : "experimental",
    playbackModes: ["metadata", "audio"],
    async searchTracks(query, signal) {
      const normalized = query
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 300);
      return normalized ? list("search", normalized, signal) : [];
    },
    getTopTracks(signal) {
      return list("top", "", signal);
    },
    async getTrack(id, signal) {
      if (!id.startsWith(`${source}:`) || base === null) return null;
      if (details.has(id)) return details.get(id)!;
      const payload = await request(
          `track/${encodeURIComponent(id)}`,
          {},
          signal,
        ),
        track = decodeTrack(payload.track, source);
      if (track) details.set(id, track);
      return track;
    },
    getTrackDetails(id, signal) {
      return provider.getTrack(id, signal);
    },
    async getPlayableSource(id, signal) {
      const track = await provider.getTrack(id, signal);
      if (
        track?.rights?.status !== "confirmed" ||
        track.playbackMode !== "audio"
      )
        return null;
      try {
        const payload = await request(
            `playable/${encodeURIComponent(id)}`,
            {},
            signal,
          ),
          raw = record(payload.source),
          url = https(raw.url);
        if (payload.rightsConfirmed !== true || !url) return null;
        const result: AudioSource = {
          url,
          cors: raw.cors === true,
          allowMix: raw.allowMix === true,
          expiresAt:
            typeof raw.expiresAt === "number" && Number.isFinite(raw.expiresAt)
              ? raw.expiresAt
              : undefined,
        };
        track.audioSource = result;
        track.availability = "available";
        track.rights.allowMix = result.allowMix === true && result.cors;
        return result;
      } catch (error) {
        if (signal?.aborted) throw error;
        track.availability = "unavailable";
        return null;
      }
    },
    async resolveStream(track, signal) {
      const source = await provider.getPlayableSource(track.id, signal);
      if (source) {
        track.audioSource = source;
        if (track.rights)
          track.rights.allowMix = source.allowMix === true && source.cors;
        track.availability = "available";
      }
      return source?.url ?? null;
    },
    async checkAvailability(track, signal) {
      return !!(await provider.getPlayableSource(track.id, signal));
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
export const createHitmozProvider = (options: CatalogOptions = {}) =>
  createRemoteCatalogProvider("hitmoz", options);
export const hitmozAdapter = createHitmozProvider();
