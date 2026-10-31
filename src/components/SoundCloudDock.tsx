import { useEffect, useRef } from "react";
import { soundcloudController } from "../services/soundcloud/controller";
import { useMusicStore } from "../store/music";
/** The official embed must stay visible even when NoteSound's full player is closed. */
export default function SoundCloudDock() {
  const active = useMusicStore((s) => s.current?.sourceId === "soundcloud");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    soundcloudController.mount(host);
    return () => soundcloudController.unmount(host);
  }, []);
  return (
    <div ref={ref} className="soundcloud-official-widget glass" hidden={!active}
      role="region" aria-label="Официальный плеер SoundCloud">
      {active && <span className="soundcloud-credit">SoundCloud · оригинальный виджет и ссылка на автора доступны в нём</span>}
    </div>
  );
}
