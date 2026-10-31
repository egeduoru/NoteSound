import { getDiscoveryApiUrl } from "../../lib/runtime-config";

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
const SAMPLE_SIZE = 48;
const CACHE_LIMIT = 64;
const paletteCache = new Map<string, string>();
const proxyHosts = new Set([
  "cover.lightaudio.ru",
  "cdn-images.dzcdn.net",
  "e-cdns-images.dzcdn.net",
]);

interface Sample {
  r: number;
  g: number;
  b: number;
  weight: number;
}
interface Bucket extends Sample {
  samples: Sample[];
}

const hex = ({ r, g, b }: Pick<Sample, "r" | "g" | "b">) =>
  `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

/** Returns a representative pixel from the largest nearby-color cluster.
 * It deliberately keeps predominantly black or white artwork those colors. */
export function dominantArtworkColor(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): string | null {
  if (
    !(pixels instanceof Uint8ClampedArray) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_IMAGE_PIXELS ||
    pixels.length < width * height * 4
  )
    return null;

  const histogram = new Map<number, Bucket>();
  let totalWeight = 0;
  const sampleStep = Math.max(1, Math.ceil((width * height) / 4096)) * 4;
  for (let i = 0; i < width * height * 4; i += sampleStep) {
    const alpha = pixels[i + 3];
    if (alpha < 32) continue;
    const sample = {
      r: pixels[i],
      g: pixels[i + 1],
      b: pixels[i + 2],
      weight: alpha / 255,
    };
    const key =
      ((sample.r >> 4) << 8) | ((sample.g >> 4) << 4) | (sample.b >> 4);
    const bucket = histogram.get(key);
    if (bucket) {
      bucket.r += sample.r * sample.weight;
      bucket.g += sample.g * sample.weight;
      bucket.b += sample.b * sample.weight;
      bucket.weight += sample.weight;
      bucket.samples.push(sample);
    } else {
      histogram.set(key, {
        r: sample.r * sample.weight,
        g: sample.g * sample.weight,
        b: sample.b * sample.weight,
        weight: sample.weight,
        samples: [sample],
      });
    }
    totalWeight += sample.weight;
  }
  if (!histogram.size) return null;

  const buckets = [...histogram.values()].map((bucket) => ({
    ...bucket,
    r: bucket.r / bucket.weight,
    g: bucket.g / bucket.weight,
    b: bucket.b / bucket.weight,
  }));
  const largest = buckets.reduce((a, b) => (b.weight > a.weight ? b : a));
  let candidates: Sample[];
  if (largest.weight > totalWeight / 2) {
    candidates = largest.samples;
  } else {
    // Nearby histogram bins belong to the same broad shade on gradient covers.
    // This prevents a small uniform white title from beating a large blue field.
    const radiusSquared = 56 ** 2;
    let winning: Bucket[] = [];
    let winningWeight = -1;
    for (const center of buckets) {
      const neighbors = buckets.filter(
        (bucket) =>
          (bucket.r - center.r) ** 2 +
            (bucket.g - center.g) ** 2 +
            (bucket.b - center.b) ** 2 <=
          radiusSquared,
      );
      const weight = neighbors.reduce((sum, bucket) => sum + bucket.weight, 0);
      if (weight > winningWeight) {
        winningWeight = weight;
        winning = neighbors;
      }
    }
    candidates = winning.flatMap((bucket) => bucket.samples);
  }

  const weight = candidates.reduce((sum, sample) => sum + sample.weight, 0);
  const center = candidates.reduce(
    (sum, sample) => ({
      r: sum.r + (sample.r * sample.weight) / weight,
      g: sum.g + (sample.g * sample.weight) / weight,
      b: sum.b + (sample.b * sample.weight) / weight,
    }),
    { r: 0, g: 0, b: 0 },
  );
  const distance = (sample: Sample) =>
    (sample.r - center.r) ** 2 +
    (sample.g - center.g) ** 2 +
    (sample.b - center.b) ** 2;
  // Return an existing pixel, rather than an averaged or artificially bright color.
  const representative = candidates.reduce((a, b) =>
    distance(b) < distance(a) ? b : a,
  );
  return hex(representative);
}

function apiBase() {
  const value = getDiscoveryApiUrl();
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

/** Only these catalog image CDNs can use the server-side CORS fallback. */
export function artworkProxyUrl(artwork: string): string | null {
  try {
    const url = new URL(artwork);
    const base = apiBase();
    if (
      base === null ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      !proxyHosts.has(url.hostname) ||
      url.href.length > 4096
    )
      return null;
    url.hash = "";
    return `${base}/api/discovery/artwork?url=${encodeURIComponent(url.href)}`;
  } catch {
    return null;
  }
}

async function boundedImageBlob(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) {
    const blob = await response.blob();
    if (blob.size > MAX_IMAGE_BYTES) throw new Error("Artwork is too large");
    return blob;
  }
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error("Artwork is too large");
      }
      chunks.push(new Uint8Array(value).buffer);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, {
    type: response.headers.get("Content-Type") || "application/octet-stream",
  });
}

function decodeColor(src: string, signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
      resolve(value);
    };
    const abort = () => finish(null);
    const timer = setTimeout(abort, 4500);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      finish(null);
      return;
    }
    image.decoding = "async";
    // Anonymous cross-origin requests omit cookies and permit canvas access.
    if (/^https?:/i.test(src)) image.crossOrigin = "anonymous";
    image.onerror = abort;
    image.onload = () => {
      if (signal.aborted) {
        finish(null);
        return;
      }
      if (
        !image.naturalWidth ||
        !image.naturalHeight ||
        image.naturalWidth > 8192 ||
        image.naturalHeight > 8192 ||
        image.naturalWidth * image.naturalHeight > MAX_IMAGE_PIXELS
      ) {
        finish(null);
        return;
      }
      try {
        const canvas = document.createElement("canvas");
        canvas.width = SAMPLE_SIZE;
        canvas.height = SAMPLE_SIZE;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
          finish(null);
          return;
        }
        // Nearest-neighbor samples preserve the cover's actual decoded RGB values.
        context.imageSmoothingEnabled = false;
        context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        finish(
          dominantArtworkColor(
            context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data,
            SAMPLE_SIZE,
            SAMPLE_SIZE,
          ),
        );
      } catch {
        // A source can display an image but deny canvas access through CORS.
        finish(null);
      }
    };
    image.src = src;
  });
}

/** Samples the cover itself; no genre, title or guessed artist palette is used.
 * Failed and aborted reads are never cached. Callers should discard stale results. */
export async function readArtworkColor(
  artwork: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (
    typeof document === "undefined" ||
    typeof Image === "undefined" ||
    typeof artwork !== "string" ||
    !artwork.trim() ||
    artwork.length > MAX_IMAGE_BYTES * 1.4 ||
    signal?.aborted
  )
    return null;

  let src: string;
  try {
    const url = new URL(artwork, document.baseURI);
    if (
      !["https:", "http:", "data:", "blob:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      (url.protocol === "http:" && url.origin !== location.origin)
    )
      return null;
    if (url.protocol === "data:" && !/^data:image\//i.test(artwork))
      return null;
    src = url.href;
  } catch {
    return null;
  }

  const cached = paletteCache.get(src);
  if (cached) {
    paletteCache.delete(src);
    paletteCache.set(src, cached);
    return cached;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(abort, 14000);
  let objectUrl: string | undefined;
  try {
    let color = await decodeColor(src, controller.signal);
    const proxy = color === null ? artworkProxyUrl(src) : null;
    if (!color && proxy && !controller.signal.aborted) {
      const response = await fetch(proxy, {
        signal: controller.signal,
        credentials: "omit",
        headers: { Accept: "image/*" },
      });
      const size = Number(response.headers.get("Content-Length") || 0);
      if (
        !response.ok ||
        size > MAX_IMAGE_BYTES ||
        !/^image\/(?:jpeg|png|webp)\b/i.test(
          response.headers.get("Content-Type") || "",
        )
      )
        return null;
      const blob = await boundedImageBlob(response, controller.signal);
      if (blob.size > MAX_IMAGE_BYTES || controller.signal.aborted) return null;
      objectUrl = URL.createObjectURL(blob);
      color = await decodeColor(objectUrl, controller.signal);
    }
    if (!color || controller.signal.aborted || signal?.aborted) return null;
    // Large data URIs are intentionally not retained as cache keys.
    if (src.length <= 4096) {
      paletteCache.delete(src);
      paletteCache.set(src, color);
      while (paletteCache.size > CACHE_LIMIT)
        paletteCache.delete(paletteCache.keys().next().value!);
    }
    return color;
  } catch {
    return null;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abort);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}
