// Service worker: permite instalar la app y que abra aunque la conexión sea mala.
// Siempre intenta la red primero (así nadie ve una versión vieja) y solo usa la copia
// guardada si no hay conexión. Las reservas (Supabase) nunca se guardan en caché.
const CACHE = 'cine-v1';
const SHELL = ['./', './index.html', './app.js', './style.css', './config.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;
  const sameOrigin = url.origin === self.location.origin;
  const cdn = url.hostname === 'cdn.jsdelivr.net';
  if (!sameOrigin && !cdn) return; // Supabase, Google… directo a la red

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (sameOrigin || cdn)) {
          const copy = res.clone();
          // las navegaciones con ?code= / #access_token (inicio de sesión) no se guardan
          if (!url.search) caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: req.mode === 'navigate' })
        .then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});
