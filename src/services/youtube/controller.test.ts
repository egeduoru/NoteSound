import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  YouTubeController,
  type YouTubeApi,
  type YouTubePlayer,
  type YouTubePlayerOptions,
  type YouTubeTrack,
} from "./controller";

const track: YouTubeTrack = {
  id: "youtube:abcdefghijk",
  sourceId: "youtube",
  title: "Династия",
  artist: "VILLIAN, madk1d",
  duration: 150,
  genres: ["rap"],
  license: { name: "YouTube embedded player", download: false },
  playback: { kind: "youtube", videoId: "abcdefghijk" },
};
class FakeWindow extends EventTarget {
  innerWidth = 1024;
  innerHeight = 768;
  location = { origin: "https://notesound.example" };
}
class FakeDocument extends EventTarget {
  hidden = false;
  createElement = vi.fn(() => ({}));
}
class FakeHost {
  isConnected = true;
  width = 400;
  height = 225;
  left = 0;
  top = 0;
  replaceChildren = vi.fn();
  getBoundingClientRect() {
    return {
      width: this.width,
      height: this.height,
      left: this.left,
      top: this.top,
      right: this.left + this.width,
      bottom: this.top + this.height,
    };
  }
}
class FakePlayer implements YouTubePlayer {
  videoId = "";
  time = 0;
  duration = 150;
  state = 5;
  iframe = {} as HTMLIFrameElement;
  autoPlay = true;
  loadVideoById = vi.fn(
    (options: { videoId: string; startSeconds: number }) => {
      this.videoId = options.videoId;
      this.time = options.startSeconds;
      if (this.autoPlay) this.emit(1);
    },
  );
  cueVideoById = vi.fn((options: { videoId: string; startSeconds: number }) => {
    this.videoId = options.videoId;
    this.time = options.startSeconds;
    this.emit(5);
  });
  playVideo = vi.fn(() => {
    if (this.autoPlay) this.emit(1);
  });
  pauseVideo = vi.fn(() => this.emit(2));
  stopVideo = vi.fn(() => {
    this.state = -1;
  });
  seekTo = vi.fn((seconds: number) => {
    this.time = seconds;
  });
  setVolume = vi.fn();
  getCurrentTime = () => this.time;
  getDuration = () => this.duration;
  getPlayerState = () => this.state;
  getVideoData = () => ({ video_id: this.videoId });
  getIframe = () => this.iframe;
  destroy = vi.fn();
  constructor(
    _host: HTMLElement,
    readonly options: YouTubePlayerOptions,
  ) {
    queueMicrotask(() => options.events.onReady({ target: this }));
  }
  emit(state: number) {
    this.state = state;
    this.options.events.onStateChange({ target: this, data: state });
  }
  error(code: number) {
    this.options.events.onError({ target: this, data: code });
  }
}

