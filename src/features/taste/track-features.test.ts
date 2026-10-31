import { describe, expect, it } from "vitest";
import type { Track } from "../../types/music";
import { defaultWavePreferences } from "../../types/music";
import {
  contentSimilarity,
  matchesWavePreferences,
  trackFeatures,
} from "./track-features";

const item = (extra: Partial<Track> = {}): Track => ({
  id: "test",
  sourceId: "local",
  title: "Песня",
  artist: "Исполнитель",
  genres: [],
  duration: 120,
  license: { name: "Personal", download: false },
  ...extra,
});
describe("truthful track content features", () => {
  it("connects related genre labels without analysing cover colors or song titles", () => {
    expect(
      contentSimilarity(
        item({ genres: ["alternative rock"] }),
        item({ genres: ["рок"] }),
      ),
    ).toBeGreaterThan(0);
    expect(trackFeatures(item({ title: "Sad Russian Rap" }))).toEqual({
      genres: [],
      moods: [],
      language: null,
      energy: null,
    });
  });
  it("only identifies language from declared vocal metadata", () => {
    expect(
      trackFeatures(item({ metadata: { language: "ru-RU" } })).language,
    ).toBe("russian");
    expect(trackFeatures(item({ metadata: { language: "en" } })).language).toBe(
      "foreign",
    );
    expect(
      trackFeatures(item({ metadata: { instrumental: "true" } })).language,
    ).toBe("instrumental");
    expect(
      matchesWavePreferences(item(), {
        ...defaultWavePreferences,
        language: "russian",
      }),
    ).toBe(true);
  });
  it("rejects invalid energy values instead of pretending to know acoustic properties", () => {
    expect(
      trackFeatures(item({ metadata: { energy: "132" } })).energy,
    ).toBeNull();
    expect(trackFeatures(item({ metadata: { energy: "0.8" } })).energy).toBe(
      0.8,
    );
  });
});
