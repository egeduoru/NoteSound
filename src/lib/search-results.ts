import type { Track } from "../types/music";
import { areSameTrack } from "./normalize";

function positiveDuration(track: Track) {
  return Number.isFinite(track.duration) && track.duration > 0
    ? track.duration
    : 0;
}

function isFullAudio(track: Track) {
  return (
    track.availability !== "unavailable" &&
    !["metadata", "external", "embedded"].includes(
      track.playbackMode || "audio",
    ) &&
    (track.streamAccess === "provider_stream" ||
      track.rights?.status === "confirmed" ||
      (track.local === true && track.sourceId === "local"))
  );
}

function preference(track: Track, references: Track[]) {
  const full = isFullAudio(track);
  const difference = Math.min(
    ...references
      .filter((reference) => areSameTrack(track, reference))
      .map((reference) =>
        Math.abs(positiveDuration(track) - positiveDuration(reference)),
      ),
  );
  const matchesReference =
    full &&
    track.sourceId === "public" &&
    positiveDuration(track) > 0 &&
    difference <= 3;
  return [
    track.availability !== "unavailable" ? 1 : 0,
    matchesReference ? 1 : 0,
    matchesReference ? -difference : 0,
    full ? 1 : 0,
    track.artwork ? 1 : 0,
    positiveDuration(track),
  ];
}

/** Select an existing recording variant without manufacturing metadata or rights. */
export function deduplicateSearchResults(tracks: Track[]): Track[] {
  const parents = tracks.map((_, index) => index);
  function root(index: number): number {
    if (parents[index] !== index) parents[index] = root(parents[index]);
    return parents[index];
  }
  for (let index = 0; index < tracks.length; index++) {
    for (let earlier = 0; earlier < index; earlier++) {
      if (areSameTrack(tracks[index], tracks[earlier])) {
        const first = root(earlier),
          second = root(index);
        parents[Math.max(first, second)] = Math.min(first, second);
      }
    }
  }
  const groups = new Map<number, Track[]>();
  tracks.forEach((track, index) => {
    const identity = root(index);
    if (!groups.has(identity)) groups.set(identity, []);
    groups.get(identity)!.push(track);
  });
  return [...groups.values()].map((group) => {
    const references = group.filter(
      (track) => track.sourceId === "deezer" && positiveDuration(track) > 0,
    );
    let selected = group[0],
      score = preference(selected, references);
    for (const candidate of group.slice(1)) {
      const next = preference(candidate, references);
      const firstDifference = next.findIndex(
        (value, index) => value !== score[index],
      );
      if (
        firstDifference !== -1 &&
        next[firstDifference] > score[firstDifference]
      ) {
        selected = candidate;
        score = next;
      }
    }
    return selected;
  });
}
