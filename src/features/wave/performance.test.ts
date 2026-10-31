import { expect, it } from "vitest";
import type { HistoryEntry, TasteSignal, Track } from "../../types/music";
import { seededRandom } from "../taste/profile";
import { buildWaveCandidates, prepareWaveRanking } from "./recommendation";

/** Opt-in diagnostic, never a machine-dependent speed assertion in CI. */
it.skipIf(process.env.RUN_WAVE_BENCHMARK !== "1")(
  "measures a full listener profile and varied candidate pool",
  () => {
    const now = 100 * 86400_000;
    const track = (index: number): Track => ({
      id: `licensed:${index}`,
      sourceId: "licensed",
      artist: `Исполнитель ${index % 70}`,
      title: `Композиция ${index}`,
      duration: 180,
      genres: [
        index % 3 === 0
          ? "alternative rock"
          : index % 3 === 1
            ? "ambient"
            : "electronic",
      ],
      metadata: { language: index % 2 ? "ru" : "en" },
      rights: { status: "confirmed", basis: "license", allowMix: false },
      license: { name: "Licensed", download: false },
    });
    const known = Array.from({ length: 1000 }, (_, index) => track(index));
    const history: HistoryEntry[] = known.map((item, index) => ({
      track: item,
      playedAt: now - index * 180000,
      completed: true,
      playedSeconds: 150,
    }));
    const signals: TasteSignal[] = Array.from({ length: 5000 }, (_, index) => ({
      id: `event:${index}`,
      trackId: known[index % known.length].id,
      track: known[index % known.length],
      kind: index % 7 === 0 ? "like" : "listen",
      at: now - index * 100000,
      playedSeconds: 150,
    }));
    const candidates = Array.from({ length: 300 }, (_, index) =>
      track(index + 900),
    );
    const samples: number[] = [];
    let selected: Track[] = [];
    for (let i = 0; i < 3; i += 1) {
      const started = performance.now();
      selected = buildWaveCandidates(known[0], candidates, {
        history,
        signals,
        favorites: known.slice(0, 40),
        excluded: [],
        diversity: 0.25,
        rng: seededRandom(123),
        now,
      });
      samples.push(Math.round((performance.now() - started) * 100) / 100);
    }
    console.log(
      "WAVE_BENCHMARK",
      JSON.stringify({
        samplesMs: samples,
        ids: selected.map((item) => item.id),
      }),
    );
    const prepareStart = performance.now();
    const prepared = prepareWaveRanking({
      history,
      signals,
      favorites: known.slice(0, 40),
      excluded: [],
      diversity: 0.25,
      now,
    });
    const prepareMs = performance.now() - prepareStart;
    const checkpointStart = performance.now();
    const checkpoint = prepared.rank(known[0], candidates, {
      rng: seededRandom(123),
    });
    const checkpointMs = performance.now() - checkpointStart;
    console.log(
      "WAVE_CHECKPOINT",
      JSON.stringify({
        prepareMs: Math.round(prepareMs * 100) / 100,
        checkpointMs: Math.round(checkpointMs * 100) / 100,
      }),
    );
    expect(checkpoint.map((t) => t.id)).toEqual(selected.map((t) => t.id));
    expect(selected).toHaveLength(7);
  },
  120000,
);
