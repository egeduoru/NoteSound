import type { MusicSourceAdapter, Track } from "../../types/music";
import { getDiscoveryApiUrl } from "../../lib/runtime-config";

const safeSoundCloudUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "soundcloud.com" ||
      url.username || url.password || url.port || url.search || url.hash ||
      url.pathname.split("/").filter(Boolean).length !== 2
    ) return null;
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch { return null; }
};

export function validSoundCloudTrack(track: Track) {
  return track.sourceId === "soundcloud" &&
    /^soundcloud:[0-9]{1,24}$/.test(track.id) &&
    track.playbackMode === "embedded" &&
    track.availability !== "unavailable" &&
    track.rights?.allowMix === false &&
    track.license.download === false &&
    !!safeSoundCloudUrl(track.externalUrl);
}

function normalizeTrack(raw: unknown): Track | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<Track>;
  if (
    typeof row.id !== "string" ||
    typeof row.title !== "string" || row.title.length > 300 ||
    typeof row.artist !== "string" || row.artist.length > 300 ||
    !Number.isFinite(row.duration) || (row.duration ?? 0) < 0 ||
    (row.duration ?? 0) > 86400
  ) return null;
  const track: Track = {
    id: row.id, sourceId: "soundcloud", sourceName: "SoundCloud",
    title: row.title, artist: row.artist, duration: row.duration ?? 0,
    artwork: typeof row.artwork === "string" && /^https:\/\/i1\.sndcdn\.com\//.test(row.artwork) ? row.artwork : undefined,
    externalUrl: safeSoundCloudUrl(row.externalUrl) ?? undefined,
    platformId: typeof row.platformId === "string" ? row.platformId : undefined,
    genres: Array.isArray(row.genres) ? row.genres.filter((g): g is string => typeof g === "string" && g.length <= 80).slice(0, 8) : [],
    playbackMode: "embedded", availability: "available",
    rights: { status: "unknown", basis: "none", allowMix: false },
    license: { name: "SoundCloud · встроенный плеер", download: false },
  };
  return validSoundCloudTrack(track) ? track : null;
}

export function createSoundCloudAdapter(options: { base?: string; fetcher?: typeof fetch } = {}): MusicSourceAdapter {
  const base = options.base ?? getDiscoveryApiUrl();
  const fetcher = options.fetcher ?? fetch;
  const known = new Map<string, Track>();
  const cache = new Map<string, { until: number; tracks: Track[] }>();
  const request = async (url: string, signal?: AbortSignal) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(cancel, 9500);
    try {
      const response = await fetcher(url, { signal: controller.signal, credentials: "omit", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`SoundCloud: сервис недоступен (${response.status}).`);
      return await response.json() as Record<string, unknown>;
    } finally { clearTimeout(timeout); signal?.removeEventListener("abort", cancel); }
  };
  const verified = new Map<string, { until: number; ok: boolean }>();
  const checkEmbed = async (track: Track, signal?: AbortSignal) => {
    if (!validSoundCloudTrack(track)) return false;
    const url = track.externalUrl!;
    const previous = verified.get(url);
    if (previous && previous.until > Date.now()) return previous.ok;
    const endpoint = new URL("https://soundcloud.com/oembed");
    endpoint.searchParams.set("url", url);
    endpoint.searchParams.set("format", "json");
    let ok = false;
    try {
      const result = await request(endpoint.href, signal);
      ok = result.provider_name === "SoundCloud" &&
        typeof result.html === "string" && /w\.soundcloud\.com\/player\//.test(result.html);
    } catch { /* Inaccessible or removed recordings must not be played. */ }
    if (!signal?.aborted) verified.set(url, { until: Date.now() + (ok ? 30 * 60000 : 60000), ok });
    if (verified.size > 100) verified.delete(verified.keys().next().value!);
    return ok;
  };
  return {
    id: "soundcloud", name: "SoundCloud", status: base ? "experimental" : "unavailable",
    playbackModes: ["embedded"],
    async searchTracks(query, signal) {
      if (!base || signal?.aborted) return [];
      const q = query.normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 120);
      if (!q) return [];
      const hit = cache.get(q);
      if (hit && hit.until > Date.now()) return hit.tracks;
      const data = await request(`${base === "/" ? "" : base}/api/discovery/soundcloud/search?q=${encodeURIComponent(q)}`, signal);
      const tracks = Array.isArray(data.tracks) ? data.tracks.map(normalizeTrack).filter((t): t is Track => !!t) : [];
      for (const track of tracks) known.set(track.id, track);
      cache.set(q, { until: Date.now() + 900000, tracks });
      if (cache.size > 50) cache.delete(cache.keys().next().value!);
      return tracks;
    },
    async getTrackDetails(id) { return known.get(id) || null; },
    async getTrack(id) { return known.get(id) || null; },
    async resolveStream(track, signal) { return await checkEmbed(track, signal) ? track.externalUrl ?? null : null; },
    checkAvailability: checkEmbed,
    async supportsDownload() { return false; },
  };
}
export const soundcloudAdapter = createSoundCloudAdapter();
