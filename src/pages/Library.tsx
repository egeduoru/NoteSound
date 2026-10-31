import { useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Heart,
  Plus,
  Upload,
  FolderHeart,
  ArrowLeft,
  Trash2,
  Play,
  Download,
  Clock3,
  Music2,
} from "lucide-react";
import { useMusicStore } from "../store/music";
import TrackList from "../components/TrackList";
import { Modal, Empty } from "../components/ui";
const tabs = [
  ["favorites", "Избранное", Heart],
  ["playlists", "Плейлисты", FolderHeart],
  ["history", "История", Clock3],
  ["offline", "На устройстве", Download],
] as const;
export default function Library({ onImport }: { onImport: () => void }) {
  const s = useMusicStore();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") || "favorites";
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [playlist, setPlaylist] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const close = useCallback(() => {
    setCreating(false);
    setConfirmDelete(false);
  }, []);
  const active = s.playlists.find((p) => p.id === playlist);
  const tracks = active
    ? s.playlistTracks[active.id] || []
    : tab === "favorites"
      ? s.favorites
      : tab === "history"
        ? s.history
            .map((h) => h.track)
            .filter((t, i, a) => a.findIndex((v) => v.id === t.id) === i)
        : s.tracks.filter((t) => t.local || s.offlineIds.includes(t.id));
  return (
    <div className="page library-page">
      <div className="page-intro">
        <div>
          <span className="eyebrow">ТВОЯ КОЛЛЕКЦИЯ</span>
          <h1>Моя музыка</h1>
          <p className="page-subtitle">То, к чему хочется возвращаться.</p>
        </div>
        <button
          className="button subtle"
          onClick={onImport}
          aria-label="Добавить музыку с устройства"
        >
          <Upload size={17} />
          <span>Добавить</span>
        </button>
      </div>
      <div className="library-summary glass">
        <div className="library-heart">
          <Heart size={30} fill="currentColor" />
        </div>
        <div>
          <span className="eyebrow">СОХРАНЕНО С ЛЮБОВЬЮ</span>
          <h2>Любимое всегда рядом</h2>
          <p>
            {s.favorites.length} в избранном · {s.playlists.length} плейлистов
          </p>
        </div>
      </div>
      <div
        className="tabs library-filters"
        role="group"
        aria-label="Разделы коллекции"
      >
        {tabs.map(([id, label, Icon]) => (
          <button
            className={tab === id ? "selected" : ""}
            aria-pressed={tab === id}
            key={id}
            onClick={() => {
              setParams({ tab: id });
              setPlaylist(null);
            }}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>
      {active ? (
        <>
          <div className="section-heading">
            <button className="text-button" onClick={() => setPlaylist(null)}>
              <ArrowLeft size={17} />
              Все плейлисты
            </button>
            <button
              className="icon-button danger"
              aria-label="Удалить плейлист"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={18} />
            </button>
          </div>
          <div className="section-heading">
            <h2>{active.name}</h2>
            {tracks.length > 0 && (
              <button
                className="button primary"
                onClick={() => void s.play(tracks[0], tracks, "playlist")}
              >
                <Play size={16} fill="currentColor" />
                Слушать
              </button>
            )}
          </div>
          <TrackList
            tracks={tracks}
            empty="Добавляйте треки через меню с тремя точками рядом с композицией."
            onRemove={(t) => void s.removeFromPlaylist(active.id, t.id)}
            onPlay={(t) => void s.play(t, tracks, "playlist")}
          />
        </>
      ) : tab === "playlists" ? (
        <>
          <div className="section-heading">
            <h2>Твои подборки</h2>
            <button className="button subtle" onClick={() => setCreating(true)}>
              <Plus size={17} />
              Создать плейлист
            </button>
          </div>
          {s.playlists.length ? (
            <div className="playlist-grid">
              {s.playlists.map((p, i) => (
                <button
                  className={`playlist-card playlist-${i % 3}`}
                  key={p.id}
                  onClick={() => setPlaylist(p.id)}
                >
                  <span className="playlist-art">
                    <FolderHeart size={48} />
                  </span>
                  <strong>{p.name}</strong>
                  <small>Треков: {(s.playlistTracks[p.id] || []).length}</small>
                </button>
              ))}
            </div>
          ) : (
            <Empty
              icon={<FolderHeart size={35} />}
              action={
                <button
                  className="button primary"
                  onClick={() => setCreating(true)}
                >
                  <Plus size={17} />
                  Первый плейлист
                </button>
              }
            >
              Соберите музыку для особенных моментов.
            </Empty>
          )}
        </>
      ) : (
        <>
          <div className="section-heading">
            <h2>{tabs.find((t) => t[0] === tab)?.[1] || "Избранное"}</h2>
            {tracks.length > 0 && (
              <button
                className="text-button"
                onClick={() => void s.play(tracks[0], tracks, active ? "playlist" : tab === "favorites" ? "favorites" : tab === "history" ? "history" : "library")}
              >
                <Play size={16} />
                Слушать всё
              </button>
            )}
          </div>
          <TrackList
            tracks={tracks}
            onPlay={(t) => void s.play(t, tracks, tab === "favorites" ? "favorites" : tab === "history" ? "history" : "library")}
            empty={
              tab === "offline"
                ? "Импортируйте MP3 или сохраните разрешённый трек через его меню."
                : tab === "history"
                  ? "Здесь появится музыка, которую вы слушали."
                  : "Нажмите на сердечко рядом с любимым треком."
            }
          />
          {tab === "offline" && (
            <p className="source-note">
              <Music2 size={17} />
              Аудио в хранилище: {(s.storageBytes / 1024 / 1024).toFixed(1)} МБ.
              Браузер может очистить локальные данные.
            </p>
          )}
        </>
      )}
      {creating && (
        <Modal title="Новый плейлист" onClose={close}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) {
                void s.createPlaylist(name.trim());
                setName("");
                close();
              }
            }}
          >
            <label className="field-label" htmlFor="playlist-name">
              Название
            </label>
            <input
              id="playlist-name"
              className="text-input"
              autoFocus
              maxLength={80}
              placeholder="Например, Вечерний город"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              className="button primary full-width"
              disabled={!name.trim()}
            >
              Создать плейлист
            </button>
          </form>
        </Modal>
      )}
      {confirmDelete && active && (
        <Modal title="Удалить плейлист?" onClose={close}>
          <p className="muted">«{active.name}» будет удалён из библиотеки.</p>
          <button
            className="button danger-button full-width"
            onClick={() => {
              void s.deletePlaylist(active.id);
              setPlaylist(null);
              close();
            }}
          >
            Удалить
          </button>
        </Modal>
      )}
    </div>
  );
}
