import { create } from "zustand";
import { contextQueue, type PlaybackContext } from "../features/playback/queue-context";
import {
  db,
  importLegacyProfile,
  MAX_OFFLINE_BYTES,
  sanitizeImportedTrack,
  type OfflineRecord,
} from "../services/storage/db";
import { playbackController } from "../services/playback/controller";
import {
  hydrateCuePoints,
  hydrateTracksCuePoints,
} from "../services/storage/cue-points";
import { adapters, resolveStream, canPlayTrack, configureMusicSources } from "../adapters/music";
import { catalog } from "../adapters/music/catalog";
import {
  chooseWaveSeed,
  discoverWaveSeed,
  refillWave,
} from "../features/wave/engine";
import {
  buildWaveCandidates,
  isNewWaveArtist,
  prepareWaveRanking,
  type WaveContext,
} from "../features/wave/recommendation";
import { qualifiesAsListen } from "../features/taste/profile";
import { latestExplicitFeedback } from "../features/taste/feedback";
import { scheduleWaveBackground } from "../features/wave/background";
import { waveExplorationDue } from "../features/wave/exploration";
import {
  mergeQueues,
  appendAutomatic,
  enqueueManual,
  WAVE_QUEUE_TARGET,
} from "../features/wave/queue";
import { normalizeSettings } from "../lib/settings";
import { telegram } from "../services/telegram";
import { areSameTrack, trackKey } from "../lib/normalize";
import {
  defaultSettings,
  type HistoryEntry,
  type Playlist,
  type Settings,
  type Track,
  type TasteSignal,
  type TasteSignalKind,
} from "../types/music";

export type RepeatMode = "off" | "one" | "all";
export interface MusicState {
  ready: boolean;
  tracks: Track[];
  favorites: Track[];
  history: HistoryEntry[];
  playlists: Playlist[];
  playlistTracks: Record<string, Track[]>;
  queue: Track[];
  queueContext: PlaybackContext;
  contextTracks: Track[];
  manualQueue: Track[];
  automaticQueue: Track[];
  tasteSignals: TasteSignal[];
  dislikedIds: string[];
  likedIds: string[];
  mixTransition: {
    from: Track;
    to: Track;
    progress: number;
    duration: number;
  } | null;
  mixMessage: string | null;
  current: Track | null;
  playing: boolean;
  position: number;
  duration: number;
  loading: boolean;
  error: string | null;
  wave: boolean;
  waveResolving: boolean;
  waveStarting: boolean;
  waveMessage: string | null;
  waveQuery: string | null;
  settings: Settings;
  repeat: RepeatMode;
  shuffle: boolean;
  offlineIds: string[];
  storageBytes: number;
  initialize: () => Promise<void>;
  play: (track: Track, list?: Track[], context?: PlaybackContext) => Promise<void>;
  playQueued: (id: string) => Promise<void>;
  togglePlay: () => Promise<void>;
  pause: () => void;
  clearPlayback: () => void;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  seek: (seconds: number) => void;
  setVolume: (volume: number) => void;
  setRepeat: (repeat: RepeatMode) => void;
  toggleShuffle: () => void;
  toggleFavorite: (track: Track) => Promise<void>;
  toggleLike: (track: Track) => Promise<void>;
  dislike: (track: Track) => Promise<void>;
  resetTaste: () => Promise<void>;
  createPlaylist: (name: string) => Promise<string>;
  deletePlaylist: (id: string) => Promise<void>;
  addToPlaylist: (id: string, track: Track) => Promise<void>;
  removeFromPlaylist: (id: string, trackId: string) => Promise<void>;
  removeFromQueue: (id: string) => void;
  enqueue: (track: Track) => void;
  startWave: (track?: Track, query?: string) => Promise<void>;
  startNewWave: () => Promise<void>;
  stopWave: () => void;
  resetWave: () => Promise<void>;
  updateSettings: (settings: Partial<Settings>) => void;
  importFiles: (files: File[]) => Promise<void>;
  downloadTrack: (track: Track) => Promise<void>;
  removeOffline: (id: string) => Promise<void>;
  clearHistory: () => Promise<void>;
  exportLibrary: () => Promise<string>;
  importLibrary: (json: string) => Promise<void>;
  dismissError: () => void;
}

let initializing: Promise<void> | null = null;
let storageAvailable = true;
let playRevision = 0;
let playbackSession = 0;
let recordedSession = -1;
let recordingPromise: Promise<void> | null = null;
let waveRequest: AbortController | null = null;
let waveFillPromise: Promise<void> | null = null;
let waveStartRevision = 0;
let cancelWaveWork: (() => void) | null = null;
let pendingWaveReplacement = false;
let manuallySelectedSession = false;
let playbackRequest: AbortController | null = null;
let waveSeen: Track[] = [];
let previousTracks: Track[] = [];
let loadedId: string | null = null;
let endedId: string | null = null;
let lastPositionSave = 0;
let advancingAfterError = false;
let failures = 0;
const offlineMemory = new Map<string, OfflineRecord>();
const offlineDownloads = new Set<string>();
let offlineWriteTail = Promise.resolve();
const listenedTotals = new Map<string, number>();
const completedLoads = new Set<string>();
let preparedRevision = 0;
let preparingTrackId: string | null = null;
let preparedTrackId: string | null = null;
const profileId = () =>
  String(telegram()?.initDataUnsafe?.user?.id ?? "device");
const preferenceKey = (key: string) =>
  profileId() === "device" ? key : `${key}:${profileId()}`;
function queues(manual: Track[], automatic: Track[]) {
  const queue = mergeQueues(manual, automatic);
  return {
    manualQueue: distinct(manual),
    automaticQueue: distinct(automatic).filter(
      (track) => !manual.some((other) => areSameTrack(track, other)),
    ),
    queue,
  };
}
function remainingQueues(tail: Track[], state: MusicState) {
  return queues(
    tail.filter((track) =>
      state.manualQueue.some((other) => other.id === track.id),
    ),
    tail.filter(
      (track) => !state.manualQueue.some((other) => other.id === track.id),
    ),
  );
}
function trustedTrack(track: Track): Track {
  const original = catalog.find(
    (item) => item.id === track.id && item.sourceId === track.sourceId,
  );
  if (original) {
    const reason = track.metadata?.recommendationReason;
    const discovery = track.metadata?.recommendationArtistDiscovery;
    return reason || discovery
      ? {
          ...original,
          metadata: {
            ...original.metadata,
            ...(reason ? { recommendationReason: reason } : {}),
            ...(discovery ? { recommendationArtistDiscovery: discovery } : {}),
          },
        }
      : original;
  }
  return track.local && track.sourceId === "local"
    ? {
        ...track,
        playbackMode: "audio",
        rights: {
          status: "confirmed",
          basis: "personal_upload",
          allowMix: true,
        },
      }
    : track;
}
async function signalFor(
  track: Track,
  kind: TasteSignalKind,
  playedSeconds?: number,
) {
  const state = useMusicStore.getState();
  const entry: TasteSignal = {
    id: crypto.randomUUID(),
    trackId: track.id,
    track,
    kind,
    at: Date.now(),
    ...(playedSeconds === undefined ? {} : { playedSeconds }),
  };
  const signals = [entry, ...state.tasteSignals].slice(0, 5000);
  useMusicStore.setState({
    tasteSignals: signals,
    ...activeFeedback(signals),
  });
  adaptWaveRecommendations();
  await persist(() =>
    db.tasteSignals.put({ ...entry, profileId: profileId() }),
  );
}
async function removeSignals(track: Track, kind: TasteSignalKind) {
  const signals = useMusicStore
    .getState()
    .tasteSignals.filter(
      (entry) => !areSameTrack(entry.track, track) || entry.kind !== kind,
    );
  useMusicStore.setState({
    tasteSignals: signals,
    ...activeFeedback(signals),
  });
  adaptWaveRecommendations();
  await persist(() =>
    db.tasteSignals
      .where("profileId")
      .equals(profileId())
      .filter(
        (entry) => areSameTrack(entry.track, track) && entry.kind === kind,
      )
      .delete(),
  );
}

