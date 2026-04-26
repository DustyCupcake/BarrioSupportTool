/**
 * Check-in tab — scan item QR, confirm return.
 */

import { get, post } from './api.js';
import { Scanner } from './scanner.js';
import { toast } from './app.js';

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
    <div id="ci-result"></div>
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
  const stat   = document.getElementById('ci-status');
  const result = document.getElementById('ci-result');
  if (stat)   stat.textContent = 'Looking up…';
  if (result) result.innerHTML = '';

  try {
    const item = await get('/items/lookup', { qr });
    lastItem = item;

    if (item.status === 'available') {
      if (result) result.innerHTML = `
        <div class="card ci-result">
          <div class="item-name">${item.name}</div>
          <div class="item-status">Already returned — no action needed</div>
          <button class="btn" style="margin-top:1rem" onclick="window._ci.reset()">Scan another</button>
        </div>
      `;
      if (stat) stat.textContent = '';
    } else {
      if (result) result.innerHTML = `
        <div class="card">
          <div class="card-label">Item found</div>
          <div class="item-row">
            <div class="item-row-info">
              <div class="item-row-name">${item.name}</div>
              <div class="item-row-sub">Checked out to: ${item.current_barrio?.name ?? '—'}</div>
            </div>
          </div>
          <button class="btn primary" style="margin-top:.75rem" onclick="window._ci.confirm('${qr}')">Confirm return</button>
          <button class="btn ghost" onclick="window._ci.reset()">Cancel</button>
        </div>
      `;
      if (stat) stat.textContent = '';
    }
  } catch (e) {
    if (stat) stat.textContent = e.status === 404 ? 'QR not found in inventory' : 'Lookup failed';
    if (result) result.innerHTML = `<button class="btn" onclick="window._ci.reset()">Try again</button>`;
    toast(e.message);
  }

  window._ci = {
    confirm: confirmCheckin,
    reset:   () => render(container),
  };
}

async function confirmCheckin(qr) {
  const btn = document.querySelector('#ci-result .btn.primary');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }

  try {
    const res = await post('/checkin', { item_qr: qr });
    if (res.__offline) {
      toast('Saved offline — will sync when connected');
    } else if (res.success) {
      toast('Returned: ' + (lastItem?.name ?? qr));
    } else {
      toast('Item was not checked out');
    }

    const container = document.getElementById('tab-checkin');
    render(container);
  } catch (e) {
    toast('Error: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Confirm return'; }
  }
}
