import { describe, it, expect } from "vitest";
import { normalizeSettings } from "./settings";
describe("version-two settings", () => {
  it("restores additive defaults without losing old preferences", () => {
    const settings = normalizeSettings({
      dataSaver: true,
      volume: 0.4,
      diversity: 0.8,
    });
    expect(settings.dataSaver).toBe(true);
    expect(settings.volume).toBe(0.4);
    expect(settings.discoveryIntensity).toBe(0.8);
    expect(settings.waveMix).toEqual({
      enabled: false,
      durationSeconds: 6,
      smartCue: true,
      earlyTransition: true,
    });
  });
  it("clamps untrusted settings and deep fills mix/weight defaults", () => {
    const settings = normalizeSettings({
      volume: 20,
      discoveryIntensity: -1,
      waveMix: { enabled: true, durationSeconds: 100 },
      signalWeights: { dislike: -100 },
    });
    expect(settings.volume).toBe(1);
    expect(settings.discoveryIntensity).toBe(0);
    expect(settings.waveMix.durationSeconds).toBe(12);
    expect(settings.waveMix.smartCue).toBe(true);
    expect(settings.signalWeights.dislike).toBe(-20);
    expect(settings.signalWeights.like).toBe(5);
  });
  it("migrates old settings and validates independently saved wave preferences", () => {
    expect(normalizeSettings({}).wavePreferences).toEqual({
      familiarity: "balanced",
      mood: "any",
      language: "any",
    });
    expect(
      normalizeSettings({
        wavePreferences: {
          familiarity: "discover",
          mood: "calm",
          language: "russian",
        },
      }).wavePreferences,
    ).toEqual({
      familiarity: "discover",
      mood: "calm",
      language: "russian",
    });
    expect(
      normalizeSettings({
        wavePreferences: {
          familiarity: "invalid",
          mood: null,
          language: "instrumental",
        },
      }).wavePreferences,
    ).toEqual({
      familiarity: "balanced",
      mood: "any",
      language: "instrumental",
    });
  });
});
