import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  Search as SearchIcon,
  X,
  SearchX,
  ExternalLink,
  Clock3,
} from "lucide-react";
import { searchTracksWithStatus } from "../adapters/music";
import { discoveryEnabled } from "../adapters/music/discovery";
import { vkSearchUrl } from "../adapters/music/vk";
import { matchesSearch } from "../services/search/normalize";
import { deduplicateTracks } from "../lib/normalize";
import { useMusicStore } from "../store/music";
import { useSearchHistory } from "../features/search/history";
import TrackList from "../components/TrackList";
import { Empty, Spinner } from "../components/ui";
import { suggestedQueries } from "../features/search/suggestions";
export default function Search() {
  const [params, setParams] = useSearchParams(),
    navigate = useNavigate();
  const routeQuery = params.get("q") || "";
  const [value, setValue] = useState(routeQuery),
    [query, setQuery] = useState(routeQuery);
  const local = useMusicStore((state) => state.tracks);
  const musicSources = useMusicStore((state) => state.settings.sources);
  const history = useSearchHistory();
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(value.trim());
      setParams(value.trim() ? { q: value.trim() } : {}, { replace: true });
    }, 600);
    return () => clearTimeout(timer);
  }, [value, setParams]);
  useEffect(() => {
    setValue(routeQuery);
  }, [routeQuery]);
  const result = useInfiniteQuery({
    queryKey: ["music-search", query, musicSources],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) =>
      searchTracksWithStatus(query, signal, pageParam),
    getNextPageParam: (page) => page.nextPageToken,
    enabled: !!query,
    staleTime: 15 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const remember = history.remember;
  useEffect(() => {
    if (result.data && query) remember(query);
  }, [result.data, query, remember]);
  const tracks = deduplicateTracks([
    ...(query
      ? local.filter((track) =>
          matchesSearch(query, `${track.title} ${track.artist}`),
        )
      : []),
    ...(result.data?.pages.flatMap((page) => page.tracks) || []),
  ]);
  const warning = result.data?.pages.map((page) => page.warning).find(Boolean);
  return (
    <div className="page search-page">
      <div className="page-intro">
        <div>
          <span className="eyebrow">НАЙДИ СВОЁ</span>
          <h1>Поиск</h1>
          <p className="page-subtitle">Твоя следующая любимая песня.</p>
        </div>
      </div>
      <div className="search-field glass">
        <SearchIcon size={23} />
        <input
          autoFocus
          aria-label="Поиск музыки"
          maxLength={160}
          placeholder="Песня, исполнитель или настроение"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        {value && (
          <button
            className="icon-button"
            aria-label="Очистить поиск"
            onClick={() => setValue("")}
          >
            <X size={19} />
          </button>
        )}
        {result.isFetching && <Spinner />}
      </div>
      {!discoveryEnabled && !import.meta.env.VITE_MUSIC_API_URL && (
        <div className="notice">
          Пока можно послушать музыку NoteSound и свои записи.
          <button className="text-button" onClick={() => navigate("/library")}>
            Добавить свою музыку
          </button>
        </div>
      )}
      {!query && (
        <>
          <div className="section-heading">
            <h2>С чего начнём?</h2>
          </div>
          <div className="tag-list">
            {suggestedQueries.map((suggestion) => (
              <button key={suggestion} onClick={() => setValue(suggestion)}>
                {suggestion === "VILLIAN madk1d ДИНАСТИЯ"
                  ? "ДИНАСТИЯ · VILLIAN, madk1d"
                  : suggestion}
              </button>
            ))}
          </div>
          {history.queries.length > 0 && (
            <>
              <div className="section-heading">
                <h2>
                  <Clock3 size={18} />
                  Недавние запросы
                </h2>
                <button className="text-button" onClick={history.clear}>
                  Очистить
                </button>
              </div>
              <div className="tag-list">
                {history.queries.map((previous) => (
                  <button key={previous} onClick={() => setValue(previous)}>
                    {previous}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
      {query && (
        <>
          <div className="section-heading">
            <h2>Найденные песни</h2>
            <span className="status-label">{tracks.length}</span>
          </div>
          {warning && (
            <div className="notice" role="status">
              {warning}
              <button
                className="text-button"
                disabled={result.isFetching}
                onClick={() => void result.refetch()}
              >
                Повторить поиск
              </button>
            </div>
          )}
          {result.isError && (
            <div className="notice">
              Поиск не ответил.{" "}
              <button
                className="text-button"
                onClick={() => void result.refetch()}
              >
                Попробовать снова
              </button>
            </div>
          )}
          {result.isFetching && !tracks.length ? (
            <div className="skeleton-list" aria-label="Поиск композиций">
              {[1, 2, 3, 4].map((item) => (
                <div key={item} />
              ))}
            </div>
          ) : tracks.length ? (
            <TrackList tracks={tracks} />
          ) : (
            <Empty icon={<SearchX size={32} />}>
              {warning
                ? "Внешний каталог сейчас недоступен. Попробуйте позже или выберите музыку в своей библиотеке."
                : "Ничего не найдено. Попробуйте сократить запрос или уточнить исполнителя."}
            </Empty>
          )}
          {result.hasNextPage && (
            <button
              className="button subtle full-width"
              disabled={result.isFetchingNextPage}
              onClick={() => void result.fetchNextPage()}
            >
              {result.isFetchingNextPage ? <Spinner /> : "Показать ещё"}
            </button>
          )}
          {!tracks.length && !result.isFetching && (
            <section className="external-search glass">
              <h3>Поищем ещё?</h3>
              <p>Можно продолжить поиск на другой площадке.</p>
              <div className="settings-actions">
                <a
                  className="button subtle"
                  href={`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={16} />
                  Искать на YouTube
                </a>
                <a
                  className="button subtle"
                  href={vkSearchUrl(query)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={16} />
                  Открыть VK Музыку
                </a>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
