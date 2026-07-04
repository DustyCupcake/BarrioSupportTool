/**
 * Truck crew fill route page.
 * Requires fill_truck permission (shift QR session or production_admin).
 *
 * Two-step sanitation flow:
 *   1. POST /fill/confirm  → writes fill_delivered transaction (water in the cube)
 *   2. POST /fill/sanitize → writes fill_confirmed transaction (chlorinated/sanitized)
 *
 * pendingSanitizations tracks cubes delivered but not yet sanitized this session.
 * Persisted to localStorage so a page refresh doesn't lose the list.
 */

import { Scanner } from './scanner.js?v=1.0.0';
import { renderSiteOverlay } from './map-overlay.js?v=1.0.0';

const CLAIM_KEY    = 'fill_claim_id';
const SANITIZE_KEY = 'fill_pending_sanitizations';

let csrfToken = null;
let direction  = null;
let claimId    = null;
let scanner    = null;

// ── Stop state ────────────────────────────────────────────────────────────────
let stops        = [];
let allStops     = [];
let stopStatuses = new Map(); // cube_qr → 'pending'|'filled'|'skipped'

// ── Pending sanitization state ────────────────────────────────────────────────
// [{ cube_id, cube_qr, cube_label, entity_id, entity_name, delivered_at }]
let pendingSanitizations = [];

function loadPendingSanitizations() {
  try { return JSON.parse(localStorage.getItem(SANITIZE_KEY) || '[]'); } catch { return []; }
}
function savePendingSanitizations() {
  try { localStorage.setItem(SANITIZE_KEY, JSON.stringify(pendingSanitizations)); } catch {}
}

// ── Map state ─────────────────────────────────────────────────────────────────
let mapView    = false;
let leafletMap = null;
let mapMarkers = new Map(); // cube_qr → L.Marker
let userMarker = null;
let gpsWatchId = null;

// ── Stop helpers ──────────────────────────────────────────────────────────────

function initStopStatuses(newStops) {
  newStops.forEach(s => {
    if (!allStops.find(a => a.cube_qr === s.cube_qr)) allStops.push(s);
    if (!stopStatuses.has(s.cube_qr)) stopStatuses.set(s.cube_qr, 'pending');
  });
  allStops.forEach(s => {
    if (!newStops.find(n => n.cube_qr === s.cube_qr) &&
        stopStatuses.get(s.cube_qr) === 'pending') {
      stopStatuses.set(s.cube_qr, 'filled');
    }
  });
}

function getNextStop()      { return stops.find(s => stopStatuses.get(s.cube_qr) === 'pending') ?? null; }
function getNextStopIndex() { return stops.findIndex(s => stopStatuses.get(s.cube_qr) === 'pending'); }
function pendingCount()     { return [...stopStatuses.values()].filter(v => v === 'pending').length; }
function filledCount()      { return [...stopStatuses.values()].filter(v => v === 'filled').length; }
function skippedCount()     { return [...stopStatuses.values()].filter(v => v === 'skipped').length; }

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  try {
    const res  = await fetch('/api/auth/me', { credentials: 'include' });
    if (!res.ok) throw new Error();
    const user = await res.json();
    csrfToken  = user.csrf_token;
    if (!user.permissions?.includes('fill_truck')) {
      document.getElementById('fr-body').innerHTML =
        '<div class="fr-empty">You need <b>fill_truck</b> permission to access this page.</div>';
      return;
    }
  } catch {
    window.location.href = '/login.html?next=' + encodeURIComponent(location.pathname);
    return;
  }

  const saved = localStorage.getItem(CLAIM_KEY);
  if (saved) {
    try { const p = JSON.parse(saved); claimId = p.id; direction = p.direction; } catch {}
  }
  pendingSanitizations = loadPendingSanitizations();

  document.getElementById('fr-logout-btn').onclick           = doLogout;
  document.getElementById('fr-scan-btn').onclick             = () => openScanModal('confirm');
  document.getElementById('fr-adhoc-btn').onclick            = () => openScanModal('adhoc');
  document.getElementById('fr-map-btn').onclick              = toggleMapView;
  document.getElementById('fr-next-banner').onclick          = showProgressOverlay;
  document.getElementById('fr-progress-close').onclick       = hideProgressOverlay;
  document.getElementById('fr-sanitize-quick').onclick       = (e) => { e.stopPropagation(); confirmSanitizeAll(); };
  document.getElementById('fr-sanitize-banner-body').onclick = showSanitizeOverlay;
  document.getElementById('fr-sanitize-close').onclick       = hideSanitizeOverlay;
  document.getElementById('fr-sanitize-all-btn').onclick     = confirmSanitizeAll;
  document.getElementById('fr-flag-all-btn').onclick         = flagAll;

  if (direction) {
    applyDirection(direction);
    renderSanitizeBanner();
    await loadRoute();
  } else {
    await showDirectionPicker();
  }
}

// ── Direction picker ──────────────────────────────────────────────────────────

