import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { ExternalLink, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useMusicStore } from "../store/music";
import { youtubeController } from "../services/youtube/controller";

export const usePlayerPanel = create<{
  expanded: boolean;
  expand: () => void;
  collapse: () => void;
}>((set) => ({
  expanded: false,
  expand: () => set({ expanded: true }),
  collapse: () => set({ expanded: false }),
}));

/** One persistent, visible media area inside the shared music player. */
export default function YouTubeDock() {
  const track = useMusicStore((state) => state.current);
  const error = useMusicStore((state) => state.error);
  const nav = useNavigate();
  const host = useRef<HTMLDivElement>(null);
  const [obscured, setObscured] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    const cleanup = youtubeController.mount(host.current);
    const hidden = () => {
      if (
        document.hidden &&
        useMusicStore.getState().current?.playback?.kind === "youtube"
      )
        useMusicStore.getState().pause();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      cleanup();
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  useEffect(() => {
    const update = () => {
      // The music screen owns this iframe; only another modal obscures it.
      const blocked = !!document.querySelector(
        '[role="dialog"]:not([data-player-shell="true"])',
      );
      setObscured(blocked);
      if (
        blocked &&
        useMusicStore.getState().current?.playback?.kind === "youtube"
      )
        useMusicStore.getState().pause();
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    update();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    youtubeController.setVisible(!obscured && !document.hidden);
  }, [obscured]);
  if (track?.playback?.kind !== "youtube") return null;
  return (
    <section
      className={`youtube-media ${obscured ? "obscured" : ""}`}
      aria-label="Встроенный плеер YouTube"
    >
      <div className="yt-host" ref={host} />
      {error && (
        <p className="yt-error" role="status">
          {error}
        </p>
      )}
      <div className="yt-footer">
        <a href={track.externalUrl} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={14} /> YouTube
        </a>
        <button
          onClick={() => {
            useMusicStore.getState().pause();
            usePlayerPanel.getState().collapse();
            nav(
              `/search?q=${encodeURIComponent(`${track.artist} ${track.title} official audio`)}`,
            );
          }}
        >
          <Search size={14} /> Другая запись
        </button>
      </div>
    </section>
  );
}
