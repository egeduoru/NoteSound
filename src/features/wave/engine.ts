import type { Track } from "../../types/music";
import { suggestSimilarRecordings } from "../../services/recommendation/listenbrainz";
import {
  adapters,
  checkAvailability,
  searchTracks,
} from "../../adapters/music";
import { catalog } from "../../adapters/music/catalog";
import { artistKeys, areSameTrack, normalizeText } from "../../lib/normalize";
import {
  buildTasteProfile,
  qualifiesAsListen,
  scoreTaste,
  type UserTasteProfile,
} from "../taste/profile";
import { deduplicateAnalyzedTracks } from "../taste/track-analysis";
import {
  buildWaveCandidates,
  prepareWaveRanking,
  isNewWaveArtist,
  isWaveAudio,
  sameArtist,
  type WaveContext,
} from "./recommendation";
export {
  buildWaveCandidates,
  isAuthorizedAudio,
  isWaveAudio,
  recommendationShares,
} from "./recommendation";
export type { WaveContext, RecommendationReason } from "./recommendation";

const abortError = () =>
  new DOMException("Wave request cancelled", "AbortError");

/** Every operation gets a bounded lifetime even when an adapter ignores its signal. */
async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
  timeout = 20000,
): Promise<T> {
  if (parent?.aborted) throw abortError();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    abortListener = () => {
      controller.abort();
      reject(abortError());
    };
    parent?.addEventListener("abort", abortListener, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new DOMException(
          "Источник музыки не ответил вовремя. Повторите запуск Волны.",
          "TimeoutError",
        ),
      );
    }, timeout);
  });
  try {
    return await Promise.race([operation(controller.signal), cancellation]);
  } finally {
    clearTimeout(timer);
    if (abortListener) parent?.removeEventListener("abort", abortListener);
  }
}

const configurationFailure = (error: unknown) =>
  ["missing_key", "quota", "credentials"].includes(
    (error as { code?: string } | null)?.code || "",
  );
const usefulGenre = (genre: string) =>
  !["music", "muzyka", "local"].includes(normalizeText(genre));

const usableQuery = (value: string | undefined) =>
  (value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 200);
const genericQuery = (value: string) =>
  !value || normalizeText(value) === normalizeText("популярная музыка");
const remoteTrack = (track: Track) =>
  !track.local && track.sourceId !== "local";

/** Queries are selectors, not fabricated songs or inferred audio characteristics. */
function preferenceQuery(context: Partial<WaveContext>) {
  const mood = {
    any: "",
    calm: "спокойная музыка",
    energetic: "энергичная музыка",
    happy: "весёлая музыка",
    melancholic: "грустная музыка",
  }[context.preferences?.mood ?? "any"];
  const language = {
    any: "",
    russian: "русская музыка",
    foreign: "foreign music",
    instrumental: "инструментальная музыка",
  }[context.preferences?.language ?? "any"];
  return usableQuery([language, mood].filter(Boolean).join(" "));
}

