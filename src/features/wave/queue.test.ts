import { describe, expect, it } from "vitest";
import type { Track } from "../../types/music";
import {
  appendAutomatic,
  consumeNext,
  enqueueManual,
  mergeQueues,
  needsRefill,
  removeQueued,
  WAVE_QUEUE_TARGET,
} from "./queue";
const t = (id: string): Track => ({
  id,
  sourceId: "local",
  local: true,
  title: `Song ${id}`,
  artist: `Artist ${id}`,
  duration: 60,
  genres: [],
  license: { name: "Personal", download: true },
});
describe("WaveQueueManager", () => {
  it("always consumes manual additions before automatic recommendations", () => {
    const one = t("manual"),
      two = t("automatic");
    const result = consumeNext({ manual: [one], automatic: [two] });
    expect(result.track).toBe(one);
    expect(result.origin).toBe("manual");
    expect(result.queues.automatic).toEqual([two]);
  });
  it("deduplicates cross-source recordings in both queue portions", () => {
    const one = t("one"),
      alias = { ...one, id: "alias", sourceId: "other" };
    expect(
      mergeQueues([one], [alias, t("two")]).map((item) => item.id),
    ).toEqual(["one", "two"]);
  });
  it("moves an automatic recording to manual without duplication", () => {
    const one = t("one");
    expect(enqueueManual({ manual: [], automatic: [one] }, one)).toEqual({
      manual: [one],
      automatic: [],
    });
  });
  it("fills to seven future tracks while keeping manual priority and excluding current", () => {
    const current = t("current"),
      manual = t("manual");
    const queues = appendAutomatic(
      { manual: [manual], automatic: [] },
      [current, ...Array.from({ length: 12 }, (_, i) => t(String(i)))],
      current,
    );
    expect(mergeQueues(queues.manual, queues.automatic)).toHaveLength(
      WAVE_QUEUE_TARGET,
    );
    expect(queues.automatic.some((item) => item.id === current.id)).toBe(false);
  });
  it("preserves a longer explicitly requested manual queue instead of dropping user choices", () => {
    const manual = Array.from({ length: 9 }, (_, i) => t(String(i)));
    const queues = appendAutomatic({ manual, automatic: [] }, [t("new")]);
    expect(queues.manual).toEqual(manual);
    expect(queues.automatic).toEqual([]);
  });
  it("refills only below three combined future tracks", () => {
    expect(needsRefill({ manual: [t("one")], automatic: [t("two")] })).toBe(
      true,
    );
    expect(
      needsRefill({ manual: [t("one")], automatic: [t("two"), t("three")] }),
    ).toBe(false);
  });
  it("removes the consumed recording from both portions", () => {
    const one = t("one");
    const result = consumeNext({
      manual: [one],
      automatic: [{ ...one, id: "alias" }, t("two")],
    });
    expect(
      mergeQueues(result.queues.manual, result.queues.automatic).map(
        (item) => item.id,
      ),
    ).toEqual(["two"]);
  });
  it("handles empty queues and explicit removal without mutation", () => {
    expect(consumeNext({ manual: [], automatic: [] }).track).toBeNull();
    const queues = { manual: [t("one")], automatic: [t("two")] };
    expect(removeQueued(queues, "one").manual).toEqual([]);
    expect(queues.manual).toHaveLength(1);
  });
});
