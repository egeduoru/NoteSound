import { describe, expect, it, vi } from "vitest";
import { PlaybackController } from "./controller";
import type { AudioEvents } from "../audio/controller";
import type { Track } from "../../types/music";
import {
  youtubeAdapter,
  reportYouTubeAvailability,
} from "../../adapters/music/youtube";
function provider() {
  let events: AudioEvents;
  return {
    bind: (next: AudioEvents) => (events = next),
    events: () => events!,
    load: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    pause: vi.fn(),
    stop: vi.fn(),
    seek: vi.fn(),
    volume: vi.fn(),
    prepare: vi.fn(),
  };
}
const audioTrack: Track = {
  id: "local:one",
  sourceId: "local",
  title: "Own file",
  artist: "User",
  duration: 40,
  genres: [],
  license: { name: "User", download: true },
};
const videoTrack: Track = {
  ...audioTrack,
  id: "youtube:Abc123xyZ_9",
  sourceId: "youtube",
  playback: { kind: "youtube", videoId: "Abc123xyZ_9" },
  license: { name: "YouTube", download: false },
};
describe("mutually exclusive playback providers", () => {
  it("temporarily excludes an iframe-denied recording from recommendations", async () => {
    const audio = provider(),
      video = provider(),
      controller = new PlaybackController(audio, video, true);
    reportYouTubeAvailability("Abc123xyZ_9", true);
    video.load.mockRejectedValueOnce(new Error("Embed denied"));
    await expect(controller.load(null, videoTrack)).rejects.toThrow(
      "Embed denied",
    );
    expect(await youtubeAdapter.checkAvailability(videoTrack)).toBe(false);
    reportYouTubeAvailability("Abc123xyZ_9", true);
  });
  it("stops audio before using the official video controller and ignores stale events", async () => {
    const audio = provider(),
      video = provider(),
      controller = new PlaybackController(audio, video, true);
    const events = {
      time: vi.fn(),
      playing: vi.fn(),
      waiting: vi.fn(),
      ended: vi.fn(),
      error: vi.fn(),
    };
    controller.bind(events);
    await controller.load("/own.wav", audioTrack);
    await controller.load(null, videoTrack);
    expect(audio.stop).toHaveBeenCalledTimes(2);
    expect(video.load).toHaveBeenLastCalledWith(videoTrack, 0, true);
    events.playing.mockClear();
    audio.events().playing(true);
    expect(events.playing).not.toHaveBeenCalled();
    video.events().playing(true);
    expect(events.playing).toHaveBeenCalledWith(true);
  });
  it("routes transport controls to the active provider only", async () => {
    const audio = provider(),
      video = provider(),
      controller = new PlaybackController(audio, video, true);
    controller.bind({
      time: () => {},
      playing: () => {},
      waiting: () => {},
      ended: () => {},
      error: () => {},
    });
    await controller.load(null, videoTrack, 8, false);
    controller.seek(12);
    controller.pause();
    await controller.resume();
    expect(video.seek).toHaveBeenCalledWith(12);
    expect(audio.seek).not.toHaveBeenCalled();
    expect(video.pause).toHaveBeenCalled();
    expect(video.resume).toHaveBeenCalled();
    await controller.load("/own.wav", audioTrack);
    expect(video.stop).toHaveBeenCalledTimes(2);
  });
});

describe("audio-first default", () => {
  it("does not load a YouTube iframe unless rollback is explicitly enabled", async () => {
    const audio = provider(),
      video = provider();
    const controller = new PlaybackController(audio, video, false);
    await expect(controller.load(null, videoTrack)).rejects.toThrow("YouTube");
    expect(video.load).not.toHaveBeenCalled();
    expect(audio.stop).not.toHaveBeenCalled();
  });
});
