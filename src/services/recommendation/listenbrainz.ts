import type { Track } from "../../types/music";
import { getDiscoveryApiUrl } from "../../lib/runtime-config";

/** ListenBrainz supplies metadata candidates, not licensed audio streams. */
export interface RecordingSuggestion {
  mbid: string;
  artist: string;
  title: string;
  score: number;
}
const cache = new Map<string, { until: number; values: RecordingSuggestion[] }>();
export async function suggestSimilarRecordings(seed: Track, signal?: AbortSignal): Promise<RecordingSuggestion[]> {
  if (seed.local || seed.sourceId === "local" || signal?.aborted) return [];
  const base = getDiscoveryApiUrl();
  if (!base) return [];
  const query = `${seed.artist} ${seed.title}`.normalize("NFKC").trim().slice(0, 120);
  if (!query) return [];
  const hit = cache.get(query);
  if (hit?.until && hit.until > Date.now()) return hit.values;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 6500);
  try {
    const response = await fetch(`${base === "/" ? "" : base}/api/music/similar?q=${encodeURIComponent(query)}`, {
      signal: controller.signal, credentials: "omit", headers: { Accept: "application/json" },
    });
    if (!response.ok) return [];
    const raw: unknown = await response.json();
    const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const values = (Array.isArray(data.recommendations) ? data.recommendations : [])
      .filter((item): item is Record<string, unknown> => item && typeof item === "object")
      .filter((v) => typeof v.title === "string" && typeof v.artist === "string" &&
        typeof v.mbid === "string" && /^[a-f0-9-]{36}$/i.test(v.mbid))
      .slice(0, 8).map(v => ({ title: String(v.title).slice(0, 160), artist: String(v.artist).slice(0, 160), mbid: String(v.mbid), score: Number(v.score) || 0 }));
    cache.set(query, { until: Date.now() + 60 * 60_000, values });
    if (cache.size > 100) cache.delete(cache.keys().next().value!);
    return values;
  } catch { return []; }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}
