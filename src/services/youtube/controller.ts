import type { AudioEvents } from "../audio/controller";
import type { Track } from "../../types/music";

export type YouTubeTrack = Track & {
  playback: { kind: "youtube"; videoId: string };
};
export interface YouTubePlayer {
  loadVideoById(options: { videoId: string; startSeconds: number }): void;
  cueVideoById(options: { videoId: string; startSeconds: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setVolume(volume: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getVideoData(): { video_id?: string };
  getIframe(): HTMLIFrameElement;
  destroy(): void;
}
export interface YouTubePlayerOptions {
  width: string;
  height: string;
  host: string;
  playerVars: Record<string, string | number>;
  events: {
    onReady: (event: { target: YouTubePlayer }) => void;
    onStateChange: (event: { target: YouTubePlayer; data: number }) => void;
    onError: (event: { target: YouTubePlayer; data: number }) => void;
    onAutoplayBlocked: () => void;
  };
}
export interface YouTubeApi {
  Player: new (
    host: HTMLElement,
    options: YouTubePlayerOptions,
  ) => YouTubePlayer;
}
declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YouTubeApi> | null = null;
/** Official API only: never extracts a media URL or downloads YouTube audio. */
export function loadYouTubeApi(): Promise<YouTubeApi> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<YouTubeApi>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    let script = document.querySelector<HTMLScriptElement>(
      'script[data-notesound-youtube="true"]',
    );
    const cleanup = () => {
      clearTimeout(timer);
      script?.removeEventListener("error", fail);
    };
    const fail = () => {
      cleanup();
      script?.remove();
      apiPromise = null;
      if (window.onYouTubeIframeAPIReady === ready)
        window.onYouTubeIframeAPIReady = previous;
      reject(
        new Error("Не удалось загрузить плеер YouTube. Проверьте подключение."),
      );
    };
    const ready = () => {
      cleanup();
      try {
        previous?.();
      } finally {
        if (window.YT?.Player) resolve(window.YT);
        else fail();
      }
    };
    const timer = setTimeout(fail, 12000);
    window.onYouTubeIframeAPIReady = ready;
    if (!script) {
      script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.dataset.notesoundYoutube = "true";
      script.referrerPolicy = "strict-origin-when-cross-origin";
      document.head.append(script);
    }
    script.addEventListener("error", fail, { once: true });
  });
  return apiPromise;
}

const noop = () => undefined;
const emptyEvents: AudioEvents = {
  time: noop,
  playing: noop,
  waiting: noop,
  ended: noop,
  error: noop,
};
const abortError = () =>
  new DOMException("Воспроизведение отменено", "AbortError");
const errorMessages: Record<number, string> = {
  2: "YouTube отклонил идентификатор записи.",
  5: "Эту запись YouTube не удалось воспроизвести в браузере.",
  100: "Запись YouTube удалена или недоступна.",
  101: "Автор запретил воспроизведение этой записи во встроенном плеере.",
  150: "Автор запретил воспроизведение этой записи во встроенном плеере.",
  153: "YouTube не распознал адрес приложения. Попробуйте открыть NoteSound в обычном браузере.",
};

