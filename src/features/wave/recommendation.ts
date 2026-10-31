import type {
  HistoryEntry,
  SignalWeights,
  TasteSignal,
  Track,
  WavePreferences,
} from "../../types/music";
import { artistKeys } from "../../lib/normalize";
import {
  buildTasteProfile,
  scoreSession,
  scoreTaste,
  type UserTasteProfile,
} from "../taste/profile";
import {
  matchesWavePreferences,
  preferenceScore,
} from "../taste/track-features";
import { isProviderAudio } from "../../lib/playback-access";
import { validSoundCloudTrack } from "../../adapters/music/soundcloud";
import { latestExplicitFeedback } from "../taste/feedback";
import {
  createTrackAnalysis,
  createRecordingIndex,
  deduplicateAnalyzedTracks,
  type TrackAnalysis,
} from "../taste/track-analysis";

export interface WaveContext {
  history: HistoryEntry[];
  favorites: Track[];
  /** Hard exclusions: current, manual/automatic queue and in-flight tracks, not lifetime history. */
  excluded: Track[];
  diversity: number;
  previousTrack?: Track;
  query?: string;
  collection?: Track[];
  dislikedIds?: string[];
  signals?: TasteSignal[];
  signalWeights?: Partial<SignalWeights>;
  discoveryIntensity?: number;
  /** Reserve the next recommendation for an unfamiliar artist when the source permits. */
  explorationDue?: boolean;
  recentSequence?: Track[];
  limit?: number;
  rng?: () => number;
  now?: number;
  preferences?: WavePreferences;
  localHour?: number;
  offline?: boolean;
}
export type RecommendationReason =
  "similar" | "personal" | "discovery" | "popular";
export const sameArtist = (one: Track, two: Track) =>
  artistKeys(one.artist).some((key) => artistKeys(two.artist).includes(key));

function anchoredArtists(
  context: WaveContext,
  profile: UserTasteProfile,
  seed?: Track,
) {
  return new Set([
    ...profile.knownArtists,
    ...[seed, context.previousTrack, ...(context.recentSequence ?? [])]
      .filter((track): track is Track => Boolean(track))
      .flatMap((track) => artistKeys(track.artist)),
  ]);
}

// Older cached source rows can contain a whole "track: artist - title" label
// in the artist field. Keep fallback playback, but do not invent an identity.
const unambiguousArtist = (track: Track) =>
  !/(?:^\s*|,\s*)(?:трек|песня|track|song)\s*:/iu.test(track.artist);

/** An unheard song or a collaboration with a familiar artist is not a new artist. */
export function isNewWaveArtist(
  track: Track,
  context: WaveContext,
  seed?: Track,
  preparedProfile?: UserTasteProfile,
) {
  const profile =
    preparedProfile ??
    buildTasteProfile(
      context.signals,
      context.favorites,
      context.history,
      context.signalWeights,
      { now: context.now ?? Date.now() },
    );
  const known = anchoredArtists(context, profile, seed);
  const artists = artistKeys(track.artist);
  return (
    unambiguousArtist(track) &&
    artists.length > 0 &&
    artists.every((artist) => !known.has(artist))
  );
}

/** Playback permissions are separate from metadata or the existence of an MP3 link. */
export function isAuthorizedAudio(track: Track) {
  if (
    track.availability === "unavailable" ||
    track.playback?.kind === "youtube" ||
    ["embedded", "external", "metadata"].includes(track.playbackMode ?? "")
  )
    return false;
  if (track.rights)
    return track.rights.status === "confirmed" && track.rights.basis !== "none";
  // Migration compatibility for files actually imported by this listener and the bundled original collection.
  return (
    track.local === true ||
    track.sourceId === "local" ||
    track.sourceId === "notesound"
  );
}

