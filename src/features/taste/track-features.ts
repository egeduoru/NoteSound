import type { Track, WavePreferences } from "../../types/music";
import { normalizeText } from "../../lib/normalize";

type Mood = Exclude<WavePreferences["mood"], "any">;
type Language = Exclude<WavePreferences["language"], "any">;
export interface TrackFeatures {
  genres: string[];
  moods: Mood[];
  language: Language | null;
  energy: number | null;
}

const families: Array<[string, RegExp]> = [
  ["rock", /\b(rock|rok|grunge|granzh|punk|pank|alternative)\b/],
  ["metal", /\b(metal|metall|hardcore|harkor|metalcore)\b/],
  ["hip hop", /\b(hip hop|hiphop|hip hop|rap|rep|trap|drill)\b/],
  [
    "electronic",
    /\b(electronic|electronica|elektronika|edm|house|haus|techno|tehno|trance|trans|dubstep|dnb|drum and bass|synthwave)\b/,
  ],
  ["pop", /\b(pop|k pop|kpop|dance pop)\b/],
  ["ambient", /\b(ambient|embient|drone|meditation|sleep)\b/],
  ["lo fi", /\b(lo fi|lofi|chillhop|chillout|downtempo)\b/],
  ["jazz", /\b(jazz|dzhaz|swing|sving)\b/],
  ["soul", /\b(soul|soul|r b|rnb|rhythm and blues)\b/],
  [
    "classical",
    /\b(classical|klassika|orchestral|orchestra|piano|fortepiano)\b/,
  ],
  ["folk", /\b(folk|folklore|country|kantri|acoustic)\b/],
  ["reggae", /\b(reggae|reggi|ska)\b/],
];
const moodTags: Record<Mood, RegExp> = {
  calm: /\b(calm|relax|relaxing|spokojn\w*|chill|sleep|meditation|ambient|embient|lo fi|lofi|downtempo)\b/,
  energetic:
    /\b(energetic|energy|bodr\w*|energich\w*|workout|hardstyle|hardcore|metal|edm|drum and bass|dnb)\b/,
  happy: /\b(happy|joy|joyful|vesel\w*|radost\w*|uplifting|positive)\b/,
  melancholic: /\b(sad|melanchol\w*|grust\w*|melanhol\w*|sorrow|depress\w*)\b/,
};

/** Content features come from supplied tags/metadata, never song titles, covers,
 * an artist's nationality, or a claim of acoustic/lyric analysis. */
export function trackFeatures(track: Track): TrackFeatures {
  const metadata = track.metadata ?? {};
  const tags = [
    ...track.genres,
    ...[metadata.genres, metadata.genre, metadata.tags].filter(Boolean),
  ]
    .flatMap((tag) => tag.split(/[,;|]/))
    .map(normalizeText)
    .filter(Boolean);
  const genres = new Set(
    tags.filter((tag) => !["music", "muzyka", "local"].includes(tag)),
  );
  const words = tags.join(" ");
  for (const [family, pattern] of families)
    if (pattern.test(words)) genres.add(family);
  const moodWords = [words, metadata.mood, metadata.moods]
    .filter(Boolean)
    .map(normalizeText)
    .join(" ");
  const moods = (Object.keys(moodTags) as Mood[]).filter((mood) =>
    moodTags[mood].test(moodWords),
  );
  const declared = normalizeText(
    metadata.language ?? metadata.lang ?? metadata.vocalLanguage ?? "",
  );
  const vocal = normalizeText(metadata.vocals ?? metadata.instrumental ?? "");
  const instrumental =
    /\b(instrumental|instrumentaln\w*|no vocals|bez vokala)\b/.test(
      [declared, vocal, words].join(" "),
    ) || metadata.instrumental === "true";
  const russian = /^(ru|rus|ru ru|russian|russk\w*)$/.test(declared);
  const unknown =
    !declared ||
    /^(unknown|und|undefined|mixed|mul|neizvestno)$/.test(declared);
  const rawEnergy =
    metadata.energy === undefined ? NaN : Number(metadata.energy);
  return {
    genres: [...genres].slice(0, 32),
    moods,
    language: instrumental
      ? "instrumental"
      : russian
        ? "russian"
        : unknown
          ? null
          : "foreign",
    energy:
      Number.isFinite(rawEnergy) && rawEnergy >= 0 && rawEnergy <= 1
        ? rawEnergy
        : moods.includes("energetic")
          ? 0.85
          : moods.includes("calm")
            ? 0.2
            : null,
  };
}

export function contentSimilarity(one: Track, two: Track) {
  const a = trackFeatures(one).genres,
    b = trackFeatures(two).genres;
  if (!a.length || !b.length) return 0;
  return (
    a.filter((genre) => b.includes(genre)).length /
    Math.sqrt(a.length * b.length)
  );
}

/** Unknown metadata stays eligible. A requested language never guesses from a
 * Cyrillic title; declared contradictions are filtered and known matches rank first. */
export function matchesWavePreferences(
  track: Track,
  preferences?: WavePreferences,
  features = trackFeatures(track),
) {
  if (!preferences) return true;
  return (
    (preferences.language === "any" ||
      !features.language ||
      features.language === preferences.language) &&
    (preferences.mood === "any" ||
      !features.moods.length ||
      features.moods.includes(preferences.mood))
  );
}

export function preferenceScore(
  track: Track,
  preferences?: WavePreferences,
  features = trackFeatures(track),
) {
  if (!preferences) return 0;
  let score = 0;
  if (
    preferences.language !== "any" &&
    features.language === preferences.language
  )
    score += 5;
  if (preferences.mood !== "any" && features.moods.length)
    score += features.moods.includes(preferences.mood) ? 9 : -7;
  return score;
}
