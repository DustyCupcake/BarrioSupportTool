/**
 * Voucher validation mode — used by validator-role users (strict) and
 * staff in the Scan In tab toggle (non-strict).
 *
 * strictMode = true  → validators only; non-voucher QR shows red error
 * strictMode = false → staff toggle; non-voucher QR shows yellow warning
 *
 * Batch flow:
 *  1. Scan voucher → marks as `used` immediately → add to batch
 *  2. Cross-barrio warning if new voucher is from a different barrio
 *  3. Batch view shows list + Confirm fill / Flag incomplete
 *  4. Flagging requires a notes field describing the problem
 *  5. Batch persisted to localStorage so it survives page reloads
 */

import { get, post } from './api.js?v=1.0.1';
import { Scanner } from './scanner.js?v=1.0.0';
import { toast } from './app.js?v=1.0.1';
import { scanOverlay } from './scan-overlay.js?v=1.0.1';
import { t } from './i18n.js?v=1.0.0';

const __ = (key) => t('validate', key);
const _c = (key) => t('common', key);

const BATCH_KEY = 'barrio_validate_batch';

let scanner    = null;
let _container = null;
let _strict    = false;

// { qr, name, barrio_name, barrio_id }
let batch = [];

// Holds a newly-scanned item when validator is redirected to batch view first
let _pendingItem = null;

export function init(container, strictMode = false) {
  _container = container;
  _strict    = strictMode;
  batch      = loadBatch();

  if (batch.length > 0) {
    renderBatchView(container, strictMode, true);
  } else {
    render(container, strictMode);
  }
}

export function destroy() {
  if (scanner) { scanner.stop(); scanner = null; }
  saveBatch();
}

// ─── Batch persistence ────────────────────────────────────────────────────────