function tasteAnchors(
  context: Partial<WaveContext>,
  preparedProfile?: UserTasteProfile,
) {
  const now = context.now ?? Date.now();
  const profile =
    preparedProfile ??
    buildTasteProfile(
      context.signals,
      context.favorites,
      context.history,
      context.signalWeights,
      { now },
    );
  const tracks = deduplicateAnalyzedTracks([
    ...(context.signals ?? [])
      .filter((event) => Number.isFinite(event.at) && event.at <= now)
      .slice()
      .sort((a, b) => b.at - a.at)
      .map((event) => event.track),
    ...(context.favorites ?? []),
    ...(context.history ?? [])
      .filter((entry) => entry.playedAt <= now)
      .map((entry) => entry.track),
  ]).filter(
    (track) =>
      remoteTrack(track) && !profile.dislikedTrackIds.includes(track.id),
  );
  const recent = (context.signals ?? [])
    .filter(
      (event) =>
        event.at <= now &&
        event.at >= now - 90 * 60_000 &&
        ["like", "favorite", "listen", "repeat"].includes(event.kind) &&
        (event.kind !== "listen" ||
          qualifiesAsListen(event.track, event.playedSeconds ?? 0)),
    )
    .slice()
    .sort((a, b) => b.at - a.at)
    .map((event) => event.track)
    .filter(
      (track) =>
        remoteTrack(track) &&
        artistKeys(track.artist).some(
          (artist) => (profile.sessionArtistScores[artist] ?? 0) > 0,
        ),
    );
  const personal = tracks
    .map((track) => ({ track, score: scoreTaste(track, profile) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.track);
  return { recent, personal, profile };
}

/** Session and lifetime tastes provide independent candidate channels. Personal
 * file metadata is never sent to an external music search. */
export function waveRetrievalQueries(
  seed: Track,
  context: Partial<WaveContext>,
  preparedProfile?: UserTasteProfile,
  preparedAnchors?: ReturnType<typeof tasteAnchors>,
) {
  if (!remoteTrack(seed)) return [];
  const { recent, personal } =
    preparedAnchors ?? tasteAnchors(context, preparedProfile);
  const query = preferenceQuery(context);
  const original = seed.sourceId === "notesound";
  const genres = [
    ...seed.genres,
    ...personal.flatMap((track) => track.genres),
  ].filter(usefulGenre);
  const sessionAnchor = recent.find((track) => !sameArtist(track, seed));
  const personalAnchor = personal.find(
    (track) =>
      !sameArtist(track, seed) &&
      (!sessionAnchor || !sameArtist(track, sessionAnchor)),
  );
  const proposals = [
    context.query,
    query,
    sessionAnchor?.artist,
    original ? genres[0] : seed.artist,
    personalAnchor?.artist,
    ...genres.slice(0, 2),
  ];
  const seen = new Set<string>();
  return proposals.flatMap((proposal) => {
    const text = usableQuery(proposal);
    const key = normalizeText(text);
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [text];
  });
}

function completeContext(context: Partial<WaveContext>): WaveContext {
  return {
    ...context,
    history: context.history ?? [],
    favorites: context.favorites ?? [],
    excluded: context.excluded ?? [],
    diversity: context.diversity ?? 0.25,
  };
}

const coldStartSeed: Track = {
  id: "wave:cold-start",
  sourceId: "wave",
  title: "",
  artist: "",
  duration: 0,
  genres: [],
  license: { name: "", download: false },
};

/** The same filter/ranker chooses the first track and subsequent queue entries.
 * The sentinel carries no recording, so no real candidate is excluded as a seed. */
export function chooseWaveSeed(
  candidates: Track[],
  context: Partial<WaveContext> = {},
): Track | null {
  const selected = buildWaveCandidates(coldStartSeed, candidates, {
    ...completeContext(context),
    limit: 1,
    now: context.now ?? Date.now(),
  })[0];
  return selected ?? null;
}

/** Cold-start discovery is a real external query, never a hard-coded song list. */
export async function discoverWaveSeed(
  query: string,
  signal?: AbortSignal,
  context: Partial<WaveContext> = {},
): Promise<Track | null> {
  return bounded(
    (requestSignal) => discoverSeed(query, requestSignal, context),
    signal,
    25000,
  );
}

async function discoverSeed(
  query: string,
  signal: AbortSignal,
  context: Partial<WaveContext>,
): Promise<Track | null> {
  const normalized = usableQuery(query);
  const explicit = !genericQuery(normalized);
  if (context.offline) {
    const terms = explicit ? normalizeText(normalized).split(" ") : [];
    return chooseWaveSeed(
      (context.collection ?? []).filter((track) => {
        const text = normalizeText(
          `${track.artist} ${track.title} ${track.genres.join(" ")}`,
        );
        return terms.every((term) => text.includes(term));
      }),
      context,
    );
  }
  const { recent, personal } = tasteAnchors(context);
  const directed = explicit
    ? normalized
    : preferenceQuery(context) ||
      recent[0]?.artist ||
      personal[0]?.artist ||
      "популярная музыка";
  const tracks: Track[] = [];
  let lastError: unknown;
  let metadataSucceeded = false;
  try {
    tracks.push(
      ...(await bounded(
        (requestSignal) => searchTracks(directed, requestSignal),
        signal,
      )),
    );
    metadataSucceeded = true;
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (explicit || configurationFailure(error)) throw error;
    lastError = error;
  }
  // An explicit query retains its meaning. Generic launch can use known playable
  // favorites/history alongside newly retrieved candidates, including offline files.
  if (!explicit)
    tracks.push(...(context.favorites ?? []), ...personal, ...recent);
  if (!tracks.some(isWaveAudio) && !explicit) {
    // A generic new-listener request can start with available licensed/original charts.
    // An explicit failed artist/song search is never replaced by demo metadata.
    for (const source of adapters
      .filter(
        (provider) => provider.status === "available" && provider.getTopTracks,
      )
      .slice(0, 2)) {
      try {
        tracks.push(
          ...(await bounded(
            (requestSignal) => source.getTopTracks!(requestSignal),
            signal,
          )),
        );
        metadataSucceeded = true;
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (configurationFailure(error)) throw error;
        lastError = error;
      }
    }
  }
  if (!tracks.length && !metadataSucceeded && lastError) throw lastError;
  const ranked = buildWaveCandidates(coldStartSeed, tracks, {
    ...completeContext(context),
    limit: 12,
    now: context.now ?? Date.now(),
  });
  for (const candidate of ranked) {
    if (signal?.aborted) throw abortError();
    try {
      if (
        await bounded(
          (requestSignal) => checkAvailability(candidate, requestSignal),
          signal,
          4500,
        )
      )
        return candidate;
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (configurationFailure(error)) throw error;
      // One stale recording is not an outage of the whole candidate catalog.
    }
  }
  return null;
}

export interface WaveRefillOptions {
  /** Append-only batches of newly validated tracks, never a cumulative replacement. */
  onBatch?: (tracks: Track[]) => void;
  /** Upper bound on the number validated and emitted at one checkpoint. */
  batchSize?: number;
  /** Return after the first available track, before retrieving slower extra selectors. */
  initialOnly?: boolean;
}

/** Up to four metadata operations, fourteen bounded availability checks, seven ready tracks. */
export async function refillWave(
  seed: Track,
  context: WaveContext,
  signal?: AbortSignal,
  options: WaveRefillOptions = {},
): Promise<Track[]> {
  const partial: Track[] = [];
  const progressive = Boolean(options.onBatch || options.initialOnly);
  try {
    return await bounded(
      (requestSignal) =>
        refill(
          seed,
          context,
          requestSignal,
          progressive
            ? {
                ...options,
                onBatch: (batch) => {
                  partial.push(...batch);
                  options.onBatch?.(batch);
                },
              }
            : options,
        ),
      signal,
      30000,
    );
  } catch (error) {
    // An extra selector failing or timing out must not retract music that the
    // caller has already received. Explicit cancellation still wins.
    if (
      !signal?.aborted &&
      (error as Error).name !== "AbortError" &&
      partial.length
    )
      return partial;
    throw error;
  }
}

async function refill(
  seed: Track,
  context: WaveContext,
  signal: AbortSignal,
  options: WaveRefillOptions,
): Promise<Track[]> {
  if (signal?.aborted) throw abortError();
  if (!isWaveAudio(seed)) return [];
  const target = Math.max(1, Math.min(7, Math.floor(context.limit ?? 7)));
  const progressive = Boolean(options.onBatch || options.initialOnly);
  const batchSize = Math.max(
    1,
    Math.min(2, Math.floor(options.batchSize ?? 2)),
  );
  // Let the browser paint/continue audio before synchronous recommendation work.
  if (progressive) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  if (signal.aborted) throw abortError();
  const ranking = prepareWaveRanking(context);
  if (context.offline) {
    const saved = ranking.rank(seed, context.collection ?? [], {
      limit: options.initialOnly ? 1 : target,
    });
    for (let i = 0; i < saved.length; i += batchSize) {
      if (signal.aborted) throw abortError();
      options.onBatch?.(saved.slice(i, i + batchSize));
    }
    if (signal.aborted) throw abortError();
    return saved;
  }
  const candidates: Track[] = [];
  const ready: Track[] = [];
  const checked: Track[] = [];
  let availabilityChecks = 0;
  const collaborators: string[] = [];
  let queryCount = 0;
  let selectors = 0;
  let lastError: unknown;
  let metadataSucceeded = false;
  const collect = async <T>(
    request: (requestSignal: AbortSignal) => Promise<T>,
  ): Promise<T | null> => {
    for (let attempt = 0; attempt < 2 && queryCount < 4; attempt += 1) {
      queryCount += 1;
      try {
        const result = await bounded(
          request,
          signal,
          context.explorationDue ? 5000 : 20000,
        );
        metadataSucceeded = true;
        return result;
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (configurationFailure(error)) throw error;
        lastError = error;
      }
      // One short backoff only; retries share the same total request budget.
      if (attempt === 0 && queryCount < 4) {
        await bounded(
          () => new Promise<void>((resolve) => setTimeout(resolve, 180)),
          signal,
          1000,
        );
      }
    }
    return null;
  };
  const source = adapters.find(
    (adapter) =>
      adapter.id === seed.sourceId &&
      ["available", "experimental"].includes(adapter.status),
  );
  const personal = seed.local || seed.sourceId === "local";
  const original = seed.sourceId === "notesound";
  const seekingNewArtist =
    Boolean(context.explorationDue) &&
    context.preferences?.familiarity !== "familiar" &&
    !personal;
  let explorationPending = seekingNewArtist;
  const unfamiliar = (track: Track) =>
    isNewWaveArtist(track, context, seed, ranking.profile);
  const anchors = personal ? undefined : tasteAnchors(context, ranking.profile);
  const publishReady = async (count = batchSize): Promise<boolean> => {
    if (!progressive) return false;
    if (ready.length >= target || availabilityChecks >= 14) return true;
    if (signal.aborted) throw abortError();
    // A full favorites/artist page must not consume a scheduled discovery slot.
    // Check real unfamiliar artists first; familiar fallback is released only
    // after the bounded retrieval channels have been attempted.
    const room = Math.min(
      explorationPending ? 1 : count,
      target - ready.length,
    );
    const ranked = ranking.rank(
      seed,
      explorationPending ? candidates.filter(unfamiliar) : candidates,
      {
        excluded: [...context.excluded, ...checked, ...ready],
        recentSequence: [...(context.recentSequence ?? [seed]), ...ready],
        previousTrack: ready.at(-1) ?? context.previousTrack,
        limit: Math.min(14 - availabilityChecks, Math.max(room, room * 2)),
        explorationDue: explorationPending,
      },
    );
    const batch: Track[] = [];
    for (const track of ranked) {
      if (
        batch.length >= room ||
        availabilityChecks >= 14 ||
        (options.initialOnly && batch.length)
      )
        break;
      if (signal.aborted) throw abortError();
      if (checked.some((other) => areSameTrack(other, track))) continue;
      checked.push(track);
      availabilityChecks += 1;
      let available = false;
      try {
        available = personal
          ? Boolean(context.collection?.some((item) => item.id === track.id))
          : await bounded(
              (requestSignal) => checkAvailability(track, requestSignal),
              signal,
              4500,
            );
      } catch {
        if (signal.aborted) throw abortError();
      }
      if (signal.aborted) throw abortError();
      if (available) batch.push(track);
    }
    if (batch.length) {
      // Availability can remove the planned first introduction while another
      // recording by that same artist survives. Assign provenance only from
      // the tracks actually entering the queue, against all already queued
      // artists; rejected recordings must not consume an introduction.
      const validated = ranking.rank(seed, batch, {
        excluded: [...context.excluded, ...ready],
        recentSequence: [...(context.recentSequence ?? [seed]), ...ready],
        previousTrack: ready.at(-1) ?? context.previousTrack,
        limit: batch.length,
        explorationDue: explorationPending,
      });
      explorationPending = false;
      ready.push(...validated);
      options.onBatch?.(validated);
      if (!options.initialOnly && room < count && ready.length < target)
        return publishReady(count - room);
    }
    return (
      ready.length >= target || Boolean(options.initialOnly && ready.length)
    );
  };
  if (personal)
    candidates.push(
      ...(context.collection || []).filter(
        (track) => track.local || track.sourceId === "local",
      ),
    );
  if (original) candidates.push(...catalog);
  if (!personal) {
    candidates.push(...context.favorites.filter(isWaveAudio));
    // Recent positive sessions are candidate sources even when the provider has
    // no genres or related-artist endpoint. Ranking still applies hard dislikes.
    const { personal: preferred, recent: session } = anchors!;
    candidates.push(
      ...preferred.filter(isWaveAudio),
      ...session.filter(isWaveAudio),
    );
  }
  if (await publishReady()) return ready;
  // Optional, independently failing ListenBrainz Labs selector. An MBID is
  // never a playable URL: each candidate must resolve through a provider and
  // pass the same availability and ranking checks as ordinary Wave tracks.
  if (!personal && !original && !context.offline) {
    try {
      const suggestions = await bounded((sig) => suggestSimilarRecordings(seed, sig), signal, 7000);
      const tasks = suggestions.slice(0, 2).map(async (item) => {
        const results = await bounded(
          (sig) => searchTracks(`${item.artist} ${item.title}`, sig), signal, 7000,
        );
        return results.filter((track) =>
          normalizeText(track.title) === normalizeText(item.title) &&
          normalizeText(track.artist) === normalizeText(item.artist) &&
          isWaveAudio(track),
        ).map((track) => ({ ...track, mbid: item.mbid }));
      });
      const retrieved = await Promise.allSettled(tasks);
      for (const result of retrieved)
        if (result.status === "fulfilled") candidates.push(...result.value);
      if (await publishReady()) return ready;
    } catch {
      // Keep local recommendations; an experimental dataset cannot halt audio.
    }
  }

  if (!personal && !original && source?.getTopTracks) {
    selectors += 1;
    const chart = await collect((requestSignal) =>
      source.getTopTracks!(requestSignal),
    );
    if (chart) candidates.push(...chart);
    if (await publishReady()) return ready;
  }
  // Paginated providers use one path; asking getSimilarTracks and then search
  // for the same artist spent the budget on the same cached first page.
  if (
    !personal &&
    !original &&
    source?.getSimilarTracks &&
    !source.searchPage
  ) {
    selectors += 1;
    const similar = await collect((requestSignal) =>
      source.getSimilarTracks!(seed, requestSignal),
    );
    if (similar) {
      candidates.push(...similar);
      const seedArtists = new Set(artistKeys(seed.artist));
      // Shared credits supply real artist relationships when genre tags are
      // absent. Keep the source spelling rather than inventing a musical style.
      for (const track of similar.filter((item) => sameArtist(seed, item)))
        for (const name of track.artist.split(
          /\s*(?:,|&|\bfeat\.?|\bft\.?|×)\s*/iu,
        ))
          if (
            name.trim() &&
            artistKeys(name).some((key) => !seedArtists.has(key))
          )
            collaborators.push(name.trim());
    }
    if (await publishReady()) return ready;
  }
  const broadQuery = preferenceQuery(context) || "популярная музыка";
  const usedSimilar =
    !original && source?.getSimilarTracks && !source.searchPage;
  const queries = waveRetrievalQueries(
    seed,
    context,
    ranking.profile,
    anchors,
  ).filter(
    (query) =>
      !usedSimilar || normalizeText(query) !== normalizeText(seed.artist),
  );
  if (seekingNewArtist && explorationPending && source?.getRelatedArtists) {
    const unknownCollaborator = collaborators.some((artist) =>
      unfamiliar({ ...seed, artist }),
    );
    if (!unknownCollaborator && queryCount < 4) {
      const soloArtist = seed.artist
        .split(/\s*(?:,|&|\bfeat\.?|\bft\.?|×)\s*/iu)[0]
        ?.trim();
      if (soloArtist) {
        selectors += 1;
        const related = await collect((requestSignal) =>
          source.getRelatedArtists!(soloArtist, requestSignal),
        );
        if (related) collaborators.push(...related);
      }
    }
  }
  const collaborator = collaborators.find(
    (name) =>
      !queries.some((query) => normalizeText(query) === normalizeText(name)),
  );
  if (collaborator && !seed.genres.some(usefulGenre))
    queries.splice(Math.min(2, queries.length), 0, collaborator);
  if (
    context.preferences?.familiarity !== "familiar" &&
    !queries.some((query) => normalizeText(query) === normalizeText(broadQuery))
  )
    queries.push(broadQuery);
  if (seekingNewArtist) {
    const names = [...new Set(collaborators)].filter((artist) =>
      unfamiliar({ ...seed, artist }),
    );
    // Rotate actual related names rather than replaying the first cached artist
    // on each refill. No artist or genre is inferred from the song title.
    if (names.length > 1) {
      const offset = Math.floor(
        Math.max(0, Math.min(0.999999, (context.rng ?? Math.random)())) *
          names.length,
      );
      names.push(...names.splice(0, offset));
    }
    const genres = [
      ...seed.genres,
      ...(anchors?.personal ?? []).flatMap((track) => track.genres),
    ]
      .filter(usefulGenre)
      .slice(0, 2);
    const ordered = [...names, ...genres, broadQuery, ...queries];
    const seen = new Set<string>();
    queries.splice(
      0,
      queries.length,
      ...ordered.filter((query) => {
        const key = normalizeText(query);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    );
  }
  // A full first artist page/chart is not enough evidence of a varied pool.
  // Each refill samples independent selectors while keeping the four-call cap.
  const minimumSelectors =
    context.preferences?.familiarity === "familiar" ? 2 : 3;
  for (const query of personal ? [] : queries) {
    if (
      queryCount >= 4 ||
      (selectors >= minimumSelectors &&
        (!explorationPending ||
          ranking.rank(seed, candidates.filter(unfamiliar), {
            limit: 1,
            rng: () => 0.5,
          }).length > 0) &&
        ranking.rank(seed, candidates, {
          limit: target,
          rng: () => 0.5,
        }).length >= target)
    )
      break;
    selectors += 1;
    const crossCatalog =
      normalizeText(query) === normalizeText(broadQuery) &&
      normalizeText(query) !== normalizeText(context.query ?? "");
    if (source?.searchPage && !crossCatalog) {
      let pageToken: string | undefined;
      const seenTokens = new Set<string>();
      do {
        const page = await collect((requestSignal) =>
          source.searchPage!(query, { signal: requestSignal, pageToken }),
        );
        if (!page) break;
        candidates.push(...page.tracks);
        if (await publishReady()) return ready;
        pageToken = page.nextPageToken;
        if (pageToken && seenTokens.has(pageToken)) break;
        if (pageToken) seenTokens.add(pageToken);
      } while (
        pageToken &&
        queryCount < 4 &&
        ranking.rank(seed, candidates, {
          limit: target,
          rng: () => 0.5,
        }).length < target
      );
    } else {
      const found = await collect((requestSignal) =>
        searchTracks(query, requestSignal),
      );
      if (found) candidates.push(...found);
      if (await publishReady()) return ready;
    }
  }
  if (!candidates.length && !metadataSucceeded && lastError) throw lastError;
  if (progressive) {
    explorationPending = false;
    while (ready.length < target && availabilityChecks < 14) {
      const before = checked.length;
      await publishReady();
      if (checked.length === before) break;
      // Small batches release the main thread rather than building the entire
      // queue in one synchronous task while the current song is playing.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (signal.aborted) throw abortError();
    }
    return ready;
  }
  const ranked = ranking.rank(seed, candidates, {
    limit: Math.min(14, target * 2),
  });
  for (let i = 0; i < ranked.length && ready.length < target; i += 2) {
    if (signal?.aborted) throw abortError();
    const batch = await Promise.all(
      ranked.slice(i, i + 2).map(async (track) => {
        try {
          if (personal)
            return context.collection?.some((item) => item.id === track.id)
              ? track
              : null;
          return (await bounded(
            (requestSignal) => checkAvailability(track, requestSignal),
            signal,
            4500,
          ))
            ? track
            : null;
        } catch {
          if (signal?.aborted) throw abortError();
          return null;
        }
      }),
    );
    ready.push(...batch.filter((track): track is Track => Boolean(track)));
  }
  if (signal?.aborted) throw abortError();
  return ranking.rank(seed, ready, { limit: target });
}
