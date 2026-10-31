import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { MusicDatabase } from "./db";
import {
  hydrateCuePoints,
  normalizeCuePoints,
  saveCuePoints,
} from "./cue-points";
import type { Track } from "../../types/music";

const track: Track = {
  id: "licensed:own-recording",
  sourceId: "licensed",
  title: "Own recording",
  artist: "Author",
  duration: 120,
  genres: [],
  license: { name: "Permission", download: false },
  playbackMode: "audio",
  rights: { status: "confirmed", basis: "license", allowMix: true },
  cuePoints: {
    cueInSeconds: 16,
    cueOutSeconds: 108,
    cueConfidence: 0.9,
    cueSource: "licensed_metadata",
  },
};
const databases: MusicDatabase[] = [];
const database = () => {
  const value = new MusicDatabase(`cue-test-${crypto.randomUUID()}`);
  databases.push(value);
  return value;
};
afterEach(async () => {
  for (const value of databases.splice(0)) await value.delete();
});

describe("persistent musical cue marks", () => {
  it("restores explicit marks after reopening the profile without changing rights", async () => {
    const value = database();
    await saveCuePoints(track, value, 1000);
    value.close();
    await value.open();
    const restored = await hydrateCuePoints(
      { ...track, cuePoints: undefined },
      value,
    );
    expect(restored.cuePoints).toEqual({ ...track.cuePoints, updatedAt: 1000 });
    expect(restored.rights).toEqual(track.rights);
    expect(restored.audioSource).toBeUndefined();
  });

  it("prefers current canonical author marks to older cached marks", async () => {
    const value = database();
    await saveCuePoints(track, value, 1000);
    const canonical = {
      ...track,
      cuePoints: {
        ...track.cuePoints!,
        cueInSeconds: 8,
        cueSource: "manual" as const,
      },
    };
    expect(
      (await hydrateCuePoints(canonical, value, 2000)).cuePoints,
    ).toMatchObject({
      cueInSeconds: 8,
      cueSource: "manual",
      updatedAt: 2000,
    });
    expect((await value.trackCuePoints.get(track.id))?.cueInSeconds).toBe(8);
  });

  it("does not persist or restore cues for unconfirmed metadata-only tracks", async () => {
    const value = database();
    await saveCuePoints(track, value);
    const unknown = {
      ...track,
      cuePoints: undefined,
      playbackMode: "metadata" as const,
      rights: {
        status: "unknown" as const,
        basis: "none" as const,
        allowMix: false,
      },
    };
    expect((await hydrateCuePoints(unknown, value)).cuePoints).toBeUndefined();
    expect(
      await saveCuePoints(
        { ...unknown, id: "unknown", cuePoints: track.cuePoints },
        value,
      ),
    ).toBeNull();
    expect(await value.trackCuePoints.get("unknown")).toBeUndefined();
  });

  it("revalidates cached positions against a newly supplied shorter duration", async () => {
    const value = database();
    await saveCuePoints(track, value, 1000);
    const restored = await hydrateCuePoints(
      { ...track, duration: 10, cuePoints: undefined },
      value,
    );
    expect(restored.cuePoints).toMatchObject({
      cueInSeconds: 8,
      cueOutSeconds: 9.75,
    });
  });

  it.each([
    { cueInSeconds: NaN },
    { cueInSeconds: Infinity },
    { cueInSeconds: -1 },
    { cueConfidence: 1.1 },
    { cueConfidence: -0.1 },
    { cueSource: "guessed" },
    { cueInSeconds: 40, cueOutSeconds: 20 },
  ])("rejects malformed marks rather than inventing a cue: %j", (patch) => {
    expect(
      normalizeCuePoints({ ...track.cuePoints, ...patch }, track.duration),
    ).toBeNull();
  });

  it("keeps low-confidence observations for later review but does not promote confidence", async () => {
    const value = database();
    const points = await saveCuePoints(
      { ...track, cuePoints: { ...track.cuePoints!, cueConfidence: 0.3 } },
      value,
      1000,
    );
    expect(points?.cueConfidence).toBe(0.3);
  });
});
