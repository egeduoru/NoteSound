import { describe, expect, it } from "vitest";
import type { TasteSignal, Track } from "../../types/music";
import { defaultWavePreferences } from "../../types/music";
import {
  buildWaveCandidates,
  isAuthorizedAudio,
  isWaveAudio,
  isNewWaveArtist,
  recommendationShares,
  type WaveContext,
} from "./recommendation";
import { seededRandom } from "../taste/profile";
const track = (id: string, extra: Partial<Track> = {}): Track => ({
  id,
  sourceId: "licensed",
  title: `Song ${id}`,
  artist: `Artist ${id}`,
  duration: 180,
  genres: ["ambient"],
  rights: { status: "confirmed", basis: "license", allowMix: true },
  license: { name: "Licensed", download: false },
  ...extra,
});
const seed = track("seed");
const ctx = (extra: Partial<WaveContext> = {}): WaveContext => ({
  history: [],
  favorites: [],
  excluded: [],
  diversity: 0.25,
  now: 40 * 86400_000,
  rng: seededRandom(10),
  ...extra,
});
const ids = (tracks: Track[]) => tracks.map((item) => item.id);
const signal = (
  kind: TasteSignal["kind"],
  item: Track,
  at = 1,
): TasteSignal => ({
  id: `${kind}:${item.id}:${at}`,
  trackId: item.id,
  track: item,
  kind,
  at,
  playedSeconds: 150,
});

