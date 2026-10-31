import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  Component,
} from "react";
import {
  Routes,
  Route,
  NavLink,
  useLocation,
  useNavigate,
  useParams,
  Navigate,
} from "react-router-dom";
import {
  Search as SearchIcon,
  AudioLines,
  Library as LibraryIcon,
  Settings as SettingsIcon,
  WifiOff,
  X,
  Music2,
} from "lucide-react";
import {
  AnimatePresence,
  motion,
  MotionConfig,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import { useMusicStore } from "../store/music";
import { useShallow } from "zustand/react/shallow";
import { initializeTelegram, telegram, isTelegram } from "../services/telegram";
import { legacyYouTubeEnabled, adapters } from "../adapters/music";
import { Brand, Spinner } from "../components/ui";
import Player from "../components/Player";
import SoundCloudDock from "../components/SoundCloudDock";
import Atmosphere from "../components/Atmosphere";
import Search from "../pages/Search";
import Library from "../pages/Library";
import Wave from "../pages/Wave";
import Settings from "../pages/Settings";
import "../styles/interactions.css";
const links = [
  ["/wave", "Моя волна", AudioLines],
  ["/search", "Поиск", SearchIcon],
  ["/library", "Моя музыка", LibraryIcon],
] as const;
class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="fatal">
        <Brand />
        <h1>Нужно перезагрузить приложение</h1>
        <p>Библиотека сохранена на устройстве.</p>
        <button className="button primary" onClick={() => location.reload()}>
          Перезагрузить
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function SharedTrack() {
  const { source, id } = useParams();
  const nav = useNavigate();
  const [message, setMessage] = useState("Ищем композицию…");
  useEffect(() => {
    const abort = new AbortController();
    const adapter = adapters.find((a) => a.id === source);
    if (!adapter || !id) {
      setMessage("Источник недоступен.");
      return;
    }
    void adapter
      .getTrackDetails(id, abort.signal)
      .then((t) => {
        if (!t) {
          setMessage(
            "Трек не найден или доступен только на другом устройстве.",
          );
          return;
        }
        if (!abort.signal.aborted) {
          void useMusicStore.getState().play(t);
          nav("/wave", { replace: true });
        }
      })
      .catch(() =>
        setMessage("Не удалось открыть трек. Проверьте подключение."),
      );
    return () => abort.abort();
  }, [source, id, nav]);
  return (
    <div className="page empty">
      <Music2 size={32} />
      <p>{message}</p>
      <button className="button subtle" onClick={() => nav("/search")}>
        Перейти к поиску
      </button>
    </div>
  );
}

function RouteStage({
  children,
  reduced,
}: {
  children: ReactNode;
  reduced: boolean;
}) {
  const present = useIsPresent();
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);
  return (
    <motion.div
      className="route-stage"
      inert={!present || undefined}
      aria-hidden={!present || undefined}
      initial={{ opacity: reduced ? 1 : 0, y: reduced ? 0 : 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: reduced ? 1 : 0, y: reduced ? 0 : -7 }}
      transition={{
        duration: reduced ? 0 : present ? 0.32 : 0.12,
        ease: [0.22, 1, 0.36, 1],
      }}
    >
      {children}
    </motion.div>
  );
}

