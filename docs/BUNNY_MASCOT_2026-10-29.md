# Кролик NoteSound — 29 октября 2026

Первая вкладка содержит крупное «МОЯ ВОЛНА», питомца и Play/Pause. Формы, подборки, очередь и пояснения с этой вкладки убраны. Поиск и «Моя музыка» не перерабатывались в этой задаче; глобальный мини-плеер и три вкладки сохранены.

## Живая анимация

Персонаж использует связную 2D-сетку WebGL 80×80, а не перемещение целого изображения. Отдельно двигаются голова, уши, корпус, лапы и мимика. Во время рока движения энергичнее, рэп-образ двигает ртом и лапой с микрофоном, грустный образ дышит медленнее. На паузе питомец продолжает двигаться; на нажатие реагирует лапами и сердечком.

Образ определяется по жанру, явно переданному настроению, названию и известным исполнителям. Акустический анализ и распознавание эмоций по звуку не выполняются. Это живая 2D-анимация, а не полноценная 3D-модель. Поддержаны reduced motion, остановка кадров в скрытой вкладке, освобождение ресурсов и облегчённый CSS-вариант при недоступном WebGL.

В браузере подтверждены WebGL-отрисовка, один заголовок, отсутствие форм и горизонтального переполнения. Записаны 30 разных кадров в области кролика при воспроизведении и 18 разных кадров на паузе. GIF — запись работающего интерфейса с меньшей частотой кадров, чем у анимации приложения (до 30 кадров/с). 16 тестов выбора образа и движений прошли; TypeScript, ESLint и сборка успешны.

## Сохранённые изображения

Использован встроенный инструмент image_gen, без CLI. Созданы прозрачные PNG 1254×1254:

- `public/mascot/bunny-idle.png` — спокойный образ.
- `public/mascot/bunny-rock.png` — рокер.
- `public/mascot/bunny-sad.png` — грустный образ в капюшоне.
- `public/mascot/bunny-rap.png` — очки и микрофон.

Все финальные изображения скопированы в проект и включены в офлайн-оболочку. Исходники генерации в папке Codex сохранены. Видео-пример интерфейса: `docs/notesound-bunny-live-2026-10-29.gif`.

## Промпты генерации

### Базовый образ

Use case: stylized-concept. Asset type: production character mascot for NoteSound music app, transparent PNG cutout, one original character, no UI. Create an exceptionally polished, adorable, detailed 3D cartoon baby rabbit wearing oversized lavender/periwinkle over-ear headphones, softly rounded headphone pads and translucent liquid-glass ear cups with delicate reflections. White plush fur with subtle lilac shadows, individual fine fluffy fibers, long soft ears with pale blush interiors, expressive large glossy dark violet eyes, tiny rosy nose, chubby cheeks, small smile, cute short paws and fluffy feet. Premium animated film / designer plush quality, stylish rather than infantile, friendly music-loving companion. A simple tiny pastel-lavender sweatshirt body, no text or symbols. Neutral happy relaxed seated pose, front-facing with very subtle 3/4 depth, head upright, paws in lap; show both ears, headphones, full head, whole body and feet. Color palette harmonious with a pale lavender liquid glass app; soft studio lighting, realistic fur and soft fabric material detail, gentle lavender rim light. Composition square, character centered, ears begin about 7% from top, feet end around90%, generous transparent margins, head/chest seam around56% image height for later head-bob animation. No stage, no colored background, no floor plane, no scenery, no typography, no watermark, no extra characters. Genuine transparent alpha around subject; preserve clean soft fur edges. This is the canonical character identity for later rock, sad hoodie and rapper variants.

### Рок — редактирование базового образа

Use case: identity-preserve. Edit the reference mascot into its ROCK MUSIC mood. Preserve exactly the same adorable original white fluffy baby rabbit identity, huge violet eyes, rosy nose, plush proportions, long floppy pink-inner ears, lavender translucent liquid-glass over-ear headphones, seated full-body framing and transparent background. Make it an enthusiastic cute rock listener: eyes joyfully nearly closed, tiny open happy singing smile, head leaning slightly forward as if beginning a headbang. Give the little lavender sweatshirt a very subtle dark-plum sleeveless rocker vest, no logos, no text. Paws can be planted on knees; no guitar and no extra objects. Highest quality detailed 3D cartoon fur, fabric and headphone reflections, soft studio light matching reference. Keep character centered at identical scale, all ears and feet inside image. Head/chin meets torso near62% height; this will be animated with a head-bob rig. Actual transparent alpha cutout, no background, no floor, no watermark.

### Грустный — редактирование базового образа

Use case: identity-preserve. Edit the reference mascot into its SAD / MELANCHOLIC MUSIC mood. Preserve exactly the same adorable original white fluffy baby rabbit identity, violet eyes, rosy nose, plush proportions, long floppy pink-inner ears, lavender translucent liquid-glass over-ear headphones and seated full-body framing. Pull up a soft oversized pastel-lavender hoodie hood around the rabbit's head, with neat openings for long ears and headphones still clearly visible. It sits curled up gently with paws close together in its lap, head slightly lowered, tender wistful eyes and a tiny melancholy pout: sweet and comforting, never distressed. Detailed premium 3D cartoon fine fur and soft knitted fabric; same soft studio lighting and pastel lilac palette. Keep character at same scale and camera angle as reference, centered, whole ears and feet visible with margin. Genuine transparent alpha cutout, no background, no scenery, no text, no watermark.

### Рэп — редактирование базового образа

Use case: identity-preserve. Edit the reference mascot into its RAP MUSIC mood. Preserve exactly the same adorable original white fluffy baby rabbit identity, rosy nose, plush proportions, fine white fur, long floppy pink-inner ears and lavender translucent liquid-glass headphones, same seated full-body framing and scale. Give it cool glossy BLACK SUNGLASSES with rounded rectangular lenses fitted neatly over its eyes, a small handheld black-and-chrome microphone in one front paw close to its mouth, and a cheerful slightly open mouth as if rapping along. Same soft pastel-lavender sweatshirt, subtle confident head angle and other paw lightly gesturing. Cute and playful, not aggressive, no money/weapon/branding props. Premium polished 3D cartoon fine fur, soft fabric, crisp sunglass highlights and metallic microphone mesh. Same lighting/camera/palette as reference; character centered, ears and feet fully inside canvas. Genuine transparent alpha background, no scenery or floor plane, no text or watermark.
