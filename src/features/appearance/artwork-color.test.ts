import { describe, expect, it } from "vitest";
import {
  artworkProxyUrl,
  dominantArtworkColor,
  readArtworkColor,
} from "./artwork-color";

const image = (
  colors: ReadonlyArray<readonly [number, number, number, number]>,
) => new Uint8ClampedArray(colors.flat());
const solid = (
  color: readonly [number, number, number, number],
  count: number,
) => Array.from({ length: count }, () => color);

describe("dominant cover color", () => {
  it("preserves an exact solid RGB value instead of brightening or averaging it", () => {
    expect(
      dominantArtworkColor(image(solid([14, 47, 123, 255], 100)), 10, 10),
    ).toBe("#0e2f7b");
  });

  it("chooses a blue gradient over a small white title", () => {
    const colors = Array.from(
      { length: 90 },
      (_, i) => [8 + (i % 10), 52 + (i % 40), 145 + (i % 50), 255] as const,
    );
    const result = dominantArtworkColor(
      image([...colors, ...solid([255, 255, 255, 255], 10)]),
      10,
      10,
    );
    const sourceColors = colors.map(
      ([r, g, b]) =>
        `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`,
    );
    expect(sourceColors).toContain(result);
  });

  it("keeps predominantly black artwork black despite a vivid accent", () => {
    expect(
      dominantArtworkColor(
        image([...solid([0, 0, 0, 255], 65), ...solid([255, 20, 45, 255], 35)]),
        10,
        10,
      ),
    ).toBe("#000000");
  });

  it("keeps predominantly white artwork white", () => {
    expect(
      dominantArtworkColor(
        image([
          ...solid([255, 255, 255, 255], 60),
          ...solid([15, 25, 30, 255], 40),
        ]),
        10,
        10,
      ),
    ).toBe("#ffffff");
  });

  it("ignores transparent padding without allowing invisible RGB values to dominate", () => {
    expect(
      dominantArtworkColor(
        image([...solid([255, 0, 0, 0], 95), ...solid([16, 171, 91, 255], 5)]),
        10,
        10,
      ),
    ).toBe("#10ab5b");
    expect(
      dominantArtworkColor(image(solid([20, 30, 40, 0], 4)), 2, 2),
    ).toBeNull();
  });

  it("does not invent a gray shade between separate red and blue fields", () => {
    expect(
      dominantArtworkColor(
        image([
          ...solid([230, 20, 35, 255], 51),
          ...solid([20, 45, 230, 255], 49),
        ]),
        10,
        10,
      ),
    ).toBe("#e61423");
  });

  it("does not modify its source pixels", () => {
    const pixels = image([
      [14, 47, 123, 255],
      [14, 47, 123, 255],
      [255, 255, 255, 128],
      [0, 0, 0, 0],
    ]);
    const before = pixels.slice();
    dominantArtworkColor(pixels, 2, 2);
    expect(pixels).toEqual(before);
  });

  it("rejects empty, noninteger, unbounded and incomplete image buffers", () => {
    for (const [width, height] of [
      [0, 1],
      [1, 0],
      [-1, 2],
      [1.5, 2],
      [Infinity, 2],
      [NaN, 2],
      [100000, 100000],
      [2, 2],
    ]) {
      expect(
        dominantArtworkColor(new Uint8ClampedArray(4), width, height),
      ).toBeNull();
    }
  });
});

describe("artwork read boundary", () => {
  it("can be imported in a non-browser environment and fails gracefully without a DOM", async () => {
    expect(
      await readArtworkColor("https://cover.lightaudio.ru/cover.jpg"),
    ).toBeNull();
  });

  it("only constructs the backend fallback for approved public cover CDNs", () => {
    expect(artworkProxyUrl("https://cover.lightaudio.ru/album/cover.jpg")).toBe(
      "/api/discovery/artwork?url=https%3A%2F%2Fcover.lightaudio.ru%2Falbum%2Fcover.jpg",
    );
    for (const url of [
      "http://cover.lightaudio.ru/cover.jpg",
      "https://cover.lightaudio.ru.evil.test/cover.jpg",
      "https://127.0.0.1/cover.jpg",
      "https://user:secret@cover.lightaudio.ru/cover.jpg",
      "https://cover.lightaudio.ru:8443/cover.jpg",
      "blob:https://notesound.test/private-cover",
      "data:image/png;base64,eA==",
      "/private-upload.png",
    ])
      expect(artworkProxyUrl(url)).toBeNull();
  });
});
