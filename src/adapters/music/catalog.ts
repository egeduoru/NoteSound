import type { MusicSourceAdapter, Track } from "../../types/music";
import { matchesSearch } from "../../services/search/normalize";

const base = import.meta.env.BASE_URL;
const pieces = [
  [
    "violet-hour",
    "Фиолетовый час",
    "NoteSound Sessions",
    ["electronic", "ambient", "chill"],
    48,
  ],
  [
    "night-drive",
    "Ночной маршрут",
    "NoteSound Sessions",
    ["electronic", "synthwave", "chill"],
    48,
  ],
  [
    "slow-orbit",
    "Slow Orbit",
    "NoteSound Studio",
    ["ambient", "downtempo", "chill"],
    48,
  ],
  [
    "glass-garden",
    "Стеклянный сад",
    "NoteSound Studio",
    ["ambient", "piano", "chill"],
    48,
  ],
  [
    "afterglow",
    "Afterglow",
    "NoteSound Sessions",
    ["electronic", "house", "chill"],
    48,
  ],
  [
    "moonwater",
    "Лунная вода",
    "NoteSound Studio",
    ["ambient", "downtempo", "piano"],
    48,
  ],
  [
    "parallel",
    "Параллели",
    "NoteSound Sessions",
    ["electronic", "synthwave", "house"],
    48,
  ],
  [
    "first-light",
    "First Light",
    "NoteSound Studio",
    ["ambient", "piano", "electronic"],
    48,
  ],
] as const;

/** Original synthesized compositions shipped in full; these are not claims about commercial artists. */
const tempos = [80, 100, 72, 84, 112, 76, 104, 88];
// Author-supplied arrangement markers from scripts/generate-originals.py: bar boundaries, not detected choruses.
const cueBars = [
  [2, 14],
  [4, 16],
  [2, 12],
  [4, 14],
  [8, 18],
  [4, 12],
  [6, 16],
  [4, 14],
];
export const catalog: Track[] = pieces.map(
  ([id, title, artist, genres, duration], index) => ({
    id: `notesound:${id}`,
    sourceId: "notesound",
    sourceName: "NoteSound Originals",
    availability: "available",
    playbackMode: "audio",
    cuePoints: {
      cueInSeconds: (cueBars[index][0] * 4 * 60) / tempos[index],
      cueOutSeconds: (cueBars[index][1] * 4 * 60) / tempos[index],
      cueConfidence: 0.9,
      cueSource: "manual",
    },
    rights: {
      status: "confirmed",
      basis: "cc0",
      allowMix: true,
      evidence: "public/audio/LICENSE.txt",
    },
    title,
    artist,
    album: "Original Sessions · тестовый каталог",
    duration,
    genres: [...genres],
    artwork: `${base}artwork/${id}.svg`,
    streamUrl: `${base}audio/${id}.wav`,
    audioSource: { url: `${base}audio/${id}.wav`, cors: true },
    license: {
      name: "CC0 · оригинальный тестовый трек",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
      download: true,
    },
  }),
);

export const catalogAdapter: MusicSourceAdapter = {
  id: "notesound",
  name: "NoteSound Originals",
  status: "available",
  async searchTracks(query) {
    return catalog.filter((track) =>
      matchesSearch(
        query,
        `${track.title} ${track.artist} ${track.genres.join(" ")} ${track.album}`,
      ),
    );
  },
  async getTrackDetails(id) {
    return catalog.find((track) => track.id === id) ?? null;
  },
  async resolveStream(track) {
    return catalog.find((item) => item.id === track.id)?.streamUrl ?? null;
  },
  async checkAvailability(track) {
    return catalog.some((item) => item.id === track.id);
  },
  async getTopTracks() {
    return catalog;
  },
  async getSimilarTracks(track) {
    return catalog
      .filter((candidate) => candidate.id !== track.id)
      .sort(
        (a, b) =>
          b.genres.filter((genre) => track.genres.includes(genre)).length -
          a.genres.filter((genre) => track.genres.includes(genre)).length,
      );
  },
  async supportsDownload(track) {
    return catalog.some((item) => item.id === track.id);
  },
};
