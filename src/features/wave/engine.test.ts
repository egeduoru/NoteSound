import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TasteSignal, Track } from "../../types/music";
const mocks = vi.hoisted(() => ({
  searchTracks: vi.fn(),
  checkAvailability: vi.fn(),
  similar: vi.fn(),
  searchPage: vi.fn(),
  top: vi.fn(),
  related: vi.fn(),
}));
vi.mock("../../adapters/music", () => ({
  adapters: [
    {
      id: "test",
      status: "available",
      getSimilarTracks: mocks.similar,
      getRelatedArtists: mocks.related,
    },
    {
      id: "licensed",
      status: "available",
      searchPage: mocks.searchPage,
      getTopTracks: mocks.top,
    },
  ],
  searchTracks: mocks.searchTracks,
  checkAvailability: mocks.checkAvailability,
}));
vi.mock("../../adapters/music/catalog", () => ({ catalog: [] }));
import {
  chooseWaveSeed,
  discoverWaveSeed,
  refillWave,
  waveRetrievalQueries,
  type WaveContext,
} from "./engine";
const track = (id: string, fields: Partial<Track> = {}): Track => ({
  id,
  sourceId: "test",
  title: `Song ${id}`,
  artist: `Artist ${id}`,
  duration: 90,
  genres: ["ambient"],
  rights: { status: "confirmed", basis: "license", allowMix: true },
  license: { name: "Test", download: false },
  ...fields,
});
const seed = track("seed");
const context = (fields: Partial<WaveContext> = {}): WaveContext => ({
  history: [],
  favorites: [],
  excluded: [],
  diversity: 0.25,
  rng: () => 0.25,
  ...fields,
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.similar.mockResolvedValue([]);
  mocks.searchTracks.mockResolvedValue([]);
  mocks.checkAvailability.mockResolvedValue(true);
  mocks.searchPage.mockResolvedValue({ tracks: [] });
  mocks.top.mockResolvedValue([]);
  mocks.related.mockResolvedValue([]);
});

