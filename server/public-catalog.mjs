import { createHash } from "node:crypto";
import { guardedRequest } from "./security.mjs";

const SEARCH_ORIGIN = "https://web.ligaudio.ru";
const MAX_HTML_BYTES = 1024 * 1024;
const CACHE_MS = 60_000;
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
};

export function decodeHtml(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== "#") return ENTITIES[entity.toLowerCase()] ?? match;
    const point =
      entity[1].toLowerCase() === "x"
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
    return point > 0 &&
      point <= 0x10ffff &&
      !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point)
      : "";
  });
}

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(
    /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
  ))
    result[match[1].toLowerCase()] = decodeHtml(
      match[2] ?? match[3] ?? match[4] ?? "",
    );
  return result;
}

function cleanText(value) {
  return value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function sourceUrl(value, kind) {
  try {
    const url = new URL(value, SEARCH_ORIGIN);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      return undefined;
    if (kind === "cover")
      return url.hostname === "cover.lightaudio.ru" ? url.href : undefined;
    if (!/^storage(?:[1-9]|[1-9]\d)\.lightaudio\.ru$/.test(url.hostname))
      return undefined;
    if (
      kind === "mp3" &&
      !(url.pathname.startsWith("/dm/") && /\.mp3$/i.test(url.pathname))
    )
      return undefined;
    if (kind === "hls" && !/\.m3u8$/i.test(url.pathname)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function duration(value) {
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!match) return 0;
  const seconds =
    Number(match[1] || 0) * 3600 +
    Number(match[2] || 0) * 60 +
    Number(match[3] || 0);
  return seconds > 0 && seconds <= 86400 ? seconds : 0;
}

function normalizedTrack(row, query) {
  const title = cleanText(row.title),
    artist = cleanText(row.artist);
  // Some uploads put a full "трек: artist - title" caption in byArtist.
  // Such a caption is not a structured artist credit: never promote it to a
  // new artist or guess a corrected identity from its punctuation.
  if (/(?:^|,\s*)(?:трек|песня|track|song)\s*:/iu.test(artist)) return null;
  const streamUrl = sourceUrl(row.mp3 || "", "mp3"),
    hls = sourceUrl(row.hls || "", "hls");
  if (!title || !artist || !row.duration || !streamUrl || !hls) return null;
  const identityUrl = new URL(hls);
  const id =
    "public:la-" +
    createHash("sha256")
      .update(identityUrl.hostname + identityUrl.pathname)
      .digest("hex")
      .slice(0, 24);
  const external = new URL(SEARCH_ORIGIN);
  external.searchParams.set("mp3", query);
  if (/^id-[\w-]{1,100}$/.test(row.rowId || "")) external.hash = row.rowId;
  return {
    id,
    sourceId: "public",
    sourceName: "LightAudio",
    title,
    artist,
    duration: row.duration,
    genres: [],
    artwork: sourceUrl(row.artwork || "", "cover"),
    streamUrl,
    audioSource: { url: streamUrl, cors: false },
    playbackMode: "audio",
    availability: "available",
    streamAccess: "provider_stream",
    externalUrl: external.href,
    platformId: row.rowId,
    metadata: { catalogSource: "lightaudio", hlsUrl: hls },
    // A source's public playback link does not grant a copyright licence, Mix or redistribution.
    rights: { status: "unknown", basis: "none", allowMix: false },
    license: {
      name: "LightAudio · поток источника",
      url: external.href,
      download: false,
    },
  };
}

/** Small bounded tokenizer for the source's MusicRecording rows; no markup is executed or returned. */
export function parseLightAudio(html, query) {
  if (typeof html !== "string" || Buffer.byteLength(html) > MAX_HTML_BYTES)
    throw new Error("Music source response is too large");
  const stack = [],
    tracks = [];
  let row = null;
  for (const match of html.matchAll(
    /<!--[^]*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>|[^<]+/g,
  )) {
    const token = match[0];
    const rawTag = stack.at(-1)?.tag;
    if (
      (rawTag === "script" || rawTag === "style") &&
      !new RegExp(`^<\\/\\s*${rawTag}\\s*>$`, "i").test(token)
    )
      continue;
    if (token.startsWith("<!--") || token.startsWith("<!")) continue;
    if (token.startsWith("</")) {
      const tag = token.match(/^<\/\s*([\w-]+)/)?.[1]?.toLowerCase();
      let index = stack.length - 1;
      while (index >= 0 && stack[index].tag !== tag) index--;
      if (index < 0) continue;
      if (row && index <= row.depth) {
        const track = normalizedTrack(row, query);
        if (track) tracks.push(track);
        row = null;
        if (tracks.length >= 60) break;
      }
      stack.length = index;
      continue;
    }
    if (token.startsWith("<")) {
      if (stack.some((item) => item.tag === "script" || item.tag === "style"))
        continue;
      const tag = token.match(/^<\s*([\w-]+)/)?.[1]?.toLowerCase();
      if (!tag) continue;
      const attrs = attributes(token),
        depth = stack.length;
      if (
        !row &&
        attrs.itemprop === "track" &&
        /(?:^|\/)MusicRecording$/.test(attrs.itemtype || "")
      )
        row = { depth, rowId: attrs.id, title: "", artist: "", duration: 0 };
      if (
        row &&
        !stack.some((item) => item.tag === "script" || item.tag === "style")
      ) {
        if (tag === "meta" && attrs.itemprop === "duration")
          row.duration = duration(attrs.content || "");
        if (tag === "a" && (attrs.class || "").split(/\s+/).includes("down"))
          row.mp3 = attrs.href;
        if (tag === "a" && attrs["data-audio"]) row.hls = attrs["data-audio"];
        if (tag === "img" && attrs.src && !row.artwork) row.artwork = attrs.src;
      }
      if (!VOID_TAGS.has(tag) && !token.endsWith("/>"))
        stack.push({ tag, itemprop: attrs.itemprop });
      continue;
    }
    if (
      !row ||
      stack.some((item) => item.tag === "script" || item.tag === "style")
    )
      continue;
    const value = decodeHtml(token);
    if (stack.some((item) => item.itemprop === "byArtist")) row.artist += value;
    else if (stack.some((item) => item.itemprop === "name")) row.title += value;
  }
  return [...new Map(tracks.map((track) => [track.id, track])).values()];
}

export function createPublicCatalogService({
  externalRequest = guardedRequest,
  now = Date.now,
} = {}) {
  const searches = new Map(),
    known = new Map();
  function prune() {
    while (searches.size > 50) searches.delete(searches.keys().next().value);
    while (known.size > 2000) known.delete(known.keys().next().value);
  }
  return {
    async search(query, signal) {
      const normalized = String(query)
        .normalize("NFKC")
        .replace(/\s+/g, " ")
        .trim();
      if (!normalized || normalized.length > 160 || /\p{Cc}/u.test(normalized))
        throw new Error("Invalid music search");
      if (signal?.aborted) throw signal.reason;
      const key = normalized.toLocaleLowerCase("ru"),
        cached = searches.get(key);
      if (cached && cached.expires > now()) {
        for (const track of cached.value.tracks)
          known.set(track.id, {
            track,
            query: normalized,
            expires: cached.expires,
          });
        prune();
        return cached.value;
      }
      const url = new URL(SEARCH_ORIGIN);
      url.searchParams.set("mp3", normalized);
      const response = await externalRequest(url.href, {
        allowedHosts: ["web.ligaudio.ru"],
        signal,
        timeoutMs: 8000,
        maxBytes: MAX_HTML_BYTES,
        headers: {
          accept: "text/html",
          "user-agent": "NoteSound/2.0 (personal music player)",
        },
      });
      if (
        !Number.isInteger(response.status) ||
        response.status < 200 ||
        response.status >= 300
      )
        throw new Error(
          "Public music source did not return a successful response",
        );
      const contentType = response.headers?.["content-type"];
      if (
        typeof contentType !== "string" ||
        !/^text\/html(?:\s*;|$)/i.test(contentType)
      )
        throw new Error(
          "Public music source returned an unexpected content type",
        );
      const tracks = parseLightAudio(response.body, normalized);
      for (const track of tracks)
        known.set(track.id, {
          track,
          query: normalized,
          expires: now() + CACHE_MS,
        });
      const value = { tracks, source: "public", enabled: true };
      searches.set(key, { value, expires: now() + CACHE_MS });
      prune();
      return value;
    },
    async track(id, signal) {
      if (!/^public:la-[a-f0-9]{24}$/.test(id)) return null;
      const entry = known.get(id);
      if (!entry) return null;
      if (entry.expires <= now()) await this.search(entry.query, signal);
      const refreshed = known.get(id);
      return refreshed && refreshed.expires > now() ? refreshed.track : null;
    },
  };
}
