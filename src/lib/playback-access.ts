import type { Track } from "../types/music";

/** Provider playback is distinct from a licence to store or modify a recording. */
export function isProviderAudio(track: Track): boolean {
  return (
    ((track.sourceId === "public" &&
      track.streamAccess === "provider_stream") ||
      (track.sourceId === "deezer" && track.streamAccess === "preview")) &&
    new RegExp(`^${track.sourceId}:[A-Za-z0-9_-]{1,200}$`).test(track.id) &&
    track.playbackMode === "audio" &&
    track.playback?.kind !== "youtube" &&
    track.availability === "available" &&
    track.rights?.status !== "denied" &&
    track.license.download === false &&
    track.rights?.allowMix === false
  );
}