/** An explicit positive reaction can undo an earlier ban of the same recording. */
function activeFeedback(signals: TasteSignal[]) {
  const explicitFor = latestExplicitFeedback(signals);
  const active = signals.filter((signal) => signal.at <= Date.now());
  return {
    dislikedIds: [
      ...new Set(
        active
          .filter(
            (signal) =>
              signal.kind === "dislike" &&
              explicitFor(signal.track)?.kind === "dislike",
          )
          .map((signal) => signal.trackId),
      ),
    ],
    likedIds: [
      ...new Set(
        active
          .filter(
            (signal) =>
              signal.kind === "like" &&
              explicitFor(signal.track)?.kind !== "dislike",
          )
          .map((signal) => signal.trackId),
      ),
    ],
  };
}
function isDislikedTrack(track: Track, state: MusicState) {
  return (
    state.dislikedIds.includes(track.id) ||
    state.tasteSignals.some(
      (signal) =>
        signal.kind === "dislike" &&
        state.dislikedIds.includes(signal.trackId) &&
        areSameTrack(signal.track, track),
    )
  );
}
function canUseWaveSeed(track: Track, state: MusicState) {
  const needsFile =
    track.local ||
    track.sourceId === "local" ||
    (typeof navigator !== "undefined" && navigator.onLine === false);
  return (
    canPlayTrack(trustedTrack(track)) &&
    (!needsFile ||
      state.offlineIds.includes(track.id) ||
      offlineMemory.has(track.id) ||
      state.tracks.some((saved) => saved.id === track.id))
  );
}

function waveContext(state: MusicState, replaceAutomatic = false): WaveContext {
  return {
    history: state.history,
    favorites: state.favorites,
    excluded: [
      ...(state.current ? [state.current] : []),
      ...state.manualQueue,
      ...(replaceAutomatic ? [] : state.automaticQueue),
    ],
    recentSequence: [
      ...state.history
        .slice(0, 4)
        .map((entry) => entry.track)
        .reverse(),
      ...(replaceAutomatic ? [] : state.queue),
    ],
    dislikedIds: state.dislikedIds,
    signals: state.tasteSignals,
    signalWeights: state.settings.signalWeights,
    discoveryIntensity: state.settings.discoveryIntensity,
    preferences: state.settings.wavePreferences,
    explorationDue: waveExplorationDue(
      state.history,
      replaceAutomatic ? [] : state.queue,
      state.settings.wavePreferences.familiarity,
    ),
    localHour: new Date().getHours(),
    offline: typeof navigator !== "undefined" && navigator.onLine === false,
    limit: Math.max(
      0,
      WAVE_QUEUE_TARGET -
        state.manualQueue.length -
        (replaceAutomatic ? 0 : state.automaticQueue.length),
    ),
    diversity: state.settings.diversity,
    previousTrack: replaceAutomatic
      ? (state.current ?? undefined)
      : (state.queue.at(-1) ?? state.current ?? undefined),
    query: state.waveQuery ?? undefined,
    collection: state.tracks,
  };
}

/** Rerank already prepared audio immediately; fetching a new pool never empties it. */
function adaptWaveRecommendations() {
  const state = useMusicStore.getState();
  if (!state.wave || !state.current || state.waveStarting) return;
  cancelWaveRequest();
  const automatic = buildWaveCandidates(state.current, state.automaticQueue, {
    ...waveContext(state, true),
    rng: () => 0,
  });
  useMusicStore.setState(queues(state.manualQueue, automatic));
  savePlayback();
  void prepareNext();
  scheduleWaveFill(350, true);
}

function scheduleWaveFill(delay = 350, replaceAutomatic = false) {
  const state = useMusicStore.getState();
  if (
    !state.wave ||
    !state.current ||
    !state.playing ||
    state.loading ||
    state.waveStarting
  )
    return;
  pendingWaveReplacement ||= replaceAutomatic;
  cancelWaveWork?.();
  cancelWaveWork = scheduleWaveBackground(() => {
    cancelWaveWork = null;
    const replace = pendingWaveReplacement;
    pendingWaveReplacement = false;
    const latest = useMusicStore.getState();
    if (
      latest.wave &&
      latest.playing &&
      !latest.loading &&
      !latest.waveStarting
    )
      void fillWave(replace, replace);
  }, delay);
}

function invalidatePreparation() {
  ++preparedRevision;
  preparingTrackId = null;
  preparedTrackId = null;
}

