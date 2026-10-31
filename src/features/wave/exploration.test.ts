import { describe, expect, it } from "vitest";
import type { HistoryEntry, Track } from "../../types/music";
import { waveExplorationDue } from "./exploration";

const track = (artist: string, discovery = false) =>
  ({
    artist,
    metadata: discovery ? { recommendationArtistDiscovery: "true" } : {},
  }) as Track;
const history = (...tracks: Track[]) =>
  tracks
    .reverse()
    .map((item, i) => ({ track: item, playedAt: 100 - i })) as HistoryEntry[];

describe("new artist cadence across incremental refills", () => {
  it("reserves an opening after three familiar songs including the future queue", () => {
    const played = history(track("A"));
    expect(waveExplorationDue(played, [track("B")])).toBe(false);
    expect(waveExplorationDue(played, [track("B"), track("C")])).toBe(true);
    expect(
      waveExplorationDue(played, [track("B"), track("C"), track("D", true)]),
    ).toBe(false);
  });
  it("continues counting after an introduction and requests more in discovery mode", () => {
    const played = history(track("A"), track("B", true));
    expect(waveExplorationDue(played, [track("A"), track("C")])).toBe(false);
    expect(
      waveExplorationDue(played, [track("A"), track("C"), track("D")]),
    ).toBe(true);
    expect(waveExplorationDue(played, [track("A")], "discover")).toBe(true);
  });
  it("does not treat a replay carrying an old marker as a second introduction", () => {
    expect(
      waveExplorationDue(
        history(track("A", true), track("B"), track("A", true), track("C")),
      ),
    ).toBe(true);
  });
  it("does not force unfamiliar artists in favorites mode or on an empty start", () => {
    expect(
      waveExplorationDue(
        history(track("A"), track("B"), track("C")),
        [],
        "familiar",
      ),
    ).toBe(false);
    expect(waveExplorationDue([])).toBe(false);
  });
});
