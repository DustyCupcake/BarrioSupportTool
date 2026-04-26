/**
 * Service worker — app shell caching + Background Sync for offline queue.
 * Cache version: bump CACHE_VER when deploying CSS/JS changes.
 */

const CACHE_VER  = 'v1';
const CACHE_NAME = 'barrio-' + CACHE_VER;

const APP_SHELL = [
  '/',
  '/login.html',
  '/assets/css/main.css',
  '/assets/css/app.css',
  '/assets/vendor/jsqr.min.js',
  '/assets/js/app.js',
  '/assets/js/api.js',
  '/assets/js/offline.js',
  '/assets/js/scanner.js',
  '/assets/js/checkout.js',
  '/assets/js/checkin.js',
  '/assets/js/inventory.js',
  '/assets/js/history.js',
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
