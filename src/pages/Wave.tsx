import { useMusicStore } from "../store/music";
import WaveHero from "../components/WaveHero";

export default function Wave() {
  const message = useMusicStore((state) => state.waveMessage);

  return (
    <div className="page wave-page bunny-wave-page">
      <WaveHero large />
      {message && (
        <p className="bunny-wave-message" role="status" aria-live="polite">
          {message}
        </p>
      )}
    </div>
  );
}