async function showDirectionPicker() {
  const overlay = document.getElementById('fr-direction-overlay');
  overlay.style.display = 'flex';
  document.getElementById('fr-scan-bar').style.display        = 'none';
  document.getElementById('fr-next-banner').style.display     = 'none';
  document.getElementById('fr-sanitize-banner').style.display = 'none';
  document.getElementById('fr-body').innerHTML = '';

  const claimedByMap = {};
  try {
    const res  = await apiFetch('/api/fill/direction-status');
    const data = await res.json();
    (data.claims || []).forEach(c => { claimedByMap[c.direction] = c.user_name; });
  } catch {}

  const ascTaken  = 'asc'  in claimedByMap;
  const descTaken = 'desc' in claimedByMap;

  overlay.innerHTML = `
    <div class="fr-pick-title">Choose your route direction</div>
    <div class="fr-pick-sub">Pick the direction your truck will travel today.</div>
    <div class="fr-dir-cards">
      <div class="fr-dir-card ${ascTaken ? 'taken' : ''}" data-dir="asc">
        <div class="fr-dir-card-icon">→</div>
        <div class="fr-dir-card-label">Clockwise</div>
        <div class="fr-dir-card-desc">Route A → Z<br>Low stop numbers first</div>
        ${ascTaken ? `<div class="fr-dir-card-taken">Taken by ${escHtml(claimedByMap.asc ?? 'other crew')}</div>` : ''}
      </div>
      <div class="fr-dir-card ${descTaken ? 'taken' : ''}" data-dir="desc">
        <div class="fr-dir-card-icon">←</div>
        <div class="fr-dir-card-label">Counterclockwise</div>
        <div class="fr-dir-card-desc">Route Z → A<br>High stop numbers first</div>
        ${descTaken ? `<div class="fr-dir-card-taken">Taken by ${escHtml(claimedByMap.desc ?? 'other crew')}</div>` : ''}
      </div>
    </div>
  `;
  overlay.querySelectorAll('.fr-dir-card:not(.taken)').forEach(card => {
    card.addEventListener('click', () => claimDirection(card.dataset.dir));
  });
}

async function claimDirection(dir) {
  const overlay = document.getElementById('fr-direction-overlay');
  overlay.innerHTML = `<div class="fr-pick-title">Starting ${dir === 'asc' ? 'Clockwise →' : '← Counterclockwise'} route…</div>`;
  try {
    const res  = await apiFetch('/api/fill/claim-direction', 'POST', { direction: dir });
    const data = await res.json();
    if (!res.ok) { await showDirectionPicker(); return; }
    claimId = data.claim_id; direction = dir;
    localStorage.setItem(CLAIM_KEY, JSON.stringify({ id: claimId, direction }));
    overlay.style.display = 'none';
    document.getElementById('fr-scan-bar').style.display = '';
    applyDirection(direction);
    renderSanitizeBanner();
    await loadRoute();
  } catch {
    overlay.innerHTML = `
      <div class="fr-pick-title">Network error</div>
      <div class="fr-pick-sub">Could not claim direction — check connection.</div>
      <button class="btn" onclick="location.reload()">Retry</button>
    `;
  }
}

function applyDirection(dir) {
  direction = dir;
  document.getElementById('dir-asc') ?.classList.toggle('active', dir === 'asc');
  document.getElementById('dir-desc')?.classList.toggle('active', dir === 'desc');
}

// ── Route loading ─────────────────────────────────────────────────────────────

async function loadRoute() {
  const body = document.getElementById('fr-body');
  if (!stops.length) body.innerHTML = '<div class="fr-empty">Loading route…</div>';
  try {
    const res  = await apiFetch(`/api/fill-route?direction=${direction}`);
    const data = await res.json();
    stops = data.stops || [];
    initStopStatuses(stops);
    renderRoute();
    renderNextStopBanner();
    renderSanitizeBanner();
  } catch {
    body.innerHTML = '<div class="fr-empty">Failed to load route — check connection.</div>';
  }
}

// ── Route list ────────────────────────────────────────────────────────────────