function Shell() {
  const s = useMusicStore(
    useShallow((state) => ({
      initialize: state.initialize,
      settings: state.settings,
      current: state.current,
      ready: state.ready,
      error: state.error,
      importFiles: state.importFiles,
      dismissError: state.dismissError,
    })),
  );
  const initialize = s.initialize;
  const location = useLocation();
  const nav = useNavigate();
  const files = useRef<HTMLInputElement>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const onImport = useCallback(() => files.current?.click(), []);
  const systemReducedMotion = useReducedMotion();
  const reducedMotion =
    s.settings.reducedMotion || systemReducedMotion === true;
  useEffect(() => {
    void initialize();
    const cleanup = initializeTelegram();
    const on = () => setOnline(navigator.onLine);
    window.addEventListener("online", on);
    window.addEventListener("offline", on);
    return () => {
      cleanup();
      window.removeEventListener("online", on);
      window.removeEventListener("offline", on);
    };
  }, [initialize]);
  useEffect(() => {
    const app = telegram();
    if (!isTelegram() || !app) return;
    const back = () => nav("/wave", { replace: true });
    if (!["/", "/wave"].includes(location.pathname)) app.BackButton.show();
    else app.BackButton.hide();
    app.BackButton.onClick(back);
    return () => app.BackButton.offClick(back);
  }, [location.pathname, nav]);
  useEffect(() => {
    document.documentElement.classList.toggle(
      "reduced-motion",
      s.settings.reducedMotion,
    );
  }, [s.settings.reducedMotion]);
  return (
    <MotionConfig reducedMotion={s.settings.reducedMotion ? "always" : "user"}>
      <div
        className={`app-shell liquid-app ${s.current ? "has-player" : ""} ${legacyYouTubeEnabled && s.current?.playback?.kind === "youtube" ? "has-video" : ""}`}
      >
        <Atmosphere />
        <a
          className="skip-link"
          href="#main-content"
          onClick={(event) => {
            event.preventDefault();
            const main = document.getElementById("main-content");
            main?.focus();
            main?.scrollIntoView({ block: "start" });
          }}
        >
          К содержимому
        </a>
        <div className="main-column">
          <header className="topbar">
            <NavLink
              to="/wave"
              className="brand-link"
              aria-label="NoteSound — Моя волна"
            >
              <Brand />
            </NavLink>
            <span className="topbar-edition">Музыка. В твоём ритме.</span>
            <div className="topbar-actions">
              <button
                className="topbar-search"
                aria-label="Поиск музыки"
                onClick={() => nav("/search")}
              >
                <SearchIcon size={17} />
                <span>Найти музыку</span>
              </button>
              <button
                className="profile-button"
                aria-label="Открыть настройки"
                onClick={() => nav("/settings")}
              >
                <SettingsIcon size={19} />
              </button>
            </div>
          </header>
          {!online && (
            <div className="offline-banner">
              <WifiOff size={16} />
              Вы офлайн. Сохранённые и импортированные файлы доступны в «Моей
              музыке».
            </div>
          )}
          <main id="main-content" tabIndex={-1}>
            {!s.ready ? (
              <div className="app-loading">
                <Brand />
                <Spinner />
                <span>Настраиваем твою частоту…</span>
              </div>
            ) : (
              <AnimatePresence mode="wait" initial={false}>
                <RouteStage key={location.pathname} reduced={reducedMotion}>
                  <Routes location={location}>
                    <Route path="/" element={<Navigate to="/wave" replace />} />
                    <Route path="/search" element={<Search />} />
                    <Route path="/wave" element={<Wave />} />
                    <Route
                      path="/library"
                      element={<Library onImport={onImport} />}
                    />
                    <Route path="/settings" element={<Settings />} />
                    <Route
                      path="/track/:source/:id"
                      element={<SharedTrack />}
                    />
                    <Route path="*" element={<Navigate to="/wave" replace />} />
                  </Routes>
                </RouteStage>
              </AnimatePresence>
            )}
          </main>
        </div>
        <Player />
        <SoundCloudDock />
        <nav className="bottom-nav glass" aria-label="Главная навигация">
          {links.map(([path, label, Icon]) => (
            <NavLink
              end
              to={path}
              key={path}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <motion.i
                      className="nav-glass-selection"
                      layoutId={
                        reducedMotion ? undefined : "notesound-nav-selection"
                      }
                      transition={
                        reducedMotion
                          ? { duration: 0 }
                          : { type: "spring", stiffness: 420, damping: 34 }
                      }
                      aria-hidden="true"
                    />
                  )}
                  <Icon size={21} />
                  <span>{label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <input
          ref={files}
          hidden
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac"
          multiple
          onChange={(e) => {
            if (e.target.files) void s.importFiles(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
        {s.error && s.current?.playback?.kind !== "youtube" && (
          <div className="toast glass" role="status">
            <span>{s.error}</span>
            <button
              className="icon-button"
              aria-label="Закрыть сообщение"
              onClick={s.dismissError}
            >
              <X size={18} />
            </button>
          </div>
        )}
      </div>
    </MotionConfig>
  );
}
export default function App() {
  return (
    <ErrorBoundary>
      <Shell />
    </ErrorBoundary>
  );
}
