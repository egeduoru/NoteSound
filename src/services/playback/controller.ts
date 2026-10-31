import type { Track, WaveMixSettings } from "../../types/music";
import { audioController, type AudioEvents } from "../audio/controller";
import { soundcloudController } from "../soundcloud/controller";
import { youtubeController, type YouTubeTrack } from "../youtube/controller";
import { legacyYouTubeEnabled } from "../../adapters/music";
import { reportYouTubeAvailability } from "../../adapters/music/youtube";

interface AudioProvider {
  bind(events: AudioEvents): void;
  load(
    url: string,
    track: Track,
    position?: number,
    autoplay?: boolean,
  ): Promise<void>;
  resume(): Promise<void>;
  pause(): void;
  stop(): void;
  seek(seconds: number): void;
  volume(value: number): void;
  prepare(url: string | null, track?: Track): void;
  configureMix?(settings: WaveMixSettings): void;
}
interface YouTubeProvider extends Omit<AudioProvider, "load" | "prepare"> {
  load(
    track: YouTubeTrack,
    position?: number,
    autoplay?: boolean,
  ): Promise<void>;
}
const noop = () => undefined;
const emptyEvents: AudioEvents = {
  time: noop,
  playing: noop,
  waiting: noop,
  ended: noop,
  error: noop,
};

/** Keeps audio and the official visible video player mutually exclusive. */
export class PlaybackController {
  private events = emptyEvents;
  private active: "audio" | "youtube" | "soundcloud" | null = null;
  private volumeValue = 0.8;
  private revision = 0;
  private videoId: string | null = null;
  constructor(
    private audio: AudioProvider = audioController,
    private youtube: YouTubeProvider = youtubeController,
    private allowLegacyYouTube = legacyYouTubeEnabled,
  ) {}

  bind(events: AudioEvents) {
    this.events = events;
    const forward = (provider: "audio" | "youtube" | "soundcloud"): AudioEvents => ({
      time: (position, duration) => {
        if (this.active === provider) this.events.time(position, duration);
      },
      playing: (playing) => {
        if (this.active === provider) {
          if (provider === "youtube" && playing && this.videoId)
            reportYouTubeAvailability(this.videoId, true);
          this.events.playing(playing);
        }
      },
      waiting: (waiting) => {
        if (this.active === provider) this.events.waiting(waiting);
      },
      ended: () => {
        if (this.active === provider) this.events.ended();
      },
      transition: (event) => {
        if (this.active === provider) this.events.transition?.(event);
      },
      listened: (sample) => {
        if (this.active === provider) this.events.listened?.(sample);
      },
      mixStatus: (message) => {
        if (this.active === provider) this.events.mixStatus?.(message);
      },
      error: (message) => {
        if (this.active === provider) {
          if (provider === "youtube" && this.videoId)
            reportYouTubeAvailability(this.videoId, false);
          this.events.error(message);
        }
      },
    });
    this.audio.bind(forward("audio"));
    this.youtube.bind(forward("youtube"));
    soundcloudController.bind(forward("soundcloud"));
  }

  async load(url: string | null, track: Track, position = 0, autoplay = true) {
    if (track.playback?.kind === "youtube" && !this.allowLegacyYouTube)
      throw new Error(
        "Видео YouTube открывается у источника. Основной плеер использует разрешённое аудио.",
      );
    this.stop();
    const revision = this.revision;
    const provider = track.sourceId === "soundcloud" ? "soundcloud" : track.playback?.kind === "youtube" ? "youtube" : "audio";
    this.active = provider;
    this.events.waiting(autoplay);
    this.videoId =
      track.playback?.kind === "youtube" ? track.playback.videoId : null;
    try {
      if (provider === "soundcloud") {
        if (!url) throw new Error("SoundCloud URL отсутствует.");
        soundcloudController.volume(this.volumeValue);
        await soundcloudController.load(url, track, position, autoplay);
      } else if (provider === "youtube" && track.playback) {
        this.youtube.volume(this.volumeValue);
        await this.youtube.load(track as YouTubeTrack, position, autoplay);
      } else {
        if (!url) throw new Error("У этой композиции нет доступного аудио.");
        this.audio.volume(this.volumeValue);
        await this.audio.load(url, track, position, autoplay);
      }
      if (revision !== this.revision)
        throw new DOMException("Воспроизведение отменено", "AbortError");
    } catch (error) {
      if (revision !== this.revision)
        throw new DOMException("Воспроизведение отменено", "AbortError");
      if (
        provider === "youtube" &&
        this.videoId &&
        (error as Error).name !== "NotAllowedError" &&
        (error as Error).name !== "AbortError"
      )
        reportYouTubeAvailability(this.videoId, false);
      throw error;
    }
  }
  async resume() {
    if (this.active === "soundcloud") await soundcloudController.resume();
    else if (this.active === "youtube") await this.youtube.resume();
    else if (this.active === "audio") await this.audio.resume();
  }
  pause() {
    if (this.active === "soundcloud") soundcloudController.pause();
    else if (this.active === "youtube") this.youtube.pause();
    else if (this.active === "audio") this.audio.pause();
  }
  stop() {
    ++this.revision;
    this.active = null;
    this.audio.stop();
    this.youtube.stop();
    soundcloudController.stop();
    this.events.playing(false);
    this.events.waiting(false);
  }
  seek(seconds: number) {
    if (this.active === "soundcloud") soundcloudController.seek(seconds);
    else if (this.active === "youtube") this.youtube.seek(seconds);
    else if (this.active === "audio") this.audio.seek(seconds);
  }
  volume(value: number) {
    this.volumeValue = Math.max(0, Math.min(1, value));
    if (this.active === "soundcloud") soundcloudController.volume(this.volumeValue);
    else if (this.active === "youtube") this.youtube.volume(this.volumeValue);
    else if (this.active === "audio") this.audio.volume(this.volumeValue);
  }
  prepare(url: string | null, track?: Track) {
    if (track?.sourceId !== "soundcloud") this.audio.prepare(url, track);
  }
  configureMix(settings: WaveMixSettings) {
    this.audio.configureMix?.(settings);
  }
}
export const playbackController = new PlaybackController();
