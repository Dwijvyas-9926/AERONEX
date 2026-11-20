/*
  AERONEX offline service worker. Written into dist/sw.js by the build
  (vite.config.ts, offlineApp), with the build's own file list.

  - The app's files are fetched once and kept; the app then opens offline.
  - A page load asks the network first, so a new release is seen as soon as
    there is a connection, and falls back to the kept copy without one.
  - Scripts, styles and fonts carry a hash of their content in their names:
    a kept one is always the right one, so they are served from the store.
  - Firmware downloads and anything from another site are never touched.
  - A new version waits (no skipWaiting on install): it takes over when the
    app is next opened, or when the page asks for it ("take-over").
*/
const VERSION = "__VERSION__";
const STORE = `shell.aeronex.${VERSION}`;
const FILES = __FILES__;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STORE).then((cache) =>
      // One at a time and forgiving: a file that fails is fetched when it is needed.
      Promise.all(FILES.map((f) => cache.add(new Request(f, { cache: "reload" })).catch(() => undefined))),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith("shell.aeronex.") && n !== STORE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "take-over") void self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Firmware must be the server's current file, every time.
  if (url.pathname.includes("/ardupilot-firmware/")) return;
  if (req.headers.has("range")) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(STORE).then((c) => c.put("./", copy));
          }
          return res;
        })
        .catch(() => caches.match("./", { cacheName: STORE, ignoreVary: true }).then((hit) => hit || Response.error())),
    );
    return;
  }

  event.respondWith(
    // ignoreVary: a host that answers "Vary: Origin" must not make a kept file miss.
    caches.match(req, { cacheName: STORE, ignoreVary: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            void caches.open(STORE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
