/**
 * Voucher activation mode — used by staff to activate half-vouchers collected
 * from the registration box before a water fill run.
 *
 * Scans QR codes and calls POST /items/activate, changing status from
 * checked-out → activated so they can subsequently be validated.
 */

import { post } from './api.js?v=1.0.1';
import { Scanner } from './scanner.js?v=1.0.0';
import { toast } from './app.js?v=1.0.1';
import { scanOverlay } from './scan-overlay.js?v=1.0.1';
import { t } from './i18n.js?v=1.0.0';

const __ = (key) => t('activate', key);
const _c = (key) => t('common', key);

let scanner    = null;
let _container = null;

export function init(container) {
  _container = container;
  render(container);
}

export function destroy() {
  if (scanner) { scanner.stop(); scanner = null; }
}

function render(container) {
  container.innerHTML = `
    <div class="card">
      <div class="card-label">${__('title')}</div>
      <div class="video-wrap" id="ac-video-wrap">
        <video id="ac-video" playsinline muted></video>
        <div class="scan-overlay"><div class="scan-frame"><div class="scan-line"></div></div></div>
      </div>
      <div class="scan-status" id="ac-status">${__('aimScanner')}</div>
      <button class="btn-text-link" id="ac-manual-btn" onclick="window._activate.manual()">${_c('enterManually')}</button>
    </div>
  `;

  window._activate = { manual: openManual };
  startScanner(container);
}

async function startScanner(container) {
  const video = document.getElementById('ac-video');
  if (!video) return;
  scanner = new Scanner(video, (qr) => handleScan(qr, container));
  try {
    await scanner.start();
  } catch (e) {
    const stat = document.getElementById('ac-status');
    if (stat) stat.textContent = _c('cameraError');
  }
}

async function handleScan(qr, container) {
  const stat = document.getElementById('ac-status');
  if (stat) stat.textContent = __('activating');

  const doReset = () => {
    scanOverlay.hide();
    render(container);
  };

  try {
    const res = await post('/items/activate', { item_qr: qr });

    if (res.success) {
      const barrio = res.barrio ? ` — ${res.barrio}` : '';
      scanOverlay.show({
        state: 'success',
        title: __('activated'),
        subtitle: (res.name ?? qr) + barrio,
        buttons: [{ label: _c('next'), action: doReset }],
      });
      return;
    }

    if (res.error === 'already_activated') {
      const barrio = res.barrio ? ` — ${res.barrio}` : '';
      scanOverlay.show({
        state: 'warning',
        title: __('alreadyActivated'),
        subtitle: (res.name ?? qr) + barrio,
        buttons: [{ label: _c('ok'), action: doReset }],
      });
      return;
    }

    if (res.error === 'not_checked_out') {
      scanOverlay.show({
        state: 'error',
        title: __('cannotActivate'),
        subtitle: res.name ? `${res.name} — not checked out to any barrio` : 'Not checked out to any barrio',
        buttons: [{ label: _c('ok'), action: doReset }],
      });
      return;
    }

    scanOverlay.show({
      state: 'error',
      title: __('activationFailed'),
      subtitle: res.error ?? 'Unknown error',
      buttons: [{ label: _c('ok'), action: doReset }],
    });

  } catch (e) {
    const isNotVoucher = e.status === 409;

    if (isNotVoucher) {
      scanOverlay.show({
        state: 'error',
        title: __('notAVoucher'),
        subtitle: 'This QR code is for equipment, not a voucher',
        buttons: [{ label: _c('ok'), action: doReset }],
      });
      return;
    }

    const doManual = () => {
      scanOverlay.showManualEntry({
        placeholder: __('typeQr'),
        onSubmit: (typed) => handleScan(typed, container),
        onCancel: doReset,
      });
    };

    scanOverlay.show({
      state: 'warning',
      title: __('unreadable'),
      subtitle: e.status === 404 ? 'QR not recognised — enter code manually' : 'Lookup failed — check connection',
      buttons: [
        { label: _c('enterManually'), action: doManual },
        { label: _c('tryAgain'),      action: doReset },
      ],
    });
  }
}

function openManual() {
  const doReset = () => {
    scanOverlay.hide();
    render(_container);
  };
  scanOverlay.showManualEntry({
    placeholder: __('typeQr'),
    onSubmit: (typed) => handleScan(typed, _container),
    onCancel: doReset,
  });
}
