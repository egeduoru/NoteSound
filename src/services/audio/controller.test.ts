import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioController } from "./controller";
import type { Track } from "../../types/music";

class FakeAudio extends EventTarget {
  currentTime = 0;
  duration = 48;
  volume = 1;
  playbackRate = 1;
  src = "";
  preload = "";
  muted = false;
  play = vi.fn(async () => {
    this.dispatchEvent(new Event("playing"));
  });
  pause = vi.fn(() => this.dispatchEvent(new Event("pause")));
  load = vi.fn();
  removeAttribute = vi.fn((key: string) => {
    if (key === "src") this.src = "";
  });
}
const track: Track = {
  id: "one",
  sourceId: "notesound",
  title: "One",
  artist: "NoteSound",
  duration: 48,
  genres: [],
  license: { name: "CC0", download: true },
};
function setup() {
  const elements: FakeAudio[] = [];
  const controller = new AudioController(() => {
    const value = new FakeAudio();
    elements.push(value);
    return value as unknown as HTMLAudioElement;
  });
  const events = {
    time: vi.fn(),
    playing: vi.fn(),
    waiting: vi.fn(),
    ended: vi.fn(),
    error: vi.fn(),
  };
  controller.bind(events);
  return { controller, elements, events };
}
afterEach(() => vi.unstubAllGlobals());
describe("audio controller", () => {
  it("reuses one playback element across tracks and pauses before replacement", async () => {
    const { controller, elements } = setup();
    await controller.load("/one.wav", track);
    await controller.load("/two.wav", { ...track, id: "two" });
    expect(elements).toHaveLength(1);
    expect(elements[0].src).toBe("/two.wav");
    expect(elements[0].pause).toHaveBeenCalledTimes(2);
    expect(elements[0].play).toHaveBeenCalledTimes(2);
  });
  it("restores position after metadata and clamps seeks to duration", async () => {
    const { controller, elements, events } = setup();
    await controller.load("/one.wav", track, 19, false);
    expect(elements[0].play).not.toHaveBeenCalled();
    elements[0].dispatchEvent(new Event("loadedmetadata"));
    expect(elements[0].currentTime).toBe(19);
    controller.seek(100);
    expect(elements[0].currentTime).toBe(48);
    controller.seek(-5);
    expect(elements[0].currentTime).toBe(0);
    expect(events.time).toHaveBeenLastCalledWith(0, 48);
  });
  it("forwards ended and load errors so the queue can advance", async () => {
    const { controller, elements, events } = setup();
    await controller.load("/one.wav", track);
    elements[0].dispatchEvent(new Event("ended"));
    expect(events.ended).toHaveBeenCalledOnce();
    elements[0].dispatchEvent(new Event("error"));
    expect(events.error).toHaveBeenCalledOnce();
    expect(events.waiting).toHaveBeenLastCalledWith(false);
  });
  it("preloads only metadata on an element that never plays", () => {
    const { controller, elements } = setup();
    controller.prepare("/next.wav");
    expect(elements[0].preload).toBe("metadata");
    expect(elements[0].muted).toBe(true);
    expect(elements[0].play).not.toHaveBeenCalled();
    controller.prepare(null);
    expect(elements[0].src).toBe("");
  });
  it("preserves rejected play so the UI can request a user gesture", async () => {
    const { controller, elements, events } = setup();
    await controller.load("/one.wav", track, 0, false);
    elements[0].play.mockRejectedValueOnce(
      new DOMException("Gesture", "NotAllowedError"),
    );
    await expect(controller.load("/two.wav", track)).rejects.toHaveProperty(
      "name",
      "NotAllowedError",
    );
    expect(events.playing).toHaveBeenLastCalledWith(false);
  });
  it("times out a stalled media load instead of waiting indefinitely", async () => {
    vi.useFakeTimers();
    try {
      const { controller, elements } = setup();
      await controller.load("/one.wav", track, 0, false);
      elements[0].play.mockImplementationOnce(
        () => new Promise<void>(() => undefined),
      );
      const loading = controller.load("/two.wav", track);
      const rejected = expect(loading).rejects.toThrow("слишком долго");
      await vi.advanceTimersByTimeAsync(20000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects a late native start after a stalled load has timed out", async () => {
    vi.useFakeTimers();
    try {
      const { controller, elements, events } = setup();
      await controller.load("/one.wav", track, 0, false);
      let release!: () => void;
      elements[0].play.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = () => {
              elements[0].dispatchEvent(new Event("playing"));
              resolve();
            };
          }),
      );
      const loading = controller.load("/two.wav", track);
      const rejected = expect(loading).rejects.toThrow("слишком долго");
      await vi.advanceTimersByTimeAsync(20000);
      await rejected;
      const pauses = elements[0].pause.mock.calls.length;
      events.playing.mockClear();
      release();
      await Promise.resolve();
      expect(elements[0].pause).toHaveBeenCalledTimes(pauses + 1);
      expect(events.playing).not.toHaveBeenCalledWith(true);
      controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
  it("settles an outstanding media load immediately when stopped", async () => {
    const { controller, elements } = setup();
    await controller.load("/one.wav", track, 0, false);
    elements[0].play.mockImplementationOnce(
      () => new Promise<void>(() => undefined),
    );
    const pending = controller.load("/two.wav", track);
    controller.stop();
    await expect(pending).resolves.toBeUndefined();
    expect(elements[0].src).toBe("");
  });
  it("requests playback audio mode only when native audio actually starts", async () => {
    const audioSession = { type: "auto" };
    vi.stubGlobal("navigator", { audioSession });
    const { controller, elements } = setup();
    controller.prepare("/next.wav");
    await controller.load("/one.wav", track, 0, false);
    expect(audioSession.type).toBe("auto");
    await controller.resume();
    expect(audioSession.type).toBe("playback");
    expect(elements[1].play).toHaveBeenCalledOnce();
    controller.stop();
    expect(audioSession.type).toBe("auto");
  });
  it("restores the earlier audio mode when playback stops or ends", async () => {
    const audioSession = { type: "ambient" };
    vi.stubGlobal("navigator", { audioSession });
    const { controller, elements } = setup();
    await controller.load("/one.wav", track);
    expect(audioSession.type).toBe("playback");
    elements[0].dispatchEvent(new Event("ended"));
    expect(audioSession.type).toBe("ambient");
    await controller.resume();
    expect(audioSession.type).toBe("playback");
    controller.stop();
    expect(audioSession.type).toBe("ambient");
  });
  it("does not overwrite an audio mode subsequently chosen by another owner", async () => {
    const audioSession = { type: "auto" };
    vi.stubGlobal("navigator", { audioSession });
    const { controller } = setup();
    await controller.load("/one.wav", track);
    audioSession.type = "ambient";
    controller.stop();
    expect(audioSession.type).toBe("ambient");
  });
  it("does not change audio mode when stopped without native playback", () => {
    const audioSession = { type: "ambient" };
    vi.stubGlobal("navigator", { audioSession });
    const { controller } = setup();
    controller.stop();
    expect(audioSession.type).toBe("ambient");
  });
  it.each(["unsupported", "throwing getter", "throwing setter"])(
    "plays normally with an %s Audio Session API",
    async (capability) => {
      const platform = {};
      if (capability === "throwing getter")
        Object.defineProperty(platform, "audioSession", {
          get: () => {
            throw new Error("Unavailable in this host");
          },
        });
      if (capability === "throwing setter")
        Object.defineProperty(platform, "audioSession", {
          value: Object.defineProperty({}, "type", {
            get: () => "auto",
            set: () => {
              throw new Error("Read only in this host");
            },
          }),
        });
      vi.stubGlobal("navigator", platform);
      const { controller, elements, events } = setup();
      await controller.load("/one.wav", track);
      expect(events.playing).toHaveBeenLastCalledWith(true);
      await controller.resume();
      expect(elements[0].play).toHaveBeenCalledTimes(2);
      expect(() => controller.stop()).not.toThrow();
    },
  );
  it("releases the audio hint when a play attempt is rejected", async () => {
    const audioSession = { type: "auto" };
    vi.stubGlobal("navigator", { audioSession });
    const { controller, elements } = setup();
    await controller.load("/one.wav", track, 0, false);
    elements[0].play.mockRejectedValueOnce(
      new DOMException("Gesture required", "NotAllowedError"),
    );
    await expect(controller.resume()).rejects.toHaveProperty(
      "name",
      "NotAllowedError",
    );
    expect(audioSession.type).toBe("auto");
  });
  it("does not release a new song's audio session when an old resume rejects late", async () => {
    const audioSession = { type: "auto" };
    vi.stubGlobal("navigator", { audioSession });
    const { controller, elements } = setup();
    await controller.load("/one.wav", track, 0, false);
    let rejectOld!: (error: Error) => void;
    elements[0].play.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectOld = reject;
        }),
    );
    const resuming = controller.resume();
    await controller.load("/two.wav", { ...track, id: "two" });
    rejectOld(new Error("Old request aborted"));
    await expect(resuming).resolves.toBeUndefined();
    expect(audioSession.type).toBe("playback");
    expect(elements[0].src).toBe("/two.wav");
    controller.stop();
  });
  it("clears stale system playback state on end and stop, including a late pause", async () => {
    const mediaSession = { playbackState: "none" };
    vi.stubGlobal("navigator", { mediaSession });
    const { controller, elements } = setup();
    await controller.load("/one.wav", track);
    expect(mediaSession.playbackState).toBe("playing");
    elements[0].dispatchEvent(new Event("ended"));
    expect(mediaSession.playbackState).toBe("none");
    await controller.resume();
    controller.stop();
    expect(mediaSession.playbackState).toBe("none");
    elements[0].dispatchEvent(new Event("pause"));
    expect(mediaSession.playbackState).toBe("none");
  });
  it("releases ended state before a queue callback starts the next native track", async () => {
    const audioSession = { type: "auto" };
    const mediaSession = { playbackState: "none" };
    vi.stubGlobal("navigator", { audioSession, mediaSession });
    const { controller, elements, events } = setup();
    await controller.load("/one.wav", track);
    let next: Promise<void> | undefined;
    events.ended.mockImplementation(() => {
      expect(mediaSession.playbackState).toBe("none");
      expect(audioSession.type).toBe("auto");
      next = controller.load("/two.wav", { ...track, id: "two" });
    });
    elements[0].dispatchEvent(new Event("ended"));
    await next;
    expect(elements[0].src).toBe("/two.wav");
    expect(mediaSession.playbackState).toBe("playing");
    expect(audioSession.type).toBe("playback");
    controller.stop();
  });
});
