# NoteSound — обновление Telegram Mini App

Комплект подготовлен для существующих адресов:

- Mini App: https://egeduoru.github.io/NoteSound/
- Сервер: https://notesound-hitmoz-test.onrender.com
- Репозиторий: https://github.com/egeduoru/NoteSound
- Бот: https://t.me/NoteSoundbot

Архив содержит файлы для обновления. Сам по себе он ничего не публикует.
Для этой версии ключ YouTube и токен Telegram-бота не нужны.

## 1. Загрузить исходники в GitHub

Распакуйте `NoteSound-MiniApp-upload.zip`. Внутри находятся три папки:

| Папка      | Содержимое                                                                 |
| ---------- | -------------------------------------------------------------------------- |
| `01-base`  | Настройки, сервер, картинки, собственные аудиофайлы, инструкция, `.github` |
| `02-app`   | Код интерфейса и плеера внутри `src`                                       |
| `03-tests` | Проверки приложения и сервера в папках `src` и `server`                    |

На странице репозитория откройте **Code → Add file → Upload files**.
Загрузите **содержимое** `01-base` в корень репозитория и нажмите **Commit changes**.
Повторите для содержимого `02-app`, затем `03-tests`.

Названия `01-base`, `02-app`, `03-tests` в репозиторий попадать не должны.
После загрузки в корне должны быть `package.json`, `index.html`, `render.yaml`,
а также папки `src`, `server`, `public`, `scripts`, `.github`.
Проверьте наличие `.github/workflows/deploy.yml`.
Промежуточные сборки могут завершаться ошибкой: оценивать нужно последнюю,
после загрузки всех трёх частей.

`NoteSound-GitHub-source.zip` содержит тот же проект целиком без разделения;
он подходит для GitHub Desktop или Git. Выберите один способ загрузки.

## 2. Обновить существующий сервер Render

Откройте сервис `notesound-hitmoz-test`. Раньше он запускал Python-проверку Hitmoz.
Теперь он должен запускать сервер NoteSound на Node.js.

В **Settings → Build → Source → Edit** выберите тот же репозиторий
`egeduoru/NoteSound`, ветку `main` и **Runtime: Docker**, затем сохраните.
Render позволяет сменить runtime существующего сервиса с сохранением адреса.
Не создавайте второй сервис через Blueprint, если обновляете этот.

| Поле                 | Значение                                  |
| -------------------- | ----------------------------------------- |
| Instance Type        | **Free**; внизу должно быть **$0/month**  |
| Branch               | `main`                                    |
| Root Directory       | **Пусто** — уберите старое `render-probe` |
| Dockerfile Path      | `server/Dockerfile`                       |
| Docker Build Context | `.` — корень репозитория                  |
| Docker Command       | Пусто: команда уже задана в Dockerfile    |
| Health Check Path    | `/api/catalog/status`                     |

В **Environment** задайте:

| Имя                       | Значение                     |
| ------------------------- | ---------------------------- |
| `HOST`                    | `0.0.0.0`                    |
| `PORT`                    | `10000`                      |
| `APP_ORIGINS`             | `https://egeduoru.github.io` |
| `REQUIRE_TELEGRAM_AUTH`   | `false`                      |
| `HITMOZ_METADATA_ENABLED` | `false`                      |
| `HITMOZ_PLAYBACK_ENABLED` | `false`                      |

Основной каталог использует публичные маршруты. Не включайте
`REQUIRE_TELEGRAM_AUTH=true`: этот клиент каталога не передаёт сеанс Telegram.
Токен бота добавлять не нужно.

Нажмите **Manual Deploy → Deploy latest commit**. Дождитесь **Live**.
Прежние команды `pip install ...` и `python app.py` не используются:
Dockerfile сам запускает `node server/index.mjs`.

Проверьте два адреса:

1. https://notesound-hitmoz-test.onrender.com/api/catalog/status — должен открыться JSON.
2. https://notesound-hitmoz-test.onrender.com/api/discovery/public/search?q=madk1d —
   при доступном внешнем источнике должен вернуться JSON со списком `tracks`.

`configured:false` в первом ответе относится к дополнительному лицензированному/Hitmoz
каталогу. Для основного поиска ориентируйтесь на второй адрес.
Прежняя страница `/probe` больше не является рабочим адресом приложения.

## 3. Проверить GitHub Pages

В **Settings → Pages → Build and deployment → Source** оставьте **GitHub Actions**.
В **Settings → Secrets and variables → Actions → Variables** можно задать:

| Имя                      | Значение                                     |
| ------------------------ | -------------------------------------------- |
| `VITE_DISCOVERY_API_URL` | `https://notesound-hitmoz-test.onrender.com` |

Workflow уже использует этот адрес по умолчанию, если переменная не задана.
Если переменная существует со старым адресом, исправьте её.
`VITE_MUSIC_API_URL` для этой конфигурации можно оставить пустым.
Ключ YouTube не используется и в сборку не включается.

В **Actions → Build and deploy NoteSound** дождитесь зелёных **build** и **deploy**
для последней загрузки. При необходимости повторите:
**Run workflow → main → Run workflow**.

Откройте https://egeduoru.github.io/NoteSound/ и проверьте поиск, запуск песни,
большой Play Волны и переход к следующему треку.

## 4. Открыть Mini App в Telegram

У BotFather уже указан прежний URL `https://egeduoru.github.io/NoteSound/`.
При обновлении файлов менять его не нужно. Полностью закройте Mini App и откройте снова.

При повторной настройке: **/mybots → @NoteSoundbot → Bot Settings → Configure Mini App**
и тот же URL. Для кнопки меню: **Menu Button**, подпись `Открыть музыку`, тот же URL.

## 5. Готовая сборка и изменение адреса

`NoteSound-site-ready.zip` — готовые файлы сайта с путём `/NoteSound/`
и настроенным адресом сервера. Это дополнительный вариант для статического хостинга.
Для описанного способа GitHub Actions используйте исходники из пункта 1:
workflow сам строит и публикует сайт. Не распаковывайте готовую сборку поверх исходников.

В готовом сайте есть публичный `config.js`. В нём можно поменять `discoveryApiUrl`
без пересборки сайта. Нужен HTTPS URL без токенов. Пустое поле использует адрес сборки.

## Бесплатное размещение и первая проверка

Render Free засыпает после 15 минут без запросов. Первый запрос после сна может
запускаться около минуты или дольше. Перед первой проверкой откройте
`/api/catalog/status` и дождитесь JSON. Если поиск успел показать ошибку,
после пробуждения нажмите **Повторить поиск**.
Для загрузки этого комплекта платный тариф не требуется;
актуальные ограничения и доступность Free определяет Render.

Обложки, поиск и запуск аудио теперь используют раздельные ограниченные бюджеты.
При ограничении 429 приложение показывает время ожидания и не повторяет запросы
до его истечения. Внешние источники могут временно ограничивать доступность музыки.
Размещение на сервере не снимает ограничения Telegram/iOS на фоновое воспроизведение.

## Справка

- [Render: смена runtime](https://render.com/docs/native-runtimes#changing-a-services-runtime)
- [Render: Docker](https://render.com/docs/docker)
- [Render Free](https://render.com/docs/free)
- [GitHub Pages: workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [Telegram: Main Mini App](https://core.telegram.org/bots/webapps#launching-the-main-mini-app)
