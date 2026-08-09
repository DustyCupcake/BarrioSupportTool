/**
 * Unified order-independent scanner — the single lending/return flow.
 * Handles checkout sessions (production/dept/group/person), checkin
 * (including location-requirement and person-transfer), voucher
 * activate/validate, and info lookups from one scanning interface.
 *
 * Session state persists across tab switches so a user can navigate away
 * and return without losing scanned items.
 */

import { get, post, put } from './api.js?v=1.0.1';
import { Scanner, scanFeedbackSuccess, scanFeedbackError } from './scanner.js?v=1.0.1';
import { renderScanResult } from './scan-result.js?v=1.0.2';

// Persistent session state (survives tab switches)
let _session          = null;   // { entity, items, mode }
let _toast            = null;
let _onTabSwitch      = null;
let _updateBanner     = null;
let _requireIdentity  = null;
let _onIdentityResolved = null;
let _user             = null;
let _container        = null;
let _scanner          = null;   // Scanner instance
let _identityMode     = false;  // true when scanner is open to scan a badge for auth
let _awaitingLocation = null;   // { itemQr, item } — next scan is a location QR for a checkin in progress

export function getSession() { return _session; }

export function destroy() {
  _scanner?.stop();
  _scanner = null;
  _awaitingLocation = null;
}

export function init(container, user, { extra = null, onTabSwitch, toast, updateBannerFn,
    requireIdentityFn, onIdentityResolvedFn } = {}) {
  _container          = container;
  _user               = user;
  _toast              = toast;
  _onTabSwitch        = onTabSwitch;
  _updateBanner       = updateBannerFn;
  _requireIdentity    = requireIdentityFn;
  _onIdentityResolved = onIdentityResolvedFn;
  _identityMode       = extra?.identityMode ?? false;
  _awaitingLocation   = null;

  // Start a fresh session if none exists
  if (!_session) {
    _session = { entity: null, items: [], mode: 'scanning' };
  }

  // Handle extra context passed in (pre-load entity or item from deep link)
  if (extra?.entity) {
    _session.entity = extra.entity;
    _groupDetail = null;
  }
  if (extra?.mode === 'confirm') {
    _session.mode = 'confirm';
  }
  if (extra?.preload?.qr) {
    // Will be looked up and handled after render
    renderScanning(container);
    handleLookup(extra.preload.qr);
    return;
  }

  renderMode(container);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderMode(container) {
  switch (_session.mode) {
    case 'scanning':      renderScanning(container);    break;
    case 'confirm':       renderConfirm(container);     break;
    case 'entity-select': renderEntitySelect(container); break;
  }
}

function renderScanning(container) {
  const items = _session.items;
  const entity = _session.entity;

  container.innerHTML = `
    <div style="position:relative">
      <div id="scanner-video-wrap" style="position:relative;background:#000;overflow:hidden;
        border-radius:0;width:100%;aspect-ratio:1">
        <video id="scanner-video" autoplay playsinline muted
          style="width:100%;height:100%;display:block;object-fit:cover"></video>
        <div id="scan-hint" style="position:absolute;bottom:12px;left:0;right:0;text-align:center;
          color:#fff;font-size:13px;text-shadow:0 1px 3px rgba(0,0,0,.7);pointer-events:none">
          ${_identityMode ? 'Scan your badge to continue' : (entity ? `Scanning items for <strong>${esc(entity.name)}</strong>` : 'Scan any QR code')}
        </div>
      </div>

      <div style="padding:1rem">
        ${items.length > 0 ? `
          <div style="margin-bottom:.75rem">
            <div style="font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--text3);margin-bottom:.4rem">
              ${items.length} item${items.length !== 1 ? 's' : ''} scanned
            </div>
            ${items.map((it, i) => `
              <div style="display:flex;align-items:center;justify-content:space-between;
                padding:.4rem 0;border-bottom:0.5px solid var(--border);font-size:14px">
                <span>${esc(it.name)}${it.warn ? `<span class="warn-tag" style="margin-left:.4rem">${esc(it.warn)}</span>` : ''}</span>
                <button onclick="window._scanner.removeItem(${i})"
                  style="background:none;border:none;color:var(--text3);cursor:pointer;
                  font-size:16px;padding:0 4px">×</button>
              </div>`).join('')}
          </div>` : ''}

        <div style="display:flex;gap:.5rem;margin-bottom:.75rem">
          <input id="manual-qr-input" type="text" placeholder="Or type / paste a code…"
            style="flex:1;min-width:0;width:0;font-size:16px;padding:12px 14px;margin-bottom:0"
            autocomplete="off" autocorrect="off" spellcheck="false">
          <button class="btn" style="margin-top:0;width:auto;flex-shrink:0;padding-left:1.25rem;padding-right:1.25rem"
            onclick="window._scanner.manualSubmit()">Go</button>
        </div>

        ${!entity ? `
          <button class="btn" style="width:100%;margin-bottom:.5rem"
            onclick="window._scanner.goEntitySelect()">
            Choose recipient manually
          </button>` : ''}

        ${items.length > 0 ? `
          <button class="btn primary" style="width:100%"
            onclick="window._scanner.done()">
            Done scanning →
          </button>` : ''}
      </div>
    </div>

    <div id="scan-result-overlay" style="display:none;position:fixed;inset:0;z-index:40;
      background:var(--bg);overflow-y:auto;padding:1rem 1rem 3rem">
      <button onclick="window._scanner.closeOverlay()"
        style="background:none;border:none;font-size:22px;color:var(--text2);
        cursor:pointer;margin-bottom:.5rem">←</button>
      <div id="scan-result-inner"></div>
    </div>`;

  window._scanner = {
    removeItem: (i) => { _session.items.splice(i, 1); _updateBanner(); renderMode(_container); },
    manualSubmit: () => {
      const val = document.getElementById('manual-qr-input')?.value.trim();
      if (val) handleLookup(val);
    },
    goEntitySelect: () => { _session.mode = 'entity-select'; renderMode(_container); },
    done: () => {
      if (!_session.entity) { _session.mode = 'entity-select'; renderMode(_container); }
      else { _session.mode = 'confirm'; renderMode(_container); }
    },
    closeOverlay: () => {
      document.getElementById('scan-result-overlay').style.display = 'none';
      resumeCamera();
    },
  };

  document.getElementById('manual-qr-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') window._scanner.manualSubmit();
  });

  if (_awaitingLocation) {
    const hint = document.getElementById('scan-hint');
    if (hint) hint.textContent = 'Scan the storage location QR…';
  }

  startCamera();
}

