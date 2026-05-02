/**
 * Lend tab — 3-step flow.
 * Step 1: select barrio  |  Step 2: scan items  |  Step 3: review & lend
 */

import { get, post } from './api.js?v=1.0.1';
import { Scanner } from './scanner.js?v=1.0.0';
import { toast, switchTab } from './app.js?v=1.0.1';
import { scanOverlay } from './scan-overlay.js?v=1.0.0';

let step              = 1;
let selectedCamp      = null;   // { id, name, arrival_status }
let campList          = [];
let scannedItems      = [];     // [{ qr, name, category, equipment_type_id, warn }]
let scanner           = null;
let _consumableTypes  = [];     // cached from /consumable-types
let _barrioDetail     = null;   // cached GET /barrios/:id (entitlements + equipment_orders)

export function init(container, preselectedBarrioId = null) {
  renderStep1(container);
  loadCamps(container, preselectedBarrioId);
}

async function loadCamps(container, preselectedBarrioId = null) {
  try {
    const [campsData, typesData] = await Promise.all([
      get('/camps'),
      get('/consumable-types'),
    ]);
    campList         = campsData.camps  || [];
    _consumableTypes = typesData.types  || [];
    try { localStorage.setItem('barrio_camps', JSON.stringify(campList)); } catch {}
    try { localStorage.setItem('barrio_consumable_types', JSON.stringify(_consumableTypes)); } catch {}
    renderChips(container);
    if (preselectedBarrioId) {
      const match = campList.find(c => String(c.id) === String(preselectedBarrioId));
      if (match) showBarrioSuccess(match);
    }
  } catch (e) {
    if (!navigator.onLine) {
      try {
        const cc = localStorage.getItem('barrio_camps');
        if (cc) campList = JSON.parse(cc);
        const ct = localStorage.getItem('barrio_consumable_types');
        if (ct) _consumableTypes = JSON.parse(ct);
      } catch {}
      if (campList.length) {
        renderChips(container);
        if (preselectedBarrioId) {
          const match = campList.find(c => String(c.id) === String(preselectedBarrioId));
          if (match) showBarrioSuccess(match);
        }
        return;
      }
    }
    toast('Could not load barrios: ' + e.message);
  }
}

// ─── Step 1: Select barrio ────────────────────────────────────────────────────

function renderStep1(container) {
  step           = 1;
  selectedCamp   = null;
  scannedItems   = [];
  _barrioDetail  = null;
  stopScanner();

  container.innerHTML = `
    ${stepsHTML(1)}
    <div class="card">
      <div class="card-label">Select barrio</div>
      <div class="video-wrap" style="display:none" id="co-camp-wrap">
        <video id="co-camp-video" playsinline muted></video>
        <div class="scan-overlay"><div class="scan-frame"><div class="scan-line"></div></div></div>
      </div>
      <div class="scan-status" style="display:none" id="co-camp-status"></div>
      <button class="btn" id="co-scan-camp-btn" onclick="window._co.toggleCampScan()">Scan barrio QR</button>
      <div class="divider"><span>or select:</span></div>
      <div class="camp-chip-wrap" id="co-chips"></div>
    </div>
    <button class="btn primary" id="co-next1" disabled onclick="window._co.goStep2()">Continue</button>
  `;

  window._co = { toggleCampScan, goStep2 };
  renderChips(container);
}

function renderChips(container) {
  const wrap = container.querySelector('#co-chips');
  if (!wrap) return;
  if (!campList.length) {
    wrap.innerHTML = '<span style="font-size:13px;color:var(--text3);font-style:italic">No barrios configured</span>';
    return;
  }
  wrap.innerHTML = campList.map(c =>
    `<button class="camp-chip ${selectedCamp?.id === c.id ? ' selected' : ''}" data-id="${c.id}"
      onclick="window._co.selectCamp(${c.id}, '${c.name.replace(/'/g, "\\'")}', '${c.arrival_status}')"><span class="status-dot ${c.arrival_status}"></span> ${c.name}</button>`
  ).join('');
  window._co.selectCamp = selectCamp;
}

