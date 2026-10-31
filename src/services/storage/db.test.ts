import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { MusicDatabase, sanitizeImportedTrack } from "./db";
import type { Track } from "../../types/music";

const track: Track = {
  id: "notesound:one",
  sourceId: "notesound",
  title: "One",
  artist: "NoteSound",
  duration: 48,
  genres: ["ambient"],
  streamUrl: "https://untrusted.example/audio.mp3",
  license: { name: "CC0", download: true },
};
const databases: MusicDatabase[] = [];
function database() {
  const value = new MusicDatabase(`test-${crypto.randomUUID()}`);
  databases.push(value);
  return value;
}
afterEach(async () => {
  for (const value of databases.splice(0)) await value.delete();
});

describe("persistent library", () => {
  it("keeps favorites, history, playlists and wave identities after reopening", async () => {
    const value = database();
    await value.favorites.put({ id: track.id, track, addedAt: 1 });
    await value.history.add({ track, playedAt: 1 });
    await value.playlists.put({ id: "p", name: "Ночь", createdAt: 1 });
    await value.playlistTracks.put({
      playlistId: "p",
      trackId: track.id,
      track,
      addedAt: 1,
    });
    await value.waveHistory.put({ key: "one", track, playedAt: 1 });
    value.close();
    await value.open();
    expect((await value.favorites.get(track.id))?.track.title).toBe("One");
    expect(await value.history.count()).toBe(1);
    expect(
      (await value.playlistTracks.where("playlistId").equals("p").first())
        ?.trackId,
    ).toBe(track.id);
    expect(await value.waveHistory.count()).toBe(1);
    await value.favorites.delete(track.id);
    await value.history.clear();
    expect(await value.favorites.count()).toBe(0);
    expect(await value.history.count()).toBe(0);
  });
  it("upgrades a version-one database without losing saved tracks", async () => {
    const name = `test-${crypto.randomUUID()}`;
    const old = new Dexie(name);
    old.version(1).stores({ tracks: "&id,sourceId" });
    const { genres: _genres, ...legacy } = track;
    void _genres;
    await old.table("tracks").put(legacy);
    old.close();
    const upgraded = new MusicDatabase(name);
    databases.push(upgraded);
    await upgraded.open();
    expect((await upgraded.tracks.get(track.id))?.genres).toEqual([]);
    expect(upgraded.verno).toBe(4);
  });
  it("enforces one entry per track in a playlist", async () => {
    const value = database();
    await value.playlistTracks.put({
      playlistId: "p",
      trackId: track.id,
      track,
      addedAt: 1,
    });
    await value.playlistTracks.put({
      playlistId: "p",
      trackId: track.id,
      track,
      addedAt: 2,
    });
    expect(await value.playlistTracks.count()).toBe(1);
  });
  it("migrates retired provider data out of every playback collection while preserving personal music", async () => {
    const name = `test-${crypto.randomUUID()}`,
      old = new Dexie(name);
    old
      .version(2)
      .stores({
        tracks: "&id,sourceId,*genres",
        favorites: "&id,addedAt",
        history: "++id,playedAt",
        playlists: "&id,createdAt",
        playlistTracks: "[playlistId+trackId],playlistId",
        queue: "&id,position",
        waveHistory: "&key,playedAt",
        settings: "&key",
        cachedRecommendations: "&key,expiresAt",
        offlineTracks: "&id,addedAt",
      });
    const retired = { ...track, id: "audius:old", sourceId: "audius" };
    await old.table("tracks").bulkPut([track, retired]);
    await old.table("favorites").bulkPut([
      { id: track.id, track, addedAt: 1 },
      { id: retired.id, track: retired, addedAt: 2 },
    ]);
    await old
      .table("playlists")
      .put({ id: "saved", name: "My playlist", createdAt: 1 });
    await old.table("playlistTracks").bulkPut([
      { playlistId: "saved", trackId: track.id, track, addedAt: 1 },
      { playlistId: "saved", trackId: retired.id, track: retired, addedAt: 2 },
    ]);
    for (const table of ["history", "queue", "waveHistory"])
      await old
        .table(table)
        .put({
          id: retired.id,
          key: "old",
          track: retired,
          playedAt: 1,
          position: 0,
        });
    await old.table("settings").bulkPut([
      { key: "playback", value: { current: retired, position: 3 } },
      { key: "settings", value: { dataSaver: true } },
    ]);
    old.close();
    const upgraded = new MusicDatabase(name);
    databases.push(upgraded);
    await upgraded.open();
    expect(await upgraded.favorites.count()).toBe(1);
    expect((await upgraded.favorites.toArray())[0].id).toBe(track.id);
    expect(await upgraded.tracks.get(retired.id)).toBeUndefined();
    expect(await upgraded.playlistTracks.count()).toBe(1);
    expect(await upgraded.playlists.get("saved")).toBeDefined();
    expect(await upgraded.history.count()).toBe(0);
    expect(await upgraded.queue.count()).toBe(0);
    expect(await upgraded.waveHistory.count()).toBe(0);
    expect(await upgraded.settings.get("playback")).toBeUndefined();
    expect((await upgraded.settings.get("settings"))?.value).toEqual({
      dataSaver: true,
    });
  });
});

