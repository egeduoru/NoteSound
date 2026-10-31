import { describe, expect, it, vi } from "vitest";
import {
  createPublicCatalogService,
  parseLightAudio,
} from "./public-catalog.mjs";

const row = (overrides = {}) => {
  const values = {
    title: "ДИНАСТИЯ &amp; тест",
    artist: "<a>VILLIAN</a>, <a>madk1d</a>",
    duration: "PT2M30S",
    mp3: "//storage6.lightaudio.ru/dm/39a3ef06/3bb5097b/song.mp3?d=150&amp;v=abc",
    hls: "//storage6.lightaudio.ru/39a3ef06/3bb5097b/song.m3u8",
    ...overrides,
  };
  return `<div class="item" id="id-valid123" itemprop="track" itemscope itemtype="http://schema.org/MusicRecording"><div>
    <a class="play" data-audio="${values.hls}"><img src="//cover.lightaudio.ru/cover.jpg?size=68&amp;quality=95"></a>
    <div class="title"><span itemprop="name">${values.title}</span> — <span itemprop="byArtist">${values.artist}</span></div>
    <meta itemprop="duration" content="${values.duration}"><a class="down" href="${values.mp3}"></a>
  </div></div>`;
};

describe("public source catalogue", () => {
  it("parses source metadata and keeps public access separate from copyright rights", () => {
    const [track] = parseLightAudio(
      `<html><div id="result">${row()}</div></html>`,
      "ДИНАСТИЯ madk1d",
    );
    expect(track.title).toBe("ДИНАСТИЯ & тест");
    expect(track.artist).toBe("VILLIAN, madk1d");
    expect(track.duration).toBe(150);
    expect(track.id).toMatch(/^public:la-[a-f0-9]{24}$/);
    expect(track.streamUrl).toContain("?d=150&v=abc");
    expect(track.rights).toEqual({
      status: "unknown",
      basis: "none",
      allowMix: false,
    });
    expect(track.license.download).toBe(false);
    expect(track.audioSource.cors).toBe(false);
    expect(track.streamAccess).toBe("provider_stream");
  });

  it("rejects foreign, credential-bearing and malformed stream URLs", () => {
    for (const mp3 of [
      "https://evil.example/song.mp3",
      "http://storage6.lightaudio.ru/dm/song.mp3",
      "https://user:pass@storage6.lightaudio.ru/dm/song.mp3",
      "https://storage6.lightaudio.ru/not-audio.html",
    ])
      expect(parseLightAudio(row({ mp3 }), "song")).toEqual([]);
  });

  it("rejects unstructured track captions in artist credits without inventing corrected artists", () => {
    for (const artist of [
      "<a>трек: greyrock</a>, <a>tewiq</a>, <a>madk1d - распять</a>",
      "<a>Песня: madk1d - распять</a>",
      "<a>tewiq</a>, <a>track: madk1d - распять</a>",
      "<a>song: madk1d - распять</a>",
    ])
      expect(
        parseLightAudio(row({ title: "madk1d - распять", artist }), "madk1d"),
      ).toEqual([]);
    const [valid] = parseLightAudio(
      row({
        title: "распять",
        artist: "<a>greyrock</a>, <a>tewiq</a>, <a>madk1d</a>",
      }),
      "madk1d",
    );
    expect(valid.artist).toBe("greyrock, tewiq, madk1d");
    expect(
      parseLightAudio(row({ artist: "<a>a-ha</a>" }), "a-ha")[0].artist,
    ).toBe("a-ha");
  });

  it("does not treat scripts or non-recording HTML as metadata", () => {
    expect(
      parseLightAudio(`<script>const fake = '${row()}'</script>`, "song"),
    ).toEqual([]);
    expect(
      parseLightAudio(
        `<div><script>const fake = '</div>${row()}'</script></div>`,
        "song",
      ),
    ).toEqual([]);
    expect(parseLightAudio(row({ duration: "PT9999999H" }), "song")).toEqual(
      [],
    );
  });

  it("bounds payloads and deduplicates stable audio identities", () => {
    expect(() => parseLightAudio("x".repeat(1024 * 1024 + 1), "x")).toThrow(
      /large/,
    );
    expect(parseLightAudio(row() + row(), "song")).toHaveLength(1);
  });

  it("uses only fixed search host, caches briefly, and refreshes expired track data", async () => {
    let time = 1000;
    const externalRequest = vi.fn(async () => ({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: row(),
    }));
    const service = createPublicCatalogService({
      externalRequest,
      now: () => time,
    });
    const first = await service.search(" ДИНАСТИЯ   madk1d ");
    await service.search("династия madk1d");
    expect(externalRequest).toHaveBeenCalledTimes(1);
    expect(new URL(externalRequest.mock.calls[0][0]).hostname).toBe(
      "web.ligaudio.ru",
    );
    expect(externalRequest.mock.calls[0][1].allowedHosts).toEqual([
      "web.ligaudio.ru",
    ]);
    time += 61_000;
    expect((await service.track(first.tracks[0].id)).title).toBe(
      "ДИНАСТИЯ & тест",
    );
    expect(externalRequest).toHaveBeenCalledTimes(2);
    expect(await service.track("public:evil")).toBeNull();
  });

  it("does not interpret rejected or non-HTML responses as search results", async () => {
    for (const response of [
      { status: 403, headers: { "content-type": "text/html" }, body: row() },
      { status: 302, headers: { "content-type": "text/html" }, body: row() },
      {
        status: 200,
        headers: { "content-type": "application/json" },
        body: row(),
      },
    ]) {
      const service = createPublicCatalogService({
        externalRequest: async () => response,
      });
      await expect(service.search("song")).rejects.toThrow(/source/);
    }
  });
});