function selectCamp(id, name, arrival_status) {
  const status = arrival_status ?? campList.find(c => c.id === id)?.arrival_status ?? 'expected';
  selectedCamp = { id, name, arrival_status: status };
  const chips = document.querySelectorAll('.camp-chip');
  chips.forEach(c => c.classList.toggle('selected', Number(c.dataset.id) === id));
  const btn = document.getElementById('co-next1');
  if (btn) btn.disabled = false;
}

async function toggleCampScan() {
  const wrap = document.getElementById('co-camp-wrap');
  const btn  = document.getElementById('co-scan-camp-btn');
  const stat = document.getElementById('co-camp-status');

  if (scanner) {
    stopScanner();
    wrap.style.display = 'none';
    stat.style.display = 'none';
    btn.textContent = 'Scan barrio QR';
    return;
  }

  wrap.style.display = '';
  stat.style.display = '';
  btn.textContent = 'Cancel scan';
  stat.textContent = 'Aim camera at barrio QR code…';

  scanner = new Scanner(document.getElementById('co-camp-video'), (value) => {
    let scannedId = value;
    try {
      const url = new URL(value);
      scannedId = url.searchParams.get('barrio') ?? value;
    } catch { /* not a URL, use raw value */ }

    const match = campList.find(c =>
      c.name.toLowerCase() === value.toLowerCase() ||
      String(c.id) === value ||
      String(c.id) === scannedId
    );

    if (match) {
      showBarrioSuccess(match, wrap, btn, stat);
    } else {
      showBarrioError(wrap, btn, stat);
    }
  });

  try { await scanner.start(); }
  catch { stat.textContent = 'Camera error — check permissions'; scanner = null; }
}

function showBarrioSuccess(match, wrap = null, btn = null, stat = null) {
  const doConfirm = () => {
    selectCamp(match.id, match.name, match.arrival_status);
    if (wrap) wrap.style.display = 'none';
    if (btn) btn.textContent = 'Scan barrio QR';
    if (stat) stat.textContent = '';
    scanOverlay.hide();
    goStep2();
  };
  const doCheckInOnly = () => {
    scanOverlay.hide();
    switchTab('barrios', match.id);
  };
  const doUndo = () => {
    scanOverlay.hide();
    if (wrap && btn) {
      scanner = null;
      toggleCampScan();
    } else {
      window.location.href = '/';
    }
  };

  const checkInLabel = match.arrival_status === 'expected' ? 'Check In Without Lending' : 'Go to Barrio';

  scanOverlay.show({
    state: 'success',
    title: match.name,
    subtitle: null,
    buttons: [
      { label: 'Continue to Items', action: doConfirm },
      { label: checkInLabel, action: doCheckInOnly },
      { label: 'Undo', action: doUndo },
    ],
  });
}

function showBarrioError(wrap, btn, stat) {
  const doOK = () => {
    scanOverlay.hide();
    scanner = null;
    toggleCampScan();
  };
  const doManual = () => {
    scanOverlay.showManualEntry({
      placeholder: 'Type barrio name or ID',
      onSubmit: (typed) => {
        const m = campList.find(c =>
          c.name.toLowerCase() === typed.toLowerCase() ||
          String(c.id) === typed
        );
        if (m) {
          showBarrioSuccess(m, wrap, btn, stat);
        } else {
          scanOverlay.show({
            state: 'error',
            title: 'Not recognised',
            subtitle: `No barrio matches "${typed}"`,
            buttons: [
              { label: 'OK', action: doOK },
              { label: 'Enter Manually', action: doManual },
            ],
          });
        }
      },
      onCancel: doOK,
    });
  };

  scanOverlay.show({
    state: 'error',
    title: 'Not recognised',
    subtitle: 'Barrio QR not found',
    buttons: [
      { label: 'OK', action: doOK },
      { label: 'Enter Manually', action: doManual },
    ],
  });
}

// ─── Step 2: Scan items ───────────────────────────────────────────────────────