function warnStorage() {
  useMusicStore.setState({
    error:
      "Хранилище недоступно или заполнено. Изменения этой сессии могут не сохраниться.",
  });
}
async function persist(task: () => Promise<unknown>) {
  if (!storageAvailable) {
    warnStorage();
    return;
  }
  try {
    await task();
  } catch {
    warnStorage();
  }
}
function savePlayback() {
  const s = useMusicStore.getState();
  void persist(async () => {
    await db.transaction("rw", db.settings, db.queue, async () => {
      await db.settings.put({
        key: preferenceKey("playback"),
        value: {
          current: s.current,
          position: s.position,
          wave: s.wave,
          waveQuery: s.waveQuery,
          repeat: s.repeat,
          shuffle: s.shuffle,
          queueContext: s.queueContext,
          contextTracks: s.contextTracks,
          previousTracks: previousTracks.slice(-50),
        },
      });
      await db.queue.clear();
      await db.queue.bulkPut(
        s.queue.map((track, position) => ({
          id: track.id,
          track,
          position,
          kind: s.manualQueue.some((item) => item.id === track.id)
            ? ("manual" as const)
            : ("automatic" as const),
        })),
      );
    });
  });
}
function pausePlayback() {
  cancelWaveRequest();
  const s = useMusicStore.getState();
  // Invalidate any automatic transition that is waiting for recommendations.
  ++playRevision;
  if (s.loading) {
    playbackRequest?.abort();
    loadedId = null;
    playbackController.stop();
  } else playbackController.pause();
  useMusicStore.setState({
    loading: false,
    playing: false,
    position: s.position,
  });
  savePlayback();
}
function distinct(tracks: Track[]) {
  return tracks.filter(
    (t, i) => !tracks.slice(0, i).some((other) => areSameTrack(t, other)),
  );
}
async function localRecord(id: string) {
  const memory = offlineMemory.get(id);
  if (memory) return memory;
  try {
    return await db.offlineTracks.get(id);
  } catch {
    return undefined;
  }
}
function commitOffline(record: OfflineRecord, requirePersistent: boolean) {
  const task = offlineWriteTail.then(async () => {
    const s = useMusicStore.getState();
    if (s.offlineIds.includes(record.id)) return;
    if (record.bytes + s.storageBytes > MAX_OFFLINE_BYTES)
      throw new Error("Недостаточно места: лимит офлайн-хранилища — 250 МБ.");
    const write = () =>
      db.transaction("rw", db.offlineTracks, db.tracks, async () => {
        await db.offlineTracks.put(record);
        await db.tracks.put(record.track);
      });
    if (requirePersistent) {
      if (!storageAvailable)
        throw new Error("Браузерное хранилище недоступно. Файл не сохранён.");
      await write();
    } else await persist(write);
    offlineMemory.set(record.id, record);
    const latest = useMusicStore.getState();
    useMusicStore.setState({
      offlineIds: [...latest.offlineIds, record.id],
      tracks: distinct([...latest.tracks, record.track]),
      storageBytes: latest.storageBytes + record.bytes,
    });
  });
  offlineWriteTail = task.catch(() => undefined);
  return task;
}
async function stream(track: Track, signal?: AbortSignal) {
  const local = await localRecord(track.id);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (local) return URL.createObjectURL(local.blob);
  return resolveStream(track, signal);
}
async function prepareNext() {
  const { queue, settings } = useMusicStore.getState();
  let next = queue[0];
  if (!next || settings.dataSaver || next.playback?.kind === "youtube" || next.sourceId === "soundcloud") {
    invalidatePreparation();
    playbackController.prepare(null);
    return;
  }
  if (preparedTrackId === next.id || preparingTrackId === next.id) return;
  const revision = ++preparedRevision;
  preparingTrackId = next.id;
  try {
    if (storageAvailable) next = await hydrateCuePoints(trustedTrack(next));
    const url = await stream(next);
    if (
      revision !== preparedRevision ||
      useMusicStore.getState().queue[0]?.id !== next.id
    ) {
      if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
      return;
    }
    playbackController.prepare(url, next);
    preparedTrackId = url ? next.id : null;
  } catch {
    if (revision === preparedRevision) playbackController.prepare(null);
  } finally {
    if (revision === preparedRevision) preparingTrackId = null;
  }
}
async function fillWave(force = false, replaceAutomatic = false) {
  if (waveFillPromise) return waveFillPromise;
  const s = useMusicStore.getState();
  if (
    !s.wave ||
    !s.current ||
    s.manualQueue.length >= WAVE_QUEUE_TARGET ||
    (!force && s.queue.length >= WAVE_QUEUE_TARGET) ||
    waveRequest
  )
    return;
  const seed = s.current;
  const request = new AbortController();
  waveRequest = request;
  useMusicStore.setState({ waveResolving: true, waveMessage: null });
  const task = (async () => {
    const initialSize = s.automaticQueue.length;
    let grew = false;
    const mergeBatch = (candidates: Track[]) => {
      if (request.signal.aborted || !useMusicStore.getState().wave) return;
      const state = useMusicStore.getState();
      const added = candidates.filter(
        (track) =>
          canPlayTrack(trustedTrack(track)) &&
          !isDislikedTrack(track, state) &&
          ![
            ...(state.current ? [state.current] : []),
            ...state.manualQueue,
            ...state.automaticQueue,
          ].some((other) => areSameTrack(track, other)),
      );
      if (!added.length) return;
      const automatic = replaceAutomatic
        ? [...added, ...state.automaticQueue]
        : [...state.automaticQueue, ...added];
      const next = appendAutomatic(
        { manual: state.manualQueue, automatic: [] },
        automatic,
        state.current ?? undefined,
      );
      useMusicStore.setState({
        ...queues(next.manual, next.automatic),
        waveMessage: null,
      });
      grew ||= next.automatic.length > initialSize;
      savePlayback();
      if (state.playing && !state.loading) void prepareNext();
    };
    try {
      const context = waveContext(s);
      context.limit = Math.min(
        2,
        replaceAutomatic
          ? WAVE_QUEUE_TARGET - s.manualQueue.length
          : (context.limit ?? 2),
      );
      const candidates = await refillWave(seed, context, request.signal, {
        onBatch: mergeBatch,
        batchSize: 1,
      });
      if (request.signal.aborted || !useMusicStore.getState().wave) return;
      mergeBatch(candidates);
      if (!useMusicStore.getState().queue.length)
        useMusicStore.setState({
          waveMessage:
            "Сейчас нет следующей доступной записи. Добавьте музыку или выберите другой трек.",
        });
    } catch (error) {
      if (
        !request.signal.aborted &&
        waveRequest === request &&
        (error as Error).name !== "AbortError"
      )
        useMusicStore.setState({
          waveMessage:
            error instanceof Error
              ? error.message
              : "Подбор временно недоступен. Повторите запуск Волны.",
        });
    } finally {
      if (waveRequest === request) {
        waveRequest = null;
        useMusicStore.setState({ waveResolving: false });
        if (grew && useMusicStore.getState().queue.length < WAVE_QUEUE_TARGET)
          scheduleWaveFill(1000);
      }
    }
  })();
  waveFillPromise = task;
  try {
    await task;
  } finally {
    if (waveFillPromise === task) waveFillPromise = null;
  }
}
function cancelWaveRequest() {
  cancelWaveWork?.();
  cancelWaveWork = null;
  pendingWaveReplacement = false;
  ++waveStartRevision;
  waveRequest?.abort();
  waveRequest = null;
  waveFillPromise = null;
  useMusicStore.setState({ waveResolving: false, waveStarting: false });
}
async function recordPlay(track: Track, intentional = false) {
  const repeated = useMusicStore
    .getState()
    .history.some(
      (entry) =>
        areSameTrack(entry.track, track) &&
        qualifiesAsListen(entry.track, entry.playedSeconds ?? 0),
    );
  if (repeated && intentional) void signalFor(track, "repeat");
  const entry: HistoryEntry = { track, playedAt: Date.now(), playedSeconds: 0 };
  const history = [entry, ...useMusicStore.getState().history].slice(0, 1000);
  useMusicStore.setState({ history });
  await persist(async () => {
    const id = await db.history.add(entry);
    entry.id = id;
    await db.tracks.put(track);
    const count = await db.history.count();
    if (count > 1000)
      await db.history
        .orderBy("playedAt")
        .limit(count - 1000)
        .delete();
  });
}
async function reserveWaveTrack(track: Track) {
  if (waveSeen.some((other) => areSameTrack(other, track))) return;
  waveSeen.push(track);
  await persist(() =>
    db.waveHistory.put({ key: trackKey(track), track, playedAt: Date.now() }),
  );
}
/** Iframe playback may start after a blocked autoplay, directly from its native Play button. */
async function commitPlayback(track: Track, session: number) {
  if (
    session !== playbackSession ||
    useMusicStore.getState().current?.id !== track.id
  )
    return;
  if (recordedSession === session) {
    await recordingPromise;
    scheduleWaveFill();
    return;
  }
  recordedSession = session;
  const task = (async () => {
    failures = 0;
    useMusicStore.setState({ loading: false, error: null });
    let reservation: Promise<void> | undefined;
    if (
      useMusicStore.getState().wave &&
      !waveSeen.some((other) => areSameTrack(other, track))
    ) {
      reservation = reserveWaveTrack(track);
    }
    await Promise.all([
      recordPlay(track, manuallySelectedSession),
      reservation,
    ]);
    if (
      session !== playbackSession ||
      useMusicStore.getState().current?.id !== track.id
    )
      return;
    savePlayback();
    void prepareNext();
    scheduleWaveFill();
  })();
  recordingPromise = task;
  try {
    await task;
  } finally {
    if (recordingPromise === task) recordingPromise = null;
  }
}
async function markSkipped() {
  const s = useMusicStore.getState();
  if (!s.current) return;
  const entry = s.history.find((h) => h.track.id === s.current?.id);
  if (!entry) return;
  if (
    (entry.playedSeconds ?? 0) >
    Math.max(10, (s.duration || s.current.duration) * 0.6)
  )
    return;
  if (entry.skipped) return;
  void signalFor(s.current, "skip", entry.playedSeconds);
  const next = { ...entry, skipped: true };
  useMusicStore.setState({
    history: s.history.map((h) => (h === entry ? next : h)),
  });
  if (entry.id)
    await persist(() => db.history.update(entry.id!, { skipped: true }));
}
async function begin(track: Track, position = 0, intentional = true) {
  track = trustedTrack(track);
  if (!canPlayTrack(track)) {
    useMusicStore.setState({
      error:
        "Для этой записи нет подтверждённого аудиоисточника. Можно открыть её страницу у источника.",
      loading: false,
    });
    return;
  }
  listenedTotals.delete(track.id);
  const revision = ++playRevision;
  const session = ++playbackSession;
  manuallySelectedSession = intentional;
  endedId = null;
  playbackRequest?.abort();
  const request = new AbortController();
  playbackRequest = request;
  loadedId = null;
  playbackController.stop();
  invalidatePreparation();
  useMusicStore.setState({
    current: track,
    position,
    duration: track.duration,
    playing: false,
    loading: true,
    error: null,
    mixTransition: null,
  });
  try {
    await persist(async () => {
      track = await hydrateCuePoints(track);
    });
    if (revision !== playRevision) return;
    useMusicStore.setState({ current: track });
    const url =
      track.playback?.kind === "youtube"
        ? null
        : await stream(track, request.signal);
    if (revision !== playRevision) {
      if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
      return;
    }
    if (!url && track.playback?.kind !== "youtube")
      throw new Error("У этой композиции нет доступного аудио.");
    playbackController.volume(useMusicStore.getState().settings.volume);
    loadedId = track.id;
    playbackController.configureMix(useMusicStore.getState().settings.waveMix);
    await playbackController.load(url, track, position, true);
    if (revision !== playRevision) return;
    if (track.sourceId === "soundcloud") {
      useMusicStore.setState({ loading: false });
    } else await commitPlayback(track, session);
  } catch (error) {
    if (revision !== playRevision || (error as Error).name === "AbortError")
      return;
    loadedId =
      track.playback?.kind === "youtube" &&
      (error as Error).name === "NotAllowedError"
        ? track.id
        : null;
    useMusicStore.setState({
      loading: false,
      playing: false,
      error:
        (error as Error).name === "NotAllowedError"
          ? "Нажмите воспроизведение ещё раз: браузер ожидает вашего действия."
          : (error as Error).message || "Не удалось воспроизвести композицию.",
    });
    // A dead stream cannot trap an otherwise prepared queue. Autoplay restrictions require a gesture instead.
    if (
      track.playback?.kind !== "youtube" &&
      (error as Error).name !== "NotAllowedError" &&
      useMusicStore.getState().queue.length &&
      failures < 3
    ) {
      failures++;
      await advance(false);
    }
  }
}

