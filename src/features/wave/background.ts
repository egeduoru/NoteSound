/** Let audio start and the next paint complete before optional recommendation work. */
export function scheduleWaveBackground(task: () => void, delay = 350) {
  let cancelled = false;
  let idle: number | undefined;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  const browser = typeof window === "undefined" ? undefined : window;
  const timer = setTimeout(() => {
    if (cancelled) return;
    const run = () => {
      if (!cancelled) task();
    };
    if (browser?.requestIdleCallback)
      idle = browser.requestIdleCallback(run, { timeout: 600 });
    else fallback = setTimeout(run, 0);
  }, delay);
  return () => {
    cancelled = true;
    clearTimeout(timer);
    clearTimeout(fallback);
    if (idle !== undefined) browser?.cancelIdleCallback(idle);
  };
}
