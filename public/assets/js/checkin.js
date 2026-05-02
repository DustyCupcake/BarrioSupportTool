/**
 * Scan In tab — return equipment or validate vouchers.
 */

import { get, post } from './api.js?v=1.0.1';
import { Scanner } from './scanner.js?v=1.0.0';
import { toast } from './app.js?v=1.0.1';
import { scanOverlay } from './scan-overlay.js?v=1.0.0';
import { init as initValidate, destroy as destroyValidate } from './validate.js?v=1.0.1';
import { init as initActivate, destroy as destroyActivate } from './activate.js?v=1.0.0';

let scanner      = null;
let lastItem     = null;
let mode         = 'return'; // 'return' | 'validate' | 'activate'

export function init(container) {
  render(container);
}

export function destroy() {
  if (scanner) { scanner.stop(); scanner = null; }
  destroyValidate();
  destroyActivate();
}

function render(container) {
  lastItem = null;

  const toggleHTML = `
    <div class="mode-toggle-wrap">
      <div class="mode-toggle">
        <button ${mode === 'return'   ? 'class="active"' : ''} onclick="window._ci.setMode('return')">Return equipment</button>
        <button ${mode === 'validate' ? 'class="active"' : ''} onclick="window._ci.setMode('validate')">Validate voucher</button>
        <button ${mode === 'activate' ? 'class="active"' : ''} onclick="window._ci.setMode('activate')">Activate vouchers</button>
      </div>
    </div>
  `;

  window._ci = { setMode: (v) => setMode(v, container) };

  if (mode === 'validate') {
    container.innerHTML = toggleHTML;
    const inner = document.createElement('div');
    container.appendChild(inner);
    initValidate(inner, false);
    return;
  }

  if (mode === 'activate') {
    container.innerHTML = toggleHTML;
    const inner = document.createElement('div');
    container.appendChild(inner);
    initActivate(inner);
    return;
  }

  if (scanner) { scanner.stop(); scanner = null; }

  container.innerHTML = toggleHTML + `
    <div class="card">
      <div class="card-label">Scan item to return</div>
      <div class="video-wrap" id="ci-video-wrap">
        <video id="ci-video" playsinline muted></video>
        <div class="scan-overlay"><div class="scan-frame"><div class="scan-line"></div></div></div>
      </div>
      <div class="scan-status" id="ci-status">Aim camera at item QR code…</div>
    </div>
  `;

  startScanner(container);
}

function setMode(v, container) {
  mode = v;
  destroyValidate();
  destroyActivate();
  if (scanner) { scanner.stop(); scanner = null; }
  render(container);
}

async function startScanner(container) {
  const video = document.getElementById('ci-video');
  if (!video) return;
  scanner = new Scanner(video, (qr) => handleScan(qr, container));
  try {
    await scanner.start();
  } catch (e) {
    const stat = document.getElementById('ci-status');
    if (stat) stat.textContent = 'Camera error — ' + e.message;
  }
}

async function handleScan(qr, container) {
  const stat = document.getElementById('ci-status');
  if (stat) stat.textContent = 'Looking up…';

  const doReset = () => {
    scanOverlay.hide();
    render(container);
  };

  const doConfirmReturn = async () => {
    scanOverlay.hide();
    await confirmCheckin(qr, container);
  };

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

    lastItem = item;

    if (item.status === 'available') {
      scanOverlay.show({
        state: 'warning',
        title: item.name,
        subtitle: 'Already returned — no action needed',
        buttons: [
          { label: 'OK', action: doReset },
        ],
      });
    } else {
      scanOverlay.show({
        state: 'success',
        title: item.name,
        subtitle: item.current_barrio?.name ? `Checked out to ${item.current_barrio.name}` : item.category ?? null,
        buttons: [
          { label: 'Confirm Return', action: doConfirmReturn },
          { label: 'Undo', action: doReset },
        ],
      });
    }
  } catch (e) {
    const doManual = () => {
      scanOverlay.showManualEntry({
        placeholder: 'Type item QR code',
        onSubmit: (typed) => handleScan(typed, container),
        onCancel: doReset,
      });
    };

    if (!e.status && !navigator.onLine) {
      scanOverlay.show({
        state: 'warning',
        title: 'Offline',
        subtitle: 'Item info unavailable — queue return?',
        buttons: [
          { label: 'Return Anyway', action: doConfirmReturn },
          { label: 'Cancel', action: doReset },
        ],
      });
      return;
    }

    scanOverlay.show({
      state: 'error',
      title: 'Not found',
      subtitle: e.status === 404 ? 'QR not in inventory' : 'Lookup failed',
      buttons: [
        { label: 'OK', action: doReset },
        { label: 'Enter Manually', action: doManual },
      ],
    });

    toast(e.message);
  }
}

async function confirmCheckin(qr, container) {
  try {
    const res = await post('/checkin', { item_qr: qr });
    if (res.__offline) {
      toast('Saved offline — will sync when connected');
    } else if (res.success) {
      toast('Returned: ' + (lastItem?.name ?? qr));
    } else {
      toast('Item was not checked out');
    }
  } catch (e) {
    toast('Error: ' + e.message);
  }

  render(container);
}
