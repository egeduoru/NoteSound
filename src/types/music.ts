export type SourceStatus =
  | "available"
  | "unavailable"
  | "experimental"
  | "authentication_required"
  | "restricted";
export interface PlaybackRights {
  status: "confirmed" | "unknown" | "denied";
  basis: "cc0" | "personal_upload" | "license" | "none";
  allowMix: boolean;
  allowTelegramDelivery?: boolean;
  evidence?: string;
}
export interface SmartCuePoints {
  cueInSeconds?: number;
  cueOutSeconds?: number;
  cueConfidence: number;
  cueSource: "manual" | "licensed_metadata" | "analysis";
  updatedAt?: number;
}
export interface WaveMixSettings {
  enabled: boolean;
  durationSeconds: number;
  smartCue: boolean;
  earlyTransition: boolean;
}
export interface WavePreferences {
  familiarity: "balanced" | "familiar" | "discover";
  mood: "any" | "calm" | "energetic" | "happy" | "melancholic";
  language: "any" | "russian" | "foreign" | "instrumental";
}
export const defaultWavePreferences: WavePreferences = {
  familiarity: "balanced",
  mood: "any",
  language: "any",
};
export type TasteSignalKind =
  "like" | "favorite" | "listen" | "repeat" | "skip" | "dislike";
export type SignalWeights = Record<TasteSignalKind, number>;
export interface TasteSignal {
  id: string;
  trackId: string;
  track: Track;
  kind: TasteSignalKind;
  at: number;
  playedSeconds?: number;
}
export interface Track {
  id: string;
  sourceId: string;
  title: string;
  artist: string;
  album?: string;
  duration: number;
  artwork?: string;
  streamUrl?: string;
  genres: string[];
  license: { name: string; url?: string; download: boolean };
  mbid?: string;
  local?: boolean;
  playback?: { kind: "youtube"; videoId: string };
  externalUrl?: string;
  platformId?: string;
  playbackMode?: "audio" | "embedded" | "external" | "metadata";
  /** Playback offered by the named provider; does not grant download or remix rights. */
  streamAccess?: "provider_stream" | "preview";
  metadata?: Record<string, string>;
  sourceName?: string;
  popularity?: number;
  availability?: "available" | "unavailable" | "unknown";
  rights?: PlaybackRights;
  audioSource?: { url: string; cors: boolean; expiresAt?: number };
  cuePoints?: SmartCuePoints;
}
export interface ProviderSearchPage {
  tracks: Track[];
  nextPageToken?: string;
}
export interface MusicSourceAdapter {
  id: string;
  name: string;
  status: SourceStatus;
  playbackModes?: Array<"audio" | "embedded" | "external" | "metadata">;
  searchPage?(
    query: string,
    options?: { pageToken?: string; signal?: AbortSignal },
  ): Promise<ProviderSearchPage>;
  searchTracks(query: string, signal?: AbortSignal): Promise<Track[]>;
  getTrackDetails(trackId: string, signal?: AbortSignal): Promise<Track | null>;
  resolveStream(track: Track, signal?: AbortSignal): Promise<string | null>;
  checkAvailability(track: Track, signal?: AbortSignal): Promise<boolean>;
  getSimilarTracks?(track: Track, signal?: AbortSignal): Promise<Track[]>;
  /** Related artist names are metadata selectors, never playable recordings. */
  getRelatedArtists?(artist: string, signal?: AbortSignal): Promise<string[]>;
  supportsDownload(track: Track): Promise<boolean>;
  getTopTracks?(signal?: AbortSignal): Promise<Track[]>;
  getTrack?(id: string, signal?: AbortSignal): Promise<Track | null>;
  getPlayableSource?(
    id: string,
    signal?: AbortSignal,
  ): Promise<{
    url: string;
    cors: boolean;
    expiresAt?: number;
    allowMix?: boolean;
  } | null>;
}
export type MusicProvider = MusicSourceAdapter;
export interface HistoryEntry {
  id?: number;
  track: Track;
  playedAt: number;
  skipped?: boolean;
  playedSeconds?: number;
  completed?: boolean;
}
export interface Playlist {
  id: string;
  name: string;
  createdAt: number;
}
export interface MusicSourceSettings {
  soundcloud: boolean;
  public: boolean;
  deezer: boolean;
  licensed: boolean;
}
export const defaultMusicSources: MusicSourceSettings = {
  soundcloud: false, public: true, deezer: true, licensed: true,
};
export interface Settings {
  sources: MusicSourceSettings;
  dataSaver: boolean;
  reducedMotion: boolean;
  diversity: number;
  volume: number;
  discoveryIntensity: number;
  smartWaveEnabled: boolean;
  waveMix: WaveMixSettings;
  signalWeights: SignalWeights;
  wavePreferences: WavePreferences;
}
export const defaultSettings: Settings = {
  dataSaver: false,
  sources: defaultMusicSources,
  reducedMotion: false,
  diversity: 0.25,
  volume: 0.8,
  discoveryIntensity: 0.25,
  smartWaveEnabled: true,
  wavePreferences: defaultWavePreferences,
  waveMix: {
    enabled: false,
    durationSeconds: 6,
    smartCue: true,
    earlyTransition: true,
  },
  signalWeights: {
    like: 5,
    favorite: 4,
    listen: 2,
    repeat: 2,
    skip: -1,
    dislike: -8,
  },
};
