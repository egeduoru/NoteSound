import { describe, expect, it } from "vitest";
import type { Track, TasteSignal } from "../../types/music";
import { defaultWavePreferences } from "../../types/music";
import { prepareWaveRanking, type WaveContext } from "./recommendation";
const track = (id: string, extra: Partial<Track> = {}): Track => ({
  id,
  sourceId: "local",
  local: true,
  title: id,
  artist: id,
  duration: 100,
  genres: [],
  license: { name: "Personal", download: false },
  ...extra,
});
const seed = track("seed"),
  one = track("one"),
  two = track("two");
const context = (): WaveContext => ({
  history: [],
  favorites: [],
  excluded: [],
  diversity: 0.25,
  now: 1000,
  rng: () => 0,
});
describe("progressive ranking snapshots", () => {
  it("honors newly queued exclusions at later refill checkpoints", () => {
    const prepared = prepareWaveRanking(context());
    expect(
      prepared.rank(seed, [one, two], { excluded: [one] }).map((t) => t.id),
    ).toEqual([two.id]);
    expect(
      prepared.rank(seed, [one, two], { excluded: [two] }).map((t) => t.id),
    ).toEqual([one.id]);
  });
  it("updates filtering when the listener changes mode without losing the prepared profile", () => {
    const english = track("en", { metadata: { language: "en" } });
    const russian = track("ru", { metadata: { language: "ru" } });
    const prepared = prepareWaveRanking(context());
    expect(
      prepared
        .rank(seed, [english, russian], {
          preferences: { ...defaultWavePreferences, language: "russian" },
        })
        .map((t) => t.id),
    ).toEqual([russian.id]);
  });
  it("rebuilds the snapshot when new explicit feedback is supplied", () => {
    const prepared = prepareWaveRanking(context());
    const dislike: TasteSignal = {
      id: "ban",
      trackId: one.id,
      track: one,
      kind: "dislike",
      at: 900,
    };
    expect(
      prepared.rank(seed, [one, two], { signals: [dislike] }).map((t) => t.id),
    ).toEqual([two.id]);
    expect(prepared.rank(seed, [one, two]).map((t) => t.id)).toContain(one.id);
  });
});
