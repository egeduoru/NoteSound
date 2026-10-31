import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioController, type AudioTransition } from "./controller";
import type { Track, WaveMixSettings } from "../../types/music";
import { MIX_HEADROOM } from "../../features/mix/engine";
class Audio extends EventTarget {
  currentTime = 0;
  duration = 100;
  readyState = 4;
  volume = 1;
  playbackRate = 1;
  muted = false;
  src = "";
  preload = "";
  crossOrigin = "";
  paused = true;
  play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event("playing"));
  });
  pause = vi.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  });
  load = vi.fn();
  removeAttribute = vi.fn((name: string) => {
    if (name === "src") this.src = "";
    if (name === "crossorigin") this.crossOrigin = "";
  });
  ready() {
    this.dispatchEvent(new Event("loadedmetadata"));
    this.dispatchEvent(new Event("canplay"));
  }
  time(value: number) {
    this.currentTime = value;
    this.dispatchEvent(new Event("timeupdate"));
  }
}
class Param {
  value = 0;
  cancelScheduledValues = vi.fn();
  setValueAtTime = vi.fn((value: number) => {
    this.value = value;
    return this;
  });
  setValueCurveAtTime = vi.fn((curve: Float32Array) => {
    this.value = curve[0];
    return this;
  });
}
class Context {
  state: AudioContextState = "running";
  destination = {};
  graphs: {
    audio: HTMLAudioElement;
    source: {
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    };
  }[] = [];
  gains: {
    gain: Param;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  get currentTime() {
    return Date.now() / 1000;
  }
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });
  createMediaElementSource = vi.fn((audio: HTMLAudioElement) => {
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    this.graphs.push({ audio, source });
    return source;
  });
  createGain = vi.fn(() => {
    const gain = { gain: new Param(), connect: vi.fn(), disconnect: vi.fn() };
    this.gains.push(gain);
    return gain;
  });
}
const one: Track = {
  id: "one",
  sourceId: "licensed",
  title: "One",
  artist: "Artist A",
  duration: 100,
  genres: [],
  license: { name: "licensed", download: false },
  rights: { status: "confirmed", basis: "license", allowMix: true },
};
const two: Track = { ...one, id: "two", title: "Two", artist: "Artist B" };
const mix: WaveMixSettings = {
  enabled: true,
  durationSeconds: 6,
  smartCue: true,
  earlyTransition: true,
};
function setup(contextFactory?: () => AudioContext) {
  const elements: Audio[] = [];
  const context = new Context();
  const controller = new AudioController(
    () => {
      const audio = new Audio();
      elements.push(audio);
      return audio as unknown as HTMLAudioElement;
    },
    contextFactory ?? (() => context as unknown as AudioContext),
  );
  const events = {
    time: vi.fn(),
    playing: vi.fn(),
    waiting: vi.fn(),
    ended: vi.fn(),
    error: vi.fn(),
    transition: vi.fn<(event: AudioTransition) => void>(),
    listened: vi.fn(),
    mixStatus: vi.fn(),
  };
  controller.bind(events);
  controller.configureMix(mix);
  return { controller, elements, context, events };
}
async function begin(s: ReturnType<typeof setup>, next: Track = two) {
  await s.controller.load("/one.wav", one);
  s.controller.prepare("/two.wav", next);
  s.elements[1].ready();
  s.elements[0].time(94);
  await vi.advanceTimersByTimeAsync(0);
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("two-channel Wave Mix", () => {
  it("schedules complementary gain curves on one reused context and commits at midpoint", async () => {
    const s = setup();
    await begin(s);
    expect(s.elements).toHaveLength(2);
    expect(s.elements[0].paused).toBe(false);
    expect(s.elements[1].paused).toBe(false);
    expect(s.context.createMediaElementSource).toHaveBeenCalledTimes(2);
    expect(s.events.transition).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "started", duration: 6 }),
    );
    const curves = s.context.gains.map(
      (graph) => graph.gain.setValueCurveAtTime.mock.calls[0][0],
    );
    expect(curves[0][0]).toBeCloseTo(MIX_HEADROOM * 0.8);
    expect(curves[1][0]).toBe(0);
    for (let i = 0; i < curves[0].length; i++)
      expect(curves[0][i] + curves[1][i]).toBeLessThanOrEqual(0.80001);
    s.elements[1].currentTime = 3;
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.events.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "committed",
        to: two,
        progress: 0.5,
        position: 3,
      }),
    );
    expect(s.events.time).toHaveBeenLastCalledWith(3, 100);
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.elements[0].src).toBe("");
    expect(s.elements[0].paused).toBe(true);
    expect(s.elements[1].paused).toBe(false);
    expect(s.events.transition).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "completed", progress: 1 }),
    );
    expect(s.events.ended).not.toHaveBeenCalled();
    s.controller.stop();
  });
  it("uses a reliable cue start and shows the real new position at midpoint", async () => {
    const s = setup();
    await begin(s, {
      ...two,
      cuePoints: { cueInSeconds: 38, cueConfidence: 0.9, cueSource: "manual" },
    });
    expect(s.elements[1].currentTime).toBe(38);
    s.elements[1].currentTime = 41;
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.events.transition).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "committed", position: 41 }),
    );
    s.controller.stop();
  });
  it("freezes both channels and transition progress on pause, then resumes the remainder", async () => {
    const s = setup();
    await begin(s);
    await vi.advanceTimersByTimeAsync(2000);
    s.controller.pause();
    expect(s.elements.every((audio) => audio.paused)).toBe(true);
    const count = s.events.transition.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20000);
    expect(s.events.transition).toHaveBeenCalledTimes(count);
    await s.controller.resume();
    expect(s.elements.every((audio) => !audio.paused)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.events.transition).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "committed", progress: 0.5 }),
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.elements[0].src).toBe("");
    s.controller.stop();
  });
  it("cancels an overlap on manual next without leaving a quiet third song", async () => {
    const s = setup();
    await begin(s);
    await vi.advanceTimersByTimeAsync(1000);
    await s.controller.load("/manual.wav", { ...one, id: "manual" });
    expect(s.events.transition).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "cancelled" }),
    );
    expect(s.elements).toHaveLength(2);
    expect(
      s.elements.filter((audio) => !audio.paused && audio.src),
    ).toHaveLength(1);
    expect(s.elements[0].src).toBe("/manual.wav");
    expect(s.elements[1].src).toBe("");
    await vi.advanceTimersByTimeAsync(10000);
    expect(s.elements[0].src).toBe("/manual.wav");
    s.controller.stop();
  });
  it("cancels after midpoint using the dominant new song, and seek never leaves old audio", async () => {
    const s = setup();
    await begin(s);
    await vi.advanceTimersByTimeAsync(3500);
    s.controller.seek(20);
    expect(s.elements[1].currentTime).toBe(20);
    expect(s.elements[0].src).toBe("");
    expect(
      s.elements.filter((audio) => !audio.paused && audio.src),
    ).toHaveLength(1);
    s.controller.stop();
  });
  it("defers a third preparation until the outgoing channel has been released", async () => {
    const s = setup();
    await begin(s);
    await vi.advanceTimersByTimeAsync(3000);
    s.controller.prepare("/third.wav", { ...one, id: "third" });
    expect(s.elements).toHaveLength(2);
    expect(s.elements[0].src).toBe("/one.wav");
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.elements).toHaveLength(2);
    expect(s.elements[0].src).toBe("/third.wav");
    expect(s.elements[0].paused).toBe(true);
    expect(s.context.createMediaElementSource).toHaveBeenCalledTimes(2);
    s.controller.stop();
  });
  it("replaces an uncommitted automatic mix when the next manual choice changes", async () => {
    const s = setup();
    await begin(s);
    await vi.advanceTimersByTimeAsync(1000);
    const manual = { ...one, id: "manual", title: "Manual" };
    s.controller.prepare("/manual.wav", manual);
    expect(s.events.transition).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "cancelled", to: two }),
    );
    expect(s.elements[0].paused).toBe(false);
    expect(s.elements[1].src).toBe("/manual.wav");
    expect(s.elements[1].paused).toBe(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(
      s.events.transition.mock.calls.some(
        ([event]) => event.phase === "committed" && event.to.id === two.id,
      ),
    ).toBe(false);
    s.elements[1].ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.events.transition).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "started", to: manual }),
    );
    s.controller.stop();
  });
  it("stops an incoming uncommitted song when its queue entry is removed", async () => {
    const s = setup();
    await begin(s);
    s.controller.prepare(null);
    await vi.advanceTimersByTimeAsync(6000);
    expect(s.elements[0].paused).toBe(false);
    expect(s.elements[1].src).toBe("");
    expect(s.elements[1].paused).toBe(true);
    expect(
      s.events.transition.mock.calls.some(
        ([event]) => event.phase === "committed",
      ),
    ).toBe(false);
    s.controller.stop();
  });
  it("does not start when next metadata or media is not ready", async () => {
    const s = setup();
    await s.controller.load("/one.wav", one);
    s.controller.prepare("/two.wav", two);
    s.elements[0].time(94);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.elements[1].play).not.toHaveBeenCalled();
    expect(s.events.transition).not.toHaveBeenCalled();
    s.controller.stop();
  });
  it("falls back without stopping the old song when incoming play fails", async () => {
    const s = setup();
    await s.controller.load("/one.wav", one);
    s.controller.prepare("/two.wav", two);
    s.elements[1].play.mockRejectedValueOnce(new Error("Network"));
    s.elements[1].ready();
    s.elements[0].time(94);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.elements[0].paused).toBe(false);
    expect(s.elements[1].paused).toBe(true);
    expect(s.events.error).not.toHaveBeenCalled();
    expect(s.events.mixStatus).toHaveBeenCalledWith(
      expect.stringContaining("обычными переходами"),
    );
    s.controller.stop();
  });
  it("times out incoming playback while preserving normal outgoing audio", async () => {
    const s = setup();
    await s.controller.load("/one.wav", one);
    s.controller.prepare("/two.wav", two);
    s.elements[1].play.mockImplementationOnce(
      () => new Promise<void>(() => undefined),
    );
    s.elements[1].ready();
    s.elements[0].time(94);
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.elements[0].paused).toBe(false);
    expect(s.elements[1].src).toBe("");
    expect(s.events.error).not.toHaveBeenCalled();
    s.controller.stop();
  });
  it("ignores an outgoing ended event and advances only when the incoming song ends", async () => {
    const s = setup();
    await begin(s);
    s.elements[0].dispatchEvent(new Event("ended"));
    expect(s.events.ended).not.toHaveBeenCalled();
    s.elements[1].dispatchEvent(new Event("ended"));
    expect(s.events.ended).toHaveBeenCalledOnce();
    s.controller.stop();
  });
  it("keeps ordinary native playback when Web Audio is unsupported", async () => {
    const s = setup(() => {
      throw new Error("Unsupported");
    });
    await begin(s);
    expect(s.elements[0].paused).toBe(false);
    expect(s.elements[1].play).not.toHaveBeenCalled();
    expect(s.events.error).not.toHaveBeenCalled();
    s.controller.stop();
  });
  it("falls back to a fresh native element if a previously routed context cannot resume", async () => {
    const s = setup();
    await s.controller.load("/one.wav", one);
    expect(s.context.createMediaElementSource).toHaveBeenCalledOnce();
    s.context.state = "suspended";
    s.context.resume.mockRejectedValueOnce(new Error("Context unavailable"));
    await s.controller.load("/two.wav", two, 12);
    expect(s.elements).toHaveLength(2);
    expect(s.elements[0].src).toBe("");
    expect(s.context.graphs[0].source.disconnect).toHaveBeenCalledOnce();
    expect(s.elements[1].src).toBe("/two.wav");
    expect(s.elements[1].paused).toBe(false);
    expect(s.context.createMediaElementSource).toHaveBeenCalledOnce();
    s.elements[1].ready();
    expect(s.elements[1].currentTime).toBe(12);
    expect(s.events.mixStatus).toHaveBeenCalledWith(
      expect.stringContaining("обычными переходами"),
    );
    s.controller.stop();
  });
  it("does not route incompatible remote audio through Web Audio", async () => {
    const s = setup();
    await s.controller.load("https://a.example/one.mp3", one);
    s.controller.prepare("/two.wav", two);
    s.elements[1].ready();
    s.elements[0].time(94);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.context.createMediaElementSource).not.toHaveBeenCalled();
    expect(s.elements[1].play).not.toHaveBeenCalled();
    expect(s.events.mixStatus).toHaveBeenCalledWith(
      expect.stringContaining("не поддерживает"),
    );
    s.controller.stop();
  });
  it("keeps Wave Mix disabled independently of normal automatic playback", async () => {
    const s = setup();
    s.controller.configureMix({ ...mix, enabled: false });
    await begin(s);
    expect(s.context.createMediaElementSource).not.toHaveBeenCalled();
    expect(s.elements[1].play).not.toHaveBeenCalled();
    s.controller.stop();
  });
  it("turning mixing off mid-overlap leaves one active song", async () => {
    const s = setup();
    await begin(s);
    await vi.advanceTimersByTimeAsync(2000);
    s.controller.configureMix({ ...mix, enabled: false });
    expect(
      s.elements.filter((audio) => !audio.paused && audio.src),
    ).toHaveLength(1);
    expect(s.elements[0].paused).toBe(false);
    s.controller.stop();
  });
  it("does not overwrite active fade gains when other settings are reapplied", async () => {
    const s = setup();
    await begin(s);
    await vi.advanceTimersByTimeAsync(1000);
    s.controller.volume(0.5);
    const changes = s.context.gains.map(
      (graph) => graph.gain.setValueAtTime.mock.calls.length,
    );
    s.controller.configureMix({ ...mix, durationSeconds: 8 });
    expect(
      s.context.gains.map(
        (graph) => graph.gain.setValueAtTime.mock.calls.length,
      ),
    ).toEqual(changes);
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.events.transition).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "completed", duration: 6 }),
    );
    s.controller.stop();
  });
  it("records cumulative actual listening on both channels, excluding seeks and paused gaps", async () => {
    const s = setup();
    await begin(s);
    s.events.listened.mockClear();
    s.elements[0].time(95);
    s.elements[1].time(1);
    expect(s.events.listened).toHaveBeenCalledWith(
      expect.objectContaining({ track: one, playedSeconds: 1 }),
    );
    expect(s.events.listened).toHaveBeenCalledWith(
      expect.objectContaining({ track: two, playedSeconds: 1 }),
    );
    s.controller.pause();
    s.elements[0].time(97);
    s.elements[1].time(3);
    const before = s.events.listened.mock.calls.length;
    s.controller.seek(50);
    s.elements[0].time(90);
    expect(s.events.listened).toHaveBeenCalledTimes(before);
    s.controller.stop();
  });
  it("rejects unconfirmed foreign streams but preserves explicitly local legacy playback", async () => {
    const s = setup();
    await expect(
      s.controller.load("/unlicensed.mp3", { ...one, rights: undefined }),
    ).rejects.toThrow("право");
    await expect(
      s.controller.load("/unlicensed.mp3", {
        ...one,
        rights: { ...one.rights!, status: "unknown" },
      }),
    ).rejects.toThrow("право");
    await s.controller.load("/local.wav", {
      ...one,
      sourceId: "local",
      local: true,
      rights: undefined,
    });
    expect(s.elements[0].paused).toBe(false);
    s.controller.stop();
  });
  it("pausing an incoming start cannot let a late play promise revive hidden sound", async () => {
    const s = setup();
    await s.controller.load("/one.wav", one);
    s.controller.prepare("/two.wav", two);
    let release!: () => void;
    s.elements[1].play.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            s.elements[1].paused = false;
            s.elements[1].dispatchEvent(new Event("playing"));
            resolve();
          };
        }),
    );
    s.elements[1].ready();
    s.elements[0].time(94);
    await vi.advanceTimersByTimeAsync(0);
    s.controller.pause();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.elements.every((audio) => audio.paused)).toBe(true);
    expect(
      s.events.transition.mock.calls.some(
        ([event]) => event.phase === "started",
      ),
    ).toBe(false);
    s.controller.stop();
  });
  it("pausing a pending regular load rejects a late native playing event", async () => {
    const s = setup();
    await s.controller.load("/one.wav", one, 0, false);
    let release!: () => void;
    s.elements[0].play.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            s.elements[0].paused = false;
            s.elements[0].dispatchEvent(new Event("playing"));
            resolve();
          };
        }),
    );
    const loading = s.controller.load("/two.wav", two);
    await vi.advanceTimersByTimeAsync(0);
    s.controller.pause();
    await loading;
    release();
    expect(s.elements[0].paused).toBe(true);
    s.controller.stop();
  });
  it("does not restart a routed song when pause arrives during pending resume unlock", async () => {
    const s = setup();
    await s.controller.load("/one.wav", one);
    s.controller.pause();
    s.context.state = "suspended";
    let release!: () => void;
    s.context.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            s.context.state = "running";
            resolve();
          };
        }),
    );
    const plays = s.elements[0].play.mock.calls.length;
    const resuming = s.controller.resume();
    s.controller.pause();
    release();
    await resuming;
    expect(s.elements[0].play).toHaveBeenCalledTimes(plays);
    expect(s.elements[0].paused).toBe(true);
    s.controller.stop();
  });
  it("does not let an old pending resume start a newly selected paused song", async () => {
    const s = setup();
    await s.controller.load("/one.wav", one);
    s.controller.pause();
    s.context.state = "suspended";
    let release!: () => void;
    s.context.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            s.context.state = "running";
            resolve();
          };
        }),
    );
    const plays = s.elements[0].play.mock.calls.length;
    const resuming = s.controller.resume();
    await s.controller.load("/two.wav", two, 0, false);
    release();
    await resuming;
    expect(s.elements[0].src).toBe("/two.wav");
    expect(s.elements[0].play).toHaveBeenCalledTimes(plays);
    expect(s.elements[0].paused).toBe(true);
    s.controller.stop();
  });
  it("keeps both paused overlap channels stopped after a stale unlock completes", async () => {
    const s = setup();
    await begin(s);
    await vi.advanceTimersByTimeAsync(1000);
    s.controller.pause();
    s.context.state = "suspended";
    let release!: () => void;
    s.context.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            s.context.state = "running";
            resolve();
          };
        }),
    );
    const plays = s.elements.map((audio) => audio.play.mock.calls.length);
    const resuming = s.controller.resume();
    s.controller.pause();
    release();
    await resuming;
    expect(s.elements.map((audio) => audio.play.mock.calls.length)).toEqual(
      plays,
    );
    expect(s.elements.every((audio) => audio.paused)).toBe(true);
    s.controller.stop();
  });
  it("retires a routed element before ordinary non-CORS playback instead of producing silence", async () => {
    const s = setup();
    await begin(s);
    await s.controller.load("https://audio.example/plain.mp3", {
      ...one,
      id: "plain",
      rights: { ...one.rights!, allowMix: false },
    });
    expect(s.elements).toHaveLength(3);
    expect(s.elements[0].src).toBe("");
    expect(s.elements[1].src).toBe("");
    expect(s.elements[2].src).toBe("https://audio.example/plain.mp3");
    expect(
      s.elements.filter((audio) => !audio.paused && audio.src),
    ).toHaveLength(1);
    expect(s.context.graphs[0].source.disconnect).toHaveBeenCalledOnce();
    s.controller.stop();
  });
  it("never preloads an explicitly unlicensed pending track", () => {
    const s = setup();
    s.controller.prepare("https://unknown.example/stream.mp3", {
      ...two,
      rights: { ...two.rights!, status: "unknown" },
    });
    expect(s.elements).toHaveLength(0);
    expect(s.events.mixStatus).toHaveBeenCalledWith(
      expect.stringContaining("право"),
    );
  });
});
