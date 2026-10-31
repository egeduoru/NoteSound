import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogHandler, loadConfig } from "./index.mjs";
import { issueCatalogSession, RateLimiter } from "./security.mjs";

const origin = "http://127.0.0.1:5173";
const id = "public:la-0123456789abcdef01234567";
const artworkPath =
  "/api/discovery/artwork?url=https%3A%2F%2Fcover.lightaudio.ru%2Fcover.jpg";
const searchPath = "/api/discovery/public/search?q=madk1d";
const trackPath = `/api/discovery/public/track/${id}`;

function setup(options = {}) {
  const discovery = {
    public: {
      search: vi.fn(async () => ({ tracks: [{ id }] })),
      track: vi.fn(async () => ({ id })),
    },
  };
  const config = { ...loadConfig({}), ...options.config };
  const handler = createCatalogHandler(
    config,
    { status: () => ({ configured: true }) },
    {
      discovery,
      artwork: {
        read: vi.fn(async () => ({
          contentType: "image/png",
          body: Buffer.from("image"),
        })),
      },
      limiter: options.limiter ?? new RateLimiter(2),
      userLimiter: options.userLimiter,
    },
  );
  return { handler, discovery };
}
async function invoke(handler, path, headers = { origin }) {
  const request = Object.assign(new EventEmitter(), {
    url: path,
    headers,
    method: "GET",
    socket: { remoteAddress: "127.0.0.1" },
  });
  const response = Object.assign(new EventEmitter(), {
    headers: {},
    writableEnded: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = body;
      this.writableEnded = true;
    },
  });
  await handler(request, response);
  return response;
}
afterEach(() => vi.useRealTimers());

describe("independent bounded catalog request budgets", () => {
  it("keeps metadata and playback available after artwork reaches its limit", async () => {
    const { handler, discovery } = setup();
    expect((await invoke(handler, artworkPath)).statusCode).toBe(200);
    expect((await invoke(handler, artworkPath)).statusCode).toBe(200);
    expect((await invoke(handler, artworkPath)).statusCode).toBe(429);
    expect((await invoke(handler, searchPath)).statusCode).toBe(200);
    expect((await invoke(handler, searchPath)).statusCode).toBe(200);
    expect((await invoke(handler, searchPath)).statusCode).toBe(429);
    expect((await invoke(handler, trackPath)).statusCode).toBe(200);
    expect((await invoke(handler, "/api/catalog/status")).statusCode).toBe(200);
    expect(discovery.public.search).toHaveBeenCalledTimes(2);
    expect(discovery.public.track).toHaveBeenCalledTimes(1);
  });

  it("also separates authenticated user budgets while preserving signed-session checks", async () => {
    const botToken = "test-token";
    const { sessionToken } = issueCatalogSession(42, botToken, { origin });
    const headers = { origin, "x-notesound-session": sessionToken };
    const { handler } = setup({
      config: { requireAuth: true, botToken },
      limiter: new RateLimiter(100),
      userLimiter: new RateLimiter(1),
    });
    expect((await invoke(handler, artworkPath, headers)).statusCode).toBe(200);
    expect((await invoke(handler, artworkPath, headers)).statusCode).toBe(429);
    expect((await invoke(handler, searchPath, headers)).statusCode).toBe(200);
    expect((await invoke(handler, searchPath, headers)).statusCode).toBe(429);
    expect((await invoke(handler, trackPath, headers)).statusCode).toBe(200);
    expect((await invoke(handler, trackPath, { origin })).statusCode).toBe(401);
  });

  it("exposes remaining retry time to cross-origin clients and resumes after the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const { handler } = setup({ limiter: new RateLimiter(1) });
    await invoke(handler, searchPath);
    vi.setSystemTime(new Date("2030-01-01T00:00:20Z"));
    const rejected = await invoke(handler, searchPath);
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["Retry-After"]).toBe("40");
    expect(rejected.headers["Access-Control-Expose-Headers"]).toBe(
      "Retry-After",
    );
    expect(JSON.parse(rejected.body)).toMatchObject({
      error: "rate_limited",
      retryAfterSeconds: 40,
    });
    vi.setSystemTime(new Date("2030-01-01T00:01:00Z"));
    expect((await invoke(handler, searchPath)).statusCode).toBe(200);
  });

  it("honors an injected deny limiter and groups arbitrary invalid paths in one bounded budget", async () => {
    const denied = setup({ limiter: { allow: () => false } });
    const response = await invoke(denied.handler, searchPath);
    expect(response.statusCode).toBe(429);
    expect(response.headers["Retry-After"]).toBe("60");
    expect(denied.discovery.public.search).not.toHaveBeenCalled();
    const { handler } = setup({ limiter: new RateLimiter(1) });
    expect((await invoke(handler, "/unknown-one")).statusCode).toBe(404);
    expect((await invoke(handler, "/unknown-two")).statusCode).toBe(429);
  });
});
