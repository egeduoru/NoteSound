import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TasteSignal, Track } from "../../types/music";
import {
  buildTasteProfile,
  DEFAULT_SIGNAL_WEIGHTS,
  normalizeSignalWeights,
  qualifiesAsListen,
  scoreTaste,
  scoreSession,
  seededRandom,
} from "./profile";
import { trackKey } from "../../lib/normalize";
const track: Track = {
  id: "one",
  sourceId: "local",
  local: true,
  title: "Song",
  artist: "Artist",
  duration: 100,
  genres: [],
  license: { name: "Personal", download: true },
};
const event = (
  kind: TasteSignal["kind"],
  at = 1,
  playedSeconds = 80,
): TasteSignal => ({
  id: `${kind}:${at}`,
  trackId: track.id,
  track,
  kind,
  at,
  playedSeconds,
});
describe("User Taste Profile", () => {
  beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(1000));
  afterEach(() => vi.restoreAllMocks());
  it("uses configurable action weights", () => {
    expect(DEFAULT_SIGNAL_WEIGHTS).toEqual({
      like: 5,
      favorite: 4,
      listen: 2,
      repeat: 2,
      skip: -1,
      dislike: -8,
    });
    expect(
      buildTasteProfile([event("like")], [], [], { like: 10 }).trackScores[
        trackKey(track)
      ],
    ).toBe(10);
  });
  it("does not count paused/brief starts as completed listening", () => {
    expect(qualifiesAsListen(track, 0)).toBe(false);
    expect(qualifiesAsListen(track, 69)).toBe(false);
    expect(qualifiesAsListen(track, 70)).toBe(true);
    expect(buildTasteProfile([event("listen", 1, 0)]).trackScores).toEqual({});
  });
  it("does not label a small fragment of a long song as listening to most of it", () => {
    expect(qualifiesAsListen({ ...track, duration: 600 }, 180)).toBe(false);
    expect(qualifiesAsListen({ ...track, duration: 600 }, 420)).toBe(true);
  });
  it("counts real listening and repeats separately", () => {
    expect(
      buildTasteProfile([event("listen"), event("repeat")]).trackScores[
        trackKey(track)
      ],
    ).toBe(4);
  });
  it("deduplicates retransmitted signal IDs", () => {
    const signal = event("like");
    expect(
      buildTasteProfile([signal, signal]).trackScores[trackKey(track)],
    ).toBe(5);
  });
  it("preserves favorite preferences without double counting a corresponding signal", () => {
    expect(
      buildTasteProfile([event("favorite")], [track]).trackScores[
        trackKey(track)
      ],
    ).toBe(4);
    expect(buildTasteProfile([], [track]).trackScores[trackKey(track)]).toBe(4);
  });
  it("does not turn legacy started history into positive completion events", () => {
    const profile = buildTasteProfile([], [], [{ track, playedAt: 1 }]);
    expect(profile.trackScores[trackKey(track)]).toBe(0);
    expect(profile.knownTrackKeys).toContain(trackKey(track));
  });
  it("does not double-count migrated completion/skip history and signals", () => {
    expect(
      buildTasteProfile(
        [event("listen")],
        [],
        [{ track, playedAt: 1, completed: true, playedSeconds: 80 }],
      ).trackScores[trackKey(track)],
    ).toBe(2);
    expect(
      buildTasteProfile(
        [event("skip")],
        [],
        [{ track, playedAt: 1, skipped: true }],
      ).trackScores[trackKey(track)],
    ).toBe(-1);
  });
  it("retains a dislike until a later explicit positive action", () => {
    expect(buildTasteProfile([event("dislike")]).dislikedTrackIds).toEqual([
      track.id,
    ]);
    expect(
      buildTasteProfile([event("dislike"), event("like", 2)]).dislikedTrackIds,
    ).toEqual([]);
  });
  it("learns an artist preference for related recordings", () => {
    const profile = buildTasteProfile([event("like")]);
    expect(
      scoreTaste({ ...track, id: "two", title: "Other song" }, profile),
    ).toBeGreaterThan(0);
  });
  it("bounds malformed custom weights and remains seed-repeatable", () => {
    expect(normalizeSignalWeights({ like: Infinity, skip: -100 }).like).toBe(5);
    expect(normalizeSignalWeights({ skip: -100 }).skip).toBe(-30);
    const a = seededRandom(10),
      b = seededRandom(10);
    expect(Array.from({ length: 20 }, () => a())).toEqual(
      Array.from({ length: 20 }, () => b()),
    );
  });
  it("ages implicit listening without erasing a saved favorite", () => {
    const now = 400 * 86400_000;
    const old = buildTasteProfile([event("listen", 1)], [], [], undefined, {
      now,
    });
    const recent = buildTasteProfile(
      [event("listen", now)],
      [],
      [],
      undefined,
      { now },
    );
    expect(scoreTaste(track, old)).toBeLessThan(scoreTaste(track, recent));
    expect(
      buildTasteProfile([], [track], [], undefined, { now }).trackScores[
        trackKey(track)
      ],
    ).toBe(4);
  });
  it("keeps a skip temporary and never writes a long-term artist penalty", () => {
    const now = 86400_000;
    const recent = buildTasteProfile([event("skip", now)], [], [], undefined, {
      now,
    });
    const old = buildTasteProfile(
      [event("skip", now - 4 * 3600_000)],
      [],
      [],
      undefined,
      { now },
    );
    expect(recent.artistScores.artist).toBe(0);
    expect(scoreSession(track, recent)).toBeLessThan(0);
    expect(scoreSession(track, old)).toBe(0);
    expect(old.dislikedTrackIds).toEqual([]);
    expect(old.trackScores[trackKey(track)]).toBe(0);
  });
  it("ignores future events and future legacy history", () => {
    const profile = buildTasteProfile(
      [event("like", 2000), event("dislike", 3000)],
      [],
      [{ track, playedAt: 4000, completed: true, playedSeconds: 90 }],
      undefined,
      { now: 1000 },
    );
    expect(profile.knownTrackKeys).toEqual([]);
    expect(profile.dislikedTrackIds).toEqual([]);
  });
  it("learns genre affinities for new artists and bounds repeated interaction strength", () => {
    const item = { ...track, genres: ["alternative rock"] };
    const profile = buildTasteProfile(
      Array.from({ length: 500 }, (_, i) => ({
        ...event("listen", i + 1),
        track: item,
        id: String(i),
      })),
      [],
      [],
      undefined,
      { now: 1000 },
    );
    expect(
      scoreTaste(
        {
          ...track,
          artist: "New artist",
          title: "New rock song",
          genres: ["rock"],
        },
        profile,
      ),
    ).toBeGreaterThan(0);
    expect(profile.trackScores[trackKey(item)]).toBeLessThanOrEqual(30);
    expect(profile.artistScores.artist).toBeLessThanOrEqual(30);
    expect(
      Object.values(profile.genreScores).every((value) => value <= 30),
    ).toBe(true);
  });
  it("does not double count a completion event emitted minutes after play started", () => {
    const item = { ...track, duration: 240 };
    const signal = { ...event("listen", 200_000, 200), track: item };
    const profile = buildTasteProfile(
      [signal],
      [],
      [{ track: item, playedAt: 1000, completed: true, playedSeconds: 200 }],
      undefined,
      { now: 250_000 },
    );
    expect(profile.trackScores[trackKey(item)]).toBe(2);
  });
  it("a later positive reaction reverses the earlier dislike contribution", () => {
    const profile = buildTasteProfile(
      [event("dislike", 1), event("like", 2)],
      [],
      [],
      undefined,
      { now: 3 },
    );
    expect(profile.dislikedTrackIds).toEqual([]);
    expect(profile.trackScores[trackKey(track)]).toBe(5);
  });
});
