/**
 * Voucher validation mode — used by validator-role users (strict) and
 * staff in the Scan In tab toggle (non-strict).
 *
 * strictMode = true  → validators only; non-voucher QR shows red error
 * strictMode = false → staff toggle; non-voucher QR shows yellow warning
 */

import { get, post } from './api.js?v=1.0.1';
import { Scanner } from './scanner.js?v=1.0.0';
import { toast } from './app.js?v=1.0.1';
import { scanOverlay } from './scan-overlay.js?v=1.0.0';

let scanner    = null;
let lastItem   = null;
let _container = null;
let _strict    = false;

export function init(container, strictMode = false) {
  _container = container;
  _strict    = strictMode;
  render(container, strictMode);
}

export function destroy() {
  if (scanner) { scanner.stop(); scanner = null; }
}

function render(container, strictMode) {
  lastItem = null;
  container.innerHTML = `
    <div class="card">
      <div class="card-label">${strictMode ? 'Voucher validation' : 'Validate voucher'}</div>
      <div class="video-wrap" id="vl-video-wrap">
        <video id="vl-video" playsinline muted></video>
        <div class="scan-overlay"><div class="scan-frame"><div class="scan-line"></div></div></div>
      </div>
      <div class="scan-status" id="vl-status">Aim camera at voucher QR code…</div>
      <button class="btn-text-link" id="vl-manual-btn" onclick="window._validate.manual()">Can't scan? Enter code manually</button>
    </div>
  `;

  window._validate = { manual: openManual };
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
    if (stat) stat.textContent = 'Camera error — ' + e.message;
  }
}

async function handleScan(qr, container, strictMode) {
  const stat = document.getElementById('vl-status');
  if (stat) stat.textContent = 'Looking up…';

  const doReset = () => {
    scanOverlay.hide();
    render(container, strictMode);
  };

  try {
    const item = await get('/items/lookup', { qr });
    lastItem = item;

    if (!item.secure_qr) {
      if (strictMode) {
        scanOverlay.show({
          state: 'error',
          title: 'Not a voucher',
          subtitle: 'This QR code is for equipment, not a voucher',
          buttons: [{ label: 'OK', action: doReset }],
        });
      } else {
        scanOverlay.show({
          state: 'warning',
          title: 'Equipment QR detected',
          subtitle: 'Turn off Validate mode to return this item',
          buttons: [{ label: 'OK', action: doReset }],
        });
      }
      return;
    }

    if (item.status === 'activated') {
      const doUse = async () => {
        scanOverlay.hide();
        await confirmUsed(qr, container, strictMode);
      };
      scanOverlay.show({
        state: 'success',
        title: 'Valid voucher',
        subtitle: item.current_barrio?.name ? `Checked out to ${item.current_barrio.name}` : 'Ready to use',
        buttons: [
          { label: 'Mark as used', action: doUse },
          { label: 'Undo', action: doReset },
        ],
      });
      return;
    }

    if (item.status === 'used') {
      scanOverlay.show({
        state: 'error',
        title: 'Already used',
        subtitle: item.name,
        buttons: [{ label: 'OK', action: doReset }],
      });
      return;
    }

    if (item.status === 'checked-out') {
      scanOverlay.show({
        state: 'error',
        title: 'Not activated',
        subtitle: 'Half-voucher not yet collected — barrio must register first',
        buttons: [{ label: 'OK', action: doReset }],
      });
      return;
    }

    // available or retired — not valid for validation
    scanOverlay.show({
      state: 'error',
      title: 'Invalid voucher',
      subtitle: item.status === 'available' ? 'Not checked out to any barrio' : 'Voucher retired',
      buttons: [{ label: 'OK', action: doReset }],
    });

  } catch (e) {
    const doManual = () => {
      scanOverlay.showManualEntry({
        placeholder: 'Type voucher QR code',
        onSubmit: (typed) => handleScan(typed, container, strictMode),
        onCancel: doReset,
      });
    };

    scanOverlay.show({
      state: 'warning',
      title: 'Unreadable',
      subtitle: e.status === 404 ? 'QR not recognised — enter code manually' : 'Lookup failed — check connection',
      buttons: [
        { label: 'Enter Manually', action: doManual },
        { label: 'Try Again', action: doReset },
      ],
    });
  }
}

async function confirmUsed(qr, container, strictMode) {
  try {
    const res = await post('/items/use', { item_qr: qr });
    if (res.success) {
      toast('Voucher marked as used: ' + (lastItem?.name ?? qr));
    } else {
      toast('Could not mark as used — ' + (res.error ?? 'unknown error'));
    }
  } catch (e) {
    toast('Error: ' + e.message);
  }
  render(container, strictMode);
}

function openManual() {
  const doReset = () => {
    scanOverlay.hide();
    render(_container, _strict);
  };
  scanOverlay.showManualEntry({
    placeholder: 'Type voucher QR code',
    onSubmit: (typed) => handleScan(typed, _container, _strict),
    onCancel: doReset,
  });
}
