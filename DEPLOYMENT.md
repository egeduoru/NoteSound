# Запуск и публикация NoteSoundbot 2.0

## Frontend без внешнего каталога

Нужны Node.js 24 и pnpm 11.25.0. Из корня проекта:

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

Откройте адрес Vite, обычно `http://127.0.0.1:5173/`. Без API доступны собственные CC0-композиции и личный импорт: настоящее аудио для проверки плеера, Волны и Mix, без каталога коммерческих хитов.

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm preview
```

`pnpm test:server` запускает серверные тесты. `pnpm server` использует переменные процесса; dotenv-пакет не добавлен.

## Окружение frontend

При необходимости скопируйте `.env.example` в `.env.local`.

| Переменная | Значение |
|---|---|
| `VITE_BASE_PATH` | `/NoteSound/` для существующего Pages |
| `VITE_DISCOVERY_API_URL` | HTTPS-адрес основного музыкального каталога; для текущего Render `https://notesound-hitmoz-test.onrender.com` |
| `VITE_MUSIC_API_URL` | Пусто — локальный каталог; локально `http://127.0.0.1:3001`; публично — HTTPS-адрес отдельного API |
| `VITE_LEGACY_YOUTUBE_ENABLED` | `false`; явный временный откат к официальному видимому iframe |
| `VITE_YOUTUBE_API_KEY` | Только для включённого старого режима |

Все `VITE_*` входят в публичную сборку. BOT_TOKEN и секреты здесь не хранятся. После изменения переменных перезапустите Vite или пересоберите сайт.

В готовой статической сборке адрес основного каталога также можно указать в
`config.js`: `window.NOTESOUND_CONFIG.discoveryApiUrl`. Корректный непустой адрес
имеет приоритет перед адресом сборки. Это публичная настройка без токенов.
Подробные шаги для текущих GitHub Pages и Render: [MINI_APP_RELEASE.md](MINI_APP_RELEASE.md).

## Отдельный API каталогов

GitHub Pages не запускает Node/Python/PHP. Удалённый каталог требует отдельного HTTPS-сервиса, при этом бот и адрес Mini App сохраняются.

Скопируйте `server/.env.example` в `server/.env`, оставьте Hitmoz выключенным и из корня запустите:

```powershell
node --env-file=server/.env server/index.mjs
```

Status: `http://127.0.0.1:3001/api/catalog/status`. Задайте локальный API в `.env.local` frontend. Запуск пустого API не добавляет музыку.

| Серверная переменная | Правило |
|---|---|
| `HOST`, `PORT` | `127.0.0.1`, `3001`; на хостинге значения платформы |
| `APP_ORIGINS` | Точные origin через запятую: `https://egeduoru.github.io,http://127.0.0.1:5173`; без пути и `*` |
| `REQUIRE_TELEGRAM_AUTH` | `false` для локального демо; `true` для публичного API с Telegram-доступом |
| `BOT_TOKEN` | Секрет существующего бота, только сервер; обязателен при включённой авторизации |
| `CATALOG_SESSION_TTL_SECONDS` | `28800` (8 часов), допустимо 300–86400 |
| `HITMOZ_METADATA_ENABLED` | `false`, включается после подтверждения условий доступа |
| `HITMOZ_PLAYBACK_ENABLED` | `false`, не заменяет права на конкретные записи |
| `HITMOZ_PARSER_URL` | Фиксированный HTTPS-адрес собственной разрешённой обёртки |
| `HITMOZ_PARSER_ALLOWED_HOSTS` | Точные разрешённые имена хостов парсера |
| `LICENSED_AUDIO_ALLOWED_HOSTS` | Точные публичные HTTPS-хосты разрешённого аудио/обложек |
| `LICENSED_CATALOG_FILE` | `server/licenses.json`, относительно рабочей папки процесса либо абсолютный путь |
| `TELEGRAM_SEND_AUDIO_ENABLED` | `false`; пример настройки будущего вызывающего кода, автоматического маршрута отправки нет |

Frontend обменивает свежий подписанный `initData` на сеанс каталога с ограниченным сроком и привязкой Origin. Сеанс хранится в памяти. После истечения может понадобиться заново открыть Mini App. Неподписанный user ID не авторизует запросы. В обычном браузере без `initData` защищённый API недоступен; собственный каталог остаётся доступным.

`server/Dockerfile` — дополнительный рецепт, не обязательная зависимость. Docker здесь не запускался; перед публикацией контейнер нужно проверить на выбранном хостинге. Задайте секреты и реестр через настройки хостинга. Реальный BOT_TOKEN и приватный реестр в публичные файлы не включаются.

