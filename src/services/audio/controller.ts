import type { Track, WaveMixSettings } from "../../types/music";
import { isProviderAudio } from "../../lib/playback-access";
import {
  MIX_HEADROOM,
  WaveMixEngine,
  supportsMix,
  type AudioContextFactory,
} from "../../features/mix/engine";
import { planTransition } from "../../features/mix/cue-points";

export interface AudioTransition {
  phase: "started" | "progress" | "committed" | "completed" | "cancelled";
  from: Track;
  to: Track;
  progress: number;
  duration: number;
  position: number;
}
export interface ListeningSample {
  track: Track;
  playedSeconds: number;
  position: number;
  duration: number;
}
export interface AudioEvents {
  time: (position: number, duration: number) => void;
  playing: (playing: boolean) => void;
  waiting: (waiting: boolean) => void;
  ended: () => void;
  error: (message: string) => void;
  transition?: (event: AudioTransition) => void;
  listened?: (sample: ListeningSample) => void;
  mixStatus?: (message: string | null) => void;
}
const noop = () => undefined;
const emptyEvents: AudioEvents = {
  time: noop,
  playing: noop,
  waiting: noop,
  ended: noop,
  error: noop,
};
interface PlaybackAudioSession {
  type: string;
}
interface Deck {
  audio: HTMLAudioElement;
  track: Track | null;
  url: string | null;
  pendingPosition: number;
  ready: boolean;
  playing: boolean;
  allowedToPlay: boolean;
  lastPosition: number;
  playedSeconds: number;
  objectUrl: string | null;
}
interface Transition {
  from: Deck;
  to: Deck;
  progress: number;
  duration: number;
  elapsed: number;
  anchor: number;
  paused: boolean;
  committed: boolean;
  ready: boolean;
}
const defaults: WaveMixSettings = {
  enabled: false,
  durationSeconds: 6,
  smartCue: true,
  earlyTransition: true,
};
const abortError = () => new DOMException("Playback cancelled", "AbortError");

/** One ordinary channel and at most one prepared/mixing channel; no hidden third player. */
export class AudioController {
  private primary: Deck | null = null;
  private standby: Deck | null = null;
  private events = emptyEvents;
  private revision = 0;
  private cancelLoad: (() => void) | null = null;
  private volumeValue = 0.8;
  private settings = { ...defaults };
  private mixer: WaveMixEngine;
  private transition: Transition | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private mixAttempt = "";
  private deferredPreparation:
    { url: string | null; track?: Track } | undefined;
  private playbackSession: {
    session: PlaybackAudioSession;
    previousType: string;
  } | null = null;
  constructor(
    private factory: () => HTMLAudioElement = () => new Audio(),
    contextFactory?: AudioContextFactory,
  ) {
    this.mixer = new WaveMixEngine(contextFactory);
  }
  bind(events: AudioEvents) {
    this.events = events;
  }

