import { spawn } from "node:child_process";
import { access, mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const appUrl = "http://127.0.0.1:5173/";
const logs = resolve(root, ".local", "logs");

async function ready(url, kind) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (error) {
    if (error.cause?.code === "ECONNREFUSED") return false;
    throw error;
  }
  const text = await response.text();
  const matches = kind === "app"
    ? text.includes('id="root"') && text.includes("NoteSound")
    : response.headers.get("content-type")?.includes("application/json") &&
      text.includes('"metadataEnabled"');
  if (!response.ok || !matches) {
    throw new Error(`Порт занят другим сервисом: ${url}. Закройте его и повторите запуск.`);
  }
  return true;
}

async function ensureService(name, args, url, kind, env) {
  if (await ready(url, kind)) {
    console.log(`${name}: уже работает.`);
    return;
  }
  const log = await open(resolve(logs, `${kind}.log`), "a");
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: root,
      detached: true,
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ["ignore", log.fd, log.fd],
    });
    await new Promise((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    child.unref();
  } finally {
    await log.close();
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(250);
    if (await ready(url, kind)) {
      console.log(`${name}: запущено.`);
      return;
    }
    if (child.exitCode !== null) break;
  }
  throw new Error(`Не удалось запустить ${name}. Подробности: ${resolve(logs, `${kind}.log`)}`);
}

try {
  await access(resolve(root, "node_modules/vite/bin/vite.js"));
  await mkdir(logs, { recursive: true });
  await ensureService(
    "Поиск музыки",
    ["server/dev-discovery.mjs"],
    "http://127.0.0.1:3002/api/catalog/status",
    "catalog",
    { HOST: "127.0.0.1", DISCOVERY_PORT: "3002" },
  );
  await ensureService(
    "NoteSound",
    ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
    appUrl,
    "app",
    { VITE_BASE_PATH: "/" },
  );
  console.log(`\nОткройте ${appUrl}#/wave`);
  if (process.platform === "win32" && !process.argv.includes("--no-open")) {
    const opener = spawn("explorer.exe", [`${appUrl}#/wave`], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    opener.on("error", () => {});
    opener.unref();
  }
} catch (error) {
  console.error(`NoteSound: ${error.code === "ENOENT" ? "Сначала установите зависимости: pnpm install --frozen-lockfile" : error.message}`);
  process.exitCode = 1;
}