Для основного публичного discovery-каталога актуального комплекта оставьте
`REQUIRE_TELEGRAM_AUTH=false`: его клиент не передаёт Telegram-сеанс. Описанная
авторизация относится к дополнительным Hitmoz/licensed адаптерам. Для готового
публичного режима токен бота не нужен. Контейнерный рецепт предназначен для
Render и отдельно проверяется на хостинге после загрузки.

## Реестр разрешённых записей

Скопируйте пустой `server/licenses.example.json` в `server/licenses.json`. Добавляйте только собственную или явно лицензированную музыку. Ниже **условная структура, не рабочая песня и не готовая лицензия**:

```json
{
  "tracks": [{
    "id": "licensed:my-original-001",
    "title": "Название собственной записи",
    "artist": "Автор записи",
    "duration": 180,
    "sourceName": "Мой разрешённый каталог",
    "externalUrl": "https://audio.example.com/releases/my-original-001",
    "artwork": "https://audio.example.com/covers/my-original-001.jpg",
    "genres": [],
    "rights": {
      "status": "confirmed",
      "basis": "license",
      "evidence": "Реальный документ или URL разрешения правообладателя",
      "allowMix": true,
      "allowTelegramDelivery": false
    },
    "audioSource": {
      "url": "https://audio.example.com/audio/my-original-001.mp3",
      "cors": true
    },
    "cuePoints": {
      "cueInSeconds": 16,
      "cueOutSeconds": 170,
      "cueConfidence": 0.9,
      "cueSource": "manual"
    }
  }]
}
```

Замените пример реальными подтверждёнными данными и внесите аудиохост в `LICENSED_AUDIO_ALLOWED_HOSTS`. Источник должен поддерживать HEAD и возвращать аудио Content-Type. Для Mix нужны `allowMix` и фактический CORS `Access-Control-Allow-Origin` для origin приложения либо `*`, а не только `cors:true`. Без CORS совместимое аудио может работать обычным HTMLAudio, но не Web Audio Mix. Реестр принимает `basis:cc0` либо `license` с непустым доказательством прав. Метки необязательны, выдумывать их нельзя.

Для Hitmoz требуется стабильный `hitmoz:<id>` нормализованной записи, канонический реестр и серверный playback-флаг. `download` парсера не используется автоматически.

## Включение Hitmoz после разрешения

1. Подтвердите условия автоматического доступа к метаданным и отдельные права воспроизведения/сведения записей.
2. Разверните контролируемую обёртку с контрактом `success/songs`. NoteSound не запускает сторонний скрипт или пользовательские shell-команды.
3. Задайте HTTPS URL, точный allowlist и включите только метаданные.
4. Проверьте status/search/top и ошибки. HTTP 403 не обходится.
5. Наполните реестр разрешённых записей; затем включайте playback и проверяйте реальные файлы, HEAD и CORS.

PHP в зависимости NoteSound не добавлен: Node API принимает JSON внешней обёртки. При выборе неизменённого стороннего `index.php` его инфраструктуру обеспечивают отдельно.

## Публикация существующего сайта

1. Загрузите актуальные исходники в `egeduoru/NoteSound`, включая скрытую `.github` и workflow. Не загружайте `node_modules`, `.env.local`, `server/.env`, BOT_TOKEN, приватный реестр, `.qa`, `outputs`.
2. Settings → Pages: оставьте Source **GitHub Actions**.
3. Для основного каталога задайте Repository variable `VITE_DISCOVERY_API_URL` с HTTPS-адресом Render. В текущем workflow адрес `https://notesound-hitmoz-test.onrender.com` используется по умолчанию. `VITE_MUSIC_API_URL` нужен только дополнительным Hitmoz/licensed адаптерам.
4. Сохраните изменения в `main`; workflow проверяет типы, lint, тесты, строит и публикует `dist`.
5. Дождитесь зелёных `build`/`deploy`, откройте сайт и проверьте плеер. Для обновления оболочки полностью закройте и откройте Mini App.

Workflow фиксирует `VITE_LEGACY_YOUTUBE_ENABLED=false`. Намеренный откат требует изменения флага и новой сборки. Для обычного 2.0 новый YouTube-ключ не нужен. Настройки BotFather менять не требуется.

## Откат

Архив до переработки: `outputs/rollback/NoteSound_before_2_0_2026-10-28.zip`, рядом контрольная сумма. Откат кода не понижает IndexedDB: перед ним экспортируйте библиотеку и сохраните личные аудиофайлы. Обычное обновление сайта не удаляет базу 2.0.
