import type { Track } from "../../types/music";

export const MIX_HEADROOM = Math.SQRT1_2;
interface ChannelGraph {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
}
export type AudioContextFactory = () => AudioContext;
const defaultFactory: AudioContextFactory = () => {
  const context =
    globalThis.AudioContext ??
    (
      globalThis as typeof globalThis & {
        webkitAudioContext?: typeof AudioContext;
      }
    ).webkitAudioContext;
  if (!context) throw new Error("Web Audio недоступен в этом браузере.");
  return new context();
};

/** Audio elements only enter Web Audio when their explicitly permitted source supports CORS. */
export function supportsMix(track: Track, url: string): boolean {
  if (
    track.playback?.kind === "youtube" ||
    track.rights?.status !== "confirmed" ||
    !track.rights.allowMix
  )
    return false;
  try {
    const base =
      typeof location === "undefined" ? "http://localhost/" : location.href;
    const parsed = new URL(url, base);
    if (parsed.protocol === "blob:") return true;
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    return (
      parsed.origin === new URL(base).origin || track.audioSource?.cors === true
    );
  } catch {
    return false;
  }
}

/** At most two reusable element graphs share a single lazily-created AudioContext. */
export class WaveMixEngine {
  private context: AudioContext | null = null;
  private channels = new Map<HTMLAudioElement, ChannelGraph>();
  constructor(private factory: AudioContextFactory = defaultFactory) {}
  get currentTime() {
    return this.context?.currentTime ?? 0;
  }
  get available() {
    return !!this.context;
  }
  async unlock() {
    this.context ??= this.factory();
    if (this.context.state === "suspended") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.context.resume(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Браузер не активировал Wave Mix.")),
              2000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  async route(element: HTMLAudioElement) {
    await this.unlock();
    if (this.channels.has(element)) return;
    if (this.channels.size >= 2)
      throw new Error("Доступны только два канала Wave Mix.");
    const source = this.context!.createMediaElementSource(element);
    const gain = this.context!.createGain();
    source.connect(gain);
    gain.connect(this.context!.destination);
    gain.gain.setValueAtTime(0, this.currentTime);
    this.channels.set(element, { source, gain });
    element.volume = 1;
  }
  routed(element: HTMLAudioElement) {
    return this.channels.has(element);
  }
  level(element: HTMLAudioElement, gain: number) {
    const node = this.channels.get(element);
    if (!node) return;
    node.gain.gain.cancelScheduledValues(this.currentTime);
    node.gain.gain.setValueAtTime(
      Math.max(0, Math.min(1, gain)),
      this.currentTime,
    );
  }
  schedule(
    from: HTMLAudioElement,
    to: HTMLAudioElement,
    progress: number,
    remainingSeconds: number,
    volume: number,
  ) {
    const start = Math.max(0, Math.min(1, progress));
    for (const [element, incoming] of [
      [from, false],
      [to, true],
    ] as const) {
      const channel = this.channels.get(element);
      if (!channel) throw new Error("Аудиоканал не подготовлен.");
      const curve = new Float32Array(96);
      for (let index = 0; index < curve.length; index++) {
        const value = start + ((1 - start) * index) / (curve.length - 1);
        curve[index] =
          (incoming
            ? Math.sin((value * Math.PI) / 2)
            : Math.cos((value * Math.PI) / 2)) *
          MIX_HEADROOM *
          volume;
      }
      const parameter = channel.gain.gain;
      parameter.cancelScheduledValues(this.currentTime);
      parameter.setValueAtTime(curve[0], this.currentTime);
      if (remainingSeconds > 0)
        parameter.setValueCurveAtTime(
          curve,
          this.currentTime,
          remainingSeconds,
        );
      else parameter.setValueAtTime(curve[curve.length - 1], this.currentTime);
    }
  }
  release(element: HTMLAudioElement) {
    const graph = this.channels.get(element);
    if (!graph) return;
    graph.source.disconnect();
    graph.gain.disconnect();
    this.channels.delete(element);
  }
  async dispose() {
    for (const element of this.channels.keys()) this.release(element);
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") await context.close();
  }
}
