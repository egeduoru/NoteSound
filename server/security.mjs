import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { createHmac, timingSafeEqual } from "node:crypto";
import { safePublicUrl } from "./catalog-model.mjs";

export function isPublicAddress(address) {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(ip) !== 6) return false;
  if (ip.startsWith("::ffff:")) return isPublicAddress(ip.slice(7));
  const prefix = Number.parseInt(ip.split(":")[0], 16);
  return prefix >= 0x2000 && prefix <= 0x3fff && !ip.startsWith("2001:db8:");
}
export async function resolvePublicUrl(input, allowedHosts, resolver = lookup) {
  const safe = safePublicUrl(input, allowedHosts);
  if (!safe) throw new Error("External URL is not permitted");
  const url = new URL(safe);
  const records = isIP(url.hostname.replace(/^\[|\]$/g, ""))
    ? [
        {
          address: url.hostname.replace(/^\[|\]$/g, ""),
          family: isIP(url.hostname.replace(/^\[|\]$/g, "")),
        },
      ]
    : await resolver(url.hostname, { all: true, verbatim: true });
  if (
    !records.length ||
    records.some((record) => !isPublicAddress(record.address))
  )
    throw new Error("External host resolves to a non-public address");
  return { url, records };
}
/** DNS answers are validated then pinned into the TLS connection, preventing rebinding. Redirects are never followed. */
export async function guardedRequest(
  input,
  {
    allowedHosts,
    method = "GET",
    signal,
    timeoutMs = 8000,
    maxBytes = 2 * 1024 * 1024,
    responseType = "text",
    headers = {},
    resolver = lookup,
  } = {},
) {
  if (!["text", "buffer"].includes(responseType))
    throw new Error("Unsupported external response type");
  if (signal?.aborted)
    throw signal.reason || new DOMException("Cancelled", "AbortError");
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  let dnsAbort;
  let target;
  try {
    target = await Promise.race([
      resolvePublicUrl(input, allowedHosts || [], resolver),
      new Promise((_, reject) => {
        dnsAbort = () =>
          reject(
            requestSignal.reason || new DOMException("Cancelled", "AbortError"),
          );
        if (requestSignal.aborted) dnsAbort();
        else requestSignal.addEventListener("abort", dnsAbort, { once: true });
      }),
    ]);
  } finally {
    if (dnsAbort) requestSignal.removeEventListener("abort", dnsAbort);
  }
  const { url, records } = target;
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method,
        signal: requestSignal,
        headers: { accept: "application/json", ...headers },
        lookup: (_hostname, options, callback) => {
          if (options?.all) callback(null, records);
          else callback(null, records[0].address, records[0].family);
        },
      },
      (response) => {
        const status = response.statusCode || 0;
        if (status < 200 || status >= 300) {
          response.destroy();
          reject(new Error(`External service returned HTTP ${status}`));
          return;
        }
        let bytes = 0;
        const chunks = [];
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            response.destroy(new Error("External response is too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status,
            headers: response.headers,
            body:
              responseType === "buffer"
                ? Buffer.concat(chunks)
                : Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
}
export function validateTelegramInitData(
  initData,
  botToken,
  { now = Date.now(), maxAgeSeconds = 300 } = {},
) {
  if (typeof initData !== "string" || initData.length > 12000 || !botToken)
    return null;
  const params = new URLSearchParams(initData),
    keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) return null;
  const provided = params.get("hash");
  if (!provided || !/^[a-f0-9]{64}$/i.test(provided)) return null;
  const authenticatedAt = Number(params.get("auth_date"));
  const age = Math.floor(now / 1000) - authenticatedAt;
  if (
    !Number.isSafeInteger(authenticatedAt) ||
    age < -30 ||
    age > maxAgeSeconds
  )
    return null;
  const check = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  const candidate = Buffer.from(provided, "hex");
  if (
    candidate.length !== expected.length ||
    !timingSafeEqual(candidate, expected)
  )
    return null;
  try {
    const user = JSON.parse(params.get("user") || "null");
    return Number.isSafeInteger(user?.id) && user.id > 0
      ? { userId: user.id, authenticatedAt }
      : null;
  } catch {
    return null;
  }
}
const sessionKey = (botToken) =>
  createHmac("sha256", botToken).update("NoteSoundCatalogSessionV1").digest();
export function issueCatalogSession(
  userId,
  botToken,
  { now = Date.now(), ttlSeconds = 28800, origin = "" } = {},
) {
  if (
    !botToken ||
    !Number.isSafeInteger(userId) ||
    userId <= 0 ||
    !Number.isFinite(now) ||
    !Number.isSafeInteger(ttlSeconds)
  )
    throw new Error("Invalid session configuration");
  const lifetime = Math.min(86400, Math.max(300, ttlSeconds));
  const iat = Math.floor(now / 1000),
    exp = iat + lifetime;
  const payload = Buffer.from(
    JSON.stringify({ v: 1, userId, iat, exp, origin }),
  ).toString("base64url");
  const signature = createHmac("sha256", sessionKey(botToken))
    .update(payload)
    .digest("base64url");
  return { sessionToken: `${payload}.${signature}`, expiresAt: exp * 1000 };
}
export function validateCatalogSession(
  token,
  botToken,
  { now = Date.now(), origin = "" } = {},
) {
  if (
    !botToken ||
    typeof token !== "string" ||
    token.length > 2048 ||
    !Number.isFinite(now)
  )
    return null;
  const parts = token.split(".");
  if (
    parts.length !== 2 ||
    !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
  )
    return null;
  try {
    const expected = createHmac("sha256", sessionKey(botToken))
      .update(parts[0])
      .digest();
    const supplied = Buffer.from(parts[1], "base64url");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return null;
    const payload = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8"),
    );
    const seconds = Math.floor(now / 1000);
    if (
      payload.v !== 1 ||
      !Number.isSafeInteger(payload.userId) ||
      payload.userId <= 0 ||
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) ||
      payload.iat > seconds ||
      payload.exp <= seconds ||
      payload.exp - payload.iat < 300 ||
      payload.exp - payload.iat > 86400 ||
      payload.origin !== origin
    )
      return null;
    return { userId: payload.userId, expiresAt: payload.exp * 1000 };
  } catch {
    return null;
  }
}
export class ConcurrencyGate {
  active = 0;
  waiting = [];
  constructor(limit = 2, maxWaiting = 16) {
    this.limit = limit;
    this.maxWaiting = maxWaiting;
  }
  async run(operation, signal) {
    if (this.active >= this.limit) {
      if (this.waiting.length >= this.maxWaiting)
        throw new Error("Catalog is busy");
      await new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        const cancelled = () => {
          this.waiting = this.waiting.filter((item) => item !== waiter);
          reject(signal.reason || new DOMException("Cancelled", "AbortError"));
        };
        waiter.resolve = () => {
          signal?.removeEventListener("abort", cancelled);
          resolve();
        };
        this.waiting.push(waiter);
        if (signal?.aborted) cancelled();
        else signal?.addEventListener("abort", cancelled, { once: true });
      });
    } else this.active++;
    const release = () => {
      const next = this.waiting.shift();
      if (next) next.resolve();
      else this.active--;
    };
    if (signal?.aborted) {
      release();
      throw signal.reason || new DOMException("Cancelled", "AbortError");
    }
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
export class RateLimiter {
  entries = new Map();
  constructor(limit = 60, windowMs = 60000, maxKeys = 5000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }
  allow(key, now = Date.now()) {
    for (const [existing, value] of this.entries)
      if (value.until <= now) this.entries.delete(existing);
    const hit = this.entries.get(key);
    if (!hit) {
      if (this.entries.size >= this.maxKeys) return false;
      this.entries.set(key, { until: now + this.windowMs, count: 1 });
      return true;
    }
    return ++hit.count <= this.limit;
  }
  retryAfter(key, now = Date.now()) {
    const until = this.entries.get(key)?.until ?? now + this.windowMs;
    return Math.max(1, Math.ceil((until - now) / 1000));
  }
}
