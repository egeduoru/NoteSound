import { describe, expect, it } from "vitest";
import type { Track } from "../types/music";
import { deduplicateSearchResults } from "./search-results";

const track = (fields: Partial<Track> = {}): Track => ({
  id: "public:one",
  sourceId: "public",
  title: "Song",
  artist: "Artist",
  duration: 150,
  genres: [],
  playbackMode: "audio",
  streamAccess: "provider_stream",
  availability: "available",
  rights: { status: "unknown", basis: "none", allowMix: false },
  license: { name: "Provided by source", download: false },
  ...fields,
});

describe("search recording selection", () => {
  it("chooses the complete public recording by a matching catalog duration", () => {
    const clipped = track({
      id: "public:clip",
      duration: 89,
      artwork: "https://art.example/clip.jpg",
    });
    const complete = track({ id: "public:complete", duration: 150 });
    const reference = track({
      id: "deezer:42",
      sourceId: "deezer",
      streamAccess: "preview",
      duration: 150,
      artwork: "https://art.example/ref.jpg",
    });
    const selected = deduplicateSearchResults([clipped, complete, reference]);
    expect(selected).toEqual([complete]);
    expect(selected[0]).toBe(complete);
    expect(selected[0].artwork).toBeUndefined();
    expect(selected[0].rights?.status).toBe("unknown");
    expect(clipped.duration).toBe(89);
  });

  it("prefers the closest full recording within three seconds before artwork", () => {
    const near = track({
      id: "public:near",
      duration: 148,
      artwork: "https://art.example/near.jpg",
    });
    const exact = track({ id: "public:exact", duration: 150 });
    const reference = track({
      id: "deezer:42",
      sourceId: "deezer",
      streamAccess: "preview",
    });
    expect(deduplicateSearchResults([near, exact, reference])).toEqual([exact]);
  });

  it("prefers an available full stream to a preview even when the preview arrives first", () => {
    const preview = track({
      id: "deezer:42",
      sourceId: "deezer",
      streamAccess: "preview",
      artwork: "https://art.example/42.jpg",
    });
    const full = track();
    expect(deduplicateSearchResults([preview, full])).toEqual([full]);
    expect(deduplicateSearchResults([full, preview])).toEqual([full]);
  });

  it("retains distinct remix and live versions and preserves group order", () => {
    const main = track({ duration: 89 }),
      remix = track({ id: "public:remix", title: "Song (Remix)" });
    const live = track({ id: "public:live", title: "Song (Live)" });
    const other = track({ id: "public:other", title: "Another Song" });
    const complete = track({ id: "public:complete", duration: 150 });
    expect(
      deduplicateSearchResults([main, remix, other, live, complete]),
    ).toEqual([complete, remix, other, live]);
  });

  it("without a reference prefers artwork, then a more complete duration only on otherwise equal variants", () => {
    const first = track({ id: "public:first", duration: 200 });
    const withArt = track({
      id: "public:art",
      duration: 150,
      artwork: "https://art.example/42.jpg",
    });
    const longerWithArt = track({
      id: "public:long",
      duration: 180,
      artwork: withArt.artwork,
    });
    expect(deduplicateSearchResults([first, withArt])).toEqual([withArt]);
    expect(deduplicateSearchResults([first, withArt, longerWithArt])).toEqual([
      longerWithArt,
    ]);
  });

  it("does not let an unavailable full recording displace an available preview", () => {
    const unavailable = track({ availability: "unavailable" });
    const preview = track({
      id: "deezer:42",
      sourceId: "deezer",
      streamAccess: "preview",
    });
    expect(deduplicateSearchResults([unavailable, preview])).toEqual([preview]);
  });

  it("does not merge common titles by different artists or invent recordings", () => {
    const first = track(),
      other = track({ id: "public:other", artist: "Another Artist" });
    expect(deduplicateSearchResults([first, other])).toEqual([first, other]);
    expect(deduplicateSearchResults([])).toEqual([]);
  });
});
