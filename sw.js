/* Offline support. Network first, so you always get the newest version when online;
   the saved copy is only used when there's no connection. Your loan data is not stored here
   (it lives in the browser's localStorage). */
const CACHE = 'loan-v7';
const FILES = ['./', 'index.html', 'tracker.html', 'desktop.html', 'settings.css', 'settings.js', 'manifest.webmanifest', 'icons/apple-touch-icon.png', 'icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  e.respondWith(fetch(r).then(res => {
    if (res.ok && (new URL(r.url).origin === location.origin || r.url.startsWith('https://fonts.'))) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)); }
    return res;
  }).catch(() => caches.match(r, { ignoreSearch: true }).then(m => m || caches.match('index.html'))));
});