async function goStep2() {
  if (!selectedCamp) return;
  const container = document.getElementById('tab-checkout');
  step = 2;
  stopScanner();

  // Fetch barrio detail for equipment orders (non-blocking)
  _barrioDetail = null;
  get('/barrios/' + selectedCamp.id)
    .then(d => { _barrioDetail = d; renderOrderSummary(); })
    .catch(() => {});

  const arrivalPrompt = selectedCamp.arrival_status === 'expected' ? `
    <div class="card arrival-prompt-card">
      <div class="card-label">Barrio not yet checked in</div>
      <div style="font-size:13px;color:var(--warn)">Arrival will be recorded on confirmation.</div>
    </div>
  ` : '';

  container.innerHTML = `
    ${stepsHTML(2)}
    <div class="camp-badge"><span class="camp-badge-dot"></span>${selectedCamp.name}</div>
    ${arrivalPrompt}
    <div id="co-order-summary"></div>
    <div class="card">
      <div class="card-label">Scan items</div>
      <div class="video-wrap" id="co-items-wrap">
        <video id="co-items-video" playsinline muted></video>
        <div class="scan-overlay"><div class="scan-frame"><div class="scan-line"></div></div></div>
      </div>
      <div class="scan-status" id="co-items-status">Aim camera at item QR code…</div>
    </div>
    <div class="card" id="co-scanned-card">
      <div class="card-label">Scanned items (<span id="co-count">0</span>)</div>
      <div id="co-item-list"><div class="empty-list">No items scanned yet</div></div>
    </div>
    <div style="display:flex;gap:.5rem">
      <button class="btn ghost" style="flex:1" onclick="window._co.back()">Back</button>
      <button class="btn primary" id="co-next2" disabled style="flex:2" onclick="window._co.goStep3()">Review &amp; lend</button>
    </div>
  `;

  window._co = { back: () => renderStep1(container), goStep3, removeItem };
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

  // Count scanned items by equipment_type_id
  const scannedByType = {};
  for (const item of scannedItems) {
    if (item.equipment_type_id) {
      scannedByType[item.equipment_type_id] = (scannedByType[item.equipment_type_id] || 0) + 1;
    }
  }

  wrap.innerHTML = `
    <div class="card" style="padding:.75rem 1rem">
      <div class="card-label" style="margin-bottom:.4rem">Equipment ordered</div>
      ${orders.map(o => {
        const scanned = scannedByType[o.equipment_type_id] || 0;
        const met     = scanned >= o.quantity_ordered;
        const over    = scanned > o.quantity_ordered;
        const color   = over ? 'var(--warn)' : met ? 'var(--success,#22c55e)' : 'var(--text2)';
        const icon    = over ? ' ⚠' : met ? ' ✓' : '';
        return `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:.2rem">
          <span>${_esc(o.type_name)}</span>
          <span style="color:${color};font-weight:${met ? '600' : '400'}">${scanned} / ${o.quantity_ordered}${icon}</span>
        </div>`;
      }).join('')}
    </div>
  `;
}