function loadBatch() {
  try {
    const raw = localStorage.getItem(BATCH_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveBatch() {
  try {
    localStorage.setItem(BATCH_KEY, JSON.stringify(batch));
  } catch { /* storage full — ignore */ }
}

function clearBatch() {
  batch = [];
  _pendingItem = null;
  try { localStorage.removeItem(BATCH_KEY); } catch { /* ignore */ }
}

// ─── Scanner view ─────────────────────────────────────────────────────────────

function render(container, strictMode) {
  if (scanner) { scanner.stop(); scanner = null; }

  container.innerHTML = `
    <div class="card">
      <div class="card-label">${strictMode ? __('title') : t('checkin', 'modeVoucher')}</div>
      <div class="video-wrap" id="vl-video-wrap">
        <video id="vl-video" playsinline muted></video>
        <div class="scan-overlay"><div class="scan-frame"><div class="scan-line"></div></div></div>
      </div>
      <div class="scan-status" id="vl-status">${__('aimScanner')}</div>
      <button class="btn-text-link" id="vl-manual-btn" onclick="window._validate.manual()">${_c('enterManually')}</button>
      ${batch.length > 0 ? `
        <div class="vl-batch-peek">
          <span>${batch.length} voucher${batch.length > 1 ? 's' : ''} in batch</span>
          <button class="btn sm" onclick="window._validate.showBatch()">${__('viewBatch').replace('[N]', batch.length)}</button>
        </div>` : ''}
    </div>
  `;

  window._validate = {
    manual:    openManual,
    showBatch: () => { scanOverlay.hide(); renderBatchView(container, strictMode, false); },
  };

  startScanner(container, strictMode);
}

async function startScanner(container, strictMode) {
  const video = document.getElementById('vl-video');
  if (!video) return;
  scanner = new Scanner(video, (qr) => handleScan(qr, container, strictMode));
  try {
    await scanner.start();
  } catch (e) {
    const stat = document.getElementById('vl-status');
    if (stat) stat.textContent = _c('cameraError');
  }
}

// ─── Scan handling ────────────────────────────────────────────────────────────

async function handleScan(qr, container, strictMode) {
  const stat = document.getElementById('vl-status');
  if (stat) stat.textContent = _c('lookingUp');

  const doReset = () => {
    scanOverlay.hide();
    render(container, strictMode);
  };

  try {
    const item = await get('/items/lookup', { qr });

    if (!item.secure_qr) {
      if (strictMode) {
        scanOverlay.show({
          state: 'error',
          title: __('notAVoucher'),
          subtitle: 'This QR code is for equipment, not a voucher',
          buttons: [{ label: _c('ok'), action: doReset }],
        });
      } else {
        scanOverlay.show({
          state: 'warning',
          title: __('equipmentDetected'),
          subtitle: __('equipmentNote'),
          buttons: [{ label: _c('ok'), action: doReset }],
        });
      }
      return;
    }

    if (item.status === 'activated') {
      const doUse = async () => {
        scanOverlay.hide();
        await markUsed(qr, item, container, strictMode);
      };
      scanOverlay.show({
        state: 'success',
        title: __('validVoucher'),
        subtitle: item.current_group?.name ? `Checked out to ${item.current_group.name}` : 'Ready to use',
        buttons: [
          { label: 'Mark as used', action: doUse },
          { label: _c('undo'),     action: doReset },
        ],
      });
      return;
    }

    if (item.status === 'used') {
      scanOverlay.show({
        state: 'error',
        title: __('alreadyUsed'),
        subtitle: item.name,
        buttons: [{ label: _c('ok'), action: doReset }],
      });
      return;
    }

    if (item.status === 'checked-out') {
      scanOverlay.show({
        state: 'error',
        title: __('notActivated'),
        subtitle: 'Half-voucher not yet collected — barrio must register first',
        buttons: [{ label: _c('ok'), action: doReset }],
      });
      return;
    }

    scanOverlay.show({
      state: 'error',
      title: __('invalidVoucher'),
      subtitle: item.status === 'available' ? 'Not checked out to any barrio' : 'Voucher retired',
      buttons: [{ label: _c('ok'), action: doReset }],
    });

  } catch (e) {
    const doManual = () => {
      scanOverlay.showManualEntry({
        placeholder: t('activate', 'typeQr'),
        onSubmit: (typed) => handleScan(typed, container, strictMode),
        onCancel: doReset,
      });
    };

    scanOverlay.show({
      state: 'warning',
      title: t('activate', 'unreadable'),
      subtitle: e.status === 404 ? 'QR not recognised — enter code manually' : 'Lookup failed — check connection',
      buttons: [
        { label: _c('enterManually'), action: doManual },
        { label: _c('tryAgain'),      action: doReset },
      ],
    });
  }
}

async function markUsed(qr, item, container, strictMode) {
  try {
    const res = await post('/items/use', { item_qr: qr });
    if (!res.success) {
      toast(__('usedError'));
      render(container, strictMode);
      return;
    }
  } catch (e) {
    toast('Error: ' + e.message);
    render(container, strictMode);
    return;
  }

  const newEntry = {
    qr,
    name:       item.name,
    barrio_name: item.current_group?.name ?? '—',
    barrio_id:  item.current_group?.id ?? null,
  };

  // Check for cross-barrio mismatch
  const existingBarrioId = batch.find(b => b.barrio_id != null)?.barrio_id ?? null;
  if (batch.length > 0 && existingBarrioId != null && newEntry.barrio_id != null && newEntry.barrio_id !== existingBarrioId) {
    _pendingItem = newEntry;
    showCrossBarrioWarning(existingBarrioId, newEntry, container, strictMode);
    return;
  }

  batch.push(newEntry);
  saveBatch();

  // Success overlay — scan another or view batch
  const doScanAnother = () => { scanOverlay.hide(); render(container, strictMode); };
  const doBatch       = () => { scanOverlay.hide(); renderBatchView(container, strictMode, false); };

  scanOverlay.show({
    state:    'success',
    title:    __('validVoucher'),
    subtitle: `${newEntry.name}${newEntry.barrio_name !== '—' ? ' · ' + newEntry.barrio_name : ''}`,
    buttons: [
      { label: _c('scanAnother'),                        action: doScanAnother },
      { label: __('doneBatch').replace('[N]', batch.length), action: doBatch },
    ],
  });
}

// ─── Cross-barrio warning ─────────────────────────────────────────────────────

function showCrossBarrioWarning(existingBarrioId, newEntry, container, strictMode) {
  const existingBarrioName = batch.find(b => b.barrio_id === existingBarrioId)?.barrio_name ?? 'current batch';

  const doAddToBatch = () => {
    scanOverlay.hide();
    batch.push(_pendingItem);
    _pendingItem = null;
    saveBatch();
    render(container, strictMode);
  };

  const doConfirmFirst = () => {
    scanOverlay.hide();
    // Pending item stays in _pendingItem; after confirm it will be added as a fresh batch
    renderBatchView(container, strictMode, false);
  };

  const doFlagAndContinue = () => {
    scanOverlay.hide();
    // Flag the existing batch inline without a notes prompt, then start fresh
    flagBatchSilent(container, strictMode, () => {
      batch.push(_pendingItem);
      _pendingItem = null;
      saveBatch();
      render(container, strictMode);
    });
  };

  scanOverlay.show({
    state:    'warning',
    title:    __('differentBarrio'),
    subtitle: __('differentBarrioSub').replace('[BARRIO_A]', existingBarrioName).replace('[BARRIO_B]', newEntry.barrio_name),
    buttons: [
      { label: __('addToBatch'),           action: doAddToBatch },
      { label: __('confirmPreviousFirst'), action: doConfirmFirst },
      { label: __('flagFill'),             action: doFlagAndContinue },
    ],
  });
}

// ─── Batch view ───────────────────────────────────────────────────────────────

function renderBatchView(container, strictMode, isResume = false) {
  if (scanner) { scanner.stop(); scanner = null; }

  const rows = batch.map((b, i) =>
    `<div class="vl-batch-row">
       <span class="vl-batch-name">${escHtml(b.name)}</span>
       <span class="vl-batch-barrio">${escHtml(b.barrio_name)}</span>
     </div>`
  ).join('');

  container.innerHTML = `
    <div class="card">
      <div class="card-label">${__('batchTitle')}</div>
      ${isResume ? `<div class="vl-resume-notice">${__('resumeNotice')}</div>` : ''}
      <div class="vl-batch-list">${rows}</div>
      <div class="vl-batch-actions">
        <button class="btn" id="vl-scan-more">${_c('scanAnother')}</button>
        <button class="btn primary" id="vl-confirm">${__('confirmFill')}</button>
        <button class="btn danger"  id="vl-flag">${__('flagFill')}</button>
      </div>
      <div id="vl-flag-notes-wrap" class="vl-flag-notes-wrap" style="display:none">
        <label for="vl-flag-notes">${__('flagNotesLabel')}</label>
        <textarea id="vl-flag-notes" rows="3" placeholder="${__('flagNotesPlaceholder')}"></textarea>
        <div class="vl-flag-notes-actions">
          <button class="btn" id="vl-flag-cancel">${_c('cancel')}</button>
          <button class="btn danger" id="vl-flag-submit">Submit flag</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('vl-scan-more').onclick = () => {
    // If there's a pending cross-barrio item, start a fresh batch from it after batch view was shown
    if (_pendingItem) {
      batch.push(_pendingItem);
      _pendingItem = null;
      saveBatch();
    }
    render(container, strictMode);
  };

  document.getElementById('vl-confirm').onclick = () => confirmFill(container, strictMode);

  document.getElementById('vl-flag').onclick = () => {
    document.getElementById('vl-flag-notes-wrap').style.display = '';
    document.getElementById('vl-flag').style.display = 'none';
    document.getElementById('vl-flag-notes').focus();
  };

  document.getElementById('vl-flag-cancel').onclick = () => {
    document.getElementById('vl-flag-notes-wrap').style.display = 'none';
    document.getElementById('vl-flag').style.display = '';
    document.getElementById('vl-flag-notes').value = '';
  };

  document.getElementById('vl-flag-submit').onclick = () => flagFill(container, strictMode);
}

// ─── Confirm fill ─────────────────────────────────────────────────────────────

async function confirmFill(container, strictMode) {
  const qrs = batch.map(b => b.qr);
  const n   = qrs.length;

  try {
    const res = await post('/items/fill-confirm', { item_qrs: qrs, flagged: false });
    if (res.success) {
      toast(__('confirmSuccess').replace('[N]', n));
      clearBatch();
      render(container, strictMode);
      // If there was a cross-barrio pending item waiting, start a fresh batch
      if (_pendingItem) {
        batch.push(_pendingItem);
        _pendingItem = null;
        saveBatch();
        renderBatchView(container, strictMode, false);
      }
    } else {
      toast(__('confirmError'));
    }
  } catch (e) {
    toast('Error: ' + e.message);
  }
}

// ─── Flag fill ────────────────────────────────────────────────────────────────

async function flagFill(container, strictMode) {
  const notes = document.getElementById('vl-flag-notes')?.value?.trim() ?? '';
  if (!notes) {
    document.getElementById('vl-flag-notes').focus();
    return;
  }

  const qrs = batch.map(b => b.qr);
  const n   = qrs.length;

  try {
    const res = await post('/items/fill-confirm', { item_qrs: qrs, flagged: true, notes });
    if (res.success) {
      toast(__('flagSuccess').replace('[N]', n));
      clearBatch();
      render(container, strictMode);
      if (_pendingItem) {
        batch.push(_pendingItem);
        _pendingItem = null;
        saveBatch();
        renderBatchView(container, strictMode, false);
      }
    } else {
      toast(__('flagError'));
    }
  } catch (e) {
    toast('Error: ' + e.message);
  }
}

// Silent flag used from the cross-barrio warning (no notes prompt needed here —
// we call the regular flagFill prompt path via the batch view instead).
// This variant is called when the validator taps "Flag incomplete fill" in the
// cross-barrio overlay and wants to flag immediately before starting a new batch.
async function flagBatchSilent(container, strictMode, onDone) {
  const qrs = batch.map(b => b.qr);
  const n   = qrs.length;
  clearBatch();

  try {
    await post('/items/fill-confirm', { item_qrs: qrs, flagged: true, notes: 'Flagged via cross-barrio warning' });
    toast(__('flagSuccess').replace('[N]', n));
  } catch {
    toast(__('flagError'));
  }

  onDone();
}

// ─── Manual entry ─────────────────────────────────────────────────────────────

function openManual() {
  const doReset = () => {
    scanOverlay.hide();
    render(_container, _strict);
  };
  scanOverlay.showManualEntry({
    placeholder: t('activate', 'typeQr'),
    onSubmit: (typed) => handleScan(typed, _container, _strict),
    onCancel: doReset,
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
