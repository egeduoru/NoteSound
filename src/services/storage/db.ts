import Dexie, { type Table } from "dexie";
import type {
  HistoryEntry,
  Playlist,
  Track,
  TasteSignal,
  SmartCuePoints,
} from "../../types/music";

export interface FavoriteRecord {
  id: string;
  track: Track;
  addedAt: number;
}
export interface PlaylistTrackRecord {
  playlistId: string;
  trackId: string;
  track: Track;
  addedAt: number;
}
export interface OfflineRecord {
  id: string;
  track: Track;
  blob: Blob;
  bytes: number;
  addedAt: number;
}
export interface SettingRecord {
  key: string;
  value: unknown;
}
export interface WaveRecord {
  key: string;
  track: Track;
  playedAt: number;
}
export class MusicDatabase extends Dexie {
  tracks!: Table<Track, string>;
  favorites!: Table<FavoriteRecord, string>;
  history!: Table<HistoryEntry, number>;
  playlists!: Table<Playlist, string>;
  playlistTracks!: Table<PlaylistTrackRecord, [string, string]>;
  queue!: Table<
    {
      id: string;
      track: Track;
      position: number;
      kind?: "manual" | "automatic";
    },
    string
  >;
  tasteSignals!: Table<TasteSignal & { profileId: string }, string>;
  trackCuePoints!: Table<SmartCuePoints & { trackId: string }, string>;
  waveHistory!: Table<WaveRecord, string>;
  settings!: Table<SettingRecord, string>;
  cachedRecommendations!: Table<
    { key: string; tracks: Track[]; expiresAt: number },
    string
  >;
  offlineTracks!: Table<OfflineRecord, string>;
  constructor(name = "notesound-music") {
    super(name);
    this.version(1).stores({
      tracks: "&id,sourceId",
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
    this.version(2)
      .stores({ tracks: "&id,sourceId,*genres" })
      .upgrade(async (tx) => {
        await tx
          .table("tracks")
          .toCollection()
          .modify((track) => {
            track.genres ??= [];
          });
      });
    this.version(3)
      .stores({})
      .upgrade(async (tx) => {
        const retired = (value: unknown) =>
          !!value &&
          typeof value === "object" &&
          (value as { sourceId?: string }).sourceId === "audius";
        await tx.table("tracks").filter(retired).delete();
        for (const name of [
          "favorites",
          "history",
          "playlistTracks",
          "queue",
          "waveHistory",
          "offlineTracks",
        ])
          await tx
            .table(name)
            .filter((row) => retired(row.track))
            .delete();
        await tx.table("cachedRecommendations").clear();
        const playback = await tx.table("settings").get("playback");
        if (retired(playback?.value?.current))
          await tx.table("settings").delete("playback");
      });
    this.version(4)
      .stores({
        queue: "&id,position,kind",
        tasteSignals: "&id,trackId,at,kind,profileId",
        trackCuePoints: "&trackId,updatedAt",
      })
      .upgrade(async (tx) => {
        const saved = await tx.table("settings").get("playback");
        await tx
          .table("queue")
          .toCollection()
          .modify((row) => {
            row.kind ??= saved?.value?.wave ? "automatic" : "manual";
          });
      });
  }
}
export function localProfileDatabaseName() {
  const id =
    typeof window !== "undefined"
      ? window.Telegram?.WebApp?.initDataUnsafe?.user?.id
      : undefined;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0
    ? `notesound-music-tg-${id}`
    : "notesound-music";
}
export const db = new MusicDatabase(localProfileDatabaseName());
/** Local account partitioning is not server authentication. The backend verifies initData independently. */
export async function importLegacyProfile(
  target: MusicDatabase,
  legacyName = "notesound-music",
) {
  if (target.name === legacyName || !(await Dexie.exists(legacyName))) return;
  await target.open();
  if (await target.settings.get("legacyImportComplete")) return;
  const legacy = new MusicDatabase(legacyName);
  try {
    await legacy.open();
    const eligible = await legacy.transaction(
      "rw",
      legacy.settings,
      async () => {
        const owner = await legacy.settings.get("profileMigrationOwner");
        if (owner && owner.value !== target.name) return false;
        if (!owner)
          await legacy.settings.put({
            key: "profileMigrationOwner",
            value: target.name,
          });
        return true;
      },
    );
    if (!eligible) return;
    const rows = await Promise.all(
      legacy.tables.map(async (table) => ({
        name: table.name,
        rows: await table.toArray(),
      })),
    );
    await target.transaction("rw", target.tables, async () => {
      for (const entry of rows) {
        const values =
          entry.name === "settings"
            ? entry.rows.filter(
                (row) =>
                  !["profileMigrationOwner", "legacyImportComplete"].includes(
                    row.key,
                  ),
              )
            : entry.rows;
        if (values.length) await target.table(entry.name).bulkPut(values);
      }
      await target.settings.put({
        key: "legacyImportComplete",
        value: { source: legacyName, at: Date.now() },
      });
    });
  } finally {
    legacy.close();
  }
}

export function isTrack(value: unknown): value is Track {
  if (!value || typeof value !== "object") return false;
  const t = value as Partial<Track>;
  return (
    typeof t.id === "string" &&
    t.id.length > 0 &&
    t.id.length <= 300 &&
    typeof t.sourceId === "string" &&
    [
      "notesound",
      "demo",
      "local",
      "youtube",
      "hitmoz",
      "licensed",
      "public",
      "deezer",
    ].includes(t.sourceId) &&
    typeof t.title === "string" &&
    t.title.length <= 500 &&
    typeof t.artist === "string" &&
    t.artist.length <= 500 &&
    typeof t.duration === "number" &&
    Number.isFinite(t.duration) &&
    t.duration >= 0 &&
    (t.mbid === undefined ||
      (typeof t.mbid === "string" && t.mbid.length <= 100)) &&
    Array.isArray(t.genres) &&
    t.genres.every((g) => typeof g === "string") &&
    !!t.license &&
    typeof t.license.name === "string" &&
    typeof t.license.download === "boolean"
  );
}

/** Imports contain metadata only; untrusted stream locations and download grants are removed. */
export function sanitizeImportedTrack(value: unknown): Track {
  if (!isTrack(value))
    throw new Error("Файл содержит некорректные данные композиции.");
  const { id, sourceId, title, artist, duration, genres, mbid } = value;
  const track: Track = {
    id,
    sourceId,
    title,
    artist,
    duration,
    genres: genres.slice(0, 20),
    mbid,
    local: sourceId === "local",
    license: {
      name: sourceId === "local" ? "Личный файл" : "Права определяет источник",
      download: false,
    },
  };
  if (sourceId === "local")
    track.rights = {
      status: "confirmed",
      basis: "personal_upload",
      allowMix: true,
    };
  if (sourceId === "hitmoz" || sourceId === "licensed") {
    track.rights = { status: "unknown", basis: "none", allowMix: false };
    track.availability = "unknown";
    track.playbackMode = "metadata";
  }
  if (sourceId === "public" || sourceId === "deezer") {
    track.rights = { status: "unknown", basis: "none", allowMix: false };
    track.availability = "unknown";
    track.playbackMode = "metadata";
  }
  if (sourceId === "youtube") {
    if (!/^youtube:[\w-]{11}$/.test(id))
      throw new Error("Некорректный идентификатор YouTube.");
    const videoId = id.slice(8);
    track.playback = { kind: "youtube", videoId };
    track.platformId = videoId;
    track.playbackMode = "embedded";
    track.externalUrl = `https://www.youtube.com/watch?v=${videoId}`;
    track.artwork = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    track.license = {
      name: "YouTube · официальный видеоплеер",
      url: "https://www.youtube.com/t/terms",
      download: false,
    };
  }
  return track;
}

export const MAX_OFFLINE_BYTES = 250 * 1024 * 1024;
