import { describe, it, expect, vi } from "vitest";
import { createLicensedProvider } from "./licensed";
const track = {
  id: "licensed:original",
  sourceId: "licensed",
  title: "Original",
  artist: "Owner",
  duration: 120,
  genres: [],
  playbackMode: "audio",
  rights: {
    status: "confirmed",
    basis: "license",
    evidence: "Owner grant",
    allowMix: true,
  },
  license: { name: "Permission", download: false },
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
describe("LicensedAudioProvider", () => {
  it("resolves only a server-confirmed playable source and verified mix capability", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url: string | URL | Request) =>
      String(url).includes("/api/auth/session")
        ? response({
            sessionToken: "test-session",
            expiresAt: Date.now() + 28800000,
          })
        : String(url).includes("/playable/")
          ? response({
              rightsConfirmed: true,
              source: {
                url: "https://audio.example/original.mp3",
                cors: true,
                allowMix: true,
              },
            })
          : response({ tracks: [track], enabled: true }),
    );
    const provider = createLicensedProvider({
      apiUrl: "https://catalog.example",
      fetcher,
      getInitData: () => "signed-init-data",
    });
    const [item] = await provider.getTopTracks();
    expect(item.rights?.allowMix).toBe(false);
    expect(await provider.resolveStream(item)).toBe(
      "https://audio.example/original.mp3",
    );
    expect(item.rights?.allowMix).toBe(true);
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({
      "X-Telegram-Init-Data": "signed-init-data",
    });
    expect(fetcher.mock.calls[1][1]?.headers).toEqual({
      "X-NoteSound-Session": "test-session",
    });
  });
  it("refuses a forged/unsafe audio URL and denied playback", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url: string | URL | Request) =>
      String(url).includes("/playable/")
        ? response({
            rightsConfirmed: true,
            source: { url: "javascript:alert(1)", cors: true },
          })
        : response({ tracks: [track], enabled: true }),
    );
    const provider = createLicensedProvider({
      apiUrl: "https://catalog.example",
      fetcher,
    });
    const [item] = await provider.getTopTracks();
    expect(await provider.resolveStream(item)).toBeNull();
    const denied = createLicensedProvider({
      apiUrl: "https://catalog.example",
      fetcher: async (url) =>
        String(url).includes("/playable/")
          ? response({ source: null }, 403)
          : response({ tracks: [track], enabled: true }),
    });
    const [entry] = await denied.getTopTracks();
    expect(await denied.checkAvailability(entry)).toBe(false);
  });
});
