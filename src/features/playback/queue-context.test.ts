import { describe, expect, it } from "vitest";
import { contextQueue } from "./queue-context";
import type { Track } from "../../types/music";
const t = (id: number): Track => ({
  id: `licensed:${id}`, sourceId: "licensed", title: `Song ${id}`,
  artist: "Artist", duration: 100, genres: [],
  license: { name: "Test", download: false },
});
describe("original collection order and shuffle", () => {
  const songs = [t(1), t(2), t(3), t(4)];
  it("continues from selected track without jumping back to earlier items", () => {
    expect(contextQueue(songs[1], songs, false).map((s) => s.id))
      .toEqual(["licensed:3", "licensed:4"]);
  });
  it("shuffles all other members of favorites, not just later songs", () => {
    expect(contextQueue(songs[2], songs, true, () => 0).map((s) => s.id))
      .toEqual(["licensed:2", "licensed:4", "licensed:1"]);
  });
  it("never adds the selected recording or duplicate to the tail", () => {
    expect(contextQueue(songs[0], [...songs, songs[1]], false).map((s) => s.id))
      .toEqual(["licensed:2", "licensed:3", "licensed:4"]);
  });
});
