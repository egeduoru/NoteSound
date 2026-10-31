import type {
  HistoryEntry,
  SignalWeights,
  TasteSignal,
  TasteSignalKind,
  Track,
} from "../../types/music";
import { artistKeys, trackKey } from "../../lib/normalize";
import { trackFeatures } from "./track-features";
import { latestExplicitFeedback } from "./feedback";
import { createTrackAnalysis, type TrackAnalysis } from "./track-analysis";

export const DEFAULT_SIGNAL_WEIGHTS: SignalWeights = {
  like: 5,
  favorite: 4,
  listen: 2,
  repeat: 2,
  skip: -1,
  dislike: -8,
};
export interface UserTasteProfile {
  trackScores: Record<string, number>;
  artistScores: Record<string, number>;
  genreScores: Record<string, number>;
  sessionTrackScores: Record<string, number>;
  sessionArtistScores: Record<string, number>;
  sessionGenreScores: Record<string, number>;
  sessionEventCount: number;
  knownTrackKeys: string[];
  knownArtists: string[];
  dislikedTrackKeys: string[];
  dislikedTrackIds: string[];
}
const clampWeight = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(-30, Math.min(30, value))
    : fallback;
export function normalizeSignalWeights(
  input?: Partial<SignalWeights>,
): SignalWeights {
  return Object.fromEntries(
    Object.entries(DEFAULT_SIGNAL_WEIGHTS).map(([kind, fallback]) => [
      kind,
      clampWeight(input?.[kind as TasteSignalKind], fallback),
    ]),
  ) as SignalWeights;
}

