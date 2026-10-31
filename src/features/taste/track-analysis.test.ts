import { describe, expect, it } from "vitest";
import type { Track } from "../../types/music";
import {
  createTrackAnalysis,
  createRecordingIndex,
  deduplicateAnalyzedTracks,
} from "./track-analysis";

const track = (id: string, extra: Partial<Track> = {}): Track => ({
  id,
  sourceId: "licensed",
  title: "Группа крови",
  artist: "Кино",
  duration: 180,
  genres: [],
  license: { name: "Licensed", download: false },
  ...extra,
});
describe("request-scoped recording analysis", () => {
  it("matches source identity, shared MBIDs and reordered collaboration credits without merging live versions", () => {
    const index = createRecordingIndex(createTrackAnalysis(), [
      track("one", { artist: "Кино, Другой", mbid: "recording" }),
    ]);
    expect(index.has(track("one", { title: "Changed metadata" }))).toBe(true);
    expect(
      index.has(
        track("foreign", {
          artist: "Other",
          title: "Other",
          mbid: "recording",
        }),
      ),
    ).toBe(true);
    expect(
      index.has(
        track("alias", {
          artist: "Другой & КИНО",
          title: "Группа крови (Official Audio)",
        }),
      ),
    ).toBe(true);
    expect(index.has(track("live", { title: "Группа крови Live" }))).toBe(
      false,
    );
  });
  it("retains the original duplicate-bridge semantics for shared collaboration credits", () => {
    const first = track("a", { artist: "A" });
    const duplicate = track("ab", { artist: "A & B" });
    const shared = track("b", { artist: "B" });
    expect(deduplicateAnalyzedTracks([first, duplicate, shared])).toEqual([
      first,
    ]);
  });
  it("does not merge uncredited tracks merely because their titles match", () => {
    expect(
      deduplicateAnalyzedTracks([
        track("a", { artist: "" }),
        track("b", { artist: "" }),
      ]),
    ).toHaveLength(2);
  });
  it("new recommendation jobs see updated provider metadata instead of a global cached value", () => {
    const item = track("one", { genres: ["ambient"] });
    const first = createTrackAnalysis();
    expect(first(item).features.genres).toContain("ambient");
    item.genres = ["metal"];
    expect(createTrackAnalysis()(item).features.genres).toContain("metal");
  });
});
