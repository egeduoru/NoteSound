import { describe, it, expect } from "vitest";
import {
  normalizeHitmozPayload,
  normalizeLicensedTracks,
  parseClock,
} from "./catalog-model.mjs";
const song = {
  rank: 1,
  title: "Династия",
  artist: "madk1d",
  duration: "02:30",
  cover: "https://eu.hitmoz.com/img/song.jpg",
  download: "https://eu.hitmoz.com/get/music/test_81251971.mp3",
  link: "https://eu.hitmoz.com/song/81251971",
};
describe("Hitmoz parser boundary", () => {
  it("decodes the real Python success/songs envelope without granting MP3 rights", () => {
    const tracks = normalizeHitmozPayload({
      success: true,
      mode: "search",
      query: "Династия",
      songs: [song],
    });
    expect(tracks[0]).toMatchObject({
      id: "hitmoz:81251971",
      duration: 150,
      title: "Династия",
      popularity: 1,
      playbackMode: "metadata",
      rights: { status: "unknown", allowMix: false },
    });
    expect(tracks[0].audioSource).toBeUndefined();
    expect(tracks[0].streamUrl).toBeUndefined();
    expect(JSON.stringify(tracks)).not.toContain("/get/music/");
  });
  it("deduplicates Unicode/case metadata and keeps stable IDs across searches", () => {
    const first = normalizeHitmozPayload({
      success: true,
      songs: [song, { ...song, title: "  ДИНАСТИЯ  " }],
    });
    expect(first).toHaveLength(1);
    expect(first[0].id).toBe(
      normalizeHitmozPayload({ success: true, songs: [song] })[0].id,
    );
    const withoutLink = { ...song, link: "" };
    expect(
      normalizeHitmozPayload({ success: true, songs: [withoutLink] })[0].id,
    ).toBe(
      normalizeHitmozPayload({
        success: true,
        songs: [{ ...withoutLink, rank: 90 }],
      })[0].id,
    );
  });
  it("handles a true empty result and rejects changed formats", () => {
    expect(normalizeHitmozPayload({ success: true, songs: [] })).toEqual([]);
    expect(
      normalizeHitmozPayload({
        success: false,
        error: "По запросу «xyz» ничего не найдено",
      }),
    ).toEqual([]);
    expect(() => normalizeHitmozPayload([song])).toThrow(/Формат/);
    expect(() =>
      normalizeHitmozPayload({ success: true, songs: "changed" }),
    ).toThrow(/Формат/);
    expect(() =>
      normalizeHitmozPayload({ success: false, error: "Forbidden" }),
    ).toThrow(/ошибке/);
  });
  it("strips untrusted images and page URLs rather than sending them to a browser", () => {
    const [track] = normalizeHitmozPayload({
      success: true,
      songs: [
        {
          ...song,
          cover: "javascript:alert(1)",
          link: "https://attacker.example/song/81251971",
        },
      ],
    });
    expect(track.artwork).toBeUndefined();
    expect(track.externalUrl).toBeUndefined();
  });
  it.each([
    ["03:08", 188],
    ["1:03:08", 3788],
    ["03:99", 0],
    ["bogus", 0],
    [150, 150],
  ])("parses duration %s", (input, expected) =>
    expect(parseClock(input)).toBe(expected),
  );
});
describe("licensed registry", () => {
  const allowed = ["audio.example"];
  const entry = {
    id: "licensed:sample",
    title: "Original",
    artist: "Owner",
    duration: 180,
    audioSource: { url: "https://audio.example/track.mp3", cors: true },
    rights: {
      status: "confirmed",
      basis: "license",
      evidence: "Owner grant 2026-10-28",
      allowMix: true,
    },
    cuePoints: {
      cueInSeconds: 38,
      cueOutSeconds: 170,
      cueConfidence: 0.9,
      cueSource: "manual",
    },
  };
  it("retains only an explicit evidenced grant and a permitted direct source", () => {
    const [track] = normalizeLicensedTracks([entry], allowed);
    expect(track.rights.allowMix).toBe(true);
    expect(track.cuePoints.cueInSeconds).toBe(38);
    expect(
      normalizeLicensedTracks(
        [{ ...entry, rights: { status: "unknown" } }],
        allowed,
      ),
    ).toEqual([]);
    expect(
      normalizeLicensedTracks(
        [{ ...entry, rights: { ...entry.rights, evidence: "" } }],
        allowed,
      ),
    ).toEqual([]);
    expect(normalizeLicensedTracks([entry], ["other.example"])).toEqual([]);
  });
  it("never assigns fabricated cue points and refuses invalid ones", () => {
    expect(
      normalizeLicensedTracks(
        [
          {
            ...entry,
            cuePoints: {
              cueInSeconds: 900,
              cueOutSeconds: -1,
              cueConfidence: 0.9,
              cueSource: "manual",
            },
          },
        ],
        allowed,
      )[0].cuePoints.cueInSeconds,
    ).toBeUndefined();
    expect(
      normalizeLicensedTracks([{ ...entry, cuePoints: undefined }], allowed)[0]
        .cuePoints,
    ).toBeUndefined();
  });
});