let _groupDetail      = null;   // fetched for group entities: { enable_arrival_tracking, arrival_status, entitlements, equipment_orders, ... }
let _consumableTypesCache = null;
let _capturedLocation = null;   // { latitude, longitude } from GPS capture during a group checkout
let _deptLabel        = '';

async function loadConsumableTypes() {
  if (_consumableTypesCache) return _consumableTypesCache;
  try {
    const data = await get('/consumable-types');
    _consumableTypesCache = data.types || [];
  } catch { _consumableTypesCache = []; }
  return _consumableTypesCache;
}

async function ensureGroupDetail(container) {
  if (!_session.entity || _session.entity.type !== 'group') return;
  if (_groupDetail && _groupDetail.__id === _session.entity.id) return;
  try {
    const [detail] = await Promise.all([
      get('/groups/' + _session.entity.id),
      loadConsumableTypes(),
    ]);
    _groupDetail = { ...detail.group, __id: _session.entity.id, entitlements: detail.entitlements || [] };
  } catch {
    _groupDetail = null;
  }
  if (_session.mode === 'confirm') renderMode(container);
}

function renderConfirm(container) {
  const { entity, items } = _session;

  if (!entity) {
    _session.mode = 'entity-select';
    renderMode(container);
    return;
  }
  if (items.length === 0) {
    _session.mode = 'scanning';
    renderMode(container);
    return;
  }

  const isGroup = entity.type === 'group';
  if (isGroup) ensureGroupDetail(container); // fires async; re-renders confirm when it lands

  const needsArrival = isGroup && _groupDetail?.__id === entity.id
    && _groupDetail.enable_arrival_tracking && _groupDetail.arrival_status === 'expected';
  // water_fill is excluded here — its real credit ledger is only ever written
  // by the truck confirm/adhoc-fill flow, never by generic arrival distribution
  // (the backend rejects it too; this just keeps it off the form in the first
  // place so staff aren't offered a control that wouldn't do anything).
  const arrivalConsumableTypes = (_consumableTypesCache || []).filter(ct => ct.key_name !== 'water_fill');
  const showEntForm = needsArrival && _groupDetail.enable_consumable_entitlements && arrivalConsumableTypes.length;

  let arrivalForm = '';
  if (showEntForm) {
    const itemInputs = arrivalConsumableTypes.map(ct => {
      const existing  = _groupDetail.entitlements.find(e => e.type_id === ct.id);
      const purchased = existing?.purchased ?? 0;
      const remaining = existing?.remaining ?? purchased;
      const defaultVal = remaining > 0 ? remaining : 0;
      return `
        <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:.5rem">
          <label style="flex:1;font-size:14px;color:var(--text);margin:0">
            ${esc(ct.name)}
            ${purchased > 0 ? `<span style="font-size:12px;color:var(--text3)">(${purchased} purchased)</span>` : ''}
          </label>
          <input type="number" class="arrival-cons-input" data-type-id="${ct.id}"
            min="0" value="${defaultVal}" inputmode="numeric" style="max-width:90px">
        </div>`;
    }).join('');
    arrivalForm = `
      <div class="arrival-form-section">
        <div class="card-label">Record arrival</div>
        ${itemInputs}
        <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text);margin:.25rem 0">
          <input type="checkbox" id="confirm-orientation" style="width:auto;margin:0;accent-color:var(--accent)">
          Orientation completed
        </label>
      </div>`;
  } else if (needsArrival) {
    arrivalForm = `
      <div class="arrival-form-section">
        <div class="card-label">Record arrival</div>
        <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text);margin-bottom:.25rem">
          <input type="checkbox" id="confirm-orientation" style="width:auto;margin:0;accent-color:var(--accent)">
          Orientation completed
        </label>
      </div>`;
  }

  container.innerHTML = `
    <div style="padding:1rem">
      <div style="font-size:17px;font-family:'Georgia',serif;margin-bottom:1rem">
        Lend to <strong>${esc(entity.name)}</strong>
      </div>

      ${needsArrival ? `
        <div class="card arrival-prompt-card">
          <div class="card-label">Group not yet checked in</div>
          <div style="font-size:13px;color:var(--warn)">Arrival will be recorded on confirmation.</div>
        </div>` : ''}

      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.07em;
        color:var(--text3);margin-bottom:.4rem">${items.length} item${items.length !== 1 ? 's' : ''}</div>
      <div style="background:var(--surface);border:0.5px solid var(--border-med);
        border-radius:var(--radius);margin-bottom:1rem">
        ${items.map(it => `
          <div style="display:flex;justify-content:space-between;padding:.6rem .75rem;
            border-bottom:0.5px solid var(--border);font-size:14px">
            <span>${esc(it.name)}${it.warn ? `<span class="warn-tag" style="margin-left:.4rem">${esc(it.warn)}</span>` : ''}</span>
            <span style="color:var(--text3);font-size:12px">${esc(it.qr)}</span>
          </div>`).join('')}
      </div>

      <div class="field" style="margin-bottom:.75rem">
        <label for="confirm-dept-label">Equipment label <span style="font-size:12px;color:var(--text3)">(optional)</span></label>
        <input type="text" id="confirm-dept-label" placeholder="e.g. Generator 1, Sound Team"
               value="${esc(_deptLabel)}" oninput="window._scanner.setLabel(this.value)">
      </div>

      ${isGroup ? `
        <div id="confirm-loc-row" style="display:flex;align-items:center;gap:.75rem;margin-bottom:.5rem">
          <button class="btn btn-sm btn-outline" id="confirm-loc-btn">📍 Capture location</button>
          <span id="confirm-loc-status" style="font-size:13px;color:var(--text3)">Optional</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:.75rem">
          <input type="checkbox" id="confirm-apply-group-loc" checked style="width:auto;margin:0;accent-color:var(--accent)">
          <label for="confirm-apply-group-loc" style="font-size:13px;color:var(--text2)">
            Set item location from ${esc(entity.name)}'s storage location (used if no GPS captured above)
          </label>
        </div>` : ''}

      ${arrivalForm}

      <button class="btn primary" style="width:100%;margin-bottom:.5rem"
        id="confirm-lend-btn">Confirm lend</button>
      <button class="btn" style="width:100%"
        onclick="window._scanner.backToScan()">← Back to scanning</button>
    </div>`;

  window._scanner = {
    backToScan: () => { _session.mode = 'scanning'; renderMode(_container); },
    setLabel: (v) => { _deptLabel = v; },
  };

  if (isGroup) {
    document.getElementById('confirm-loc-btn')?.addEventListener('click', captureConfirmLocation);
  }

  document.getElementById('confirm-lend-btn')?.addEventListener('click', submitCheckout);
}

