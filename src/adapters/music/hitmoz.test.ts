import { describe, it, expect, vi } from "vitest";
import { createHitmozProvider, parseHitmozPayload } from "./hitmoz";
const song = {
  id: "hitmoz:81251971",
  sourceId: "hitmoz",
  title: "Династия",
  artist: "madk1d",
  duration: 150,
  genres: [],
  playbackMode: "metadata",
  rights: { status: "unknown", basis: "none", allowMix: false },
  license: { name: "Unknown", download: false },
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
describe("HitmozProvider", () => {
  it("decodes the source's real document contract and ignores download", () => {
    const [track] = parseHitmozPayload({
      success: true,
      songs: [
        {
          title: "Династия",
          artist: "madk1d",
          duration: "02:30",
          link: "https://eu.hitmoz.com/song/81251971",
          download: "https://eu.hitmoz.com/get/music/song.mp3",
        },
      ],
    });
    expect(track.id).toBe(song.id);
    expect(track.rights?.status).toBe("unknown");
    expect(track.streamUrl).toBeUndefined();
  });
  it("sends Cyrillic search through backend and caches metadata", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response({ tracks: [song, song], enabled: true }),
    );
    const provider = createHitmozProvider({
      apiUrl: "https://catalog.example",
      fetcher,
      getInitData: () => "",
    });
    expect(await provider.searchTracks(" Династия ")).toHaveLength(1);
    await provider.searchTracks("ДИНАСТИЯ");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      new URL(String(fetcher.mock.calls[0][0])).searchParams.get("q"),
    ).toBe("Династия");
    expect(await provider.getPlayableSource(song.id)).toBeNull();
  });
  it("makes no calls without API configuration and surfaces disabled access", async () => {
    const fetcher = vi.fn();
    expect(
      await createHitmozProvider({ apiUrl: "", fetcher }).getTopTracks(),
    ).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    const disabled = createHitmozProvider({
      apiUrl: "https://catalog.example",
      fetcher: async () =>
        response({
          enabled: false,
          tracks: [],
          warning: "Разрешение не получено",
        }),
    });
    await expect(disabled.getTopTracks()).rejects.toThrow(/Разрешение/);
    expect(disabled.status).toBe("restricted");
  });
  it("rejects changed shape, handles empty and propagates abort", async () => {
    await expect(
      createHitmozProvider({
        apiUrl: "https://catalog.example",
        fetcher: async () => response({ songs: [] }),
      }).searchTracks("song"),
    ).rejects.toThrow(/Формат/);
    expect(
      await createHitmozProvider({
        apiUrl: "https://catalog.example",
        fetcher: async () => response({ enabled: true, tracks: [] }),
      }).searchTracks("song"),
    ).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      createHitmozProvider({ apiUrl: "https://catalog.example" }).searchTracks(
        "song",
        controller.signal,
      ),
    ).rejects.toThrow();
  });
  it("does not transmit initData to invalid insecure configuration", async () => {
    const fetcher = vi.fn();
    expect(
      await createHitmozProvider({
        apiUrl: "http://untrusted.example",
        fetcher,
        getInitData: () => "private-data",
      }).getTopTracks(),
    ).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("catalog session client", () => {
  it("exchanges initData once and sends only the memory-held session on later calls", async () => {
    let rawInit = "fresh-signed-init";
    const token = "memory-session-token";
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/api/auth/session")
        ? response({
            sessionToken: token,
            expiresAt: Date.now() + 3600000,
            authenticationRequired: true,
          })
        : response({ tracks: [song], enabled: true }),
    );
    const provider = createHitmozProvider({
      apiUrl: "https://session-catalog.example",
      fetcher,
      getInitData: () => rawInit,
    });
    await provider.searchTracks("one");
    await provider.searchTracks("two");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({
      "X-Telegram-Init-Data": rawInit,
    });
    expect(fetcher.mock.calls[1][1]?.headers).toEqual({
      "X-NoteSound-Session": token,
    });
    expect(fetcher.mock.calls[2][1]?.headers).toEqual({
      "X-NoteSound-Session": token,
    });
    rawInit = "another-user-signed-init";
    await provider.searchTracks("three");
    expect(fetcher.mock.calls[3][1]?.headers).toEqual({
      "X-Telegram-Init-Data": rawInit,
    });
  });
  it("does not request catalog data if the signed launch can no longer mint a session", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response({ message: "Откройте приложение заново" }, 401),
    );
    const provider = createHitmozProvider({
      apiUrl: "https://expired-session.example",
      fetcher,
      getInitData: () => "expired-launch",
    });
    await expect(provider.searchTracks("song")).rejects.toThrow(/заново/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain("/api/auth/session");
  });
  it("uses a public catalog without repeatedly transmitting initData when authentication is disabled", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/api/auth/session")
        ? response({ sessionToken: null, authenticationRequired: false })
        : response({ tracks: [], enabled: true }),
    );
    const provider = createHitmozProvider({
      apiUrl: "https://open-session.example",
      fetcher,
      getInitData: () => "signed-launch",
    });
    await provider.searchTracks("one");
    await provider.searchTracks("two");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1][1]?.headers).toEqual({});
    expect(fetcher.mock.calls[2][1]?.headers).toEqual({});
  });
});
