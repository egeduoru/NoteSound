import { useEffect, useState } from "react";
import { useMusicStore } from "../../store/music";
import { readArtworkColor } from "./artwork-color";
import { telegram } from "../../services/telegram";

/** White is the initial scene; later pauses and loading gaps keep the last cover. */
export function useArtworkAppearance() {
  const artwork = useMusicStore((state) => state.current?.artwork);
  const playing = useMusicStore((state) => state.playing);
  const [color, setColor] = useState("#ffffff");

  useEffect(() => {
    if (!playing || !artwork) return;
    const controller = new AbortController();
    // Retain the displayed color while the next cover is loading, so a track
    // change blends directly into its new color rather than flashing white.
    void readArtworkColor(artwork, controller.signal).then((next) => {
      if (!controller.signal.aborted && next) setColor(next);
    });
    return () => controller.abort();
  }, [artwork, playing]);

  return { color, playing };
}

function rgb(value: string): [number, number, number] {
  if (/^#[\da-f]{6}$/i.test(value))
    return [1, 3, 5].map((index) =>
      parseInt(value.slice(index, index + 2), 16),
    ) as [number, number, number];
  const values = value.match(/[\d.]+/g)?.map(Number);
  return values && values.length >= 3
    ? [values[0], values[1], values[2]]
    : [255, 255, 255];
}

function luminance(value: string) {
  const [r, g, b] = rgb(value).map((channel) => {
    const v = channel / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

/** The cover itself stays unchanged; only foreground controls get a readable
 * accent and switch contrast as the native CSS color transition progresses. */
export function syncArtworkContrast(element: HTMLElement, color: string) {
  const root = document.documentElement;
  root.style.setProperty("--cover-color", color);
  const [r, g, b] = rgb(color);
  const accent =
    luminance(color) > 0.18
      ? `rgb(${Math.round(r * 0.45)}, ${Math.round(g * 0.45)}, ${Math.round(b * 0.45)})`
      : color;
  root.style.setProperty(
    "--cover-accent",
    color === "#ffffff" ? "#8e5677" : accent,
  );
  const until = performance.now() + 1800;
  let frame = 0;
  let last = -Infinity;
  const sample = (now: number) => {
    if (now - last >= 45 || now >= until) {
      last = now;
      const actual = getComputedStyle(element).color;
      root.dataset.coverTone = luminance(actual) < 0.2 ? "dark" : "light";
    }
    if (now < until) frame = requestAnimationFrame(sample);
    else {
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", color);
      const app = telegram();
      if (app?.initData && app.isVersionAtLeast("6.1")) {
        try {
          app.setHeaderColor(color);
          app.setBackgroundColor(color);
        } catch {
          /* The web background remains available in older clients. */
        }
      }
    }
  };
  sample(performance.now());
  return () => cancelAnimationFrame(frame);
}
