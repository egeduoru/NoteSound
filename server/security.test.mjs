import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  isPublicAddress,
  resolvePublicUrl,
  guardedRequest,
  validateTelegramInitData,
  issueCatalogSession,
  validateCatalogSession,
  ConcurrencyGate,
  RateLimiter,
} from "./security.mjs";
function sign(values, token = "test-token") {
  const params = new URLSearchParams(values);
  params.sort();
  const text = [...params].map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(text).digest("hex"));
  return params.toString();
}
describe("catalog SSRF boundary", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "172.16.1.1",
    "192.168.0.1",
    "100.64.0.2",
    "192.0.2.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2001:db8::2",
  ])("blocks non-public %s", (ip) => expect(isPublicAddress(ip)).toBe(false));
  it("rejects a mixed public/private DNS answer and exact hostname spoofing", async () => {
    await expect(
      resolvePublicUrl(
        "https://catalog.example/index.php",
        ["catalog.example"],
        async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      ),
    ).rejects.toThrow(/non-public/);
    await expect(
      resolvePublicUrl(
        "https://catalog.example.attacker.test/index.php",
        ["catalog.example"],
        vi.fn(),
      ),
    ).rejects.toThrow(/not permitted/);
    await expect(
      resolvePublicUrl(
        "https://user:pass@catalog.example/index.php",
        ["catalog.example"],
        vi.fn(),
      ),
    ).rejects.toThrow(/not permitted/);
  });
  it("accepts allowed DNS and times out unresolved DNS without starting HTTP", async () => {
    const result = await resolvePublicUrl(
      "https://catalog.example/index.php",
      ["catalog.example"],
      async () => [{ address: "93.184.216.34", family: 4 }],
    );
    expect(result.records[0].address).toBe("93.184.216.34");
    await expect(
      guardedRequest("https://catalog.example/index.php", {
        allowedHosts: ["catalog.example"],
        resolver: () => new Promise(() => {}),
        timeoutMs: 20,
      }),
    ).rejects.toThrow();
  });
});
describe("Telegram initData HMAC", () => {
  const now = 1_800_000_000_000;
  const values = {
    auth_date: String(now / 1000),
    user: JSON.stringify({ id: 123, first_name: "User" }),
    signature: "signed-extra-field",
  };
  it("validates a fresh HMAC including received signature, independent of client userId", () =>
    expect(
      validateTelegramInitData(sign(values), "test-token", { now }),
    ).toEqual({ userId: 123, authenticatedAt: now / 1000 }));
  it("rejects tampering, expired/future data, duplicates and wrong bot", () => {
    const data = sign(values);
    expect(
      validateTelegramInitData(
        data.replace("signed-extra-field", "tampered"),
        "test-token",
        { now },
      ),
    ).toBeNull();
    expect(validateTelegramInitData(data, "wrong-token", { now })).toBeNull();
    expect(
      validateTelegramInitData(data, "test-token", { now: now + 301000 }),
    ).toBeNull();
    expect(
      validateTelegramInitData(data, "test-token", { now: now - 31000 }),
    ).toBeNull();
    expect(
      validateTelegramInitData(`${data}&user=another`, "test-token", { now }),
    ).toBeNull();
  });
});
describe("bounded catalog work", () => {
  it("limits concurrent work and releases slots after errors/cancellation", async () => {
    const gate = new ConcurrencyGate(2, 4);
    let active = 0,
      peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        gate
          .run(async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 2));
            active--;
            if (i === 2) throw new Error("fixture");
          })
          .catch(() => {}),
      ),
    );
    expect(peak).toBe(2);
    expect(gate.active).toBe(0);
    const controller = new AbortController();
    controller.abort();
    await expect(gate.run(async () => {}, controller.signal)).rejects.toThrow();
    expect(gate.active).toBe(0);
  });
  it("bounds rate-limit memory and resets expired windows", () => {
    const limiter = new RateLimiter(2, 100, 1);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 1)).toBe(true);
    expect(limiter.allow("a", 2)).toBe(false);
    expect(limiter.allow("b", 3)).toBe(false);
    expect(limiter.allow("b", 101)).toBe(true);
  });
});

describe("catalog listening sessions", () => {
  const now = 1800000000000,
    token = "session-test-token",
    origin = "https://egeduoru.github.io";
  it("keeps a signed listening session valid beyond initData freshness", () => {
    const issued = issueCatalogSession(42, token, { now, origin });
    expect(
      validateCatalogSession(issued.sessionToken, token, {
        now: now + 20 * 60000,
        origin,
      }),
    ).toEqual({ userId: 42, expiresAt: issued.expiresAt });
    expect(issued.expiresAt).toBe(now + 8 * 3600000);
  });
  it("rejects expired, future-issued, wrong-origin and wrong-key tokens", () => {
    const issued = issueCatalogSession(42, token, {
      now,
      origin,
      ttlSeconds: 300,
    });
    expect(
      validateCatalogSession(issued.sessionToken, token, {
        now: now + 300000,
        origin,
      }),
    ).toBeNull();
    expect(
      validateCatalogSession(issued.sessionToken, token, {
        now: now - 1000,
        origin,
      }),
    ).toBeNull();
    expect(
      validateCatalogSession(issued.sessionToken, token, {
        now,
        origin: "https://evil.example",
      }),
    ).toBeNull();
    expect(
      validateCatalogSession(issued.sessionToken, "wrong", { now, origin }),
    ).toBeNull();
    expect(
      validateCatalogSession(issued.sessionToken, token, { now }),
    ).toBeNull();
  });
  it("rejects tampered identity and malformed signatures", () => {
    const issued = issueCatalogSession(42, token, { now, origin });
    const [body, sig] = issued.sessionToken.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url"));
    payload.userId = 7;
    const altered =
      Buffer.from(JSON.stringify(payload)).toString("base64url") + "." + sig;
    expect(validateCatalogSession(altered, token, { now, origin })).toBeNull();
    for (const bad of [
      "",
      body,
      issued.sessionToken + "!",
      "x.y",
      issued.sessionToken + ".extra",
      "a".repeat(2050),
    ])
      expect(validateCatalogSession(bad, token, { now, origin })).toBeNull();
  });
  it("bounds issuance and does not put the bot token into the returned session", () => {
    expect(() => issueCatalogSession(0, token, { now })).toThrow();
    expect(() => issueCatalogSession(42, "", { now })).toThrow();
    expect(() =>
      issueCatalogSession(42, token, { now, ttlSeconds: NaN }),
    ).toThrow();
    const issued = issueCatalogSession(42, token, { now, ttlSeconds: 999999 });
    expect(issued.expiresAt - now).toBe(86400000);
    expect(JSON.stringify(issued)).not.toContain(token);
  });
});
