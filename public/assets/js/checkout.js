/**
 * Check-out tab — 3-step flow.
 * Step 1: select barrio  |  Step 2: scan items  |  Step 3: review & finalize
 */

import { get, post } from './api.js';
import { Scanner } from './scanner.js';
import { toast } from './app.js';
import { scanOverlay } from './scan-overlay.js';

let step         = 1;
let selectedCamp = null;   // { id, name }
let campList     = [];
let scannedItems = [];     // [{ qr, name, category, warn }]
let scanner      = null;

export function init(container, preselectedBarrioId = null) {
  renderStep1(container);
  loadCamps(container, preselectedBarrioId);
}

async function loadCamps(container, preselectedBarrioId = null) {
  try {
    const data = await get('/camps');
    campList = data.camps || [];
    renderChips(container);
    if (preselectedBarrioId) {
      const match = campList.find(c => String(c.id) === String(preselectedBarrioId));
      if (match) {
        selectCamp(match.id, match.name);
        toast('Checking out to: ' + match.name);
        await goStep2();
      }
    }
  } catch (e) {
    toast('Could not load barrios: ' + e.message);
  }
}

// ─── Step 1: Select barrio ────────────────────────────────────────────────

function renderStep1(container) {
  step = 1;
  selectedCamp = null;
  scannedItems = [];
  stopScanner();

  container.innerHTML = `
    ${stepsHTML(1)}
    <div class="card">
      <div class="card-label">Select barrio</div>
      <div class="camp-chip-wrap" id="co-chips"></div>
      <div class="divider"><span>or scan barrio QR</span></div>
      <div class="video-wrap" style="display:none" id="co-camp-wrap">
        <video id="co-camp-video" playsinline muted></video>
        <div class="scan-overlay"><div class="scan-frame"><div class="scan-line"></div></div></div>
      </div>
      <div class="scan-status" id="co-camp-status"></div>
      <button class="btn" id="co-scan-camp-btn" onclick="window._co.toggleCampScan()">Scan barrio QR</button>
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
    `<button class="camp-chip${selectedCamp?.id === c.id ? ' selected' : ''}"
      onclick="window._co.selectCamp(${c.id}, '${c.name.replace(/'/g, "\\'")}')">${c.name}</button>`
  ).join('');
  window._co.selectCamp = selectCamp;
}

function selectCamp(id, name) {
  selectedCamp = { id, name };
  const chips = document.querySelectorAll('.camp-chip');
  chips.forEach(c => c.classList.toggle('selected', c.textContent === name));
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
    btn.textContent = 'Scan barrio QR';
    return;
  }

  wrap.style.display = '';
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

function showBarrioSuccess(match, wrap, btn, stat) {
  const doConfirm = () => {
    selectCamp(match.id, match.name);
    wrap.style.display = 'none';
    btn.textContent = 'Scan barrio QR';
    stat.textContent = '';
    scanOverlay.hide();
    goStep2();
  };
  const doUndo = () => {
    scanOverlay.hide();
    scanner = null;
    toggleCampScan();
  };

  scanOverlay.show({
    state: 'success',
    title: match.name,
    subtitle: null,
    buttons: [
      { label: 'Continue to Items', action: doConfirm },
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

// ─── Step 2: Scan items ───────────────────────────────────────────────────

async function goStep2() {
  if (!selectedCamp) return;
  const container = document.getElementById('tab-checkout');
  step = 2;
  stopScanner();

  container.innerHTML = `
    ${stepsHTML(2)}
    <div class="camp-badge"><span class="camp-badge-dot"></span>${selectedCamp.name}</div>
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
      <button class="btn primary" id="co-next2" disabled style="flex:2" onclick="window._co.goStep3()">Review &amp; finalise</button>
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
    const item = await get('/items/lookup', { qr });
    const entry = {
      qr,
      name: item.name,
      category: item.category,
      warn: item.status === 'checked-out' ? `Out to ${item.current_barrio?.name}` : null,
    };

    const doAdd = () => {
      scannedItems.push(entry);
      renderScannedList();
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

// ─── Step 3: Review & finalise ────────────────────────────────────────────

function goStep3() {
  const container = document.getElementById('tab-checkout');
  step = 3;
  stopScanner();

  const hasWarns = scannedItems.some(i => i.warn);

  container.innerHTML = `
    ${stepsHTML(3)}
    <div class="card">
      <div class="card-label">Review</div>
      <div class="camp-badge"><span class="camp-badge-dot"></span>${selectedCamp.name}</div>
      <div class="summary-count">${scannedItems.length}</div>
      <div class="summary-sub">item${scannedItems.length !== 1 ? 's' : ''} to check out</div>
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
      ${hasWarns ? '<div style="font-size:12px;color:var(--warn);margin-top:.75rem;font-style:italic">Items already checked out will be force-transferred</div>' : ''}
    </div>
    <button class="btn primary" id="co-confirm" onclick="window._co.confirm()">Confirm check out</button>
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

    const failed = result.results?.filter(r => !r.success) ?? [];

    if (failed.length) {
      toast(`${failed.length} item(s) failed to check out`);
    } else {
      toast(`Checked out ${scannedItems.length} item(s) to ${selectedCamp.name}`);
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
      if (btn) { btn.disabled = false; btn.textContent = 'Confirm check out'; }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

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
