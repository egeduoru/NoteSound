import { createHmac } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  loadConfig,
  createCatalogService,
  createCatalogHandler,
} from "./index.mjs";
const fixture = {
  id: "licensed:sample",
  title: "Разрешённая песня",
  artist: "Владелец",
  duration: 120,
  audioSource: { url: "https://audio.example/song.mp3", cors: true },
  rights: {
    status: "confirmed",
    basis: "license",
    evidence: "Owner grant",
    allowMix: true,
  },
};
const config = (extra = {}) => ({
  ...loadConfig({}),
  audioHosts: ["audio.example"],
  ...extra,
});
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
describe("catalog service rights and caching", () => {
  it("makes no parser calls while metadata/playback are disabled by default", async () => {
    const externalRequest = vi.fn();
    const service = createCatalogService(config(), { externalRequest });
    expect(await service.search("hitmoz", "Династия")).toMatchObject({
      enabled: false,
      tracks: [],
    });
    expect(await service.playable("hitmoz:81251971")).toBeNull();
    expect(externalRequest).not.toHaveBeenCalled();
    expect(service.track("hitmoz:unknown")).toBeNull();
  });
  it("caches parser JSON, validates format and never treats download as a playable grant", async () => {
    const externalRequest = vi.fn(async () => ({
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        success: true,
        songs: [
          {
            title: "Династия",
            artist: "madk1d",
            duration: "02:30",
            download: "https://eu.hitmoz.com/get/song.mp3",
            link: "https://eu.hitmoz.com/song/81251971",
          },
        ],
      }),
    }));
    const service = createCatalogService(
      config({
        metadataEnabled: true,
        parserUrl: "https://parser.example/index.php",
        parserHosts: ["parser.example"],
      }),
      { externalRequest },
    );
    const first = await service.search("hitmoz", "Династия");
    await service.search("hitmoz", "ДИНАСТИЯ");
    expect(externalRequest).toHaveBeenCalledTimes(1);
    expect(first.tracks[0].rights.status).toBe("unknown");
    expect(await service.playable(first.tracks[0].id)).toBeNull();
    expect(
      new URL(externalRequest.mock.calls[0][0]).searchParams.get("search"),
    ).toBe("Династия");
  });
  it("requires an evidenced registry grant, successful audio HEAD and actual CORS for mixing", async () => {
    const externalRequest = vi.fn(async () => ({
      headers: {
        "content-type": "audio/mpeg",
        "access-control-allow-origin": "*",
      },
      body: "",
    }));
    const service = createCatalogService(config(), {
      externalRequest,
      registryTracks: [fixture],
    });
    expect(
      (await service.search("licensed", "разрешённая")).tracks,
    ).toHaveLength(1);
    expect(
      await service.playable(
        fixture.id,
        undefined,
        "https://egeduoru.github.io",
      ),
    ).toMatchObject({
      url: fixture.audioSource.url,
      cors: true,
      allowMix: true,
    });
    expect(externalRequest.mock.calls[0][1].method).toBe("HEAD");
    const nonCors = createCatalogService(config(), {
      externalRequest: async () => ({
        headers: { "content-type": "audio/mpeg" },
        body: "",
      }),
      registryTracks: [fixture],
    });
    expect(await nonCors.playable(fixture.id)).toMatchObject({
      cors: false,
      allowMix: false,
    });
    const html = createCatalogService(config(), {
      externalRequest: async () => ({
        headers: { "content-type": "text/html" },
        body: "",
      }),
      registryTracks: [fixture],
    });
    await expect(html.playable(fixture.id)).rejects.toThrow(/audio/);
  });
  it("keeps Hitmoz playback off even with registry evidence until explicit flag is enabled", async () => {
    const externalRequest = vi.fn(async () => ({
      headers: { "content-type": "audio/mpeg" },
      body: "",
    }));
    const hitmoz = { ...fixture, id: "hitmoz:81251971" };
    const service = createCatalogService(config(), {
      externalRequest,
      registryTracks: [hitmoz],
    });
    expect(service.track(hitmoz.id).playbackMode).toBe("metadata");
    expect(service.track(hitmoz.id).audioSource).toBeUndefined();
    expect(await service.playable(hitmoz.id)).toBeNull();
    expect(externalRequest).not.toHaveBeenCalled();
  });
});
describe("HTTP catalog boundary", () => {
  it("validates configuration without exposing a token", () => {
    expect(() => loadConfig({ REQUIRE_TELEGRAM_AUTH: "true" })).toThrow(
      /BOT_TOKEN/,
    );
    expect(() =>
      loadConfig({
        HITMOZ_METADATA_ENABLED: "true",
        HITMOZ_PARSER_URL: "http://127.0.0.1/",
      }),
    ).toThrow(/HTTPS/);
  });
  it("rejects forged Origin, unverified initData, invalid IDs/query and write methods", async () => {
    const settings = config({ requireAuth: true, botToken: "test-token" }),
      service = createCatalogService(settings),
      handler = createCatalogHandler(settings, service);
    expect(
      (
        await invoke(handler, "/api/catalog/top", {
          origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    expect((await invoke(handler, "/api/catalog/top")).status).toBe(401);
    const publicHandler = createCatalogHandler(config(), service);
    expect(
      (
        await invoke(
          publicHandler,
          "/api/catalog/playable/http%3A%2F%2Flocalhost",
        )
      ).status,
    ).toBe(400);
    expect(
      (await invoke(publicHandler, `/api/catalog/search?q=${"a".repeat(301)}`))
        .status,
    ).toBe(400);
    expect(
      (await invoke(publicHandler, "/api/catalog/top", {}, "POST")).status,
    ).toBe(405);
    expect(
      (await invoke(publicHandler, "/api/catalog/status")).body,
    ).not.toHaveProperty("botToken");
  });
  it("returns a bounded service failure without upstream details", async () => {
    const service = {
      search: async () => {
        throw new Error("sensitive upstream URL");
      },
      status: () => ({}),
    };
    const handler = createCatalogHandler(config(), service);
    const result = await invoke(handler, "/api/catalog/search?q=песня");
    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toContain("sensitive");
  });
});

function signedInitData(now, userId = 42, token = "test-token") {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(now / 1000)),
    user: JSON.stringify({ id: userId, first_name: "User" }),
  });
  params.sort();
  const check = [...params].map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}
describe("authenticated catalog sessions", () => {
  it("exchanges fresh initData and preserves playback access after five minutes", async () => {
    const now = 1800000000000,
      origin = "https://egeduoru.github.io",
      clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const settings = config({ requireAuth: true, botToken: "test-token" }),
        handler = createCatalogHandler(
          settings,
          createCatalogService(settings),
        );
      const initData = signedInitData(now);
      const exchange = await invoke(handler, "/api/auth/session", {
        origin,
        "x-telegram-init-data": initData,
      });
      expect(exchange.status).toBe(200);
      expect(exchange.body.sessionToken).toBeTypeOf("string");
      expect(JSON.stringify(exchange.body)).not.toContain("test-token");
      clock.mockReturnValue(now + 20 * 60000);
      expect(
        (
          await invoke(handler, "/api/catalog/top", {
            origin,
            "x-telegram-init-data": initData,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await invoke(handler, "/api/catalog/top", {
            origin,
            "x-notesound-session": exchange.body.sessionToken,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await invoke(handler, "/api/catalog/top", {
            "x-notesound-session": exchange.body.sessionToken,
          })
        ).status,
      ).toBe(401);
      clock.mockReturnValue(exchange.body.expiresAt);
      expect(
        (
          await invoke(handler, "/api/catalog/top", {
            origin,
            "x-notesound-session": exchange.body.sessionToken,
          })
        ).status,
      ).toBe(401);
    } finally {
      clock.mockRestore();
    }
  });
  it("requires genuine fresh initData to mint tokens and tolerates public mode", async () => {
    const settings = config({ requireAuth: true, botToken: "test-token" }),
      handler = createCatalogHandler(settings, createCatalogService(settings));
    expect(
      (
        await invoke(handler, "/api/auth/session", {
          "x-telegram-init-data": "user=42",
        })
      ).status,
    ).toBe(401);
    const publicSettings = config(),
      open = createCatalogHandler(
        publicSettings,
        createCatalogService(publicSettings),
      );
    expect((await invoke(open, "/api/auth/session")).body).toEqual({
      sessionToken: null,
      authenticationRequired: false,
    });
  });
  it("validates bounded session TTL and allows the session header in preflight", async () => {
    expect(() => loadConfig({ CATALOG_SESSION_TTL_SECONDS: "299" })).toThrow(
      /TTL/,
    );
    expect(() => loadConfig({ CATALOG_SESSION_TTL_SECONDS: "86401" })).toThrow(
      /TTL/,
    );
    const settings = config(),
      handler = createCatalogHandler(settings, createCatalogService(settings));
    const result = await invoke(
      handler,
      "/api/catalog/top",
      { origin: "https://egeduoru.github.io" },
      "OPTIONS",
    );
    expect(result.headers["Access-Control-Allow-Headers"]).toContain(
      "X-NoteSound-Session",
    );
  });
});
