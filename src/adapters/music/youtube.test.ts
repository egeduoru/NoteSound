import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createYouTubeProvider,
  parseYouTubeVideo,
  parseDuration,
  rankYouTubeTracks,
  reportYouTubeAvailability,
} from "./youtube";
const video = (
  id = "Abc123xyZ_9",
  title = "An Artist - A Song (Official Audio)",
  channel = "An Artist - Topic",
) => ({
  id,
  snippet: {
    title,
    channelTitle: channel,
    categoryId: "10",
    liveBroadcastContent: "none",
    thumbnails: {
      high: { url: "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg" },
    },
  },
  contentDetails: { duration: "PT3M21S" },
  status: { embeddable: true, privacyStatus: "public" },
});
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("official dynamic YouTube search", () => {
  for (const query of [
    "VILLIAN madk1d ДИНАСТИЯ",
    "MACAN",
    "Miyagi Captain",
    "Баста Сансара",
    "The Weeknd Blinding Lights",
  ])
    it(`sends ${query} to the official live search endpoint`, async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          response({ items: [{ id: { videoId: "Abc123xyZ_9" } }] }),
        )
        .mockResolvedValueOnce(response({ items: [video()] }));
      const provider = createYouTubeProvider(() => `key-${query}`, fetcher);
      const page = await provider.searchPage(query);
      const url = new URL(fetcher.mock.calls[0][0]);
      expect(url.origin + url.pathname).toBe(
        "https://www.googleapis.com/youtube/v3/search",
      );
      expect(url.searchParams.get("q")).toBe(query);
      expect(url.searchParams.get("type")).toBe("video");
      expect(url.searchParams.get("videoCategoryId")).toBe("10");
      expect(url.searchParams.get("videoEmbeddable")).toBe("true");
      expect(page.tracks[0].duration).toBe(201);
      expect(page.tracks[0].playback).toEqual({
        kind: "youtube",
        videoId: "Abc123xyZ_9",
      });
      expect(page.tracks[0].streamUrl).toBeUndefined();
      expect(await provider.supportsDownload(page.tracks[0])).toBe(false);
    });
  it("has no canned results when the application key is missing", async () => {
    const fetcher = vi.fn();
    const provider = createYouTubeProvider(() => "", fetcher);
    await expect(provider.searchPage("Династия")).rejects.toMatchObject({
      code: "missing_key",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(provider.status).toBe("authentication_required");
  });
  it("does not request anything for an empty query", async () => {
    const fetcher = vi.fn();
    expect(
      await createYouTubeProvider(() => "key-empty", fetcher).searchPage("  "),
    ).toEqual({ tracks: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("handles genuine empty results without filling them with demo songs", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ items: [] }));
    expect(
      (
        await createYouTubeProvider(() => "key-no-results", fetcher).searchPage(
          "unfindable query",
        )
      ).tracks,
    ).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("loads another external page and caches repeated identical requests", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          items: [{ id: { videoId: "Abc123xyZ_9" } }],
          nextPageToken: "page-two",
        }),
      )
      .mockResolvedValueOnce(response({ items: [video()] }))
      .mockResolvedValueOnce(
        response({ items: [{ id: { videoId: "Def456xyZ_8" } }] }),
      )
      .mockResolvedValueOnce(
        response({
          items: [video("Def456xyZ_8", "Another Artist - New Song")],
        }),
      );
    const provider = createYouTubeProvider(() => "key-pages", fetcher);
    const first = await provider.searchPage("pagination");
    expect(first.nextPageToken).toBe("page-two");
    await provider.searchPage("pagination");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const next = await provider.searchPage("pagination", {
      pageToken: first.nextPageToken,
    });
    expect(
      new URL(fetcher.mock.calls[2][0]).searchParams.get("pageToken"),
    ).toBe("page-two");
    expect(next.tracks[0].id).toBe("youtube:Def456xyZ_8");
  });
  it.each([
    ["quotaExceeded", "quota"],
    ["keyInvalid", "credentials"],
    ["accessNotConfigured", "credentials"],
  ])("explains API error %s", async (reason, code) => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(response({ error: { errors: [{ reason }] } }, 403));
    await expect(
      createYouTubeProvider(() => `key-${reason}`, fetcher).searchPage(reason),
    ).rejects.toMatchObject({ code });
  });
  it("rejects outdated requests including a cached query", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    await expect(
      createYouTubeProvider(() => "key-abort", fetcher).searchPage("MACAN", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("turns network failures into a readable error without including the key", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(
      createYouTubeProvider(() => "do-not-print-key", fetcher).searchPage(
        "network failure",
      ),
    ).rejects.toMatchObject({ code: "network" });
  });
});
describe("music validation and ranking", () => {
  it("parses duration, artist, title and retains the original platform identifier", () => {
    expect(parseDuration("PT1H2M3S")).toBe(3723);
    expect(parseDuration("not a duration")).toBe(0);
    expect(parseYouTubeVideo(video())).toMatchObject({
      artist: "An Artist",
      title: "A Song",
      platformId: "Abc123xyZ_9",
      playbackMode: "embedded",
      license: { download: false },
    });
  });
  it("rejects nonmusic, private, blocked, short and live videos", () => {
    const raw = video();
    for (const invalid of [
      null,
      {},
      { ...raw, status: { ...raw.status, embeddable: false } },
      { ...raw, status: { ...raw.status, privacyStatus: "private" } },
      { ...raw, snippet: { ...raw.snippet, categoryId: "20" } },
      { ...raw, contentDetails: { duration: "PT15S" } },
      {
        ...raw,
        contentDetails: {
          ...raw.contentDetails,
          contentRating: { ytRating: "ytAgeRestricted" },
        },
      },
      { ...raw, snippet: { ...raw.snippet, liveBroadcastContent: "live" } },
      {
        ...raw,
        snippet: {
          ...raw.snippet,
          title: "Reaction to this song",
          channelTitle: "Music Reviews",
        },
      },
    ])
      expect(parseYouTubeVideo(invalid)).toBeNull();
  });
  it.each([
    "РЕАКЦИЯ: Певец — Небо",
    "Певец — Небо (РеАкЦиЯ!)",
    "Певец — Небо #реакции",
    "ОБЗОР / Певец — Небо",
    "Певец — Небо [РАЗБОР]",
    "Певец — Небо: УРОК",
    "Певец — Небо • ИНТЕРВЬЮ",
    "Певец — Небо [БЭКСТЕЙДЖ]",
    "Певец — Небо (тизер)",
    "Певец — Небо — СНИППЕТ",
    "Певец — Небо: отрывок",
    "Artist — Song [REACTION]",
    "Artist — Song • Review",
    "Artist — Song (Tutorial)",
    "Artist — Song: Behind-the-scenes",
    "Artist — Song (Making Of)",
    "Artist — Song [PREVIEW]",
    "Artist — Song #Shorts",
  ])("excludes non-song title markers across scripts and punctuation: %s", (title) => {
    expect(
      parseYouTubeVideo(video("Abc123xyZ_9", title, "Music Reviews")),
    ).toBeNull();
  });
  it.each(["Уроки любви", "Backstage", "Reaction"])(
    "preserves genuine Topic songs with marker words: %s",
    (title) => {
      expect(
        parseYouTubeVideo(video("Abc123xyZ_9", title, "A Singer - Topic")),
      ).toMatchObject({ title, metadata: { publication: "topic" } });
      expect(
        parseYouTubeVideo(video("Abc123xyZ_9", title, "Music Reviews")),
      ).toBeNull();
    },
  );
  it.each([
    "Певец - Небо (Официальный клип)",
    "Певец - Небо (Ремикс)",
    "Artist - Song (Live at the Hall)",
    "Artist - Song (Official Audio)",
    "Artist - Alive",
    "Artist - Reactionary",
    "Певец - Закулисный свет",
    "Певец - Контрреакция",
    "Artist - ReactionЯ",
  ])(
    "retains songs, recorded performances and whole-word lookalikes: %s",
    (title) => {
      expect(
        parseYouTubeVideo(video("Abc123xyZ_9", title, "A Music Channel")),
      ).not.toBeNull();
    },
  );
  it("ranks an official original before alternate versions and keeps the best duplicate", () => {
    const unofficial = parseYouTubeVideo(
      video("Abc123xyZ_9", "A Singer - New Song (Unofficial Audio)", "A Fan"),
    )!;
    const official = parseYouTubeVideo(
      video("Def456xyZ_8", "A Singer - New Song (Official Audio)", "A Singer"),
    )!;
    const duplicate = { ...unofficial, title: official.title };
    const remix = parseYouTubeVideo(
      video("Ghi789xyZ_7", "A Singer - New Song (Official Remix)", "A Singer"),
    )!;
    const ranked = rankYouTubeTracks(
      [duplicate, remix, unofficial, official],
      "A Singer New Song",
    );
    expect(unofficial.metadata?.publication).toBe("music");
    expect(ranked[0]).toBe(official);
    expect(ranked).not.toContain(duplicate);
    expect(ranked.indexOf(remix)).toBeGreaterThan(ranked.indexOf(unofficial));
  });
  it.each([
    ["Remix", "remix"],
    ["Ремикс", "ремикс"],
    ["Live", "live"],
    ["Кавер", "кавер"],
    ["Acoustic Version", "acoustic"],
    ["Акустическая версия", "акустика"],
    ["Karaoke", "karaoke"],
    ["Караоке", "караоке"],
    ["Instrumental", "instrumental"],
    ["Инструментал", "инструментал"],
    ["Slowed + Reverb", "slowed"],
    ["Sped Up", "spedup"],
    ["Spedup", "sped up"],
    ["Nightcore", "nightcore"],
  ])("preserves requested %s versions in ranking", (label, requested) => {
    const original = parseYouTubeVideo(
      video("Abc123xyZ_9", "A Singer - New Song (Official Audio)", "A Singer"),
    )!;
    const version = parseYouTubeVideo(
      video("Def456xyZ_8", `A Singer - New Song (${label})`, "A Singer - Topic"),
    )!;
    expect(rankYouTubeTracks([version, original], "A Singer New Song")[0]).toBe(
      original,
    );
    expect(
      rankYouTubeTracks([original, version], `A Singer New Song ${requested}`)[0],
    ).toBe(version);
  });
  it.each([
    "Acoustically",
    "Karaokeland",
    "Караокер",
    "Instrumentalist",
    "Slowedly",
    "Spedupper",
    "Nightcorewave",
  ])("does not penalize version-marker substrings in song titles: %s", (word) => {
    const title = parseYouTubeVideo(
      video("Abc123xyZ_9", `A Singer - New Song ${word}`, "A Singer - Topic"),
    )!;
    const other = parseYouTubeVideo(
      video("Def456xyZ_8", "A Singer - New Song", "A Singer - Topic"),
    )!;
    expect(rankYouTubeTracks([title, other], "A Singer New Song")[0]).toBe(title);
  });
  it("uses generic spelling equivalence and publication signals rather than a song-specific rule", () => {
    const actual = parseYouTubeVideo(
      video("Abc123xyZ_9", "madk1d - Династия", "madk1d - Topic"),
    )!;
    const other = parseYouTubeVideo(
      video("Def456xyZ_8", "Elsewhere - Unrelated", "Some Channel"),
    )!;
    expect(
      rankYouTubeTracks([other, actual, actual], "madkid Династия"),
    ).toEqual([actual, other]);
  });
  it("excludes a runtime-denied video from Wave and can recover later", async () => {
    const provider = createYouTubeProvider(() => "key-runtime");
    const track = parseYouTubeVideo(video())!;
    reportYouTubeAvailability("Abc123xyZ_9", false);
    expect(await provider.checkAvailability(track)).toBe(false);
    reportYouTubeAvailability("Abc123xyZ_9", true);
    expect(await provider.checkAvailability(track)).toBe(true);
    expect(await provider.resolveStream(track)).toBeNull();
  });
});
