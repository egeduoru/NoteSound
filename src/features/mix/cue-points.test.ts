import { describe, expect, it } from "vitest";
import type { Track, WaveMixSettings } from "../../types/music";
import { cueInFor, planTransition } from "./cue-points";
import { supportsMix } from "./engine";
const settings: WaveMixSettings = {
  enabled: true,
  durationSeconds: 6,
  smartCue: true,
  earlyTransition: true,
};
const track: Track = {
  id: "a",
  sourceId: "licensed",
  title: "A",
  artist: "One",
  duration: 180,
  genres: [],
  license: { name: "Licensed", download: false },
  rights: { status: "confirmed", basis: "license", allowMix: true },
};
const marked = (points: Partial<NonNullable<Track["cuePoints"]>>): Track => ({
  ...track,
  cuePoints: { cueConfidence: 0.95, cueSource: "manual", ...points },
});
describe("reliable musical cues", () => {
  it("starts at zero with no trusted mark rather than inventing a chorus", () => {
    expect(cueInFor(track)).toBe(0);
    expect(cueInFor(marked({ cueInSeconds: 38, cueConfidence: 0.3 }))).toBe(0);
    expect(cueInFor(marked({ cueInSeconds: 38 }), false)).toBe(0);
  });
  it("uses the supplied musical start and accepts an explicit zero", () => {
    expect(cueInFor(marked({ cueInSeconds: 38 }))).toBe(38);
    expect(cueInFor(marked({ cueInSeconds: 0 }))).toBe(0);
  });
  it.each([NaN, Infinity, -4])("ignores invalid cue %s", (cueInSeconds) => {
    expect(cueInFor(marked({ cueInSeconds }))).toBe(0);
  });
  it("clamps marks inside a short recording", () => {
    expect(cueInFor({ ...marked({ cueInSeconds: 99 }), duration: 10 })).toBe(8);
  });
  it("fades only at the end without trustworthy structural data", () => {
    expect(planTransition(track, track, settings)).toEqual({
      cueInSeconds: 0,
      transitionAtSeconds: 174,
      durationSeconds: 6,
    });
  });
  it("uses cueOut only when early transitions and smart cues are enabled", () => {
    const old = marked({ cueOutSeconds: 142 }),
      next = marked({ cueInSeconds: 38 });
    expect(planTransition(old, next, settings)).toEqual({
      cueInSeconds: 38,
      transitionAtSeconds: 142,
      durationSeconds: 6,
    });
    expect(
      planTransition(old, next, { ...settings, earlyTransition: false })
        .transitionAtSeconds,
    ).toBe(174);
    expect(
      planTransition(old, next, { ...settings, smartCue: false }).cueInSeconds,
    ).toBe(0);
  });
  it("shortens the overlap to the actual remaining material", () => {
    expect(
      planTransition(
        { ...track, duration: 3 },
        { ...track, duration: 2 },
        settings,
      ).durationSeconds,
    ).toBe(2);
    expect(
      planTransition(marked({ cueOutSeconds: 178 }), track, settings)
        .durationSeconds,
    ).toBe(2);
  });
});
describe("mix eligibility", () => {
  it("requires confirmed permission to mix rather than a URL or download field", () => {
    expect(supportsMix({ ...track, rights: undefined }, "/a.wav")).toBe(false);
    expect(
      supportsMix(
        { ...track, rights: { ...track.rights!, status: "unknown" } },
        "/a.wav",
      ),
    ).toBe(false);
    expect(
      supportsMix(
        { ...track, rights: { ...track.rights!, allowMix: false } },
        "/a.wav",
      ),
    ).toBe(false);
    expect(supportsMix(track, "/a.wav")).toBe(true);
  });
  it("rejects cross-origin sources without explicit CORS capability", () => {
    expect(supportsMix(track, "https://audio.example/a.mp3")).toBe(false);
    expect(
      supportsMix(
        {
          ...track,
          audioSource: { url: "https://audio.example/a.mp3", cors: true },
        },
        "https://audio.example/a.mp3",
      ),
    ).toBe(true);
    expect(supportsMix(track, "javascript:alert(1)")).toBe(false);
  });
  it("does not mix a YouTube iframe even when metadata is forged", () => {
    expect(
      supportsMix(
        { ...track, playback: { kind: "youtube", videoId: "abcdefghijk" } },
        "/a.wav",
      ),
    ).toBe(false);
  });
});
