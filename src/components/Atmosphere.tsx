import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  useArtworkAppearance,
  syncArtworkContrast,
} from "../features/appearance/useArtworkAppearance";
import "../styles/atmosphere.css";

// Fixed positions keep the light field steady when music state updates.
const lights = Array.from({ length: 38 }, (_, index) => ({
  x: 3 + ((index * 37 + 5) % 94),
  y: 3 + ((index * 53 + 11) % 93),
  duration: 3.8 + (index % 7) * 0.55,
  delay: -((index * 1.37) % 8),
  size: [1.8, 2.4, 3.2, 2.2][index % 4],
}));

function Atmosphere() {
  const { color, playing } = useArtworkAppearance();
  const backdrop = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(document.hidden);
  useEffect(() => {
    const sync = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  useEffect(() => {
    if (!backdrop.current) return;
    return syncArtworkContrast(backdrop.current, color);
  }, [color]);

  return (
    <div
      ref={backdrop}
      className={`atmosphere${paused ? " is-paused" : ""}`}
      style={{ color }}
      data-cover-color={color}
      data-cover-state={playing ? "playing" : "idle"}
      aria-hidden="true"
    >
      <div className="atmosphere-cloud atmosphere-cloud--lilac" />
      <div className="atmosphere-cloud atmosphere-cloud--rose" />
      <div className="atmosphere-cloud atmosphere-cloud--pearl" />
      <div className="atmosphere-silk" />
      <div className="atmosphere-lights">
        {lights.map(({ x, y, duration, delay, size }, index) => (
          <i
            key={index}
            className={`atmosphere-light${index % 4 === 0 ? " atmosphere-light--star" : ""}`}
            style={
              {
                "--light-x": `${x}%`,
                "--light-y": `${y}%`,
                "--light-duration": `${duration}s`,
                "--light-delay": `${delay}s`,
                "--light-size": `${size}px`,
              } as CSSProperties
            }
          />
        ))}
      </div>
      <div className="atmosphere-finish" />
    </div>
  );
}

export default memo(Atmosphere);