describe("metadata import trust boundary", () => {
  it("restores YouTube playback only from its safe platform identifier", () => {
    const safe = sanitizeImportedTrack({
      ...track,
      id: "youtube:Abc123xyZ_9",
      sourceId: "youtube",
      playback: { kind: "youtube", videoId: "malicious" },
      externalUrl: "https://untrusted.example",
    });
    expect(safe.playback).toEqual({ kind: "youtube", videoId: "Abc123xyZ_9" });
    expect(safe.externalUrl).toBe(
      "https://www.youtube.com/watch?v=Abc123xyZ_9",
    );
    expect(safe.license.download).toBe(false);
  });
  it("discards external stream addresses and download permissions", () => {
    const safe = sanitizeImportedTrack(track);
    expect(safe.streamUrl).toBeUndefined();
    expect(safe.artwork).toBeUndefined();
    expect(safe.license.download).toBe(false);
  });
  it("rejects malformed or unknown-source tracks before import", () => {
    expect(() => sanitizeImportedTrack({ ...track, duration: "48" })).toThrow();
    expect(() =>
      sanitizeImportedTrack({ ...track, sourceId: "unknown-proxy" }),
    ).toThrow();
    expect(() => sanitizeImportedTrack({ ...track, genres: [1] })).toThrow();
    expect(() => sanitizeImportedTrack({ ...track, mbid: {} })).toThrow();
  });
});


describe("account partition migration",()=>{
  it("copies the legacy library once, preserves the source and does not share it with a second account",async()=>{
    const {importLegacyProfile}=await import("./db");
    const legacy=new MusicDatabase(`legacy-${crypto.randomUUID()}`),one=new MusicDatabase(`account-one-${crypto.randomUUID()}`),two=new MusicDatabase(`account-two-${crypto.randomUUID()}`);
    databases.push(legacy,one,two);await legacy.open();
    await legacy.favorites.put({id:track.id,track,addedAt:1});
    await legacy.queue.put({id:track.id,track,position:0,kind:"manual"});
    await legacy.settings.put({key:"settings",value:{volume:.35}});
    await importLegacyProfile(one,legacy.name);
    expect(await one.favorites.count()).toBe(1);expect(await one.queue.count()).toBe(1);expect((await one.settings.get("settings"))?.value).toEqual({volume:.35});
    expect(await legacy.favorites.count()).toBe(1);
    await importLegacyProfile(two,legacy.name);await two.open();expect(await two.favorites.count()).toBe(0);expect(await two.queue.count()).toBe(0);
    await one.favorites.delete(track.id);await importLegacyProfile(one,legacy.name);expect(await one.favorites.count()).toBe(0);
  });
});