function setup() {
  const players: FakePlayer[] = [];
  class Player extends FakePlayer {
    constructor(host: HTMLElement, options: YouTubePlayerOptions) {
      super(host, options);
      players.push(this);
    }
  }
  const api: YouTubeApi = { Player };
  const controller = new YouTubeController(async () => api);
  const events = {
    time: vi.fn(),
    playing: vi.fn(),
    waiting: vi.fn(),
    ended: vi.fn(),
    error: vi.fn(),
  };
  controller.bind(events);
  const host = new FakeHost();
  const unmount = controller.mount(host as unknown as HTMLElement);
  return { controller, players, host, events, unmount };
}
let cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", new FakeWindow());
  vi.stubGlobal("document", new FakeDocument());
  vi.stubGlobal("IntersectionObserver", undefined);
});
afterEach(() => {
  cleanups.forEach((cleanup) => cleanup());
  cleanups = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function create() {
  const value = setup();
  cleanups.push(value.unmount);
  return value;
}

describe("official YouTube controller", () => {
  it("uses one visible iframe, preserves official controls and identifies the origin", async () => {
    const { controller, players, events } = create();
    await controller.load(track, 11);
    await controller.load({
      ...track,
      id: "youtube:ABCDEFGHIJK",
      playback: { kind: "youtube", videoId: "ABCDEFGHIJK" },
    });
    expect(players).toHaveLength(1);
    expect(players[0].loadVideoById).toHaveBeenNthCalledWith(1, {
      videoId: "abcdefghijk",
      startSeconds: 11,
    });
    expect(players[0].options.playerVars).toMatchObject({
      controls: 1,
      playsinline: 1,
      origin: "https://notesound.example",
    });
    expect(players[0].iframe.referrerPolicy).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(events.playing).toHaveBeenLastCalledWith(true);
  });
  it("cues restored state without autoplay and supports seek and volume", async () => {
    const { controller, players, events } = create();
    await controller.load(track, 42, false);
    expect(players[0].loadVideoById).not.toHaveBeenCalled();
    expect(players[0].cueVideoById).toHaveBeenCalledWith({
      videoId: "abcdefghijk",
      startSeconds: 42,
    });
    controller.seek(500);
    expect(players[0].seekTo).toHaveBeenCalledWith(150, true);
    controller.volume(0.23);
    expect(players[0].setVolume).toHaveBeenLastCalledWith(23);
    expect(events.time).toHaveBeenLastCalledWith(150, 150);
  });
  it("forwards actual progress and ending to the app queue", async () => {
    const { controller, players, events } = create();
    await controller.load(track);
    players[0].time = 37;
    await vi.advanceTimersByTimeAsync(500);
    expect(events.time).toHaveBeenLastCalledWith(37, 150);
    players[0].emit(0);
    expect(events.ended).toHaveBeenCalledOnce();
    expect(events.playing).toHaveBeenLastCalledWith(false);
  });
  it("pauses when the document becomes hidden and never auto resumes on return", async () => {
    const { controller, players, events } = create();
    await controller.load(track);
    const doc = document as unknown as FakeDocument;
    doc.hidden = true;
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(players[0].pauseVideo).toHaveBeenCalled();
    expect(events.playing).toHaveBeenLastCalledWith(false);
    doc.hidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(players[0].playVideo).not.toHaveBeenCalled();
  });
  it("refuses playback in a smaller than 200x200 or mostly offscreen player", async () => {
    const { controller, host, players } = create();
    host.height = 199;
    await expect(controller.load(track)).rejects.toHaveProperty(
      "name",
      "NotAllowedError",
    );
    expect(players[0].loadVideoById).not.toHaveBeenCalled();
    host.height = 225;
    host.left = 900;
    await expect(controller.load(track)).rejects.toHaveProperty(
      "name",
      "NotAllowedError",
    );
  });
  it("surfaces disabled embedding and missing referrer errors without extracting audio", async () => {
    const { controller, players, events } = create();
    await controller.load(track, 0, false);
    players[0].error(101);
    expect(events.error).toHaveBeenLastCalledWith(
      expect.stringContaining("Автор запретил"),
    );
    players[0].error(153);
    expect(events.error).toHaveBeenLastCalledWith(
      expect.stringContaining("адрес приложения"),
    );
  });
  it("rejects blocked autoplay but accepts a subsequent explicit user play", async () => {
    const { controller, players, events } = create();
    await controller.load(track, 0, false);
    players[0].autoPlay = false;
    const pending = controller.resume();
    const rejected = expect(pending).rejects.toHaveProperty(
      "name",
      "NotAllowedError",
    );
    await Promise.resolve();
    players[0].options.events.onAutoplayBlocked();
    await rejected;
    players[0].autoPlay = true;
    await controller.resume();
    expect(events.playing).toHaveBeenLastCalledWith(true);
  });
  it("stop settles an outstanding load and prevents a late playback from starting", async () => {
    const { controller, players, events } = create();
    await controller.load(track, 0, false);
    players[0].autoPlay = false;
    const pending = controller.load(track);
    const rejected = expect(pending).rejects.toHaveProperty(
      "name",
      "AbortError",
    );
    await Promise.resolve();
    controller.stop();
    await rejected;
    players[0].emit(1);
    expect(events.playing).toHaveBeenLastCalledWith(false);
    expect(players[0].pauseVideo).toHaveBeenCalled();
  });
  it("times out a stalled play without leaving an indefinite spinner", async () => {
    const { controller, players, events } = create();
    await controller.load(track, 0, false);
    players[0].autoPlay = false;
    const pending = controller.load(track);
    const rejected = expect(pending).rejects.toThrow("слишком долго");
    await vi.advanceTimersByTimeAsync(20000);
    await rejected;
    expect(events.waiting).toHaveBeenLastCalledWith(false);
  });
});
