import type { Track } from "../src/types/music";
export function metadataKey(value: unknown): string;
export function safePublicUrl(
  value: unknown,
  allowedHosts: string[],
): string | null;
export function parseClock(value: unknown): number;
export function normalizeHitmozPayload(payload: unknown): Track[];
export function normalizeLicensedTracks(
  payload: unknown,
  allowedHosts: string[],
): Track[];
