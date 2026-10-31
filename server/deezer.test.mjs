import { describe, expect, it, vi } from "vitest";
import { createDeezerService } from "./deezer.mjs";

const fixture = {
  id: 4174083162,
  title: "ДИНАСТИЯ",
  duration: 150,
  preview:
    "https://cdnt-preview.dzcdn.net/api/clip.mp3?hdnea=exp=9999999999~hmac=sample",
  artist: { name: "villian" },
  contributors: [{ name: "villian" }, { name: "madk1d" }],
  album: {
    title: "Красивое Зло",
    cover_big: "https://cdn-images.dzcdn.net/images/cover/example/500.jpg",
  },
  link: "https://evil.example/redirect",
};
const json = (body, extra = {}) => ({
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(body),
  ...extra,
});

describe("Deezer discovery and official previews", () => {
  it("uses an exact artist identity for related names and caches metadata without audio", async () => {
    const externalRequest = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          data: [
            { id: 1, name: "not madk1d" },
            { id: 153072532, name: "madk1d" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        json({
          data: [
            { id: 2, name: "CUPSIZE", preview: "https://example.com/file.mp3" },
            { id: 3, name: " cupsize " },
            { id: 4, name: "тёмный принц" },
            { id: 153072532, name: "madk1d" },
            { id: "../bad", name: "bad" },
            { id: 5, name: "bad\nname" },
            {},
          ],
          next: "http://localhost/private",
        }),
      );
    const service = createDeezerService({ externalRequest });
    const result = await service.relatedArtists("madk1d");
    expect(result).toEqual({ artists: ["CUPSIZE", "тёмный принц"] });
    expect(externalRequest.mock.calls[1][0]).toBe(
      "https://api.deezer.com/artist/153072532/related?limit=12",
    );
    result.artists.push("mutated");
    expect(await service.relatedArtists("MADK1D")).toEqual({
      artists: ["CUPSIZE", "тёмный принц"],
    });
    expect(externalRequest).toHaveBeenCalledTimes(2);
  });

  it("does not treat a fuzzy match or unvalidated id as the requested artist", async () => {
    const externalRequest = vi.fn(async () =>
      json({
        data: [
          { id: 12, name: "Other Artist" },
          { id: "../bad", name: "MACAN" },
        ],
      }),
    );
    expect(
      await createDeezerService({ externalRequest }).relatedArtists("MACAN"),
    ).toEqual({ artists: [] });
    expect(externalRequest).toHaveBeenCalledTimes(1);
  });

  it("validates related metadata input and honors cancellation before lookup or cache hit", async () => {
    const externalRequest = vi.fn(async () => json({ data: [] }));
    const service = createDeezerService({ externalRequest });
    await expect(service.relatedArtists("a".repeat(161))).rejects.toThrow(
      /Invalid/,
    );
    await expect(service.relatedArtists("bad\nname")).rejects.toThrow(
      /Invalid/,
    );
    expect(externalRequest).not.toHaveBeenCalled();
    await service.relatedArtists("MACAN");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      service.relatedArtists("MACAN", controller.signal),
    ).rejects.toThrow("cancelled");
    expect(externalRequest).toHaveBeenCalledTimes(1);
  });

  it("forwards cancellation to both related lookup steps and rejects malformed metadata", async () => {
    const controller = new AbortController();
    const externalRequest = vi
      .fn()
      .mockResolvedValueOnce(json({ data: [{ id: 1, name: "MACAN" }] }))
      .mockResolvedValueOnce(json({ wrong: [] }));
    await expect(
      createDeezerService({ externalRequest }).relatedArtists(
        "MACAN",
        controller.signal,
      ),
    ).rejects.toThrow(/format/);
    expect(
      externalRequest.mock.calls.every(
        (call) => call[1].signal === controller.signal,
      ),
    ).toBe(true);
  });

  it("finds real metadata without exposing a stale preview URL or granting full-track rights", async () => {
    const externalRequest = vi.fn(async () =>
      json({ data: [fixture, fixture, {}] }),
    );
    const service = createDeezerService({ externalRequest });
    const result = await service.search("ДИНАСТИЯ madk1d");
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]).toMatchObject({
      id: "deezer:4174083162",
      sourceId: "deezer",
      title: "ДИНАСТИЯ",
      artist: "villian, madk1d",
      duration: 150,
      streamAccess: "preview",
      rights: { status: "unknown", basis: "none", allowMix: false },
      metadata: { preview: "true" },
      license: { download: false },
      externalUrl: "https://www.deezer.com/track/4174083162",
    });
    expect(result.tracks[0].audioSource).toBeUndefined();
    const [url, options] = externalRequest.mock.calls[0];
    expect(new URL(url).hostname).toBe("api.deezer.com");
    expect(new URL(url).searchParams.get("q")).toBe("ДИНАСТИЯ madk1d");
    expect(options).toMatchObject({
      allowedHosts: ["api.deezer.com"],
      timeoutMs: 8000,
      maxBytes: 2 * 1024 * 1024,
    });
  });

  it("refreshes detail and signed preview on each playback request", async () => {
    const externalRequest = vi.fn(async () => json(fixture));
    const service = createDeezerService({ externalRequest, now: () => 1000 });
    const first = await service.track("deezer:4174083162");
    await service.track("4174083162");
    expect(externalRequest).toHaveBeenCalledTimes(2);
    expect(first.audioSource).toEqual({
      url: fixture.preview,
      cors: true,
      expiresAt: 61000,
    });
    expect(first.duration).toBe(150);
    expect(first.license.name).toContain("30 секунд");
  });

  it("caches search metadata for 60 seconds but does not return shared mutable data", async () => {
    let now = 0;
    const externalRequest = vi.fn(async () => json({ data: [fixture] }));
    const service = createDeezerService({ externalRequest, now: () => now });
    const first = await service.search("MACAN");
    first.tracks[0].title = "changed";
    expect((await service.search("macan")).tracks[0].title).toBe("ДИНАСТИЯ");
    expect(externalRequest).toHaveBeenCalledTimes(1);
    now = 60_001;
    await service.search("MACAN");
    expect(externalRequest).toHaveBeenCalledTimes(2);
  });

  it("bounds the metadata cache and evicts old keys", async () => {
    const externalRequest = vi.fn(async () => json({ data: [] }));
    const service = createDeezerService({ externalRequest, now: () => 0 });
    for (let index = 0; index < 201; index++)
      await service.search(`query ${index}`);
    await service.search("query 0");
    expect(externalRequest).toHaveBeenCalledTimes(202);
  });

  it.each([
    "https://127.0.0.1/song.mp3",
    "deezer:../../1",
    "0",
    "-12",
    "1?url=https://evil.example",
    "9007199254740992",
  ])("rejects invalid track id %s before any network request", async (id) => {
    const externalRequest = vi.fn();
    await expect(
      createDeezerService({ externalRequest }).track(id),
    ).rejects.toThrow(/Invalid/);
    expect(externalRequest).not.toHaveBeenCalled();
  });

  it("does not accept credentials, ports, non-HTTPS or lookalike preview hosts", async () => {
    for (const preview of [
      "http://cdnt-preview.dzcdn.net/a.mp3",
      "https://cdnt-preview.dzcdn.net.evil.example/a.mp3",
      "https://user@cdnt-preview.dzcdn.net/a.mp3",
      "https://cdnt-preview.dzcdn.net:444/a.mp3",
      "https://127.0.0.1/a.mp3",
    ]) {
      const service = createDeezerService({
        externalRequest: async () =>
          json({
            ...fixture,
            preview,
            album: { cover_big: "https://evil.example/cover.jpg" },
          }),
      });
      const track = await service.track("4174083162");
      expect(track.audioSource).toBeUndefined();
      expect(track.availability).toBe("unavailable");
      expect(track.artwork).toBeUndefined();
    }
  });

  it("does not follow arbitrary search URLs or upstream next links", async () => {
    const externalRequest = vi.fn(async () =>
      json({ data: [], next: "http://localhost/private" }),
    );
    await createDeezerService({ externalRequest }).search(
      "https://evil.example/private",
    );
    expect(externalRequest).toHaveBeenCalledTimes(1);
    expect(new URL(externalRequest.mock.calls[0][0]).hostname).toBe(
      "api.deezer.com",
    );
  });

  it("reports upstream errors instead of interpreting them as empty search results", async () => {
    for (const response of [
      json({ error: { code: 4 } }),
      json({ data: [] }, { status: 403 }),
      {
        status: 200,
        body: "<html>blocked</html>",
        headers: { "content-type": "text/html" },
      },
      json({ wrong: [] }),
    ]) {
      await expect(
        createDeezerService({ externalRequest: async () => response }).search(
          "MACAN",
        ),
      ).rejects.toThrow();
    }
  });

  it("rejects mismatched detail ids and forwards cancellation", async () => {
    const signal = new AbortController().signal;
    const externalRequest = vi.fn(async () => json({ ...fixture, id: 123 }));
    await expect(
      createDeezerService({ externalRequest }).track("4174083162", signal),
    ).rejects.toThrow(/different track/);
    expect(externalRequest.mock.calls[0][1].signal).toBe(signal);
  });
});
