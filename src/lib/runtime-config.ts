interface PublicRuntimeConfig {
  /** Public backend address only. Secrets never belong in the browser config. */
  discoveryApiUrl?: string;
}

declare global {
  interface Window {
    NOTESOUND_CONFIG?: PublicRuntimeConfig;
  }
}

function publicApiUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "/") return text;
  if (!text || text.length > 2048) return null;
  try {
    const url = new URL(text);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname))
      )
    )
      return null;
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** A ready static build can point at its deployed backend by editing config.js.
 * Empty or damaged runtime values retain the build's existing configuration. */
export function resolveDiscoveryApiUrl(
  runtimeConfig: unknown,
  buildValue: unknown = "",
  development = false,
): string {
  const runtime =
    runtimeConfig &&
    typeof runtimeConfig === "object" &&
    !Array.isArray(runtimeConfig)
      ? publicApiUrl((runtimeConfig as PublicRuntimeConfig).discoveryApiUrl)
      : null;
  return runtime ?? publicApiUrl(buildValue) ?? (development ? "/" : "");
}

export function getDiscoveryApiUrl(): string {
  return resolveDiscoveryApiUrl(
    typeof window === "undefined" ? undefined : window.NOTESOUND_CONFIG,
    import.meta.env.VITE_DISCOVERY_API_URL,
    import.meta.env.DEV,
  );
}