function captureConfirmLocation() {
  const btn    = document.getElementById('confirm-loc-btn');
  const status = document.getElementById('confirm-loc-status');
  if (!navigator.geolocation) {
    if (status) status.textContent = 'Geolocation not supported';
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Locating…'; }
  navigator.geolocation.getCurrentPosition(
    pos => {
      _capturedLocation = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      if (status) status.textContent = `📍 ${_capturedLocation.latitude.toFixed(5)}, ${_capturedLocation.longitude.toFixed(5)}`;
      if (btn) { btn.disabled = false; btn.textContent = '📍 Update'; }
    },
    () => {
      if (status) status.textContent = 'Location unavailable';
      if (btn) { btn.disabled = false; btn.textContent = '📍 Capture location'; }
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function renderEntitySelect(container) {
  const perms = _user?.permissions || [];
  const showDeptChips = perms.includes('checkout_equipment');

  container.innerHTML = `
    <div style="padding:1rem">
      <div style="font-size:17px;font-family:'Georgia',serif;margin-bottom:1rem">
        Who are you lending to?
      </div>

      <input id="entity-search" type="text" placeholder="Search group or person…"
        style="width:100%;margin-bottom:.5rem" autocomplete="off">
      <div id="entity-results"></div>

      ${showDeptChips ? `
        <div style="margin-top:1rem;font-size:12px;text-transform:uppercase;
          letter-spacing:.07em;color:var(--text3);margin-bottom:.4rem">Or pick a team</div>
        <div id="entity-dept-chips" class="camp-chip-wrap"></div>` : ''}

      <div style="margin-top:1rem;font-size:12px;text-transform:uppercase;
        letter-spacing:.07em;color:var(--text3);margin-bottom:.4rem">Or scan their QR</div>
      <button class="btn" style="width:100%" id="entity-scan-btn">Open scanner</button>

      <div style="margin-top:.75rem">
        <button class="btn ghost" onclick="window._scanner.backToScan()">← Cancel</button>
      </div>
    </div>`;

  window._scanner = { backToScan: () => { _session.mode = 'scanning'; renderMode(_container); } };

  if (showDeptChips) loadDeptChips();

  let searchTimer;
  document.getElementById('entity-search')?.addEventListener('input', e => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    if (q.length < 2) { document.getElementById('entity-results').innerHTML = ''; return; }
    searchTimer = setTimeout(() => searchEntities(q), 300);
  });

  document.getElementById('entity-scan-btn')?.addEventListener('click', () => {
    _session.mode = 'scanning';
    renderMode(_container);
  });
}

let _deptsCache = null;

async function loadDeptChips() {
  const wrap = document.getElementById('entity-dept-chips');
  if (!wrap) return;
  try {
    if (!_deptsCache) {
      const data = await get('/departments');
      _deptsCache = data.departments || [];
    }
    if (!_deptsCache.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = _deptsCache.map(d =>
      `<button class="camp-chip" data-id="${d.id}">${esc(d.name)}</button>`
    ).join('');
    wrap.querySelectorAll('button[data-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const d = _deptsCache.find(x => x.id === +btn.dataset.id);
        if (!d) return;
        _setSessionEntity({ type: 'dept', id: d.id, name: d.name });
      });
    });
  } catch { wrap.innerHTML = ''; }
}

function _setSessionEntity(entity) {
  _session.entity = entity;
  _groupDetail = null;
  if (_session.items.length > 0) _session.mode = 'confirm';
  else _session.mode = 'scanning';
  _updateBanner();
  renderMode(_container);
}

let _barriosCache = null;

async function loadBarriosCache() {
  if (_barriosCache) return _barriosCache;
  try {
    const data = await get('/groups');
    _barriosCache = data.groups || [];
    try { localStorage.setItem('barrio_camps', JSON.stringify(_barriosCache)); } catch {}
  } catch {
    try { _barriosCache = JSON.parse(localStorage.getItem('barrio_camps') || '[]'); }
    catch { _barriosCache = []; }
  }
  return _barriosCache;
}

async function searchEntities(q) {
  const results = document.getElementById('entity-results');
  if (!results) return;

  const perms = _user?.permissions || [];
  const matches = [];

  try {
    if (perms.includes('sub_checkout') || perms.includes('checkout_equipment')) {
      // Search groups
      const barrios = await loadBarriosCache();
      barrios.filter(b => b.name.toLowerCase().includes(q.toLowerCase())).slice(0, 5).forEach(b => {
        matches.push({ type: 'group', id: b.id, name: b.name });
      });
    }
    if (perms.includes('checkout_equipment') || perms.includes('sub_checkout')) {
      const data = await get('/persons?q=' + encodeURIComponent(q));
      (data.persons || []).slice(0, 5).forEach(p => {
        matches.push({ type: 'person', id: p.id, name: p.display_name, qr: p.qr_token });
      });
    }
  } catch {}

  if (!matches.length) {
    results.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:.5rem 0">No results</div>';
    return;
  }

  results.innerHTML = matches.map((m, i) => `
    <button data-idx="${i}" style="display:flex;align-items:center;gap:.5rem;width:100%;
      padding:.5rem .25rem;background:none;border:none;border-bottom:0.5px solid var(--border);
      text-align:left;cursor:pointer;font-size:14px;color:var(--text)">
      <span style="font-size:1rem">${m.type === 'group' ? '⛺' : '👤'}</span>
      ${esc(m.name)}
    </button>`).join('');

  results.querySelectorAll('button[data-idx]').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = matches[+btn.dataset.idx];
      _setSessionEntity(m);
    });
  });
}

