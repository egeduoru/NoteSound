import { safePublicUrl } from "./catalog-model.mjs";
import { guardedRequest } from "./security.mjs";

const API_HOST = "api.deezer.com";
const PREVIEW_HOSTS = ["cdnt-preview.dzcdn.net", "cdn-preview.dzcdn.net"];
const ARTWORK_HOSTS = ["cdn-images.dzcdn.net", "e-cdns-images.dzcdn.net"];
const TERMS = "https://cdn-content.dzcdn.net/pdf/CGU-developers.pdf";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_KEYS = 200;
const clean = (value, limit = 300) =>
  typeof value === "string"
    ? Array.from(value.normalize("NFKC"))
        .filter(
          (character) =>
            character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        )
        .join("")
        .trim()
        .slice(0, limit)
    : "";
const artistKey = (value) =>
  clean(value, 160).replace(/\s+/gu, " ").toLocaleLowerCase("ru");

function numericId(value) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string") return null;
  const match = /^(?:deezer:)?([1-9]\d{0,14})$/.exec(text);
  return match && Number.isSafeInteger(Number(match[1])) ? match[1] : null;
}

function normalizeTrack(row, { includePreview = false, now = Date.now } = {}) {
  if (!row || typeof row !== "object") return null;
  const id = numericId(row.id);
  const title = clean(row.title);
  const contributors = Array.isArray(row.contributors)
    ? [
        ...new Set(
          row.contributors.map((artist) => clean(artist?.name)).filter(Boolean),
        ),
      ]
    : [];
  const artist = contributors.join(", ") || clean(row.artist?.name);
  const duration = Number(row.duration);
  if (
    !id ||
    !title ||
    !artist ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 86400
  )
    return null;
  const preview = safePublicUrl(row.preview, PREVIEW_HOSTS);
  const artwork =
    safePublicUrl(row.album?.cover_big, ARTWORK_HOSTS) ||
    safePublicUrl(row.album?.cover_medium, ARTWORK_HOSTS);
  const track = {
    id: `deezer:${id}`,
    platformId: id,
    sourceId: "deezer",
    sourceName: "Deezer",
    title,
    artist,
    album: clean(row.album?.title) || undefined,
    duration,
    artwork: artwork || undefined,
    genres: [],
    metadata: { preview: "true", previewDurationSeconds: "30" },
    streamAccess: "preview",
    availability: preview ? "available" : "unavailable",
    playbackMode: preview ? "audio" : "metadata",
    rights: { status: "unknown", basis: "none", allowMix: false },
    license: {
      name: "Deezer · фрагмент 30 секунд",
      url: TERMS,
      download: false,
    },
    // Construct this from the validated id, rather than trusting an upstream link.
    externalUrl: `https://www.deezer.com/track/${id}`,
  };
  if (includePreview && preview)
    track.audioSource = { url: preview, cors: true, expiresAt: now() + 60_000 };
  return track;
}

export function createDeezerService({
  externalRequest = guardedRequest,
  now = Date.now,
} = {}) {
  const cache = new Map();

  async function read(path, signal) {
    const response = await externalRequest(`https://${API_HOST}${path}`, {
      allowedHosts: [API_HOST],
      timeoutMs: 8000,
      maxBytes: MAX_BYTES,
      signal,
    });
    if (
      (response.status !== undefined &&
        (response.status < 200 || response.status >= 300)) ||
      typeof response.body !== "string" ||
      Buffer.byteLength(response.body) > MAX_BYTES
    )
      throw new Error("Deezer returned an invalid response");
    const type = response.headers?.["content-type"];
    if (type && !/^application\/json\b/i.test(type))
      throw new Error("Deezer returned a non-JSON response");
    let payload;
    try {
      payload = JSON.parse(response.body);
    } catch {
      throw new Error("Deezer returned invalid JSON");
    }
    if (!payload || typeof payload !== "object" || payload.error)
      throw new Error("Deezer is temporarily unavailable");
    return payload;
  }

  function remember(key, value) {
    const timestamp = now();
    for (const [storedKey, item] of cache)
      if (item.until <= timestamp) cache.delete(storedKey);
    if (cache.size >= MAX_CACHE_KEYS) cache.delete(cache.keys().next().value);
    cache.set(key, { until: timestamp + 60_000, value });
    return structuredClone(value);
  }

  return {
    async search(query, signal) {
      if (typeof query !== "string" || query.length > 160)
        throw new Error("Invalid Deezer search query");
      const text = clean(query, 160);
      if (!text) return { tracks: [] };
      const key = `search:${text.toLocaleLowerCase("ru")}`;
      const hit = cache.get(key);
      if (hit && hit.until > now()) return structuredClone(hit.value);
      const params = new URLSearchParams({ q: text, limit: "25" });
      const payload = await read(`/search?${params}`, signal);
      if (!Array.isArray(payload.data))
        throw new Error("Deezer search format changed");
      const seen = new Set();
      const tracks = payload.data.slice(0, 25).flatMap((row) => {
        const track = normalizeTrack(row);
        if (!track || seen.has(track.id)) return [];
        seen.add(track.id);
        return [track];
      });
      return remember(key, { tracks });
    },
    async relatedArtists(artist, signal) {
      if (signal?.aborted) throw signal.reason;
      if (
        typeof artist !== "string" ||
        artist.length > 160 ||
        /\p{Cc}/u.test(artist)
      )
        throw new Error("Invalid Deezer artist query");
      const name = clean(artist, 160).replace(/\s+/gu, " ");
      if (!name) return { artists: [] };
      const key = `related:${artistKey(name)}`;
      const hit = cache.get(key);
      if (hit && hit.until > now()) return structuredClone(hit.value);
      const params = new URLSearchParams({ q: name, limit: "5" });
      const search = await read(`/search/artist?${params}`, signal);
      if (!Array.isArray(search.data))
        throw new Error("Deezer artist format changed");
      // A fuzzy first search hit is not evidence that two artists are related.
      const exact = search.data
        .slice(0, 5)
        .find(
          (row) =>
            numericId(row?.id) &&
            typeof row?.name === "string" &&
            row.name.length <= 160 &&
            !/\p{Cc}/u.test(row.name) &&
            artistKey(row.name) === artistKey(name),
        );
      if (!exact) return remember(key, { artists: [] });
      if (signal?.aborted) throw signal.reason;
      const related = await read(
        `/artist/${numericId(exact.id)}/related?limit=12`,
        signal,
      );
      if (!Array.isArray(related.data))
        throw new Error("Deezer related artist format changed");
      const seen = new Set([artistKey(name)]);
      const artists = related.data.slice(0, 12).flatMap((row) => {
        const value = row?.name;
        if (
          !numericId(row?.id) ||
          typeof value !== "string" ||
          value.length > 160 ||
          /\p{Cc}/u.test(value)
        )
          return [];
        const normalized = clean(value, 160).replace(/\s+/gu, " ");
        const identity = artistKey(normalized);
        if (!identity || seen.has(identity)) return [];
        seen.add(identity);
        return [normalized];
      });
      // Only names leave this lookup; no preview URLs or playback rights.
      return remember(key, { artists });
    },
    async track(trackId, signal) {
      const id = numericId(trackId);
      if (!id) throw new Error("Invalid Deezer track id");
      // Detail is intentionally fetched on every play: preview URLs are signed and short-lived.
      const payload = await read(`/track/${id}`, signal);
      if (numericId(payload.id) !== id)
        throw new Error("Deezer returned a different track");
      const track = normalizeTrack(payload, { includePreview: true, now });
      if (!track) throw new Error("Deezer track format changed");
      return track;
    },
  };
}
