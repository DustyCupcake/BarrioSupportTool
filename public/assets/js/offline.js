/**
 * IndexedDB-backed offline queue.
 * Stores checkout/checkin events when the device is offline.
 * Syncs automatically on reconnect.
 */

import { post, setCsrf } from './api.js?v=1.0.0';

const DB_NAME    = 'barrio_support';
const DB_VERSION = 1;
const STORE      = 'offline_queue';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'client_id' });
        store.createIndex('synced', 'synced', { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export async function enqueue(event) {
  const db    = await openDB();
  const entry = {
    client_id:   uuid(),
    synced:      0,
    occurred_at: new Date().toISOString(),
    ...event,
  };
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put(entry);
    req.onsuccess = () => resolve(entry);
    req.onerror   = e => reject(e.target.error);
  });
}

async function getPending() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE, 'readonly');
    const index = tx.objectStore(STORE).index('synced');
    const req   = index.getAll(IDBKeyRange.only(0));
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function markSynced(client_ids) {
  if (!client_ids.length) return;
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  const st = tx.objectStore(STORE);
  await Promise.all(client_ids.map(id => new Promise((res, rej) => {
    const get = st.get(id);
    get.onsuccess = e => {
      const rec = e.target.result;
      if (rec) { rec.synced = 1; st.put(rec); }
      res();
    };
    get.onerror = e => rej(e.target.error);
  })));
}

export async function sync(showToast) {
  const pending = await getPending();
  if (!pending.length) return;

  // Flatten to API shape
  const events = pending.map(e => ({
    client_id:   e.client_id,
    type:        e.body?.type || (e.path === '/checkout' ? 'checkout' : 'checkin'),
    item_qr:     e.body?.item_qrs?.[0] ?? e.body?.item_qr,
    barrio_id:   e.body?.barrio_id,
    occurred_at: e.occurred_at,
  }));

  try {
    const result = await post('/sync/offline-queue', { events });
    const synced_ids = events
      .filter((_, i) => !result.rejected?.find(r => r.client_id === events[i].client_id))
      .map(e => e.client_id);
    await markSynced(synced_ids);

    if (showToast) {
      const msg = result.rejected?.length
        ? `Synced ${result.processed} offline events (${result.rejected.length} rejected)`
        : `Synced ${result.processed} offline event${result.processed !== 1 ? 's' : ''}`;
      showToast(msg);
    }
  } catch {
    // Will retry on next online event
  }
}

export function initOfflineSync(showToast) {
  window.addEventListener('online', () => sync(showToast));

  // Attempt sync on load in case previous session had pending events
  if (navigator.onLine) {
    setTimeout(() => sync(showToast), 2000);
  }
}