// ── Camera ────────────────────────────────────────────────────────────────────

function startCamera() {
  const video = document.getElementById('scanner-video');
  if (!video) return;
  _scanner?.stop();
  _scanner = new Scanner(video, qr => handleLookup(qr));
  _scanner.start().catch(err => {
    const hint = document.getElementById('scan-hint');
    if (hint) hint.textContent = 'Camera unavailable — use manual entry below';
  });
}

function resumeCamera() {
  // Scanner stops itself after emitting; restart for next scan
  const video = document.getElementById('scanner-video');
  if (!video) return;
  _scanner = new Scanner(video, qr => handleLookup(qr));
  _scanner.start().catch(() => {});
}

// ── QR Lookup & Routing ───────────────────────────────────────────────────────

async function handleLookup(qr) {
  // If we're mid-checkin waiting for a storage-location QR, route there instead
  // of the normal item/entity lookup.
  if (_awaitingLocation) {
    await handleLocationForCheckin(qr);
    return;
  }

  // Detect person badge URL: https://host/person.html?token=TOKEN
  const badgeMatch = qr.match(/\/person\.html[?#&][^"]*[?&]?token=([a-f0-9]{64})/i);
  if (badgeMatch) {
    await handlePersonBadgeScan(badgeMatch[1]);
    return;
  }

  // Scanner already stopped itself on emit; overlay takes focus
  const overlay = document.getElementById('scan-result-overlay');
  const inner   = document.getElementById('scan-result-inner');
  if (!overlay || !inner) return;

  inner.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  overlay.style.display = '';

  let data;
  try {
    data = await get('/scan/lookup?qr=' + encodeURIComponent(qr));
  } catch (e) {
    inner.innerHTML = `<div style="color:var(--text2);padding:1rem">Error: ${esc(e.message)}</div>`;
    return;
  }

  const perms = _user?.permissions || [];

  renderScanResult(inner, data, perms, (action, payload) => {
    onScanAction(action, payload, qr, data);
  });
}

async function handlePersonBadgeScan(token) {
  const perms = _user?.permissions || [];

  // ── Identity mode: inline badge claim / login ─────────────────────────────
  if (_identityMode) {
    const overlay = document.getElementById('scan-result-overlay');
    const inner   = document.getElementById('scan-result-inner');
    if (!overlay || !inner) { window.location.href = '/person.html?token=' + encodeURIComponent(token); return; }

    inner.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    overlay.style.display = '';

    let info;
    try {
      info = await get('/auth/person-token-info?token=' + encodeURIComponent(token));
    } catch (e) {
      inner.innerHTML = `<div style="color:var(--text2);padding:1rem">Network error: ${esc(e.message)}</div>`;
      return;
    }

    if (!info.valid) {
      inner.innerHTML = `
        <div class="scan-card">
          <div class="scan-card-icon" style="color:var(--danger)">✕</div>
          <div class="scan-card-body">
            <div class="scan-card-name">Badge not found</div>
            <div class="scan-card-sub">This badge may have been deactivated.</div>
          </div>
        </div>
        <div class="scan-actions">
          <button class="btn scan-action-btn" onclick="window._scanner.closeOverlay()">← Try again</button>
        </div>`;
      return;
    }

    const isUnclaimed = !info.claimed;
    inner.innerHTML = `
      <div class="scan-card">
        <div class="scan-card-icon">🪪</div>
        <div class="scan-card-body">
          <div class="scan-card-name">${esc(info.label || 'Personal Badge')}</div>
          <div class="scan-card-sub">${isUnclaimed
            ? 'Unclaimed — enter your name to claim this badge'
            : "Enter your name to confirm it's you"}</div>
        </div>
      </div>
      <div style="padding:0 1rem 1rem">
        <input type="text" id="badge-name-input" placeholder="Your name"
          autocomplete="name" style="width:100%;margin-bottom:.5rem">
        <div id="badge-name-error" style="color:var(--danger);font-size:13px;display:none;margin-bottom:.5rem"></div>
        <button class="btn primary scan-action-btn" id="badge-name-btn" style="width:100%">
          ${isUnclaimed ? 'Claim badge' : 'Continue'}
        </button>
        <button class="btn scan-action-btn" style="width:100%;margin-top:.25rem"
          onclick="window._scanner.closeOverlay()">← Back</button>
      </div>`;

    setTimeout(() => document.getElementById('badge-name-input')?.focus(), 100);

    const submit = async () => {
      const nameEl = document.getElementById('badge-name-input');
      const errEl  = document.getElementById('badge-name-error');
      const btn    = document.getElementById('badge-name-btn');
      const name   = nameEl?.value.trim();
      if (!name) { errEl.textContent = 'Please enter your name.'; errEl.style.display = ''; return; }

      btn.disabled = true;
      btn.textContent = isUnclaimed ? 'Claiming…' : 'Signing in…';
      errEl.style.display = 'none';

      try {
        const endpoint = isUnclaimed ? '/api/auth/person-claim' : '/api/auth/person-login';
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ token, display_name: name }),
        });
        const data = await resp.json();

        if (!resp.ok) {
          errEl.textContent = resp.status === 401
            ? 'Name does not match. Try the name you used when claiming this badge.'
            : (data.error || 'Something went wrong.');
          errEl.style.display = '';
          btn.disabled = false;
          btn.textContent = isUnclaimed ? 'Claim badge' : 'Continue';
          return;
        }

        if (_onIdentityResolved) _onIdentityResolved(data);
        overlay.style.display = 'none';
      } catch {
        errEl.textContent = 'Network error. Check your connection.';
        errEl.style.display = '';
        btn.disabled = false;
        btn.textContent = isUnclaimed ? 'Claim badge' : 'Continue';
      }
    };

    document.getElementById('badge-name-btn')?.addEventListener('click', submit);
    document.getElementById('badge-name-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    return;
  }

  // ── Staff checkout flow: set person as checkout entity ────────────────────
  if (perms.includes('checkout_equipment') || perms.includes('sub_checkout')) {
    const overlay = document.getElementById('scan-result-overlay');
    const inner   = document.getElementById('scan-result-inner');
    if (!overlay || !inner) return;

    inner.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    overlay.style.display = '';

    try {
      const info = await get('/auth/person-token-info?token=' + encodeURIComponent(token));

      if (!info.valid) {
        inner.innerHTML = `
          <div class="scan-card">
            <div class="scan-card-icon" style="color:var(--danger)">✕</div>
            <div class="scan-card-body"><div class="scan-card-name">Badge not found</div></div>
          </div>
          <div class="scan-actions">
            <button class="btn scan-action-btn" onclick="window._scanner.closeOverlay()">Close</button>
          </div>`;
        return;
      }

      if (!info.claimed) {
        inner.innerHTML = `
          <div class="scan-card">
            <div class="scan-card-icon">🪪</div>
            <div class="scan-card-body">
              <div class="scan-card-name">${esc(info.label || 'Personal Badge')}</div>
              <div class="scan-card-sub">This badge hasn't been claimed yet.</div>
            </div>
          </div>
          <div class="scan-actions">
            <button class="btn scan-action-btn" onclick="window._scanner.closeOverlay()">Close</button>
          </div>`;
        return;
      }

      const personData = await get('/person-info?qr=' + encodeURIComponent(token));
      const p = personData?.person;
      if (!p) {
        inner.innerHTML = `<div style="color:var(--text2);padding:1rem">Person record not found.</div>`;
        return;
      }

      const entity = { type: 'person', id: p.id, name: p.display_name, qr: token };

      if (_session.entity && _session.entity.id !== entity.id) {
        inner.innerHTML = `
          <div class="scan-card">
            <div class="scan-card-icon">⚠️</div>
            <div class="scan-card-body">
              <div class="scan-card-name">Switch recipient?</div>
              <div class="scan-card-sub">Currently lending to <strong>${esc(_session.entity.name)}</strong>.
                Switch to <strong>${esc(entity.name)}</strong>? Your scanned items will be kept.</div>
            </div>
          </div>
          <div class="scan-actions">
            <button class="btn primary scan-action-btn" id="badge-switch-btn">Switch to ${esc(entity.name)}</button>
            <button class="btn scan-action-btn" onclick="window._scanner.closeOverlay()">Keep ${esc(_session.entity.name)}</button>
          </div>`;
        document.getElementById('badge-switch-btn')?.addEventListener('click', () => {
          _session.entity = entity;
          _groupDetail = null;
          _updateBanner?.();
          overlay.style.display = 'none';
          renderMode(_container);
        });
        return;
      }

      _session.entity = entity;
      _groupDetail = null;
      _updateBanner?.();
      overlay.style.display = 'none';
      renderMode(_container);

    } catch (e) {
      inner.innerHTML = `<div style="color:var(--text2);padding:1rem">Error: ${esc(e.message)}</div>`;
    }
    return;
  }

  // ── Guest / person session: go to person.html ─────────────────────────────
  window.location.href = '/person.html?token=' + encodeURIComponent(token);
}

