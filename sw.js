/* PiezoVisit service worker: makes the app open without network.
   - app files: answered from the cache at once, refreshed in the background
     (a change is visible the second time the app is opened)
   - map tiles: every tile seen once is kept, so browse the visit area before leaving
   Change VERSION to force every phone to drop its old copy of the app files. */
const VERSION = "96e7e69c55";
const SHELL = "piezovisit-shell-" + VERSION;
const TILES = "piezovisit-tiles";
const MAX_TILES = 6000;

const FILES = [
  "./", "index.html", "manifest.webmanifest",
  "css/app.css", "js/i18n.js", "js/core.js", "js/app.js",
  "data/data.enc.js", "js/unlock.js",
  "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
];
const TILE_HOSTS = ["server.arcgisonline.com", "tile.openstreetmap.org"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("piezovisit-shell-") && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_TILES) await Promise.all(keys.slice(0, keys.length - MAX_TILES).map(k => cache.delete(k)));
}

async function tile(request) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  // tiles come from other sites: the answer is "opaque" (status 0) but can still be stored
  if (res.ok || res.type === "opaque") {
    cache.put(request, res.clone()).then(() => { if (Math.random() < 0.02) trim(cache); });
  }
  return res;
}

async function shell(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request, { ignoreSearch: true });
  const fresh = fetch(request).then(res => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  return hit || (await fresh) || new Response("Offline", { status: 503 });
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (TILE_HOSTS.some(h => url.hostname.endsWith(h))) e.respondWith(tile(req).catch(() => new Response("", { status: 504 })));
  else if (url.origin === self.location.origin) e.respondWith(shell(req));
  // anything else (road routing) goes to the network as usual
});