describe("Smart Wave recommendation", () => {
  it("has 40/30/20/10 target shares at default intensity", () => {
    const shares = recommendationShares();
    expect(shares.similar).toBeCloseTo(0.4);
    expect(shares.personal).toBeCloseTo(0.3);
    expect(shares.discovery).toBeCloseTo(0.2);
    expect(shares.popular).toBeCloseTo(0.1);
  });
  it("discovery control changes shares while keeping a nonzero discovery allowance at zero", () => {
    expect(recommendationShares(1).discovery).toBeGreaterThan(
      recommendationShares(0).discovery,
    );
    expect(recommendationShares(0).discovery).toBeGreaterThan(0);
    expect(
      Object.values(recommendationShares(1)).reduce((a, b) => a + b),
    ).toBeCloseTo(1);
  });
  it("excludes current/queued/in-flight recordings including alternate names", () => {
    const queued = track("queued", { title: "Группа крови", artist: "Кино" });
    const duplicate = track("foreign", {
      title: "Группа крови (Official Audio)",
      artist: "КИНО",
    });
    const fresh = track("fresh");
    expect(
      ids(
        buildWaveCandidates(
          seed,
          [seed, queued, duplicate, fresh],
          ctx({ excluded: [queued] }),
        ),
      ),
    ).toEqual(["fresh"]);
  });
  it("deduplicates cross-source publications without mutating source metadata", () => {
    const first = track("one"),
      same = { ...first, id: "two", sourceId: "other" };
    const result = buildWaveCandidates(seed, [first, same], ctx());
    expect(result).toHaveLength(1);
    expect(first.metadata).toBeUndefined();
    expect(result[0].metadata?.recommendationReason).toBeTruthy();
  });
  it("rejects metadata, denied rights, unknown rights and embedded YouTube even when an MP3 URL exists", () => {
    const bad = [
      track("metadata", { playbackMode: "metadata" }),
      track("denied", {
        rights: { status: "denied", basis: "license", allowMix: false },
      }),
      track("unknown", {
        rights: undefined,
        streamUrl: "https://example.com/file.mp3",
      }),
      track("youtube", {
        playback: { kind: "youtube", videoId: "abcdefghijk" },
      }),
      track("gone", { availability: "unavailable" }),
    ];
    expect(buildWaveCandidates(seed, bad, ctx())).toEqual([]);
    expect(bad.every((item) => !isAuthorizedAudio(item))).toBe(true);
  });
  it("keeps an authorized publication when the same metadata-only recording appears first", () => {
    const permitted = track("licensed");
    const metadata = {
      ...permitted,
      id: "unknown",
      rights: undefined,
      playbackMode: "metadata" as const,
    };
    expect(
      ids(buildWaveCandidates(seed, [metadata, permitted], ctx())),
    ).toEqual([permitted.id]);
  });
  it("includes a full provider stream without upgrading its copyright or Mix rights", () => {
    const publicTrack = track("public:la-full", {
      sourceId: "public",
      streamAccess: "provider_stream",
      playbackMode: "audio",
      availability: "available",
      rights: { status: "unknown", basis: "none", allowMix: false },
      streamUrl: "https://storage6.lightaudio.ru/dm/song.mp3",
    });
    const originalRights = { ...publicTrack.rights };
    expect(isAuthorizedAudio(publicTrack)).toBe(false);
    expect(isWaveAudio(publicTrack)).toBe(true);
    const result = buildWaveCandidates(seed, [publicTrack], ctx());
    expect(ids(result)).toEqual([publicTrack.id]);
    expect(result[0].rights).toEqual(originalRights);
    expect(result[0].rights?.allowMix).toBe(false);
    expect(result[0].license.download).toBe(false);
  });
  it("excludes previews and denied full streams from Wave even if metadata suggests playback", () => {
    const full = track("public:la-full", {
      sourceId: "public",
      streamAccess: "provider_stream",
      playbackMode: "audio",
      availability: "available",
      rights: { status: "unknown", basis: "none", allowMix: false },
    });
    const denied = {
      ...full,
      id: "public:la-denied",
      rights: {
        status: "denied" as const,
        basis: "none" as const,
        allowMix: false,
      },
    };
    const preview = track("deezer:123", {
      sourceId: "deezer",
      streamAccess: "preview",
      playbackMode: "audio",
      availability: "available",
      rights: { status: "confirmed", basis: "license", allowMix: false },
    });
    expect(isWaveAudio(preview)).toBe(false);
    expect(isWaveAudio(denied)).toBe(false);
    expect(buildWaveCandidates(seed, [preview, denied], ctx())).toEqual([]);
  });
  it("supports trusted existing personal files and bundled CC0 during migration", () => {
    expect(
      isAuthorizedAudio(
        track("local", { rights: undefined, sourceId: "local", local: true }),
      ),
    ).toBe(true);
    expect(
      isAuthorizedAudio(
        track("original", { rights: undefined, sourceId: "notesound" }),
      ),
    ).toBe(true);
  });
  it("never relaxes a dislike and recognizes a duplicate recording", () => {
    const disliked = track("bad", { artist: "Кино", title: "Группа крови" });
    const alias = track("alias", {
      artist: "КИНО",
      title: "Группа крови (Official Video)",
    });
    const good = track("good");
    expect(
      ids(
        buildWaveCandidates(
          seed,
          [alias, good],
          ctx({ signals: [signal("dislike", disliked)] }),
        ),
      ),
    ).toEqual(["good"]);
    expect(
      buildWaveCandidates(seed, [good], ctx({ dislikedIds: [good.id] })),
    ).toEqual([]);
  });
  it("prioritizes unseen-in-30-days tracks then gradually relaxes history for a small catalog", () => {
    const recent = [track("recent-a"), track("recent-b")],
      fresh = track("fresh");
    const result = buildWaveCandidates(
      seed,
      [...recent, fresh],
      ctx({
        history: recent.map((item) => ({
          track: item,
          playedAt: 39 * 86400_000,
        })),
      }),
    );
    expect(result[0].id).toBe("fresh");
    expect(result).toHaveLength(3);
    expect(new Set(ids(result)).size).toBe(3);
  });
  it("does not exclude lifetime history older than thirty days", () => {
    const old = track("old");
    expect(
      ids(
        buildWaveCandidates(
          seed,
          [old],
          ctx({ history: [{ track: old, playedAt: 1 }] }),
        ),
      ),
    ).toEqual([old.id]);
  });
  it("keeps at most two songs of an artist in any five when the pool permits", () => {
    const candidates = [1, 2, 3, 4]
      .map((i) => track(`a${i}`, { artist: "Artist A" }))
      .concat(
        [1, 2, 3, 4].map((i) => track(`b${i}`, { artist: "Artist B" })),
        [1, 2, 3, 4].map((i) => track(`c${i}`, { artist: "Artist C" })),
      );
    const result = buildWaveCandidates(seed, candidates, ctx());
    for (let i = 0; i <= result.length - 5; i++)
      for (const artist of new Set(
        result.slice(i, i + 5).map((item) => item.artist),
      ))
        expect(
          result.slice(i, i + 5).filter((item) => item.artist === artist)
            .length,
        ).toBeLessThanOrEqual(2);
  });
  it("relaxes artist caps when only one artist exists without duplicating the same track", () => {
    const candidates = [1, 2, 3].map((i) =>
      track(String(i), { artist: seed.artist }),
    );
    expect(buildWaveCandidates(seed, candidates, ctx())).toHaveLength(3);
  });
  it("uses the previous queue tail when selecting the next artist", () => {
    const tail = track("tail", { artist: "Queued artist" });
    const matching = track("matching", { artist: tail.artist });
    const other = track("other");
    expect(
      buildWaveCandidates(
        seed,
        [matching, other],
        ctx({ previousTrack: tail, excluded: [tail] }),
      )[0].id,
    ).toBe(other.id);
  });
  it("is reproducible with a seed and is not permanently tied to the maximum score", () => {
    const candidates = Array.from({ length: 16 }, (_, i) => track(String(i)));
    const first = ids(
      buildWaveCandidates(seed, candidates, ctx({ rng: seededRandom(123) })),
    );
    expect(
      ids(
        buildWaveCandidates(seed, candidates, ctx({ rng: seededRandom(123) })),
      ),
    ).toEqual(first);
    expect(
      ids(
        buildWaveCandidates(seed, candidates, ctx({ rng: seededRandom(999) })),
      ),
    ).not.toEqual(first);
  });
  it("rewards preferences without turning an early skip into a permanent ban", () => {
    const preferred = track("preferred", { artist: "Favorite" }),
      skipped = track("skipped");
    const result = buildWaveCandidates(
      seed,
      [preferred, skipped],
      ctx({
        favorites: [preferred],
        signals: [signal("skip", skipped)],
        rng: () => 0,
      }),
    );
    expect(result[0].id).toBe(preferred.id);
    expect(ids(result)).toContain(skipped.id);
  });
  it("works for a new listener with missing genres without inventing BPM or mood", () => {
    const unknown = track("unknown", { genres: [], metadata: undefined });
    const result = buildWaveCandidates(
      track("seed", { genres: [] }),
      [unknown],
      ctx(),
    );
    expect(result[0].genres).toEqual([]);
    expect(Object.keys(result[0].metadata ?? {})).toEqual([
      "recommendationReason",
      "recommendationArtistDiscovery",
    ]);
  });
  it("does not label a track as popular unless chart information exists", () => {
    const plain = track("plain", { genres: [] });
    expect(
      buildWaveCandidates(seed, [plain], ctx({ rng: () => 0.999 }))[0].metadata
        ?.recommendationReason,
    ).toBe("discovery");
    const popular = track("chart", { genres: [], popularity: 2 });
    expect(
      buildWaveCandidates(seed, [popular], ctx({ rng: () => 0.999 }))[0]
        .metadata?.recommendationReason,
    ).toBe("popular");
  });
  it("does not invent a discovery reason for a familiar recording whose metadata says nothing else", () => {
    const familiar = track("familiar", {
      genres: [],
      metadata: { recommendationReason: "discovery" },
    });
    const result = buildWaveCandidates(
      track("seed", { genres: [] }),
      [familiar],
      ctx({ history: [{ track: familiar, playedAt: 1 }] }),
    );
    expect(result[0].metadata?.recommendationReason).toBeUndefined();
  });
  it("relaxes recent-history protection before violating the artist cap when an alternative exists", () => {
    const artistA = track("a", { artist: "A" }),
      olderB = track("b", { artist: "B" });
    const recentSequence = [
      track("a1", { artist: "A" }),
      track("a2", { artist: "A" }),
    ];
    expect(
      buildWaveCandidates(
        seed,
        [artistA, olderB],
        ctx({
          recentSequence,
          history: [{ track: olderB, playedAt: 39 * 86400_000 }],
        }),
      )[0].id,
    ).toBe(olderB.id);
  });
  it("bounds a default recommendation batch to seven and handles empty catalog", () => {
    expect(
      buildWaveCandidates(
        seed,
        Array.from({ length: 40 }, (_, i) => track(String(i))),
        ctx(),
      ),
    ).toHaveLength(7);
    expect(buildWaveCandidates(seed, [], ctx())).toEqual([]);
    expect(
      buildWaveCandidates(seed, [track("one")], ctx({ limit: 0 })),
    ).toEqual([]);
  });
  it("switches between familiar artists and new recordings without hard-banning either pool", () => {
    const known = track("known", { genres: [] }),
      fresh = track("fresh", { genres: [] });
    const context = { history: [{ track: known, playedAt: 1 }], rng: () => 0 };
    const familiar = buildWaveCandidates(
      seed,
      [fresh, known],
      ctx({
        ...context,
        preferences: { ...defaultWavePreferences, familiarity: "familiar" },
      }),
    );
    const discover = buildWaveCandidates(
      seed,
      [known, fresh],
      ctx({
        ...context,
        preferences: { ...defaultWavePreferences, familiarity: "discover" },
      }),
    );
    expect(familiar[0].id).toBe(known.id);
    expect(discover[0].id).toBe(fresh.id);
    expect(ids(familiar).sort()).toEqual(ids(discover).sort());
  });
  it("reserves an exploration slot for a new artist rather than an unheard song by a favorite", () => {
    const favorite = track("favorite", { artist: "Favorite", genres: [] });
    const unheardFavorite = track("unheard-favorite", {
      artist: "Favorite",
      genres: [],
    });
    const unfamiliar = track("unfamiliar", {
      artist: "New artist",
      genres: [],
    });
    const result = buildWaveCandidates(
      seed,
      [unheardFavorite, unfamiliar],
      ctx({
        favorites: [favorite],
        explorationDue: true,
        rng: () => 0,
      }),
    );
    expect(result[0].id).toBe(unfamiliar.id);
    expect(result[0].metadata?.recommendationReason).toBe("discovery");
    expect(result[0].metadata?.recommendationArtistDiscovery).toBe("true");
    expect(result[1].metadata?.recommendationArtistDiscovery).toBeUndefined();
    expect(result[1].metadata?.recommendationReason).not.toBe("discovery");
  });
  it("discover mode prefers a new artist even when a familiar artist has unheard songs", () => {
    const favorite = track("favorite", { artist: "Favorite", genres: [] });
    const unheardFavorite = track("unheard", {
      artist: "Favorite",
      genres: [],
    });
    const unfamiliar = track("new", { artist: "New", genres: [] });
    expect(
      buildWaveCandidates(
        seed,
        [unheardFavorite, unfamiliar],
        ctx({
          favorites: [favorite],
          rng: () => 0,
          preferences: { ...defaultWavePreferences, familiarity: "discover" },
        }),
      )[0].id,
    ).toBe(unfamiliar.id);
  });
  it("does not count known collaborations, the current artist, or queued artists as discoveries", () => {
    const favorite = track("favorite", { artist: "Favorite" });
    const queued = track("queued", { artist: "Queued" });
    const context = ctx({ favorites: [favorite], recentSequence: [queued] });
    expect(
      isNewWaveArtist(
        track("collaboration", { artist: "Favorite, New" }),
        context,
        seed,
      ),
    ).toBe(false);
    expect(
      isNewWaveArtist(
        track("same-seed", { artist: seed.artist }),
        context,
        seed,
      ),
    ).toBe(false);
    expect(
      isNewWaveArtist(
        track("queued-artist", { artist: queued.artist }),
        context,
        seed,
      ),
    ).toBe(false);
    expect(
      isNewWaveArtist(track("new", { artist: "New" }), context, seed),
    ).toBe(true);
  });
  it("does not count restored source labels as new artist identities", () => {
    const ambiguous = track("ambiguous", {
      artist: "трек: greyrock, tewiq, madk1d - распять",
      genres: [],
      metadata: { recommendationArtistDiscovery: "true" },
    });
    const unfamiliar = track("unfamiliar", {
      artist: "Actual new artist",
      genres: [],
    });
    const context = ctx({ explorationDue: true, rng: () => 0 });
    expect(isNewWaveArtist(ambiguous, context, seed)).toBe(false);
    const result = buildWaveCandidates(seed, [ambiguous, unfamiliar], context);
    expect(result[0].id).toBe(unfamiliar.id);
    const fallback = buildWaveCandidates(seed, [ambiguous], context);
    expect(ids(fallback)).toEqual([ambiguous.id]);
    expect(fallback[0].metadata?.recommendationArtistDiscovery).toBeUndefined();
    expect(fallback[0].metadata?.recommendationReason).not.toBe("discovery");
    for (const artist of ["Песня: A", "Track: B", " Song: C"])
      expect(isNewWaveArtist(track(artist, { artist }), context, seed)).toBe(
        false,
      );
  });
  it("keeps a known-only catalog playable and removes stale discovery markers", () => {
    const known = track("known", {
      artist: seed.artist,
      metadata: {
        recommendationArtistDiscovery: "true",
        recommendationReason: "discovery",
      },
    });
    const result = buildWaveCandidates(
      seed,
      [known],
      ctx({ explorationDue: true }),
    );
    expect(ids(result)).toEqual([known.id]);
    expect(result[0].metadata?.recommendationArtistDiscovery).toBeUndefined();
    expect(result[0].metadata?.recommendationReason).toBe("similar");
    expect(known.metadata?.recommendationArtistDiscovery).toBe("true");
  });
  it("marks only the first introduction of an artist in a recommendation batch", () => {
    const result = buildWaveCandidates(
      seed,
      [track("one", { artist: "New" }), track("two", { artist: "New" })],
      ctx({ explorationDue: true }),
    );
    expect(result[0].metadata?.recommendationArtistDiscovery).toBe("true");
    expect(result[1].metadata?.recommendationArtistDiscovery).toBeUndefined();
    expect(result[1].metadata?.recommendationReason).not.toBe("discovery");
  });
  it("follows the recent calm session after a longstanding rock preference", () => {
    const now = 40 * 86400_000;
    const rock = track("rock", { artist: "Rock artist", genres: ["rock"] });
    const calm = track("calm", { artist: "Calm artist", genres: ["ambient"] });
    const rockNew = track("rock-new", { genres: ["rock"] });
    const calmNew = track("calm-new", { genres: ["ambient"] });
    const signals = [
      ...Array.from({ length: 20 }, (_, i) =>
        signal(
          "listen",
          { ...rock, id: `old${i}`, title: `Old ${i}` },
          now - 2 * 86400_000,
        ),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        signal(
          "skip",
          { ...rock, id: `skip${i}`, title: `Skipped ${i}` },
          now - (4 - i) * 60_000,
        ),
      ),
      signal("like", calm, now),
    ];
    const result = buildWaveCandidates(
      rock,
      [rockNew, calmNew],
      ctx({ now, signals, rng: () => 0 }),
    );
    expect(result[0].id).toBe(calmNew.id);
  });
  it("uses declared language and mood while leaving unknown metadata eligible", () => {
    const russian = track("russian", {
      metadata: { language: "ru", mood: "calm" },
    });
    const foreign = track("foreign", {
      metadata: { language: "en", mood: "energetic" },
    });
    const unknown = track("unknown", {
      title: "Русское название без сведений о вокале",
      genres: [],
    });
    const preferences = {
      ...defaultWavePreferences,
      language: "russian" as const,
      mood: "calm" as const,
    };
    const result = buildWaveCandidates(
      seed,
      [foreign, unknown, russian],
      ctx({ preferences, rng: () => 0 }),
    );
    expect(result[0].id).toBe(russian.id);
    expect(ids(result)).toContain(unknown.id);
    expect(ids(result)).not.toContain(foreign.id);
    expect(
      result.find((item) => item.id === unknown.id)?.metadata?.language,
    ).toBeUndefined();
  });
  it("does not relax an explicit language contradiction for a one-track catalog", () => {
    expect(
      buildWaveCandidates(
        seed,
        [track("english", { metadata: { language: "en" } })],
        ctx({
          preferences: { ...defaultWavePreferences, language: "russian" },
        }),
      ),
    ).toEqual([]);
  });
  it("a requested calm mood excludes a declared energetic favorite without guessing unknown tracks", () => {
    const energetic = track("energetic", {
      genres: [],
      metadata: { mood: "energetic" },
    });
    const calm = track("calm", { genres: [], metadata: { mood: "calm" } });
    const unknown = track("unknown", { genres: [] });
    const result = buildWaveCandidates(
      seed,
      [energetic, calm, unknown],
      ctx({
        favorites: [energetic],
        preferences: { ...defaultWavePreferences, mood: "calm" },
        rng: () => 0,
      }),
    );
    expect(ids(result)).not.toContain(energetic.id);
    expect(ids(result)).toContain(unknown.id);
    expect(result[0].id).toBe(calm.id);
  });
  it("dislikes remain hard exclusions in familiar mode and after context changes", () => {
    const bad = track("bad");
    const alias = { ...bad, id: "other-source", sourceId: "licensed" };
    expect(
      buildWaveCandidates(
        seed,
        [alias],
        ctx({
          favorites: [bad],
          signals: [signal("dislike", bad)],
          preferences: { ...defaultWavePreferences, familiarity: "familiar" },
        }),
      ),
    ).toEqual([]);
  });
});
