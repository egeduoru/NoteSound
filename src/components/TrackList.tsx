import { useState, useCallback } from "react";
import {
  Play,
  Pause,
  Heart,
  MoreHorizontal,
  ListPlus,
  Download,
  Share2,
  FolderPlus,
  Check,
  Music2,
  ExternalLink,
  ThumbsUp,
  ThumbsDown,
} from "lucide-react";
import { canPlayTrack } from "../adapters/music";
import type { Track } from "../types/music";
import { useMusicStore } from "../store/music";
import { Cover, Equalizer, formatTime, Modal, Empty } from "./ui";
import { haptic } from "../services/telegram";
export async function shareTrack(track: Track) {
  if (track.local) {
    useMusicStore.setState({
      error:
        "Локальным файлом можно поделиться через файловый менеджер устройства.",
    });
    return;
  }
  const url = new URL(location.href);
  url.hash = `/track/${encodeURIComponent(track.sourceId)}/${encodeURIComponent(track.id)}`;
  try {
    if (navigator.share)
      await navigator.share({
        title: `${track.artist} — ${track.title}`,
        url: url.href,
      });
    else {
      await navigator.clipboard.writeText(url.href);
      useMusicStore.setState({ error: "Ссылка на трек скопирована." });
    }
  } catch (e) {
    if (!(e instanceof DOMException && e.name === "AbortError"))
      useMusicStore.setState({
        error: "Не удалось поделиться. Скопируйте адрес из строки браузера.",
      });
  }
}
export default function TrackList({
  tracks,
  empty = "Здесь пока тихо. Добавьте свою первую композицию.",
  onRemove,
  onPlay,
}: {
  tracks: Track[];
  empty?: string;
  onRemove?: (track: Track) => void;
  onPlay?: (track: Track) => void;
}) {
  const s = useMusicStore();
  const [menu, setMenu] = useState<Track | null>(null);
  const close = useCallback(() => setMenu(null), []);
  if (!tracks.length) return <Empty icon={<Music2 />}>{empty}</Empty>;
  return (
    <>
      <div className="track-list">
        {tracks.map((track, i) => {
          const active =
            s.current?.id === track.id &&
            s.current?.sourceId === track.sourceId;
          const liked = s.favorites.some((t) => t.id === track.id);
          const playable = canPlayTrack(track);
          return (
            <div
              className={`track-row ${active ? "active" : ""}`}
              key={`${track.sourceId}:${track.id}`}
            >
              <button
                className="track-play"
                aria-label={`${!playable ? "Открыть страницу" : active && s.playing ? "Пауза" : "Слушать"}: ${track.title}`}
                onClick={() => {
                  haptic();
                  if (!playable) {
                    if (track.externalUrl)
                      window.open(
                        track.externalUrl,
                        "_blank",
                        "noopener,noreferrer",
                      );
                    return;
                  }
                  if (active) void s.togglePlay();
                  else if (onPlay) onPlay(track);
                  else void s.play(track, tracks);
                }}
              >
                <span className="track-index">
                  {active && s.playing ? (
                    <Equalizer />
                  ) : (
                    String(i + 1).padStart(2, "0")
                  )}
                </span>
                <Cover src={track.artwork} title={track.title} />
                <span className="play-hover">
                  {!playable ? (
                    <ExternalLink size={17} />
                  ) : active && s.playing ? (
                    <Pause size={17} />
                  ) : (
                    <Play size={17} fill="currentColor" />
                  )}
                </span>
              </button>
              <button
                className="track-info"
                onClick={() => {
                  if (!playable) {
                    if (track.externalUrl)
                      window.open(
                        track.externalUrl,
                        "_blank",
                        "noopener,noreferrer",
                      );
                    return;
                  }
                  if (active) void s.togglePlay();
                  else if (onPlay) onPlay(track);
                  else void s.play(track, tracks);
                }}
              >
                <strong>{track.title}</strong>
                <span>
                  {track.artist}
                  {track.local ? " · На устройстве" : ""}
                  <em className="track-source">
                    {!playable
                      ? `${track.sourceName || track.sourceId} · открыть у источника`
                      : track.local
                        ? "Личный файл"
                        : track.streamAccess === "preview"
                          ? `${track.sourceName} · фрагмент 30 с`
                          : track.sourceName || "NoteSound · аудио"}
                  </em>
                </span>
              </button>
              <span className="track-album">
                {track.album || track.genres[0] || "Сингл"}
              </span>
              <span className="track-duration">
                {formatTime(track.duration)}
              </span>
              <button
                className={`icon-button heart ${liked ? "liked" : ""}`}
                aria-label={liked ? "Убрать из избранного" : "В избранное"}
                onClick={() => {
                  haptic();
                  void s.toggleFavorite(track);
                }}
              >
                <Heart size={18} fill={liked ? "currentColor" : "none"} />
              </button>
              <button
                className="icon-button"
                aria-label={`Действия: ${track.title}`}
                onClick={() => setMenu(track)}
              >
                <MoreHorizontal size={21} />
              </button>
            </div>
          );
        })}
      </div>
      {menu && (
        <Modal title={menu.title} onClose={close}>
          <div className="track-menu">
            <p className="muted">
              {menu.artist} · {menu.license.name}
            </p>
            <button
              disabled={!canPlayTrack(menu)}
              onClick={() => {
                s.enqueue(menu);
                close();
              }}
            >
              <ListPlus />
              Добавить в очередь
            </button>
            <button
              disabled={!canPlayTrack(menu) || menu.streamAccess === "preview"}
              onClick={() => {
                void s.startWave(menu);
                close();
              }}
            >
              <Music2 />
              Волна по этому треку
            </button>
            {menu.license.download && !s.offlineIds.includes(menu.id) && (
              <button
                onClick={() => {
                  void s.downloadTrack(menu);
                  close();
                }}
              >
                <Download />
                Сохранить на устройстве
              </button>
            )}
            {s.offlineIds.includes(menu.id) && (
              <p>
                <Check size={16} />
                Доступен без интернета
              </p>
            )}
            <button
              onClick={() => {
                void shareTrack(menu);
                close();
              }}
            >
              <Share2 />
              Поделиться
            </button>
            <button
              onClick={() => {
                void s.toggleLike(menu);
                close();
              }}
            >
              <ThumbsUp />
              {s.likedIds.includes(menu.id) ? "Убрать лайк" : "Нравится"}
            </button>
            <button
              onClick={() => {
                void s.dislike(menu);
                close();
              }}
            >
              <ThumbsDown />
              {s.dislikedIds.includes(menu.id)
                ? "Убрать дизлайк"
                : "Не предлагать в Волне"}
            </button>
            <div className="menu-divider" />
            <p className="eyebrow">ДОБАВИТЬ В ПЛЕЙЛИСТ</p>
            {s.playlists.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  void s.addToPlaylist(p.id, menu);
                  close();
                }}
              >
                <FolderPlus />
                {p.name}
              </button>
            ))}
            {!s.playlists.length && (
              <p className="muted">Создайте плейлист в разделе «Моя музыка».</p>
            )}
            {onRemove && (
              <button
                className="danger"
                onClick={() => {
                  onRemove(menu);
                  close();
                }}
              >
                Убрать из списка
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
