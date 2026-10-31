import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiscoveryProvider } from "./discovery";

const rawTrack = (source = "public", extra: Record<string, unknown> = {}) => ({
  id: `${source}:42`,
  sourceId: source,
  title: "ДИНАСТИЯ",
  artist: "VILLIAN, madk1d",
  duration: 150,
  genres: ["Rap"],
  artwork: "https://images.example/cover.jpg",
  availability: "available",
  playbackMode: "audio",
  streamAccess: source === "public" ? "provider_stream" : "preview",
  rights: { status: "confirmed", basis: "license", allowMix: true },
  license: { name: "Источник", download: true },
  ...extra,
});
const response = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });

afterEach(() => vi.useRealTimers());

describe("discovery providers", () => {
  it("honors a metadata 429 cooldown without sending repeated searches or blocking playback details", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    let metadataCalls = 0;
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("/track/"))
        return response({ track: rawTrack() });
      metadataCalls += 1;
      return metadataCalls === 1
        ? new Response("{}", { status: 429, headers: { "retry-after": "30" } })
        : response({ tracks: [rawTrack()] });
    });
    const provider = createDiscoveryProvider("public", { base: "/", fetcher });
    await expect(provider.searchTracks("madk1d")).rejects.toMatchObject({
      code: "rate",
      status: 429,
      retryAfterSeconds: 30,
    });
    await expect(provider.getRelatedArtists!("madk1d")).rejects.toMatchObject({
      code: "rate",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await provider.getTrackDetails("public:42")).toMatchObject({
      id: "public:42",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date("2030-01-01T00:00:29Z"));
    await expect(provider.searchTracks("another")).rejects.toMatchObject({
      retryAfterSeconds: 1,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date("2030-01-01T00:00:30Z"));
    expect(await provider.searchTracks("madk1d")).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("uses a bounded default cooldown for malformed Retry-After while cancellation still wins", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response("{}", {
          status: 429,
          headers: { "retry-after": "invalid" },
        }),
    );
    const provider = createDiscoveryProvider("public", { base: "/", fetcher });
    await expect(provider.searchTracks("madk1d")).rejects.toMatchObject({
      retryAfterSeconds: 60,
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      provider.searchTracks("MACAN", controller.signal),
    ).rejects.toThrow("cancelled");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("uses related names metadata independently of full-stream lookup and removes malformed or duplicate names", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response({
        artists: [
          "CUPSIZE",
          " cupsize ",
          " madk1d ",
          "тёмный принц",
          123,
          { name: "bad" },
          "bad\nname",
          "a".repeat(161),
          "",
        ],
      }),
    );
    const provider = createDiscoveryProvider("public", { base: "/", fetcher });
    expect(await provider.getRelatedArtists!("  madk1d ")).toEqual([
      "CUPSIZE",
      "тёмный принц",
    ]);
    expect(fetcher.mock.calls[0][0]).toBe(
      "/api/discovery/deezer/related?artist=madk1d",
    );
    expect(await provider.getRelatedArtists!("a".repeat(161))).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects cancelled or malformed related metadata without manufacturing recommendations", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({ tracks: [] }));
    const provider = createDiscoveryProvider("public", { base: "/", fetcher });
    await expect(provider.getRelatedArtists!("madk1d")).rejects.toThrow(
      /Некорректный/,
    );
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      provider.getRelatedArtists!("madk1d", controller.signal),
    ).rejects.toThrow("cancelled");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("validates search identities and never grants rights or trusts a search audio URL", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response({
        tracks: [
          rawTrack("public", {
            audioSource: {
              url: "https://audio.example/untrusted.mp3",
              cors: true,
            },
          }),
          rawTrack("deezer"),
          rawTrack("public", { id: "public:../unsafe" }),
          rawTrack("public", {
            id: "public:bad-duration",
            duration: Number.POSITIVE_INFINITY,
          }),
        ],
      }),
    );
    const provider = createDiscoveryProvider("public", {
      base: "https://api.example",
      fetcher,
    });
    const tracks = await provider.searchTracks("  ДИНАСТИЯ   madk1d  ");
    expect(tracks).toHaveLength(1);
    expect(String(fetcher.mock.calls[0][0])).toBe(
      `https://api.example/api/discovery/public/search?q=${encodeURIComponent("ДИНАСТИЯ madk1d")}`,
    );
    expect(tracks[0].rights).toMatchObject({
      status: "unknown",
      basis: "none",
      allowMix: false,
    });
    expect(tracks[0].audioSource).toBeUndefined();
    expect(tracks[0].license.download).toBe(false);
    expect(await provider.supportsDownload(tracks[0])).toBe(false);
    expect(await provider.checkAvailability(tracks[0])).toBe(true);
  });

  it("resolves fresh server details on every play rather than a cached or forged URL", async () => {
    let version = 0;
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/search?")
        ? response({ tracks: [rawTrack()] })
        : response({
            track: rawTrack("public", {
              audioSource: {
                url: `https://audio.example/${++version}.mp3`,
                cors: false,
              },
            }),
          }),
    );
    const provider = createDiscoveryProvider("public", { base: "/", fetcher });
    const [track] = await provider.searchTracks("ДИНАСТИЯ");
    track.streamUrl = "https://forged.example/stale.mp3";
    expect(await provider.resolveStream(track)).toBe(
      "https://audio.example/1.mp3",
    );
    expect(await provider.resolveStream(track)).toBe(
      "https://audio.example/2.mp3",
    );
    expect(String(fetcher.mock.calls[1][0])).toBe(
      "/api/discovery/public/track/public%3A42",
    );
    expect(track.audioSource?.cors).toBe(false);
    expect(track.rights?.allowMix).toBe(false);
  });

  it.each([
    "javascript:alert(1)",
    "http://audio.example/file.mp3",
    "https://127.0.0.1/file.mp3",
    "https://localhost/file.mp3",
    "https://192.168.1.2/file.mp3",
    "https://user:password@audio.example/file.mp3",
  ])("rejects unsafe fresh audio %s", async (url) => {
    const provider = createDiscoveryProvider("public", {
      base: "/",
      fetcher: async () =>
        response({
          track: rawTrack("public", { audioSource: { url, cors: true } }),
        }),
    });
    expect(await provider.resolveStream(rawTrack() as never)).toBeNull();
  });

  it("does not substitute a different track and rejects expired stream links", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response({
        track: rawTrack("public", {
          id: "public:other",
          audioSource: { url: "https://audio.example/file.mp3", cors: true },
        }),
      }),
    );
    const provider = createDiscoveryProvider("public", { base: "/", fetcher });
    expect(await provider.getTrackDetails("public:42")).toBeNull();
    fetcher.mockImplementation(async () =>
      response({
        track: rawTrack("public", {
          audioSource: {
            url: "https://audio.example/file.mp3",
            cors: true,
            expiresAt: Date.now() - 1000,
          },
        }),
      }),
    );
    expect(await provider.resolveStream(rawTrack() as never)).toBeNull();
    expect(await provider.getTrackDetails("deezer:42")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps Deezer previews distinct from full provider streams", async () => {
    const provider = createDiscoveryProvider("deezer", {
      base: "/",
      fetcher: async () =>
        response({
          tracks: [
            rawTrack("deezer"),
            rawTrack("deezer", {
              id: "deezer:wrong",
              streamAccess: "provider_stream",
            }),
          ],
        }),
    });
    const tracks = await provider.searchTracks("madk1d");
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      sourceId: "deezer",
      streamAccess: "preview",
      rights: { status: "unknown", allowMix: false },
    });
  });

  it("cancels one caller without aborting a separate concurrent search", async () => {
    const signals: AbortSignal[] = [];
    const finish: Array<(response: Response) => void> = [];
    const fetcher = vi.fn<typeof fetch>((_url, options) => {
      signals.push(options!.signal!);
      return new Promise<Response>((resolve) => finish.push(resolve));
    });
    const provider = createDiscoveryProvider("public", { base: "/", fetcher });
    const cancelled = new AbortController();
    const first = provider.searchTracks("one", cancelled.signal);
    const firstRejected = expect(first).rejects.toThrow("Stop first");
    const second = provider.searchTracks("two");
    cancelled.abort(new Error("Stop first"));
    await firstRejected;
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    finish[1](response({ tracks: [rawTrack()] }));
    expect(await second).toHaveLength(1);
  });

  it("bounds waiting even when a fetch implementation ignores cancellation", async () => {
    vi.useFakeTimers();
    const provider = createDiscoveryProvider("public", {
      base: "/",
      fetcher: () => new Promise<Response>(() => {}),
    });
    const request = provider.searchTracks("madk1d");
    const rejected = expect(request).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
  });

  it("does not contact any server when disabled", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = createDiscoveryProvider("public", { base: "", fetcher });
    expect(provider.status).toBe("unavailable");
    expect(await provider.searchTracks("madk1d")).toEqual([]);
    expect(await provider.getTrackDetails("public:42")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("restores an exact public identity after server restart before retrying fresh details once", async () => {
    let detailsCalls = 0;
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("/search?"))
        return response({
          tracks: [rawTrack(), rawTrack("public", { id: "public:unrelated" })],
        });
      if (++detailsCalls === 1) return new Response("{}", { status: 404 });
      return response({
        track: rawTrack("public", {
          audioSource: { url: "https://audio.example/fresh.mp3", cors: false },
        }),
      });
    });
    const provider = createDiscoveryProvider("public", { base: "/", fetcher });
    expect(await provider.resolveStream(rawTrack() as never)).toBe(
      "https://audio.example/fresh.mp3",
    );
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/discovery/public/track/public%3A42",
      `/api/discovery/public/search?q=${encodeURIComponent("VILLIAN, madk1d ДИНАСТИЯ")}`,
      "/api/discovery/public/track/public%3A42",
    ]);
  });

  it("never replaces a lost public track with a different search result", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/search?")
        ? response({ tracks: [rawTrack("public", { id: "public:unrelated" })] })
        : new Response("{}", { status: 404 }),
    );
    const provider = createDiscoveryProvider("public", { base: "/", fetcher });
    expect(await provider.resolveStream(rawTrack() as never)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never retries an aborted public request", async () => {
    const cancelled = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => {
      cancelled.abort(new Error("Cancelled play"));
      return new Response("{}", { status: 404 });
    });
    const provider = createDiscoveryProvider("public", { base: "/", fetcher });
    await expect(
      provider.resolveStream(rawTrack() as never, cancelled.signal),
    ).rejects.toThrow("Cancelled play");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not loop when restored details still return 404", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/search?")
        ? response({ tracks: [rawTrack()] })
        : new Response("{}", { status: 404 }),
    );
    const provider = createDiscoveryProvider("public", { base: "/", fetcher });
    await expect(
      provider.resolveStream(rawTrack() as never),
    ).rejects.toMatchObject({ status: 404 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
