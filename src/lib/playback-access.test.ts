import { describe, expect, it } from "vitest";
import { isProviderAudio } from "./playback-access";
import { supportsMix } from "../features/mix/engine";
import type { Track } from "../types/music";

const providerTrack: Track = {
  id: "public:la-debea3df7de5f97860db3c99",
  sourceId: "public",
  title: "ДИНАСТИЯ",
  artist: "VILLIAN, madk1d",
  duration: 150,
  genres: [],
  streamAccess: "provider_stream",
  playbackMode: "audio",
  availability: "available",
  rights: { status: "unknown", basis: "none", allowMix: false },
  license: { name: "LightAudio", download: false },
};
describe("provider playback access", () => {
  it("accepts a supplied full stream without inventing remix or download rights", () => {
    expect(isProviderAudio(providerTrack)).toBe(true);
    expect(providerTrack.rights?.status).toBe("unknown");
    expect(
      supportsMix(providerTrack, "https://storage6.lightaudio.ru/dm/test.mp3"),
    ).toBe(false);
  });
  it("keeps previews separate and rejects mismatched, denied and metadata records", () => {
    expect(
      isProviderAudio({
        ...providerTrack,
        sourceId: "deezer",
        id: "deezer:4174083162",
        streamAccess: "preview",
      }),
    ).toBe(true);
    expect(isProviderAudio({ ...providerTrack, streamAccess: "preview" })).toBe(
      false,
    );
    expect(
      isProviderAudio({ ...providerTrack, playbackMode: "metadata" }),
    ).toBe(false);
    expect(
      isProviderAudio({
        ...providerTrack,
        rights: { status: "denied", basis: "none", allowMix: false },
      }),
    ).toBe(false);
  });
});
