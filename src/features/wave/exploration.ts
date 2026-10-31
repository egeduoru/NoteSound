import type { HistoryEntry, Track, WavePreferences } from "../../types/music";
import { artistKeys } from "../../lib/normalize";

/** Count played and already scheduled songs together, so incremental two-song
 * refills do not each restart the discovery quota from zero. */
export function waveExplorationDue(
  history: HistoryEntry[],
  following: Track[] = [],
  familiarity: WavePreferences["familiarity"] = "balanced",
) {
  if (familiarity === "familiar") return false;
  const interval = familiarity === "discover" ? 2 : 4;
  const seenArtists = new Set<string>();
  let sinceDiscovery = 0;
  for (const track of [
    ...history
      .slice()
      .reverse()
      .map((entry) => entry.track),
    ...following,
  ]) {
    const artists = artistKeys(track.artist);
    const firstIntroduction =
      track.metadata?.recommendationArtistDiscovery === "true" &&
      artists.length > 0 &&
      artists.every((artist) => !seenArtists.has(artist));
    sinceDiscovery = firstIntroduction ? 0 : sinceDiscovery + 1;
    artists.forEach((artist) => seenArtists.add(artist));
  }
  return sinceDiscovery >= interval - 1;
}
