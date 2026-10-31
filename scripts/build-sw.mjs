import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const root = new URL("../dist/", import.meta.url);
const assets = (await readdir(new URL("assets/", root)))
  .filter((name) => /\.(js|css|woff2?|ttf)$/.test(name))
  .map((name) => `assets/${name}`);
const artwork = (await readdir(new URL("artwork/", root)))
  .filter((name) => name.endsWith(".svg"))
  .map((name) => `artwork/${name}`);
const mascot = (await readdir(new URL("mascot/", root)))
  .filter((name) => name === "pink-bunny-sticker.png")
  .map((name) => `mascot/${name}`);
const files = [
  "./",
  "index.html",
  "favicon.svg",
  "manifest.webmanifest",
  "config.js",
  ...assets,
  ...artwork,
  ...mascot,
];
const hash = createHash("sha256")
  .update(await readFile(new URL("index.html", root)))
  .update(await readFile(new URL("config.js", root)))
  .digest("hex")
  .slice(0, 12);
const source = `/* Generated at build time. Audio is stored only by explicit user action in IndexedDB. */
const CACHE='notesound-shell-${hash}';
const FILES=${JSON.stringify(files)};
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('notesound-shell-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.includes('/audio/'))return;
 if(url.pathname===new URL('config.js',self.registration.scope).pathname){
  event.respondWith(fetch(event.request,{cache:'no-store'}).catch(()=>caches.open(CACHE).then(cache=>cache.match('config.js'))));return;
 }
 if(event.request.mode==='navigate'){
  event.respondWith(fetch(event.request).catch(()=>caches.open(CACHE).then(cache=>cache.match('index.html'))));return;
 }
 event.respondWith(caches.match(event.request).then(hit=>hit||fetch(event.request)));
});
`;
await writeFile(new URL("sw.js", root), source);
console.log(`Offline app shell: ${files.length} resources; audio excluded.`);
