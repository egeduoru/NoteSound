import { describe, expect, it } from "vitest";
import type { TasteSignal, Track } from "../../types/music";
import { latestExplicitFeedback } from "./feedback";
const one: Track = {
  id: "one",
  sourceId: "local",
  artist: "Кино, Другой",
  title: "Группа крови",
  duration: 180,
  genres: [],
  license: { name: "Personal", download: false },
};
const reaction = (
  kind: TasteSignal["kind"],
  track = one,
  at = 100,
): TasteSignal => ({
  id: `${kind}:${track.id}:${at}`,
  trackId: track.id,
  track,
  kind,
  at,
});
describe("recording feedback identity", () => {
  const alias = {
    ...one,
    id: "alias",
    sourceId: "licensed",
    artist: "Другой & КИНО",
    title: "Группа крови (Official Audio)",
  };
  it("recognizes the same recording with reordered collaboration credits", () => {
    expect(
      latestExplicitFeedback([reaction("dislike")], 200)(alias)?.kind,
    ).toBe("dislike");
    expect(
      latestExplicitFeedback(
        [reaction("dislike")],
        200,
      )({ ...alias, title: "Группа крови Live" }),
    ).toBeUndefined();
  });
  it("a newer positive reaction undoes that recording's earlier ban", () => {
    const feedback = latestExplicitFeedback(
      [reaction("like", alias, 110), reaction("dislike")],
      200,
    );
    expect(feedback(one)?.kind).toBe("like");
    expect(feedback(alias)?.kind).toBe("like");
  });
  it("uses newest-first order for actions in the same millisecond", () => {
    expect(
      latestExplicitFeedback(
        [reaction("like", alias), reaction("dislike")],
        200,
      )(one)?.kind,
    ).toBe("like");
  });
  it("a skip or future action cannot erase an explicit dislike", () => {
    expect(
      latestExplicitFeedback(
        [
          reaction("like", alias, 300),
          reaction("skip", one, 110),
          reaction("dislike"),
        ],
        200,
      )(alias)?.kind,
    ).toBe("dislike");
  });
});