async function onScanAction(action, payload, rawQr, lookupData) {
  const overlay = document.getElementById('scan-result-overlay');
  const perms   = _user?.permissions || [];

  switch (action) {
    case 'entity_select': {
      // Entity QR scanned — set as checkout target
      let entity = null;
      if (lookupData.type === 'group') {
        entity = { type: 'group', id: lookupData.id, name: lookupData.name };
      } else if (lookupData.type === 'department') {
        entity = { type: 'dept', id: lookupData.id, name: lookupData.name };
      } else if (lookupData.type === 'person') {
        entity = { type: 'person', id: lookupData.id, name: lookupData.name, qr: rawQr };
      }

      if (_session.entity && _session.entity.id !== entity?.id) {
        // Switching entity mid-session
        const inner = document.getElementById('scan-result-inner');
        inner.innerHTML = `
          <div class="scan-card">
            <div class="scan-card-icon">⚠️</div>
            <div class="scan-card-body">
              <div class="scan-card-name">Switch recipient?</div>
              <div class="scan-card-sub">
                Currently lending to <strong>${esc(_session.entity.name)}</strong>.
                Switch to <strong>${esc(entity.name)}</strong>?
                Your scanned items will be kept.
              </div>
            </div>
          </div>
          <div class="scan-actions">
            <button class="btn primary scan-action-btn" id="switch-entity-btn">Switch to ${esc(entity.name)}</button>
            <button class="btn scan-action-btn" onclick="window._scanner.closeOverlay()">Keep ${esc(_session.entity.name)}</button>
          </div>`;
        document.getElementById('switch-entity-btn')?.addEventListener('click', () => {
          _session.entity = entity;
          _groupDetail = null;
          _updateBanner();
          overlay.style.display = 'none';
          renderMode(_container);
        });
        return;
      }

      if (entity) {
        _session.entity = entity;
        _groupDetail = null;
        _updateBanner();
      }
      overlay.style.display = 'none';
      renderMode(_container);
      break;
    }

    case 'checkout_start': {
      // Item scanned — add to lending cart (works whether the item is
      // currently available or already checked out elsewhere — the final
      // submit always force-transfers, matching the previous Lend wizard).
      if (_session.items.some(i => i.qr === rawQr)) {
        _toast('Already in list');
        overlay.style.display = 'none';
        resumeCamera();
        return;
      }
      let warn = null;
      if (lookupData.status === 'checked-out') {
        const holder = lookupData.current_person?.name || lookupData.current_group?.name
          || lookupData.holder_dept?.name || lookupData.current_dept?.name || null;
        if (holder) warn = `Out to ${holder}`;
      }
      _session.items.push({ qr: rawQr, name: lookupData.name, id: lookupData.id, warn });
      _updateBanner();
      overlay.style.display = 'none';
      renderMode(_container);
      break;
    }

    case 'borrow_self': {
      await doAction(() => post('/person-checkout', {
        person_qr: _user.qr_token,
        item_qrs: [rawQr],
      }), 'Borrowed');
      overlay.style.display = 'none';
      resumeCamera();
      break;
    }

    case 'checkin': {
      startCheckinFlow(rawQr, lookupData);
      break;
    }

    case 'login': {
      overlay.style.display = 'none';
      resumeCamera();
      if (_requireIdentity) {
        // After identity resolved, reinit scanner (with updated user) and re-scan
        _requireIdentity(() => _onTabSwitch?.('scanner', { preload: { qr: rawQr } }));
      } else {
        window.location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search);
      }
      break;
    }
  }
}