async function handleItemScan(qr) {
  const stat = document.getElementById('co-items-status');
  if (scannedItems.find(i => i.qr === qr)) {
    const existing = scannedItems.find(i => i.qr === qr);
    scanOverlay.show({
      state: 'warning',
      title: existing.name,
      subtitle: 'Already in list',
      buttons: [
        { label: 'Continue Scanning', action: () => { scanOverlay.hide(); restartItemScanner(); } },
        { label: 'Undo', action: () => { scanOverlay.hide(); restartItemScanner(); } },
      ],
    });
    return;
  }

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

    const entry = {
      qr,
      name:              item.name,
      category:          item.category,
      equipment_type_id: item.equipment_type_id ?? null,
      warn: item.status === 'checked-out' ? `Out to ${item.current_barrio?.name}` : null,
    };

    const doAdd = () => {
      scannedItems.push(entry);
      renderScannedList();
      renderOrderSummary();
    };

    const doContinue = () => {
      doAdd();
      if (stat) stat.textContent = '';
      scanOverlay.hide();
      restartItemScanner();
    };
    const doDone = () => {
      doAdd();
      scanOverlay.hide();
      goStep3();
    };
    const doUndo = () => {
      if (stat) stat.textContent = '';
      scanOverlay.hide();
      restartItemScanner();
    };

    const buttons = [
      { label: 'Continue Scanning', action: doContinue },
      ...(scannedItems.length >= 1 ? [{ label: 'Done Scanning', action: doDone }] : []),
      { label: 'Undo', action: doUndo },
    ];

    scanOverlay.show({
      state: entry.warn ? 'warning' : 'success',
      title: item.name,
      subtitle: entry.warn ?? item.category ?? null,
      buttons,
    });
  } catch (e) {
    const doOK = () => {
      if (stat) stat.textContent = '';
      scanOverlay.hide();
      restartItemScanner();
    };
    const doManual = () => {
      scanOverlay.showManualEntry({
        placeholder: 'Type item QR code',
        onSubmit: (typed) => handleItemScan(typed),
        onCancel: doOK,
      });
    };

    if (!e.status && !navigator.onLine) {
      const doAddAnyway = () => {
        scannedItems.push({ qr, name: qr, category: null, equipment_type_id: null, warn: null });
        renderScannedList();
        renderOrderSummary();
        if (stat) stat.textContent = '';
        scanOverlay.hide();
        restartItemScanner();
      };
      scanOverlay.show({
        state: 'warning',
        title: 'Offline',
        subtitle: 'Item details unavailable — add by QR?',
        buttons: [
          { label: 'Add Anyway', action: doAddAnyway },
          { label: 'Cancel', action: doOK },
        ],
      });
      return;
    }

    scanOverlay.show({
      state: 'error',
      title: 'Not found',
      subtitle: e.status === 404 ? 'QR not in inventory' : 'Lookup failed',
      buttons: [
        { label: 'OK', action: doOK },
        { label: 'Enter Manually', action: doManual },
      ],
    });
  }
}

async function restartItemScanner() {
  const video = document.getElementById('co-items-video');
  if (!video) return;
  scanner = new Scanner(video, handleItemScan);
  try { await scanner.start(); }
  catch {/* camera closed */}
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
    list.innerHTML = '<div class="empty-list">No items scanned yet</div>';
    return;
  }

  list.innerHTML = scannedItems.map(i => `
    <div class="item-row">
      <div class="item-row-info">
        <div class="item-row-name">
          ${i.name}
          ${i.warn ? `<span class="warn-tag">${i.warn}</span>` : ''}
        </div>
        <div class="item-row-sub">${i.qr}</div>
      </div>
      <button class="remove-btn" onclick="window._co.removeItem('${i.qr}')" title="Remove">×</button>
    </div>
  `).join('');
}

// ─── Step 3: Review & finalise ────────────────────────────────────────────────

