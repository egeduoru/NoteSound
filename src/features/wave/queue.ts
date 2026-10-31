import type { Track } from "../../types/music";
import { areSameTrack, deduplicateTracks } from "../../lib/normalize";

export const WAVE_QUEUE_TARGET = 7;
export const WAVE_QUEUE_LOW_WATER = 3;
export interface WaveQueues {
  manual: Track[];
  automatic: Track[];
}
const same = (one: Track, two: Track) => areSameTrack(one, two);
export function mergeQueues(manual: Track[], automatic: Track[]): Track[] {
  const uniqueManual = deduplicateTracks(manual);
  return [
    ...uniqueManual,
    ...deduplicateTracks(automatic).filter(
      (track) => !uniqueManual.some((other) => same(track, other)),
    ),
  ];
}
export function enqueueManual(queues: WaveQueues, track: Track): WaveQueues {
  const manual = deduplicateTracks([...queues.manual, track]);
  return {
    manual,
    automatic: queues.automatic
      .filter((other) => !same(track, other))
      .slice(0, Math.max(0, WAVE_QUEUE_TARGET - manual.length)),
  };
}
export function appendAutomatic(
  queues: WaveQueues,
  candidates: Track[],
  current?: Track,
): WaveQueues {
  const hard = [...queues.manual, ...(current ? [current] : [])];
  return {
    manual: [...queues.manual],
    automatic: deduplicateTracks([...queues.automatic, ...candidates])
      .filter((track) => !hard.some((other) => same(track, other)))
      .slice(
        0,
        Math.max(
          0,
          WAVE_QUEUE_TARGET - deduplicateTracks(queues.manual).length,
        ),
      ),
  };
}
export function consumeNext(queues: WaveQueues): {
  track: Track | null;
  queues: WaveQueues;
  origin: "manual" | "automatic" | null;
} {
  const combined = mergeQueues(queues.manual, queues.automatic);
  const track = combined[0] ?? null;
  if (!track)
    return { track: null, queues: { manual: [], automatic: [] }, origin: null };
  const manual = queues.manual.some((other) => same(track, other));
  return {
    track,
    origin: manual ? "manual" : "automatic",
    queues: {
      manual: queues.manual.filter((other) => !same(track, other)),
      automatic: queues.automatic.filter((other) => !same(track, other)),
    },
  };
}
export function removeQueued(queues: WaveQueues, id: string): WaveQueues {
  return {
    manual: queues.manual.filter((track) => track.id !== id),
    automatic: queues.automatic.filter((track) => track.id !== id),
  };
}
export function needsRefill(queues: WaveQueues) {
  return (
    mergeQueues(queues.manual, queues.automatic).length < WAVE_QUEUE_LOW_WATER
  );
}
export const WaveQueueManager = {
  mergeQueues,
  enqueueManual,
  appendAutomatic,
  consumeNext,
  removeQueued,
  needsRefill,
};
