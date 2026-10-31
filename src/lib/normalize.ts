import type { Track } from "../types/music";

const cyrillic: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
  є: "e",
  і: "i",
  ї: "i",
  ґ: "g",
};

/** The same normalization powers search and cross-catalog duplicate detection. */
export function normalizeText(value: string): string {
  return value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[а-яёєіїґ]/g, (letter) => cyrillic[letter] ?? letter)
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function artistKeys(artist: string): string[] {
  return artist
    .split(
      /\s*(?:&|,|\b(?:feat(?:uring)?|ft|with|vs)\b\.?|×|\s+x\s+|\s+и\s+)\s*/iu,
    )
    .map(normalizeText)
    .filter(Boolean);
}

/** Remove publishing decorations; recording/version words deliberately remain. */
export function normalizedTitle(
  track: Pick<Track, "title" | "artist">,
): string {
  let title = track.title;
  const prefix = title.match(/^(.*?)\s+[-–—:]\s+(.*)$/u);
  if (
    prefix &&
    [normalizeText(track.artist), ...artistKeys(track.artist)].includes(
      normalizeText(prefix[1]),
    )
  ) {
    title = prefix[2];
  }
  return normalizeText(
    title
      .replace(
        /\b(?:official\s*(?:audio|music\s*video|video|visuali[sz]er)|lyrics?(?:\s*video)?|hd|hq|4k)\b/giu,
        " ",
      )
      .replace(
        /(?:официальн(?:ое|ый)\s*(?:аудио|видео|клип)|текст\s+песни)/giu,
        " ",
      ),
  );
}

export function trackKey(track: Track): string {
  return `${artistKeys(track.artist)[0] ?? normalizeText(track.artist)}::${normalizedTitle(track)}`;
}

export function areSameTrack(a: Track, b: Track): boolean {
  if (a.sourceId === b.sourceId && a.id === b.id) return true;
  if (a.mbid && b.mbid && a.mbid === b.mbid) return true;
  if (normalizedTitle(a) !== normalizedTitle(b)) return false;
  const artists = artistKeys(a.artist);
  return artistKeys(b.artist).some((key) => artists.includes(key));
}

export function deduplicateTracks(tracks: Track[]): Track[] {
  return tracks.filter(
    (track, index, all) =>
      !all.slice(0, index).some((earlier) => areSameTrack(earlier, track)),
  );
}