  private createDeck(): Deck {
    const audio = this.factory();
    audio.preload = "metadata";
    const deck: Deck = {
      audio,
      track: null,
      url: null,
      pendingPosition: 0,
      ready: false,
      playing: false,
      allowedToPlay: false,
      lastPosition: 0,
      playedSeconds: 0,
      objectUrl: null,
    };
    audio.addEventListener("timeupdate", () => {
      this.sample(deck);
      if (deck === this.primary && deck.track) {
        this.updateTime();
        void this.considerMix();
      }
    });
    audio.addEventListener("loadedmetadata", () => {
      if (deck.pendingPosition > 0) {
        audio.currentTime = Math.min(
          deck.pendingPosition,
          Math.max(0, this.duration(deck) - 0.1),
        );
        deck.lastPosition = audio.currentTime;
        deck.pendingPosition = 0;
      }
      deck.ready = audio.readyState >= 2;
      if (deck === this.primary && deck.track) this.updateTime();
    });
    for (const event of ["canplay", "loadeddata"])
      audio.addEventListener(event, () => {
        deck.ready = true;
        if (deck === this.primary && deck.track) this.events.waiting(false);
        void this.considerMix();
      });
    audio.addEventListener("playing", () => {
      if (!deck.track || !deck.allowedToPlay) {
        audio.pause();
        return;
      }
      deck.playing = true;
      deck.lastPosition = audio.currentTime;
      if (deck === this.primary) {
        this.events.playing(true);
        this.events.waiting(false);
        this.playbackState("playing");
      }
    });
    audio.addEventListener("pause", () => {
      this.sample(deck);
      deck.playing = false;
      if (deck === this.primary) {
        this.events.playing(false);
        this.playbackState(deck.track ? "paused" : "none");
      }
    });
    audio.addEventListener("waiting", () => {
      if (this.transition?.to === deck && this.transition.ready) {
        this.cancelTransition(
          "Следующий трек буферизуется. Используем обычное переключение.",
        );
      } else if (deck === this.primary && deck.track) this.events.waiting(true);
    });
    audio.addEventListener("ended", () => this.ended(deck));
    audio.addEventListener("error", () => this.failed(deck));
    return deck;
  }
  private active() {
    return (this.primary ??= this.createDeck());
  }
  private duration(deck: Deck) {
    return Number.isFinite(deck.audio.duration) && deck.audio.duration > 0
      ? deck.audio.duration
      : deck.track?.duration || 0;
  }
  private sample(deck: Deck) {
    const position = deck.audio.currentTime;
    const delta = position - deck.lastPosition;
    if (deck.track && deck.playing && delta > 0 && delta <= 3) {
      deck.playedSeconds += delta;
      this.events.listened?.({
        track: deck.track,
        playedSeconds: deck.playedSeconds,
        position,
        duration: this.duration(deck),
      });
    }
    deck.lastPosition = position;
  }
  private clearDeck(deck: Deck) {
    this.sample(deck);
    deck.track = null;
    deck.allowedToPlay = false;
    deck.url = null;
    deck.playing = false;
    deck.ready = false;
    deck.audio.pause();
    deck.audio.removeAttribute("src");
    deck.audio.load();
    if (deck.objectUrl) URL.revokeObjectURL(deck.objectUrl);
    deck.objectUrl = null;
    this.mixer.level(deck.audio, 0);
  }
  private assign(
    deck: Deck,
    url: string,
    track: Track | null,
    position: number,
  ) {
    deck.track = null;
    deck.allowedToPlay = false;
    deck.audio.pause();
    if (deck.objectUrl && deck.objectUrl !== url)
      URL.revokeObjectURL(deck.objectUrl);
    deck.objectUrl = url.startsWith("blob:") ? url : null;
    deck.track = track;
    deck.url = url;
    deck.playing = false;
    deck.ready = false;
    deck.playedSeconds = 0;
    deck.pendingPosition = Math.max(0, position);
    deck.lastPosition = Math.max(0, position);
    // Anonymous CORS is set before src, never after a cross-origin resource is loaded.
    if (track?.audioSource?.cors && /^https?:/i.test(url))
      deck.audio.crossOrigin = "anonymous";
    else deck.audio.removeAttribute("crossorigin");
    deck.audio.src = url;
    deck.audio.load();
  }

