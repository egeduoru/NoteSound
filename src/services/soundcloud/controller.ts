import type { Track } from "../../types/music";
import type { AudioEvents } from "../audio/controller";

interface Widget {
  bind(event: string, callback: (data?: { currentPosition?: number }) => void): void;
  unbind(event: string): void;
  play(): void;
  pause(): void;
  seekTo(positionMs: number): void;
  setVolume(volume: number): void;
  getPosition(callback: (ms: number) => void): void;
  getDuration(callback: (ms: number) => void): void;
}
interface WidgetApi {
  (element: HTMLIFrameElement): Widget;
  Events: Record<string, string>;
}
// Keep the SDK type local: the optional legacy SoundCloud page declares its
// own Window.SC shape, so a second global declaration breaks TypeScript builds.
function getWidgetApiFromWindow(): WidgetApi | undefined {
  return (window as unknown as { SC?: { Widget?: WidgetApi } }).SC?.Widget;
}
let apiTask: Promise<WidgetApi> | null = null;
export function loadSoundCloudWidgetApi(): Promise<WidgetApi> {
  const existingApi = getWidgetApiFromWindow();
  if (existingApi) return Promise.resolve(existingApi);
  if (apiTask) return apiTask;
  apiTask = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://w.soundcloud.com/player/api.js";
    script.async = true;
    const timeout = setTimeout(fail, 12000);
    function fail() {
      clearTimeout(timeout);
      script.remove();
      apiTask = null;
      reject(new Error("SoundCloud Widget API не загрузился."));
    }
    script.onerror = fail;
    script.onload = () => {
      clearTimeout(timeout);
      const loadedApi = getWidgetApiFromWindow();
      if (loadedApi) resolve(loadedApi);
      else fail();
    };
    document.head.append(script);
  });
  return apiTask;
}
const noop = () => undefined;
const emptyEvents: AudioEvents = { time: noop, playing: noop, waiting: noop, ended: noop, error: noop };
const cancelled = () => new DOMException("SoundCloud playback cancelled", "AbortError");

/** Persistent, visibly attributed SoundCloud iframe; never a hidden audio extractor. */
export class SoundCloudController {
  private host: HTMLElement | null = null;
  private widget: Widget | null = null;
  private frame: HTMLIFrameElement | null = null;
  private events = emptyEvents;
  private revision = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private playing = false;
  private volumeValue = 0.8;
  private duration = 0;
  private activeTrack: Track | null = null;
  private eventNames: string[] = [];
  private pendingReject: ((error: Error) => void) | null = null;
  constructor(private getApi = loadSoundCloudWidgetApi) {}
  bind(events: AudioEvents) { this.events = events; }
  mount(host: HTMLElement) {
    this.host = host;
    if (this.frame && this.frame.parentElement !== host) host.append(this.frame);
  }
  unmount(host: HTMLElement) {
    if (this.host === host) this.host = null;
    // The dock is a Shell-level singleton, not a page-scoped component.
    this.stop();
  }
  private clear() {
    this.pendingReject?.(cancelled());
    this.pendingReject = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.widget) {
      for (const type of this.eventNames) this.widget.unbind(type);
      this.eventNames = [];
      this.widget.pause();
    }
    this.frame?.remove();
    this.frame = null;
    this.widget = null;
    this.playing = false;
    this.activeTrack = null;
  }
  async load(url: string, track: Track, position = 0, autoplay = true) {
    ++this.revision;
    const revision = this.revision;
    this.clear();
    if (!this.host || !/^https:\/\/soundcloud\.com\/[^/?#]+\/[^/?#]+\/?$/.test(url) || track.externalUrl !== url)
      throw new Error("Для SoundCloud необходима видимая официальная форма воспроизведения.");
    const frame = document.createElement("iframe");
    frame.title = `SoundCloud: ${track.artist} — ${track.title}`;
    frame.allow = "autoplay";
    frame.loading = "eager";
    frame.width = "100%";
    frame.height = "166";
    frame.style.border = "0";
    frame.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&auto_play=false&show_user=true&show_artwork=false&visual=false`;
    this.host.append(frame);
    this.frame = frame;
    this.activeTrack = track;
    this.duration = track.duration;
    this.events.waiting(true);
    try {
      const api = await this.getApi();
      if (revision !== this.revision) throw cancelled();
      const widget = api(frame);
      this.widget = widget;
      const on = (event: string, callback: (data?: { currentPosition?: number }) => void) => {
        widget.bind(event, callback);
        this.eventNames.push(event);
      };
      on(api.Events.PLAY, () => {
        if (revision !== this.revision) return;
        this.playing = true;
        this.events.playing(true);
        this.events.waiting(false);
      });
      on(api.Events.PAUSE, () => {
        if (revision !== this.revision) return;
        this.playing = false;
        this.events.playing(false);
      });
      on(api.Events.FINISH, () => {
        if (revision !== this.revision) return;
        this.playing = false;
        this.events.playing(false);
        this.events.ended();
      });
      on(api.Events.ERROR, () => {
        if (revision === this.revision) this.events.error("SoundCloud не разрешил воспроизведение этой записи.");
      });
      on(api.Events.PLAY_PROGRESS, (event) => {
        if (revision === this.revision && Number.isFinite(event?.currentPosition))
          this.events.time(event!.currentPosition! / 1000, this.duration);
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Встраиваемый SoundCloud не ответил.")), 12000);
        this.pendingReject = (err) => { clearTimeout(timeout); reject(err); };
        on(api.Events.READY, () => {
          clearTimeout(timeout);
          this.pendingReject = null;
          if (revision !== this.revision) { reject(cancelled()); return; }
          widget.setVolume(this.volumeValue * 100);
          if (position > 0) widget.seekTo(position * 1000);
          widget.getDuration((ms) => {
            if (revision === this.revision && Number.isFinite(ms)) {
              this.duration = ms / 1000;
              this.events.time(position, this.duration);
            }
          });
          this.events.waiting(false);
          if (autoplay) widget.play();
          resolve();
        });
      });
      this.timer = setInterval(() => {
        if (!this.playing || revision !== this.revision) return;
        widget.getPosition((ms) => {
          if (revision === this.revision && Number.isFinite(ms)) this.events.time(ms / 1000, this.duration);
        });
      }, 1000);
      if (typeof navigator !== "undefined" && "mediaSession" in navigator && typeof MediaMetadata !== "undefined")
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title, artist: track.artist, album: track.album || "SoundCloud",
          artwork: track.artwork ? [{ src: track.artwork }] : [],
        });
    } catch (error) {
      if (revision === this.revision) { this.clear(); this.events.waiting(false); }
      throw error;
    }
  }
  async resume() { this.widget?.play(); }
  pause() { this.widget?.pause(); }
  stop() { ++this.revision; this.clear(); }
  seek(seconds: number) { if (Number.isFinite(seconds)) this.widget?.seekTo(Math.max(0, seconds) * 1000); }
  volume(value: number) { this.volumeValue = Math.max(0, Math.min(1, value)); this.widget?.setVolume(this.volumeValue * 100); }
  prepare() { /* Never preload a second third-party widget. */ }
}
export const soundcloudController = new SoundCloudController();
