import { createServer } from "node:http";
import { createMusicIntelligence } from "./music-intelligence.mjs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicCatalogService } from "./public-catalog.mjs";
import { createDeezerService } from "./deezer.mjs";
import { ArtworkRequestError, createArtworkService } from "./artwork.mjs";
import {
  normalizeHitmozPayload,
  normalizeLicensedTracks,
  metadataKey,
  safePublicUrl,
} from "./catalog-model.mjs";
import {
  guardedRequest,
  validateTelegramInitData,
  issueCatalogSession,
  validateCatalogSession,
  ConcurrencyGate,
  RateLimiter,
} from "./security.mjs";

const yes = (value) => value === "true";
const list = (value) =>
  (value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
export function loadConfig(env = process.env) {
  const config = {
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT || 3001),
    metadataEnabled: yes(env.HITMOZ_METADATA_ENABLED),
    playbackEnabled: yes(env.HITMOZ_PLAYBACK_ENABLED),
    parserUrl: env.HITMOZ_PARSER_URL || "",
    parserHosts: list(env.HITMOZ_PARSER_ALLOWED_HOSTS),
    audioHosts: list(env.LICENSED_AUDIO_ALLOWED_HOSTS),
    origins: (
      env.APP_ORIGINS || "http://127.0.0.1:5173,https://egeduoru.github.io"
    )
      .split(",")
      .map((value) => value.trim()),
    requireAuth: yes(env.REQUIRE_TELEGRAM_AUTH),
    botToken: env.BOT_TOKEN || "",
    sessionTtlSeconds: Number(env.CATALOG_SESSION_TTL_SECONDS || 28800),
    registryPath: resolve(env.LICENSED_CATALOG_FILE || "server/licenses.json"),
    soundcloudApproved: yes(env.SOUNDCLOUD_CATALOG_APPROVED),
    soundcloudClientId: env.SOUNDCLOUD_CLIENT_ID || "",
    soundcloudClientSecret: env.SOUNDCLOUD_CLIENT_SECRET || "",
    musicbrainzContact: env.MUSICBRAINZ_CONTACT || "https://github.com/",
  };
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)
    throw new Error("Invalid PORT");
  if (
    !Number.isSafeInteger(config.sessionTtlSeconds) ||
    config.sessionTtlSeconds < 300 ||
    config.sessionTtlSeconds > 86400
  )
    throw new Error(
      "CATALOG_SESSION_TTL_SECONDS must be between 300 and 86400",
    );
  if (config.requireAuth && !config.botToken)
    throw new Error("BOT_TOKEN is required when REQUIRE_TELEGRAM_AUTH=true");
  if (
    config.metadataEnabled &&
    !safePublicUrl(config.parserUrl, config.parserHosts)
  )
    throw new Error(
      "Configure an allowlisted HTTPS HITMOZ_PARSER_URL before enabling metadata",
    );
  for (const origin of config.origins) {
    const parsed = new URL(origin);
    if (
      origin !== parsed.origin ||
      !["https:", "http:"].includes(parsed.protocol) ||
      (parsed.protocol === "http:" &&
        !["127.0.0.1", "localhost"].includes(parsed.hostname))
    )
      throw new Error(
        "APP_ORIGINS must contain exact HTTPS origins or localhost development origins",
      );
  }
  return config;
}
export async function loadRegistry(config) {
  try {
    const source = await readFile(config.registryPath, "utf8");
    if (Buffer.byteLength(source) > 2 * 1024 * 1024)
      throw new Error("License registry too large");
    const parsed = JSON.parse(source);
    return normalizeLicensedTracks(parsed.tracks, config.audioHosts);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
export function createCatalogService(
  config,
  {
    externalRequest = guardedRequest,
    registryTracks = [],
    now = Date.now,
  } = {},
) {
  const gate = new ConcurrencyGate(2, 16),
    cache = new Map(),
    pending = new Map(),
    details = new Map();
  const registry = new Map(
    normalizeLicensedTracks(registryTracks, config.audioHosts).map((track) => [
      track.id,
      track,
    ]),
  );
  const withRights = (track) => {
    if (!track) return null;
    const license = registry.get(track.id);
    if (!license) return track;
    const result = {
      ...track,
      ...license,
      availability: "unknown",
      playbackMode:
        track.sourceId === "hitmoz" && !config.playbackEnabled
          ? "metadata"
          : "audio",
    };
    if (result.playbackMode === "metadata") delete result.audioSource;
    return result;
  };
  const remember = (tracks) => {
    for (const track of tracks) details.set(track.id, track);
    while (details.size > 2500) details.delete(details.keys().next().value);
    return tracks;
  };
  async function cached(key, ttl, work, signal) {
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.value;
    if (signal?.aborted) throw signal.reason;
    // Shared requests have their own short deadline; one caller cannot cancel another caller's cache fill.
    let task = pending.get(key);
    if (!task) {
      const lifetime = AbortSignal.timeout(10000);
      task = gate
        .run(() => work(lifetime), lifetime)
        .then((value) => {
          while (cache.size >= 100) cache.delete(cache.keys().next().value);
          cache.set(key, { until: now() + ttl, value });
          return value;
        })
        .finally(() => pending.delete(key));
      pending.set(key, task);
    }
    if (!signal) return task;
    let abort;
    try {
      return await Promise.race([
        task,
        new Promise((_, reject) => {
          abort = () =>
            reject(
              signal.reason || new DOMException("Cancelled", "AbortError"),
            );
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  }
  async function hitmoz(mode, query, signal) {
    if (!config.metadataEnabled)
      return {
        tracks: [],
        source: "hitmoz",
        enabled: false,
        warning:
          "Hitmoz отключён: доступ к каталогу и права ещё не подтверждены.",
      };
    const tracks = await cached(
      `${mode}:${metadataKey(query)}`,
      mode === "top" ? 900000 : 300000,
      async (requestSignal) => {
        const url = new URL(config.parserUrl);
        url.search = "";
        if (mode === "top") url.searchParams.set("top-today", "");
        else url.searchParams.set("search", query);
        const response = await externalRequest(url.href, {
          allowedHosts: config.parserHosts,
          signal: requestSignal,
          headers: { accept: "application/json" },
        });
        const mime = String(response.headers["content-type"] || "");
        if (!/\bapplication\/(?:[\w.+-]*\+)?json\b/i.test(mime))
          throw new Error("Parser did not return JSON");
        return remember(
          normalizeHitmozPayload(JSON.parse(response.body)).map(withRights),
        );
      },
      signal,
    );
    return { tracks, source: "hitmoz", enabled: true };
  }
  return {
    status: () => ({
      hitmoz: {
        metadataEnabled: config.metadataEnabled,
        playbackEnabled: config.playbackEnabled,
        reason: config.metadataEnabled
          ? null
          : "Требуется разрешение на каталог и настройка собственного Parser API.",
      },
      licensed: {
        count: [...registry.values()].filter(
          (track) => track.sourceId === "licensed",
        ).length,
      },
      authenticationRequired: config.requireAuth,
    }),
    async search(source, query, signal) {
      if (source === "hitmoz") return hitmoz("search", query, signal);
      const terms = metadataKey(query).split(" ").filter(Boolean);
      const tracks = [...registry.values()].filter(
        (track) =>
          track.sourceId === "licensed" &&
          terms.every((word) =>
            metadataKey(`${track.artist} ${track.title}`).includes(word),
          ),
      );
      return { tracks: remember(tracks), source: "licensed", enabled: true };
    },
    async top(source, signal) {
      if (source === "hitmoz") return hitmoz("top", "", signal);
      return {
        tracks: remember(
          [...registry.values()]
            .filter((track) => track.sourceId === "licensed")
            .sort(
              (a, b) => (a.popularity || Infinity) - (b.popularity || Infinity),
            )
            .slice(0, 100),
        ),
        source: "licensed",
        enabled: true,
      };
    },
    track: (id) => withRights(details.get(id) || registry.get(id) || null),
    async playable(id, signal, origin) {
      const track = registry.get(id);
      if (
        !track ||
        track.rights.status !== "confirmed" ||
        !track.audioSource ||
        (track.sourceId === "hitmoz" && !config.playbackEnabled)
      )
        return null;
      return cached(
        `audio:${id}:${origin || ""}`,
        60000,
        async (requestSignal) => {
          const response = await externalRequest(track.audioSource.url, {
            allowedHosts: config.audioHosts,
            method: "HEAD",
            signal: requestSignal,
            maxBytes: 1024,
            headers: origin ? { origin } : {},
          });
          const mime = String(response.headers["content-type"] || "")
            .split(";")[0]
            .trim()
            .toLowerCase();
          if (
            ![
              "audio/mpeg",
              "audio/mp4",
              "audio/x-m4a",
              "audio/aac",
              "audio/wav",
              "audio/x-wav",
              "audio/ogg",
              "audio/flac",
              "audio/x-flac",
            ].includes(mime)
          )
            throw new Error("Source is not a supported audio file");
          const corsHeader = response.headers["access-control-allow-origin"];
          const cors =
            track.audioSource.cors === true &&
            (corsHeader === "*" || (!!origin && corsHeader === origin));
          return {
            url: track.audioSource.url,
            cors,
            allowMix: track.rights.allowMix === true && cors,
            expiresAt: now() + 60000,
          };
        },
        signal,
      );
    },
  };
}
function send(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(payload));
}
// Separate bounded budgets prevent cloud artwork or recommendation metadata
// from spending the requests needed to start an already chosen audio track.
function requestBudget(path) {
  if (path === "/api/discovery/artwork") return "artwork";
  if (path.startsWith("/api/music/") || path === "/api/discovery/soundcloud/search") return "metadata";
  if (
    /^\/api\/(?:discovery\/(?:public|deezer)\/track\/|catalog\/(?:track|playable)\/)/.test(
      path,
    )
  )
    return "playback";
  if (
    /^\/api\/(?:discovery\/(?:public|deezer)\/(?:search|related)$|catalog\/(?:search|top)$)/.test(
      path,
    )
  )
    return "metadata";
  if (path === "/api/auth/session") return "session";
  return "status";
}
function rateLimited(response, limiter, key) {
  const retryAfterSeconds = Math.min(
    3600,
    Math.max(1, limiter.retryAfter?.(key) || 60),
  );
  response.setHeader("Retry-After", String(retryAfterSeconds));
  send(response, 429, {
    error: "rate_limited",
    retryAfterSeconds,
    message: `Слишком много запросов. Попробуйте через ${retryAfterSeconds} с.`,
  });
}
export function createCatalogHandler(
  config,
  service,
  {
    limiter = new RateLimiter(),
    userLimiter = new RateLimiter(90),
    artwork = createArtworkService(),
    music = createMusicIntelligence({
      soundcloudApproved: config.soundcloudApproved,
      clientId: config.soundcloudClientId,
      clientSecret: config.soundcloudClientSecret,
      appContact: config.musicbrainzContact,
    }),
    discovery = {
      public: createPublicCatalogService(),
      deezer: createDeezerService(),
    },
  } = {},
) {
  return async (request, response) => {
    const origin = request.headers.origin;
    if (origin && !config.origins.includes(origin)) {
      send(response, 403, { error: "origin_not_allowed" });
      return;
    }
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Expose-Headers", "Retry-After");
      response.setHeader("Vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      response.setHeader(
        "Access-Control-Allow-Headers",
        "X-Telegram-Init-Data, X-NoteSound-Session",
      );
      response.setHeader("Access-Control-Max-Age", "600");
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method !== "GET") {
      send(response, 405, { error: "method_not_allowed" });
      return;
    }
    let url;
    try {
      url = new URL(request.url, "http://catalog.local");
    } catch {
      send(response, 400, { error: "invalid_url" });
      return;
    }
    const budget = requestBudget(url.pathname);
    const addressKey = `${budget}:${request.socket.remoteAddress || "unknown"}`;
    if (!limiter.allow(addressKey)) {
      rateLimited(response, limiter, addressKey);
      return;
    }
    if (url.pathname === "/api/catalog/status") {
      send(response, 200, service.status());
      return;
    }
    if (url.pathname === "/api/auth/session") {
      if (!config.requireAuth) {
        send(response, 200, {
          sessionToken: null,
          authenticationRequired: false,
        });
        return;
      }
      const identity = validateTelegramInitData(
        request.headers["x-telegram-init-data"],
        config.botToken,
      );
      if (!identity) {
        send(response, 401, {
          error: "telegram_auth_required",
          message:
            "Сеанс Telegram устарел. Закройте и заново откройте приложение.",
        });
        return;
      }
      const userKey = `${budget}:${identity.userId}`;
      if (!userLimiter.allow(userKey)) {
        rateLimited(response, userLimiter, userKey);
        return;
      }
      const issued = issueCatalogSession(identity.userId, config.botToken, {
        origin: origin || "",
        ttlSeconds: config.sessionTtlSeconds,
      });
      send(response, 200, { ...issued, authenticationRequired: true });
      return;
    }
    if (config.requireAuth) {
      const token = request.headers["x-notesound-session"];
      const identity =
        token === undefined
          ? validateTelegramInitData(
              request.headers["x-telegram-init-data"],
              config.botToken,
            )
          : validateCatalogSession(token, config.botToken, {
              origin: origin || "",
            });
      if (!identity) {
        send(response, 401, {
          error: "telegram_auth_required",
          message:
            "Сеанс Telegram устарел. Закройте и заново откройте приложение.",
        });
        return;
      }
      const userKey = `${budget}:${identity.userId}`;
      if (!userLimiter.allow(userKey)) {
        rateLimited(response, userLimiter, userKey);
        return;
      }
    }
    if (["/api/music/metadata", "/api/music/recommendations", "/api/music/similar", "/api/discovery/soundcloud/search"].includes(url.pathname)) {
      const query = url.searchParams.get("q") || "";
      const username = url.searchParams.get("username") || "";
      if (query.length > 160 || /\p{Cc}/u.test(query) || username.length > 80) {
        send(response, 400, { error: "invalid_query" });
        return;
      }
      try {
        if (url.pathname === "/api/music/metadata")
          send(response, 200, { recordings: await music.metadata(query) });
        else if (url.pathname === "/api/music/recommendations")
          send(response, 200, { recommendations: await music.listenBrainzUser(username) });
        else if (url.pathname === "/api/music/similar")
          send(response, 200, { recommendations: await music.similarByRecording(query) });
        else send(response, 200, await music.soundcloudSearch(query));
      } catch {
        send(response, 502, { error: "music_metadata_unavailable", tracks: [], recordings: [], recommendations: [] });
      }
      return;
    }
    if (url.pathname === "/api/discovery/artwork") {
      const urls = url.searchParams.getAll("url");
      if (urls.length !== 1 || url.searchParams.size !== 1) {
        send(response, 400, { error: "invalid_artwork_url" });
        return;
      }
      const controller = new AbortController();
      const cancel = () => controller.abort();
      const timer = setTimeout(cancel, 10_000);
      const close = () => {
        if (!response.writableEnded) cancel();
      };
      request.on("aborted", cancel);
      response.on("close", close);
      try {
        const image = await artwork.read(urls[0], controller.signal);
        response.statusCode = 200;
        response.setHeader("Content-Type", image.contentType);
        response.setHeader("Content-Length", image.body.length);
        response.setHeader("Cache-Control", "private, max-age=600");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.end(image.body);
      } catch (error) {
        if (!response.writableEnded)
          send(
            response,
            error instanceof ArtworkRequestError ? error.status : 502,
            {
              error:
                error instanceof ArtworkRequestError
                  ? error.code
                  : "artwork_unavailable",
            },
          );
      } finally {
        clearTimeout(timer);
        request.off("aborted", cancel);
        response.off("close", close);
      }
      return;
    }
    if (url.pathname.startsWith("/api/discovery/")) {
      const route = url.pathname.match(
        /^\/api\/discovery\/(public|deezer)\/(search|related|track\/([^/]+))$/,
      );
      if (!route || (route[2] === "related" && route[1] !== "deezer")) {
        send(response, 404, { error: "not_found" });
        return;
      }
      const query = (
        url.searchParams.get(route[2] === "related" ? "artist" : "q") || ""
      ).trim();
      if (query.length > 160 || /\p{Cc}/u.test(query)) {
        send(response, 400, { error: "invalid_query" });
        return;
      }
      const controller = new AbortController();
      const cancel = () => controller.abort();
      const timer = setTimeout(cancel, 12000);
      request.on("aborted", cancel);
      const close = () => {
        if (!response.writableEnded) cancel();
      };
      response.on("close", close);
      try {
        const provider = discovery[route[1]];
        if (route[2] === "search") {
          send(
            response,
            200,
            query
              ? await provider.search(query, controller.signal)
              : { tracks: [] },
          );
        } else if (route[2] === "related") {
          send(
            response,
            200,
            query
              ? await provider.relatedArtists(query, controller.signal)
              : { artists: [] },
          );
        } else {
          let id;
          try {
            id = decodeURIComponent(route[3]);
          } catch {
            send(response, 400, { error: "invalid_id" });
            return;
          }
          if (
            !(
              route[1] === "deezer"
                ? /^deezer:[1-9]\d{0,14}$/
                : /^public:la-[a-f0-9]{24}$/
            ).test(id)
          ) {
            send(response, 400, { error: "invalid_id" });
            return;
          }
          const track = await provider.track(id, controller.signal);
          send(response, track ? 200 : 404, { track });
        }
      } catch {
        if (!response.writableEnded)
          send(response, 502, {
            error: "source_unavailable",
            message:
              "Этот музыкальный источник не ответил. Попробуйте другой результат или повторите поиск.",
          });
      } finally {
        clearTimeout(timer);
        request.off("aborted", cancel);
        response.off("close", close);
      }
      return;
    }
    const source = url.searchParams.get("source") || "licensed";
    if (!["hitmoz", "licensed"].includes(source)) {
      send(response, 400, { error: "invalid_source" });
      return;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.on("aborted", cancel);
    response.on("close", () => {
      if (!response.writableEnded) cancel();
    });
    try {
      if (url.pathname === "/api/catalog/search") {
        const query = url.searchParams.get("q") || "";
        if (
          query.length > 300 ||
          Array.from(query).some((character) => character.charCodeAt(0) < 32)
        ) {
          send(response, 400, { error: "invalid_query" });
          return;
        }
        send(
          response,
          200,
          query.trim()
            ? await service.search(source, query.trim(), controller.signal)
            : { tracks: [], source, enabled: true },
        );
        return;
      }
      if (url.pathname === "/api/catalog/top") {
        send(response, 200, await service.top(source, controller.signal));
        return;
      }
      const route = url.pathname.match(
        /^\/api\/catalog\/(track|playable)\/([^/]+)$/,
      );
      if (!route) {
        send(response, 404, { error: "not_found" });
        return;
      }
      let id;
      try {
        id = decodeURIComponent(route[2]);
      } catch {
        send(response, 400, { error: "invalid_id" });
        return;
      }
      if (!/^(?:hitmoz|licensed):[\w-]{1,200}$/.test(id)) {
        send(response, 400, { error: "invalid_id" });
        return;
      }
      if (route[1] === "track") {
        const track = service.track(id);
        send(response, track ? 200 : 404, { track });
        return;
      }
      const playable = await service.playable(id, controller.signal, origin);
      send(
        response,
        playable ? 200 : 403,
        playable
          ? { source: playable, rightsConfirmed: true }
          : {
              source: null,
              error: "playback_not_authorized",
              message:
                "Нет подтверждённых прав или разрешённого аудиоисточника.",
            },
      );
    } catch {
      if (!controller.signal.aborted && !response.writableEnded)
        send(response, 502, {
          error: "catalog_unavailable",
          message:
            "Музыкальный источник временно недоступен. Попробуйте позже.",
        });
    } finally {
      request.off("aborted", cancel);
    }
  };
}
export async function startCatalogServer(config = loadConfig()) {
  const registryTracks = await loadRegistry(config),
    service = createCatalogService(config, { registryTracks });
  const server = createServer(createCatalogHandler(config, service));
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const server = await startCatalogServer();
    console.log(
      `NoteSound catalog server listening on ${server.address().address}:${server.address().port}`,
    );
  } catch {
    console.error(
      "Catalog server could not start. Check server environment configuration.",
    );
    process.exitCode = 1;
  }
}