/** Only confirmed listening samples award a listen signal; starting a track is not a completed listen. */
export function qualifiesAsListen(track: Track, playedSeconds: number) {
  return (
    Number.isFinite(playedSeconds) &&
    track.duration > 0 &&
    playedSeconds >= track.duration * 0.7
  );
}
export function buildTasteProfile(
  signals: TasteSignal[] = [],
  favorites: Track[] = [],
  history: HistoryEntry[] = [],
  customWeights?: Partial<SignalWeights>,
  options: {
    now?: number;
    analysis?: TrackAnalysis;
    explicitFor?: ReturnType<typeof latestExplicitFeedback>;
  } = {},
): UserTasteProfile {
  const now = options.now ?? Date.now();
  const weights = normalizeSignalWeights(customWeights);
  const analysis = options.analysis ?? createTrackAnalysis();
  const profile: UserTasteProfile = {
    trackScores: {},
    artistScores: {},
    genreScores: {},
    sessionTrackScores: {},
    sessionArtistScores: {},
    sessionGenreScores: {},
    sessionEventCount: 0,
    knownTrackKeys: [],
    knownArtists: [],
    dislikedTrackKeys: [],
    dislikedTrackIds: [],
  };
  const knownTracks = new Set<string>(),
    knownArtists = new Set<string>();
  const favoriteSignals = new Set<string>();
  const lastExplicit = new Map<string, TasteSignal>();
  const explicitFor =
    options.explicitFor ?? latestExplicitFeedback(signals, now, analysis);
  // The store keeps newest events first, including multiple actions in one ms.
  const orderedSignals = signals
    .slice(0, 5000)
    .reverse()
    .sort((a, b) => a.at - b.at);
  for (const signal of orderedSignals)
    if (
      signal?.track &&
      Number.isFinite(signal.at) &&
      signal.at >= 0 &&
      signal.at <= now &&
      ["dislike", "like", "favorite"].includes(signal.kind)
    )
      lastExplicit.set(analysis(signal.track).key, signal);
  const add = (scores: Record<string, number>, key: string, weight: number) => {
    scores[key] = Math.max(-30, Math.min(30, (scores[key] ?? 0) + weight));
  };
  const register = (
    track: Track,
    weight: number,
    sessionWeight = 0,
    skip = false,
  ) => {
    const data = analysis(track);
    const key = data.key;
    knownTracks.add(key);
    add(profile.trackScores, key, weight);
    add(profile.sessionTrackScores, key, sessionWeight);
    for (const artist of data.artists) {
      knownArtists.add(artist);
      // A skip says "not now", not "I stopped liking this artist".
      add(profile.artistScores, artist, skip ? 0 : weight);
      add(profile.sessionArtistScores, artist, sessionWeight);
    }
    const genres = data.features.genres;
    for (const genre of genres) {
      add(
        profile.genreScores,
        genre,
        skip ? 0 : weight / Math.sqrt(genres.length),
      );
      add(
        profile.sessionGenreScores,
        genre,
        sessionWeight / Math.sqrt(genres.length),
      );
    }
  };
  const validTime = (at: number) => Number.isFinite(at) && at >= 0 && at <= now;
  const sessionDecay = (at: number) => {
    const minutes = Math.floor((now - at) / 60_000);
    return minutes >= 180 ? 0 : 2 ** (-minutes / 25);
  };
  const registerEvent = (track: Track, kind: TasteSignalKind, at: number) => {
    const recent = sessionDecay(at);
    const days = Math.floor((now - at) / 86400_000);
    const explicit = ["like", "favorite", "dislike"].includes(kind);
    const weight =
      weights[kind] *
      (kind === "skip" ? recent : explicit ? 1 : 2 ** (-days / 90));
    register(track, weight, weights[kind] * recent, kind === "skip");
    if (recent) profile.sessionEventCount += 1;
  };
  const seenSignals = new Set<string>();
  const listeningTimes = new Map<
    string,
    { skip: number[]; listen: number[] }
  >();
  for (const signal of orderedSignals) {
    if (
      !signal?.track ||
      !validTime(signal.at) ||
      seenSignals.has(signal.id) ||
      !(signal.kind in weights)
    )
      continue;
    seenSignals.add(signal.id);
    if (
      signal.kind === "listen" &&
      !qualifiesAsListen(signal.track, signal.playedSeconds ?? 0)
    )
      continue;
    if (signal.kind === "listen" || signal.kind === "skip") {
      const key = analysis(signal.track).key;
      const times = listeningTimes.get(key) ?? { skip: [], listen: [] };
      times[signal.kind].push(signal.at);
      listeningTimes.set(key, times);
    }
    // Undoing a dislike also removes its old negative contribution.
    if (
      signal.kind !== "dislike" ||
      explicitFor(signal.track)?.kind === "dislike"
    )
      registerEvent(signal.track, signal.kind, signal.at);
    const key = analysis(signal.track).key;
    if (signal.kind === "favorite") favoriteSignals.add(key);
  }
  for (const track of favorites)
    if (!favoriteSignals.has(analysis(track).key))
      register(track, weights.favorite);
  // Legacy history has no duration samples; preserve familiarity without inventing positive listen events.
  for (const entry of history) {
    if (!entry?.track || !validTime(entry.playedAt)) continue;
    const times = listeningTimes.get(analysis(entry.track).key);
    const isCovered = (kind: "skip" | "listen") =>
      times?.[kind].some(
        (at) =>
          at >= entry.playedAt - 1000 &&
          at <=
            entry.playedAt + (Math.max(0, entry.track.duration) + 60) * 1000,
      );
    const hasSkip = entry.skipped && isCovered("skip");
    register(entry.track, 0);
    if (entry.skipped && !hasSkip)
      registerEvent(entry.track, "skip", entry.playedAt);
    if (
      entry.completed &&
      qualifiesAsListen(entry.track, entry.playedSeconds ?? 0)
    ) {
      if (!isCovered("listen"))
        registerEvent(entry.track, "listen", entry.playedAt);
    }
  }
  for (const [key, signal] of lastExplicit)
    if (explicitFor(signal.track)?.kind === "dislike") {
      profile.dislikedTrackKeys.push(key);
      profile.dislikedTrackIds.push(signal.trackId);
    }
  profile.knownTrackKeys = [...knownTracks];
  profile.knownArtists = [...knownArtists];
  return profile;
}
export function scoreTaste(
  track: Track,
  profile: UserTasteProfile,
  analysis?: TrackAnalysis,
) {
  const data = analysis?.(track);
  const direct = profile.trackScores[data?.key ?? trackKey(track)] ?? 0;
  const artist = (data?.artists ?? artistKeys(track.artist)).reduce(
    (score, key) => score + (profile.artistScores[key] ?? 0),
    0,
  );
  const genres = data?.features.genres ?? trackFeatures(track).genres;
  const genre =
    genres.reduce((score, key) => score + (profile.genreScores[key] ?? 0), 0) /
    Math.max(1, genres.length);
  return Math.max(-30, Math.min(30, direct + artist * 0.35 + genre * 0.8));
}
/** Recent reactions decay within hours; they influence this session without
 * overwriting the long-term profile or turning skips into catalog bans. */
export function scoreSession(
  track: Track,
  profile: UserTasteProfile,
  analysis?: TrackAnalysis,
) {
  const data = analysis?.(track);
  const direct = profile.sessionTrackScores[data?.key ?? trackKey(track)] ?? 0;
  const artist = (data?.artists ?? artistKeys(track.artist)).reduce(
    (score, key) => score + (profile.sessionArtistScores[key] ?? 0),
    0,
  );
  const genres = data?.features.genres ?? trackFeatures(track).genres;
  const genre =
    genres.reduce(
      (score, key) => score + (profile.sessionGenreScores[key] ?? 0),
      0,
    ) / Math.max(1, genres.length);
  return Math.max(-18, Math.min(18, direct * 0.4 + artist * 0.6 + genre * 1.6));
}
export function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = Math.imul(value ^ (value >>> 15), 1 | value);
    next ^= next + Math.imul(next ^ (next >>> 7), 61 | next);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}