async function doAction(apiFn, successMsg) {
  try {
    const result = await apiFn();
    if (result.error) {
      scanFeedbackError();
      _toast('Error: ' + result.error);
    } else {
      scanFeedbackSuccess();
      _toast(successMsg);
    }
  } catch (e) {
    scanFeedbackError();
    _toast('Error: ' + e.message);
  }
}

// ── Checkin flow (return equipment) ─────────────────────────────────────────
// Ported from the old checkin.js "return" mode: location-requirement
// enforcement, optional person-transfer, and a post-return home-location
// update prompt — none of this existed in the plain immediate-post checkin
// action this replaces.

function _checkedOutToLabel(item) {
  if (item.current_person) return `Out — ${item.current_person.name}`;
  if (item.current_group)  return `Out — ${item.current_group.name}`;
  if (item.holder_dept)    return `In dept pool — ${item.holder_dept.name}`;
  if (item.current_dept)   return `In dept pool — ${item.current_dept.name}`;
  return item.category ?? null;
}

function startCheckinFlow(qr, item) {
  const overlay = document.getElementById('scan-result-overlay');
  const inner   = document.getElementById('scan-result-inner');
  if (!overlay || !inner) return;

  const requireHome = item.require_home_location;
  const requireAny  = item.require_any_location;
  const homeLocName = item.home_location?.name;

  if (requireHome || requireAny) {
    const hint = requireHome
      ? `Scan location QR to return (must go to: ${homeLocName || 'home location'})`
      : 'Scan a storage location QR to return this item';

    inner.innerHTML = `
      <div class="scan-card">
        <div class="scan-card-icon">📦</div>
        <div class="scan-card-body">
          <div class="scan-card-name">${esc(item.name)}</div>
          <div class="scan-card-sub">${esc(hint)}</div>
        </div>
      </div>
      <div class="scan-actions">
        <button class="btn primary scan-action-btn" id="checkin-scan-loc-btn">Scan location</button>
        <button class="btn scan-action-btn" onclick="window._scanner.closeOverlay()">Cancel</button>
      </div>`;

    document.getElementById('checkin-scan-loc-btn')?.addEventListener('click', () => {
      _awaitingLocation = { itemQr: qr, item };
      overlay.style.display = 'none';
      _toast('Scan the storage location QR');
      resumeCamera();
    });
    return;
  }

  presentCheckinConfirm(qr, item, null);
}

async function handleLocationForCheckin(locQr) {
  const { itemQr, item } = _awaitingLocation;
  const overlay = document.getElementById('scan-result-overlay');
  const inner   = document.getElementById('scan-result-inner');
  if (!overlay || !inner) { _awaitingLocation = null; return; }

  inner.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  overlay.style.display = '';

  let locData;
  try {
    locData = await get('/locations/lookup?qr=' + encodeURIComponent(locQr));
  } catch (e) {
    inner.innerHTML = `<div style="color:var(--text2);padding:1rem">Location lookup failed: ${esc(e.message)}</div>
      <div class="scan-actions"><button class="btn scan-action-btn" onclick="window._scanner.closeOverlay()">Close</button></div>`;
    return;
  }

  if (!locData || locData.type !== 'storage_location') {
    inner.innerHTML = `
      <div class="scan-card">
        <div class="scan-card-icon" style="color:var(--danger)">✕</div>
        <div class="scan-card-body"><div class="scan-card-name">That's not a storage location QR</div></div>
      </div>
      <div class="scan-actions">
        <button class="btn primary scan-action-btn" id="checkin-retry-loc-btn">Try again</button>
        <button class="btn scan-action-btn" onclick="window._scanner.closeOverlay()">Cancel</button>
      </div>`;
    document.getElementById('checkin-retry-loc-btn')?.addEventListener('click', () => {
      overlay.style.display = 'none';
      resumeCamera();
    });
    return;
  }

  if (item.require_home_location && item.home_location && locData.id !== item.home_location.id) {
    inner.innerHTML = `
      <div class="scan-card">
        <div class="scan-card-icon" style="color:var(--danger)">✕</div>
        <div class="scan-card-body">
          <div class="scan-card-name">Wrong location</div>
          <div class="scan-card-sub">Must return to: ${esc(item.home_location.name)}</div>
        </div>
      </div>
      <div class="scan-actions">
        <button class="btn primary scan-action-btn" id="checkin-retry-loc-btn">Scan again</button>
        <button class="btn scan-action-btn" onclick="window._scanner.closeOverlay()">Cancel</button>
      </div>`;
    document.getElementById('checkin-retry-loc-btn')?.addEventListener('click', () => {
      overlay.style.display = 'none';
      resumeCamera();
    });
    return;
  }

  _awaitingLocation = null;
  scanFeedbackSuccess();
  presentCheckinConfirm(itemQr, item, { id: locData.id, name: locData.name, qr: locQr });
}