export const useMusicStore = create<MusicState>((set, get) => ({
  ready: false,
  tracks: [],
  favorites: [],
  history: [],
  playlists: [],
  playlistTracks: {},
  queue: [],
  queueContext: "library",
  contextTracks: [],
  manualQueue: [],
  automaticQueue: [],
  tasteSignals: [],
  dislikedIds: [],
  likedIds: [],
  mixTransition: null,
  mixMessage: null,
  current: null,
  playing: false,
  position: 0,
  duration: 0,
  loading: false,
  error: null,
  wave: false,
  waveResolving: false,
  waveStarting: false,
  waveMessage: null,
  waveQuery: null,
  settings: defaultSettings,
  repeat: "off",
  shuffle: false,
  offlineIds: [],
  storageBytes: 0,
  initialize: async () => {
    if (initializing) return initializing;
    initializing = (async () => {
      playbackController.bind({
        time: (position, duration) => {
          set({ position, ...(duration > 0 ? { duration } : {}) });
          if (Date.now() - lastPositionSave > 5000) {
            lastPositionSave = Date.now();
            savePlayback();
          }
        },
        playing: (playing) => {
          set({ playing });
          const current = get().current;
          if (playing && current) {
            loadedId = current.id;
            void commitPlayback(current, playbackSession);
          }
        },
        waiting: (loading) => set({ loading }),
        ended: () => {
          endedId = get().current?.id ?? null;
          if (get().waveStarting) return;
          void advance(false);
        },
        error: (message) => {
          set({ error: message, loading: false, playing: false });
          if (get().waveStarting) return;
          if (get().current?.playback?.kind === "youtube") return;
          if (advancingAfterError || !get().queue.length || failures >= 3)
            return;
          advancingAfterError = true;
          failures++;
          void advance(false).finally(() => {
            advancingAfterError = false;
          });
        },
        mixStatus: (mixMessage) => set({ mixMessage }),
        transition: (event) => {
          if (event.phase === "started") void recordPlay(event.to);
          if (event.phase === "started" || event.phase === "progress")
            set({
              mixTransition: {
                from: event.from,
                to: event.to,
                progress: event.progress,
                duration: event.duration,
              },
            });
          if (event.phase === "committed") {
            const state = get();
            if (state.current) previousTracks.push(state.current);
            ++playRevision;
            ++playbackSession;
            manuallySelectedSession = false;
            endedId = null;
            loadedId = event.to.id;
            listenedTotals.delete(event.to.id);
            set({
              ...remainingQueues(
                state.queue.filter((track) => !areSameTrack(track, event.to)),
                state,
              ),
              current: event.to,
              position: event.position,
              duration: event.to.duration,
              loading: false,
              playing: true,
              mixTransition: {
                from: event.from,
                to: event.to,
                progress: event.progress,
                duration: event.duration,
              },
            });
            recordedSession = playbackSession;
            failures = 0;
            void reserveWaveTrack(event.to);
            savePlayback();
          }
          if (event.phase === "completed" || event.phase === "cancelled") {
            set({ mixTransition: null });
            savePlayback();
            void prepareNext();
            scheduleWaveFill();
          }
        },
        listened: (sample) => {
          const key = sample.track.id;
          const previous = listenedTotals.get(key) ?? 0;
          listenedTotals.set(key, sample.playedSeconds);
          if (sample.playedSeconds <= previous) return;
          const entry = get().history.find((item) => item.track.id === key);
          if (!entry) return;
          const completed =
            sample.duration > 0 &&
            sample.playedSeconds >= sample.duration * 0.7;
          const history = get().history.map((item) =>
            item === entry
              ? { ...item, playedSeconds: sample.playedSeconds, completed }
              : item,
          );
          set({ history });
          if (
            entry.id &&
            Math.floor(previous / 5) !== Math.floor(sample.playedSeconds / 5)
          )
            void persist(() =>
              db.history.update(entry.id!, {
                playedSeconds: sample.playedSeconds,
                completed,
              }),
            );
          const loadKey = `${key}:${entry.playedAt}`;
          if (completed && !completedLoads.has(loadKey)) {
            completedLoads.add(loadKey);
            void signalFor(sample.track, "listen", sample.playedSeconds);
          }
        },
      });
      try {
        await importLegacyProfile(db);
        await db.open();
        const [
          favorites,
          history,
          playlists,
          entries,
          queue,
          settings,
          playback,
          offline,
          seen,
          taste,
        ] = await Promise.all([
          db.favorites.orderBy("addedAt").reverse().toArray(),
          db.history.orderBy("playedAt").reverse().limit(1000).toArray(),
          db.playlists.orderBy("createdAt").toArray(),
          db.playlistTracks.toArray(),
          db.queue.orderBy("position").toArray(),
          db.settings
            .get(preferenceKey("settings"))
            .then((value) => value ?? db.settings.get("settings")),
          db.settings
            .get(preferenceKey("playback"))
            .then((value) => value ?? db.settings.get("playback")),
          db.offlineTracks.toArray(),
          db.waveHistory.toArray(),
          db.tasteSignals
            .orderBy("at")
            .reverse()
            .filter((entry) => entry.profileId === profileId())
            .limit(5000)
            .toArray(),
        ]);
        const playlistTracks: Record<string, Track[]> = {};
        for (const p of playlists)
          playlistTracks[p.id] = entries
            .filter((e) => e.playlistId === p.id)
            .sort((a, b) => a.addedAt - b.addedAt)
            .map((e) => trustedTrack(e.track));
        const saved = playback?.value as
          | {
              current?: Track;
              position?: number;
              wave?: boolean;
              waveQuery?: string;
              repeat?: RepeatMode;
              shuffle?: boolean;
              previousTracks?: Track[];
              queueContext?: PlaybackContext;
              contextTracks?: Track[];
            }
          | undefined;
        const restoreCandidates = [
          ...favorites.map((entry) => entry.track),
          ...history.map((entry) => entry.track),
          ...entries.map((entry) => entry.track),
          ...queue.map((entry) => entry.track),
          ...offline.map((entry) => entry.track),
          ...(saved?.current ? [saved.current] : []),
          ...(saved?.previousTracks ?? []),
          ...(saved?.contextTracks ?? []),
          ...seen.map((entry) => entry.track),
        ].map(trustedTrack);
        const restoredTracks = await hydrateTracksCuePoints([
          ...new Map(
            restoreCandidates.map((track) => [track.id, track]),
          ).values(),
        ]);
        const restoredById = new Map(
          restoredTracks.map((track) => [track.id, track]),
        );
        const restoreTrack = (track: Track) =>
          restoredById.get(track.id) ?? trustedTrack(track);
        for (const id of Object.keys(playlistTracks))
          playlistTracks[id] = playlistTracks[id].map(restoreTrack);
        waveSeen = seen.map((e) => restoreTrack(e.track));
        previousTracks = (saved?.previousTracks ?? []).map(restoreTrack);
        const restoredSettings = normalizeSettings(settings?.value);
        playbackController.configureMix(restoredSettings.waveMix);
        configureMusicSources(restoredSettings.sources);
        set({
          favorites: favorites.map((f) => restoreTrack(f.track)),
          history: history.map((entry) => ({
            ...entry,
            track: restoreTrack(entry.track),
          })),
          playlists,
          playlistTracks,
          ...queues(
            queue
              .filter((row) => row.kind !== "automatic")
              .map((row) => restoreTrack(row.track)),
            queue
              .filter((row) => row.kind === "automatic")
              .map((row) => restoreTrack(row.track)),
          ),
          settings: restoredSettings,
          tasteSignals: taste,
          ...activeFeedback(taste),
          current: saved?.current ? restoreTrack(saved.current) : null,
          position: saved?.position ?? 0,
          duration: saved?.current?.duration ?? 0,
          wave: saved?.wave ?? false,
          waveQuery: saved?.waveQuery ?? null,
          repeat: saved?.repeat ?? "off",
          shuffle: saved?.shuffle ?? false,
          queueContext: saved?.queueContext ?? (saved?.wave ? "wave" : "library"),
          contextTracks: (saved?.contextTracks ?? []).map(restoreTrack),
          tracks: offline.map((o) => restoreTrack(o.track)),
          offlineIds: offline.map((o) => o.id),
          storageBytes: offline.reduce((sum, o) => sum + o.bytes, 0),
        });
      } catch {
        storageAvailable = false;
        warnStorage();
      }
      bindMediaSession();
      if (typeof window !== "undefined")
        window.addEventListener("pagehide", savePlayback);
      set({ ready: true });
    })();
    return initializing;
  },
  play: async (requested, list, context) => {
    await get().initialize();
    const track = trustedTrack(requested);
    if (!canPlayTrack(track)) {
      set({
        error: "Воспроизведение этой записи пока не разрешено источником.",
      });
      return;
    }
    await markSkipped();
    if (get().current && !areSameTrack(get().current!, track))
      previousTracks.push(get().current!);
    failures = 0;
    if (!context && get().settings.smartWaveEnabled) {
      await get().startWave(track);
      return;
    }
    cancelWaveRequest();
    // Preserve the selected collection’s original order, even when Play is
    // pressed on a middle track. Add the selected track only if not in it.
    const collection = distinct((list ?? []).filter(canPlayTrack));
    const order = collection.some((item) => areSameTrack(item, track))
      ? collection : [track, ...collection];
    previousTracks = [];
    set({
      ...queues(contextQueue(track, order, get().shuffle), []),
      queueContext: context ?? "library",
      contextTracks: order,
      wave: false,
      waveMessage: null,
    });
    await begin(track);
  },
  playQueued: async (id) => {
    const state = get(),
      index = state.queue.findIndex((track) => track.id === id);
    if (index < 0) return;
    const selected = state.queue[index];
    const consumed = state.queue.slice(0, index + 1);
    cancelWaveRequest();
    const revision = playRevision;
    await markSkipped();
    if (revision !== playRevision) return;
    const latest = get();
    if (isDislikedTrack(selected, latest)) return;
    if (latest.current) previousTracks.push(latest.current);
    set({
      ...remainingQueues(
        latest.queue.filter(
          (track) => !consumed.some((other) => areSameTrack(track, other)),
        ),
        latest,
      ),
      waveMessage: null,
    });
    failures = 0;
    await begin(selected);
    savePlayback();
  },
  togglePlay: async () => {
    const s = get();
    if (s.loading || s.playing) {
      pausePlayback();
      return;
    }
    const current = s.current;
    if (!current) return;
    if (
      s.wave &&
      (endedId === current.id ||
        (s.duration > 0 && s.position >= s.duration - 0.2))
    ) {
      await advance(false);
      return;
    }
    if (loadedId !== current.id) {
      await begin(current, s.position);
      return;
    }
    try {
      await playbackController.resume();
    } catch {
      set({
        error: "Нажмите Play ещё раз или выберите другую композицию.",
        loading: false,
      });
    }
  },
  pause: pausePlayback,
  clearPlayback: () => {
    ++playRevision;
    ++playbackSession;
    playbackRequest?.abort();
    cancelWaveRequest();
    loadedId = null;
    endedId = null;
    previousTracks = [];
    playbackController.stop();
    invalidatePreparation();
    set({
      current: null,
      ...queues([], []),
      mixTransition: null,
      wave: false,
      queueContext: "library",
      contextTracks: [],
      waveResolving: false,
      waveStarting: false,
      waveMessage: null,
      playing: false,
      loading: false,
      position: 0,
      duration: 0,
    });
    savePlayback();
  },
  next: async () => {
    if (get().waveStarting) cancelWaveRequest();
    const revision = playRevision;
    failures = 0;
    await markSkipped();
    if (revision === playRevision) await advance(true);
  },
  previous: async () => {
    if (get().waveStarting) cancelWaveRequest();
    if (get().position > 3) {
      get().seek(0);
      return;
    }
    const prior = previousTracks.pop();
    if (!prior) {
      get().seek(0);
      return;
    }
    if (get().current)
      set(queues([get().current!, ...get().manualQueue], get().automaticQueue));
    await begin(prior);
  },
  seek: (seconds) => {
    const position = Math.max(0, Math.min(seconds, get().duration));
    set({ position });
    playbackController.seek(position);
    savePlayback();
  },
  setVolume: (volume) => {
    const safe = Math.max(0, Math.min(1, volume));
    playbackController.volume(safe);
    get().updateSettings({ volume: safe });
  },
  setRepeat: (repeat) => {
    set({ repeat });
    savePlayback();
  },
  toggleShuffle: () => {
    const next = !get().shuffle;
    const state = get();
    if (state.queueContext !== "wave" && state.current) {
      const order = next
        ? contextQueue(state.current, [state.current, ...state.queue], true)
        : contextQueue(state.current, state.contextTracks, false);
      set({ shuffle: next, ...queues(order, []) });
    } else set({ shuffle: next });
    savePlayback();
  },
  toggleFavorite: async (track) => {
    const exists = get().favorites.some((f) => f.id === track.id);
    set({
      favorites: exists
        ? get().favorites.filter((f) => f.id !== track.id)
        : [track, ...get().favorites],
    });
    if (exists) await removeSignals(track, "favorite");
    else await signalFor(track, "favorite");
    await persist(() =>
      exists
        ? db.favorites.delete(track.id)
        : db.favorites.put({ id: track.id, track, addedAt: Date.now() }),
    );
  },
  createPlaylist: async (name) => {
    const clean = name.trim().slice(0, 80);
    if (!clean) throw new Error("Введите название плейлиста.");
    const playlist = {
      id: crypto.randomUUID(),
      name: clean,
      createdAt: Date.now(),
    };
    set({
      playlists: [...get().playlists, playlist],
      playlistTracks: { ...get().playlistTracks, [playlist.id]: [] },
    });
    await persist(() => db.playlists.add(playlist));
    return playlist.id;
  },
  deletePlaylist: async (id) => {
    const playlistTracks = { ...get().playlistTracks };
    delete playlistTracks[id];
    set({
      playlists: get().playlists.filter((p) => p.id !== id),
      playlistTracks,
    });
    await persist(() =>
      db.transaction("rw", db.playlists, db.playlistTracks, async () => {
        await db.playlists.delete(id);
        await db.playlistTracks.where("playlistId").equals(id).delete();
      }),
    );
  },
  addToPlaylist: async (id, track) => {
    if (!get().playlists.some((p) => p.id === id)) return;
    const existing = get().playlistTracks[id] ?? [];
    if (existing.some((t) => t.id === track.id)) return;
    set({
      playlistTracks: { ...get().playlistTracks, [id]: [...existing, track] },
    });
    await persist(() =>
      db.playlistTracks.put({
        playlistId: id,
        trackId: track.id,
        track,
        addedAt: Date.now(),
      }),
    );
  },
  removeFromPlaylist: async (id, trackId) => {
    set({
      playlistTracks: {
        ...get().playlistTracks,
        [id]: (get().playlistTracks[id] ?? []).filter((t) => t.id !== trackId),
      },
    });
    await persist(() => db.playlistTracks.delete([id, trackId]));
  },
  removeFromQueue: (id) => {
    const state = get();
    set(
      queues(
        state.manualQueue.filter((track) => track.id !== id),
        state.automaticQueue.filter((track) => track.id !== id),
      ),
    );
    savePlayback();
    void prepareNext();
    scheduleWaveFill();
  },
  enqueue: (track) => {
    const state = get();
    if (
      !canPlayTrack(trustedTrack(track)) ||
      (state.current && areSameTrack(state.current, track))
    )
      return;
    const next = enqueueManual(
      { manual: state.manualQueue, automatic: state.automaticQueue },
      trustedTrack(track),
    );
    set(queues(next.manual, next.automatic));
    savePlayback();
    void prepareNext();
  },
  startNewWave: async () => {
    await get().initialize();
    cancelWaveRequest();
    const revision = waveStartRevision;
    const state = get();
    const current = state.current;
    const acceptable = (track: Track, snapshot: MusicState) =>
      (!snapshot.current || !areSameTrack(track, snapshot.current)) &&
      !snapshot.manualQueue.some((manual) => areSameTrack(manual, track)) &&
      !isDislikedTrack(track, snapshot) &&
      canUseWaveSeed(track, snapshot);
    const freshContext = {
      ...waveContext(state, true),
      query: undefined,
      limit: 1,
    };
    const prepared = state.automaticQueue.filter((track) =>
      acceptable(track, state),
    );
    const fallback = prepared[0];
    const preparedProfile =
      freshContext.explorationDue && prepared.length
        ? prepareWaveRanking(freshContext).profile
        : undefined;
    let next = freshContext.explorationDue
      ? prepared.find((track) =>
          isNewWaveArtist(
            track,
            freshContext,
            current ?? undefined,
            preparedProfile,
          ),
        )
      : fallback;
    let request: AbortController | undefined;
    set({ wave: true, waveQuery: null, waveStarting: true, waveMessage: null });
    try {
      if (!next) {
        request = new AbortController();
        waveRequest = request;
        set({ waveResolving: true });
        const context = freshContext;
        if (current) {
          const first = await refillWave(current, context, request.signal, {
            initialOnly: true,
            batchSize: 1,
          }).catch((error: unknown) => {
            if (fallback && !request?.signal.aborted) return [fallback];
            throw error;
          });
          next = first.find((track) => acceptable(track, get()));
        } else {
          next =
            chooseWaveSeed(
              [
                ...state.favorites,
                ...state.history
                  .filter((entry) => !entry.skipped)
                  .map((entry) => entry.track),
                ...state.tracks,
              ].filter((track) => acceptable(track, state)),
              context,
            ) ?? undefined;
        }
        if (!next && !request.signal.aborted)
          next =
            (await discoverWaveSeed("", request.signal, context)) ?? undefined;
        next ??= fallback;
        if (request.signal.aborted || revision !== waveStartRevision) return;
      }
      const latest = get();
      if (revision !== waveStartRevision) return;
      if (!next || !acceptable(next, latest)) {
        set({
          waveMessage:
            "Пока нет новой доступной песни для Волны. Попробуйте изменить настройки подбора.",
        });
        return;
      }
      if (
        freshContext.explorationDue &&
        isNewWaveArtist(
          next,
          freshContext,
          current ?? undefined,
          preparedProfile,
        )
      )
        next = {
          ...next,
          metadata: {
            ...next.metadata,
            recommendationReason: "discovery",
            recommendationArtistDiscovery: "true",
          },
        };
      if (waveRequest === request) waveRequest = null;
      set({
        ...queues(
          latest.manualQueue,
          latest.automaticQueue.filter(
            (track) =>
              !areSameTrack(track, next!) &&
              (!current || !areSameTrack(track, current)),
          ),
        ),
        wave: true,
        waveResolving: false,
        waveMessage: null,
      });
      if (latest.current) previousTracks.push(latest.current);
      failures = 0;
      await begin(trustedTrack(next), 0, false);
      savePlayback();
    } catch (error) {
      if (revision === waveStartRevision && !request?.signal.aborted)
        set({
          waveMessage:
            error instanceof Error
              ? error.message
              : "Не удалось подобрать новую песню.",
        });
    } finally {
      if (revision === waveStartRevision) {
        if (waveRequest === request) waveRequest = null;
        set({ waveStarting: false, waveResolving: false });
        scheduleWaveFill();
      }
    }
  },
  startWave: async (requestedTrack, query) => {
    await get().initialize();
    failures = 0;
    cancelWaveRequest();
    const revision = waveStartRevision;
    const state = get();
    const requestedQuery = query?.trim().slice(0, 300);
    const context = waveContext(state, true);
    context.excluded = state.manualQueue;
    let track = requestedQuery
      ? undefined
      : requestedTrack && canUseWaveSeed(requestedTrack, state)
        ? requestedTrack
        : state.current &&
            !isDislikedTrack(state.current, state) &&
            canUseWaveSeed(state.current, state)
          ? state.current
          : (chooseWaveSeed(
              [
                ...state.favorites,
                ...state.history
                  .filter((entry) => !entry.skipped)
                  .map((entry) => entry.track),
                ...state.tracks,
              ].filter(
                (item) =>
                  canUseWaveSeed(item, state) && !isDislikedTrack(item, state),
              ),
              context,
            ) ?? undefined);
    const waveQuery = requestedQuery || null;
    if (!track) {
      const request = new AbortController();
      waveRequest = request;
      set({
        wave: false,
        waveQuery,
        waveResolving: true,
        waveStarting: true,
        waveMessage: "Подбираем первую композицию…",
      });
      try {
        track =
          (await discoverWaveSeed(
            requestedQuery || "",
            request.signal,
            context,
          )) ?? undefined;
      } catch (error) {
        if (!request.signal.aborted)
          set({
            waveMessage:
              error instanceof Error ? error.message : "Источник недоступен.",
          });
        return;
      } finally {
        if (waveRequest === request) {
          waveRequest = null;
          set({ waveResolving: false, waveStarting: false });
        }
      }
      if (request.signal.aborted || waveStartRevision !== revision) return;
      if (!track) {
        set({
          waveMessage: context.offline
            ? "Для Волны без интернета добавьте аудиофайлы в Мою музыку. Сейчас нет сохранённых треков для этих настроек."
            : "В доступном каталоге пока нет музыки для этого направления. Добавьте свои аудиофайлы или выберите другую песню.",
        });
        return;
      }
    }
    if (waveStartRevision !== revision) return;
    track = trustedTrack(track);
    const latest = get(),
      continuing = !!latest.current && areSameTrack(latest.current, track);
    set({
      ...queues(
        latest.manualQueue.filter((item) => !areSameTrack(item, track)),
        [],
      ),
      queueContext: "wave",
      contextTracks: [],
      wave: true,
      waveQuery,
      waveMessage: null,
    });
    if (
      continuing &&
      (latest.playing || (loadedId === track.id && endedId !== track.id))
    ) {
      scheduleWaveFill();
      savePlayback();
      if (!latest.playing) await get().togglePlay();
      return;
    }
    const playback = begin(
      track,
      continuing ? latest.position : 0,
      !!requestedTrack,
    );
    savePlayback();
    await playback;
  },
  stopWave: () => {
    cancelWaveRequest();
    set({ ...queues(get().manualQueue, []), wave: false, queueContext: "library", waveMessage: null });
    savePlayback();
    void prepareNext();
  },
  toggleLike: async (track) => {
    if (get().likedIds.includes(track.id)) await removeSignals(track, "like");
    else {
      await removeSignals(track, "dislike");
      await signalFor(track, "like");
    }
  },
  dislike: async (track) => {
    if (get().dislikedIds.includes(track.id)) {
      await removeSignals(track, "dislike");
      return;
    }
    await signalFor(track, "dislike");
    await removeSignals(track, "like");
    const state = get();
    set(
      queues(
        state.manualQueue.filter((item) => !areSameTrack(item, track)),
        state.automaticQueue.filter((item) => !areSameTrack(item, track)),
      ),
    );
    if (state.current && areSameTrack(state.current, track)) await get().next();
    else scheduleWaveFill();
  },
  resetTaste: async () => {
    await persist(() =>
      db.tasteSignals.where("profileId").equals(profileId()).delete(),
    );
    set({
      tasteSignals: [],
      dislikedIds: [],
      likedIds: [],
      waveMessage: "Предпочтения сброшены. Избранное сохранено.",
    });
    adaptWaveRecommendations();
  },
  resetWave: async () => {
    cancelWaveRequest();
    waveSeen = [];
    await persist(() => db.waveHistory.clear());
    set({ waveMessage: "История Волны сброшена." });
    if (get().wave && get().current) {
      waveSeen.push(get().current!);
      await persist(() =>
        db.waveHistory.put({
          key: trackKey(get().current!),
          track: get().current!,
          playedAt: Date.now(),
        }),
      );
      scheduleWaveFill();
    }
  },
  updateSettings: (settings) => {
    const previous = get().settings;
    const next = normalizeSettings({
      ...previous,
      ...settings,
      waveMix: { ...previous.waveMix, ...settings.waveMix },
      signalWeights: { ...previous.signalWeights, ...settings.signalWeights },
      wavePreferences: {
        ...previous.wavePreferences,
        ...settings.wavePreferences,
      },
      sources: { ...previous.sources, ...settings.sources },
      ...(settings.diversity !== undefined &&
      settings.discoveryIntensity === undefined
        ? { discoveryIntensity: settings.diversity }
        : {}),
    });
    set({ settings: next });
    configureMusicSources(next.sources);
    awaitSettings(next);
    playbackController.configureMix(next.waveMix);
    if (get().current && Object.entries(settings.sources ?? {}).some(([source, enabled]) => enabled === false && get().current?.sourceId === source))
      get().clearPlayback();
    if (next.dataSaver) playbackController.prepare(null);
    else void prepareNext();
    if (
      settings.discoveryIntensity !== undefined ||
      settings.diversity !== undefined ||
      settings.wavePreferences !== undefined ||
      settings.signalWeights !== undefined
    ) {
      if (get().wave && get().waveStarting) {
        cancelWaveRequest();
        void get().startNewWave();
      } else if (get().wave) {
        adaptWaveRecommendations();
      } else if (get().waveResolving) {
        const query = get().waveQuery ?? undefined;
        cancelWaveRequest();
        void get().startWave(undefined, query);
      }
    }
    if (settings.smartWaveEnabled === false) get().stopWave();
  },
  importFiles: async (files) => {
    for (const file of files) {
      if (
        !/\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(file.name) &&
        !file.type.startsWith("audio/")
      ) {
        set({ error: "Выберите аудиофайл: MP3, WAV, OGG, M4A, FLAC или AAC." });
        continue;
      }
      if (!file.size || get().storageBytes + file.size > MAX_OFFLINE_BYTES) {
        set({
          error:
            "Лимит локальных аудиофайлов — 250 МБ. Освободите место в настройках.",
        });
        continue;
      }
      const filename = file.name.replace(/\.[^.]+$/, "");
      const parts = filename.split(" - ");
      const duration = await readDuration(file);
      const track: Track = {
        id: `local:${crypto.randomUUID()}`,
        sourceId: "local",
        title: parts.length > 1 ? parts.slice(1).join(" - ") : filename,
        artist: parts.length > 1 ? parts[0] : "Мой файл",
        duration,
        genres: ["local"],
        local: true,
        playbackMode: "audio",
        rights: {
          status: "confirmed",
          basis: "personal_upload",
          allowMix: true,
        },
        license: { name: "Личный файл пользователя", download: true },
      };
      const record: OfflineRecord = {
        id: track.id,
        track,
        blob: file,
        bytes: file.size,
        addedAt: Date.now(),
      };
      try {
        await commitOffline(record, false);
      } catch (error) {
        set({ error: (error as Error).message });
      }
    }
  },
  downloadTrack: async (track) => {
    if (get().offlineIds.includes(track.id) || offlineDownloads.has(track.id))
      return;
    offlineDownloads.add(track.id);
    try {
      const adapter = adapters.find((a) => a.id === track.sourceId);
      if (
        !adapter ||
        !track.license.download ||
        !(await adapter.supportsDownload(track))
      )
        throw new Error("Источник не разрешает сохранять эту запись офлайн.");
      const url = await resolveStream(track);
      if (!url) throw new Error("Аудиофайл сейчас недоступен.");
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error("Не удалось сохранить аудио.");
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length + get().storageBytes > MAX_OFFLINE_BYTES)
        throw new Error("Недостаточно места: лимит офлайн-хранилища — 250 МБ.");
      const blob = await response.blob();
      if (blob.size + get().storageBytes > MAX_OFFLINE_BYTES)
        throw new Error("Недостаточно места: лимит офлайн-хранилища — 250 МБ.");
      const record = {
        id: track.id,
        track,
        blob,
        bytes: blob.size,
        addedAt: Date.now(),
      };
      await commitOffline(record, true);
    } catch (error) {
      set({ error: (error as Error).message });
    } finally {
      offlineDownloads.delete(track.id);
    }
  },
  removeOffline: async (id) => {
    const record = await localRecord(id);
    offlineMemory.delete(id);
    await persist(() => db.offlineTracks.delete(id));
    set({
      offlineIds: get().offlineIds.filter((i) => i !== id),
      tracks: get().tracks.filter((t) => t.id !== id),
      storageBytes: Math.max(0, get().storageBytes - (record?.bytes ?? 0)),
    });
  },
  clearHistory: async () => {
    set({ history: [] });
    await persist(() => db.history.clear());
  },
  exportLibrary: async () => {
    const s = get();
    return JSON.stringify(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        favorites: s.favorites,
        playlists: s.playlists,
        playlistTracks: s.playlistTracks,
      },
      null,
      2,
    );
  },
  importLibrary: async (json) => {
    try {
      if (json.length > 5_000_000)
        throw new Error("Файл библиотеки слишком большой (максимум 5 МБ).");
      const data = JSON.parse(json) as {
        version?: unknown;
        favorites?: unknown;
        playlists?: unknown;
        playlistTracks?: unknown;
      };
      if (
        data.version !== 1 ||
        !Array.isArray(data.favorites) ||
        !Array.isArray(data.playlists) ||
        !data.playlistTracks ||
        typeof data.playlistTracks !== "object"
      )
        throw new Error("Неподдерживаемый формат библиотеки.");
      if (data.favorites.length > 10000 || data.playlists.length > 500)
        throw new Error("В библиотеке слишком много записей.");
      const hydrate = (value: unknown) => {
        const safe = sanitizeImportedTrack(value);
        return (
          catalog.find(
            (t) => t.id === safe.id && t.sourceId === safe.sourceId,
          ) ?? safe
        );
      };
      const favorites = distinct([
        ...get().favorites,
        ...data.favorites
          .filter((value) => !isRetiredTrack(value))
          .map(hydrate),
      ]);
      const playlists = [...get().playlists];
      const playlistTracks = { ...get().playlistTracks };
      for (const value of data.playlists as unknown[]) {
        if (
          !value ||
          typeof value !== "object" ||
          typeof (value as Playlist).id !== "string" ||
          typeof (value as Playlist).name !== "string"
        )
          throw new Error("Некорректный плейлист.");
        const p = value as Playlist;
        const id = crypto.randomUUID();
        const entries = (data.playlistTracks as Record<string, unknown>)[p.id];
        if (!Array.isArray(entries) || entries.length > 10000)
          throw new Error("Некорректное содержимое плейлиста.");
        playlists.push({
          id,
          name: p.name.slice(0, 80),
          createdAt: Date.now(),
        });
        playlistTracks[id] = distinct(
          entries.filter((value) => !isRetiredTrack(value)).map(hydrate),
        );
      }
      // Persist the complete valid import atomically before exposing it in the interface.
      if (!storageAvailable)
        throw new Error("Импорт требует доступного локального хранилища.");
      await db.transaction(
        "rw",
        db.favorites,
        db.playlists,
        db.playlistTracks,
        async () => {
          await db.favorites.bulkPut(
            favorites.map((track) => ({
              id: track.id,
              track,
              addedAt: Date.now(),
            })),
          );
          await db.playlists.bulkPut(playlists);
          await db.playlistTracks.bulkPut(
            playlists.flatMap((p) =>
              (playlistTracks[p.id] ?? []).map((track) => ({
                playlistId: p.id,
                trackId: track.id,
                track,
                addedAt: Date.now(),
              })),
            ),
          );
        },
      );
      set({ favorites, playlists, playlistTracks });
    } catch (error) {
      set({
        error:
          (error as Error).message || "Не удалось импортировать библиотеку.",
      });
    }
  },
  dismissError: () => set({ error: null }),
}));

