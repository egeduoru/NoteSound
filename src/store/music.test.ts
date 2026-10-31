import "fake-indexeddb/auto";
import Dexie from "dexie";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AudioEvents } from "../services/audio/controller";
import { defaultSettings, type Track, type Settings } from "../types/music";

const mock = vi.hoisted(() => ({
  events: null as AudioEvents | null,
  load: vi.fn(async () => undefined),
  resume: vi.fn(async () => undefined),
  pause: vi.fn(),
  seek: vi.fn(),
  stop: vi.fn(),
  volume: vi.fn(),
  prepare: vi.fn(),
  configureMix: vi.fn(),
  refill: vi.fn(async () => [] as Track[]),
  discover: vi.fn(async () => null as Track | null),
  videoEvents: null as AudioEvents | null,
  videoLoad: vi.fn(async () => undefined),
}));
vi.mock("../services/audio/controller", () => ({
  audioController: {
    bind: (events: AudioEvents) => {
      mock.events = events;
    },
    load: mock.load,
    resume: mock.resume,
    pause: mock.pause,
    seek: mock.seek,
    stop: mock.stop,
    volume: mock.volume,
    prepare: mock.prepare,
    configureMix: mock.configureMix,
  },
}));
vi.mock("../adapters/music", () => ({
  adapters: [{ id: "notesound", supportsDownload: async () => true }],
  legacyYouTubeEnabled: false,
  configureMusicSources: vi.fn(),
  canPlayTrack: (track: Track) =>
    !track.playback &&
    track.playbackMode !== "metadata" &&
    track.rights?.status === "confirmed" &&
    track.availability !== "unavailable",
  resolveStream: vi.fn(async () => "/track.wav"),
}));
vi.mock("../services/telegram", () => ({ telegram: () => undefined }));
vi.mock("../features/wave/engine", () => ({
  refillWave: mock.refill,
  discoverWaveSeed: mock.discover,
  chooseWaveSeed: (tracks: Track[]) => tracks[0] ?? null,
}));
vi.mock("../services/youtube/controller", () => ({
  youtubeController: {
    bind: (events: AudioEvents) => (mock.videoEvents = events),
    load: mock.videoLoad,
    resume: vi.fn(async () => undefined),
    pause: vi.fn(),
    stop: vi.fn(),
    seek: vi.fn(),
    volume: vi.fn(),
  },
}));
import { useMusicStore } from "./music";
import { db } from "../services/storage/db";

const one: Track = {
  id: "notesound:one",
  sourceId: "notesound",
  title: "One",
  artist: "First",
  duration: 48,
  genres: ["ambient"],
  license: { name: "CC0", download: true },
  playbackMode: "audio",
  rights: { status: "confirmed", basis: "cc0", allowMix: true },
  availability: "available",
};
const two: Track = {
  ...one,
  id: "notesound:two",
  title: "Two",
  artist: "Second",
};
const three: Track = {
  ...one,
  id: "notesound:three",
  title: "Three",
  artist: "Third",
};
beforeAll(async () => {
  await db.delete();
  await useMusicStore.getState().initialize();
});
beforeEach(async () => {
  useMusicStore.getState().clearPlayback();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await Promise.all([
    db.favorites.clear(),
    db.playlists.clear(),
    db.playlistTracks.clear(),
    db.history.clear(),
    db.waveHistory.clear(),
    db.offlineTracks.clear(),
    db.tasteSignals.clear(),
    db.trackCuePoints.clear(),
    db.queue.clear(),
    db.settings.clear(),
  ]);
  useMusicStore.setState({
    current: null,
    queue: [],
    manualQueue: [],
    automaticQueue: [],
    tasteSignals: [],
    likedIds: [],
    dislikedIds: [],
    mixTransition: null,
    mixMessage: null,
    settings: structuredClone(defaultSettings),
    loading: false,
    duration: 0,
    favorites: [],
    playlists: [],
    playlistTracks: {},
    history: [],
    position: 0,
    playing: false,
    repeat: "off",
    wave: false,
    waveStarting: false,
    waveQuery: null,
    error: null,
    offlineIds: [],
    storageBytes: 0,
    tracks: [],
  });
  await useMusicStore.getState().resetWave();
  mock.refill.mockReset();
  mock.refill.mockResolvedValue([]);
  mock.discover.mockReset();
  mock.discover.mockResolvedValue(null);
  mock.load.mockReset();
  mock.load.mockImplementation(async () => {
    mock.events?.playing(true);
  });
  mock.seek.mockClear();
  mock.resume.mockReset();
  mock.resume.mockImplementation(async () => {
    mock.events?.playing(true);
  });
  mock.configureMix.mockClear();
  mock.videoLoad.mockReset();
  mock.videoLoad.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await db.delete();
});