function renderRoute() {
  const body = document.getElementById('fr-body');
  if (stops.length === 0 && allStops.length === 0) {
    body.innerHTML = `<div class="fr-empty">No pending fill requests on the ${direction === 'asc' ? 'clockwise →' : '← counterclockwise'} route.</div>`;
    return;
  }
  if (stops.length === 0) {
    body.innerHTML = '<div class="fr-empty">All stops on this route are complete.</div>';
    return;
  }

  body.innerHTML = stops.map((s, i) => {
    const status = stopStatuses.get(s.cube_qr) ?? 'pending';
    const isNext = i === getNextStopIndex();
    return `
      <div class="fr-stop" data-qr="${escAttr(s.cube_qr)}" data-index="${i}"
           style="${status === 'skipped' ? 'opacity:.4;' : ''}">
        <div class="fr-stop-pos" style="${isNext ? 'background:var(--accent);color:#fff;' : ''}">${s.route_position ?? '?'}</div>
        <div class="fr-stop-info">
          <div class="fr-stop-entity">${escHtml(s.entity_name)}</div>
          <div class="fr-stop-cube">${escHtml(s.cube_label)}</div>
          <div class="fr-stop-fills">${s.fills_remaining} fill${s.fills_remaining !== 1 ? 's' : ''} requested</div>
        </div>
        <div class="fr-stop-actions">
          <button class="fr-fill-btn" data-qr="${escAttr(s.cube_qr)}" data-index="${i}"
            ${status === 'skipped' ? 'disabled style="opacity:.4"' : ''}>Fill ✓</button>
          <button class="fr-skip-btn" data-qr="${escAttr(s.cube_qr)}" data-index="${i}"
            ${status === 'skipped' ? 'style="display:none"' : ''}>Skip</button>
        </div>
      </div>`;
  }).join('');

  body.querySelectorAll('.fr-fill-btn:not([disabled])').forEach(btn => {
    btn.onclick = () => confirmFillByQr(btn.dataset.qr, +btn.dataset.index);
  });
  body.querySelectorAll('.fr-skip-btn').forEach(btn => {
    btn.onclick = () => skipStop(btn.dataset.qr);
  });
}

// ── Banners ───────────────────────────────────────────────────────────────────

function renderNextStopBanner() {
  const banner = document.getElementById('fr-next-banner');
  const next   = getNextStop();
  if (!next || stops.length === 0) { banner.style.display = 'none'; return; }
  banner.style.display = 'flex';
  document.getElementById('fr-next-banner-stop').textContent = next.entity_name;
  document.getElementById('fr-next-banner-meta').textContent = `Stop #${next.route_position ?? '?'} · ${next.cube_label}`;
}

function renderSanitizeBanner() {
  const banner  = document.getElementById('fr-sanitize-banner');
  const countEl = document.getElementById('fr-sanitize-banner-count');
  const body    = document.getElementById('fr-body');
  const n       = pendingSanitizations.length;

  const mapContainer = document.getElementById('fr-map-container');
  if (n === 0) {
    banner.style.display = 'none';
    body?.classList.remove('has-sanitize-banner');
    mapContainer?.classList.remove('has-sanitize-banner');
    return;
  }
  banner.style.display = 'flex';
  body?.classList.add('has-sanitize-banner');
  mapContainer?.classList.add('has-sanitize-banner');

  const entityNames = [...new Set(pendingSanitizations.map(p => p.entity_name))];
  const label = entityNames.length <= 2
    ? entityNames.join(' & ')
    : `${entityNames[0]} +${entityNames.length - 1} more`;
  countEl.textContent = `${n} fill${n !== 1 ? 's' : ''} pending sanitation — ${label}`;
}

// ── Sanitize overlay ──────────────────────────────────────────────────────────