/** One visible official YouTube iframe, controlled through its documented IFrame API. */
export class YouTubeController {
  private events = emptyEvents;
  private host: HTMLElement | null = null;
  private player: YouTubePlayer | null = null;
  private playerReady = false;
  private readyPromise: Promise<YouTubePlayer> | null = null;
  private hostWaiters = new Set<(host: HTMLElement) => void>();
  private videoId: string | null = null;
  private visible = false;
  private volumeValue = 0.8;
  private revision = 0;
  private tick: ReturnType<typeof setInterval> | null = null;
  private pendingPlay: {
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
  private cancelLoad: (() => void) | null = null;
  constructor(private readApi = loadYouTubeApi) {}

  bind(events: AudioEvents) {
    this.events = events;
  }

  /** Keep this host mounted while the YouTube track is selected, including route changes. */
  mount(host: HTMLElement) {
    if (this.host && this.host !== host) this.destroyPlayer();
    this.host = host;
    const update = () => this.setVisible(this.measureVisible(host));
    update();
    for (const waiter of this.hostWaiters) waiter(host);
    this.hostWaiters.clear();
    const observer =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            (entries) => {
              const entry = entries[0];
              this.setVisible(
                !!entry &&
                  entry.intersectionRatio > 0.5 &&
                  this.measureVisible(host),
              );
            },
            { threshold: [0, 0.5, 1] },
          )
        : null;
    observer?.observe(host);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("resize", update);
      if (this.host === host) {
        this.stop();
        this.destroyPlayer();
        this.host = null;
        this.visible = false;
      }
    };
  }

  /** Also call with false when an application overlay would obscure the iframe. */
  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible) this.pause();
  }

  private measureVisible(host: HTMLElement) {
    if (!host.isConnected || document.hidden) return false;
    const rect = host.getBoundingClientRect();
    if (rect.width < 200 || rect.height < 200) return false;
    const width = Math.max(
      0,
      Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0),
    );
    const height = Math.max(
      0,
      Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0),
    );
    return (width * height) / (rect.width * rect.height) > 0.5;
  }

  private waitForHost() {
    if (this.host) return Promise.resolve(this.host);
    return new Promise<HTMLElement>((resolve) => {
      this.hostWaiters.add(resolve);
    });
  }

  private ensurePlayer(): Promise<YouTubePlayer> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      const [api, host] = await Promise.all([
        this.readApi(),
        this.waitForHost(),
      ]);
      if (host !== this.host) throw abortError();
      const slot = document.createElement("div");
      host.replaceChildren(slot);
      return new Promise<YouTubePlayer>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("YouTube не подготовил плеер вовремя.")),
          12000,
        );
        this.player = new api.Player(slot, {
          width: "100%",
          height: "100%",
          host: "https://www.youtube.com",
          playerVars: {
            controls: 1,
            playsinline: 1,
            autoplay: 0,
            origin: window.location.origin,
            rel: 0,
          },
          events: {
            onReady: ({ target }) => {
              clearTimeout(timer);
              if (host !== this.host) {
                target.destroy();
                reject(abortError());
                return;
              }
              this.playerReady = true;
              const iframe = target.getIframe();
              iframe.title = "Официальный плеер YouTube";
              iframe.referrerPolicy = "strict-origin-when-cross-origin";
              iframe.allow =
                "autoplay; encrypted-media; fullscreen; picture-in-picture";
              target.setVolume(Math.round(this.volumeValue * 100));
              resolve(target);
            },
            onStateChange: ({ target, data }) => this.stateChange(target, data),
            onError: ({ data, target }) => {
              const reportedId = target.getVideoData()?.video_id;
              if (reportedId && this.videoId && reportedId !== this.videoId)
                return;
              const error = new Error(
                errorMessages[data] || "Ошибка воспроизведения YouTube.",
              );
              if (!this.playerReady) {
                clearTimeout(timer);
                reject(error);
              } else this.fail(error);
            },
            onAutoplayBlocked: () =>
              this.fail(
                new DOMException(
                  "Нажмите Play в окне YouTube, чтобы запустить запись.",
                  "NotAllowedError",
                ),
              ),
          },
        });
      });
    })().catch((error) => {
      this.readyPromise = null;
      throw error;
    });
    return this.readyPromise;
  }

  async load(track: YouTubeTrack, position = 0, autoplay = true) {
    if (!/^[\w-]{11}$/.test(track.playback.videoId))
      throw new Error("Некорректный идентификатор YouTube.");
    this.cancelLoad?.();
    const revision = ++this.revision;
    this.videoId = track.playback.videoId;
    this.events.waiting(autoplay);
    this.events.playing(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancellation = new Promise<never>((_, reject) => {
      this.cancelLoad = () => reject(abortError());
      timer = setTimeout(
        () =>
          reject(
            new Error(
              "YouTube загружается слишком долго. Проверьте соединение.",
            ),
          ),
        20000,
      );
    });
    try {
      await Promise.race([
        (async () => {
          const player = await this.ensurePlayer();
          if (revision !== this.revision) throw abortError();
          const options = {
            videoId: track.playback.videoId,
            startSeconds: Math.max(0, position),
          };
          if (autoplay) {
            this.assertVisible();
            const playing = this.waitForPlayback();
            player.loadVideoById(options);
            await playing;
          } else {
            player.cueVideoById(options);
            this.events.waiting(false);
            this.events.time(Math.max(0, position), track.duration);
          }
        })(),
        cancellation,
      ]);
    } catch (error) {
      if (revision === this.revision) {
        if (this.playerReady) this.player?.pauseVideo();
        this.events.waiting(false);
        this.events.playing(false);
        this.rejectPending(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (revision === this.revision) this.cancelLoad = null;
    }
  }

  async resume() {
    this.assertVisible();
    if (!this.videoId) throw new Error("Сначала выберите запись YouTube.");
    const player = await this.ensurePlayer();
    this.assertVisible();
    if (player.getPlayerState() === 1) return;
    const playing = this.waitForPlayback();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      player.playVideo();
      await Promise.race([
        playing,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error("Нажмите Play в окне YouTube, чтобы продолжить."),
              ),
            12000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  pause() {
    this.cancelLoad?.();
    this.cancelLoad = null;
    this.rejectPending(abortError());
    if (this.playerReady) this.player?.pauseVideo();
    this.clearTick();
    this.events.waiting(false);
    this.events.playing(false);
  }
  stop() {
    ++this.revision;
    this.pause();
    this.videoId = null;
    if (this.playerReady) this.player?.stopVideo();
  }
  seek(seconds: number) {
    const player = this.player;
    if (!player || !this.playerReady || !this.videoId) return;
    const duration = player.getDuration();
    player.seekTo(Math.max(0, Math.min(seconds, duration || Infinity)), true);
    this.updateTime();
  }
  volume(value: number) {
    this.volumeValue = Math.max(0, Math.min(1, value));
    if (this.playerReady)
      this.player?.setVolume(Math.round(this.volumeValue * 100));
  }

  private assertVisible() {
    if (!this.visible || !this.host || !this.measureVisible(this.host))
      throw new DOMException(
        "Для YouTube нужно открытое видимое окно плеера.",
        "NotAllowedError",
      );
  }
  private waitForPlayback() {
    this.rejectPending(abortError());
    return new Promise<void>((resolve, reject) => {
      this.pendingPlay = { resolve, reject };
    });
  }
  private rejectPending(error: Error) {
    const pending = this.pendingPlay;
    this.pendingPlay = null;
    pending?.reject(error);
  }
  private fail(error: Error) {
    this.events.waiting(false);
    this.events.playing(false);
    this.clearTick();
    if (this.pendingPlay) this.rejectPending(error);
    else this.events.error(error.message);
  }
  private stateChange(player: YouTubePlayer, state: number) {
    if (!this.videoId) {
      if (state === 1) player.pauseVideo();
      return;
    }
    const playingId = player.getVideoData().video_id;
    if (playingId && playingId !== this.videoId) return;
    if (state === 1) {
      if (!this.visible || !this.host || !this.measureVisible(this.host)) {
        this.pause();
        return;
      }
      this.events.waiting(false);
      this.events.playing(true);
      const pending = this.pendingPlay;
      this.pendingPlay = null;
      pending?.resolve();
      this.updateTime();
      this.clearTick();
      this.tick = setInterval(() => this.updateTime(), 500);
    } else if (state === 3) {
      this.events.waiting(true);
    } else if (state === 2 || state === 5 || state === -1) {
      this.events.playing(false);
      if (state !== -1) this.events.waiting(false);
      this.clearTick();
      this.updateTime();
    } else if (state === 0) {
      this.clearTick();
      this.events.waiting(false);
      this.events.playing(false);
      this.updateTime();
      this.events.ended();
    }
  }
  private updateTime() {
    if (!this.player || !this.playerReady) return;
    const position = this.player.getCurrentTime();
    const duration = this.player.getDuration();
    this.events.time(
      Number.isFinite(position) ? position : 0,
      Number.isFinite(duration) ? duration : 0,
    );
  }
  private clearTick() {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
  }
  private destroyPlayer() {
    this.player?.destroy();
    this.player = null;
    this.playerReady = false;
    this.readyPromise = null;
  }
}

export const youtubeController = new YouTubeController();
