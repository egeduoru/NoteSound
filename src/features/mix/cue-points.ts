import type { Track, WaveMixSettings } from "../../types/music";

export interface CuePlan {
  cueInSeconds: number;
  transitionAtSeconds: number;
  durationSeconds: number;
}
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const trusted = (track: Track) => {
  const points = track.cuePoints;
  return points &&
    finite(points.cueConfidence) &&
    points.cueConfidence >= 0.7 &&
    ["manual", "licensed_metadata", "analysis"].includes(points.cueSource)
    ? points
    : null;
};

/** Only supplied, sufficiently reliable musical marks can move a song's start. */
export function cueInFor(track: Track, enabled = true): number {
  const points = enabled ? trusted(track) : null;
  if (!points || !finite(points.cueInSeconds) || points.cueInSeconds < 0)
    return 0;
  const end = track.duration > 0 ? Math.max(0, track.duration - 2) : 0;
  return Math.min(points.cueInSeconds, end);
}

export function planTransition(
  current: Track,
  next: Track,
  settings: WaveMixSettings,
  actualDuration = current.duration,
): CuePlan {
  const duration =
    finite(actualDuration) && actualDuration > 0
      ? actualDuration
      : current.duration;
  const requested = Math.max(
    2,
    Math.min(
      12,
      Number.isFinite(settings.durationSeconds) ? settings.durationSeconds : 6,
    ),
  );
  const nextStart = cueInFor(next, settings.smartCue);
  const nextRemaining =
    next.duration > 0 ? next.duration - nextStart : requested;
  const fade = Math.max(0, Math.min(requested, duration, nextRemaining));
  const points =
    settings.smartCue && settings.earlyTransition ? trusted(current) : null;
  const markedOut =
    points &&
    finite(points.cueOutSeconds) &&
    points.cueOutSeconds > 0 &&
    points.cueOutSeconds < duration
      ? points.cueOutSeconds
      : null;
  // Unknown structure never means cutting an arbitrary 20/30 seconds off a song.
  return {
    cueInSeconds: nextStart,
    transitionAtSeconds:
      markedOut === null
        ? Math.max(0, duration - fade)
        : Math.min(markedOut, Math.max(0, duration - 0.25)),
    durationSeconds:
      markedOut === null ? fade : Math.min(fade, duration - markedOut),
  };
}

export const SmartCuePointService = { cueInFor, planTransition };
