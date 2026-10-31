import { useCallback, useRef, useState } from "react";
import {
  Download,
  Upload,
  Trash2,
  ExternalLink,
  ShieldCheck,
  Database,
  Globe2,
  Info,
  RotateCcw,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMusicStore } from "../store/music";
import { adapters } from "../adapters/music";
import { discoveryEnabled } from "../adapters/music/discovery";
import { capabilities, openInBrowser } from "../services/telegram";
import { Modal } from "../components/ui";
export default function Settings() {
  const s = useMusicStore();
  const qc = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const [confirm, setConfirm] = useState<"history" | "wave" | "taste" | null>(
    null,
  );
  const close = useCallback(() => setConfirm(null), []);
  const caps = capabilities();
  async function exportData() {
    const json = await s.exportLibrary();
    const url = URL.createObjectURL(
      new Blob([json], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "notesound-library.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="page settings-page">
      <div className="page-intro">
        <div>
          <span className="eyebrow">НАСТРОЙ СВОЮ ЧАСТОТУ</span>
          <h1>
            Настройки<span className="purple">.</span>
          </h1>
        </div>
      </div>
      <section className="settings-block glass">
        <h2>Музыкальный каталог</h2>
        <p className="muted">
          Основной плеер работает с аудио и обложками. Встроенное прослушивание
          доступно для авторских записей, личных файлов и потоков подключённых
          музыкальных источников.
        </p>
        <p className="small muted">
          {discoveryEnabled
            ? "Подключены внешний аудиокаталог и поиск Deezer. Фрагменты Deezer отмечены отдельно."
            : import.meta.env.VITE_MUSIC_API_URL
              ? "Адрес внешнего каталога настроен. Его доступность и права на каждую запись проверяются отдельно."
              : "Сейчас доступен авторский аудиокаталог NoteSound. Внешний каталог пока не подключён."}
        </p>
      </section>
      <section className="settings-block glass">
        <h2>Музыкальные источники</h2>
        <p className="muted">Отключение источника не удаляет сохранённые записи. SoundCloud доступен только при разрешённом серверном подключении; для его музыки требуется видимый официальный виджет.</p>
        {([
          ["soundcloud", "SoundCloud", "Одобренное подключение и официальное встраивание"],
          ["public", "Публичный каталог", "Потоки сторонних источников, если они доступны"],
          ["deezer", "Deezer", "Только доступные фрагменты"],
          ["licensed", "Лицензированный каталог", "Подтверждённые аудиофайлы"],
        ] as const).map(([id, label, description]) => (
          <div className="setting-row" key={id}>
            <div><strong>{label}</strong><p>{description}</p></div>
            <button role="switch" aria-label={`Источник ${label}`}
              aria-checked={s.settings.sources[id]}
              className={`switch ${s.settings.sources[id] ? "on" : ""}`}
              onClick={() => {
                s.updateSettings({ sources: { ...s.settings.sources, [id]: !s.settings.sources[id] } });
                qc.invalidateQueries({ queryKey: ["music-search"] });
              }}><span /></button>
          </div>
        ))}
      </section>
      <section className="settings-block glass">
        <h2>Умная Волна</h2>
        <div className="setting-row">
          <div>
            <strong>Автоматический подбор</strong>
            <p>После выбора песни готовить следующие композиции</p>
          </div>
          <button
            role="switch"
            aria-label="Автоматическая Умная Волна"
            aria-checked={s.settings.smartWaveEnabled}
            className={`switch ${s.settings.smartWaveEnabled ? "on" : ""}`}
            onClick={() =>
              s.updateSettings({
                smartWaveEnabled: !s.settings.smartWaveEnabled,
              })
            }
          >
            <span />
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>
              Новые музыкальные открытия ·{" "}
              {Math.round(s.settings.discoveryIntensity * 100)}%
            </strong>
            <p>От любимых исполнителей к новым именам</p>
          </div>
          <input
            aria-label="Новые музыкальные открытия"
            className="setting-range"
            type="range"
            min="0"
            max="1"
            step=".01"
            value={s.settings.discoveryIntensity}
            onChange={(event) =>
              s.updateSettings({
                discoveryIntensity: Number(event.target.value),
              })
            }
          />
        </div>
        <button
          className="text-button muted"
          onClick={() => setConfirm("taste")}
        >
          <RotateCcw size={16} />
          Сбросить предпочтения
        </button>
      </section>
      <section className="settings-block glass">
        <h2>Wave Mix</h2>
        <p className="muted">
          Плавное сведение совместимых аудиозаписей. Подбор музыки работает
          независимо от этой настройки.
        </p>
        <div className="setting-row">
          <div>
            <strong>Плавные переходы</strong>
            <p>До двух аудиоканалов во время сведения</p>
          </div>
          <button
            role="switch"
            aria-label="Wave Mix"
            aria-checked={s.settings.waveMix.enabled}
            className={`switch ${s.settings.waveMix.enabled ? "on" : ""}`}
            onClick={() =>
              s.updateSettings({
                waveMix: {
                  ...s.settings.waveMix,
                  enabled: !s.settings.waveMix.enabled,
                },
              })
            }
          >
            <span />
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>
              Длительность · {s.settings.waveMix.durationSeconds} сек.
            </strong>
            <p>От 2 до 12 секунд</p>
          </div>
          <input
            aria-label="Длительность Wave Mix"
            className="setting-range"
            type="range"
            min="2"
            max="12"
            step="1"
            value={s.settings.waveMix.durationSeconds}
            onChange={(event) =>
              s.updateSettings({
                waveMix: {
                  ...s.settings.waveMix,
                  durationSeconds: Number(event.target.value),
                },
              })
            }
          />
        </div>
        {[
          [
            "smartCue",
            "Умные точки начала",
            "Использовать подтверждённые музыкальные метки",
          ],
          [
            "earlyTransition",
            "Раннее переключение",
            "Начинать переход по метке окончания, если она есть",
          ],
        ].map(([key, label, description]) => (
          <div className="setting-row" key={key}>
            <div>
              <strong>{label}</strong>
              <p>{description}</p>
            </div>
            <button
              role="switch"
              aria-label={label}
              aria-checked={
                s.settings.waveMix[key as "smartCue" | "earlyTransition"]
              }
              className={`switch ${s.settings.waveMix[key as "smartCue" | "earlyTransition"] ? "on" : ""}`}
              onClick={() =>
                s.updateSettings({
                  waveMix: {
                    ...s.settings.waveMix,
                    [key]:
                      !s.settings.waveMix[
                        key as "smartCue" | "earlyTransition"
                      ],
                  },
                })
              }
            >
              <span />
            </button>
          </div>
        ))}
        {s.mixMessage && (
          <p className="small muted" role="status">
            {s.mixMessage}
          </p>
        )}
      </section>
      <section className="settings-block glass">
        <h2>Прослушивание</h2>
        <div className="setting-row">
          <div>
            <strong>Экономия трафика</strong>
            <p>Отключает предварительную буферизацию аудио</p>
          </div>
          <button
            role="switch"
            aria-checked={s.settings.dataSaver}
            aria-label="Экономия трафика"
            className={`switch ${s.settings.dataSaver ? "on" : ""}`}
            onClick={() =>
              void s.updateSettings({ dataSaver: !s.settings.dataSaver })
            }
          >
            <span />
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>Меньше анимаций</strong>
            <p>Спокойный интерфейс и меньше нагрузки</p>
          </div>
          <button
            role="switch"
            aria-checked={s.settings.reducedMotion}
            aria-label="Меньше анимаций"
            className={`switch ${s.settings.reducedMotion ? "on" : ""}`}
            onClick={() =>
              void s.updateSettings({
                reducedMotion: !s.settings.reducedMotion,
              })
            }
          >
            <span />
          </button>
        </div>
      </section>
      <section className="settings-block glass">
        <h2>
          <Database size={21} />
          Библиотека и память
        </h2>
        <p className="muted">
          Аудио занимает {(s.storageBytes / 1024 / 1024).toFixed(1)} МБ.
          Избранное, плейлисты и история хранятся локально.
        </p>
        <div className="settings-actions">
          <button className="button subtle" onClick={() => void exportData()}>
            <Download size={17} />
            Экспорт JSON
          </button>
          <button
            className="button subtle"
            onClick={() => file.current?.click()}
          >
            <Upload size={17} />
            Импорт JSON
          </button>
          <button
            className="button subtle"
            onClick={() => {
              qc.clear();
              useMusicStore.setState({
                error: "Кэш поисковых запросов очищен.",
              });
            }}
          >
            <RotateCcw size={16} />
            Очистить кэш поиска
          </button>
        </div>
        <input
          hidden
          ref={file}
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f)
              void f
                .text()
                .then((json) => s.importLibrary(json))
                .catch(() =>
                  useMusicStore.setState({
                    error: "Не удалось прочитать библиотеку.",
                  }),
                );
            e.target.value = "";
          }}
        />
        <p className="small muted">
          JSON переносит только метаданные. Локальные аудиофайлы нужно
          импортировать отдельно.
        </p>
        {s.offlineIds.map((id) => {
          const t = s.tracks.find((v) => v.id === id);
          return (
            <div className="setting-row" key={id}>
              <span>{t?.title || id}</span>
              <button
                className="icon-button danger"
                aria-label={`Удалить файл ${t?.title || id}`}
                onClick={() => void s.removeOffline(id)}
              >
                <Trash2 size={18} />
              </button>
            </div>
          );
        })}
        <div className="settings-actions">
          <button
            className="text-button muted"
            onClick={() => setConfirm("history")}
          >
            <Trash2 size={15} />
            Очистить историю
          </button>
          <button
            className="text-button muted"
            onClick={() => setConfirm("wave")}
          >
            <RotateCcw size={15} />
            Сбросить историю Волны
          </button>
        </div>
      </section>
      <section className="settings-block glass">
        <h2>
          <Globe2 size={21} />
          Музыкальные источники
        </h2>
        {adapters.map((a) => (
          <div className="setting-row" key={a.id}>
            <div>
              <strong>{a.name}</strong>
              <p>
                {a.id === "notesound"
                  ? "Авторские тестовые инструменталы · CC0"
                  : a.id === "vk"
                    ? "Открывается на официальном сайте. Встроенный музыкальный API не подключён."
                    : a.id === "hitmoz"
                      ? "Подключаемый каталог. Метаданные и права на воспроизведение проверяются отдельно."
                      : a.id === "licensed"
                        ? "Аудиокаталог с подтверждёнными правами"
                        : "Дополнительный внешний источник"}
              </p>
            </div>
            <span
              className={`source-status ${a.status === "available" ? "available" : ""}`}
            >
              {a.status === "available"
                ? "Подключён"
                : a.status === "experimental"
                  ? "Ожидает проверки"
                  : a.status === "restricted"
                    ? "Ограничен"
                    : a.status === "authentication_required"
                      ? "Нужен ключ"
                      : "Недоступен"}
            </span>
          </div>
        ))}
      </section>
      <section className="settings-block glass">
        <h2>
          <Info size={21} />
          Фоновое прослушивание
        </h2>
        <p className="muted">
          Плеер использует системное управление аудио, если оно поддерживается.
          Telegram и операционная система могут приостанавливать WebView при
          сворачивании или блокировке экрана.
        </p>
        <p className="muted">
          {s.current?.playback?.kind === "youtube"
            ? "Видео YouTube воспроизводится только в видимом плеере. При сворачивании NoteSound оно ставится на паузу; фоновый звук и экран блокировки не поддерживаются этой интеграцией."
            : caps.telegram
              ? "На этом устройстве нужно отдельно проверить сворачивание и блокировку экрана. Можно попробовать воспроизведение в браузере; результат также зависит от iOS или Android."
              : "Поддержка фонового звука зависит от браузера и устройства. Системное управление " +
                (caps.mediaSession
                  ? "доступно."
                  : "не поддерживается в этом браузере.")}
        </p>
        <button className="button subtle" onClick={openInBrowser}>
          <ExternalLink size={17} />
          Открыть в браузере
        </button>
        <p className="small muted">
          Хранилища Telegram и браузера могут быть раздельными. Перенесите
          библиотеку через JSON; аудиофайлы импортируйте снова.
        </p>
      </section>
      <div className="privacy-note">
        <ShieldCheck size={25} />
        <div>
          <strong>Твоя музыка — твоё личное пространство</strong>
          <p>
            Без скрытой аналитики и дополнительной регистрации. Запросы уходят
            только в подключённые каталоги. История и предпочтения хранятся на
            устройстве; сервер проверяет Telegram-авторизацию отдельно, когда
            она включена.
          </p>
        </div>
      </div>
      <p className="version">NoteSound Музыка · 2.0.0</p>
      {confirm && (
        <Modal
          title={
            confirm === "history"
              ? "Очистить историю?"
              : confirm === "taste"
                ? "Сбросить предпочтения?"
                : "Начать Волну заново?"
          }
          onClose={close}
        >
          <p className="muted">
            {confirm === "history"
              ? "История прослушиваний будет удалена."
              : confirm === "taste"
                ? "Лайки и дизлайки будут сброшены. Избранное и файлы сохранятся."
                : "Сохранённые запреты повторов будут сброшены. Треки снова смогут попадать в Волну."}
          </p>
          <button
            className="button danger-button full-width"
            onClick={() => {
              if (confirm === "history") void s.clearHistory();
              else if (confirm === "taste") void s.resetTaste();
              else void s.resetWave();
              close();
            }}
          >
            Подтвердить
          </button>
        </Modal>
      )}
    </div>
  );
}