  async load(url: string, track: Track, position = 0, autoplay = true) {
    const legacyLocal =
      !track.rights &&
      (track.sourceId === "notesound" ||
        (track.local && track.sourceId === "local"));
    if (
      (!legacyLocal &&
        track.rights?.status !== "confirmed" &&
        !isProviderAudio(track)) ||
      track.availability === "unavailable"
    )
      throw new Error(
        "Источник не подтвердил право на воспроизведение этой записи.",
      );
    const revision = ++this.revision;
    this.cancelLoad?.();
    this.cancelLoad = null;
    this.cancelTransition();
    this.deferredPreparation = undefined;
    this.mixAttempt = "";
    this.releasePlaybackSession();
    let deck = this.active();
    if (this.mixer.routed(deck.audio) && !supportsMix(track, url)) {
      // A MediaElementSource cannot be detached back to native output. Retire
      // this stopped element before loading an ordinary non-CORS source.
      this.clearDeck(deck);
      this.mixer.release(deck.audio);
      deck = this.primary = this.createDeck();
    }
    this.assign(deck, url, track, position);
    if (this.standby) this.clearDeck(this.standby);
    this.metadata(track);
    if (!autoplay) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      this.cancelLoad = () => reject(abortError());
      timer = setTimeout(
        () =>
          reject(
            new Error(
              "Аудио загружается слишком долго. Проверьте соединение или выберите другой трек.",
            ),
          ),
        20000,
      );
    });
    // Cancellation can arrive while optional Web Audio is resuming.
    void cancelled.catch(noop);
    try {
      this.usePlaybackSession();
      if (this.settings.enabled && supportsMix(track, url)) {
        try {
          await this.mixer.route(deck.audio);
          if (revision !== this.revision) return;
          this.restoreLevel(deck);
        } catch {
          if (revision !== this.revision) return;
          if (this.mixer.routed(deck.audio)) {
            // A previously routed element cannot play through native output
            // while its AudioContext is suspended. Use a fresh ordinary deck.
            this.clearDeck(deck);
            this.mixer.release(deck.audio);
            deck = this.primary = this.createDeck();
            this.assign(deck, url, track, position);
          }
          this.events.mixStatus?.(
            "Wave Mix недоступен. Музыка продолжится с обычными переходами.",
          );
        }
      }
      if (revision !== this.revision) return;
      deck.allowedToPlay = true;
      await Promise.race([deck.audio.play(), cancelled]);
      if (revision !== this.revision) return;
    } catch (error) {
      if (
        revision !== this.revision ||
        (error as DOMException).name === "AbortError"
      )
        return;
      // A timed-out play request can still produce a late native event.
      // Revoke playback before pausing so that event cannot revive the deck.
      deck.allowedToPlay = false;
      deck.audio.pause();
      this.releasePlaybackSession();
      this.events.waiting(false);
      this.events.playing(false);
      throw error;
    } finally {
      clearTimeout(timer);
      if (revision === this.revision) this.cancelLoad = null;
    }
  }
  async resume() {
    const revision = this.revision;
    const deck = this.active();
    if (!deck.track) throw new Error("Сначала выберите композицию.");
    this.usePlaybackSession();
    const transition = this.transition;
    try {
      if (transition?.ready && transition.paused) {
        await this.mixer.unlock();
        if (revision !== this.revision || this.transition !== transition)
          return;
        transition.from.allowedToPlay = true;
        transition.to.allowedToPlay = true;
        const results = await Promise.allSettled([
          transition.from.audio.play(),
          transition.to.audio.play(),
        ]);
        if (revision !== this.revision || this.transition !== transition)
          return;
        if (results.some((result) => result.status === "rejected")) {
          this.cancelTransition(
            "Не удалось продолжить сведение. Используем обычное воспроизведение.",
          );
          if (!this.primary?.playing) await this.primary?.audio.play();
          return;
        }
        transition.paused = false;
        transition.anchor = this.mixer.currentTime;
        this.mixer.schedule(
          transition.from.audio,
          transition.to.audio,
          transition.progress,
          transition.duration - transition.elapsed,
          this.volumeValue,
        );
        this.startTick();
      } else {
        if (this.mixer.routed(deck.audio)) await this.mixer.unlock();
        if (revision !== this.revision || deck !== this.primary) return;
        deck.allowedToPlay = true;
        await deck.audio.play();
      }
    } catch (error) {
      if (revision !== this.revision) return;
      this.releasePlaybackSession();
      throw error;
    }
  }
  pause() {
    ++this.revision;
    if (this.cancelLoad) {
      this.cancelLoad();
      this.cancelLoad = null;
    }
    if (this.primary) this.primary.allowedToPlay = false;
    if (this.standby) this.standby.allowedToPlay = false;
    const transition = this.transition;
    if (transition && !transition.ready) {
      this.cancelTransition();
      this.primary?.audio.pause();
      return;
    }
    if (transition?.ready) {
      this.updateTransition();
      if (this.transition === transition) {
        transition.paused = true;
        transition.elapsed = transition.progress * transition.duration;
        this.setTransitionLevels(transition);
        this.clearTick();
        transition.from.audio.pause();
        transition.to.audio.pause();
      } else this.primary?.audio.pause();
    } else this.primary?.audio.pause();
  }
  stop() {
    ++this.revision;
    this.cancelLoad?.();
    this.cancelLoad = null;
    this.cancelTransition();
    if (this.primary) this.clearDeck(this.primary);
    if (this.standby) this.clearDeck(this.standby);
    this.deferredPreparation = undefined;
    this.releasePlaybackSession();
    this.playbackState("none");
  }
  seek(seconds: number) {
    this.cancelTransition();
    const deck = this.primary;
    if (!deck?.track) return;
    deck.audio.currentTime = Math.max(
      0,
      Math.min(seconds, this.duration(deck) || Infinity),
    );
    deck.lastPosition = deck.audio.currentTime;
    this.updateTime();
  }
  volume(value: number) {
    this.volumeValue = Math.max(0, Math.min(1, value));
    const deck = this.active();
    if (this.transition?.ready) {
      this.updateTransition();
      const transition = this.transition;
      if (transition) {
        if (transition.paused) this.setTransitionLevels(transition);
        else
          this.mixer.schedule(
            transition.from.audio,
            transition.to.audio,
            transition.progress,
            transition.duration * (1 - transition.progress),
            this.volumeValue,
          );
      }
    } else this.restoreLevel(deck);
  }
  configureMix(settings: WaveMixSettings) {
    this.settings = {
      enabled: settings.enabled === true,
      durationSeconds: Math.max(
        2,
        Math.min(
          12,
          Number.isFinite(settings.durationSeconds)
            ? settings.durationSeconds
            : 6,
        ),
      ),
      smartCue: settings.smartCue !== false,
      earlyTransition: settings.earlyTransition !== false,
    };
    if (!this.settings.enabled) this.cancelTransition();
    if (this.primary && !this.transition) this.restoreLevel(this.primary);
    this.mixAttempt = "";
  }
  prepare(url: string | null, track?: Track) {
    const legacyLocal =
      track &&
      !track.rights &&
      (track.sourceId === "notesound" ||
        (track.local && track.sourceId === "local"));
    if (
      url &&
      track &&
      !legacyLocal &&
      track.rights?.status !== "confirmed" &&
      !isProviderAudio(track)
    ) {
      this.events.mixStatus?.(
        "Источник не подтвердил право на подготовку следующей записи.",
      );
      return;
    }
    const transition = this.transition;
    if (transition) {
      const sameIncoming =
        !!url &&
        (track
          ? track.id === transition.to.track?.id
          : url === transition.to.url);
      if (sameIncoming) {
        if (url.startsWith("blob:") && url !== transition.to.url)
          URL.revokeObjectURL(url);
        return;
      }
      if (!transition.committed) {
        // A manual queue change must replace the pending next song rather
        // than allowing the old automatic choice to commit at midpoint.
        this.cancelTransition();
      } else {
        const previous = this.deferredPreparation?.url;
        if (previous?.startsWith("blob:") && previous !== url)
          URL.revokeObjectURL(previous);
        this.deferredPreparation = { url, track };
        return;
      }
    }
    if (this.standby?.url === url && this.standby.track?.id === track?.id)
      return;
    if (this.standby) this.clearDeck(this.standby);
    this.mixAttempt = "";
    if (!url) return;
    const deck = (this.standby ??= this.createDeck());
    this.assign(
      deck,
      url,
      track ?? null,
      track
        ? planTransition(this.primary?.track ?? track, track, this.settings)
            .cueInSeconds
        : 0,
    );
    deck.audio.preload = "metadata";
    deck.audio.muted = true;
  }
  private restoreLevel(deck: Deck) {
    if (this.mixer.routed(deck.audio))
      this.mixer.level(
        deck.audio,
        this.volumeValue * (this.settings.enabled ? MIX_HEADROOM : 1),
      );
    else deck.audio.volume = this.volumeValue;
  }
  private async considerMix() {
    const current = this.primary;
    const next = this.standby;
    if (
      !this.settings.enabled ||
      this.transition ||
      !current?.track ||
      !next?.track ||
      !current.playing ||
      !next.ready ||
      !current.url ||
      !next.url
    )
      return;
    const key = `${current.track.id}:${next.track.id}:${next.url}`;
    if (this.mixAttempt === key) return;
    const plan = planTransition(
      current.track,
      next.track,
      this.settings,
      this.duration(current),
    );
    if (
      current.audio.currentTime < plan.transitionAtSeconds ||
      plan.durationSeconds < 0.25
    )
      return;
    if (
      !supportsMix(current.track, current.url) ||
      !supportsMix(next.track, next.url)
    ) {
      this.mixAttempt = key;
      this.events.mixStatus?.(
        "Источник не поддерживает Wave Mix. Следующая песня начнётся обычным способом.",
      );
      return;
    }
    this.mixAttempt = key;
    const revision = this.revision;
    const duration = Math.min(
      plan.durationSeconds,
      Math.max(0, this.duration(current) - current.audio.currentTime),
    );
    if (duration < 0.25) return;
    const transition: Transition = {
      from: current,
      to: next,
      duration,
      elapsed: 0,
      anchor: 0,
      progress: 0,
      paused: false,
      committed: false,
      ready: false,
    };
    this.transition = transition;
    try {
      await this.mixer.route(current.audio);
      await this.mixer.route(next.audio);
      if (revision !== this.revision || this.transition !== transition) return;
      this.mixer.level(current.audio, this.volumeValue * MIX_HEADROOM);
      this.mixer.level(next.audio, 0);
      next.audio.muted = false;
      next.audio.currentTime = Math.min(
        plan.cueInSeconds,
        Math.max(0, this.duration(next) - 0.1),
      );
      next.lastPosition = next.audio.currentTime;
      let startTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        next.allowedToPlay = true;
        await Promise.race([
          next.audio.play(),
          new Promise<never>((_, reject) => {
            startTimer = setTimeout(
              () =>
                reject(
                  new Error("Следующий источник не начал воспроизведение."),
                ),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(startTimer);
      }
      if (revision !== this.revision || this.transition !== transition) {
        if (next !== this.primary) next.audio.pause();
        return;
      }
      transition.ready = true;
      transition.anchor = this.mixer.currentTime;
      this.events.mixStatus?.(null);
      this.mixer.schedule(
        current.audio,
        next.audio,
        0,
        duration,
        this.volumeValue,
      );
      this.emitTransition("started", transition);
      this.startTick();
    } catch {
      if (revision === this.revision && this.transition === transition)
        this.cancelTransition(
          "Не удалось подготовить сведение. Музыка продолжится с обычными переходами.",
        );
    }
  }
  private startTick() {
    this.clearTick();
    this.tick = setInterval(() => {
      this.sample(this.transition?.from ?? this.primary!);
      if (this.transition) this.sample(this.transition.to);
      this.updateTransition();
    }, 100);
  }
  private clearTick() {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
  }
  private updateTransition() {
    const transition = this.transition;
    if (!transition?.ready || transition.paused) return;
    transition.progress = Math.max(
      0,
      Math.min(
        1,
        (transition.elapsed + this.mixer.currentTime - transition.anchor) /
          transition.duration,
      ),
    );
    if (transition.progress >= 0.5 && !transition.committed) {
      transition.committed = true;
      this.primary = transition.to;
      this.standby = transition.from;
      this.metadata(transition.to.track!);
      this.emitTransition("committed", transition);
      this.updateTime();
    }
    this.emitTransition("progress", transition);
    if (transition.progress >= 1) this.finishTransition();
  }
  private setTransitionLevels(transition: Transition) {
    this.mixer.level(
      transition.from.audio,
      Math.cos((transition.progress * Math.PI) / 2) *
        this.volumeValue *
        MIX_HEADROOM,
    );
    this.mixer.level(
      transition.to.audio,
      Math.sin((transition.progress * Math.PI) / 2) *
        this.volumeValue *
        MIX_HEADROOM,
    );
  }
  private finishTransition() {
    const transition = this.transition;
    if (!transition) return;
    if (!transition.committed) {
      transition.committed = true;
      this.primary = transition.to;
      this.standby = transition.from;
      this.metadata(transition.to.track!);
      this.emitTransition("committed", transition);
    }
    transition.progress = 1;
    this.emitTransition("completed", transition);
    this.transition = null;
    this.clearTick();
    this.clearDeck(transition.from);
    this.restoreLevel(transition.to);
    this.updateTime();
    const deferred = this.deferredPreparation;
    this.deferredPreparation = undefined;
    if (deferred) this.prepare(deferred.url, deferred.track);
  }
  private cancelTransition(reason?: string) {
    const transition = this.transition;
    if (!transition) return;
    this.transition = null;
    this.clearTick();
    this.emitTransition("cancelled", transition);
    const retired = transition.committed ? transition.from : transition.to;
    this.primary = transition.committed ? transition.to : transition.from;
    this.standby = retired;
    this.clearDeck(retired);
    this.restoreLevel(this.primary);
    this.deferredPreparation = undefined;
    if (reason) this.events.mixStatus?.(reason);
  }
  private emitTransition(
    phase: AudioTransition["phase"],
    transition: Transition,
  ) {
    if (!transition.from.track || !transition.to.track) return;
    this.events.transition?.({
      phase,
      from: transition.from.track,
      to: transition.to.track,
      progress: transition.progress,
      duration: transition.duration,
      position: transition.to.audio.currentTime,
    });
  }
  private ended(deck: Deck) {
    this.sample(deck);
    deck.allowedToPlay = false;
    deck.playing = false;
    const transition = this.transition;
    if (transition?.ready) {
      if (deck === transition.from) {
        this.finishTransition();
        return;
      }
      if (deck === transition.to && !transition.committed) {
        this.cancelTransition(
          "Следующий трек закончился раньше перехода. Используем обычный порядок.",
        );
        return;
      }
      if (deck === transition.to) this.finishTransition();
    }
    if (deck !== this.primary || !deck.track) return;
    this.releasePlaybackSession();
    this.playbackState("none");
    this.events.playing(false);
    this.events.ended();
  }
  private failed(deck: Deck) {
    deck.allowedToPlay = false;
    deck.ready = false;
    if (
      this.transition &&
      (deck === this.transition.to || deck === this.transition.from)
    ) {
      const isPrimary = deck === this.primary;
      this.cancelTransition("Сведение остановлено из-за ошибки источника.");
      if (!isPrimary || this.primary?.playing) return;
    }
    if (deck !== this.primary) {
      this.events.mixStatus?.("Следующий источник не готов для Wave Mix.");
      return;
    }
    this.releasePlaybackSession();
    this.playbackState("none");
    this.events.waiting(false);
    this.events.playing(false);
    this.events.error(
      "Не удалось загрузить аудио. Попробуйте другую композицию.",
    );
  }
  private updateTime() {
    const deck = this.primary;
    if (!deck?.track) return;
    this.events.time(
      Number.isFinite(deck.audio.currentTime) ? deck.audio.currentTime : 0,
      this.duration(deck),
    );
    this.positionState(deck);
  }
  /** A platform hint for authorized ordinary audio, not a background-playback guarantee. */
  private usePlaybackSession() {
    if (typeof navigator === "undefined") return;
    try {
      const session = (
        navigator as Navigator & { audioSession?: PlaybackAudioSession }
      ).audioSession;
      if (!session || typeof session.type !== "string") return;
      if (this.playbackSession?.session === session) {
        session.type = "playback";
        return;
      }
      this.releasePlaybackSession();
      const previousType = session.type;
      session.type = "playback";
      this.playbackSession = { session, previousType };
    } catch {
      /* Optional APIs cannot interrupt ordinary audio. */
    }
  }
  private releasePlaybackSession() {
    const previous = this.playbackSession;
    this.playbackSession = null;
    if (!previous) return;
    try {
      if (previous.session.type === "playback")
        previous.session.type = previous.previousType;
    } catch {
      /* Host may revoke capability. */
    }
  }
  private metadata(track: Track) {
    if (
      typeof navigator === "undefined" ||
      !("mediaSession" in navigator) ||
      typeof MediaMetadata === "undefined"
    )
      return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album ?? "NoteSound",
        artwork: track.artwork
          ? [{ src: new URL(track.artwork, location.href).href }]
          : [],
      });
    } catch {
      /* Metadata is optional. */
    }
  }
  private playbackState(value: MediaSessionPlaybackState) {
    try {
      if (typeof navigator !== "undefined" && "mediaSession" in navigator)
        navigator.mediaSession.playbackState = value;
    } catch {
      /* Optional embedded-host capability. */
    }
  }
  private positionState(deck: Deck) {
    if (
      typeof navigator === "undefined" ||
      !("mediaSession" in navigator) ||
      !navigator.mediaSession.setPositionState
    )
      return;
    const duration = this.duration(deck);
    if (duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.min(Math.max(0, deck.audio.currentTime), duration),
        playbackRate: deck.audio.playbackRate,
      });
    } catch {
      /* Host capabilities vary. */
    }
  }
}
export { AudioController as AudioEngine };
export const audioController = new AudioController();