/** A full provider stream may enter the queue without granting download or Mix rights. */
export function isWaveAudio(track: Track) {
  if (track.streamAccess === "preview" || track.rights?.status === "denied")
    return false;
  return (
    isAuthorizedAudio(track) ||
    validSoundCloudTrack(track) ||
    (isProviderAudio(track) && track.streamAccess === "provider_stream")
  );
}
export function recommendationShares(
  intensity = 0.25,
): Record<RecommendationReason, number> {
  const discovery = 0.05 + 0.6 * Math.max(0, Math.min(1, intensity));
  return {
    similar: (1 - discovery) * 0.5,
    personal: (1 - discovery) * 0.375,
    discovery,
    popular: (1 - discovery) * 0.125,
  };
}
function weighted<T>(
  items: T[],
  weight: (item: T) => number,
  rng: () => number,
): T {
  const total = items.reduce((sum, item) => sum + Math.max(0, weight(item)), 0);
  let ticket =
    Math.max(0, Math.min(0.999999999999, Number(rng()) || 0)) * total;
  for (const item of items) {
    ticket -= Math.max(0, weight(item));
    if (ticket < 0) return item;
  }
  return items[items.length - 1];
}

export interface PreparedWaveRanking {
  profile: UserTasteProfile;
  rank(
    seed: Track,
    candidates: Track[],
    overrides?: Partial<WaveContext>,
  ): Track[];
}

/** Prepare once for a refill's checkpoints. It owns all caches and is discarded
 * when feedback changes, so mutable catalog objects never enter a global cache. */
export function prepareWaveRanking(context: WaveContext): PreparedWaveRanking {
  const now = context.now ?? Date.now();
  const analysis = createTrackAnalysis();
  const explicitFor = latestExplicitFeedback(
    context.signals ?? [],
    now,
    analysis,
  );
  const profile = buildTasteProfile(
    context.signals,
    context.favorites,
    context.history,
    context.signalWeights,
    { now, analysis, explicitFor },
  );
  const knownTracks = new Set(profile.knownTrackKeys);
  const knownArtists = new Set(profile.knownArtists);
  const dislikedKeys = new Set(profile.dislikedTrackKeys);
  const recentIndexes = new Map<
    boolean,
    ReturnType<typeof createRecordingIndex>
  >();
  return {
    profile,
    rank(seed, candidates, overrides = {}) {
      const next = { ...context, ...overrides };
      // Queue/limit/sequence/mode overrides are cheap. A new profile snapshot
      // must be prepared if a caller supplies new feedback or history.
      if (
        ["signals", "favorites", "history", "signalWeights", "now"].some(
          (name) =>
            Object.hasOwn(overrides, name) &&
            overrides[name as keyof WaveContext] !==
              context[name as keyof WaveContext],
        )
      )
        return prepareWaveRanking(next).rank(seed, candidates);
      const familiar = next.preferences?.familiarity === "familiar";
      let recent = recentIndexes.get(familiar);
      if (!recent) {
        const cutoff = now - (familiar ? 3 * 3600_000 : 30 * 86400_000);
        recent = createRecordingIndex(
          analysis,
          context.history
            .filter(
              (entry) => entry.playedAt >= cutoff && entry.playedAt <= now,
            )
            .map((entry) => entry.track),
        );
        recentIndexes.set(familiar, recent);
      }
      return rankPrepared(seed, candidates, next, {
        now,
        analysis,
        explicitFor,
        profile,
        knownTracks,
        knownArtists,
        dislikedKeys,
        recent,
      });
    },
  };
}

/** Target mixture is 40/30/20/10 at default discovery; only truthful buckets participate. */
export function buildWaveCandidates(
  seed: Track,
  candidates: Track[],
  context: WaveContext,
): Track[] {
  if (context.limit !== undefined && context.limit <= 0) return [];
  return prepareWaveRanking(context).rank(seed, candidates);
}

