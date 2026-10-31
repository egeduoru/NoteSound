import type { TasteSignal, Track } from "../../types/music";
import { artistKeys, normalizedTitle } from "../../lib/normalize";
import type { TrackAnalysis } from "./track-analysis";

/** Index explicit reactions by recording and each credited artist. This keeps
 * a different publication or reordered collaboration from bypassing a dislike. */
export function latestExplicitFeedback(
  signals: TasteSignal[],
  now = Date.now(),
  analysis?: TrackAnalysis,
) {
  const indexed = new Map<string, { event: TasteSignal; order: number }>();
  const cache = new WeakMap<Track, string[]>();
  const keys = (track: Track) => {
    let value = cache.get(track);
    if (!value) {
      const data = analysis?.(track);
      const title = data?.title ?? normalizedTitle(track);
      value = [
        `source:${track.sourceId}:${track.id}`,
        ...(data?.artists ?? artistKeys(track.artist)).map(
          (artist) => `recording:${artist}:${title}`,
        ),
        ...(track.mbid ? [`mbid:${track.mbid}`] : []),
      ];
      cache.set(track, value);
    }
    return value;
  };
  const seen = new Set<string>();
  const ordered = signals
    .slice(0, 5000)
    .reverse()
    .sort((a, b) => a.at - b.at);
  ordered.forEach((event, order) => {
    if (
      !event.track ||
      !Number.isFinite(event.at) ||
      event.at < 0 ||
      event.at > now ||
      !["like", "favorite", "dislike"].includes(event.kind) ||
      seen.has(event.id)
    )
      return;
    seen.add(event.id);
    for (const key of keys(event.track)) indexed.set(key, { event, order });
  });
  return (track: Track): TasteSignal | undefined => {
    let latest: { event: TasteSignal; order: number } | undefined;
    for (const key of keys(track)) {
      const match = indexed.get(key);
      if (match && (!latest || match.order > latest.order)) latest = match;
    }
    return latest?.event;
  };
}
