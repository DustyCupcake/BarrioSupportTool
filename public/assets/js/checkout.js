/**
 * Lend tab — 3-step flow.
 *
 * Modes (determined by user permissions + dept sub_entity):
 *   'dept'        — production → department
 *   'person_prod' — production → person
 *   'sub_barrio'  — dept → barrio
 *   'sub_artist'  — dept → artist
 *   'sub_person'  — dept → person
 *
 * Users with multiple options see a mode-selector in step 1.
 */

import { get, post } from './api.js?v=1.0.1';
import { Scanner } from './scanner.js?v=1.0.0';
import { toast, switchTab, getCurrentUser } from './app.js?v=1.0.1';
import { scanOverlay } from './scan-overlay.js?v=1.0.1';
import { t } from './i18n.js?v=1.0.1';

const __ = (key) => t('checkout', key);
const _c = (key) => t('common', key);

// Module state
let step           = 1;
let mode           = 'sub_barrio';
let availableModes = [];      // modes the user can choose from
let selectedEntity = null;    // { id, name, arrival_status?, qr_token? }
let entityList     = [];
let scannedItems   = [];
let scanner        = null;
let deptLabel      = '';
let _consumableTypes = [];
let _barrioDetail    = null;
let capturedLocation = null;  // { latitude, longitude } from GPS capture during sub-checkout

// ─── Mode helpers ──────────────────────────────────────────────────────────────

function buildAvailableModes(user) {
  const perms       = user?.permissions || [];
  const subEntities = Object.values(user?.dept_sub_entities || {});
  const modes       = [];

  if (perms.includes('checkout_equipment')) {
    modes.push('dept');
    modes.push('person_prod');
  }
  if (perms.includes('sub_checkout')) {
    if (subEntities.includes('barrio')) modes.push('sub_barrio');
    if (subEntities.includes('artist')) modes.push('sub_artist');
    if (!perms.includes('checkout_equipment')) modes.push('sub_person');
  }
  return modes.length ? modes : ['sub_barrio']; // fallback
}

function modeEntityLabel(m = mode) {
  const labels = { dept: 'team', person_prod: 'person', sub_barrio: 'barrio', sub_artist: 'artist', sub_person: 'person' };
  return labels[m] ?? 'entity';
}

function modeChipLabel(m) {
  const map = { dept: 'modeToDept', person_prod: 'modeToPerson', sub_barrio: 'modeToBarrio', sub_artist: 'modeToArtist', sub_person: 'modeToPerson' };
  return map[m] ? __(map[m]) : m;
}

function modeStep1Title() {
  const map = { dept: 'selectTeam', person_prod: 'selectPerson', sub_barrio: 'step1', sub_artist: 'selectArtist', sub_person: 'selectPerson' };
  return map[mode] ? __(map[mode]) : 'Select';
}