function goStep3() {
  const container = document.getElementById('tab-checkout');
  step = 3;
  stopScanner();

  const hasWarns    = scannedItems.some(i => i.warn);
  const needArrival = selectedCamp.arrival_status === 'expected';

  // Build arrival distribution form from entitlements (or all consumable types if none set)
  let arrivalForm = '';
  if (needArrival && _consumableTypes.length) {
    const entitlements = _barrioDetail?.entitlements || [];
    const itemInputs = _consumableTypes.map(ct => {
      const existing = entitlements.find(e => e.type_id === ct.id);
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
        <div class="card-label">Record Arrival — Consumables Given</div>
        ${itemInputs}
        <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text);margin-bottom:.25rem;margin-top:.25rem">
          <input type="checkbox" id="co-orientation" style="width:auto;margin:0;accent-color:var(--accent)">
          Orientation completed
        </label>
      </div>
    `;
  } else if (needArrival) {
    arrivalForm = `
      <div class="arrival-form-section">
        <div class="card-label">Record Arrival</div>
        <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text);margin-bottom:.25rem">
          <input type="checkbox" id="co-orientation" style="width:auto;margin:0;accent-color:var(--accent)">
          Orientation completed
        </label>
      </div>
    `;
  }

  container.innerHTML = `
    ${stepsHTML(3)}
    <div class="card">
      <div class="card-label">Review</div>
      <div class="camp-badge"><span class="camp-badge-dot"></span>${selectedCamp.name}</div>
      <div class="summary-count">${scannedItems.length}</div>
      <div class="summary-sub">item${scannedItems.length !== 1 ? 's' : ''} to lend</div>
      <div id="co-review-list">
        ${scannedItems.map(i => `
          <div class="item-row">
            <div class="item-row-info">
              <div class="item-row-name">
                ${i.name}
                ${i.warn ? `<span class="warn-tag">${i.warn}</span>` : ''}
              </div>
              <div class="item-row-sub">${i.qr}</div>
            </div>
          </div>
        `).join('')}
      </div>
      ${hasWarns ? '<div style="font-size:12px;color:var(--warn);margin-top:.75rem;font-style:italic">Items already lent will be force-transferred</div>' : ''}
      ${arrivalForm}
    </div>
    <button class="btn primary" id="co-confirm" onclick="window._co.confirm()">Confirm lend</button>
    <button class="btn ghost" onclick="window._co.back()">Back</button>
  `;

  window._co = {
    back: () => goStep2(),
    confirm: finalise,
  };
}

async function finalise() {
  const btn = document.getElementById('co-confirm');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Processing…';

  try {
    const result = await post('/checkout', {
      barrio_id: selectedCamp.id,
      item_qrs:  scannedItems.map(i => i.qr),
      force:     true,
    });

    if (result.__offline) {
      toast('Saved offline — will sync when connected');
      const container = document.getElementById('tab-checkout');
      renderStep1(container);
      loadCamps(container);
      return;
    }

    const failed = result.results?.filter(r => !r.success) ?? [];

    if (failed.length) {
      toast(`${failed.length} item(s) failed to lend`);
    } else {
      toast(`Lent ${scannedItems.length} item(s) to ${selectedCamp.name}`);
    }

    // If this barrio was expected, also record arrival
    if (selectedCamp.arrival_status === 'expected') {
      const orient = document.getElementById('co-orientation')?.checked || false;

      // Gather consumable distribution amounts
      const items = [];
      document.querySelectorAll('.arrival-cons-input').forEach(inp => {
        const qty = parseInt(inp.value || '0', 10);
        if (qty > 0) items.push({ type_id: +inp.dataset.typeId, quantity: qty });
      });

      try {
        await post('/barrio-arrival', {
          barrio_id:        selectedCamp.id,
          items,
          orientation_done: orient,
        });
        toast('Arrival recorded for ' + selectedCamp.name);
        selectedCamp.arrival_status = 'on-site';
      } catch {
        // Non-fatal — equipment was lent; arrival may have been recorded by another device
      }
    }

    const container = document.getElementById('tab-checkout');
    renderStep1(container);
    loadCamps(container);
  } catch (e) {
    if (e.__offline) {
      toast('Saved offline — will sync when connected');
      const container = document.getElementById('tab-checkout');
      renderStep1(container);
    } else {
      toast('Error: ' + e.message);
      const btn = document.getElementById('co-confirm');
      if (btn) { btn.disabled = false; btn.textContent = 'Confirm lend'; }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stopScanner() {
  if (scanner) { scanner.stop(); scanner = null; }
}

function stepsHTML(active) {
  const steps = ['Select barrio', 'Scan items', 'Finalise'];
  return '<div class="steps">' + steps.map((label, i) => {
    const n    = i + 1;
    const cls  = n < active ? 'done' : n === active ? 'active' : '';
    const num  = n < active ? '✓' : n;
    return (i > 0 ? '<div class="step-line"></div>' : '') +
      `<div class="step ${cls}"><div class="step-num">${num}</div>${label}</div>`;
  }).join('') + '</div>';
}

function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