describe("player and library integration", () => {
  it("starts a prepared unfamiliar artist when exploration is due instead of another familiar song", async () => {
    useMusicStore.getState().updateSettings({ smartWaveEnabled: false });
    await useMusicStore.getState().play(one);
    const familiar = {
      ...one,
      id: "notesound:familiar-next",
      title: "Another familiar song",
    };
    const now = Date.now();
    useMusicStore.setState({
      history: [0, 1, 2].map((i) => ({ track: one, playedAt: now - i * 1000 })),
      wave: true,
      automaticQueue: [familiar, two],
      queue: [familiar, two],
    });
    mock.load.mockClear();
    mock.refill.mockClear();
    await useMusicStore.getState().startNewWave();
    expect(useMusicStore.getState().current?.id).toBe(two.id);
    expect(mock.load).toHaveBeenCalledTimes(1);
    if (mock.refill.mock.calls.length)
      expect(mock.refill.mock.invocationCallOrder[0]).toBeGreaterThan(
        mock.load.mock.invocationCallOrder[0],
      );
  });
  it("carries discovery cadence through small background refills without stopping audio", async () => {
    const now = Date.now();
    useMusicStore.setState({
      history: [0, 1].map((i) => ({
        track: one,
        playedAt: now - (i + 1) * 1000,
      })),
    });
    const introduction = {
      ...two,
      metadata: { recommendationArtistDiscovery: "true" },
    };
    const familiar = {
      ...one,
      id: "notesound:cadence-familiar",
      title: "Familiar continuation",
    };
    const later = {
      ...one,
      id: "notesound:cadence-later",
      title: "Later continuation",
    };
    const due: boolean[] = [];
    mock.refill.mockImplementation(async (...args: unknown[]) => {
      due.push((args[1] as { explorationDue: boolean }).explorationDue);
      return due.length === 1 ? [introduction, familiar] : [later];
    });
    await useMusicStore.getState().startWave(one);
    await vi.waitFor(() => expect(due.length).toBeGreaterThanOrEqual(2), {
      timeout: 3000,
    });
    useMusicStore.getState().pause();
    expect(due.slice(0, 2)).toEqual([true, false]);
    expect(useMusicStore.getState().current?.id).toBe(one.id);
    expect(mock.load).toHaveBeenCalledTimes(1);
  });
  it("keeps a prepared familiar continuation usable if the discovery metadata service fails", async () => {
    useMusicStore.getState().updateSettings({ smartWaveEnabled: false });
    await useMusicStore.getState().play(one);
    const familiar = {
      ...one,
      id: "notesound:discovery-fallback",
      title: "Prepared fallback",
    };
    const now = Date.now();
    useMusicStore.setState({
      history: [0, 1, 2].map((i) => ({ track: one, playedAt: now - i * 1000 })),
      wave: true,
      queue: [familiar],
      automaticQueue: [familiar],
    });
    mock.refill.mockRejectedValueOnce(
      new Error("Metadata service unavailable"),
    );
    await useMusicStore.getState().startNewWave();
    expect(useMusicStore.getState()).toMatchObject({
      current: familiar,
      playing: true,
      waveStarting: false,
    });
  });
  it.each([true, false])(
    "starts a different prepared Wave song when the previous playing state is %s and keeps manual choices separate",
    async (playing) => {
      useMusicStore.getState().updateSettings({ smartWaveEnabled: false });
      await useMusicStore.getState().play(one);
      if (!playing) useMusicStore.getState().pause();
      const alias = {
        ...one,
        id: "licensed:one-alias",
        sourceId: "licensed",
        title: "One (Official Audio)",
      };
      const manual = {
        ...three,
        id: "notesound:manual-fresh",
        title: "Manual later",
      };
      useMusicStore.setState({
        wave: true,
        manualQueue: [manual],
        automaticQueue: [alias, two, three],
        queue: [manual, alias, two, three],
      });
      mock.load.mockClear();
      mock.resume.mockClear();
      mock.refill.mockClear();

      await useMusicStore.getState().startNewWave();

      expect(useMusicStore.getState()).toMatchObject({
        current: two,
        position: 0,
        playing: true,
        wave: true,
        waveStarting: false,
      });
      expect(useMusicStore.getState().manualQueue).toEqual([manual]);
      expect(mock.resume).not.toHaveBeenCalled();
      if (mock.refill.mock.calls.length)
        expect(mock.refill.mock.invocationCallOrder[0]).toBeGreaterThan(
          mock.load.mock.invocationCallOrder[0],
        );
      await useMusicStore.getState().startNewWave();
      expect(useMusicStore.getState().current?.id).toBe(three.id);
      expect(useMusicStore.getState().manualQueue).toEqual([manual]);
    },
  );
  it("keeps the old audio playing while a fresh first recommendation is being found", async () => {
    useMusicStore.getState().updateSettings({ smartWaveEnabled: false });
    await useMusicStore.getState().play(one);
    let release!: (tracks: Track[]) => void;
    mock.refill.mockImplementationOnce(
      () =>
        new Promise<Track[]>((resolve) => {
          release = resolve;
        }),
    );
    mock.load.mockClear();
    mock.stop.mockClear();
    mock.pause.mockClear();
    mock.resume.mockClear();
    const pending = useMusicStore.getState().startNewWave();
    await vi.waitFor(() => expect(mock.refill).toHaveBeenCalled());
    expect(mock.refill).toHaveBeenCalledWith(
      one,
      expect.objectContaining({
        limit: 1,
        excluded: expect.arrayContaining([one]),
      }),
      expect.any(AbortSignal),
      expect.objectContaining({ initialOnly: true }),
    );
    expect(useMusicStore.getState()).toMatchObject({
      current: one,
      playing: true,
      waveStarting: true,
    });
    expect(mock.load).not.toHaveBeenCalled();
    expect(mock.stop).not.toHaveBeenCalled();
    expect(mock.pause).not.toHaveBeenCalled();
    release([two]);
    await pending;
    expect(useMusicStore.getState()).toMatchObject({
      current: two,
      playing: true,
      position: 0,
      waveStarting: false,
    });
    expect(mock.resume).not.toHaveBeenCalled();
  });
  it("does not commit a stale fresh-Wave result after another track is explicitly selected", async () => {
    useMusicStore.getState().updateSettings({ smartWaveEnabled: false });
    await useMusicStore.getState().play(one);
    let release!: (tracks: Track[]) => void;
    mock.refill.mockImplementationOnce(
      () =>
        new Promise<Track[]>((resolve) => {
          release = resolve;
        }),
    );
    const pending = useMusicStore.getState().startNewWave();
    await vi.waitFor(() => expect(mock.refill).toHaveBeenCalled());
    const request = (
      mock.refill.mock.calls as unknown[][]
    )[0]?.[2] as AbortSignal;
    await useMusicStore.getState().play(three);
    expect(request.aborted).toBe(true);
    release([two]);
    await pending;
    expect(useMusicStore.getState()).toMatchObject({
      current: three,
      waveStarting: false,
    });
  });
  it("does not retrieve the following queue before the first audio actually starts", async () => {
    let finishLoad!: () => void;
    mock.load.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishLoad = () => resolve(undefined);
        }),
    );
    const starting = useMusicStore.getState().startWave(one);
    await vi.waitFor(() => expect(mock.load).toHaveBeenCalled());
    expect(useMusicStore.getState().playing).toBe(false);
    expect(mock.refill).not.toHaveBeenCalled();
    mock.events?.playing(true);
    finishLoad();
    await starting;
    await vi.waitFor(() => expect(mock.refill).toHaveBeenCalled());
    expect(useMusicStore.getState().playing).toBe(true);
    expect(mock.refill).toHaveBeenCalledWith(
      one,
      expect.objectContaining({ limit: 2 }),
      expect.any(AbortSignal),
      expect.any(Object),
    );
  });
  it("publishes an early ready recommendation while later background selectors are still pending", async () => {
    let finish!: () => void;
    mock.refill.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[3] as { onBatch?: (tracks: Track[]) => void };
      options.onBatch?.([two]);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return [two, three];
    });
    await useMusicStore.getState().startWave(one);
    await vi.waitFor(() =>
      expect(useMusicStore.getState().automaticQueue[0]?.id).toBe(two.id),
    );
    expect(useMusicStore.getState()).toMatchObject({
      current: one,
      playing: true,
      waveResolving: true,
      waveStarting: false,
    });
    finish();
    await vi.waitFor(() =>
      expect(useMusicStore.getState().automaticQueue).toHaveLength(2),
    );
    expect(
      useMusicStore.getState().automaticQueue.map((track) => track.id),
    ).toEqual([two.id, three.id]);
    expect(mock.load).toHaveBeenCalledTimes(1);
  });
  it("grows the prepared queue in small background requests without restarting the playing track", async () => {
    const recommendations = Array.from({ length: 7 }, (_, index) => ({
      ...one,
      id: `notesound:gradual-${index}`,
      title: `Gradual ${index}`,
      artist: `Gradual artist ${index}`,
    }));
    const limits: number[] = [];
    mock.refill.mockImplementation(async (...args: unknown[]) => {
      const context = args[1] as { limit: number; excluded: Track[] };
      limits.push(context.limit);
      return recommendations
        .filter(
          (track) =>
            !context.excluded.some((excluded) => excluded.id === track.id),
        )
        .slice(0, context.limit);
    });
    await useMusicStore.getState().startWave(one);
    await vi.waitFor(() =>
      expect(useMusicStore.getState().automaticQueue).toHaveLength(2),
    );
    expect(useMusicStore.getState()).toMatchObject({
      current: one,
      playing: true,
    });
    await vi.waitFor(
      () => expect(useMusicStore.getState().automaticQueue).toHaveLength(7),
      { timeout: 5000 },
    );
    expect(limits).toEqual([2, 2, 2, 1]);
    expect(mock.load).toHaveBeenCalledTimes(1);
  });
  it("cancels a pending fresh-Wave launch when the Wave is stopped", async () => {
    useMusicStore.getState().updateSettings({ smartWaveEnabled: false });
    await useMusicStore.getState().play(one);
    let release!: (tracks: Track[]) => void;
    mock.refill.mockImplementationOnce(
      () =>
        new Promise<Track[]>((resolve) => {
          release = resolve;
        }),
    );
    const pending = useMusicStore.getState().startNewWave();
    await vi.waitFor(() => expect(mock.refill).toHaveBeenCalled());
    const request = (
      mock.refill.mock.calls as unknown[][]
    )[0]?.[2] as AbortSignal;
    useMusicStore.getState().stopWave();
    expect(request.aborted).toBe(true);
    release([two]);
    await pending;
    expect(useMusicStore.getState()).toMatchObject({
      current: one,
      playing: true,
      wave: false,
      waveStarting: false,
    });
  });
  it("lets a newer manual Next action win over a pending fresh-Wave search", async () => {
    useMusicStore.getState().updateSettings({ smartWaveEnabled: false });
    await useMusicStore.getState().play(one, [one, three]);
    let release!: (tracks: Track[]) => void;
    mock.refill.mockImplementationOnce(
      () =>
        new Promise<Track[]>((resolve) => {
          release = resolve;
        }),
    );
    const pending = useMusicStore.getState().startNewWave();
    await vi.waitFor(() => expect(mock.refill).toHaveBeenCalled());
    const request = (
      mock.refill.mock.calls as unknown[][]
    )[0]?.[2] as AbortSignal;
    await useMusicStore.getState().next();
    expect(useMusicStore.getState().current?.id).toBe(three.id);
    expect(request.aborted).toBe(true);
    release([two]);
    await pending;
    expect(useMusicStore.getState()).toMatchObject({
      current: three,
      waveStarting: false,
    });
  });
  it("leaves a paused old song paused when no different Wave recommendation is available", async () => {
    useMusicStore.getState().updateSettings({ smartWaveEnabled: false });
    await useMusicStore.getState().play(one);
    useMusicStore.getState().pause();
    mock.load.mockClear();
    mock.resume.mockClear();
    await useMusicStore.getState().startNewWave();
    expect(useMusicStore.getState()).toMatchObject({
      current: one,
      playing: false,
      waveStarting: false,
    });
    expect(useMusicStore.getState().waveMessage).toBeTruthy();
    expect(mock.load).not.toHaveBeenCalled();
    expect(mock.resume).not.toHaveBeenCalled();
  });
  it("restarts pending cold-start discovery when Wave preferences change and discards its old result", async () => {
    let release!: (track: Track) => void;
    mock.discover.mockImplementationOnce(
      () =>
        new Promise<Track>((resolve) => {
          release = resolve;
        }),
    );
    mock.discover.mockResolvedValueOnce(two);
    const old = useMusicStore.getState().startWave();
    await vi.waitFor(() => expect(mock.discover).toHaveBeenCalledTimes(1));
    const oldSignal = (mock.discover.mock.calls as unknown[][])[0]?.[1] as
      AbortSignal | undefined;
    useMusicStore.getState().updateSettings({
      wavePreferences: { ...defaultSettings.wavePreferences, mood: "calm" },
    });
    await vi.waitFor(() =>
      expect(useMusicStore.getState().current?.id).toBe(two.id),
    );
    expect(oldSignal?.aborted).toBe(true);
    release(one);
    await old;
    expect(useMusicStore.getState().current?.id).toBe(two.id);
    expect(mock.discover).toHaveBeenLastCalledWith(
      "",
      expect.any(AbortSignal),
      expect.objectContaining({
        preferences: expect.objectContaining({ mood: "calm" }),
      }),
    );
  });
  it("does not select a deleted local file from old favorites as the first Wave track", async () => {
    const missing = {
      ...one,
      id: "local:deleted",
      sourceId: "local",
      local: true,
    };
    useMusicStore.setState({ favorites: [missing, two] });
    await useMusicStore.getState().startWave();
    expect(useMusicStore.getState().current?.id).toBe(two.id);
    expect(mock.discover).not.toHaveBeenCalled();
  });
  it("preserves newly enqueued manual tracks while a queued selection records feedback", async () => {
    useMusicStore.getState().updateSettings({ smartWaveEnabled: false });
    await useMusicStore.getState().play(one, [one, two, three]);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const update = db.history.update.bind(db.history);
    const pending = vi
      .spyOn(db.history, "update")
      .mockImplementationOnce((key, changes) =>
        Dexie.Promise.resolve(barrier).then(() => update(key, changes)),
      );
    const selecting = useMusicStore.getState().playQueued(two.id);
    await vi.waitFor(() => expect(pending).toHaveBeenCalled());
    const extra = { ...three, id: "notesound:extra", title: "Extra" };
    useMusicStore.getState().enqueue(extra);
    release();
    await selecting;
    expect(useMusicStore.getState().current?.id).toBe(two.id);
    expect(
      useMusicStore.getState().manualQueue.map((track) => track.id),
    ).toEqual([three.id, extra.id]);
  });
  it("starts a personal wave from a favorite without requiring a current song", async () => {
    useMusicStore.setState({ favorites: [one] });
    await useMusicStore.getState().startWave();
    expect(useMusicStore.getState().current?.id).toBe(one.id);
    expect(useMusicStore.getState().wave).toBe(true);
    expect(mock.discover).not.toHaveBeenCalled();
  });
  it("chooses a recent unskipped song before imported audio for a fresh wave", async () => {
    useMusicStore.setState({
      history: [
        { track: one, skipped: true, playedAt: 3 },
        { track: two, playedAt: 2 },
      ],
      tracks: [three],
    });
    await useMusicStore.getState().startWave();
    expect(useMusicStore.getState().current?.id).toBe(two.id);
    expect(mock.discover).not.toHaveBeenCalled();
  });
  it("discovers a real seed and starts queue preparation for an entirely new listener", async () => {
    mock.discover.mockResolvedValue(one);
    mock.refill.mockResolvedValue([two, three]);
    await useMusicStore.getState().startWave();
    await vi.waitFor(() =>
      expect(useMusicStore.getState().queue).toHaveLength(2),
    );
    expect(mock.discover).toHaveBeenCalledWith(
      "",
      expect.any(AbortSignal),
      expect.objectContaining({
        preferences: defaultSettings.wavePreferences,
        favorites: [],
        history: [],
      }),
    );
    expect(useMusicStore.getState()).toMatchObject({
      wave: true,
      waveQuery: null,
      current: one,
      queue: [two, three],
    });
    expect(mock.refill).toHaveBeenCalledWith(
      one,
      expect.objectContaining({ query: undefined, limit: 2 }),
      expect.any(AbortSignal),
      expect.any(Object),
    );
  });
  it("retains a requested discovery direction instead of using an unrelated current track", async () => {
    useMusicStore.setState({ current: one });
    mock.discover.mockResolvedValue(two);
    await useMusicStore.getState().startWave(undefined, "русский хип-хоп");
    expect(mock.discover).toHaveBeenCalledWith(
      "русский хип-хоп",
      expect.any(AbortSignal),
      expect.objectContaining({ query: undefined }),
    );
    expect(useMusicStore.getState()).toMatchObject({
      current: two,
      waveQuery: "русский хип-хоп",
    });
  });
  it("keeps a playing seed at its current position and prepares recommendations without replaying it", async () => {
    await useMusicStore.getState().play(one, [one]);
    mock.events?.playing(true);
    useMusicStore.getState().seek(13);
    mock.load.mockClear();
    mock.refill.mockResolvedValue([two, three]);
    await useMusicStore.getState().startWave(one);
    await vi.waitFor(() =>
      expect(useMusicStore.getState().queue).toHaveLength(2),
    );
    expect(mock.load).not.toHaveBeenCalled();
    expect(useMusicStore.getState()).toMatchObject({
      playing: true,
      position: 13,
      wave: true,
      queue: [two, three],
    });
    expect(
      useMusicStore
        .getState()
        .history.filter((entry) => entry.track.id === one.id),
    ).toHaveLength(1);
    expect(await db.waveHistory.count()).toBe(1);
  });
  it("defers recommendation work while the WebView is waiting for a playback gesture", async () => {
    mock.load.mockRejectedValueOnce(
      new DOMException("Gesture required", "NotAllowedError"),
    );
    mock.refill.mockResolvedValue([two, three]);
    await useMusicStore.getState().startWave(one);
    expect(useMusicStore.getState()).toMatchObject({
      playing: false,
      wave: true,
      queue: [],
    });
    expect(mock.refill).not.toHaveBeenCalled();
    expect(useMusicStore.getState().error).toContain("браузер ожидает");
    expect(await db.waveHistory.count()).toBe(0);
  });
  it("resumes a paused seed without reloading it or recording another listen", async () => {
    await useMusicStore.getState().play(one, [one]);
    useMusicStore.getState().seek(12);
    useMusicStore.getState().pause();
    mock.load.mockClear();
    await useMusicStore.getState().startWave(one);
    expect(mock.resume).toHaveBeenCalled();
    expect(mock.load).not.toHaveBeenCalled();
    expect(useMusicStore.getState().position).toBe(12);
    expect(
      useMusicStore
        .getState()
        .history.filter((entry) => entry.track.id === one.id),
    ).toHaveLength(1);
  });
  it("shows the actual discovery failure and leaves no permanent resolving state", async () => {
    mock.discover.mockRejectedValue(
      new Error("Лимит поиска YouTube исчерпан."),
    );
    await useMusicStore.getState().startWave();
    expect(useMusicStore.getState()).toMatchObject({
      wave: false,
      waveResolving: false,
      waveMessage: "Лимит поиска YouTube исчерпан.",
    });
  });
  it("does not start a stale discovered seed after the listener stops the wave", async () => {
    let release!: (track: Track) => void;
    mock.discover.mockImplementationOnce(
      () =>
        new Promise<Track>((resolve) => {
          release = resolve;
        }),
    );
    const pending = useMusicStore.getState().startWave();
    await new Promise((resolve) => setTimeout(resolve, 10));
    useMusicStore.getState().stopWave();
    await useMusicStore.getState().play(three, [three]);
    release(one);
    await pending;
    expect(useMusicStore.getState()).toMatchObject({
      current: three,
      wave: true,
      waveResolving: false,
    });
  });
  it("does not send YouTube metadata into the audio-only player", async () => {
    const youtube: Track = {
      ...one,
      id: "youtube:Abc123xyZ_9",
      sourceId: "youtube",
      playback: { kind: "youtube", videoId: "Abc123xyZ_9" },
      playbackMode: "embedded",
      rights: undefined,
    };
    await useMusicStore.getState().play(youtube);
    expect(mock.videoLoad).not.toHaveBeenCalled();
    expect(mock.load).not.toHaveBeenCalled();
    expect(useMusicStore.getState().current).toBeNull();
    expect(useMusicStore.getState().error).toContain("не разрешено");
  });
  it("does not treat an unconfirmed MP3 link as a playable source", async () => {
    await useMusicStore.getState().play({
      ...one,
      id: "hitmoz:unknown",
      sourceId: "hitmoz",
      rights: { status: "unknown", basis: "none", allowMix: false },
      streamUrl: "https://example.com/track.mp3",
      playbackMode: "metadata",
    });
    expect(mock.load).not.toHaveBeenCalled();
    expect(useMusicStore.getState().history).toEqual([]);
  });
  it("stores toggled favorites and removes them durably", async () => {
    await useMusicStore.getState().toggleFavorite(one);
    expect((await db.favorites.get(one.id))?.track.title).toBe("One");
    await useMusicStore.getState().toggleFavorite(one);
    expect(useMusicStore.getState().favorites).toEqual([]);
    expect(await db.favorites.count()).toBe(0);
  });
  it("adds a track only once to a playlist and removes membership", async () => {
    const id = await useMusicStore.getState().createPlaylist("Ночь");
    await useMusicStore.getState().addToPlaylist(id, one);
    await useMusicStore.getState().addToPlaylist(id, one);
    expect(useMusicStore.getState().playlistTracks[id]).toHaveLength(1);
    expect(await db.playlistTracks.count()).toBe(1);
    await useMusicStore.getState().removeFromPlaylist(id, one.id);
    expect(await db.playlistTracks.count()).toBe(0);
  });
  it("advances a real queue, records a skipped track and saves playback position", async () => {
    useMusicStore.getState().updateSettings({ smartWaveEnabled: false });
    await useMusicStore.getState().play(one, [one, two, three]);
    useMusicStore.getState().seek(7);
    await useMusicStore.getState().next();
    expect(useMusicStore.getState().current?.id).toBe(two.id);
    expect(useMusicStore.getState().queue.map((t) => t.id)).toEqual([three.id]);
    expect(
      useMusicStore.getState().history.find((h) => h.track.id === one.id)
        ?.skipped,
    ).toBe(true);
    expect(mock.load).toHaveBeenCalledTimes(2);
    useMusicStore.getState().seek(12);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await db.settings.get("playback"))?.value).toMatchObject({
      current: { id: two.id },
      position: 12,
    });
  });
  it("uses an audio-ended event to advance and honors single-track repeat", async () => {
    useMusicStore.getState().updateSettings({ smartWaveEnabled: false });
    await useMusicStore.getState().play(one, [one, two]);
    useMusicStore.getState().setRepeat("one");
    mock.events?.playing(false);
    mock.events?.ended();
    expect(mock.seek).toHaveBeenCalledWith(0);
    expect(useMusicStore.getState().current?.id).toBe(one.id);
    useMusicStore.getState().setRepeat("off");
    mock.events?.playing(false);
    mock.events?.ended();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(useMusicStore.getState().current?.id).toBe(two.id);
  });
  it("reserves wave identities while allowing an explicit replay of an earlier song", async () => {
    mock.refill.mockResolvedValue([two, three]);
    await useMusicStore.getState().startWave(one);
    await vi.waitFor(() =>
      expect(useMusicStore.getState().queue).toHaveLength(2),
    );
    expect(await db.waveHistory.count()).toBe(1);
    useMusicStore.getState().enqueue(one);
    useMusicStore.getState().enqueue(two);
    expect(useMusicStore.getState().queue.map((t) => t.id)).toEqual([
      two.id,
      three.id,
    ]);
    await useMusicStore.getState().next();
    useMusicStore.getState().enqueue(one);
    expect(useMusicStore.getState().queue.some((t) => t.id === one.id)).toBe(
      true,
    );
    expect(
      useMusicStore.getState().manualQueue.some((track) => track.id === one.id),
    ).toBe(true);
  });
  it("does not persist a partly malformed library import", async () => {
    await useMusicStore.getState().importLibrary(
      JSON.stringify({
        version: 1,
        favorites: [one],
        playlists: [{ id: "x", name: "x" }],
        playlistTracks: { x: [{ bad: true }] },
      }),
    );
    expect(useMusicStore.getState().error).toBeTruthy();
    expect(await db.favorites.count()).toBe(0);
    expect(await db.playlists.count()).toBe(0);
  });
  it("waits for an in-flight wave refill when the current audio ends", async () => {
    let release!: (tracks: Track[]) => void;
    mock.refill.mockImplementationOnce(
      () =>
        new Promise<Track[]>((resolve) => {
          release = resolve;
        }),
    );
    await useMusicStore.getState().startWave(one);
    await vi.waitFor(() =>
      expect(useMusicStore.getState().waveResolving).toBe(true),
    );
    mock.events?.playing(false);
    mock.events?.ended();
    expect(useMusicStore.getState().current?.id).toBe(one.id);
    release([two, three]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(useMusicStore.getState().current?.id).toBe(two.id);
    expect(useMusicStore.getState().queue.map((t) => t.id)).toEqual([three.id]);
  });
  it("ignores a stale refill after stopping a wave and selecting another track", async () => {
    await useMusicStore.getState().startWave(one);
    await new Promise((resolve) => setTimeout(resolve, 10));
    useMusicStore.getState().stopWave();
    let release!: (tracks: Track[]) => void;
    mock.refill.mockImplementationOnce(
      () =>
        new Promise<Track[]>((resolve) => {
          release = resolve;
        }),
    );
    const pending = useMusicStore.getState().startWave(one);
    await vi.waitFor(() =>
      expect(useMusicStore.getState().waveResolving).toBe(true),
    );
    useMusicStore.getState().stopWave();
    await useMusicStore.getState().play(three, [three]);
    release([two]);
    await pending;
    expect(useMusicStore.getState().current?.id).toBe(three.id);
    expect(useMusicStore.getState().wave).toBe(true);
    expect(
      useMusicStore.getState().queue.some((track) => track.id === two.id),
    ).toBe(false);
  });
  it("records and prepares a wave after retrying a browser autoplay restriction", async () => {
    mock.load.mockRejectedValueOnce(
      new DOMException("Gesture required", "NotAllowedError"),
    );
    mock.refill.mockResolvedValue([two, three]);
    await useMusicStore.getState().startWave(one);
    expect(await db.waveHistory.count()).toBe(0);
    expect(useMusicStore.getState().playing).toBe(false);
    await useMusicStore.getState().togglePlay();
    await vi.waitFor(() =>
      expect(useMusicStore.getState().queue).toHaveLength(2),
    );
    expect(await db.waveHistory.count()).toBe(1);
    expect(
      useMusicStore.getState().history.filter((h) => h.track.id === one.id),
    ).toHaveLength(1);
    expect(useMusicStore.getState().queue.map((t) => t.id)).toEqual([
      two.id,
      three.id,
    ]);
  });
  it("bounds automatic skips when every prepared stream fails", async () => {
    useMusicStore.getState().updateSettings({ smartWaveEnabled: false });
    const four = { ...one, id: "notesound:four", title: "Four" };
    const five = { ...one, id: "notesound:five", title: "Five" };
    mock.load.mockRejectedValue(new Error("Dead stream"));
    await useMusicStore.getState().play(one, [one, two, three, four, five]);
    expect(mock.load).toHaveBeenCalledTimes(4);
    expect(useMusicStore.getState().current?.id).toBe(four.id);
    expect(useMusicStore.getState().queue.map((t) => t.id)).toEqual([five.id]);
    expect(useMusicStore.getState().error).toBe("Dead stream");
  });
  it("saves simultaneous clicks for one authorized offline track only once", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(new Blob(["audio"], { type: "audio/wav" })),
      );
    const download = {
      ...one,
      id: "notesound:download",
      title: "Offline download",
    };
    await Promise.all([
      useMusicStore.getState().downloadTrack(download),
      useMusicStore.getState().downloadTrack(download),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(useMusicStore.getState().offlineIds).toEqual([download.id]);
    expect(useMusicStore.getState().storageBytes).toBe(5);
    expect(await db.offlineTracks.count()).toBe(1);
  });
  it("blocks offline storage when rights are absent or the size cap is reached", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(new Blob(["audio"], { type: "audio/wav" })),
      );
    await useMusicStore.getState().downloadTrack({
      ...one,
      license: { name: "Streaming only", download: false },
    });
    expect(fetcher).not.toHaveBeenCalled();
    useMusicStore.setState({ storageBytes: 250 * 1024 * 1024 - 1 });
    await useMusicStore.getState().downloadTrack(one);
    expect(useMusicStore.getState().offlineIds).toEqual([]);
    expect(await db.offlineTracks.count()).toBe(0);
    expect(useMusicStore.getState().error).toContain("250 МБ");
  });
  it("selects a queued wave track without ending the wave and drops earlier queue entries", async () => {
    mock.refill.mockResolvedValueOnce([two, three]);
    await useMusicStore.getState().startWave(one);
    await vi.waitFor(() =>
      expect(useMusicStore.getState().queue).toHaveLength(2),
    );
    await useMusicStore.getState().playQueued(three.id);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(useMusicStore.getState().current?.id).toBe(three.id);
    expect(useMusicStore.getState().wave).toBe(true);
    expect(useMusicStore.getState().queue).toEqual([]);
    expect(
      useMusicStore.getState().history.find((h) => h.track.id === one.id)
        ?.skipped,
    ).toBe(true);
    expect((await db.settings.get("playback"))?.value).toMatchObject({
      current: { id: three.id },
      wave: true,
    });
    expect(await db.waveHistory.count()).toBe(2);
  });
  it("cancels a pending audio load on pause and permits a clean retry", async () => {
    let release!: () => void;
    mock.load.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    const pending = useMusicStore.getState().play(one, [one, two]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(useMusicStore.getState().loading).toBe(true);
    await useMusicStore.getState().togglePlay();
    expect(useMusicStore.getState().loading).toBe(false);
    expect(useMusicStore.getState().playing).toBe(false);
    release();
    await pending;
    expect(useMusicStore.getState().history).toEqual([]);
    await useMusicStore.getState().togglePlay();
    expect(mock.load).toHaveBeenCalledTimes(2);
    expect(useMusicStore.getState().history).toHaveLength(1);
  });
  it("continues to a new wave track instead of replaying ended audio while refill is pending", async () => {
    let release!: (tracks: Track[]) => void;
    mock.refill.mockImplementationOnce(
      () =>
        new Promise<Track[]>((resolve) => {
          release = resolve;
        }),
    );
    await useMusicStore.getState().startWave(one);
    await vi.waitFor(() => expect(mock.refill).toHaveBeenCalled());
    mock.events?.playing(false);
    mock.events?.ended();
    const continuing = useMusicStore.getState().togglePlay();
    expect(mock.resume).not.toHaveBeenCalled();
    release([two, three]);
    await continuing;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(useMusicStore.getState().current?.id).toBe(two.id);
    expect(mock.load).toHaveBeenCalledTimes(2);
    expect(
      useMusicStore.getState().history.filter((h) => h.track.id === one.id),
    ).toHaveLength(1);
  });
  it("automatically starts Smart Wave after a manual selection and rebuilds recommendations around a new song", async () => {
    mock.refill.mockResolvedValue([three]);
    await useMusicStore.getState().play(one, [one, two]);
    await vi.waitFor(() =>
      expect(useMusicStore.getState().automaticQueue).toHaveLength(1),
    );
    expect(useMusicStore.getState()).toMatchObject({
      current: one,
      wave: true,
      automaticQueue: [three],
      manualQueue: [],
    });
    expect(mock.refill).toHaveBeenCalledWith(
      one,
      expect.objectContaining({ limit: 2, discoveryIntensity: 0.25 }),
      expect.any(AbortSignal),
      expect.any(Object),
    );
    mock.refill.mockClear();
    await useMusicStore.getState().play(two);
    await vi.waitFor(() => expect(mock.refill).toHaveBeenCalled());
    expect(useMusicStore.getState().current?.id).toBe(two.id);
    expect(mock.refill).toHaveBeenCalledWith(
      two,
      expect.anything(),
      expect.any(AbortSignal),
      expect.any(Object),
    );
  });
  it("preserves manual queue priority over automatic recommendations", async () => {
    mock.refill.mockResolvedValue([two, three]);
    await useMusicStore.getState().play(one);
    await vi.waitFor(() =>
      expect(useMusicStore.getState().queue).toHaveLength(2),
    );
    const manual = { ...one, id: "notesound:manual", title: "Manual choice" };
    useMusicStore.getState().enqueue(manual);
    expect(useMusicStore.getState().queue.map((item) => item.id)).toEqual([
      manual.id,
      two.id,
      three.id,
    ]);
    await useMusicStore.getState().next();
    expect(useMusicStore.getState().current?.id).toBe(manual.id);
    expect(
      useMusicStore.getState().automaticQueue.map((item) => item.id),
    ).toEqual([two.id, three.id]);
  });
  it("fills a newly started Wave to seven even when three restored manual choices already exist", async () => {
    const manual = [
      two,
      three,
      {
        ...one,
        id: "notesound:manual-three",
        title: "Third manual",
        artist: "Manual artist",
      },
    ];
    const recommended = Array.from({ length: 6 }, (_, index) => ({
      ...one,
      id: `notesound:recommend-${index}`,
      title: `Recommendation ${index}`,
      artist: `Recommendation artist ${index}`,
    }));
    useMusicStore.setState({
      manualQueue: manual,
      automaticQueue: [],
      queue: manual,
    });
    mock.refill.mockResolvedValue(recommended);
    await useMusicStore.getState().startWave(one);
    await vi.waitFor(
      () => expect(useMusicStore.getState().queue).toHaveLength(7),
      { timeout: 5000 },
    );
    expect(mock.refill).toHaveBeenCalledWith(
      one,
      expect.objectContaining({
        limit: 2,
        excluded: expect.arrayContaining(manual),
      }),
      expect.any(AbortSignal),
      expect.any(Object),
    );
    expect(useMusicStore.getState().queue).toHaveLength(7);
    expect(useMusicStore.getState().queue.slice(0, 3)).toEqual(manual);
    expect(useMusicStore.getState().manualQueue).toEqual(manual);
    expect(useMusicStore.getState().automaticQueue).toHaveLength(4);
  });
  it("bounds the complete future queue at seven automatic recommendations", async () => {
    mock.refill.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => ({
        ...one,
        id: `notesound:next-${index}`,
        title: `Next ${index}`,
        artist: `Artist ${index}`,
      })),
    );
    await useMusicStore.getState().play(one);
    await vi.waitFor(
      () => expect(useMusicStore.getState().queue).toHaveLength(7),
      { timeout: 5000 },
    );
    expect(useMusicStore.getState().queue).toHaveLength(7);
    expect(
      new Set(useMusicStore.getState().queue.map((item) => item.id)).size,
    ).toBe(7);
  });
  it("persists likes/dislikes and can undo rejection without deleting favorites", async () => {
    await useMusicStore.getState().toggleFavorite(one);
    await useMusicStore.getState().toggleLike(one);
    expect(useMusicStore.getState().likedIds).toContain(one.id);
    expect((await db.tasteSignals.toArray()).map((item) => item.kind)).toEqual(
      expect.arrayContaining(["like", "favorite"]),
    );
    await useMusicStore.getState().dislike(one);
    expect(useMusicStore.getState().dislikedIds).toContain(one.id);
    expect(useMusicStore.getState().likedIds).not.toContain(one.id);
    await useMusicStore.getState().toggleLike(one);
    expect(useMusicStore.getState().dislikedIds).not.toContain(one.id);
    await useMusicStore.getState().resetTaste();
    expect(await db.tasteSignals.count()).toBe(0);
    expect(useMusicStore.getState().favorites.map((item) => item.id)).toContain(
      one.id,
    );
  });
  it("deep-merges and saves mix/taste settings without interrupting the current audio", async () => {
    await useMusicStore.getState().play(one);
    mock.load.mockClear();
    useMusicStore
      .getState()
      .updateSettings({ waveMix: { enabled: true } as Settings["waveMix"] });
    useMusicStore.getState().updateSettings({
      waveMix: { durationSeconds: 9 } as Settings["waveMix"],
      signalWeights: { like: 8 } as Settings["signalWeights"],
    });
    useMusicStore.getState().updateSettings({ discoveryIntensity: 0.8 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(useMusicStore.getState().settings.waveMix).toEqual({
      enabled: true,
      durationSeconds: 9,
      smartCue: true,
      earlyTransition: true,
    });
    expect(useMusicStore.getState().settings.signalWeights).toMatchObject({
      like: 8,
      dislike: -8,
      favorite: 4,
    });
    expect((await db.settings.get("settings"))?.value).toMatchObject({
      discoveryIntensity: 0.8,
      waveMix: { enabled: true, durationSeconds: 9 },
    });
    expect(mock.load).not.toHaveBeenCalled();
  });
  it("deep-merges Wave preferences and refreshes automatic choices without replacing manual choices or restarting audio", async () => {
    const manual = { ...three, id: "notesound:manual", title: "Manual choice" };
    mock.refill.mockResolvedValue([two, three]);
    await useMusicStore.getState().play(one);
    await vi.waitFor(() =>
      expect(useMusicStore.getState().queue).toHaveLength(2),
    );
    useMusicStore.getState().enqueue(manual);
    useMusicStore.getState().seek(13);
    mock.load.mockClear();
    mock.refill.mockClear();

    useMusicStore.getState().updateSettings({
      wavePreferences: {
        familiarity: "discover",
      } as Settings["wavePreferences"],
    });
    useMusicStore.getState().updateSettings({
      wavePreferences: { mood: "calm" } as Settings["wavePreferences"],
    });
    useMusicStore.getState().updateSettings({
      wavePreferences: { language: "russian" } as Settings["wavePreferences"],
    });

    const expectedPreferences = {
      familiarity: "discover",
      mood: "calm",
      language: "russian",
    };
    expect(useMusicStore.getState().settings.wavePreferences).toEqual(
      expectedPreferences,
    );
    await vi.waitFor(async () =>
      expect((await db.settings.get("settings"))?.value).toMatchObject({
        wavePreferences: expectedPreferences,
      }),
    );
    await vi.waitFor(() => expect(mock.refill).toHaveBeenCalled());
    expect(mock.refill).toHaveBeenLastCalledWith(
      one,
      expect.objectContaining({
        preferences: expectedPreferences,
        excluded: expect.arrayContaining([manual]),
        limit: 2,
      }),
      expect.any(AbortSignal),
      expect.any(Object),
    );
    expect(useMusicStore.getState()).toMatchObject({
      current: one,
      position: 13,
      playing: true,
      manualQueue: [manual],
    });
    expect(useMusicStore.getState().queue[0]).toEqual(manual);
    expect((await db.queue.get(manual.id))?.kind).toBe("manual");
    expect(mock.load).not.toHaveBeenCalled();
  });
  it("reranks prepared recommendations after positive feedback and removes a rejected choice immediately", async () => {
    const manual = { ...one, id: "notesound:manual", title: "Keep this next" };
    mock.refill.mockResolvedValue([two, three]);
    await useMusicStore.getState().play(one);
    await vi.waitFor(() =>
      expect(useMusicStore.getState().automaticQueue).toHaveLength(2),
    );
    useMusicStore.getState().enqueue(manual);
    mock.load.mockClear();

    await useMusicStore.getState().toggleLike(three);
    expect(useMusicStore.getState().automaticQueue[0]?.id).toBe(three.id);
    expect(useMusicStore.getState().queue[0]?.id).toBe(manual.id);
    expect(useMusicStore.getState().current?.id).toBe(one.id);
    expect(mock.load).not.toHaveBeenCalled();

    await useMusicStore.getState().dislike(three);
    expect(
      useMusicStore.getState().automaticQueue.map((track) => track.id),
    ).not.toContain(three.id);
    expect(useMusicStore.getState().manualQueue).toEqual([manual]);
    expect(useMusicStore.getState().likedIds).not.toContain(three.id);
    expect(useMusicStore.getState().dislikedIds).toContain(three.id);
  });
  it("undoes an earlier dislike when another publication of the same recording is explicitly liked", async () => {
    const publication: Track = {
      ...two,
      sourceId: "licensed",
      id: "licensed:two-other-publication",
      title: "Two (Official Audio)",
      artist: "SECOND",
    };
    await useMusicStore.getState().dislike(two);
    expect(useMusicStore.getState().dislikedIds).toContain(two.id);

    await useMusicStore.getState().toggleLike(publication);
    expect(useMusicStore.getState().dislikedIds).toEqual([]);
    expect(useMusicStore.getState().likedIds).toContain(publication.id);
    expect(
      (await db.tasteSignals.toArray()).filter(
        (entry) => entry.kind === "dislike",
      ),
    ).toEqual([]);
    expect(
      (await db.tasteSignals.toArray()).find((entry) => entry.kind === "like")
        ?.trackId,
    ).toBe(publication.id);
  });
  it("keeps manual queue priority when shuffle was restored from an earlier session", async () => {
    useMusicStore.getState().updateSettings({ smartWaveEnabled: false });
    await useMusicStore.getState().play(one);
    useMusicStore.setState({
      shuffle: true,
      manualQueue: [two],
      automaticQueue: [three],
      queue: [two, three],
    });
    await useMusicStore.getState().next();
    expect(useMusicStore.getState().current?.id).toBe(two.id);
    expect(useMusicStore.getState().queue[0]?.id).toBe(three.id);
  });
  it("stores musical cue marks when an authorized track begins playback", async () => {
    useMusicStore.getState().updateSettings({ smartWaveEnabled: false });
    const marked = {
      ...one,
      cuePoints: {
        cueInSeconds: 8,
        cueOutSeconds: 40,
        cueConfidence: 0.9,
        cueSource: "manual" as const,
      },
    };
    await useMusicStore.getState().play(marked);
    expect(await db.trackCuePoints.get(one.id)).toMatchObject({
      trackId: one.id,
      cueInSeconds: 8,
      cueOutSeconds: 40,
      cueConfidence: 0.9,
      cueSource: "manual",
    });
  });
  it("preserves a manual choice queued ahead of an in-flight mix when the midpoint commits", async () => {
    useMusicStore.getState().updateSettings({ smartWaveEnabled: false });
    await useMusicStore.getState().play(one);
    useMusicStore.setState({
      manualQueue: [three],
      automaticQueue: [two],
      queue: [three, two],
    });
    mock.events?.transition?.({
      from: one,
      to: two,
      phase: "committed",
      progress: 0.5,
      duration: 6,
      position: 15,
    });
    expect(useMusicStore.getState().current?.id).toBe(two.id);
    expect(useMusicStore.getState().queue.map((track) => track.id)).toEqual([
      three.id,
    ]);
    expect(
      useMusicStore.getState().manualQueue.map((track) => track.id),
    ).toEqual([three.id]);
  });
  it("adopts midpoint mix metadata without reloading or double-recording either audio channel", async () => {
    mock.refill.mockResolvedValue([two, three]);
    await useMusicStore.getState().play(one);
    await vi.waitFor(() =>
      expect(useMusicStore.getState().queue).toHaveLength(2),
    );
    mock.load.mockClear();
    const transition = {
      from: one,
      to: two,
      progress: 0,
      duration: 6,
      position: 12,
    };
    mock.events?.transition?.({ ...transition, phase: "started" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(useMusicStore.getState().current?.id).toBe(one.id);
    mock.events?.listened?.({
      track: one,
      playedSeconds: 40,
      position: 40,
      duration: 48,
    });
    mock.events?.listened?.({
      track: two,
      playedSeconds: 2,
      position: 12,
      duration: 48,
    });
    mock.events?.transition?.({
      ...transition,
      phase: "committed",
      progress: 0.5,
      position: 15,
    });
    mock.events?.playing(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(useMusicStore.getState()).toMatchObject({
      current: two,
      position: 15,
    });
    expect(
      useMusicStore.getState().queue.some((item) => item.id === two.id),
    ).toBe(false);
    mock.events?.listened?.({
      track: two,
      playedSeconds: 35,
      position: 45,
      duration: 48,
    });
    mock.events?.listened?.({
      track: two,
      playedSeconds: 36,
      position: 46,
      duration: 48,
    });
    mock.events?.transition?.({
      ...transition,
      phase: "completed",
      progress: 1,
      position: 18,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mock.load).not.toHaveBeenCalled();
    expect(useMusicStore.getState().mixTransition).toBeNull();
    expect(
      useMusicStore
        .getState()
        .history.filter((entry) => entry.track.id === one.id),
    ).toHaveLength(1);
    expect(
      useMusicStore
        .getState()
        .history.filter((entry) => entry.track.id === two.id),
    ).toHaveLength(1);
    expect(
      useMusicStore
        .getState()
        .tasteSignals.filter(
          (entry) => entry.kind === "listen" && entry.trackId === two.id,
        ),
    ).toHaveLength(1);
    expect(
      useMusicStore
        .getState()
        .history.find((entry) => entry.track.id === two.id),
    ).toMatchObject({ playedSeconds: 36, completed: true });
  });
  it("returns to a genuinely heard previous song, restarting the current one first after three seconds", async () => {
    useMusicStore.getState().updateSettings({ smartWaveEnabled: false });
    await useMusicStore.getState().play(one, [one, two, three]);
    await useMusicStore.getState().next();
    useMusicStore.getState().seek(9);
    await useMusicStore.getState().previous();
    expect(useMusicStore.getState().current?.id).toBe(two.id);
    expect(useMusicStore.getState().position).toBe(0);
    await useMusicStore.getState().previous();
    expect(useMusicStore.getState().current?.id).toBe(one.id);
    expect(useMusicStore.getState().manualQueue[0]?.id).toBe(two.id);
  });
  it("records no completed-listen signal from a paused/briefly started track", async () => {
    await useMusicStore.getState().play(one);
    useMusicStore.getState().pause();
    expect(
      useMusicStore
        .getState()
        .tasteSignals.some((entry) => entry.kind === "listen"),
    ).toBe(false);
    expect(useMusicStore.getState().history[0]).toMatchObject({
      playedSeconds: 0,
    });
  });
  it("records an early skip from actual listening even after seeking near the end", async () => {
    useMusicStore.getState().updateSettings({ smartWaveEnabled: false });
    await useMusicStore.getState().play(one, [one, two]);
    mock.events?.listened?.({
      track: one,
      playedSeconds: 4,
      position: 4,
      duration: 48,
    });
    useMusicStore.getState().seek(46);
    await useMusicStore.getState().next();

    expect(useMusicStore.getState().current?.id).toBe(two.id);
    expect(
      useMusicStore
        .getState()
        .history.find((entry) => entry.track.id === one.id),
    ).toMatchObject({
      skipped: true,
      playedSeconds: 4,
      completed: false,
    });
    expect(
      useMusicStore
        .getState()
        .tasteSignals.find(
          (entry) => entry.kind === "skip" && entry.trackId === one.id,
        )?.playedSeconds,
    ).toBe(4);
    expect(
      useMusicStore
        .getState()
        .tasteSignals.some(
          (entry) => entry.kind === "listen" && entry.trackId === one.id,
        ),
    ).toBe(false);
  });
  it.each(["previous", "selection"] as const)(
    "records a repeat for an intentional %s after a genuine completed listen",
    async (action) => {
      useMusicStore.getState().updateSettings({ smartWaveEnabled: false });
      await useMusicStore.getState().play(one, [one, two]);
      mock.events?.listened?.({
        track: one,
        playedSeconds: 35,
        position: 35,
        duration: 48,
      });
      await useMusicStore.getState().next();
      if (action === "previous") await useMusicStore.getState().previous();
      else await useMusicStore.getState().play(one);

      expect(useMusicStore.getState().current?.id).toBe(one.id);
      expect(
        useMusicStore
          .getState()
          .tasteSignals.filter(
            (entry) => entry.kind === "repeat" && entry.trackId === one.id,
          ),
      ).toHaveLength(1);
    },
  );
  it("does not award repeat preference when a barely heard song is selected again", async () => {
    useMusicStore.getState().updateSettings({ smartWaveEnabled: false });
    await useMusicStore.getState().play(one, [one, two]);
    mock.events?.listened?.({
      track: one,
      playedSeconds: 3,
      position: 3,
      duration: 48,
    });
    await useMusicStore.getState().next();
    await useMusicStore.getState().play(one);

    expect(useMusicStore.getState().current?.id).toBe(one.id);
    expect(
      useMusicStore
        .getState()
        .tasteSignals.filter((entry) => entry.kind === "repeat"),
    ).toEqual([]);
  });
  it("does not mistake an automatic repeat-all loop for an intentional replay", async () => {
    useMusicStore.getState().updateSettings({ smartWaveEnabled: false });
    await useMusicStore.getState().play(one, [one, two]);
    mock.events?.listened?.({
      track: one,
      playedSeconds: 35,
      position: 35,
      duration: 48,
    });
    useMusicStore.getState().setRepeat("all");
    mock.events?.ended();
    await vi.waitFor(() => {
      expect(useMusicStore.getState()).toMatchObject({
        current: two,
        playing: true,
      });
      expect(useMusicStore.getState().history[0]?.track.id).toBe(two.id);
    });
    mock.events?.listened?.({
      track: two,
      playedSeconds: 35,
      position: 35,
      duration: 48,
    });
    mock.events?.ended();
    await vi.waitFor(() => {
      expect(useMusicStore.getState()).toMatchObject({
        current: one,
        playing: true,
      });
      expect(
        useMusicStore
          .getState()
          .history.filter((entry) => entry.track.id === one.id),
      ).toHaveLength(2);
    });

    expect(
      useMusicStore
        .getState()
        .tasteSignals.filter((entry) => entry.kind === "repeat"),
    ).toEqual([]);
  });
  it("never reintroduces a newly disliked recording from a stale recommendation response", async () => {
    let release!: (tracks: Track[]) => void;
    mock.refill.mockImplementationOnce(
      () =>
        new Promise<Track[]>((resolve) => {
          release = resolve;
        }),
    );
    await useMusicStore.getState().play(one);
    await vi.waitFor(() =>
      expect(useMusicStore.getState().waveResolving).toBe(true),
    );
    await useMusicStore.getState().dislike(two);
    const publication = {
      ...two,
      id: "licensed:duplicate-two",
      sourceId: "licensed",
      title: "Two (Official Audio)",
    };
    release([publication, three]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(
      useMusicStore
        .getState()
        .queue.some((item) => item.id === two.id || item.id === publication.id),
    ).toBe(false);
    expect(useMusicStore.getState().dislikedIds).toContain(two.id);
  });
});
