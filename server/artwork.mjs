import { safePublicUrl } from "./catalog-model.mjs";
import { ConcurrencyGate, guardedRequest } from "./security.mjs";

export const ARTWORK_HOSTS = [
  "cover.lightaudio.ru",
  "cdn-images.dzcdn.net",
  "e-cdns-images.dzcdn.net",
];
export const MAX_ARTWORK_BYTES = 3 * 1024 * 1024;
const CACHE_MS = 10 * 60_000;
const MAX_PIXELS = 16 * 1024 * 1024;

export class ArtworkRequestError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function dimensions(body, type) {
  if (type === "image/png") {
    if (
      body.length < 24 ||
      !body
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      body.toString("ascii", 12, 16) !== "IHDR"
    )
      return null;
    return [body.readUInt32BE(16), body.readUInt32BE(20)];
  }
  if (type === "image/jpeg") {
    if (body.length < 12 || body[0] !== 0xff || body[1] !== 0xd8) return null;
    let offset = 2;
    const sof = new Set([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
      0xcf,
    ]);
    while (offset + 4 <= body.length) {
      if (body[offset] !== 0xff) return null;
      while (body[offset] === 0xff) offset++;
      const marker = body[offset++];
      if (marker === 0xd9 || marker === 0xda) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > body.length) return null;
      const length = body.readUInt16BE(offset);
      if (length < 2 || offset + length > body.length) return null;
      if (sof.has(marker)) {
        if (length < 7) return null;
        return [body.readUInt16BE(offset + 5), body.readUInt16BE(offset + 3)];
      }
      offset += length;
    }
    return null;
  }
  if (type === "image/webp") {
    if (
      body.length < 25 ||
      body.toString("ascii", 0, 4) !== "RIFF" ||
      body.toString("ascii", 8, 12) !== "WEBP"
    )
      return null;
    const chunk = body.toString("ascii", 12, 16);
    if (chunk === "VP8X" && body.length >= 30)
      return [body.readUIntLE(24, 3) + 1, body.readUIntLE(27, 3) + 1];
    if (chunk === "VP8L" && body[20] === 0x2f) {
      const bits = body.readUInt32LE(21);
      return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
    if (
      chunk === "VP8 " &&
      body.length >= 30 &&
      body.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))
    )
      return [body.readUInt16LE(26) & 0x3fff, body.readUInt16LE(28) & 0x3fff];
  }
  return null;
}

/** Only known cover CDNs can be read. DNS pinning, byte and pixel limits also
 * apply when their responses do not expose CORS to the browser canvas. */
export function createArtworkService({
  externalRequest = guardedRequest,
  now = Date.now,
  maxCacheBytes = 16 * 1024 * 1024,
  maxCacheEntries = 32,
} = {}) {
  const cache = new Map();
  const gate = new ConcurrencyGate(2, 8);
  let cacheBytes = 0;
  function remove(key) {
    const item = cache.get(key);
    if (item) cacheBytes -= item.body.length;
    cache.delete(key);
  }
  function cached(key) {
    for (const [oldKey, value] of cache)
      if (value.until <= now()) remove(oldKey);
    const hit = cache.get(key);
    if (!hit) return null;
    cache.delete(key);
    cache.set(key, hit);
    return { body: hit.body, contentType: hit.contentType };
  }
  return {
    async read(input, signal) {
      if (signal?.aborted) throw signal.reason;
      const url =
        typeof input === "string" && input.length <= 2048
          ? safePublicUrl(input, ARTWORK_HOSTS)
          : null;
      if (!url) throw new ArtworkRequestError(400, "invalid_artwork_url");
      const hit = cached(url);
      if (hit) return hit;
      return gate.run(async () => {
        const ready = cached(url);
        if (ready) return ready;
        const response = await externalRequest(url, {
          allowedHosts: ARTWORK_HOSTS,
          signal,
          timeoutMs: 8000,
          maxBytes: MAX_ARTWORK_BYTES,
          responseType: "buffer",
          headers: { accept: "image/jpeg,image/png,image/webp" },
        });
        const contentType = String(response.headers?.["content-type"] || "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        const type = contentType === "image/jpg" ? "image/jpeg" : contentType;
        if (
          (response.status !== undefined &&
            (response.status < 200 || response.status >= 300)) ||
          !Buffer.isBuffer(response.body) ||
          !response.body.length ||
          response.body.length > MAX_ARTWORK_BYTES ||
          !["image/jpeg", "image/png", "image/webp"].includes(type)
        )
          throw new ArtworkRequestError(502, "artwork_unavailable");
        const size = dimensions(response.body, type);
        if (
          !size ||
          size.some((value) => value < 1 || value > 8192) ||
          size[0] * size[1] > MAX_PIXELS
        )
          throw new ArtworkRequestError(502, "artwork_unavailable");
        const result = { body: response.body, contentType: type };
        if (result.body.length <= maxCacheBytes && maxCacheEntries > 0) {
          while (
            cache.size &&
            (cacheBytes + result.body.length > maxCacheBytes ||
              cache.size >= maxCacheEntries)
          )
            remove(cache.keys().next().value);
          cache.set(url, { ...result, until: now() + CACHE_MS });
          cacheBytes += result.body.length;
        }
        return result;
      }, signal);
    },
  };
}