function presentCheckinConfirm(qr, item, locationInfo) {
  const overlay = document.getElementById('scan-result-overlay');
  const inner   = document.getElementById('scan-result-inner');
  if (!overlay || !inner) return;

  const subtitle = _checkedOutToLabel(item);
  const locSub = locationInfo ? (subtitle ? subtitle + ' · ' : '') + '📍 ' + locationInfo.name : subtitle;

  const homeLat = item.home_location?.latitude;
  const homeLng = item.home_location?.longitude;
  const navBtn = (homeLat != null)
    ? `<a class="btn scan-action-btn" style="display:block;text-align:center;text-decoration:none"
         href="https://maps.apple.com/?daddr=${homeLat},${homeLng}" target="_blank">
         Navigate to ${esc(item.home_location.name)}</a>`
    : '';

  const canTransfer = item.current_person && item.borrowable && item.borrow_eligible;

  // Reaching this screen with no locationInfo always means neither require
  // flag was set (a required scan is enforced earlier, before this screen
  // ever renders) — so return is never blocked on a location. Still offer
  // it as an optional, one-tap capture: encouraged, never required, and
  // useful even for items with no configured home location.
  const offerOptionalScan = !locationInfo;

  inner.innerHTML = `
    <div class="scan-card">
      <div class="scan-card-icon">📦</div>
      <div class="scan-card-body">
        <div class="scan-card-name">${esc(item.name)}</div>
        ${locSub ? `<div class="scan-card-sub">${esc(locSub)}</div>` : ''}
      </div>
    </div>
    <div class="scan-actions">
      <button class="btn primary scan-action-btn" id="checkin-confirm-btn">Confirm return</button>
      ${offerOptionalScan ? `<button class="btn scan-action-btn" id="checkin-optional-loc-btn">📍 Log where this went (optional)</button>` : ''}
      ${canTransfer ? `<button class="btn scan-action-btn" id="checkin-transfer-btn">Transfer to different person</button>` : ''}
      ${navBtn}
      <button class="btn scan-action-btn" onclick="window._scanner.closeOverlay()">Cancel</button>
    </div>`;

  document.getElementById('checkin-confirm-btn')?.addEventListener('click', () => doCheckin(qr, item, locationInfo));
  document.getElementById('checkin-optional-loc-btn')?.addEventListener('click', () => {
    _awaitingLocation = { itemQr: qr, item };
    overlay.style.display = 'none';
    _toast('Scan the storage location QR');
    resumeCamera();
  });
  document.getElementById('checkin-transfer-btn')?.addEventListener('click', () => startTransferFlow(item, qr, locationInfo));
}

async function doCheckin(qr, item, locationInfo) {
  const overlay = document.getElementById('scan-result-overlay');
  const inner   = document.getElementById('scan-result-inner');

  try {
    const body = { item_qr: qr };
    if (locationInfo) body.location_qr = locationInfo.qr;
    const res = await post('/checkin', body);

    if (res.__offline) {
      scanFeedbackSuccess();
      _toast('Saved offline — will sync');
      overlay.style.display = 'none';
      resumeCamera();
      return;
    }
    if (!res.success) {
      scanFeedbackError();
      _toast('Item was not checked out');
      overlay.style.display = 'none';
      resumeCamera();
      return;
    }

    scanFeedbackSuccess();
    _toast(`Returned ${item.name}${locationInfo ? ' → ' + locationInfo.name : ''}`);
    await maybePromptHomeLocationUpdate(item, locationInfo);
  } catch (e) {
    scanFeedbackError();
    _toast('Error: ' + e.message);
    overlay.style.display = 'none';
    resumeCamera();
  }
}

async function maybePromptHomeLocationUpdate(item, locationInfo) {
  const overlay   = document.getElementById('scan-result-overlay');
  const inner     = document.getElementById('scan-result-inner');
  const canManage = (_user?.permissions || []).includes('manage_equipment');
  const homeId    = item?.home_location?.id;
  const locId     = locationInfo?.id;

  if (canManage && homeId && locId && locId !== homeId && inner) {
    inner.innerHTML = `
      <div class="scan-card">
        <div class="scan-card-icon">📍</div>
        <div class="scan-card-body">
          <div class="scan-card-name">Update home location?</div>
          <div class="scan-card-sub">Home is "${esc(item.home_location.name)}". Make "${esc(locationInfo.name)}" the new home for ${esc(item.name)}?</div>
        </div>
      </div>
      <div class="scan-actions">
        <button class="btn primary scan-action-btn" id="checkin-set-home-btn">Set home to ${esc(locationInfo.name)}</button>
        <button class="btn scan-action-btn" onclick="window._scanner.closeOverlay()">Keep current home</button>
      </div>`;
    document.getElementById('checkin-set-home-btn')?.addEventListener('click', async () => {
      try {
        await put('/admin/items', { id: item.id, home_location_id: locationInfo.id });
        _toast(`Home location updated to ${locationInfo.name}`);
      } catch (e) {
        _toast('Could not update: ' + e.message);
      }
      overlay.style.display = 'none';
      resumeCamera();
    });
    return;
  }

  overlay.style.display = 'none';
  resumeCamera();
}

// ── Person-transfer flow (return-and-reassign in one step) ─────────────────

function startTransferFlow(item, qr, locationInfo) {
  const inner = document.getElementById('scan-result-inner');
  if (!inner) return;

  inner.innerHTML = `
    <div class="scan-card">
      <div class="scan-card-icon">👤</div>
      <div class="scan-card-body"><div class="scan-card-name">Transfer: ${esc(item.name)}</div></div>
    </div>
    <div style="padding:0 1rem">
      <input class="search-input" id="transfer-search" type="search"
        placeholder="Search person by name…" autocomplete="off" autocorrect="off" spellcheck="false"
        style="width:100%;margin-bottom:.5rem">
      <div id="transfer-results"></div>
      <button class="btn scan-action-btn" style="width:100%;margin-top:.75rem" id="transfer-cancel-btn">Cancel</button>
    </div>`;

  document.getElementById('transfer-cancel-btn')?.addEventListener('click', () => presentCheckinConfirm(qr, item, locationInfo));

  let searchTimer;
  const input = document.getElementById('transfer-search');
  input?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    const results = document.getElementById('transfer-results');
    if (!results) return;
    if (q.length < 2) { results.innerHTML = ''; return; }
    searchTimer = setTimeout(() => searchTransferPersons(q, item, qr), 300);
  });
  setTimeout(() => input?.focus(), 60);
}

