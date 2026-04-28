/**
 * Check-in tab — scan item QR, confirm return.
 */

import { get, post } from './api.js?v=1.0.0';
import { Scanner } from './scanner.js?v=1.0.0';
import { toast } from './app.js?v=1.0.0';
import { scanOverlay } from './scan-overlay.js?v=1.0.0';

let scanner = null;
let lastItem = null;

export function init(container) {
  render(container);
}

export function destroy() {
  if (scanner) { scanner.stop(); scanner = null; }
}

function render(container) {
  lastItem = null;
  container.innerHTML = `
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

  try {
    const item = await get('/items/lookup', { qr });
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
      const doConfirm = async () => {
        scanOverlay.hide();
        await confirmCheckin(qr, container);
      };

      scanOverlay.show({
        state: 'success',
        title: item.name,
        subtitle: item.current_barrio?.name ? `Checked out to ${item.current_barrio.name}` : item.category ?? null,
        buttons: [
          { label: 'Confirm Return', action: doConfirm },
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
