/* Static shell only. Never cache API endpoints or other origins in the service worker. */
const CACHE_NAME = 'golf-yardage-shell-v1.3-r2';
const SHELL = [
  './', './index.html', './styles.css', './app.mjs',
  './lib/yardage.mjs', './lib/weather.mjs', './lib/compass.mjs', './manifest.webmanifest',
  './assets/icon-192.png', './assets/icon-512.png', './assets/apple-touch-icon.png',
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(name => name.startsWith('golf-yardage-shell-') && name !== CACHE_NAME)
      .map(name => caches.delete(name))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // API requests are not intercepted.
  event.respondWith(caches.match(request).then(cached => {
    if (cached) return cached;
    return fetch(request).catch(error => {
      if (request.mode === 'navigate') return caches.match('./index.html');
      throw error;
    });
  }));
});