async function searchTransferPersons(q, item, qr) {
  const results = document.getElementById('transfer-results');
  if (!results) return;
  try {
    const data = await get('/persons', { q });
    const persons = data.persons || [];
    if (!persons.length) {
      results.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:.5rem 0">No results</div>';
      return;
    }
    results.innerHTML = persons.map((p, i) => `
      <button data-idx="${i}" style="display:block;width:100%;padding:.5rem .25rem;
        background:none;border:none;border-bottom:0.5px solid var(--border);
        text-align:left;cursor:pointer;font-size:14px;color:var(--text)">${esc(p.display_name)}</button>
    `).join('');
    results.querySelectorAll('button[data-idx]').forEach(btn => {
      btn.addEventListener('click', () => doPersonTransfer(item, qr, persons[+btn.dataset.idx]));
    });
  } catch {
    results.innerHTML = '<div style="color:var(--danger);font-size:13px">Search failed</div>';
  }
}

async function doPersonTransfer(item, qr, person) {
  const overlay = document.getElementById('scan-result-overlay');
  try {
    const perms = _user?.permissions || [];
    let result;
    if (perms.includes('checkout_equipment')) {
      result = await post('/person-checkout', { person_qr: person.qr_token, item_qrs: [qr], force: true });
    } else {
      const deptId = (_user?.dept_ids || [])[0];
      result = await post('/sub-person-checkout', { dept_id: deptId, person_qr: person.qr_token, item_qrs: [qr], force: true });
    }
    if (result.results?.some(r => !r.success)) throw new Error(result.results.find(r => !r.success)?.error || 'Transfer failed');
    scanFeedbackSuccess();
    _toast(`Transferred ${item.name} to ${person.display_name}`);
  } catch (e) {
    scanFeedbackError();
    _toast('Error: ' + e.message);
  }
  overlay.style.display = 'none';
  resumeCamera();
}

// ── Submit checkout ───────────────────────────────────────────────────────────

async function submitCheckout() {
  const { entity, items } = _session;
  if (!entity || items.length === 0) return;

  const btn = document.getElementById('confirm-lend-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Lending…'; }

  const item_qrs = items.map(i => i.qr);
  const perms    = _user?.permissions || [];
  const label    = _deptLabel || undefined;

  try {
    let endpoint, body;

    if (entity.type === 'person') {
      endpoint = perms.includes('checkout_equipment') ? '/person-checkout' : '/sub-person-checkout';
      body = { person_qr: entity.qr, item_qrs, dept_label: label, force: true };
      if (!perms.includes('checkout_equipment')) {
        body.dept_id = _user?.dept_ids?.[0];
      }
    } else if (entity.type === 'dept') {
      endpoint = '/checkout';
      body = { dept_id: entity.id, item_qrs, dept_label: label, force: true };
    } else if (entity.type === 'group') {
      endpoint = '/sub-checkout';
      body = {
        dept_id: _user?.dept_ids?.[0] ?? null,
        group_id: entity.id,
        item_qrs,
        dept_label: label,
        force: true,
        apply_group_location: document.getElementById('confirm-apply-group-loc')?.checked ?? true,
      };
      if (_capturedLocation) {
        body.latitude  = _capturedLocation.latitude;
        body.longitude = _capturedLocation.longitude;
      }
    }

    const result = await post(endpoint, body);
    if (result.__offline) {
      _toast('Saved offline — will sync');
      resetLendingSession();
      return;
    }
    if (result.error) throw new Error(result.error);

    // Per-item results (person-checkout endpoints)
    if (result.results) {
      const restricted = result.results.filter(r => !r.success && r.error === 'borrow_restricted');
      const otherFails = result.results.filter(r => !r.success && r.error !== 'borrow_restricted');
      if (otherFails.length) throw new Error(otherFails.map(r => r.error || 'error').join('; '));
      if (restricted.length) {
        if (btn) { btn.disabled = false; btn.textContent = 'Confirm lend'; }
        const canManage = perms.includes('manage_equipment');
        let msgEl = document.getElementById('borrow-restrict-msg');
        if (!msgEl) {
          msgEl = document.createElement('div');
          msgEl.id = 'borrow-restrict-msg';
          msgEl.style.cssText = 'margin-top:.75rem;padding:.75rem;background:#fff8e1;border:1px solid #e5c000;border-radius:var(--radius);font-size:13px;line-height:1.5';
          btn?.parentNode?.insertBefore(msgEl, btn.nextSibling);
        }
        const itemNames = restricted.map(r => esc(items.find(i => i.qr === r.qr)?.name || r.qr)).join(', ');
        msgEl.innerHTML = `
          <strong>⚠ Not permitted to borrow</strong><br>
          ${esc(entity.name)} can't borrow: ${itemNames}
          ${canManage ? `<div style="margin-top:.5rem">
            <button class="btn sm" id="add-borrow-exception-btn">Add exception &amp; retry</button>
          </div>` : ''}`;
        if (canManage) {
          document.getElementById('add-borrow-exception-btn')?.addEventListener('click', async () => {
            const exBtn = document.getElementById('add-borrow-exception-btn');
            if (exBtn) { exBtn.disabled = true; exBtn.textContent = 'Adding…'; }
            try {
              const typeIds = [...new Set(restricted.map(r => r.type_id))];
              await Promise.all(typeIds.map(tid =>
                post('/admin/borrow-rules', { type_id: tid, allowed_user_id: entity.id })
              ));
              msgEl.remove();
              await submitCheckout();
            } catch {
              if (exBtn) { exBtn.disabled = false; exBtn.textContent = 'Failed — try again'; }
            }
          });
        }
        return;
      }
    }

    // Record group arrival if this session's confirm step showed the sub-form
    if (entity.type === 'group' && document.getElementById('confirm-orientation')) {
      const orient = document.getElementById('confirm-orientation')?.checked || false;
      const arrItems = [];
      document.querySelectorAll('.arrival-cons-input').forEach(inp => {
        const qty = parseInt(inp.value || '0', 10);
        if (qty > 0) arrItems.push({ type_id: +inp.dataset.typeId, quantity: qty });
      });
      try {
        await post('/group-arrival', { group_id: entity.id, items: arrItems, orientation_done: orient });
      } catch { /* non-fatal */ }
    }

    _toast('Lent successfully');
    resetLendingSession();
  } catch (e) {
    _toast('Error: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Confirm lend'; }
  }
}

function resetLendingSession() {
  _session = null;
  _groupDetail = null;
  _capturedLocation = null;
  _deptLabel = '';
  _updateBanner();
  _onTabSwitch('home');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
