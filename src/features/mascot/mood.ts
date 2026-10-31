import type { Track } from "../../types/music";
import { normalizeText } from "../../lib/normalize";

export type BunnyMood = "idle" | "rock" | "sad" | "rap";

export const BUNNY_MOOD_LABELS: Record<BunnyMood, string> = {
  idle: "Кролик в наушниках спокойно слушает музыку",
  rock: "Кролик-рокер кивает головой в такт музыке",
  sad: "Кролик в капюшоне слушает грустную музыку",
  rap: "Кролик в чёрных очках читает рэп в микрофон",
};

const phrases = (values: string[]) => values.map(normalizeText);
const rockGenres = phrases([
  "rock",
  "punk",
  "metal",
  "metalcore",
  "grunge",
  "рок",
  "метал",
  "металл",
  "панк",
  "гранж",
]);
const rapGenres = phrases([
  "rap",
  "hip hop",
  "hiphop",
  "trap",
  "drill",
  "рэп",
  "реп",
  "хип хоп",
  "трэп",
  "треп",
  "дрилл",
]);
const sadWords = phrases([
  "sad",
  "melancholic",
  "melancholy",
  "melancholia",
  "sorrowful",
  "heartbreak",
  "lonely",
  "грустный",
  "грустная",
  "грустное",
  "грустные",
  "грусть",
  "печаль",
  "печальный",
  "печальная",
  "меланхолия",
  "тоска",
  "одиноко",
]);
const sadTitleWords = phrases([
  "sad",
  "lonely",
  "broken heart",
  "crying",
  "грустный",
  "грустная",
  "грустное",
  "грустные",
  "грусть",
  "печаль",
  "слёзы",
  "без тебя",
  "мне больно",
  "я скучаю",
  "одиноко",
]);
const rockArtists = phrases([
  "Skillet",
  "Linkin Park",
  "Nirvana",
  "Rammstein",
  "Metallica",
  "AC/DC",
  "System of a Down",
  "Bring Me the Horizon",
  "Three Days Grace",
  "Slipknot",
  "Король и Шут",
  "КиШ",
  "Кино",
  "Би-2",
  "Агата Кристи",
  "Сплин",
  "Lumen",
  "Ария",
  "Порнофильмы",
  "Radio Tapok",
]);
const rapArtists = phrases([
  "MACAN",
  "Miyagi",
  "Andy Panda",
  "Баста",
  "Гуф",
  "Guf",
  "Каста",
  "Скриптонит",
  "Scriptonite",
  "Oxxxymiron",
  "Моргенштерн",
  "Morgenshtern",
  "Noize MC",
  "Хаски",
  "Husky",
  "madk1d",
  "madkid",
  "мадкид",
  "VILLIAN",
  "VILLAIN",
  "Фараон",
  "PHARAOH",
  "OG Buda",
  "Big Baby Tape",
  "Aarne",
  "OBLADAET",
  "ATL",
]);

function normalized(value: unknown): string {
  return typeof value === "string" ? normalizeText(value) : "";
}

function hasPhrase(value: string, options: string[]): boolean {
  const padded = ` ${value} `;
  return options.some((phrase) => padded.includes(` ${phrase} `));
}

function explicitMood(value: string): BunnyMood | null {
  if (hasPhrase(value, sadWords)) return "sad";
  if (hasPhrase(value, rockGenres)) return "rock";
  if (hasPhrase(value, rapGenres)) return "rap";
  return null;
}

/** A costume hint from supplied metadata, not acoustic or emotional analysis. */
export function getBunnyMood(track: Track | null | undefined): BunnyMood {
  if (!track) return "idle";
  const metadata = Object.fromEntries(
    Object.entries(track.metadata ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      normalized(value),
    ]),
  );
  const declaredMood = explicitMood(metadata.mood ?? "");
  if (declaredMood) return declaredMood;

  const genre = [
    ...(Array.isArray(track.genres) ? track.genres.map(normalized) : []),
    metadata.genre ?? "",
    metadata.genres ?? "",
    metadata.style ?? "",
  ].join(" ");
  const declaredGenre = explicitMood(genre);
  if (declaredGenre) return declaredGenre;

  const title = normalized(track.title);
  if (hasPhrase(title, sadTitleWords)) return "sad";

  const artist = normalized(track.artist);
  if (hasPhrase(artist, rockArtists)) return "rock";
  if (hasPhrase(artist, rapArtists)) return "rap";
  // Some public catalogues put the artist in the title and lose its own field.
  if (hasPhrase(title, rockArtists)) return "rock";
  if (hasPhrase(title, rapArtists)) return "rap";
  return "idle";
}
