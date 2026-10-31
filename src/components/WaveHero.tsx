import { Play } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useMusicStore } from "../store/music";
import BunnyMascot from "./BunnyMascot";
import { Spinner } from "./ui";
import WaveTuning from "./WaveTuning";

export default function WaveHero({ large = false }: { large?: boolean }) {
  const s = useMusicStore(
    useShallow((state) => ({
      waveStarting: state.waveStarting,
      loading: state.loading,
      playing: state.playing,
      startNewWave: state.startNewWave,
    })),
  );
  const busy = s.waveStarting || s.loading;
  const label = busy ? "Подбираем музыку" : "Включить новую песню Моей волны";

  return (
    <section
      className={`wave-hero bunny-wave-hero ${large ? "wave-large" : ""}`}
      aria-label="Моя волна"
    >
      <div className="hero-content">
        <h1>МОЯ ВОЛНА</h1>
      </div>
      <div className="bunny-placement">
        <BunnyMascot playing={s.playing} resolving={busy} />
      </div>
      <div className="hero-actions">
        <button
          className="bunny-play-button button primary"
          aria-label={label}
          aria-busy={busy}
          disabled={busy}
          onClick={() => void s.startNewWave()}
        >
          {busy ? (
            <Spinner />
          ) : (
            <Play size={30} fill="currentColor" aria-hidden="true" />
          )}
        </button>
        <WaveTuning />
      </div>
    </section>
  );
}