function awaitSettings(settings: Settings) {
  void persist(() =>
    db.settings.put({ key: preferenceKey("settings"), value: settings }),
  );
}
function isRetiredTrack(value: unknown) {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { sourceId?: string }).sourceId === "audius"
  );
}
async function advance(manual: boolean) {
  let s = useMusicStore.getState();
  if (!s.current) return;
  const revision = playRevision;
  if (!manual && s.repeat === "one" && !s.wave) {
    playbackController.seek(0);
    try {
      await playbackController.resume();
    } catch {
      useMusicStore.setState({ error: "Для продолжения нажмите Play." });
    }
    return;
  }
  if (s.wave && !s.queue.length) {
    await fillWave();
    if (revision !== playRevision) return;
    s = useMusicStore.getState();
  }
  let queue = [...s.queue];
  const next = queue.shift();
  if (!next) {
    if (s.repeat === "all" && !s.wave) {
      const loop = distinct(s.contextTracks.length
        ? s.contextTracks.filter(canPlayTrack)
        : [...previousTracks, ...(s.current ? [s.current] : [])]);
      const first = s.shuffle
        ? loop.splice(Math.floor(Math.random() * loop.length), 1)[0]
        : loop.shift();
      previousTracks = [];
      if (first) {
        useMusicStore.setState(queues(s.shuffle ? contextQueue(first, [first, ...loop], true) : loop, []));
        await begin(first, 0, false);
        return;
      }
    }
    playbackController.pause();
    useMusicStore.setState({
      playing: false,
      loading: false,
      ...(s.wave
        ? {
            waveMessage:
              "Волна завершена: новых доступных треков нет. Повторы исключены.",
          }
        : {}),
    });
    savePlayback();
    return;
  }
  if (s.current) previousTracks.push(s.current);
  useMusicStore.setState(remainingQueues(queue, s));
  await begin(next, 0, false);
}
function bindMediaSession() {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator))
    return;
  const actions: Partial<
    Record<MediaSessionAction, MediaSessionActionHandler>
  > = {
    play: () => {
      if (!useMusicStore.getState().playing)
        void useMusicStore.getState().togglePlay();
    },
    pause: pausePlayback,
    nexttrack: () => {
      void useMusicStore.getState().next();
    },
    previoustrack: () => {
      void useMusicStore.getState().previous();
    },
    seekto: (e) => {
      if (e.seekTime !== undefined) useMusicStore.getState().seek(e.seekTime);
    },
    seekforward: (e) =>
      useMusicStore
        .getState()
        .seek(useMusicStore.getState().position + (e.seekOffset ?? 10)),
    seekbackward: (e) =>
      useMusicStore
        .getState()
        .seek(useMusicStore.getState().position - (e.seekOffset ?? 10)),
  };
  for (const [action, handler] of Object.entries(actions)) {
    try {
      navigator.mediaSession.setActionHandler(
        action as MediaSessionAction,
        handler!,
      );
    } catch {
      /* Optional platform action. */
    }
  }
}
async function readDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const audio = new Audio();
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (duration: number) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
      resolve(duration);
    };
    const timeout = setTimeout(() => finish(0), 5000);
    audio.addEventListener(
      "loadedmetadata",
      () => finish(Number.isFinite(audio.duration) ? audio.duration : 0),
      { once: true },
    );
    audio.addEventListener("error", () => finish(0), { once: true });
    audio.preload = "metadata";
    audio.src = url;
  });
}