describe("bounded licensed-audio Wave refill", () => {
  it("ranks only saved audio offline without contacting any metadata or playback provider", async () => {
    const saved = [track("saved-a"), track("saved-b")];
    const offline = context({
      offline: true,
      collection: [seed, ...saved],
      dislikedIds: [saved[1].id],
    });
    expect((await refillWave(seed, offline)).map((item) => item.id)).toEqual([
      saved[0].id,
    ]);
    expect((await discoverWaveSeed("", undefined, offline))?.id).toBeTruthy();
    expect(
      await discoverWaveSeed("nonexistent song", undefined, offline),
    ).toBeNull();
    expect(mocks.searchTracks).not.toHaveBeenCalled();
    expect(mocks.searchPage).not.toHaveBeenCalled();
    expect(mocks.similar).not.toHaveBeenCalled();
    expect(mocks.top).not.toHaveBeenCalled();
    expect(mocks.checkAvailability).not.toHaveBeenCalled();
  });
  it("uses later pages and returns seven distinct permitted tracks", async () => {
    const initial = track("licensed-seed", {
      sourceId: "licensed",
      genres: ["music"],
    });
    const heard = track("heard", { sourceId: "licensed" });
    const fresh = Array.from({ length: 9 }, (_, i) =>
      track(`fresh-${i}`, { sourceId: "licensed" }),
    );
    mocks.searchPage
      .mockResolvedValueOnce({
        tracks: [initial, heard],
        nextPageToken: "second",
      })
      .mockResolvedValueOnce({ tracks: fresh });
    const ready = await refillWave(initial, context({ excluded: [heard] }));
    expect(ready).toHaveLength(7);
    expect(new Set(ready.map((item) => item.id)).size).toBe(7);
    expect(
      ready.every((item) => fresh.some((other) => other.id === item.id)),
    ).toBe(true);
    expect(mocks.searchPage).toHaveBeenNthCalledWith(
      2,
      initial.artist,
      expect.objectContaining({ pageToken: "second" }),
    );
    expect(mocks.similar).not.toHaveBeenCalled();
  });
  it("retains direction, ignores generic genre music and bounds metadata operations", async () => {
    await refillWave(
      track("licensed", { sourceId: "licensed", genres: ["music", "local"] }),
      context({ query: "русский хип-хоп" }),
    );
    expect(mocks.searchPage.mock.calls.map(([query]) => query)).toEqual([
      "русский хип-хоп",
      "Artist licensed",
    ]);
    expect(
      mocks.top.mock.calls.length + mocks.searchPage.mock.calls.length,
    ).toBeLessThanOrEqual(4);
  });
  it("adds chart candidates without treating a download link as playback permission", async () => {
    mocks.top.mockResolvedValue([
      track("chart", { sourceId: "licensed", popularity: 4 }),
      track("forbidden", {
        sourceId: "licensed",
        rights: { status: "unknown", basis: "none", allowMix: false },
        streamUrl: "https://example.com/music.mp3",
      }),
    ]);
    const ready = await refillWave(
      track("licensed", { sourceId: "licensed" }),
      context(),
    );
    expect(ready.map((item) => item.id)).toEqual(["chart"]);
    expect(
      mocks.checkAvailability.mock.calls.some(
        ([item]) => item.id === "forbidden",
      ),
    ).toBe(false);
  });
  it("preserves configuration and quota explanations without retries", async () => {
    const error = Object.assign(new Error("Лимит каталога исчерпан"), {
      code: "quota",
    });
    mocks.searchPage.mockRejectedValue(error);
    await expect(
      refillWave(track("licensed", { sourceId: "licensed" }), context()),
    ).rejects.toBe(error);
    expect(mocks.searchPage).toHaveBeenCalledTimes(1);
  });
  it("reports a total outage instead of false catalog exhaustion", async () => {
    mocks.similar.mockRejectedValue(new Error("Сеть недоступна"));
    mocks.searchTracks.mockRejectedValue(new Error("Сеть недоступна"));
    await expect(refillWave(seed, context())).rejects.toThrow(
      "Сеть недоступна",
    );
  });
  it("times out a provider that ignores cancellation within the total deadline", async () => {
    vi.useFakeTimers();
    try {
      mocks.similar.mockImplementation(() => new Promise(() => {}));
      const checked = expect(refillWave(seed, context())).rejects.toThrow(
        "Источник музыки не ответил вовремя",
      );
      await vi.advanceTimersByTimeAsync(30000);
      await checked;
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps a personal-file Wave within the imported collection", async () => {
    const local = (id: string) =>
      track(id, {
        sourceId: "local",
        local: true,
        rights: undefined,
        genres: ["local"],
      });
    const one = local("one"),
      two = local("two"),
      three = local("three");
    const ready = await refillWave(
      one,
      context({ collection: [one, two, three, seed] }),
    );
    expect(ready.map((item) => item.id).sort()).toEqual(["three", "two"]);
    expect(mocks.searchTracks).not.toHaveBeenCalled();
    expect(mocks.checkAvailability).not.toHaveBeenCalled();
  });
  it("checks at most fourteen candidates and fills a seven-track queue despite a failed recording", async () => {
    mocks.similar.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => track(String(i))),
    );
    mocks.checkAvailability.mockImplementation(
      async (candidate: Track) => candidate.id !== "0",
    );
    const ready = await refillWave(seed, context());
    expect(ready).toHaveLength(7);
    expect(ready.some((item) => item.id === "0")).toBe(false);
    expect(mocks.checkAvailability.mock.calls.length).toBeLessThanOrEqual(14);
  });
  it("supports a requested smaller refill without exceeding target", async () => {
    mocks.similar.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => track(String(i))),
    );
    expect(await refillWave(seed, context({ limit: 2 }))).toHaveLength(2);
  });
  it("stops on an exhausted catalog without changing hard exclusions", async () => {
    mocks.similar.mockResolvedValue([seed]);
    mocks.searchTracks.mockResolvedValue([seed]);
    const hard = [seed];
    expect(await refillWave(seed, context({ excluded: hard }))).toEqual([]);
    expect(hard).toEqual([seed]);
    expect(mocks.checkAvailability).not.toHaveBeenCalled();
  });
  it("tolerates unavailable audio after a successful metadata response", async () => {
    mocks.similar.mockResolvedValue([track("missing")]);
    mocks.checkAvailability.mockRejectedValue(new Error("404"));
    expect(await refillWave(seed, context())).toEqual([]);
  });
  it("retries a transient metadata failure once within a shared four-operation budget", async () => {
    mocks.similar
      .mockRejectedValueOnce(new Error("Temporary error"))
      .mockResolvedValueOnce([track("recovered")]);
    expect((await refillWave(seed, context())).map((item) => item.id)).toEqual([
      "recovered",
    ]);
    expect(mocks.similar).toHaveBeenCalledTimes(2);
    expect(
      mocks.similar.mock.calls.length + mocks.searchTracks.mock.calls.length,
    ).toBeLessThanOrEqual(4);
  });
  it("cancels stale work when its provider ignores AbortSignal", async () => {
    const controller = new AbortController();
    mocks.similar.mockImplementation(() => new Promise(() => {}));
    const pending = refillWave(seed, context(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
  it("does not start already cancelled work", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      refillWave(seed, context(), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.similar).not.toHaveBeenCalled();
  });
  it("never builds a Wave from a metadata-only or unconfirmed seed", async () => {
    expect(
      await refillWave(
        track("metadata", {
          rights: { status: "unknown", basis: "none", allowMix: false },
        }),
        context(),
      ),
    ).toEqual([]);
    expect(mocks.searchTracks).not.toHaveBeenCalled();
  });
});

describe("incremental Wave refill", () => {
  it("marks the available introduction when the planned first recording by that artist is unavailable", async () => {
    const first = track("missing-introduction", { artist: "New artist" });
    const second = track("available-introduction", { artist: "New artist" });
    mocks.similar.mockResolvedValue([first, second]);
    mocks.checkAvailability.mockImplementation(
      async (candidate: Track) => candidate.id !== first.id,
    );
    const onBatch = vi.fn();
    const ready = await refillWave(
      seed,
      context({ explorationDue: true, limit: 1, rng: () => 0 }),
      undefined,
      { initialOnly: true, onBatch },
    );
    expect(ready.map((item) => item.id)).toEqual([second.id]);
    expect(ready[0].metadata?.recommendationArtistDiscovery).toBe("true");
    expect(
      onBatch.mock.calls[0][0][0].metadata?.recommendationArtistDiscovery,
    ).toBe("true");
    expect(
      mocks.checkAvailability.mock.calls.map(([candidate]) => candidate.id),
    ).toEqual([first.id, second.id]);
  });

  it("keeps artists from the entire future queue familiar even beyond the last four entries", async () => {
    const queued = [
      track("queued-artist", { artist: "Already queued", genres: [] }),
      ...Array.from({ length: 4 }, (_, i) =>
        track(`tail-${i}`, { genres: [] }),
      ),
    ];
    const familiar = track("another-queued-song", {
      artist: "Already queued",
      genres: [],
    });
    const fresh = track("actual-introduction", {
      artist: "Actual new artist",
      genres: [],
    });
    mocks.similar.mockResolvedValue([familiar, fresh]);
    const ready = await refillWave(
      track("initial", { genres: [] }),
      context({
        limit: 2,
        recentSequence: queued,
        excluded: queued,
        rng: () => 0,
        preferences: { familiarity: "discover", mood: "any", language: "any" },
      }),
      undefined,
      { onBatch: vi.fn(), batchSize: 2 },
    );
    expect(ready.map((item) => item.id)).toEqual([fresh.id, familiar.id]);
    expect(ready[0].metadata?.recommendationArtistDiscovery).toBe("true");
    expect(ready[1].metadata?.recommendationArtistDiscovery).toBeUndefined();
  });

  it("reserves a due discovery slot even when favorites and the artist page already fill the batch", async () => {
    const initial = track("initial", { artist: "Known artist", genres: [] });
    const favorite = track("favorite", { artist: "Known artist", genres: [] });
    const neighbor = track("neighbor", {
      artist: "Actual related artist",
      genres: [],
    });
    mocks.similar.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) =>
        track(`known-${i}`, { artist: initial.artist, genres: [] }),
      ),
    );
    mocks.related.mockResolvedValue([neighbor.artist]);
    let release!: (tracks: Track[]) => void;
    mocks.searchTracks.mockImplementationOnce(
      () =>
        new Promise<Track[]>((resolve) => {
          release = resolve;
        }),
    );
    const onBatch = vi.fn();
    const pending = refillWave(
      initial,
      context({ favorites: [favorite], explorationDue: true, limit: 2 }),
      undefined,
      { onBatch },
    );
    await vi.waitFor(() =>
      expect(mocks.searchTracks).toHaveBeenCalledWith(
        neighbor.artist,
        expect.any(AbortSignal),
      ),
    );
    expect(onBatch).not.toHaveBeenCalled();
    release([neighbor]);
    const ready = await pending;
    expect(ready[0].id).toBe(neighbor.id);
    expect(ready[0].metadata?.recommendationArtistDiscovery).toBe("true");
    expect(ready).toHaveLength(2);
    expect(
      mocks.similar.mock.calls.length +
        mocks.related.mock.calls.length +
        mocks.searchTracks.mock.calls.length,
    ).toBeLessThanOrEqual(4);
  });

  it("prefers a co-credit artist's solo catalog before broad or familiar searches", async () => {
    const initial = track("initial", { artist: "Known artist", genres: [] });
    mocks.similar.mockResolvedValue([
      track("duet", { artist: "Known artist, New collaborator", genres: [] }),
    ]);
    mocks.searchTracks.mockResolvedValue([
      track("solo", { artist: "New collaborator", genres: [] }),
    ]);
    const ready = await refillWave(
      initial,
      context({ explorationDue: true, limit: 1 }),
      undefined,
      { initialOnly: true },
    );
    expect(mocks.searchTracks).toHaveBeenNthCalledWith(
      1,
      "New collaborator",
      expect.any(AbortSignal),
    );
    expect(mocks.related).not.toHaveBeenCalled();
    expect(ready[0].id).toBe("solo");
  });

  it("falls back to familiar playable songs after bounded empty discovery channels", async () => {
    const favorite = track("favorite", { artist: seed.artist });
    mocks.similar.mockResolvedValue([
      track("unheard", { artist: seed.artist }),
    ]);
    const onBatch = vi.fn();
    const ready = await refillWave(
      seed,
      context({ favorites: [favorite], explorationDue: true, limit: 1 }),
      undefined,
      { initialOnly: true, onBatch },
    );
    expect(ready).toHaveLength(1);
    expect(ready[0].metadata?.recommendationArtistDiscovery).not.toBe("true");
    expect(mocks.searchTracks).toHaveBeenCalledWith(
      "популярная музыка",
      expect.any(AbortSignal),
    );
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(
      mocks.similar.mock.calls.length +
        mocks.related.mock.calls.length +
        mocks.searchTracks.mock.calls.length,
    ).toBeLessThanOrEqual(4);
  });

  it("does not spend availability checks or emit a familiar fallback while a due discovery search is pending", async () => {
    const favorite = track("favorite", { artist: seed.artist });
    mocks.related.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const onBatch = vi.fn();
    const pending = refillWave(
      seed,
      context({ favorites: [favorite], explorationDue: true }),
      controller.signal,
      { onBatch },
    );
    const cancelled = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(mocks.related).toHaveBeenCalled());
    expect(mocks.checkAvailability).not.toHaveBeenCalled();
    expect(onBatch).not.toHaveBeenCalled();
    controller.abort();
    await cancelled;
  });
  it("returns only the first saved recording in initial-only offline mode", async () => {
    const onBatch = vi.fn();
    const ready = await refillWave(
      seed,
      context({
        offline: true,
        collection: [track("saved-a"), track("saved-b")],
      }),
      undefined,
      { initialOnly: true, batchSize: 2, onBatch },
    );
    expect(ready).toHaveLength(1);
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(onBatch.mock.calls[0][0]).toHaveLength(1);
    expect(mocks.searchTracks).not.toHaveBeenCalled();
    expect(mocks.checkAvailability).not.toHaveBeenCalled();
  });

  it("finishes a complete small background batch without starting slower extra selectors", async () => {
    mocks.similar.mockResolvedValue([
      track("first"),
      track("second"),
      track("third"),
    ]);
    mocks.searchTracks.mockImplementation(() => new Promise(() => {}));
    const onBatch = vi.fn();
    const ready = await refillWave(seed, context({ limit: 2 }), undefined, {
      onBatch,
      batchSize: 2,
    });
    expect(ready).toHaveLength(2);
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(mocks.checkAvailability).toHaveBeenCalledTimes(2);
    expect(mocks.searchTracks).not.toHaveBeenCalled();
  });

  it.each([1, 2])(
    "initial-only publishes one available track from %i candidates without waiting to fill a two-track batch",
    async (count) => {
      mocks.similar.mockResolvedValue(
        Array.from({ length: count }, (_, index) => track(`first-${index}`)),
      );
      mocks.checkAvailability
        .mockResolvedValueOnce(true)
        .mockImplementation(() => new Promise(() => {}));
      const onBatch = vi.fn();
      const ready = await refillWave(
        seed,
        context({ limit: 2, rng: () => 0 }),
        undefined,
        { onBatch, initialOnly: true, batchSize: 2 },
      );
      expect(ready.map((item) => item.id)).toEqual(["first-0"]);
      expect(onBatch).toHaveBeenCalledTimes(1);
      expect(mocks.checkAvailability).toHaveBeenCalledTimes(1);
      expect(mocks.searchTracks).not.toHaveBeenCalled();
    },
  );

  it("publishes the first useful batch before a slower later selector finishes", async () => {
    const first = track("first"),
      later = track("later");
    mocks.similar.mockResolvedValue([first]);
    let release!: (tracks: Track[]) => void;
    mocks.searchTracks.mockImplementationOnce(
      () =>
        new Promise<Track[]>((resolve) => {
          release = resolve;
        }),
    );
    const onBatch = vi.fn();
    let settled = false;
    const pending = refillWave(seed, context({ limit: 2 }), undefined, {
      onBatch,
      batchSize: 1,
    });
    void pending.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(mocks.searchTracks).toHaveBeenCalled());
    expect(
      onBatch.mock.calls.map(([batch]) => batch.map((item: Track) => item.id)),
    ).toEqual([[first.id]]);
    expect(settled).toBe(false);
    release([later]);
    const ready = await pending;
    expect(ready.map((item) => item.id)).toEqual([first.id, later.id]);
    expect(
      onBatch.mock.calls.flatMap(([batch]) =>
        batch.map((item: Track) => item.id),
      ),
    ).toEqual([first.id, later.id]);
  });

  it("returns one first track without waiting for the remaining catalog selectors", async () => {
    mocks.similar.mockResolvedValue([track("first"), track("second")]);
    mocks.searchTracks.mockImplementation(() => new Promise(() => {}));
    const ready = await refillWave(seed, context({ limit: 1 }), undefined, {
      initialOnly: true,
      batchSize: 1,
    });
    expect(ready).toHaveLength(1);
    expect(mocks.searchTracks).not.toHaveBeenCalled();
    expect(mocks.checkAvailability).toHaveBeenCalledTimes(1);
  });

  it("does not emit later batches after cancellation from the first batch", async () => {
    const controller = new AbortController();
    mocks.similar.mockResolvedValue([track("first"), track("second")]);
    const onBatch = vi.fn(() => controller.abort());
    await expect(
      refillWave(seed, context(), controller.signal, { onBatch, batchSize: 1 }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(mocks.searchTracks).not.toHaveBeenCalled();
  });

  it("keeps already published music if an extra selector reports a quota error", async () => {
    const first = track("first");
    mocks.similar.mockResolvedValue([first]);
    mocks.searchTracks.mockRejectedValue(
      Object.assign(new Error("Quota"), { code: "quota" }),
    );
    const onBatch = vi.fn();
    const ready = await refillWave(seed, context(), undefined, {
      onBatch,
      batchSize: 1,
    });
    expect(ready.map((item) => item.id)).toEqual([first.id]);
    expect(onBatch).toHaveBeenCalledTimes(1);
  });

  it("preserves partial progress when later providers ignore cancellation until the deadline", async () => {
    vi.useFakeTimers();
    try {
      const first = track("first");
      mocks.similar.mockResolvedValue([first]);
      mocks.searchTracks.mockImplementation(() => new Promise(() => {}));
      const onBatch = vi.fn();
      const pending = refillWave(seed, context(), undefined, {
        onBatch,
        batchSize: 1,
      });
      const checked = expect(pending).resolves.toMatchObject([
        { id: first.id },
      ]);
      await vi.advanceTimersByTimeAsync(30000);
      await checked;
      expect(onBatch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never republishes a duplicate recording and keeps availability checks bounded", async () => {
    const first = track("first");
    const alias = {
      ...first,
      id: "alias",
      sourceId: "licensed",
      title: `${first.title} (Official Audio)`,
    };
    mocks.similar.mockResolvedValue([first]);
    mocks.searchTracks.mockResolvedValue([
      alias,
      ...Array.from({ length: 20 }, (_, i) => track(`extra-${i}`)),
    ]);
    const onBatch = vi.fn();
    const ready = await refillWave(seed, context(), undefined, {
      onBatch,
      batchSize: 2,
    });
    expect(ready).toHaveLength(7);
    expect(ready.some((item) => item.id === alias.id)).toBe(false);
    const batches = onBatch.mock.calls.map(([batch]) => batch as Track[]);
    expect(batches.every((batch) => batch.length <= 2)).toBe(true);
    expect(
      new Set(batches.flatMap((batch) => batch.map((item) => item.id))).size,
    ).toBe(7);
    expect(mocks.checkAvailability.mock.calls.length).toBeLessThanOrEqual(14);
  });
});

describe("cold-start discovery", () => {
  it("uses arbitrary queries and skips unavailable or unauthorized results", async () => {
    const noRights = track("metadata", {
      rights: { status: "unknown", basis: "none", allowMix: false },
    });
    const missing = track("missing"),
      available = track("available");
    mocks.searchTracks.mockResolvedValue([noRights, missing, available]);
    mocks.checkAvailability.mockImplementation(
      async (item: Track) => item.id !== "missing",
    );
    expect(await discoverWaveSeed("джаз для работы")).toMatchObject(available);
    expect(mocks.searchTracks).toHaveBeenCalledWith(
      "джаз для работы",
      expect.any(AbortSignal),
    );
    expect(mocks.top).not.toHaveBeenCalled();
  });
  it("does not replace an explicit empty artist query with demo music", async () => {
    mocks.top.mockResolvedValue([seed]);
    expect(await discoverWaveSeed("Несуществующий артист")).toBeNull();
    expect(mocks.top).not.toHaveBeenCalled();
  });
  it("lets a generic new-listener request use an available authorized chart", async () => {
    mocks.top.mockResolvedValue([seed]);
    expect(await discoverWaveSeed("популярная музыка")).toMatchObject(seed);
  });
  it("keeps the original source configuration explanation", async () => {
    const error = Object.assign(new Error("Каталог ещё не подключён"), {
      code: "credentials",
    });
    mocks.searchTracks.mockRejectedValue(error);
    await expect(discoverWaveSeed("музыка")).rejects.toBe(error);
  });
  it("uses a recent positive artist to direct a generic launch", async () => {
    const now = Date.now();
    const recent = track("recent", { artist: "Новый любимый артист" });
    const event: TasteSignal = {
      id: "recent-positive",
      trackId: recent.id,
      track: recent,
      kind: "like",
      at: now - 1_000,
    };
    mocks.searchTracks.mockResolvedValue([recent]);
    expect(
      await discoverWaveSeed("", undefined, context({ now, signals: [event] })),
    ).toMatchObject(recent);
    expect(mocks.searchTracks).toHaveBeenCalledWith(
      recent.artist,
      expect.any(AbortSignal),
    );
  });
  it("can launch known permitted favorites during an ordinary metadata outage", async () => {
    const favorite = track("favorite");
    mocks.searchTracks.mockRejectedValue(new Error("Сеть недоступна"));
    expect(
      await discoverWaveSeed("", undefined, context({ favorites: [favorite] })),
    ).toMatchObject(favorite);
  });
  it("does not mutate a provider's cached result array when adding personal candidates", async () => {
    const results: Track[] = [];
    const favorite = track("favorite");
    mocks.searchTracks.mockResolvedValue(results);
    await discoverWaveSeed("", undefined, context({ favorites: [favorite] }));
    expect(results).toEqual([]);
  });
  it("keeps new-artist provenance on the first recommendation without changing the provider's cached object", async () => {
    const candidate = track("new-artist");
    mocks.searchTracks.mockResolvedValue([candidate]);
    const result = await discoverWaveSeed("ambient");
    expect(result?.id).toBe(candidate.id);
    expect(result?.metadata?.recommendationArtistDiscovery).toBe("true");
    expect(candidate.metadata).toBeUndefined();
  });
  it("skips a stale recording whose availability request fails", async () => {
    const stale = track("stale"),
      available = track("available");
    mocks.searchTracks.mockResolvedValue([stale, available]);
    mocks.checkAvailability.mockImplementation(async (candidate: Track) => {
      if (candidate.id === stale.id) throw new Error("404");
      return true;
    });
    expect(
      await discoverWaveSeed("ambient", undefined, context({ rng: () => 0 })),
    ).toMatchObject(available);
  });
});

describe("personal and session retrieval selectors", () => {
  it("uses current session, lifetime favorites and genres as separate selectors", () => {
    const now = Date.now();
    const recent = track("session", {
      artist: "Session artist",
      genres: ["jazz"],
    });
    const favorite = track("favorite", {
      artist: "Favorite artist",
      genres: ["soul"],
    });
    const queries = waveRetrievalQueries(
      seed,
      context({
        now,
        favorites: [favorite],
        signals: [
          {
            id: "session",
            trackId: recent.id,
            track: recent,
            kind: "like",
            at: now - 1_000,
          },
        ],
      }),
    );
    expect(queries).toContain(recent.artist);
    expect(queries).toContain(favorite.artist);
    expect(queries.indexOf(recent.artist)).toBeLessThan(
      queries.indexOf(seed.artist),
    );
    expect(queries).toContain("ambient");
  });
  it("does not send imported personal-file artist names to a remote selector", () => {
    const personal = track("private", {
      sourceId: "local",
      local: true,
      artist: "Private rehearsal name",
    });
    expect(
      waveRetrievalQueries(seed, context({ favorites: [personal] })),
    ).not.toContain(personal.artist);
    expect(waveRetrievalQueries(personal, context())).toEqual([]);
  });
  it("never lets future feedback direct current music retrieval", () => {
    const now = Date.now(),
      future = track("future", { artist: "Future artist" });
    expect(
      waveRetrievalQueries(
        seed,
        context({
          now,
          signals: [
            {
              id: "future",
              trackId: future.id,
              track: future,
              kind: "like",
              at: now + 60_000,
            },
          ],
        }),
      ),
    ).not.toContain(future.artist);
  });
  it("does not stop at a full first artist page and samples a broader catalog", async () => {
    const sameArtist = Array.from({ length: 10 }, (_, index) =>
      track(`same-${index}`, { artist: seed.artist }),
    );
    mocks.similar.mockResolvedValue(sameArtist);
    mocks.searchTracks.mockImplementation(async (query: string) =>
      query === "популярная музыка" ? [track("discovery")] : [],
    );
    await refillWave(seed, context());
    expect(mocks.searchTracks).toHaveBeenCalledWith(
      "популярная музыка",
      expect.any(AbortSignal),
    );
    expect(
      mocks.similar.mock.calls.length + mocks.searchTracks.mock.calls.length,
    ).toBeLessThanOrEqual(4);
  });
  it("uses real collaboration credits to find new artists when genre metadata is missing", async () => {
    const initial = track("initial", { artist: "madk1d", genres: [] });
    mocks.similar.mockResolvedValue([
      track("duet", { artist: "VILLIAN, madk1d", genres: [] }),
    ]);
    mocks.searchTracks.mockImplementation(async (query: string) =>
      query === "VILLIAN"
        ? [track("neighbor", { artist: "VILLIAN", genres: [] })]
        : [],
    );
    const result = await refillWave(initial, context());
    expect(mocks.searchTracks).toHaveBeenCalledWith(
      "VILLIAN",
      expect.any(AbortSignal),
    );
    expect(result.some((item) => item.id === "neighbor")).toBe(true);
    expect(result.every((item) => item.genres.length === 0)).toBe(true);
    expect(
      mocks.similar.mock.calls.length + mocks.searchTracks.mock.calls.length,
    ).toBeLessThanOrEqual(4);
  });
  it("uses explicit mood and language to retrieve a matching pool", () => {
    const queries = waveRetrievalQueries(
      seed,
      context({
        preferences: {
          familiarity: "discover",
          mood: "calm",
          language: "russian",
        },
      }),
    );
    expect(queries).toContain("русская музыка спокойная музыка");
  });
  it("ranks the first available choice with the same hard exclusions and preferences", () => {
    const forbidden = track("forbidden"),
      favorite = track("favorite");
    expect(
      chooseWaveSeed(
        [forbidden, favorite],
        context({
          dislikedIds: [forbidden.id],
          favorites: [favorite],
          rng: () => 0,
        }),
      ),
    ).toMatchObject(favorite);
    expect(
      chooseWaveSeed([forbidden], context({ excluded: [forbidden] })),
    ).toBeNull();
  });
  it("never reuses a repeated pagination token beyond its bounded page budget", async () => {
    mocks.searchPage.mockResolvedValue({ tracks: [], nextPageToken: "repeat" });
    await refillWave(
      track("licensed", { sourceId: "licensed", genres: ["music"] }),
      context(),
    );
    expect(
      mocks.searchPage.mock.calls.length +
        mocks.top.mock.calls.length +
        mocks.searchTracks.mock.calls.length,
    ).toBeLessThanOrEqual(4);
    expect(
      mocks.searchPage.mock.calls.filter(
        ([, options]) => options.pageToken === "repeat",
      ),
    ).toHaveLength(1);
  });
});
