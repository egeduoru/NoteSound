import type { Track } from "../../types/music";
import { areSameTrack } from "../../lib/normalize";

/** Navigation must not mutate the queue; only a new selection changes its source. */
export type PlaybackContext = "wave" | "favorites" | "playlist" | "album" | "history" | "library";
export function contextQueue(
  selected: Track,
  list: Track[],
  shuffle: boolean,
  rng: () => number = Math.random,
): Track[] {
  const start = list.findIndex((item) => areSameTrack(item, selected));
  const tail = (shuffle || start < 0 ? list : list.slice(start + 1)).filter(
    (item, i, items) =>
      !areSameTrack(item, selected) &&
      !items.slice(0, i).some((other) => areSameTrack(item, other)),
  );
  if (!shuffle) return tail;
  for (let i = tail.length - 1; i > 0; i--) {
    const j = Math.max(0, Math.min(i, Math.floor(rng() * (i + 1))));
    [tail[i], tail[j]] = [tail[j], tail[i]];
  }
  return tail;
}
