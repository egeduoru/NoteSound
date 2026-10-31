import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogHandler, loadConfig } from "./index.mjs";
import { issueCatalogSession } from "./security.mjs";

const ORIGIN = "http://127.0.0.1:5173";
const publicId = "public:la-0123456789abcdef01234567";
const deezerId = "deezer:4174083162";

function setup(overrides = {}) {
  const discovery = {
    public: {
      search: vi.fn(async () => ({ tracks: [{ id: publicId }] })),
      track: vi.fn(async (id) => ({ id })),
    },
    deezer: {
      search: vi.fn(async () => ({ tracks: [{ id: deezerId }] })),
      track: vi.fn(async (id) => ({ id })),
      relatedArtists: vi.fn(async () => ({ artists: ["CUPSIZE"] })),
    },
  };
  const service = {
    status: () => ({ configured: true }),
    search: vi.fn(async () => ({ tracks: [] })),
  };
  const config = { ...loadConfig({}), ...overrides };
  return {
    discovery,
    service,
    config,
    handler: createCatalogHandler(config, service, { discovery }),
  };
}

async function invoke(handler, path, headers = {}, method = "GET") {
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
  await handler(request, response);
  return {
    status: response.statusCode,
    headers: response.headers,
    body: response.body ? JSON.parse(response.body) : null,
  };
}

afterEach(() => vi.useRealTimers());

describe("discovery HTTP routes", () => {
  it("routes a related artist query as names-only metadata with existing CORS", async () => {
    const { handler, discovery } = setup();
    const response = await invoke(
      handler,
      "/api/discovery/deezer/related?artist=madk1d",
      { origin: ORIGIN },
    );
    expect(response).toMatchObject({
      status: 200,
      body: { artists: ["CUPSIZE"] },
    });
    expect(discovery.deezer.relatedArtists).toHaveBeenCalledWith(
      "madk1d",
      expect.any(AbortSignal),
    );
    expect(response.headers["Access-Control-Allow-Origin"]).toBe(ORIGIN);
  });

  it("rejects invalid related queries and unsupported provider before source access", async () => {
    const { handler, discovery } = setup();
    for (const query of ["a".repeat(161), "bad\nname"])
      expect(
        (
          await invoke(
            handler,
            `/api/discovery/deezer/related?${new URLSearchParams({ artist: query })}`,
          )
        ).status,
      ).toBe(400);
    expect(
      (await invoke(handler, "/api/discovery/public/related?artist=madk1d"))
        .status,
    ).toBe(404);
    expect(
      (await invoke(handler, "/api/discovery/deezer/related?artist=")).body,
    ).toEqual({ artists: [] });
    expect(discovery.deezer.relatedArtists).not.toHaveBeenCalled();
  });

  it.each(["public", "deezer"])(
    "decodes a %s search query exactly once and passes a cancellation signal",
    async (source) => {
      const { handler, discovery } = setup();
      const query = "VILLIAN + madk1d & ДИНАСТИЯ %20";
      const response = await invoke(
        handler,
        `/api/discovery/${source}/search?${new URLSearchParams({ q: query })}`,
        { origin: ORIGIN },
      );
      expect(response.status).toBe(200);
      expect(discovery[source].search).toHaveBeenCalledWith(
        query,
        expect.any(AbortSignal),
      );
      expect(response.headers["Access-Control-Allow-Origin"]).toBe(ORIGIN);
      expect(response.headers["Cache-Control"]).toBe("no-store");
    },
  );

  it("does not query an external source for an empty search", async () => {
    const { handler, discovery } = setup();
    const response = await invoke(
      handler,
      "/api/discovery/deezer/search?q=%20%20",
    );
    expect(response).toMatchObject({ status: 200, body: { tracks: [] } });
    expect(discovery.deezer.search).not.toHaveBeenCalled();
  });

  it.each([
    ["public", publicId],
    ["deezer", deezerId],
  ])("validates and decodes canonical %s track ids", async (source, id) => {
    const { handler, discovery } = setup();
    const response = await invoke(
      handler,
      `/api/discovery/${source}/track/${encodeURIComponent(id)}`,
    );
    expect(response).toMatchObject({ status: 200, body: { track: { id } } });
    expect(discovery[source].track).toHaveBeenCalledWith(
      id,
      expect.any(AbortSignal),
    );
  });

  it.each([
    "https://127.0.0.1/private",
    "deezer:../private",
    "public:la-0123456789abcdef01234567",
    "deezer%3A4174083162",
  ])(
    "rejects invalid or arbitrary-url track ids before provider access: %s",
    async (id) => {
      const { handler, discovery } = setup();
      const response = await invoke(
        handler,
        `/api/discovery/deezer/track/${encodeURIComponent(id)}`,
      );
      expect(response.status).toBe(400);
      expect(response.body.error).toBe("invalid_id");
      expect(discovery.deezer.track).not.toHaveBeenCalled();
    },
  );

  it("distinguishes missing tracks from external source errors without leaking exception details", async () => {
    const { handler, discovery } = setup();
    discovery.public.track.mockResolvedValue(null);
    expect(
      (
        await invoke(
          handler,
          `/api/discovery/public/track/${encodeURIComponent(publicId)}`,
        )
      ).status,
    ).toBe(404);
    discovery.deezer.search.mockRejectedValue(
      new Error("secret internal token and upstream stack"),
    );
    const response = await invoke(
      handler,
      "/api/discovery/deezer/search?q=MACAN",
    );
    expect(response).toMatchObject({
      status: 502,
      body: { error: "source_unavailable" },
    });
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });

  it("applies the existing CORS and method restrictions before discovery calls", async () => {
    const { handler, discovery } = setup();
    const denied = await invoke(
      handler,
      "/api/discovery/public/search?q=MACAN",
      { origin: "https://evil.example" },
    );
    expect(denied).toMatchObject({
      status: 403,
      body: { error: "origin_not_allowed" },
    });
    expect(
      (
        await invoke(
          handler,
          "/api/discovery/public/search?q=MACAN",
          {},
          "POST",
        )
      ).status,
    ).toBe(405);
    expect(discovery.public.search).not.toHaveBeenCalled();
  });

  it("keeps Telegram authentication required on the new discovery routes", async () => {
    const { handler, discovery } = setup({
      requireAuth: true,
      botToken: "test-discovery-token",
    });
    const denied = await invoke(
      handler,
      "/api/discovery/deezer/search?q=MACAN",
      { origin: ORIGIN },
    );
    expect(denied).toMatchObject({
      status: 401,
      body: { error: "telegram_auth_required" },
    });
    expect(discovery.deezer.search).not.toHaveBeenCalled();
    const session = issueCatalogSession(42, "test-discovery-token", {
      origin: ORIGIN,
    });
    const allowed = await invoke(
      handler,
      "/api/discovery/deezer/search?q=MACAN",
      { origin: ORIGIN, "x-notesound-session": session.sessionToken },
    );
    expect(allowed.status).toBe(200);
    expect(discovery.deezer.search).toHaveBeenCalledTimes(1);
  });

  it("cancels a slow source after the HTTP deadline and returns a bounded error", async () => {
    vi.useFakeTimers();
    const { handler, discovery } = setup();
    discovery.public.search.mockImplementation(
      (_query, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        }),
    );
    const pending = invoke(handler, "/api/discovery/public/search?q=MACAN");
    await vi.advanceTimersByTimeAsync(12_000);
    const response = await pending;
    expect(response).toMatchObject({
      status: 502,
      body: { error: "source_unavailable" },
    });
    expect(discovery.public.search.mock.calls[0][1].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
