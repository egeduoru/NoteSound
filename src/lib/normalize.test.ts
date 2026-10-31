import { describe, expect, it } from "vitest";
import {
  areSameTrack,
  artistKeys,
  deduplicateTracks,
  normalizeText,
  trackKey,
} from "./normalize";
import type { Track } from "../types/music";

const track = (fields: Partial<Track> = {}): Track => ({
  id: "one",
  sourceId: "a",
  title: "Captain",
  artist: "Miyagi",
  duration: 200,
  genres: ["hip hop"],
  license: { name: "Test", download: false },
  ...fields,
});

describe("music identity", () => {
  it("normalizes Cyrillic, Latin, accents, spacing and punctuation for search", () => {
    expect(normalizeText(" КАПИТАН — музыка! ")).toBe("kapitan muzyka");
    expect(normalizeText("Beyoncé")).toBe("beyonce");
    expect(normalizeText("Ёж")).toBe(normalizeText("Еж"));
  });
  it("matches the three Captain spelling variants across providers", () => {
    const first = track({ title: "Miyagi - Captain" });
    const second = track({
      id: "two",
      sourceId: "b",
      artist: "MIYAGI",
      title: "MIYAGI — CAPTAIN",
    });
    const third = track({
      id: "three",
      sourceId: "c",
      artist: "Miyagi & Andy Panda",
      title: "Captain (Official Audio)",
    });
    expect(areSameTrack(first, second)).toBe(true);
    expect(areSameTrack(first, third)).toBe(true);
    expect(trackKey(first)).toBe(trackKey(third));
    expect(deduplicateTracks([first, second, third])).toHaveLength(1);
  });
  it("preserves distinct remix, live and acoustic recordings", () => {
    for (const title of [
      "Captain (Remix)",
      "Captain (Live)",
      "Captain (Acoustic)",
      "Captain (Radio Edit)",
    ]) {
      expect(areSameTrack(track(), track({ id: title, title }))).toBe(false);
    }
  });
  it("uses source identity and MusicBrainz IDs without treating common titles as duplicates", () => {
    expect(
      areSameTrack(
        track({ mbid: "recording-1" }),
        track({
          sourceId: "b",
          title: "Alternate spelling",
          mbid: "recording-1",
        }),
      ),
    ).toBe(true);
    expect(
      areSameTrack(track(), track({ sourceId: "b", artist: "Another artist" })),
    ).toBe(false);
    expect(artistKeys("Miyagi featuring Andy Panda")).toEqual([
      "miyagi",
      "andy panda",
    ]);
  });
});
