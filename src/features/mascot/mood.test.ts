import { describe, expect, it } from "vitest";
import type { Track } from "../../types/music";
import { BUNNY_MOOD_LABELS, getBunnyMood } from "./mood";

const track = (fields: Partial<Track> = {}): Track => ({
  id: "test:one",
  sourceId: "test",
  title: "Song",
  artist: "Unknown artist",
  duration: 180,
  genres: [],
  license: { name: "Test", download: false },
  ...fields,
});

describe("bunny costumes from track metadata", () => {
  it("rests when no track or useful metadata exists", () => {
    expect(getBunnyMood(null)).toBe("idle");
    expect(getBunnyMood(undefined)).toBe("idle");
    expect(getBunnyMood(track({ genres: ["pop", "electronic"] }))).toBe("idle");
  });

  it("recognizes supplied rock and rap genres across case, script and punctuation", () => {
    expect(getBunnyMood(track({ genres: ["Alternative ROCK"] }))).toBe("rock");
    expect(getBunnyMood(track({ genres: ["Русский РОК"] }))).toBe("rock");
    expect(getBunnyMood(track({ genres: ["ＨＩＰ－ＨＯＰ"] }))).toBe("rap");
    expect(getBunnyMood(track({ metadata: { style: "Хип-хоп / Трэп" } }))).toBe(
      "rap",
    );
  });

  it("prioritizes explicit mood and genre over artist or title hints", () => {
    expect(
      getBunnyMood(
        track({
          artist: "MACAN",
          genres: ["rock"],
          metadata: { mood: "melancholic" },
        }),
      ),
    ).toBe("sad");
    expect(getBunnyMood(track({ artist: "Skillet", genres: ["rap"] }))).toBe(
      "rap",
    );
    expect(
      getBunnyMood(
        track({ title: "Lonely", artist: "MACAN", genres: ["hip-hop"] }),
      ),
    ).toBe("rap");
    expect(
      getBunnyMood(track({ artist: "Nirvana", metadata: { Genre: "РЭП" } })),
    ).toBe("rap");
  });

  it("chooses a stable pose for mixed genres without depending on array order", () => {
    expect(getBunnyMood(track({ genres: ["rap", "metal"] }))).toBe("rock");
    expect(getBunnyMood(track({ genres: ["metal", "rap"] }))).toBe("rock");
    expect(getBunnyMood(track({ genres: ["sad rap"] }))).toBe("sad");
  });

  it("covers the current sparse Skillet result and the requested Russian rappers", () => {
    expect(
      getBunnyMood(
        track({ title: "Skillet--monster", artist: "Скелет--Монстр" }),
      ),
    ).toBe("rock");
    expect(
      getBunnyMood(track({ title: "ДИНАСТИЯ", artist: "VILLIAN, madk1d" })),
    ).toBe("rap");
    expect(getBunnyMood(track({ artist: "miyagi & Andy Panda" }))).toBe("rap");
    expect(getBunnyMood(track({ artist: "Король и Шут" }))).toBe("rock");
  });

  it("uses explicit sad title clues but does not infer sadness from the artist name", () => {
    expect(getBunnyMood(track({ title: "Мне больно", artist: "MACAN" }))).toBe(
      "sad",
    );
    expect(getBunnyMood(track({ title: "СЛЁЗЫ" }))).toBe("sad");
    expect(getBunnyMood(track({ artist: "Sad Boys" }))).toBe("idle");
    expect(getBunnyMood(track({ title: "ДИНАСТИЯ" }))).toBe("idle");
  });

  it("matches complete words rather than fragments of unrelated names", () => {
    expect(
      getBunnyMood(
        track({ artist: "Macarena", title: "Rapture in the Crocodile House" }),
      ),
    ).toBe("idle");
    expect(
      getBunnyMood(track({ title: "Rocking Horse", artist: "Atletico" })),
    ).toBe("idle");
  });

  it("keeps usable accessible descriptions for every mode", () => {
    for (const label of Object.values(BUNNY_MOOD_LABELS)) {
      expect(label).toMatch(/Кролик/);
      expect(label.length).toBeGreaterThan(20);
    }
  });
});
