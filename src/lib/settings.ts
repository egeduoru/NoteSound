import {
  defaultSettings,
  defaultMusicSources,
  type Settings,
  type WaveMixSettings,
  type SignalWeights,
  type WavePreferences,
} from "../types/music";
const bounded = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
export function normalizeSettings(input: unknown): Settings {
  const value =
    input && typeof input === "object" ? (input as Partial<Settings>) : {};
  const mix =
    value.waveMix && typeof value.waveMix === "object"
      ? (value.waveMix as Partial<WaveMixSettings>)
      : {};
  const weights =
    value.signalWeights && typeof value.signalWeights === "object"
      ? value.signalWeights
      : ({} as Partial<SignalWeights>);
  const discovery = bounded(
    value.discoveryIntensity,
    bounded(value.diversity, defaultSettings.discoveryIntensity, 0, 1),
    0,
    1,
  );
  const wave =
    value.wavePreferences && typeof value.wavePreferences === "object"
      ? value.wavePreferences
      : ({} as Partial<WavePreferences>);
  const option = <T extends string>(
    value: unknown,
    choices: readonly T[],
    fallback: T,
  ): T => (choices.includes(value as T) ? (value as T) : fallback);
  const sources = value.sources && typeof value.sources === "object" ? value.sources : {};
  return {
    sources: Object.fromEntries(Object.entries(defaultMusicSources).map(([id, fallback]) => [
      id, (sources as Record<string, unknown>)[id] === undefined ? fallback : (sources as Record<string, unknown>)[id] === true,
    ])) as Settings["sources"],
    dataSaver: value.dataSaver === true,
    reducedMotion: value.reducedMotion === true,
    volume: bounded(value.volume, defaultSettings.volume, 0, 1),
    diversity: discovery,
    discoveryIntensity: discovery,
    smartWaveEnabled: value.smartWaveEnabled !== false,
    wavePreferences: {
      familiarity: option(
        wave.familiarity,
        ["balanced", "familiar", "discover"],
        "balanced",
      ),
      mood: option(
        wave.mood,
        ["any", "calm", "energetic", "happy", "melancholic"],
        "any",
      ),
      language: option(
        wave.language,
        ["any", "russian", "foreign", "instrumental"],
        "any",
      ),
    },
    waveMix: {
      enabled: mix.enabled === true,
      durationSeconds: bounded(mix.durationSeconds, 6, 2, 12),
      smartCue: mix.smartCue !== false,
      earlyTransition: mix.earlyTransition !== false,
    },
    signalWeights: Object.fromEntries(
      Object.entries(defaultSettings.signalWeights).map(([kind, weight]) => [
        kind,
        bounded(weights[kind as keyof SignalWeights], weight, -20, 20),
      ]),
    ) as SignalWeights,
  };
}