function rankPrepared(
  seed: Track,
  candidates: Track[],
  context: WaveContext,
  prepared: {
    now: number;
    analysis: TrackAnalysis;
    explicitFor: ReturnType<typeof latestExplicitFeedback>;
    profile: UserTasteProfile;
    knownTracks: Set<string>;
    knownArtists: Set<string>;
    dislikedKeys: Set<string>;
    recent: ReturnType<typeof createRecordingIndex>;
  },
): Track[] {
  const limit = Math.max(0, Math.min(50, Math.floor(context.limit ?? 7)));
  if (!limit) return [];
  const rng = context.rng ?? Math.random;
  const {
    now,
    analysis,
    profile,
    explicitFor,
    knownTracks,
    knownArtists,
    dislikedKeys,
    recent,
  } = prepared;
  const hardExcluded = createRecordingIndex(analysis, [
    seed,
    ...context.excluded,
  ]);
  const dislikedIds = new Set([
    ...(context.dislikedIds ?? []),
    ...profile.dislikedTrackIds,
  ]);
  const intensity =
    context.preferences?.familiarity === "discover"
      ? 0.95
      : context.preferences?.familiarity === "familiar"
        ? 0.03
        : (context.discoveryIntensity ?? context.diversity ?? 0.25);
  const shares = recommendationShares(intensity);
  const used: Record<RecommendationReason, number> = {
    similar: 0,
    personal: 0,
    discovery: 0,
    popular: 0,
  };
  const pool = deduplicateAnalyzedTracks(
    candidates.filter(isWaveAudio),
    analysis,
  ).filter(
    (track) =>
      !dislikedIds.has(track.id) &&
      explicitFor(track)?.kind !== "dislike" &&
      !dislikedKeys.has(analysis(track).key) &&
      matchesWavePreferences(
        track,
        context.preferences,
        analysis(track).features,
      ) &&
      !hardExcluded.has(track),
  );
  const result: Track[] = [];
  const reasons: RecommendationReason[] = [
    "similar",
    "personal",
    "discovery",
    "popular",
  ];
  const seedData = analysis(seed);
  const familiarArtists = anchoredArtists(context, profile, seed);
  const sharesArtist = (one: Track, two: Track) =>
    analysis(one).artists.some((artist) =>
      analysis(two).artists.includes(artist),
    );
  const sameRecording = (one: Track, two: Track) => {
    const a = analysis(one),
      b = analysis(two);
    return (
      a.sourceKey === b.sourceKey ||
      (!!a.mbid && a.mbid === b.mbid) ||
      (a.title === b.title &&
        a.artists.some((artist) => b.artists.includes(artist)))
    );
  };
  const seedIdentity = createRecordingIndex(analysis, [seed]);
  let latestSeedReaction: TasteSignal | undefined;
  for (const event of context.signals ?? [])
    if (
      event.at <= now &&
      event.at >= now - 3 * 3600_000 &&
      (!latestSeedReaction || event.at > latestSeedReaction.at) &&
      seedIdentity.has(event.track)
    )
      latestSeedReaction = event;
  const seedAffinity =
    latestSeedReaction?.kind === "skip" ||
    latestSeedReaction?.kind === "dislike"
      ? 0.2
      : 1;
  const facts = new Map<
    Track,
    {
      known: boolean;
      familiar: boolean;
      newArtist: boolean;
      heard: boolean;
      score: number;
      buckets: Record<RecommendationReason, boolean>;
    }
  >();
  for (const track of pool) {
    const data = analysis(track);
    const common = seedData.features.genres.filter((genre) =>
      data.features.genres.includes(genre),
    ).length;
    const similarity =
      !seedData.features.genres.length || !data.features.genres.length
        ? 0
        : common /
          Math.sqrt(
            seedData.features.genres.length * data.features.genres.length,
          );
    const sameSeedArtist = sharesArtist(seed, track);
    const taste = scoreTaste(track, profile, analysis);
    const session = scoreSession(track, profile, analysis);
    const known = knownTracks.has(data.key);
    const knownArtist = data.artists.some((artist) => knownArtists.has(artist));
    const newArtist =
      unambiguousArtist(track) &&
      data.artists.length > 0 &&
      data.artists.every((artist) => !familiarArtists.has(artist));
    const score = Math.max(
      0.1,
      5 +
        similarity * 4 * seedAffinity +
        taste * 0.6 +
        session * 1.4 +
        preferenceScore(track, context.preferences, data.features) +
        (sameSeedArtist ? 3 * (1 - intensity) * seedAffinity : intensity * 4) +
        (knownArtist ? 0 : intensity * 5) +
        (context.localHour !== undefined &&
        (context.localHour >= 23 || context.localHour < 6) &&
        context.preferences?.mood === "any" &&
        data.features.energy !== null
          ? (0.5 - data.features.energy) * 0.8
          : 0),
    );
    facts.set(track, {
      known,
      familiar: known || knownArtist,
      newArtist,
      heard: recent.has(track),
      score,
      buckets: {
        similar: session >= -1 && (sameSeedArtist || common > 0),
        personal: taste > 0,
        popular:
          typeof track.popularity === "number" &&
          Number.isFinite(track.popularity) &&
          track.popularity > 0,
        discovery: newArtist,
      },
    });
  }
  const inBucket = (track: Track, reason: RecommendationReason) =>
    facts.get(track)!.buckets[reason] &&
    (reason !== "discovery" ||
      !result.some((selected) => sharesArtist(track, selected)));
  const score = (track: Track) => facts.get(track)!.score;
  const preceding = context.recentSequence?.length
    ? [...context.recentSequence]
    : [seed];
  if (
    context.previousTrack &&
    !sameRecording(preceding.at(-1)!, context.previousTrack)
  )
    preceding.push(context.previousTrack);
  while (pool.length && result.length < limit) {
    // Prefer anything not heard in 30 days, then relax only this soft restriction for a small catalog.
    let eligible = pool.filter((track) => !facts.get(track)!.heard);
    if (!eligible.length) eligible = pool.slice();
    const familiar = (track: Track) => facts.get(track)!.familiar;
    if (context.preferences?.familiarity === "familiar") {
      const known = eligible.filter(familiar);
      if (known.length) eligible = known;
    }
    const newArtist = (track: Track) =>
      facts.get(track)!.newArtist &&
      !result.some((selected) => sharesArtist(track, selected));
    const wantsNewArtist =
      context.preferences?.familiarity !== "familiar" &&
      ((context.explorationDue && result.length === 0) ||
        context.preferences?.familiarity === "discover");
    if (wantsNewArtist) {
      const unknownArtists = eligible.filter(newArtist);
      if (unknownArtists.length) eligible = unknownArtists;
      else if (context.preferences?.familiarity === "discover") {
        const unheard = eligible.filter((track) => !facts.get(track)!.known);
        if (unheard.length) eligible = unheard;
      }
    }
    const prior = [...preceding, ...result].slice(-4);
    const withinArtistCap = eligible.filter(
      (track) => prior.filter((other) => sharesArtist(track, other)).length < 2,
    );
    if (withinArtistCap.length) eligible = withinArtistCap;
    else {
      const catalogAlternatives = pool.filter(
        (track) =>
          prior.filter((other) => sharesArtist(track, other)).length < 2,
      );
      if (catalogAlternatives.length) eligible = catalogAlternatives;
    }
    const previous = result.at(-1) ?? context.previousTrack ?? seed;
    const differentArtist = eligible.filter(
      (track) => !sharesArtist(track, previous),
    );
    if (differentArtist.length) eligible = differentArtist;
    const availableBuckets = reasons.filter((reason) =>
      eligible.some((track) => inBucket(track, reason)),
    );
    // A previously heard track with unknown metadata may have no truthful reason.
    const forcedDiscovery = wantsNewArtist && eligible.some(newArtist);
    const reason = forcedDiscovery
      ? "discovery"
      : availableBuckets.length
        ? weighted(
            availableBuckets,
            (bucket) =>
              Math.max(
                0.01,
                shares[bucket] * (result.length + 1) - used[bucket],
              ),
            rng,
          )
        : null;
    const matching = reason
      ? eligible.filter((track) => inBucket(track, reason))
      : eligible;
    const selection = matching.length ? matching : eligible;
    const top = selection
      .slice()
      .sort((one, two) => score(two) - score(one))
      .slice(0, 8);
    const selected = weighted(top, (track) => score(track) ** 2, rng);
    const metadata = { ...selected.metadata };
    if (reason) metadata.recommendationReason = reason;
    else delete metadata.recommendationReason;
    if (newArtist(selected)) metadata.recommendationArtistDiscovery = "true";
    else delete metadata.recommendationArtistDiscovery;
    result.push({ ...selected, metadata });
    if (reason) used[reason] += 1;
    pool.splice(pool.indexOf(selected), 1);
  }
  return result;
}