function isPersonMode(m = mode) {
  return m === 'person_prod' || m === 'sub_person';
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function init(container, preselectedId = null) {
  const user    = getCurrentUser();
  availableModes = buildAvailableModes(user);

  // Check for person QR from URL (?person=<token>)
  const pendingPerson = window._pendingPerson;
  const pendingQr     = window._pendingPersonQr;
  if (pendingPerson && pendingQr) {
    delete window._pendingPerson;
    delete window._pendingPersonQr;
    const personMode = availableModes.includes('person_prod') ? 'person_prod'
                     : availableModes.includes('sub_person')  ? 'sub_person'
                     : null;
    if (personMode) {
      mode = personMode;
      renderStep1(container, null);
      // Pre-select the person and advance to step 2
      selectedEntity = { id: pendingPerson.id, name: pendingPerson.display_name, qr_token: pendingQr };
      goStep2();
      return;
    }
  }

  mode = availableModes[0];
  renderStep1(container, preselectedId);
}

// ─── Step 1: Select entity ─────────────────────────────────────────────────────

function renderStep1(container, preselectedId = null) {
  step             = 1;
  selectedEntity   = null;
  scannedItems     = [];
  deptLabel        = '';
  _barrioDetail    = null;
  capturedLocation = null;
  stopScanner();

  const modeSelectorHtml = availableModes.length > 1 ? `
    <div class="mode-chips" style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1rem">
      ${availableModes.map(m => `
        <button class="camp-chip${m === mode ? ' selected' : ''}" data-mode="${m}"
          onclick="window._co.setMode('${m}')">
          ${modeChipLabel(m)}
        </button>`).join('')}
    </div>
  ` : '';

  const scanBtnHtml = mode === 'sub_barrio' ? `
    <button class="btn" id="co-scan-camp-btn" onclick="window._co.toggleEntityScan()">Scan barrio QR</button>
    <div class="divider"><span>or select:</span></div>
  ` : isPersonMode() ? `
    <button class="btn" id="co-scan-camp-btn" onclick="window._co.toggleEntityScan()">Scan person QR</button>
    <div class="divider"><span>or search:</span></div>
    <div class="field" style="margin-bottom:.5rem">
      <input type="text" id="co-person-search" placeholder="Search by name…" autocomplete="off"
             oninput="window._co.searchPersons(this.value)">
    </div>
  ` : '';

  container.innerHTML = `
    ${stepsHTML(1)}
    ${modeSelectorHtml}
    <div class="card">
      <div class="card-label">${modeStep1Title()}</div>
      <div class="video-wrap" style="display:none" id="co-camp-wrap">
        <video id="co-camp-video" playsinline muted></video>
        <div class="scan-overlay"><div class="scan-frame"><div class="scan-line"></div></div></div>
      </div>
      <div class="scan-status" style="display:none" id="co-camp-status"></div>
      ${scanBtnHtml}
      <div class="camp-chip-wrap" id="co-chips"></div>
    </div>
    <button class="btn primary" id="co-next1" disabled onclick="window._co.goStep2()">Continue</button>
  `;

  window._co = {
    toggleEntityScan,
    goStep2,
    setMode: (m) => { mode = m; renderStep1(container, null); },
    selectEntity,
    searchPersons,
  };

  if (!isPersonMode()) {
    loadEntityList(container, preselectedId);
  }
}

async function loadEntityList(container, preselectedId = null) {
  try {
    if (mode === 'dept') {
      const data = await get('/departments');
      entityList = data.departments || [];
      try { localStorage.setItem('barrio_departments', JSON.stringify(entityList)); } catch {}
    } else if (mode === 'sub_barrio') {
      const [campsData, typesData] = await Promise.all([get('/camps'), get('/consumable-types')]);
      entityList       = campsData.camps || [];
      _consumableTypes = typesData.types || [];
      try { localStorage.setItem('barrio_camps', JSON.stringify(entityList)); } catch {}
      try { localStorage.setItem('barrio_consumable_types', JSON.stringify(_consumableTypes)); } catch {}
    } else if (mode === 'sub_artist') {
      const data = await get('/artists');
      entityList = data.artists || [];
      try { localStorage.setItem('barrio_artists', JSON.stringify(entityList)); } catch {}
    }

    renderChips(container);

    if (preselectedId) {
      const match = entityList.find(e => String(e.id) === String(preselectedId));
      if (match) {
        if (mode === 'sub_barrio') showBarrioSuccess(match);
        else selectEntity(match.id, match.name);
      }
    }
  } catch (e) {
    if (!navigator.onLine) {
      try {
        const cacheKey = mode === 'dept' ? 'barrio_departments' : mode === 'sub_barrio' ? 'barrio_camps' : 'barrio_artists';
        const cc = localStorage.getItem(cacheKey);
        if (cc) entityList = JSON.parse(cc);
        if (mode === 'sub_barrio') {
          const ct = localStorage.getItem('barrio_consumable_types');
          if (ct) _consumableTypes = JSON.parse(ct);
        }
      } catch {}
      if (entityList.length) { renderChips(container); return; }
    }
    toast(`Could not load ${modeEntityLabel()}s: ${e.message}`);
  }
}

function renderChips(container) {
  const wrap = container.querySelector('#co-chips');
  if (!wrap) return;
  if (!entityList.length) {
    wrap.innerHTML = `<span style="font-size:13px;color:var(--text3);font-style:italic">No ${modeEntityLabel()}s configured</span>`;
    return;
  }

  if (mode === 'sub_barrio') {
    wrap.innerHTML = entityList.map(c =>
      `<button class="camp-chip${selectedEntity?.id === c.id ? ' selected' : ''}" data-id="${c.id}"
        onclick="window._co.selectEntity(${c.id}, '${_escAttr(c.name)}', '${c.arrival_status}')">
        <span class="status-dot ${c.arrival_status}"></span> ${_esc(c.name)}
      </button>`
    ).join('');
  } else {
    wrap.innerHTML = entityList.map(e =>
      `<button class="camp-chip${selectedEntity?.id === e.id ? ' selected' : ''}" data-id="${e.id}"
        onclick="window._co.selectEntity(${e.id}, '${_escAttr(e.name)}')">
        ${_esc(e.name)}
      </button>`
    ).join('');
  }
  window._co.selectEntity = selectEntity;
}

function selectEntity(id, name, arrival_status = null, qr_token = null) {
  const entity = entityList.find(e => e.id === id);
  selectedEntity = {
    id,
    name,
    arrival_status: arrival_status ?? entity?.arrival_status ?? null,
    qr_token:       qr_token ?? entity?.qr_token ?? null,
  };
  document.querySelectorAll('.camp-chip').forEach(c =>
    c.classList.toggle('selected', Number(c.dataset.id) === id));
  const btn = document.getElementById('co-next1');
  if (btn) btn.disabled = false;
}

// Person search (for person modes)
async function searchPersons(query) {
  const wrap = document.getElementById('co-chips');
  if (!wrap) return;
  if (!query || query.length < 2) {
    wrap.innerHTML = '<span style="font-size:13px;color:var(--text3)">Type a name to search…</span>';
    if (selectedEntity && query.length === 0) {
      // clear selection only if input cleared
      selectedEntity = null;
      const btn = document.getElementById('co-next1');
      if (btn) btn.disabled = true;
    }
    return;
  }
  try {
    const data = await get('/persons', { q: query });
    const persons = data.persons || [];
    if (!persons.length) {
      wrap.innerHTML = '<span style="font-size:13px;color:var(--text3)">No matches found</span>';
      return;
    }
    wrap.innerHTML = persons.map(p =>
      `<button class="camp-chip${selectedEntity?.id === p.id ? ' selected' : ''}" data-id="${p.id}"
        onclick="window._co.selectEntity(${p.id}, '${_escAttr(p.display_name)}', null, '${_escAttr(p.qr_token || '')}')">
        ${_esc(p.display_name)}
      </button>`
    ).join('');
    window._co.selectEntity = selectEntity;
  } catch {
    wrap.innerHTML = '<span style="font-size:13px;color:var(--danger)">Search failed</span>';
  }
}

// ─── Entity QR scanner (step 1) ────────────────────────────────────────────────

async function toggleEntityScan() {
  const wrap = document.getElementById('co-camp-wrap');
  const btn  = document.getElementById('co-scan-camp-btn');
  const stat = document.getElementById('co-camp-status');
  if (!wrap || !btn) return;

  if (scanner) {
    stopScanner();
    wrap.style.display = 'none';
    stat.style.display = 'none';
    btn.textContent = isPersonMode() ? 'Scan person QR' : 'Scan barrio QR';
    return;
  }

  wrap.style.display = '';
  stat.style.display = '';
  btn.textContent = _c('cancelScan');
  stat.textContent = isPersonMode() ? 'Aim camera at person QR code…' : __('aimBarrio');

  scanner = new Scanner(document.getElementById('co-camp-video'), async (value) => {
    if (isPersonMode()) {
      await handlePersonQrScan(value, wrap, btn, stat);
    } else {
      handleBarrioQrScan(value, wrap, btn, stat);
    }
  });

  try { await scanner.start(); }
  catch { stat.textContent = _c('cameraError'); scanner = null; }
}

async function handlePersonQrScan(value, wrap, btn, stat) {
  // Extract qr_token from URL or use raw value
  let qrToken = value;
  try {
    const url = new URL(value);
    qrToken = url.searchParams.get('person') ?? value;
  } catch { /* not a URL */ }

  const doError = () => {
    scanOverlay.show({
      state: 'error',
      title: _c('notRecognised'),
      subtitle: 'Person QR not found',
      buttons: [{ label: _c('ok'), action: () => { scanOverlay.hide(); scanner = null; toggleEntityScan(); } }],
    });
  };

  try {
    const data = await get('/person-info', { qr: qrToken });
    const person = data.person;
    const doConfirm = () => {
      selectedEntity = { id: person.id, name: person.display_name, qr_token: qrToken };
      wrap.style.display = 'none';
      btn.textContent = 'Scan person QR';
      stat.textContent = '';
      scanOverlay.hide();
      stopScanner();
      goStep2();
    };
    const itemsNote = data.items_out?.length
      ? `${data.items_out.length} item(s) already out`
      : 'No items currently checked out';
    scanOverlay.show({
      state: data.items_out?.length ? 'warning' : 'success',
      title: person.display_name,
      subtitle: itemsNote,
      buttons: [
        { label: __('continueItems'), action: doConfirm },
        { label: _c('undo'), action: () => { scanOverlay.hide(); scanner = null; toggleEntityScan(); } },
      ],
    });
  } catch (e) {
    if (e.status === 404) doError();
    else scanOverlay.show({
      state: 'error', title: 'Error', subtitle: e.message,
      buttons: [{ label: _c('ok'), action: () => { scanOverlay.hide(); } }],
    });
  }
}

function handleBarrioQrScan(value, wrap, btn, stat) {
  let scannedId = value;
  try {
    const url = new URL(value);
    scannedId = url.searchParams.get('barrio') ?? value;
  } catch { /* not a URL */ }

  const match = entityList.find(c =>
    c.name.toLowerCase() === value.toLowerCase() ||
    String(c.id) === value ||
    String(c.id) === scannedId
  );

  if (match) showBarrioSuccess(match, wrap, btn, stat);
  else        showBarrioError(wrap, btn, stat);
}

function showBarrioSuccess(match, wrap = null, btn = null, stat = null) {
  const doConfirm = () => {
    selectEntity(match.id, match.name, match.arrival_status);
    if (wrap) wrap.style.display = 'none';
    if (btn) btn.textContent = 'Scan barrio QR';
    if (stat) stat.textContent = '';
    scanOverlay.hide();
    goStep2();
  };
  const doCheckInOnly = () => { scanOverlay.hide(); switchTab('barrios', match.id); };
  const doUndo = () => {
    scanOverlay.hide();
    if (wrap && btn) { scanner = null; toggleEntityScan(); }
    else             { window.location.href = '/'; }
  };
  const checkInLabel = match.arrival_status === 'expected' ? __('checkInWithout') : __('goToBarrio');
  scanOverlay.show({
    state: 'success', title: match.name, subtitle: null,
    buttons: [
      { label: __('continueItems'), action: doConfirm },
      { label: checkInLabel,        action: doCheckInOnly },
      { label: _c('undo'),          action: doUndo },
    ],
  });
}

function showBarrioError(wrap, btn, stat) {
  const doOK = () => { scanOverlay.hide(); scanner = null; toggleEntityScan(); };
  const doManual = () => {
    scanOverlay.showManualEntry({
      placeholder: __('typeName'),
      onSubmit: (typed) => {
        const m = entityList.find(c =>
          c.name.toLowerCase() === typed.toLowerCase() || String(c.id) === typed
        );
        if (m) showBarrioSuccess(m, wrap, btn, stat);
        else scanOverlay.show({
          state: 'error', title: _c('notRecognised'), subtitle: `No barrio matches "${typed}"`,
          buttons: [{ label: _c('ok'), action: doOK }, { label: _c('enterManually'), action: doManual }],
        });
      },
      onCancel: doOK,
    });
  };
  scanOverlay.show({
    state: 'error', title: _c('notRecognised'), subtitle: __('barrioNotFound'),
    buttons: [{ label: _c('ok'), action: doOK }, { label: _c('enterManually'), action: doManual }],
  });
}

// ─── Step 2: Scan items ────────────────────────────────────────────────────────

async function goStep2() {
  if (!selectedEntity) return;
  const container = document.getElementById('tab-checkout');
  step = 2;
  stopScanner();

  _barrioDetail = null;
  if (mode === 'sub_barrio') {
    get('/barrios/' + selectedEntity.id)
      .then(d => { _barrioDetail = d; renderOrderSummary(); })
      .catch(() => {});
  }

  const arrivalPrompt = (mode === 'sub_barrio' && selectedEntity.arrival_status === 'expected') ? `
    <div class="card arrival-prompt-card">
      <div class="card-label">Barrio not yet checked in</div>
      <div style="font-size:13px;color:var(--warn)">Arrival will be recorded on confirmation.</div>
    </div>
  ` : '';

  container.innerHTML = `
    ${stepsHTML(2)}
    <div class="camp-badge"><span class="camp-badge-dot"></span>${_esc(selectedEntity.name)}</div>
    ${arrivalPrompt}
    <div id="co-order-summary"></div>
    <div class="card">
      <div class="card-label">Scan items</div>
      <div class="video-wrap" id="co-items-wrap">
        <video id="co-items-video" playsinline muted></video>
        <div class="scan-overlay"><div class="scan-frame"><div class="scan-line"></div></div></div>
      </div>
      <div class="scan-status" id="co-items-status">${__('aimItem')}</div>
    </div>
    <div class="card" id="co-scanned-card">
      <div class="card-label">${__('scannedItems')} (<span id="co-count">0</span>)</div>
      <div id="co-item-list"><div class="empty-list">${__('noItems')}</div></div>
    </div>
    <div class="field" style="margin-bottom:.5rem">
      <label for="co-dept-label">Equipment label <span style="font-size:12px;color:var(--text3)">(optional)</span></label>
      <input type="text" id="co-dept-label" placeholder="e.g. Generator 1, Sound Team"
             value="${_esc(deptLabel)}" oninput="window._co.setLabel(this.value)">
    </div>
    <div style="display:flex;gap:.5rem">
      <button class="btn ghost" style="flex:1" onclick="window._co.back()">${_c('back')}</button>
      <button class="btn primary" id="co-next2" disabled style="flex:2" onclick="window._co.goStep3()">${__('reviewLend')}</button>
    </div>
  `;

  window._co = {
    back: () => renderStep1(container),
    goStep3,
    removeItem,
    setLabel: (v) => { deptLabel = v; },
  };
  renderScannedList();

  scanner = new Scanner(document.getElementById('co-items-video'), handleItemScan);
  try { await scanner.start(); }
  catch (e) {
    document.getElementById('co-items-status').textContent = 'Camera error — ' + e.message;
  }
}

function renderOrderSummary() {
  const wrap = document.getElementById('co-order-summary');
  if (!wrap || !_barrioDetail) return;
  const orders = _barrioDetail.equipment_orders || [];
  if (!orders.length) return;
  const scannedByType = {};
  for (const item of scannedItems) {
    if (item.equipment_type_id)
      scannedByType[item.equipment_type_id] = (scannedByType[item.equipment_type_id] || 0) + 1;
  }
  wrap.innerHTML = `
    <div class="card" style="padding:.75rem 1rem">
      <div class="card-label" style="margin-bottom:.4rem">${__('equipmentOrdered')}</div>
      ${orders.map(o => {
        const scanned = scannedByType[o.equipment_type_id] || 0;
        const met  = scanned >= o.quantity_ordered;
        const over = scanned > o.quantity_ordered;
        const color = over ? 'var(--warn)' : met ? 'var(--success,#22c55e)' : 'var(--text2)';
        const icon  = over ? ' ⚠' : met ? ' ✓' : '';
        return `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:.2rem">
          <span>${_esc(o.type_name)}</span>
          <span style="color:${color};font-weight:${met ? '600' : '400'}">${scanned} / ${o.quantity_ordered}${icon}</span>
        </div>`;
      }).join('')}
    </div>`;
}

async function handleItemScan(qr) {
  const stat = document.getElementById('co-items-status');
  if (scannedItems.find(i => i.qr === qr)) {
    const existing = scannedItems.find(i => i.qr === qr);
    scanOverlay.show({
      state: 'warning', title: existing.name, subtitle: __('alreadyInList'),
      buttons: [
        { label: __('continueScanning'), action: () => { scanOverlay.hide(); restartItemScanner(); } },
        { label: _c('undo'),             action: () => { scanOverlay.hide(); restartItemScanner(); } },
      ],
    });
    return;
  }

  // Detect person QR scanned into item scanner — warn and ignore
  try {
    const url = new URL(qr);
    if (url.searchParams.has('person')) {
      scanOverlay.show({
        state: 'warning',
        title: 'Person QR detected',
        subtitle: 'Scan equipment QR codes here, not person QRs',
        buttons: [{ label: _c('ok'), action: () => { scanOverlay.hide(); restartItemScanner(); } }],
      });
      return;
    }
    if (url.pathname === '/shift' && url.searchParams.has('token')) {
      scanOverlay.show({
        state: 'warning',
        title: 'Shift QR detected',
        subtitle: "This is a volunteer shift login code — scan it with your phone's camera app, not here",
        buttons: [{ label: _c('ok'), action: () => { scanOverlay.hide(); restartItemScanner(); } }],
      });
      return;
    }
  } catch { /* not a URL */ }

  if (stat) stat.textContent = 'Looking up…';
  try {
    let item;
    if (!navigator.onLine) {
      const cached = localStorage.getItem('barrio_item:' + qr);
      if (cached) item = JSON.parse(cached);
    }
    if (!item) {
      item = await get('/items/lookup', { qr });
      try { localStorage.setItem('barrio_item:' + qr, JSON.stringify(item)); } catch {}
    }

    let warnMsg = null;
    if (item.status === 'checked-out') {
      if (item.current_person?.name) warnMsg = `Out to ${item.current_person.name}`;
      else if (item.current_barrio?.name) warnMsg = `Out to ${item.current_barrio.name}`;
      else if (item.current_artist?.name) warnMsg = `Out to ${item.current_artist.name}`;
      else if (item.current_dept?.name) warnMsg = `Out to ${item.current_dept.name}`;
    }

    const entry = { qr, name: item.name, category: item.category, equipment_type_id: item.equipment_type_id ?? null, warn: warnMsg };

    const doAdd = () => { scannedItems.push(entry); renderScannedList(); renderOrderSummary(); };
    const doContinue = () => { doAdd(); if (stat) stat.textContent = ''; scanOverlay.hide(); restartItemScanner(); };
    const doDone     = () => { doAdd(); scanOverlay.hide(); goStep3(); };
    const doUndo     = () => { if (stat) stat.textContent = ''; scanOverlay.hide(); restartItemScanner(); };

    scanOverlay.show({
      state: entry.warn ? 'warning' : 'success',
      title: item.name,
      subtitle: entry.warn ?? item.category ?? null,
      buttons: [
        { label: __('continueScanning'), action: doContinue },
        ...(scannedItems.length >= 1 ? [{ label: __('doneScanning'), action: doDone }] : []),
        { label: _c('undo'), action: doUndo },
      ],
    });
  } catch (e) {
    const doOK = () => { if (stat) stat.textContent = ''; scanOverlay.hide(); restartItemScanner(); };
    const doManual = () => {
      scanOverlay.showManualEntry({
        placeholder: __('typeQr'),
        onSubmit: (typed) => handleItemScan(typed),
        onCancel: doOK,
      });
    };

    if (!e.status && !navigator.onLine) {
      const doAddAnyway = () => {
        scannedItems.push({ qr, name: qr, category: null, equipment_type_id: null, warn: null });
        renderScannedList(); renderOrderSummary();
        if (stat) stat.textContent = ''; scanOverlay.hide(); restartItemScanner();
      };
      scanOverlay.show({
        state: 'warning', title: _c('offline'), subtitle: __('itemUnavailable'),
        buttons: [{ label: 'Add Anyway', action: doAddAnyway }, { label: _c('cancel'), action: doOK }],
      });
      return;
    }
    scanOverlay.show({
      state: 'error', title: _c('notFound'),
      subtitle: e.status === 404 ? __('qrNotFound') : __('lookupFailed'),
      buttons: [{ label: _c('ok'), action: doOK }, { label: _c('enterManually'), action: doManual }],
    });
  }
}

async function restartItemScanner() {
  const video = document.getElementById('co-items-video');
  if (!video) return;
  scanner = new Scanner(video, handleItemScan);
  try { await scanner.start(); } catch { /* camera closed */ }
}

function removeItem(qr) {
  scannedItems = scannedItems.filter(i => i.qr !== qr);
  renderScannedList();
  renderOrderSummary();
}

function renderScannedList() {
  const list  = document.getElementById('co-item-list');
  const count = document.getElementById('co-count');
  const btn   = document.getElementById('co-next2');
  if (!list) return;
  count.textContent = scannedItems.length;
  btn.disabled = scannedItems.length === 0;
  if (!scannedItems.length) {
    list.innerHTML = `<div class="empty-list">${__('noItems')}</div>`;
    return;
  }
  list.innerHTML = scannedItems.map(i => `
    <div class="item-row">
      <div class="item-row-info">
        <div class="item-row-name">
          ${_esc(i.name)}
          ${i.warn ? `<span class="warn-tag">${_esc(i.warn)}</span>` : ''}
        </div>
        <div class="item-row-sub">${_esc(i.qr)}</div>
      </div>
      <button class="remove-btn" onclick="window._co.removeItem('${_escAttr(i.qr)}')" title="Remove">×</button>
    </div>
  `).join('');
}

// ─── Step 3: Review & finalise ─────────────────────────────────────────────────

function goStep3() {
  const container = document.getElementById('tab-checkout');
  step = 3;
  stopScanner();

  const hasWarns    = scannedItems.some(i => i.warn);
  const needArrival = mode === 'sub_barrio' && selectedEntity.arrival_status === 'expected';

  let arrivalForm = '';
  if (needArrival && _consumableTypes.length) {
    const entitlements = _barrioDetail?.entitlements || [];
    const itemInputs = _consumableTypes.map(ct => {
      const existing  = entitlements.find(e => e.type_id === ct.id);
      const purchased = existing?.purchased ?? 0;
      const remaining = existing?.remaining ?? purchased;
      const defaultVal = remaining > 0 ? remaining : 0;
      return `
        <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:.5rem">
          <label style="flex:1;font-size:14px;color:var(--text);margin:0">
            ${_esc(ct.name)}
            ${purchased > 0 ? `<span style="font-size:12px;color:var(--text3)">(${purchased} purchased)</span>` : ''}
          </label>
          <input type="number" class="arrival-cons-input" data-type-id="${ct.id}"
            min="0" value="${defaultVal}" inputmode="numeric" style="max-width:90px">
        </div>`;
    }).join('');
    arrivalForm = `
      <div class="arrival-form-section">
        <div class="card-label">${__('recordArrival')}</div>
        ${itemInputs}
        <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text);margin:.25rem 0">
          <input type="checkbox" id="co-orientation" style="width:auto;margin:0;accent-color:var(--accent)">
          ${__('orientation')}
        </label>
      </div>`;
  } else if (needArrival) {
    arrivalForm = `
      <div class="arrival-form-section">
        <div class="card-label">${t('barrios', 'recordArrival')}</div>
        <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text);margin-bottom:.25rem">
          <input type="checkbox" id="co-orientation" style="width:auto;margin:0;accent-color:var(--accent)">
          ${__('orientation')}
        </label>
      </div>`;
  }

  const labelBadge = deptLabel
    ? `<div style="font-size:13px;color:var(--text2);margin-top:.4rem">Label: <strong>${_esc(deptLabel)}</strong></div>`
    : '';

  container.innerHTML = `
    ${stepsHTML(3)}
    <div class="card">
      <div class="card-label">Review</div>
      <div class="camp-badge"><span class="camp-badge-dot"></span>${_esc(selectedEntity.name)}</div>
      ${labelBadge}
      <div class="summary-count">${scannedItems.length}</div>
      <div class="summary-sub">item${scannedItems.length !== 1 ? 's' : ''} to lend</div>
      <div id="co-review-list">
        ${scannedItems.map(i => `
          <div class="item-row">
            <div class="item-row-info">
              <div class="item-row-name">
                ${_esc(i.name)}
                ${i.warn ? `<span class="warn-tag">${_esc(i.warn)}</span>` : ''}
              </div>
              <div class="item-row-sub">${_esc(i.qr)}</div>
            </div>
          </div>`).join('')}
      </div>
      ${hasWarns ? '<div style="font-size:12px;color:var(--warn);margin-top:.75rem;font-style:italic">Items already lent will be force-transferred</div>' : ''}
      ${arrivalForm}
    </div>
    ${isSubMode() ? `<div id="co-location-row" style="display:flex;align-items:center;gap:.75rem;margin-bottom:.5rem">
      <button class="btn btn-sm btn-outline" id="co-loc-btn">📍 Capture location</button>
      <span id="co-loc-status" style="font-size:13px;color:var(--text3)">Optional</span>
    </div>` : ''}
    ${mode === 'sub_barrio' ? `<div id="co-barrio-loc-row" style="display:flex;align-items:center;gap:8px;margin-bottom:.75rem">
      <input type="checkbox" id="co-apply-barrio-loc" checked style="width:auto;margin:0;accent-color:var(--accent)">
      <label for="co-apply-barrio-loc" style="font-size:13px;color:var(--text2)">Set item location from ${_esc(selectedEntity.name)}'s storage location (used if no GPS captured above)</label>
    </div>` : ''}
    <button class="btn primary" id="co-confirm" onclick="window._co.confirm()">${__('reviewLend')}</button>
    <button class="btn ghost" onclick="window._co.back()">${_c('back')}</button>
  `;
  window._co = { back: goStep2, confirm: finalise };

  if (isSubMode()) {
    document.getElementById('co-loc-btn')?.addEventListener('click', captureCheckoutLocation);
  }
}

// ─── Location capture ──────────────────────────────────────────────────────────

function isSubMode() {
  return mode === 'sub_barrio' || mode === 'sub_artist';
}

function captureCheckoutLocation() {
  const btn    = document.getElementById('co-loc-btn');
  const status = document.getElementById('co-loc-status');
  if (!navigator.geolocation) {
    if (status) status.textContent = 'Geolocation not supported';
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Locating…'; }
  navigator.geolocation.getCurrentPosition(
    pos => {
      capturedLocation = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      if (status) status.textContent = `📍 ${capturedLocation.latitude.toFixed(5)}, ${capturedLocation.longitude.toFixed(5)}`;
      if (btn) { btn.disabled = false; btn.textContent = '📍 Update'; }
    },
    () => {
      if (status) status.textContent = 'Location unavailable';
      if (btn) { btn.disabled = false; btn.textContent = '📍 Capture location'; }
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ─── Finalise ──────────────────────────────────────────────────────────────────

async function finalise() {
  const btn = document.getElementById('co-confirm');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Processing…';

  const user    = getCurrentUser();
  const itemQrs = scannedItems.map(i => i.qr);
  const label   = deptLabel || undefined;

  try {
    let result;

    if (mode === 'dept') {
      result = await post('/checkout', { dept_id: selectedEntity.id, item_qrs: itemQrs, dept_label: label, force: true });

    } else if (mode === 'person_prod') {
      result = await post('/person-checkout', { person_qr: selectedEntity.qr_token, item_qrs: itemQrs, dept_label: label, force: true });

    } else if (mode === 'sub_person') {
      const deptId = (user?.dept_ids || [])[0] ?? null;
      result = await post('/sub-person-checkout', { dept_id: deptId, person_qr: selectedEntity.qr_token, item_qrs: itemQrs, dept_label: label, force: true });

    } else {
      // sub_barrio or sub_artist
      const deptId = (user?.dept_ids || [])[0] ?? null;
      const payload = { dept_id: deptId, item_qrs: itemQrs, dept_label: label, force: true };
      if (mode === 'sub_barrio') {
        payload.barrio_id = selectedEntity.id;
        payload.apply_barrio_location = document.getElementById('co-apply-barrio-loc')?.checked ?? true;
      } else {
        payload.artist_id = selectedEntity.id;
      }
      if (capturedLocation) {
        payload.latitude  = capturedLocation.latitude;
        payload.longitude = capturedLocation.longitude;
      }
      result = await post('/sub-checkout', payload);
    }

    if (result.__offline) {
      toast(_c('offlineSaved'));
      const container = document.getElementById('tab-checkout');
      renderStep1(container);
      return;
    }

    const failed = result.results?.filter(r => !r.success) ?? [];
    if (failed.length) toast(`${failed.length} item(s) failed to lend`);
    else if (result.barrio_location_note) toast(result.barrio_location_note);
    else toast(__('success').replace('[N]', scannedItems.length).replace('[BARRIO]', selectedEntity.name));

    // Record barrio arrival if applicable
    if (mode === 'sub_barrio' && selectedEntity.arrival_status === 'expected') {
      const orient = document.getElementById('co-orientation')?.checked || false;
      const items  = [];
      document.querySelectorAll('.arrival-cons-input').forEach(inp => {
        const qty = parseInt(inp.value || '0', 10);
        if (qty > 0) items.push({ type_id: +inp.dataset.typeId, quantity: qty });
      });
      try {
        await post('/barrio-arrival', { barrio_id: selectedEntity.id, items, orientation_done: orient });
        toast(t('barrios', 'arrivalDone').replace('[BARRIO]', selectedEntity.name));
        selectedEntity.arrival_status = 'on-site';
      } catch { /* non-fatal */ }
    }

    const container = document.getElementById('tab-checkout');
    renderStep1(container);
    if (!isPersonMode()) {
      // Reload entity list (not needed for person mode since list is dynamic search)
      loadEntityList(container);
    }

  } catch (e) {
    if (e.__offline) {
      toast(_c('offlineSaved'));
      const container = document.getElementById('tab-checkout');
      renderStep1(container);
    } else {
      toast('Error: ' + e.message);
      const b = document.getElementById('co-confirm');
      if (b) { b.disabled = false; b.textContent = __('reviewLend'); }
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function stopScanner() {
  if (scanner) { scanner.stop(); scanner = null; }
}

function stepsHTML(active) {
  const steps = [modeStep1Title(), __('step2'), __('step3')];
  return '<div class="steps">' + steps.map((label, i) => {
    const n   = i + 1;
    const cls = n < active ? 'done' : n === active ? 'active' : '';
    const num = n < active ? '✓' : n;
    return (i > 0 ? '<div class="step-line"></div>' : '') +
      `<div class="step ${cls}"><div class="step-num">${num}</div>${label}</div>`;
  }).join('') + '</div>';
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _escAttr(s) {
  return String(s ?? '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
