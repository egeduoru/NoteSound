/** Pure parser-boundary model shared by the server and provider. No network or secrets. */
const clean = (value, limit = 500) =>
  typeof value === "string"
    ? Array.from(value.normalize("NFKC"))
        .filter(
          (character) =>
            character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        )
        .join("")
        .trim()
        .slice(0, limit)
    : "";
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
export const metadataKey = (value) =>
  clean(value)
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
export function safePublicUrl(value, allowedHosts) {
  try {
    const url = new URL(clean(value, 2048));
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      return null;
    if (!allowedHosts.includes(url.hostname.toLowerCase())) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}
export function parseClock(value) {
  if (typeof value === "number")
    return Number.isFinite(value) && value >= 0 && value <= 86400 ? value : 0;
  const match = clean(value, 20).match(/^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/);
  if (!match || Number(match[3]) > 59 || (match[1] && Number(match[2]) > 59))
    return 0;
  return Math.min(
    86400,
    Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]),
  );
}
function hash(value) {
  let result = 2166136261;
  for (const character of value) {
    result ^= character.codePointAt(0);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}
const hitmozHosts = [
  "eu.hitmoz.com",
  "ru.hitmoz.org",
  "hitmoz.com",
  "hitmoz.org",
];
export function normalizeHitmozPayload(payload) {
  const envelope = object(payload);
  if (envelope.success === false) {
    if (
      typeof envelope.error === "string" &&
      /ничего не найдено|треки не найдены|no results/i.test(envelope.error)
    )
      return [];
    throw new Error("Hitmoz Parser сообщил об ошибке. Повторите запрос позже.");
  }
  if (envelope.success !== true || !Array.isArray(envelope.songs))
    throw new Error(
      "Формат Hitmoz Parser изменился: ожидается объект success/songs.",
    );
  const seen = new Set();
  const tracks = [];
  for (const item of envelope.songs.slice(0, 500)) {
    const row = object(item),
      title = clean(row.title),
      artist = clean(row.artist);
    if (!title || !artist) continue;
    const page = safePublicUrl(row.link, hitmozHosts);
    const numericId = page?.match(/\/song\/(\d+)(?:[/?]|$)/)?.[1];
    const identity =
      numericId || hash(`${metadataKey(artist)}::${metadataKey(title)}`);
    const key = `${metadataKey(artist)}::${metadataKey(title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push({
      id: `hitmoz:${identity}`,
      sourceId: "hitmoz",
      sourceName: "Hitmoz",
      title,
      artist,
      duration: parseClock(row.duration),
      artwork: safePublicUrl(row.cover, hitmozHosts) || undefined,
      externalUrl: page || undefined,
      platformId: numericId || undefined,
      genres: [],
      popularity:
        Number.isInteger(row.rank) && row.rank > 0 ? row.rank : undefined,
      availability: "unknown",
      playbackMode: "metadata",
      rights: { status: "unknown", basis: "none", allowMix: false },
      license: {
        name: "Права на воспроизведение не подтверждены",
        download: false,
      },
    });
  }
  return tracks;
}
export function normalizeLicensedTracks(payload, allowedHosts) {
  if (!Array.isArray(payload))
    throw new Error("Реестр аудио должен содержать массив tracks.");
  const ids = new Set();
  return payload.slice(0, 2000).flatMap((value) => {
    const raw = object(value),
      rights = object(raw.rights),
      source = object(raw.audioSource);
    const id = clean(raw.id, 200),
      title = clean(raw.title),
      artist = clean(raw.artist);
    const url = safePublicUrl(source.url, allowedHosts);
    if (
      !/^(?:licensed|hitmoz):[\w-]+$/.test(id) ||
      !title ||
      !artist ||
      ids.has(id) ||
      !url ||
      rights.status !== "confirmed" ||
      !["cc0", "license"].includes(rights.basis) ||
      !clean(rights.evidence, 2000)
    )
      return [];
    ids.add(id);
    const duration = parseClock(raw.duration);
    if (!duration) return [];
    const track = {
      id,
      sourceId: id.startsWith("hitmoz:") ? "hitmoz" : "licensed",
      sourceName: clean(raw.sourceName, 100) || "Разрешённый аудиокаталог",
      title,
      artist,
      duration,
      artwork: safePublicUrl(raw.artwork, allowedHosts) || undefined,
      externalUrl: safePublicUrl(raw.externalUrl, allowedHosts) || undefined,
      popularity:
        Number.isFinite(raw.popularity) && raw.popularity > 0
          ? raw.popularity
          : undefined,
      genres: Array.isArray(raw.genres)
        ? raw.genres
            .filter((g) => typeof g === "string")
            .slice(0, 20)
            .map((g) => clean(g, 80))
        : [],
      rights: {
        status: "confirmed",
        basis: rights.basis,
        evidence: clean(rights.evidence, 2000),
        allowMix: rights.allowMix === true && source.cors === true,
        allowTelegramDelivery: rights.allowTelegramDelivery === true,
      },
      audioSource: { url, cors: source.cors === true },
      availability: "unknown",
      playbackMode: "audio",
      license: {
        name:
          clean(object(raw.license).name, 200) || "Разрешение правообладателя",
        download: false,
      },
    };
    const cue = object(raw.cuePoints);
    if (
      ["manual", "licensed_metadata", "analysis"].includes(cue.cueSource) &&
      Number.isFinite(cue.cueConfidence) &&
      cue.cueConfidence >= 0 &&
      cue.cueConfidence <= 1
    ) {
      const cueIn =
        Number.isFinite(cue.cueInSeconds) &&
        cue.cueInSeconds >= 0 &&
        cue.cueInSeconds < duration
          ? cue.cueInSeconds
          : undefined;
      const cueOut =
        Number.isFinite(cue.cueOutSeconds) &&
        cue.cueOutSeconds > (cueIn || 0) &&
        cue.cueOutSeconds <= duration
          ? cue.cueOutSeconds
          : undefined;
      track.cuePoints = {
        cueInSeconds: cueIn,
        cueOutSeconds: cueOut,
        cueConfidence: cue.cueConfidence,
        cueSource: cue.cueSource,
      };
    }
    return [track];
  });
}
