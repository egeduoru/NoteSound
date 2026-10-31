import type { Track } from "../../types/music";
import {
  artistKeys,
  normalizedTitle,
  normalizeText,
} from "../../lib/normalize";
import { trackFeatures, type TrackFeatures } from "./track-features";

export interface AnalyzedTrack {
  artists: string[];
  title: string;
  key: string;
  sourceKey: string;
  mbid?: string;
  features: TrackFeatures;
}
/** A cache belongs to one recommendation request, never to the mutable catalog. */
export type TrackAnalysis = (track: Track) => AnalyzedTrack;
export function createTrackAnalysis(): TrackAnalysis {
  const cache = new WeakMap<Track, AnalyzedTrack>();
  return (track) => {
    let value = cache.get(track);
    if (!value) {
      const artists = artistKeys(track.artist);
      const title = normalizedTitle(track);
      value = {
        artists,
        title,
        key: `${artists[0] ?? normalizeText(track.artist)}::${title}`,
        sourceKey: JSON.stringify([track.sourceId, track.id]),
        mbid: track.mbid,
        features: trackFeatures(track),
      };
      cache.set(track, value);
    }
    return value;
  };
}

/** An exact index of the existing areSameTrack predicate, not a fuzzy identity. */
export function createRecordingIndex(
  analysis: TrackAnalysis,
  tracks: Track[] = [],
) {
  const ids = new Set<string>();
  const mbids = new Set<string>();
  const titles = new Map<string, Set<string>>();
  const add = (track: Track) => {
    const data = analysis(track);
    ids.add(data.sourceKey);
    if (data.mbid) mbids.add(data.mbid);
    let artists = titles.get(data.title);
    if (!artists) titles.set(data.title, (artists = new Set()));
    for (const artist of data.artists) artists.add(artist);
  };
  const has = (track: Track) => {
    const data = analysis(track);
    return (
      ids.has(data.sourceKey) ||
      (!!data.mbid && mbids.has(data.mbid)) ||
      data.artists.some((artist) => titles.get(data.title)?.has(artist))
    );
  };
  tracks.forEach(add);
  return { add, has };
}

export function deduplicateAnalyzedTracks(
  tracks: Track[],
  analysis = createTrackAnalysis(),
) {
  const seen = createRecordingIndex(analysis);
  return tracks.filter((track) => {
    const duplicate = seen.has(track);
    // The original predicate considers all earlier publications, even one
    // already identified as a duplicate (shared collaboration credits).
    seen.add(track);
    return !duplicate;
  });
}
