import { memo, useEffect, useRef, useState } from "react";
import { Heart, Sparkles } from "lucide-react";
import { createBunnySticker } from "../features/mascot/sticker";
import "../styles/bunny-wave.css";

const sticker = `${import.meta.env.BASE_URL}mascot/pink-bunny-sticker.png`;

interface BunnyMascotProps {
  playing: boolean;
  resolving?: boolean;
}

function BunnyMascot({ playing, resolving = false }: BunnyMascotProps) {
  const [petting, setPetting] = useState(false);
  const [petCount, setPetCount] = useState(0);
  const [ready, setReady] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const animation = useRef<ReturnType<typeof createBunnySticker>>(null);
  const initialPlaying = useRef(playing);
  const petTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!canvas.current) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const reduced = () =>
      preference.matches ||
      document.documentElement.classList.contains("reduced-motion");
    const instance = createBunnySticker(canvas.current, {
      src: sticker,
      playing: initialPlaying.current,
      reducedMotion: reduced(),
      onReady: () => setReady(true),
      onError: () => setReady(false),
    });
    animation.current = instance;
    const syncMotion = () => instance?.update({ reducedMotion: reduced() });
    preference.addEventListener("change", syncMotion);
    const observer = new MutationObserver(syncMotion);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => {
      observer.disconnect();
      preference.removeEventListener("change", syncMotion);
      instance?.dispose();
      animation.current = null;
      clearTimeout(petTimer.current);
    };
  }, []);

  useEffect(() => {
    animation.current?.update({ playing, petting });
  }, [playing, petting]);

  return (
    <button
      type="button"
      className={`bunny-mascot bunny-sticker-mascot${ready ? " is-sticker-ready" : ""}${playing ? " is-playing" : ""}${resolving ? " is-resolving" : ""}${petting ? " is-petted" : ""}`}
      data-renderer={ready ? "sticker-webgl" : "sticker-image"}
      data-playing={playing}
      aria-label="Зайка в наушниках. Погладить зайку"
      onClick={() => {
        clearTimeout(petTimer.current);
        setPetCount((count) => count + 1);
        setPetting(true);
        petTimer.current = setTimeout(() => setPetting(false), 1100);
      }}
    >
      <span className="bunny-floor" aria-hidden="true" />
      <img
        className="bunny-sticker-fallback"
        src={sticker}
        alt=""
        draggable={false}
        decoding="async"
        aria-hidden="true"
      />
      <canvas
        ref={canvas}
        className="bunny-sticker-canvas"
        aria-hidden="true"
      />
      {petting && (
        <span className="bunny-pet-glints" key={petCount} aria-hidden="true">
          <Heart className="bunny-pet-heart" fill="currentColor" />
          <Sparkles className="bunny-pet-sparkle" />
        </span>
      )}
    </button>
  );
}

export default memo(BunnyMascot);