function showSanitizeOverlay() {
  const overlay = document.getElementById('fr-sanitize-overlay');
  const list    = document.getElementById('fr-sanitize-list');
  const sub     = document.getElementById('fr-sanitize-sub');
  const n       = pendingSanitizations.length;

  sub.textContent = `${n} fill${n !== 1 ? 's' : ''} delivered — tap each to confirm or flag`;

  list.innerHTML = pendingSanitizations.map((p, i) => `
    <div class="fr-sanitize-item" data-index="${i}">
      <div class="fr-sanitize-item-info">
        <div class="fr-sanitize-item-entity">${escHtml(p.entity_name)}</div>
        <div class="fr-sanitize-item-cube">${escHtml(p.cube_label)}</div>
        <div class="fr-sanitize-item-time">${formatTime(p.delivered_at)}</div>
      </div>
      <div class="fr-sanitize-item-actions">
        <button class="fr-san-ok"   data-index="${i}">Sanitized ✓</button>
        <button class="fr-san-flag" data-index="${i}">Flag ✗</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.fr-san-ok').forEach(btn => {
    btn.onclick = () => sanitizeSingle(+btn.dataset.index, false);
  });
  list.querySelectorAll('.fr-san-flag').forEach(btn => {
    btn.onclick = () => promptFlagSingle(+btn.dataset.index);
  });

  overlay.style.display = 'flex';
}

function hideSanitizeOverlay() {
  document.getElementById('fr-sanitize-overlay').style.display = 'none';
}

// ── Sanitize actions ──────────────────────────────────────────────────────────

async function confirmSanitizeAll() {
  if (!pendingSanitizations.length) return;
  const ids = pendingSanitizations.map(p => p.cube_id);
  try {
    const res  = await apiFetch('/api/fill/sanitize', 'POST', { cube_item_ids: ids });
    const data = await res.json();
    if (res.ok && data.success) {
      const n = pendingSanitizations.length;
      pendingSanitizations = []; savePendingSanitizations();
      renderSanitizeBanner(); hideSanitizeOverlay();
      showToast(`${n} fill${n !== 1 ? 's' : ''} confirmed sanitized ✓`);
    } else { showScanError(data.error || 'Sanitize failed'); }
  } catch { showScanError('Network error'); }
}

async function sanitizeSingle(index, flagged, notes = '') {
  const item = pendingSanitizations[index];
  if (!item) return;
  try {
    const res  = await apiFetch('/api/fill/sanitize', 'POST', {
      cube_item_ids: [item.cube_id], flagged, notes: notes || undefined,
    });
    const data = await res.json();
    if (res.ok && data.success) {
      pendingSanitizations.splice(index, 1); savePendingSanitizations();
      renderSanitizeBanner();
      if (pendingSanitizations.length === 0) hideSanitizeOverlay();
      else showSanitizeOverlay();
    } else { showScanError(data.error || 'Sanitize failed'); }
  } catch { showScanError('Network error'); }
}

function promptFlagSingle(index) {
  const item = pendingSanitizations[index];
  if (!item) return;
  const row     = document.querySelector(`.fr-sanitize-item[data-index="${index}"]`);
  if (!row) return;
  const actions = row.querySelector('.fr-sanitize-item-actions');
  actions.innerHTML = `
    <textarea id="flag-note-${index}" placeholder="Reason…"
      style="width:130px;height:48px;padding:5px;font-size:12px;font-family:Georgia,serif;
             border:0.5px solid var(--warn-border);border-radius:var(--radius);
             background:var(--surface);color:var(--text);resize:none"></textarea>
    <div style="display:flex;gap:.25rem;margin-top:.2rem">
      <button class="fr-san-flag" id="flag-confirm-${index}">Flag</button>
      <button class="fr-san-ok" id="flag-cancel-${index}"
        style="background:var(--surface);color:var(--text2);border-color:var(--border-med)">✕</button>
    </div>
  `;
  document.getElementById(`flag-confirm-${index}`).onclick = () =>
    sanitizeSingle(index, true, document.getElementById(`flag-note-${index}`)?.value?.trim() ?? '');
  document.getElementById(`flag-cancel-${index}`).onclick = showSanitizeOverlay;
}

async function flagAll() {
  const modal = document.getElementById('fr-scan-modal');
  const n     = pendingSanitizations.length;
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="fr-scan-modal-inner">
      <div class="fr-scan-modal-title">Flag all ${n} fill${n !== 1 ? 's' : ''}</div>
      <textarea id="flag-all-note" placeholder="Reason for flagging all…"
        style="width:100%;height:60px;padding:8px;font-family:Georgia,serif;font-size:13px;
               border:0.5px solid var(--warn-border);border-radius:var(--radius);
               background:var(--surface);color:var(--text);resize:none"></textarea>
      <div style="display:flex;gap:.5rem;margin-top:.75rem">
        <button class="btn secondary" id="flag-all-confirm">Flag all</button>
        <button class="btn secondary" id="flag-all-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.getElementById('flag-all-cancel').onclick = () => { modal.style.display = 'none'; modal.innerHTML = ''; };
  document.getElementById('flag-all-confirm').onclick = async () => {
    const notes = document.getElementById('flag-all-note')?.value?.trim() ?? '';
    const ids   = pendingSanitizations.map(p => p.cube_id);
    modal.style.display = 'none'; modal.innerHTML = '';
    try {
      const res  = await apiFetch('/api/fill/sanitize', 'POST', { cube_item_ids: ids, flagged: true, notes });
      const data = await res.json();
      if (res.ok && data.success) {
        pendingSanitizations = []; savePendingSanitizations();
        renderSanitizeBanner(); hideSanitizeOverlay();
        showToast(`${n} fill${n !== 1 ? 's' : ''} flagged`);
      } else { showScanError(data.error || 'Flag failed'); }
    } catch { showScanError('Network error'); }
  };
}

// ── Confirm fill ──────────────────────────────────────────────────────────────

async function confirmFillByQr(cube_qr, indexHint) {
  const idx = (indexHint !== null && indexHint !== undefined && stops[indexHint]?.cube_qr === cube_qr)
    ? indexHint
    : stops.findIndex(s => s.cube_qr === cube_qr);

  if (idx === -1) { showScanError('No pending fill request for this cube.'); return; }

  // Entity-change check
  if (pendingSanitizations.length > 0) {
    const lastEntityId    = pendingSanitizations[pendingSanitizations.length - 1].entity_id;
    const scannedEntityId = stops[idx]?.entity_id;
    if (scannedEntityId && scannedEntityId !== lastEntityId) {
      showEntityChangePrompt(cube_qr, idx, getNextStopIndex());
      return;
    }
  }

  // Out-of-order check
  const nextIdx = getNextStopIndex();
  if (nextIdx !== -1 && idx !== nextIdx) {
    showOutOfOrderWarning(cube_qr, idx, nextIdx);
    return;
  }

  await doConfirmFill(cube_qr, idx);
}

async function doConfirmFill(cube_qr, idx) {
  try {
    const res  = await apiFetch('/api/fill/confirm', 'POST', { cube_qr });
    const data = await res.json();
    if (res.ok && data.success) {
      pendingSanitizations.push({
        cube_id:     data.cube_id,
        cube_qr:     data.cube_qr,
        cube_label:  data.cube_label,
        entity_id:   data.entity_id,
        entity_name: data.entity_name,
        delivered_at: new Date().toISOString(),
      });
      savePendingSanitizations();
      stopStatuses.set(cube_qr, 'filled');
      markStopDone(idx);
      showFillDelivered(data.cube_label, data.entity_name, data.fills_remaining);
    } else { showScanError(data.error || 'Could not confirm fill.'); }
  } catch { showScanError('Network error — try again.'); }
}

function markStopDone(index) {
  stops.splice(index, 1);
  const el = document.querySelector(`.fr-stop[data-index="${index}"]`);
  if (el) {
    el.classList.add('completing');
    setTimeout(() => {
      renderRoute(); renderNextStopBanner(); renderSanitizeBanner();
      if (mapView) renderMapMarkers();
    }, 350);
  } else {
    renderRoute(); renderNextStopBanner(); renderSanitizeBanner();
    if (mapView) renderMapMarkers();
  }
}

function skipStop(cube_qr) {
  stopStatuses.set(cube_qr, 'skipped');
  renderRoute(); renderNextStopBanner();
  if (mapView) renderMapMarkers();
}

// ── Entity-change prompt ──────────────────────────────────────────────────────

function showEntityChangePrompt(cube_qr, idx, nextIdx) {
  const n          = pendingSanitizations.length;
  const entityList = pendingSanitizations
    .map(p => `<li style="margin:.1rem 0">${escHtml(p.cube_label)} — ${escHtml(p.entity_name)}</li>`)
    .join('');

  const modal = document.getElementById('fr-scan-modal');
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="fr-scan-modal-inner">
      <div class="fr-scan-modal-title">Before continuing…</div>
      <div class="fr-adhoc-card" style="margin-bottom:.75rem">
        <div class="fr-adhoc-card-title">${n} fill${n !== 1 ? 's' : ''} pending sanitation</div>
        <div class="fr-adhoc-card-body">
          <ul style="margin:.4rem 0 .5rem 1rem;padding:0">${entityList}</ul>
          Did you sanitize ${n === 1 ? 'it' : 'them'} before moving on?
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:.4rem">
        <button class="btn"           id="ech-yes">Yes — confirm sanitized, then continue</button>
        <button class="btn secondary" id="ech-no">Not yet — continue without sanitizing</button>
        <button class="btn secondary" id="ech-review">Review each fill</button>
      </div>
    </div>
  `;

  document.getElementById('ech-review').onclick = () => {
    modal.style.display = 'none'; modal.innerHTML = ''; showSanitizeOverlay();
  };
  document.getElementById('ech-no').onclick = async () => {
    modal.style.display = 'none'; modal.innerHTML = '';
    await proceedWithFill(cube_qr, idx, nextIdx);
  };
  document.getElementById('ech-yes').onclick = async () => {
    modal.style.display = 'none'; modal.innerHTML = '';
    const ids = pendingSanitizations.map(p => p.cube_id);
    try {
      await apiFetch('/api/fill/sanitize', 'POST', { cube_item_ids: ids });
      pendingSanitizations = []; savePendingSanitizations(); renderSanitizeBanner();
    } catch {}
    await proceedWithFill(cube_qr, idx, nextIdx);
  };
}

async function proceedWithFill(cube_qr, idx, nextIdx) {
  if (nextIdx !== -1 && idx !== nextIdx) showOutOfOrderWarning(cube_qr, idx, nextIdx);
  else await doConfirmFill(cube_qr, idx);
}

// ── Out-of-order warning ──────────────────────────────────────────────────────

function showOutOfOrderWarning(cube_qr, scannedIdx, nextIdx) {
  const scanned   = stops[scannedIdx];
  const next      = stops[nextIdx];
  const skipCount = scannedIdx - nextIdx;

  const modal = document.getElementById('fr-scan-modal');
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="fr-scan-modal-inner">
      <div class="fr-scan-modal-title">Stop out of order</div>
      <div class="fr-adhoc-card">
        <div class="fr-adhoc-card-title">Not the expected next stop</div>
        <div class="fr-adhoc-card-body">
          You scanned <b>stop #${scanned.route_position ?? '?'} — ${escHtml(scanned.entity_name)}</b>.<br>
          Expected next: <b>stop #${next.route_position ?? '?'} — ${escHtml(next.entity_name)}</b>.
          ${skipCount > 0 ? `<br><br>${skipCount} stop${skipCount !== 1 ? 's' : ''} before this will be marked as skipped.` : ''}
        </div>
      </div>
      <div style="display:flex;gap:.5rem;margin-top:.75rem">
        <button class="btn" id="ooo-confirm">Fill anyway</button>
        <button class="btn secondary" id="ooo-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.getElementById('ooo-cancel').onclick = () => { modal.style.display = 'none'; modal.innerHTML = ''; };
  document.getElementById('ooo-confirm').onclick = async () => {
    modal.style.display = 'none'; modal.innerHTML = '';
    for (let i = nextIdx; i < scannedIdx; i++) {
      const s = stops[i];
      if (s && stopStatuses.get(s.cube_qr) === 'pending') stopStatuses.set(s.cube_qr, 'skipped');
    }
    renderRoute(); renderNextStopBanner();
    await doConfirmFill(cube_qr, scannedIdx);
  };
}

// ── Progress overlay ──────────────────────────────────────────────────────────

function showProgressOverlay() {
  const overlay = document.getElementById('fr-progress-overlay');
  document.getElementById('fr-progress-title').textContent =
    `Route — ${direction === 'asc' ? 'Clockwise →' : '← Counterclockwise'}`;
  document.getElementById('fr-progress-sub').textContent =
    `${filledCount()} filled · ${pendingCount()} remaining${skippedCount() ? ` · ${skippedCount()} skipped` : ''}`;

  const nextQr = getNextStop()?.cube_qr;
  const sorted = [...allStops].sort((a, b) =>
    direction === 'asc'
      ? (a.route_position ?? 9999) - (b.route_position ?? 9999)
      : (b.route_position ?? -1)   - (a.route_position ?? -1)
  );

  document.getElementById('fr-progress-list').innerHTML = sorted.map(s => {
    const status      = stopStatuses.get(s.cube_qr) ?? 'pending';
    const isNext      = s.cube_qr === nextQr;
    const badgeClass  = status === 'filled' ? 'filled' : status === 'skipped' ? 'skipped' : isNext ? 'next' : 'upcoming';
    const badgeContent= status === 'filled' ? '✓' : status === 'skipped' ? '↷' : isNext ? '→' : String(s.route_position ?? '?');
    const tag = isNext ? '<span class="fr-progress-stop-tag next">Next</span>'
      : status === 'skipped' ? '<span class="fr-progress-stop-tag skipped">Skipped</span>' : '';
    return `
      <div class="fr-progress-stop">
        <div class="fr-progress-badge ${badgeClass}">${badgeContent}</div>
        <div class="fr-progress-stop-info">
          <div class="fr-progress-stop-entity ${status}">${escHtml(s.entity_name)}</div>
          <div class="fr-progress-stop-cube">${escHtml(s.cube_label)}</div>
        </div>${tag}
      </div>`;
  }).join('') || '<div style="color:var(--text3);text-align:center;padding:2rem;font-size:14px">No stops yet</div>';

  overlay.style.display = 'flex';
}

function hideProgressOverlay() {
  document.getElementById('fr-progress-overlay').style.display = 'none';
}

// ── Ad-hoc fill (sticker fallback, records delivery+sanitation together) ──────

async function confirmAdhocByQr(cube_qr) {
  const modal = document.getElementById('fr-scan-modal');
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="fr-scan-modal-inner">
      <div class="fr-scan-modal-title">Confirm sticker fill</div>
      <div class="fr-adhoc-card">
        <div class="fr-adhoc-card-title">No digital request</div>
        <div class="fr-adhoc-card-body">No pending request found. Use when a sticker is present.
          Records delivery and sanitation together. A credit will be used if available.</div>
      </div>
      <div style="font-size:13px;color:var(--text2);margin-bottom:.75rem">Cube: <b id="adhoc-lbl">looking up…</b></div>
      <textarea id="adhoc-notes" placeholder="Notes (sticker colour, reason…)"
        style="width:100%;height:60px;padding:8px;font-family:Georgia,serif;font-size:13px;
               border:0.5px solid var(--border-med);border-radius:var(--radius);
               background:var(--surface);color:var(--text);resize:none"></textarea>
      <div style="display:flex;gap:.5rem;margin-top:.75rem">
        <button class="btn" id="adhoc-confirm">Confirm fill</button>
        <button class="btn secondary" id="adhoc-cancel">Cancel</button>
      </div>
    </div>
  `;
  try {
    const r = await fetch(`/api/water/cube-status?qr=${encodeURIComponent(cube_qr)}`);
    const d = await r.json();
    const el = document.getElementById('adhoc-lbl');
    if (el) el.textContent = d.cube_label ?? cube_qr;
  } catch {}

  document.getElementById('adhoc-cancel').onclick = closeScanModal;
  document.getElementById('adhoc-confirm').onclick = async () => {
    const notes = document.getElementById('adhoc-notes')?.value?.trim() ?? '';
    try {
      const res  = await apiFetch('/api/fill/confirm-adhoc', 'POST', { cube_qr, notes });
      const data = await res.json();
      if (res.ok && data.success) {
        closeScanModal();
        showToast(`Ad-hoc fill logged — ${data.cube_label}`);
        loadRoute();
      } else { showScanError(data.error || 'Could not confirm fill.'); }
    } catch { showScanError('Network error.'); }
  };
}

// ── Scanner modal ─────────────────────────────────────────────────────────────

function openScanModal(mode) {
  const modal = document.getElementById('fr-scan-modal');
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="fr-scan-modal-inner">
      <div class="fr-scan-modal-title">${mode === 'adhoc' ? 'Scan cube (sticker fill)' : 'Scan cube to confirm fill'}</div>
      <div class="fr-scan-video-wrap">
        <video id="fr-scan-video" playsinline muted></video>
        <div class="fr-scan-overlay"><div class="fr-scan-frame"><div class="fr-scan-line"></div></div></div>
      </div>
      <div class="fr-scan-status" id="fr-scan-status">Aim camera at the cube QR code</div>
      <button class="btn secondary" id="fr-scan-close" style="margin-top:.5rem">Cancel</button>
    </div>
  `;
  document.getElementById('fr-scan-close').onclick = closeScanModal;
  const video = document.getElementById('fr-scan-video');
  scanner = new Scanner(video, (qr) => {
    closeScanModal(false);
    if (mode === 'adhoc') confirmAdhocByQr(qr);
    else confirmFillByQr(qr, null);
  });
  scanner.start().catch(() => {
    const s = document.getElementById('fr-scan-status');
    if (s) s.textContent = 'Camera unavailable';
  });
}

function closeScanModal(clearScanner = true) {
  if (clearScanner && scanner) { scanner.stop(); scanner = null; }
  const modal = document.getElementById('fr-scan-modal');
  modal.style.display = 'none'; modal.innerHTML = '';
}

// ── Logout ────────────────────────────────────────────────────────────────────

async function doLogout() {
  if (claimId) {
    try { await apiFetch('/api/fill/release-direction', 'POST', { claim_id: claimId }); } catch {}
    localStorage.removeItem(CLAIM_KEY);
  }
  // Intentionally keep SANITIZE_KEY — if crew logs back in they can still confirm sanitation
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  window.location.href = '/login.html';
}

// ── Feedback ──────────────────────────────────────────────────────────────────

function showFillDelivered(cubeLabel, entityName, fillsRemaining) {
  const body = document.getElementById('fr-body');
  const el   = document.createElement('div');
  el.className = 'fr-confirm-card';
  el.innerHTML = `
    <div class="fr-confirm-card-title">Fill delivered ✓</div>
    <div class="fr-confirm-card-body">
      ${escHtml(cubeLabel)} — ${escHtml(entityName ?? '—')}
      ${fillsRemaining !== null && fillsRemaining !== undefined
        ? `<br>${fillsRemaining} fill${fillsRemaining !== 1 ? 's' : ''} remaining for this entity`
        : ''}
      <br><span style="font-size:11px;opacity:.65">Sanitize using the amber banner above when ready</span>
    </div>
  `;
  body.prepend(el);
  setTimeout(() => el.remove(), 5000);
}

function showToast(msg) {
  const body = document.getElementById('fr-body');
  const el   = document.createElement('div');
  el.style.cssText = 'background:var(--accent-light);border:0.5px solid var(--accent);border-radius:var(--radius-lg);padding:.75rem 1rem;margin-bottom:.75rem;font-size:13px;color:var(--accent-text)';
  el.textContent = msg;
  body.prepend(el);
  setTimeout(() => el.remove(), 4000);
}

function showScanError(msg) {
  const stat = document.getElementById('fr-scan-status');
  if (stat) {
    stat.textContent = msg; stat.style.color = 'var(--warn)';
    setTimeout(() => { stat.style.color = ''; stat.textContent = 'Aim camera at the cube QR code'; }, 3000);
    return;
  }
  const body = document.getElementById('fr-body');
  const el   = document.createElement('div');
  el.style.cssText = 'background:var(--warn-bg);border:0.5px solid var(--warn-border);border-radius:var(--radius-lg);padding:.75rem 1rem;margin-bottom:.75rem;font-size:13px;color:var(--warn)';
  el.textContent = msg;
  body.prepend(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function apiFetch(path, method = 'GET', body = null) {
  const opts = { method, credentials: 'include', headers: { 'X-CSRF-Token': csrfToken || '' } };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  return fetch(path, opts);
}

function formatTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(str) { return String(str ?? '').replace(/"/g,'&quot;'); }

// ── Map view ──────────────────────────────────────────────────────────────────

function toggleMapView() {
  mapView = !mapView;
  const mapContainer = document.getElementById('fr-map-container');
  const listBody     = document.getElementById('fr-body');
  const btn          = document.getElementById('fr-map-btn');

  mapContainer.style.display = mapView ? 'block' : 'none';
  listBody.style.display     = mapView ? 'none'  : '';
  btn.classList.toggle('active', mapView);

  if (mapView) {
    _ensureMap();
    renderMapMarkers();
    _startGpsTracking();
  } else {
    _stopGpsTracking();
  }
}

function _ensureMap() {
  if (leafletMap) { leafletMap.invalidateSize(); return; }
  // eslint-disable-next-line no-undef
  leafletMap = L.map('fr-map', { zoomControl: true, attributionControl: false });
  // Base tile layer disabled — OSM was returning 403s (referrer required) in this
  // deployment. The site map KML overlay stands in as the visual reference for now.
  renderSiteOverlay(leafletMap);
}

function _stopIcon(status, isNext, routePos) {
  const color = isNext     ? '#1d6ef5'
    : status === 'filled'  ? '#16a34a'
    : status === 'skipped' ? '#d97706'
    : '#6b7280';
  const size  = isNext ? 28 : 22;
  const label = isNext ? '→' : (routePos ?? '?');
  // eslint-disable-next-line no-undef
  return L.divIcon({
    html: `<div style="
      width:${size}px;height:${size}px;background:${color};
      border:2px solid #fff;border-radius:50%;
      box-shadow:0 2px 6px rgba(0,0,0,.45);
      display:flex;align-items:center;justify-content:center;
      font-size:${isNext?12:10}px;color:#fff;font-weight:bold;
      font-family:-apple-system,sans-serif;
    ">${label}</div>`,
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2 + 4)],
  });
}

function renderMapMarkers() {
  if (!leafletMap) return;

  // Clear old markers
  mapMarkers.forEach(m => m.remove());
  mapMarkers.clear();

  const stopsWithCoords = allStops.filter(s => s.latitude != null && s.longitude != null);

  if (!stopsWithCoords.length) {
    // Show a no-coords message overlay on the map div
    let msg = document.getElementById('fr-map-no-coords');
    if (!msg) {
      msg = document.createElement('div');
      msg.id = 'fr-map-no-coords';
      msg.className = 'fr-map-no-coords';
      msg.innerHTML = 'No GPS coordinates set for cubes yet.<br><span style="font-size:12px;opacity:.7">Add coordinates via Admin → Equipment → Items.</span>';
      document.getElementById('fr-map').appendChild(msg);
    }
    return;
  }
  document.getElementById('fr-map-no-coords')?.remove();

  const nextQr  = getNextStop()?.cube_qr;
  const bounds  = [];

  stopsWithCoords.forEach(s => {
    const status = stopStatuses.get(s.cube_qr) ?? 'pending';
    const isNext = s.cube_qr === nextQr;
    const icon   = _stopIcon(status, isNext, s.route_position);
    const latlng = [s.latitude, s.longitude];
    bounds.push(latlng);

    const fillsLabel = `${s.fills_remaining} fill${s.fills_remaining !== 1 ? 's' : ''} requested`;
    const fillBtn = (status === 'pending')
      ? `<br><button data-qr="${s.cube_qr.replace(/"/g, '&quot;')}" class="fr-map-fill-popup"
           style="margin-top:6px;padding:4px 14px;background:#2a5f3f;color:#fff;
                  border:none;border-radius:4px;cursor:pointer;font-size:12px">Fill ✓</button>`
      : '';

    // eslint-disable-next-line no-undef
    const marker = L.marker(latlng, { icon })
      .addTo(leafletMap)
      .bindPopup(`
        <b style="font-size:13px">${escHtml(s.entity_name)}</b><br>
        <span style="font-size:11px;color:#666">${escHtml(s.cube_label)}</span><br>
        <span style="font-size:11px;color:#666">${fillsLabel}</span>
        ${fillBtn}
      `);

    marker.on('popupopen', () => {
      document.querySelectorAll('.fr-map-fill-popup').forEach(btn => {
        btn.onclick = () => {
          leafletMap.closePopup();
          confirmFillByQr(btn.dataset.qr, null);
        };
      });
    });

    mapMarkers.set(s.cube_qr, marker);
  });

  if (bounds.length === 1) {
    leafletMap.setView(bounds[0], 16);
  } else if (bounds.length > 1) {
    // eslint-disable-next-line no-undef
    leafletMap.fitBounds(bounds, { padding: [48, 48] });
  }
}

function _startGpsTracking() {
  if (!navigator.geolocation || gpsWatchId !== null) return;
  gpsWatchId = navigator.geolocation.watchPosition(
    pos => {
      if (!leafletMap) return;
      const latlng = [pos.coords.latitude, pos.coords.longitude];
      if (userMarker) {
        userMarker.setLatLng(latlng);
      } else {
        // eslint-disable-next-line no-undef
        const icon = L.divIcon({
          html: `<div style="
            width:14px;height:14px;background:#3b82f6;
            border:2px solid #fff;border-radius:50%;
            box-shadow:0 0 0 5px rgba(59,130,246,.25);
          "></div>`,
          className: '',
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        });
        // eslint-disable-next-line no-undef
        userMarker = L.marker(latlng, { icon, zIndexOffset: 1000 })
          .addTo(leafletMap)
          .bindTooltip('You', { permanent: false, direction: 'top' });
      }
    },
    null,
    { enableHighAccuracy: true, maximumAge: 5000 }
  );
}

function _stopGpsTracking() {
  if (gpsWatchId !== null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
  if (userMarker && leafletMap) {
    userMarker.remove();
    userMarker = null;
  }
}

boot();
