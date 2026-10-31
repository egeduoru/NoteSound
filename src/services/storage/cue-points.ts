import type { SmartCuePoints, Track } from "../../types/music";
import { db, type MusicDatabase } from "./db";

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const eligible = (track: Track) =>
  track.rights?.status === "confirmed" &&
  ["cc0", "personal_upload", "license"].includes(track.rights.basis) &&
  !track.playback &&
  track.playbackMode !== "metadata" &&
  track.playbackMode !== "external";

/** Cache only explicit musical marks, never inferred rights or guessed positions. */
export function normalizeCuePoints(
  value: unknown,
  duration: number,
  now = Date.now(),
): SmartCuePoints | null {
  if (!value || typeof value !== "object" || !finite(duration) || duration <= 0)
    return null;
  const points = value as Partial<SmartCuePoints>;
  if (
    !finite(points.cueConfidence) ||
    points.cueConfidence < 0 ||
    points.cueConfidence > 1 ||
    !["manual", "licensed_metadata", "analysis"].includes(
      points.cueSource ?? "",
    )
  )
    return null;
  if (
    (points.cueInSeconds !== undefined &&
      (!finite(points.cueInSeconds) || points.cueInSeconds < 0)) ||
    (points.cueOutSeconds !== undefined &&
      (!finite(points.cueOutSeconds) || points.cueOutSeconds <= 0))
  )
    return null;
  if (points.cueInSeconds === undefined && points.cueOutSeconds === undefined)
    return null;
  const cueInSeconds =
    points.cueInSeconds === undefined
      ? undefined
      : Math.min(points.cueInSeconds, Math.max(0, duration - 2));
  const cueOutSeconds =
    points.cueOutSeconds === undefined
      ? undefined
      : Math.min(points.cueOutSeconds, Math.max(0, duration - 0.25));
  if (
    cueOutSeconds !== undefined &&
    (cueOutSeconds <= 0 || cueOutSeconds <= (cueInSeconds ?? 0))
  )
    return null;
  return {
    ...(cueInSeconds === undefined ? {} : { cueInSeconds }),
    ...(cueOutSeconds === undefined ? {} : { cueOutSeconds }),
    cueConfidence: points.cueConfidence,
    cueSource: points.cueSource!,
    updatedAt:
      finite(points.updatedAt) && points.updatedAt > 0 ? points.updatedAt : now,
  };
}

export async function saveCuePoints(
  track: Track,
  database: MusicDatabase = db,
  now = Date.now(),
): Promise<SmartCuePoints | null> {
  const points = eligible(track)
    ? normalizeCuePoints(track.cuePoints, track.duration, now)
    : null;
  if (points)
    await database.trackCuePoints.put({ trackId: track.id, ...points });
  return points;
}

/** Call after resolving canonical track metadata, so current author marks win. */
export async function hydrateCuePoints(
  track: Track,
  database: MusicDatabase = db,
  now = Date.now(),
): Promise<Track> {
  if (!eligible(track)) return track;
  if (track.cuePoints !== undefined) {
    const points = await saveCuePoints(track, database, now);
    return { ...track, cuePoints: points ?? undefined };
  }
  const saved = await database.trackCuePoints.get(track.id);
  const points = normalizeCuePoints(saved, track.duration, now);
  return points ? { ...track, cuePoints: points } : track;
}

export function hydrateTracksCuePoints(
  tracks: Track[],
  database: MusicDatabase = db,
  now = Date.now(),
): Promise<Track[]> {
  return Promise.all(
    tracks.map((track) => hydrateCuePoints(track, database, now)),
  );
}
