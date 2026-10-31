import { useEffect, useRef, useState } from "react";
import { Heart, Sparkles } from "lucide-react";
import { createBunnyVideoRenderer } from "../features/mascot/video";

interface BunnyVideoMascotProps {
  onError: () => void;
}

/** The uploaded animation is currently the shared preview for every song. */
export default function BunnyVideoMascot({ onError }: BunnyVideoMascotProps) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [petting, setPetting] = useState(false);
  const [petCount, setPetCount] = useState(0);
  const petTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const source = video.current;
    const target = canvas.current;
    if (!source || !target) return;
    let disposed = false;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const reduced = () => preference.matches ||
      document.documentElement.classList.contains("reduced-motion");
    const renderer = createBunnyVideoRenderer(target, source, {
      reducedMotion: reduced(),
      onReady: () => { if (!disposed) setReady(true); },
      onError: () => { if (!disposed) onError(); },
    });
    if (!renderer) return;

    // Keep the mascot silent even if a future source file includes a soundtrack.
    source.muted = true;
    source.defaultMuted = true;
    source.volume = 0;
    const syncPlayback = () => {
      renderer.update({ reducedMotion: reduced() });
      if (document.hidden || reduced()) source.pause();
      else void source.play().catch(() => {
        // A browser may require a tap before starting inline video.
        // Its first decoded frame remains available until that interaction.
      });
    };
    const handleError = () => { if (!disposed) onError(); };
    const observer = new MutationObserver(syncPlayback);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    preference.addEventListener("change", syncPlayback);
    document.addEventListener("visibilitychange", syncPlayback);
    source.addEventListener("error", handleError);
    source.addEventListener("loadeddata", syncPlayback);
    syncPlayback();
    return () => {
      disposed = true;
      clearTimeout(petTimer.current);
      observer.disconnect();
      preference.removeEventListener("change", syncPlayback);
      document.removeEventListener("visibilitychange", syncPlayback);
      source.removeEventListener("error", handleError);
      source.removeEventListener("loadeddata", syncPlayback);
      renderer.dispose();
      source.pause();
    };
  }, [onError]);

  return (
    <button
      type="button"
      className={`bunny-mascot bunny-video-mascot${ready ? " is-video-ready" : ""}${petting ? " is-petted" : ""}`}
      data-renderer={ready ? "video-webgl" : "video-loading"}
      aria-label="Розовый кролик в наушниках. Погладить кролика"
      onClick={() => {
        clearTimeout(petTimer.current);
        setPetCount((count) => count + 1);
        setPetting(true);
        petTimer.current = setTimeout(() => setPetting(false), 850);
        if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches &&
          !document.documentElement.classList.contains("reduced-motion")) {
          void video.current?.play().catch(() => {});
        }
      }}
    >
      <span className="bunny-floor" aria-hidden="true" />
      <img
        className="bunny-video-placeholder"
        src={`${import.meta.env.BASE_URL}mascot/bunny-idle.png`}
        alt="" draggable={false} aria-hidden="true"
      />
      <video
        ref={video}
        className="bunny-video-source"
        src={`${import.meta.env.BASE_URL}mascot/bunny-idle.mp4`}
        muted loop playsInline autoPlay preload="auto"
        disablePictureInPicture disableRemotePlayback
        aria-hidden="true" tabIndex={-1}
      />
      <canvas ref={canvas} className="bunny-video-canvas" aria-hidden="true" />
      {petting && (
        <span className="bunny-pet-glints" key={petCount} aria-hidden="true">
          <Heart className="bunny-pet-heart" fill="currentColor" />
          <Sparkles className="bunny-pet-sparkle" />
        </span>
      )}
    </button>
  );
}
