import type { MusicSourceAdapter } from "../../types/music";
/** External search only. VK ID is not an audio playback grant. */
export const vkSearchUrl = (query: string) =>
  `https://vk.com/audio?q=${encodeURIComponent(query.trim().slice(0, 300))}`;
export const vkAdapter: MusicSourceAdapter = {
  id: "vk",
  name: "VK Музыка · внешнее открытие",
  status: "restricted",
  playbackModes: ["external"],
  searchTracks: async () => [],
  getTrackDetails: async () => null,
  resolveStream: async () => null,
  checkAvailability: async () => false,
  supportsDownload: async () => false,
};
