import {
  ArrowRight,
  Play,
  Upload,
  Headphones,
  Sparkles,
  Heart,
  Clock3,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useMusicStore } from "../store/music";
import { catalog } from "../adapters/music/catalog";
import WaveHero from "../components/WaveHero";
import TrackList from "../components/TrackList";
import { Cover } from "../components/ui";
import SearchEntry from "../components/SearchEntry";
import { useSearchHistory } from "../features/search/history";
import { suggestedQueries } from "../features/search/suggestions";
const moods = [
  {
    name: "Сосредоточиться",
    tag: "ambient",
    sub: "В потоке, без лишних слов",
    cls: "focus",
    icon: "◌",
  },
  {
    name: "Поймать ритм",
    tag: "electronic",
    sub: "Энергия для нового дня",
    cls: "energy",
    icon: "ϟ",
  },
  {
    name: "Замедлиться",
    tag: "chill",
    sub: "Время только для себя",
    cls: "chill",
    icon: "≈",
  },
  {
    name: "Помечтать",
    tag: "cinematic",
    sub: "Чуть ближе к звёздам",
    cls: "dream",
    icon: "✧",
  },
];
export default function Home({ onImport }: { onImport: () => void }) {
  const nav = useNavigate();
  const s = useMusicStore();
  const searchHistory = useSearchHistory();
  return (
    <div className="page home-page">
      <div className="page-intro">
        <div>
          <span className="eyebrow">МУЗЫКА БЛИЖЕ, ЧЕМ КАЖЕТСЯ</span>
          <h2>
            На твоей частоте<span className="purple">.</span>
          </h2>
        </div>
        <span className="outline-label">
          <Headphones size={14} /> Сделай погромче
        </span>
      </div>
      <SearchEntry />
      <div className="home-query-tags tag-list">
        {suggestedQueries.slice(0, 5).map((query) => (
          <button
            key={query}
            onClick={() => nav(`/search?q=${encodeURIComponent(query)}`)}
          >
            {query}
          </button>
        ))}
      </div>
      {searchHistory.queries.length > 0 && (
        <>
          <div className="section-heading">
            <h2>
              <Clock3 size={18} />
              Недавние поиски
            </h2>
            <button className="text-button" onClick={searchHistory.clear}>
              Очистить
            </button>
          </div>
          <div className="tag-list home-query-tags">
            {searchHistory.queries.slice(0, 6).map((query) => (
              <button
                key={query}
                onClick={() => nav(`/search?q=${encodeURIComponent(query)}`)}
              >
                {query}
              </button>
            ))}
          </div>
        </>
      )}
      <WaveHero />
      <div className="section-heading">
        <h2>Какое у тебя настроение?</h2>
        <span className="muted small">У каждого момента свой звук</span>
      </div>
      <div className="mood-grid">
        {moods.map((m) => (
          <button
            className={`mood-card ${m.cls}`}
            key={m.tag}
            onClick={() => nav(`/search?q=${m.tag}`)}
          >
            <span className="mood-art" aria-hidden="true">
              {m.icon}
            </span>
            <span>
              <strong>{m.name}</strong>
              <small>{m.sub}</small>
            </span>
            <ArrowRight size={17} />
          </button>
        ))}
      </div>
      <details className="demo-library">
        <summary>
          Оригинальные тестовые записи NoteSound · проверка плеера без API
        </summary>
        <div className="section-heading">
          <div>
            <span className="eyebrow">ОТКРОЙ СВОЁ ЗВУЧАНИЕ</span>
            <h2>
              Коллекция NoteSound <Sparkles size={18} />
            </h2>
          </div>
          <button className="text-button" onClick={() => nav("/search")}>
            Вся музыка <ArrowRight size={16} />
          </button>
        </div>
        <p className="section-description">
          Авторские инструменталы для знакомства с плеером. Полные версии,
          свободное прослушивание.
        </p>
        <div className="album-grid">
          {catalog.slice(0, 6).map((t) => (
            <button
              key={t.id}
              className="album-card"
              onClick={() => void s.play(t, catalog)}
            >
              <div className="album-art">
                <Cover src={t.artwork} title={t.title} />
                <span className="album-play">
                  <Play size={21} fill="currentColor" />
                </span>
              </div>
              <strong>{t.title}</strong>
              <span>{t.artist}</span>
              <small>{t.genres.join(" · ")}</small>
            </button>
          ))}
        </div>
      </details>
      {s.favorites.length > 0 && (
        <section>
          <div className="section-heading">
            <h2>
              Ближе к сердцу <Heart size={17} />
            </h2>
            <button className="text-button" onClick={() => nav("/library")}>
              Всё избранное <ArrowRight size={16} />
            </button>
          </div>
          <TrackList tracks={s.favorites.slice(0, 4)} />
          <div className="section-heading">
            <h2>Любимые исполнители</h2>
          </div>
          <div className="tag-list">
            {[...new Set(s.favorites.map((t) => t.artist))]
              .slice(0, 8)
              .map((artist) => (
                <button
                  key={artist}
                  onClick={() => nav(`/search?q=${encodeURIComponent(artist)}`)}
                >
                  {artist}
                </button>
              ))}
          </div>
        </section>
      )}
      <div className="home-bottom">
        <section className="recent-section">
          <div className="section-heading">
            <h2>
              {s.history.length
                ? "Снова на репите"
                : "Твоя музыка начинается здесь"}
            </h2>
            {s.history.length > 0 && (
              <button
                className="text-button"
                onClick={() => nav("/library?tab=history")}
              >
                <Clock3 size={15} /> История
              </button>
            )}
          </div>
          {s.history.length ? (
            <TrackList
              tracks={s.history
                .slice(0, 4)
                .map((h) => h.track)
                .filter((t, i, a) => a.findIndex((v) => v.id === t.id) === i)}
            />
          ) : (
            <div className="start-list">
              <button onClick={() => nav("/library")}>
                <span className="start-icon">
                  <Heart size={23} />
                </span>
                <span>
                  <strong>Оставляй то, что откликается</strong>
                  <small>Любимые треки всегда под рукой</small>
                </span>
                <ArrowRight size={18} />
              </button>
              <button onClick={onImport}>
                <span className="start-icon blue">
                  <Upload size={23} />
                </span>
                <span>
                  <strong>Принеси свою музыку</strong>
                  <small>Импортируй MP3 прямо с устройства</small>
                </span>
                <ArrowRight size={18} />
              </button>
            </div>
          )}
        </section>
        <section className="import-card glass">
          <span className="import-art">♫</span>
          <span className="eyebrow">ТВОЯ ЛИЧНАЯ КОЛЛЕКЦИЯ</span>
          <h3>
            Любимая музыка.
            <br />
            Всегда с тобой.
          </h3>
          <p>
            Добавляй свои треки и слушай
            <br />
            даже без интернета.
          </p>
          <button className="button subtle" onClick={onImport}>
            <Upload size={16} /> Добавить музыку
          </button>
        </section>
      </div>
      <footer className="page-footer">
        <span>
          NoteSound <span className="purple">✦</span> Чувствуй музыку.
        </span>
        <span>Без подписки. В твоём ритме.</span>
      </footer>
    </div>
  );
}
