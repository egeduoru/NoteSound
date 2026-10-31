import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createArtworkService, MAX_ARTWORK_BYTES } from "./artwork.mjs";
import { createCatalogHandler, loadConfig } from "./index.mjs";
import { issueCatalogSession } from "./security.mjs";

const URL = "https://cover.lightaudio.ru/cover.jpg";
const ORIGIN = "http://127.0.0.1:5173";
const PNG = () => {
  const body = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(body);
  body.writeUInt32BE(13, 8);
  body.write("IHDR", 12);
  body.writeUInt32BE(300, 16);
  body.writeUInt32BE(300, 20);
  return body;
};
const imageResponse = (body = PNG(), contentType = "image/png") => ({
  status: 200,
  body,
  headers: { "content-type": contentType },
});

describe("bounded artwork reader", () => {
  it("requests only binary artwork from the pinned known CDN boundary", async () => {
    const request = vi.fn(async () => imageResponse());
    const controller = new AbortController();
    const image = await createArtworkService({ externalRequest: request }).read(
      URL,
      controller.signal,
    );
    expect(image).toEqual({ body: PNG(), contentType: "image/png" });
    expect(request).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({
        allowedHosts: [
          "cover.lightaudio.ru",
          "cdn-images.dzcdn.net",
          "e-cdns-images.dzcdn.net",
        ],
        responseType: "buffer",
        maxBytes: MAX_ARTWORK_BYTES,
        signal: controller.signal,
      }),
    );
  });

  it.each([
    "http://cover.lightaudio.ru/cover.jpg",
    "https://127.0.0.1/private.png",
    "https://cover.lightaudio.ru.evil.example/cover.jpg",
    "https://user:password@cover.lightaudio.ru/cover.jpg",
    "https://cover.lightaudio.ru:444/cover.jpg",
    "data:image/png;base64,foo",
  ])("rejects an unapproved URL before any network access: %s", async (url) => {
    const request = vi.fn();
    await expect(
      createArtworkService({ externalRequest: request }).read(url),
    ).rejects.toMatchObject({ status: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    imageResponse(Buffer.from("<html>not an image</html>"), "text/html"),
    imageResponse(Buffer.from("<svg><script /></svg>"), "image/svg+xml"),
    imageResponse(Buffer.from("<html>not a PNG</html>"), "image/png"),
    imageResponse(Buffer.alloc(MAX_ARTWORK_BYTES + 1), "image/png"),
    { ...imageResponse(), status: 302 },
  ])(
    "rejects non-image, spoofed, oversized and redirect responses",
    async (response) => {
      await expect(
        createArtworkService({ externalRequest: async () => response }).read(
          URL,
        ),
      ).rejects.toMatchObject({ status: 502 });
    },
  );

  it("rejects excessive image dimensions before browser decode", async () => {
    const image = PNG();
    image.writeUInt32BE(8192, 16);
    image.writeUInt32BE(8192, 20);
    await expect(
      createArtworkService({
        externalRequest: async () => imageResponse(image),
      }).read(URL),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("recognizes actual JPEG and WebP dimension headers", async () => {
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 100, 0, 120, 1, 1, 0x11, 0, 0xff,
      0xd9,
    ]);
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0);
    webp.writeUInt32LE(22, 4);
    webp.write("WEBPVP8X", 8);
    webp.writeUInt32LE(10, 16);
    webp.writeUIntLE(119, 24, 3);
    webp.writeUIntLE(99, 27, 3);
    for (const [body, type] of [
      [jpeg, "image/jpeg"],
      [webp, "image/webp"],
    ]) {
      expect(
        (
          await createArtworkService({
            externalRequest: async () => imageResponse(body, type),
          }).read(URL)
        ).body,
      ).toEqual(body);
    }
  });

  it("bounds the byte cache and expires artwork", async () => {
    let now = 0;
    const request = vi.fn(async () => imageResponse());
    const service = createArtworkService({
      externalRequest: request,
      now: () => now,
      maxCacheBytes: PNG().length,
      maxCacheEntries: 32,
    });
    await service.read(URL);
    await service.read(URL);
    expect(request).toHaveBeenCalledTimes(1);
    await service.read(URL + "?another");
    await service.read(URL);
    expect(request).toHaveBeenCalledTimes(3);
    now += 600_001;
    await service.read(URL);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("honors an already cancelled client before reading the cache or network", async () => {
    const request = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      createArtworkService({ externalRequest: request }).read(
        URL,
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
    expect(request).not.toHaveBeenCalled();
  });
});

function exchange(handler, path, headers = {}, method = "GET") {
  const request = Object.assign(new EventEmitter(), {
    url: path,
    headers,
    method,
    socket: { remoteAddress: "127.0.0.1" },
  });
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: {},
    writableEnded: false,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(body) {
      this.body = body;
      this.writableEnded = true;
    },
  });
  return { request, response, pending: handler(request, response) };
}

describe("artwork HTTP endpoint", () => {
  const path = `/api/discovery/artwork?${new URLSearchParams({ url: URL })}`;
  it("returns raw bytes with image MIME and existing CORS headers", async () => {
    const artwork = {
      read: vi.fn(async () => ({ body: PNG(), contentType: "image/png" })),
    };
    const handler = createCatalogHandler(loadConfig({}), {}, { artwork });
    const { response, pending } = exchange(handler, path, { origin: ORIGIN });
    await pending;
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(PNG());
    expect(response.headers).toMatchObject({
      "Content-Type": "image/png",
      "Content-Length": PNG().length,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=600",
      "Access-Control-Allow-Origin": ORIGIN,
    });
  });
  it("keeps method, origin, auth and rate limits ahead of artwork access", async () => {
    const artwork = {
      read: vi.fn(async () => ({ body: PNG(), contentType: "image/png" })),
    };
    const config = {
      ...loadConfig({}),
      requireAuth: true,
      botToken: "artwork-test-token",
    };
    const handler = createCatalogHandler(config, {}, { artwork });
    for (const [headers, method, status] of [
      [{ origin: "https://evil.example" }, "GET", 403],
      [{}, "POST", 405],
      [{ origin: ORIGIN }, "GET", 401],
    ]) {
      const x = exchange(handler, path, headers, method);
      await x.pending;
      expect(x.response.statusCode).toBe(status);
    }
    expect(artwork.read).not.toHaveBeenCalled();
    const session = issueCatalogSession(42, config.botToken, {
      origin: ORIGIN,
    });
    const allowed = exchange(handler, path, {
      origin: ORIGIN,
      "x-notesound-session": session.sessionToken,
    });
    await allowed.pending;
    expect(allowed.response.statusCode).toBe(200);
    const deniedHandler = createCatalogHandler(
      loadConfig({}),
      {},
      { artwork, limiter: { allow: () => false } },
    );
    const denied = exchange(deniedHandler, path);
    await denied.pending;
    expect(denied.response.statusCode).toBe(429);
    expect(artwork.read).toHaveBeenCalledTimes(1);
  });
  it("rejects duplicate parameters and never leaks upstream exception details", async () => {
    const artwork = {
      read: vi.fn(async () => {
        throw new Error("private upstream details");
      }),
    };
    const handler = createCatalogHandler(loadConfig({}), {}, { artwork });
    const duplicate = exchange(handler, path + "&url=another");
    await duplicate.pending;
    expect(duplicate.response.statusCode).toBe(400);
    expect(artwork.read).not.toHaveBeenCalled();
    const failed = exchange(handler, path);
    await failed.pending;
    expect(failed.response.statusCode).toBe(502);
    expect(failed.response.body).not.toContain("private");
  });
  it("aborts an upstream read when its client disconnects", async () => {
    let signal;
    const artwork = {
      read: vi.fn((_url, value) => {
        signal = value;
        return new Promise((_, reject) =>
          value.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          ),
        );
      }),
    };
    const handler = createCatalogHandler(loadConfig({}), {}, { artwork });
    const x = exchange(handler, path);
    x.response.emit("close");
    await x.pending;
    expect(signal.aborted).toBe(true);
    expect(x.request.listenerCount("aborted")).toBe(0);
    expect(x.response.listenerCount("close")).toBe(0);
  });
});
