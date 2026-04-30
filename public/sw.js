/**
 * Service worker — app shell caching + Background Sync for offline queue.
 * Cache version: bump CACHE_VER when deploying CSS/JS changes.
 */

const CACHE_VER  = 'v1';
const CACHE_NAME = 'barrio-' + CACHE_VER;

const APP_SHELL = [
  '/',
  '/login.html',
  '/assets/css/main.css?v=1.0.0',
  '/assets/css/app.css?v=1.0.1',
  '/assets/vendor/jsqr.min.js?v=1.0.0',
  '/assets/js/app.js?v=1.0.1',
  '/assets/js/api.js?v=1.0.1',
  '/assets/js/offline.js?v=1.0.0',
  '/assets/js/scanner.js?v=1.0.0',
  '/assets/js/checkout.js?v=1.0.1',
  '/assets/js/checkin.js?v=1.0.1',
  '/assets/js/inventory.js?v=1.0.0',
  '/assets/js/history.js?v=1.0.0',
];

// ── Install: cache app shell ───────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// ── Activate: purge old caches ────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: network-first for API, cache-first for shell ───────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // API calls: network only (offline fallback handled by api.js + offline.js)
  if (url.pathname.startsWith('/api/')) return;

  // App shell: cache-first with network fallback
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(resp => {
        if (resp.ok && request.method === 'GET') {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
        }
        return resp;
      });
    })
  );
});

// ── Background Sync (Chrome Android) ─────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'barrio-sync') {
    // Notify the active client to run the sync
    event.waitUntil(
      self.clients.matchAll().then(clients =>
        clients.forEach(c => c.postMessage({ type: 'SYNC_OFFLINE' }))
      )
    );
  }
});
