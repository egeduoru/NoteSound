import { useState, useCallback, useEffect, useRef } from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Heart,
  ChevronDown,
  ListMusic,
  Volume2,
  Shuffle,
  Repeat,
  Repeat1,
  Share2,
  AudioLines,
  X,
  Music2,
  Maximize2,
  Trash2,
  ThumbsDown,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { legacyYouTubeEnabled, canPlayTrack } from "../adapters/music";
import { useMusicStore } from "../store/music";
import { Cover, Equalizer, Spinner, formatTime, Modal, Empty } from "./ui";
import { shareTrack } from "./TrackList";
import YouTubeDock, { usePlayerPanel } from "./YouTubeDock";
export default function Player() {
  const s = useMusicStore();
  const nav = useNavigate();
  const [queue, setQueue] = useState(false);
  const close = useCallback(() => setQueue(false), []);
  const fullRef = useRef<HTMLDivElement>(null);
  const { expanded: full, expand, collapse } = usePlayerPanel();
  const videoKind = legacyYouTubeEnabled
    ? s.current?.playback?.kind
    : undefined;
  useEffect(() => {
    if (videoKind === "youtube") expand();
  }, [videoKind, expand]);
  useEffect(() => {
    if (!full || queue) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    fullRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") collapse();
      if (event.key !== "Tab") return;
      const elements = Array.from(
        fullRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled)",
        ) || [],
      );
      const first = elements[0],
        last = elements.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === fullRef.current)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", handleKey);
      previous?.focus();
    };
  }, [full, queue, collapse]);
  const t = s.current;
  if (!t) return null;
  const liked = s.favorites.some((v) => v.id === t.id);
  const progress = (
    <input
      className="progress-range"
      aria-label="Позиция воспроизведения"
      type="range"
      min="0"
      max={s.duration || t.duration || 1}
      step="0.1"
      value={Math.min(s.position, s.duration || t.duration || 1)}
      style={
        {
          "--progress": `${(s.position / (s.duration || t.duration || 1)) * 100}%`,
        } as React.CSSProperties
      }
      onChange={(e) => s.seek(Number(e.target.value))}
    />
  );
  const toggle = (
    <button
      className={`player-play ${s.loading ? "loading" : ""}`}
      aria-label={s.playing ? "Пауза" : "Воспроизвести"}
      onClick={() => {
        if (canPlayTrack(t)) void s.togglePlay();
        else if (t.externalUrl)
          window.open(t.externalUrl, "_blank", "noopener,noreferrer");
      }}
    >
      {s.loading ? (
        <Spinner />
      ) : s.playing ? (
        <Pause fill="currentColor" />
      ) : (
        <Play fill="currentColor" />
      )}
    </button>
  );
  return (
    <>
      <div
        className={`mini-player glass ${full ? "covered" : ""}`}
        aria-hidden={full}
        inert={full}
      >
        <div className="mini-progress">{progress}</div>
        <button
          className="mini-track"
          onClick={expand}
          aria-label="Открыть плеер"
        >
          <Cover src={t.artwork} title={t.title} />
          <span>
            <strong>{t.title}</strong>
            <small>{t.artist}</small>
          </span>
          {s.playing && <Equalizer />}
        </button>
        <button
          className={`icon-button mini-heart ${liked ? "liked" : ""}`}
          aria-label={liked ? "Убрать из избранного" : "В избранное"}
          onClick={() => void s.toggleFavorite(t)}
        >
          <Heart size={19} fill={liked ? "currentColor" : "none"} />
        </button>
        <div className="mini-controls">
          <button
            className="icon-button previous"
            aria-label="Предыдущий трек"
            onClick={() => void s.previous()}
          >
            <SkipBack size={19} fill="currentColor" />
          </button>
          {toggle}
          <button
            className="icon-button"
            aria-label="Следующий трек"
            onClick={() => void s.next()}
          >
            <SkipForward size={19} fill="currentColor" />
          </button>
        </div>
        <span className="mini-time">
          {formatTime(s.position)}{" "}
          <span>/ {formatTime(s.duration || t.duration)}</span>
        </span>
        <div className="mini-volume">
          <Volume2 size={17} />
          <input
            aria-label="Громкость"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={s.settings.volume}
            onChange={(e) => s.setVolume(Number(e.target.value))}
          />
        </div>
        <button
          className="icon-button queue-toggle"
          aria-label="Очередь воспроизведения"
          onClick={() => setQueue(true)}
        >
          <ListMusic size={21} />
        </button>
        <button
          className="icon-button expand-player"
          aria-label="Развернуть плеер"
          onClick={expand}
        >
          <Music2 size={20} />
        </button>
      </div>
      {(full || (legacyYouTubeEnabled && t.playback?.kind === "youtube")) && (
        <div
          className={`full-player player-sheet ${full ? "expanded" : "compact"}`}
          ref={fullRef}
          tabIndex={-1}
          role={full ? "dialog" : "region"}
          aria-modal={full || undefined}
          data-player-shell="true"
          aria-label="Музыкальный плеер"
          onKeyDown={(e) => {
            if (e.key === "Escape") collapse();
          }}
        >
          <div className="player-glow" />
          <div className="full-player-header">
            <button
              className="icon-button"
              aria-label={full ? "Свернуть плеер" : "Развернуть плеер"}
              onClick={full ? collapse : expand}
            >
              {full ? <ChevronDown /> : <Maximize2 size={18} />}
            </button>
            <span className={full ? "eyebrow" : "compact-track-heading"}>
              {full ? (s.wave ? "МОЯ ВОЛНА" : "СЕЙЧАС ЗВУЧИТ") : t.title}
            </span>
            <button
              className="icon-button full-only"
              aria-label="Поделиться треком"
              onClick={() => void shareTrack(t)}
            >
              <Share2 size={21} />
            </button>
            {!full && (
              <button
                className="icon-button"
                aria-label="Остановить и закрыть плеер"
                onClick={s.clearPlayback}
              >
                <X size={18} />
              </button>
            )}
          </div>
          <div className="full-player-content">
            {legacyYouTubeEnabled && t.playback?.kind === "youtube" ? (
              <YouTubeDock />
            ) : (
              <div className={`full-artwork ${s.playing ? "is-playing" : ""}`}>
                {s.mixTransition ? (
                  <div className="artwork-blend">
                    <Cover
                      src={s.mixTransition.from.artwork}
                      title={s.mixTransition.from.title}
                    />
                    <div
                      className="incoming-artwork"
                      style={{ opacity: s.mixTransition.progress }}
                    >
                      <Cover
                        src={s.mixTransition.to.artwork}
                        title={s.mixTransition.to.title}
                      />
                    </div>
                  </div>
                ) : (
                  <Cover src={t.artwork} title={t.title} />
                )}
              </div>
            )}
            <div className="full-track-title full-only">
              <div>
                <h1>{t.title}</h1>
                <p>{t.artist}</p>
                {t.streamAccess === "preview" && (
                  <small>Фрагмент · до 30 секунд</small>
                )}
              </div>
              <button
                className={`icon-button ${liked ? "liked" : ""}`}
                aria-label={liked ? "Убрать из избранного" : "В избранное"}
                onClick={() => void s.toggleFavorite(t)}
              >
                <Heart size={27} fill={liked ? "currentColor" : "none"} />
              </button>
            </div>
            <div className="full-progress full-only">
              {progress}
              <div>
                <span>{formatTime(s.position)}</span>
                <span>{formatTime(s.duration || t.duration)}</span>
              </div>
            </div>
            <div className="full-controls full-only">
              <button
                className={`icon-button ${s.shuffle ? "selected" : ""}`}
                aria-label="Перемешивание"
                aria-pressed={s.shuffle}
                disabled={s.wave}
                onClick={s.toggleShuffle}
              >
                <Shuffle size={22} />
              </button>
              <button
                className="icon-button"
                aria-label="Предыдущий трек"
                onClick={() => void s.previous()}
              >
                <SkipBack size={29} fill="currentColor" />
              </button>
              {toggle}
              <button
                className="icon-button"
                aria-label="Следующий трек"
                onClick={() => void s.next()}
              >
                <SkipForward size={29} fill="currentColor" />
              </button>
              <button
                className={`icon-button ${s.repeat !== "off" ? "selected" : ""}`}
                aria-label={`Повтор: ${s.repeat}`}
                disabled={s.wave}
                onClick={() =>
                  s.setRepeat(
                    s.repeat === "off"
                      ? "all"
                      : s.repeat === "all"
                        ? "one"
                        : "off",
                  )
                }
              >
                {s.repeat === "one" ? (
                  <Repeat1 size={22} />
                ) : (
                  <Repeat size={22} />
                )}
              </button>
            </div>
            <div className="full-bottom full-only">
              <button
                className={s.wave ? "selected" : ""}
                disabled={t.streamAccess === "preview"}
                onClick={() => {
                  if (s.wave) s.stopWave();
                  else void s.startWave(t);
                }}
              >
                <AudioLines size={22} />
                <span>Моя волна</span>
              </button>
              <span className="player-license">
                {legacyYouTubeEnabled && t.playback?.kind === "youtube"
                  ? "YouTube · официальный плеер"
                  : t.sourceId === "notesound"
                    ? "NoteSound Originals · CC0"
                    : t.local
                      ? "Ваш аудиофайл"
                      : t.streamAccess === "preview"
                        ? "Deezer · фрагмент 30 с"
                        : t.sourceName || "Внешний источник"}
              </span>
              <button onClick={() => setQueue(true)}>
                <ListMusic size={22} />
                <span>Очередь</span>
              </button>
            </div>
            <div className="player-mix-strip full-only">
              <button
                className={s.settings.waveMix.enabled ? "selected" : ""}
                aria-pressed={s.settings.waveMix.enabled}
                onClick={() =>
                  s.updateSettings({
                    waveMix: {
                      ...s.settings.waveMix,
                      enabled: !s.settings.waveMix.enabled,
                    },
                  })
                }
              >
                Wave Mix · {s.settings.waveMix.enabled ? "включён" : "выключен"}
              </button>
              <button
                aria-label={
                  s.dislikedIds.includes(t.id)
                    ? "Убрать дизлайк"
                    : "Не предлагать этот трек"
                }
                onClick={() => void s.dislike(t)}
              >
                <ThumbsDown size={18} />
              </button>
            </div>
            {s.mixMessage && (
              <p className="small muted center full-only" role="status">
                {s.mixMessage}
              </p>
            )}
            {s.waveMessage && (
              <p className="small muted center full-only" role="status">
                {s.waveMessage}
              </p>
            )}
          </div>
        </div>
      )}
      {queue && (
        <Modal title="Очередь воспроизведения" onClose={close} wide>
          <p className="eyebrow">СЕЙЧАС ЗВУЧИТ</p>
          <div className="queue-row current">
            <Cover src={t.artwork} title={t.title} />
            <div>
              <strong>{t.title}</strong>
              <small>{t.artist}</small>
            </div>
            {s.playing && <Equalizer />}
          </div>
          <div className="section-heading">
            <h3>Далее в Волне</h3>
            <span className="muted small">Треков: {s.queue.length}</span>
          </div>
          {s.queue.length ? (
            s.queue.map((v, i) => (
              <div className="queue-row" key={`${v.id}:${i}`}>
                <span className="muted small">{i + 1}</span>
                <Cover src={v.artwork} title={v.title} />
                <button
                  className="track-info"
                  onClick={() => {
                    void s.playQueued(v.id);
                    close();
                  }}
                >
                  <strong>{v.title}</strong>
                  <small>
                    {v.artist} ·{" "}
                    {s.manualQueue.some((track) => track.id === v.id)
                      ? "Добавлено тобой"
                      : (
                          {
                            similar: "Похоже на твой выбор",
                            personal: "По твоим предпочтениям",
                            discovery: "Новое открытие",
                            popular: "Популярное в каталоге",
                          } as Record<string, string>
                        )[v.metadata?.recommendationReason ?? ""] ||
                        "Умная Волна"}
                  </small>
                </button>
                <span className="small muted">{formatTime(v.duration)}</span>
                <button
                  className="icon-button"
                  aria-label={`Убрать ${v.title} из очереди`}
                  onClick={() => s.removeFromQueue(v.id)}
                >
                  <X size={17} />
                </button>
              </div>
            ))
          ) : (
            <Empty>Добавляйте треки через меню или запустите Волну.</Empty>
          )}
          <div className="settings-actions">
            <button
              className="button subtle"
              onClick={() => {
                close();
                collapse();
                nav("/wave");
              }}
            >
              <AudioLines size={17} />
              Перейти к Волне
            </button>
            {s.queue.length > 0 && (
              <button
                className="text-button muted"
                onClick={() => s.queue.forEach((v) => s.removeFromQueue(v.id))}
              >
                <Trash2 size={15} />
                Очистить очередь
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
