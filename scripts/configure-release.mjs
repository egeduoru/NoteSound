import { writeFile, readFile } from "node:fs/promises";

const value = process.argv[2];
const api = new URL(value || "https://notesound-hitmoz-test.onrender.com");
if (
  api.protocol !== "https:" || api.username || api.password || api.search ||
  api.hash || api.pathname !== "/"
) throw new Error("Release API must be an HTTPS origin without secrets or a path");
const index = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
if (!index.includes('/NoteSound/assets/') || !index.includes('/NoteSound/config.js'))
  throw new Error("Build this release with VITE_BASE_PATH=/NoteSound/");
await writeFile(
  new URL("../dist/config.js", import.meta.url),
  `// Public NoteSound server address. Do not add tokens here.\nwindow.NOTESOUND_CONFIG = ${JSON.stringify({ discoveryApiUrl: api.origin }, null, 2)};\n`,
);
await import("./build-sw.mjs");
console.log(`Release configured for ${api.origin}`);
