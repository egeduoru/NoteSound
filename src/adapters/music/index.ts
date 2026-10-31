import type { MusicSourceAdapter, Track } from "../../types/music";
import { youtubeAdapter } from "./youtube";
import { soundcloudAdapter, validSoundCloudTrack } from "./soundcloud";
import { defaultMusicSources, type MusicSourceSettings } from "../../types/music";
import { catalogAdapter } from "./catalog";
import { vkAdapter } from "./vk";
import { hitmozAdapter } from "./hitmoz";
import { licensedAdapter } from "./licensed";
import { publicCatalogAdapter, deezerAdapter } from "./discovery";
import { isProviderAudio } from "../../lib/playback-access";
import { deduplicateTracks } from "../../lib/normalize";
import { deduplicateSearchResults } from "../../lib/search-results";
export { catalog } from "./catalog";
export const legacyYouTubeEnabled =
  import.meta.env.VITE_LEGACY_YOUTUBE_ENABLED === "true";
let enabledSources: MusicSourceSettings = { ...defaultMusicSources };
export function configureMusicSources(next: MusicSourceSettings) { enabledSources = { ...next }; }
export const adapters: MusicSourceAdapter[] = [
  soundcloudAdapter,
  publicCatalogAdapter,
  deezerAdapter,
  licensedAdapter,
  hitmozAdapter,
  catalogAdapter,
  vkAdapter,
  ...(legacyYouTubeEnabled ? [youtubeAdapter] : []),
];
export interface SearchResult {
  tracks: Track[];
  warning: string | null;
  nextPageToken?: string;
}
export function isAuthorizedAudio(track: Track) {
  return (
    track.playback?.kind !== "youtube" &&
    track.rights?.status === "confirmed" &&
    track.availability !== "unavailable" &&
    !["metadata", "external"].includes(track.playbackMode || "audio")
  );
}
export function canPlayTrack(track: Track) {
  // Disabling a provider never erases its saved records, but prevents new playback.
  if (track.sourceId === "soundcloud" && !enabledSources.soundcloud) return false;
  if (track.sourceId === "public" && !enabledSources.public) return false;
  if (track.sourceId === "deezer" && !enabledSources.deezer) return false;
  if (track.sourceId === "licensed" && !enabledSources.licensed) return false;
  return (
    (enabledSources.soundcloud && validSoundCloudTrack(track)) ||
    isAuthorizedAudio(track) ||
    isProviderAudio(track) ||
    (!!track.local && track.sourceId === "local") ||
    (legacyYouTubeEnabled && track.playback?.kind === "youtube")
  );
}
const searchable = () =>
  adapters.filter(
    (source) =>
      source.id !== "vk" &&
      (source.id !== "soundcloud" || enabledSources.soundcloud) &&
      (source.id !== "public" || enabledSources.public) &&
      (source.id !== "deezer" || enabledSources.deezer) &&
      (source.id !== "licensed" || enabledSources.licensed) &&
      !["unavailable", "restricted", "authentication_required"].includes(
        source.status,
      ),
  );
export async function searchTracksWithStatus(
  query: string,
  signal?: AbortSignal,
  pageToken?: string,
): Promise<SearchResult> {
  if (signal?.aborted) throw signal.reason;
  const normalized = query
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 300);
  if (!normalized) return { tracks: [], warning: null };
  const results = await Promise.allSettled(
    searchable().map(async (source) =>
      source.searchPage
        ? source.searchPage(normalized, {
            signal,
            pageToken: source.id === "youtube" ? pageToken : undefined,
          })
        : {
            tracks: await source.searchTracks(normalized, signal),
            nextPageToken: undefined,
          },
    ),
  );
  if (signal?.aborted) throw signal.reason;
  const tracks: Track[] = [];
  let nextPageToken: string | undefined;
  const errors: string[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      tracks.push(...result.value.tracks);
      nextPageToken ||= result.value.nextPageToken;
    } else
      errors.push(
        result.reason instanceof Error
          ? result.reason.message
          : "Каталог временно недоступен.",
      );
  }
  return {
    tracks: deduplicateSearchResults(tracks),
    warning: errors.length ? [...new Set(errors)].join(" ") : null,
    nextPageToken,
  };
}
export async function searchTracks(query: string, signal?: AbortSignal) {
  const result = await searchTracksWithStatus(query, signal);
  if (!result.tracks.length && result.warning) throw new Error(result.warning);
  return result.tracks;
}
export async function getTopTracks(signal?: AbortSignal) {
  const results = await Promise.allSettled(
    searchable()
      .filter((source) => source.getTopTracks)
      .map((source) => source.getTopTracks!(signal)),
  );
  if (signal?.aborted) throw signal.reason;
  return deduplicateTracks(
    results.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    ),
  );
}
export async function resolveStream(track: Track, signal?: AbortSignal) {
  if (track.sourceId === "soundcloud" && enabledSources.soundcloud) return soundcloudAdapter.resolveStream(track, signal);
  if (track.sourceId === "notesound")
    return catalogAdapter.resolveStream(track, signal);
  if (!isAuthorizedAudio(track) && !isProviderAudio(track)) return null;
  return (
    adapters
      .find((adapter) => adapter.id === track.sourceId)
      ?.resolveStream(track, signal) ?? null
  );
}
export async function checkAvailability(track: Track, signal?: AbortSignal) {
  if (track.local && track.sourceId === "local") return true;
  if (track.sourceId === "soundcloud" && enabledSources.soundcloud) return soundcloudAdapter.checkAvailability(track, signal);
  if (!canPlayTrack(track) && track.sourceId !== "notesound") return false;
  return (
    adapters
      .find((adapter) => adapter.id === track.sourceId)
      ?.checkAvailability(track, signal) ?? false
  );
}
