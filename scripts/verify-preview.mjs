import { readdir } from "node:fs/promises";
const base = new URL(process.argv[2] || "http://127.0.0.1:4173/NoteSound/");
const html = await (await fetch(base)).text();
if (!html.includes('id="root"')) throw new Error("App shell is missing");
const resources = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((match) => new URL(match[1], base))
  .filter((url) => url.origin === base.origin);
resources.push(new URL("sw.js", base));
for (const file of await readdir(new URL("../dist/artwork/", import.meta.url)))
  if (file.endsWith(".svg")) resources.push(new URL(`artwork/${file}`, base));
resources.push(new URL("audio/violet-hour.wav", base));
await Promise.all(
  resources.map(async (url) => {
    if (!url.pathname.startsWith(base.pathname))
      throw new Error(`Resource escapes the configured base: ${url.pathname}`);
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok)
      throw new Error(`HTTP ${response.status}: ${url.pathname}`);
    const type = response.headers.get("content-type") || "";
    if (
      (url.pathname.endsWith(".js") && !/javascript/.test(type)) ||
      (url.pathname.endsWith(".css") && !/text\/css/.test(type))
    )
      throw new Error(`Wrong MIME type: ${url.pathname}`);
  }),
);
console.log(
  `PASS: app shell and ${resources.length} resources served under ${base.pathname}; JS/CSS MIME types correct.`,
);
