interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: { user?: { id?: number; first_name?: string } };
  platform: string;
  colorScheme: string;
  safeAreaInset?: { top: number; bottom: number };
  contentSafeAreaInset?: { top: number; bottom: number };
  ready(): void;
  expand(): void;
  isVersionAtLeast(version: string): boolean;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  openLink(
    url: string,
    options?: { try_instant_view?: boolean; try_browser?: string },
  ): void;
  onEvent(event: string, callback: () => void): void;
  offEvent(event: string, callback: () => void): void;
  BackButton: {
    show(): void;
    hide(): void;
    onClick(cb: () => void): void;
    offClick(cb: () => void): void;
  };
  HapticFeedback?: { impactOccurred(style: "light" | "medium"): void };
}
declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}
export const telegram = () => window.Telegram?.WebApp;
export const isTelegram = () => !!telegram()?.initData;
export function initializeTelegram() {
  const app = telegram();
  if (!app?.initData) return () => {};
  app.ready();
  app.expand();
  if (app.isVersionAtLeast("6.1")) {
    app.setHeaderColor("#ffffff");
    app.setBackgroundColor("#ffffff");
  }
  const update = () => {
    const insets = {
      "--tg-safe-top": app.safeAreaInset?.top ?? 0,
      "--tg-safe-bottom": app.safeAreaInset?.bottom ?? 0,
      "--tg-content-top": app.contentSafeAreaInset?.top ?? 0,
      "--tg-content-bottom": app.contentSafeAreaInset?.bottom ?? 0,
    };
    for (const [name, value] of Object.entries(insets))
      document.documentElement.style.setProperty(
        name,
        `${Math.max(0, value)}px`,
      );
    document.documentElement.dataset.telegramTheme = app.colorScheme;
  };
  update();
  [
    "viewportChanged",
    "safeAreaChanged",
    "contentSafeAreaChanged",
    "themeChanged",
  ].forEach((e) => app.onEvent(e, update));
  return () =>
    [
      "viewportChanged",
      "safeAreaChanged",
      "contentSafeAreaChanged",
      "themeChanged",
    ].forEach((e) => app.offEvent(e, update));
}
export function haptic() {
  try {
    if (isTelegram() && telegram()?.isVersionAtLeast("6.1"))
      telegram()?.HapticFeedback?.impactOccurred("light");
  } catch {
    /* optional device feature */
  }
}
export function openInBrowser() {
  const url = new URL(location.href);
  if (isTelegram())
    telegram()?.openLink(url.href, {
      try_instant_view: false,
      try_browser: "chrome",
    });
  else window.open(url.href, "_blank", "noopener,noreferrer");
}
export function capabilities() {
  return {
    telegram: isTelegram(),
    ios: /iPhone|iPad|iPod/.test(navigator.userAgent),
    mediaSession: "mediaSession" in navigator,
    indexedDB: "indexedDB" in window,
    online: navigator.onLine,
  };
}
