import {
  validateTelegramInitData,
  validateCatalogSession,
} from "./security.mjs";
/** Optional server-only delivery: recipient comes exclusively from authenticated Telegram data. */
export async function sendLicensedAudio(
  { trackId, initData, sessionToken, origin = "" },
  { enabled = false, botToken, service, fetcher = fetch, signal } = {},
) {
  if (!enabled) throw new Error("Telegram audio delivery is disabled");
  const user = sessionToken
    ? validateCatalogSession(sessionToken, botToken, { origin })
    : validateTelegramInitData(initData, botToken);
  const userId = user?.userId ?? user?.id;
  if (!Number.isSafeInteger(userId) || userId <= 0)
    throw new Error("Telegram authentication is required");
  const track = service.track(trackId);
  if (
    track?.rights?.status !== "confirmed" ||
    track.rights.allowTelegramDelivery !== true
  )
    throw new Error("This recording is not authorized for Telegram delivery");
  const source = await service.playable(trackId, signal, origin);
  if (!source || !/\.(mp3|m4a)$/i.test(new URL(source.url).pathname))
    throw new Error("An authorized MP3 or M4A source is required");
  try {
    const timeout = AbortSignal.timeout(10000);
    const response = await fetcher(
      `https://api.telegram.org/bot${botToken}/sendAudio`,
      {
        method: "POST",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: userId,
          audio: source.url,
          title: track.title,
          performer: track.artist,
          duration: Math.round(track.duration),
          protect_content: true,
        }),
      },
    );
    const payload = await response.json();
    if (
      !response.ok ||
      payload.ok !== true ||
      !Number.isSafeInteger(payload.result?.message_id)
    )
      throw new Error("delivery failed");
    return { messageId: payload.result.message_id };
  } catch {
    throw new Error(
      "Не удалось отправить аудио в Telegram. Убедитесь, что чат с ботом уже открыт.",
    );
  }
}
