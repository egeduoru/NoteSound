import { describe, it, expect, vi } from "vitest";
import { issueCatalogSession } from "./security.mjs";
import { sendLicensedAudio } from "./telegram-audio.mjs";
const botToken = "test-token",
  origin = "https://app.example";
const sessionToken = () =>
  issueCatalogSession(42, botToken, { origin }).sessionToken;
const track = {
  title: "Owned",
  artist: "Owner",
  duration: 120,
  rights: { status: "confirmed", allowTelegramDelivery: true },
};
const fixture = () => ({
  track: vi.fn(() => track),
  playable: vi.fn(async () => ({ url: "https://audio.example/song.mp3" })),
});
describe("optional authenticated Telegram audio delivery", () => {
  it("defaults off and never contacts Telegram", async () => {
    const fetcher = vi.fn();
    await expect(
      sendLicensedAudio(
        { trackId: "licensed:one" },
        { botToken, service: fixture(), fetcher },
      ),
    ).rejects.toThrow("disabled");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects an unverified user or a registry without delivery permission", async () => {
    const service = fixture(),
      fetcher = vi.fn();
    await expect(
      sendLicensedAudio(
        { trackId: "licensed:one", sessionToken: "forged", origin },
        { enabled: true, botToken, service, fetcher },
      ),
    ).rejects.toThrow("authentication");
    service.track.mockReturnValue({
      ...track,
      rights: { status: "confirmed", allowTelegramDelivery: false },
    });
    await expect(
      sendLicensedAudio(
        { trackId: "licensed:one", sessionToken: sessionToken(), origin },
        { enabled: true, botToken, service, fetcher },
      ),
    ).rejects.toThrow("authorized");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("derives the recipient from a signed session and sends the approved URL without proxying", async () => {
    const service = fixture(),
      fetcher = vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 9 } }),
      }));
    expect(
      await sendLicensedAudio(
        {
          trackId: "licensed:one",
          sessionToken: sessionToken(),
          origin,
          chat_id: 777,
        },
        { enabled: true, botToken, service, fetcher },
      ),
    ).toEqual({ messageId: 9 });
    const payload = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(payload.chat_id).toBe(42);
    expect(payload.audio).toBe("https://audio.example/song.mp3");
    expect(service.playable).toHaveBeenCalledTimes(1);
  });
});
