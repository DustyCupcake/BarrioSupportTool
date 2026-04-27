/**
 * Barrios tab — list + detail views for barrio arrival/departure tracking.
 */

import { get, post } from './api.js';
import { toast } from './app.js';
import { scanOverlay } from './scan-overlay.js';

let container   = null;
let detailId    = null;   // null = list view, number = detail view
let arrivalOpen = false;  // whether inline arrival form is expanded

export function init(el, barrioId = null) {
  container   = el;
  detailId    = null;
  arrivalOpen = false;
  if (barrioId) {
    loadDetail(barrioId);
  } else {
    loadList();
  }
}

export function destroy() {}

// ─── List view ────────────────────────────────────────────────────────────────

async function loadList() {
  detailId    = null;
  arrivalOpen = false;
  container.innerHTML = `<div class="card"><div class="empty" style="padding:1.5rem 0">Loading…</div></div>`;
  try {
    const data = await get('/barrios');
    renderList(data.barrios || []);
  } catch (e) {
    toast('Could not load barrios: ' + e.message);
    container.innerHTML = `<div class="card"><div class="empty">Failed to load</div></div>`;
  }
}

function renderList(barrios) {
  const counts = {
    expected: barrios.filter(b => b.arrival_status === 'expected').length,
    'on-site': barrios.filter(b => b.arrival_status === 'on-site').length,
    departed:  barrios.filter(b => b.arrival_status === 'departed').length,
  };

  container.innerHTML = `
    <div class="barrio-stats">
      <div class="barrio-stat-chip expected">
        <span class="status-dot expected"></span>
        ${counts.expected} Expected
      </div>
      <div class="barrio-stat-chip on-site">
        <span class="status-dot on-site"></span>
        ${counts['on-site']} On Site
      </div>
      <div class="barrio-stat-chip departed">
        <span class="status-dot departed"></span>
        ${counts.departed} Departed
      </div>
    </div>
    <div class="card" style="padding:0">
      ${barrios.length
        ? barrios.map(b => barrioCardHTML(b)).join('')
        : '<div class="empty">No barrios configured</div>'
      }
    </div>
  `;

  barrios.forEach(b => {
    container.querySelector(`[data-barrio-id="${b.id}"]`)
      ?.addEventListener('click', () => loadDetail(b.id));
  });
}

function barrioCardHTML(b) {
  const badge = b.arrival_status === 'on-site' && b.items_out_count > 0
    ? `<span class="items-out-badge">${b.items_out_count} out</span>`
    : '';
  return `
    <div class="barrio-card" data-barrio-id="${b.id}">
      <span class="status-dot ${b.arrival_status}"></span>
      <div class="barrio-card-body">
        <div class="barrio-card-name">${_esc(b.name)}</div>
        <div class="barrio-status-label ${b.arrival_status}">${statusLabel(b.arrival_status)}</div>
      </div>
      ${badge}
      <span class="barrio-card-arrow">›</span>
    </div>
  `;
}

// ─── Detail view ──────────────────────────────────────────────────────────────

async function loadDetail(id) {
  detailId    = id;
  arrivalOpen = false;
  container.innerHTML = `<div class="card"><div class="empty" style="padding:1.5rem 0">Loading…</div></div>`;
  try {
    const data = await get('/barrios/' + id);
    renderDetail(data.barrio, data.items_out || []);
  } catch (e) {
    toast('Could not load barrio: ' + e.message);
    loadList();
  }
}

function renderDetail(barrio, itemsOut) {
  const status = barrio.arrival_status;

  const arrivalSection = status !== 'expected' ? `
    <div class="barrio-detail-section">
      <div class="card-label">Arrival</div>
      <div class="barrio-detail-row">
        <span class="barrio-detail-key">Arrived</span>
        <span>${fmtDateTime(barrio.arrived_at)}</span>
      </div>
      <div class="barrio-detail-row">
        <span class="barrio-detail-key">By</span>
        <span>${_esc(barrio.arrived_by_name ?? '—')}</span>
      </div>
      <div class="barrio-detail-row">
        <span class="barrio-detail-key">Water vouchers</span>
        <span>${barrio.water_vouchers}</span>
      </div>
      <div class="barrio-detail-row">
        <span class="barrio-detail-key">Ice tokens</span>
        <span>${barrio.ice_tokens}</span>
      </div>
      <div class="barrio-detail-row">
        <span class="barrio-detail-key">Orientation</span>
        <span>${barrio.orientation_done ? '✓ Complete' : '✗ Not recorded'}</span>
      </div>
    </div>
  ` : '';

  const departureSection = status === 'departed' ? `
    <div class="barrio-detail-section" style="margin-top:.75rem">
      <div class="card-label">Departure</div>
      <div class="barrio-detail-row">
        <span class="barrio-detail-key">Departed</span>
        <span>${fmtDateTime(barrio.departed_at)}</span>
      </div>
      <div class="barrio-detail-row">
        <span class="barrio-detail-key">By</span>
        <span>${_esc(barrio.departed_by_name ?? '—')}</span>
      </div>
    </div>
  ` : '';

  const itemsSection = `
    <div class="barrio-detail-section" style="margin-top:.75rem">
      <div class="card-label">Items out (${itemsOut.length})</div>
      ${itemsOut.length
        ? itemsOut.map(i => `
            <div class="item-row">
              <div class="item-row-info">
                <div class="item-row-name">${_esc(i.name)}</div>
                <div class="item-row-sub">${_esc(i.qr_code)}${i.category ? ' · ' + _esc(i.category) : ''}</div>
              </div>
            </div>
          `).join('')
        : '<div class="empty-list">None</div>'
      }
    </div>
  `;

  let actionSection = '';
  if (status === 'expected') {
    actionSection = `
      <div id="barrio-arrival-area">
        <button class="btn primary" id="barrio-arrival-btn" style="margin-top:0">Record Arrival</button>
      </div>
    `;
  } else if (status === 'on-site') {
    actionSection = `
      <button class="btn danger" id="barrio-departure-btn" style="margin-top:0">Record Departure</button>
    `;
  }

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:1rem">
      <button class="btn ghost" style="width:auto;margin:0;padding:6px 10px" id="barrio-back">← Back</button>
      <span class="status-dot ${status}" style="flex-shrink:0"></span>
      <span style="font-size:16px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(barrio.name)}</span>
      <span class="barrio-status-label ${status}">${statusLabel(status)}</span>
    </div>
    <div class="card">
      ${arrivalSection}
      ${departureSection}
      ${itemsSection}
    </div>
    ${actionSection}
  `;

  container.querySelector('#barrio-back')?.addEventListener('click', loadList);

  if (status === 'expected') {
    container.querySelector('#barrio-arrival-btn')?.addEventListener('click', () => {
      showArrivalForm(barrio);
    });
  } else if (status === 'on-site') {
    container.querySelector('#barrio-departure-btn')?.addEventListener('click', () => {
      confirmDeparture(barrio.id, itemsOut.length, barrio.name);
    });
  }
}

function showArrivalForm(barrio) {
  const area = container.querySelector('#barrio-arrival-area');
  if (!area) return;

  area.innerHTML = `
    <div class="card arrival-form-section" style="margin-top:0">
      <div class="card-label">Record Arrival</div>
      <label>Water vouchers given</label>
      <input type="number" id="ba-water" min="0" value="0" inputmode="numeric" style="margin-bottom:.65rem">
      <label>Ice tokens given</label>
      <input type="number" id="ba-ice" min="0" value="0" inputmode="numeric" style="margin-bottom:.65rem">
      <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text);margin-bottom:.75rem">
        <input type="checkbox" id="ba-orientation" style="width:auto;margin:0;accent-color:var(--accent)">
        Orientation completed
      </label>
      <button class="btn primary" id="ba-confirm" style="margin-top:0">Confirm Arrival</button>
      <button class="btn ghost" id="ba-cancel">Cancel</button>
    </div>
  `;

  area.querySelector('#ba-cancel')?.addEventListener('click', () => {
    area.innerHTML = `<button class="btn primary" id="barrio-arrival-btn" style="margin-top:0">Record Arrival</button>`;
    area.querySelector('#barrio-arrival-btn')?.addEventListener('click', () => showArrivalForm(barrio));
  });

  area.querySelector('#ba-confirm')?.addEventListener('click', async () => {
    const btn    = area.querySelector('#ba-confirm');
    const water  = parseInt(area.querySelector('#ba-water').value || '0', 10);
    const ice    = parseInt(area.querySelector('#ba-ice').value || '0', 10);
    const orient = area.querySelector('#ba-orientation').checked;

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Recording…';

    try {
      await post('/barrio-arrival', {
        barrio_id:       barrio.id,
        water_vouchers:  water,
        ice_tokens:      ice,
        orientation_done: orient,
      });
      toast('Arrival recorded for ' + barrio.name);
      loadDetail(barrio.id);
    } catch (e) {
      if (e.status === 409) {
        toast('Already recorded: ' + e.message);
        loadDetail(barrio.id);
      } else {
        toast('Error: ' + e.message);
        btn.disabled = false;
        btn.textContent = 'Confirm Arrival';
      }
    }
  });
}

async function confirmDeparture(barrioId, itemsOutCount, barrioName) {
  if (itemsOutCount > 0) {
    const n = itemsOutCount;
    scanOverlay.show({
      state: 'warning',
      title: barrioName,
      subtitle: `${n} item${n !== 1 ? 's' : ''} still checked out`,
      buttons: [
        { label: 'Confirm Departure Anyway', action: () => doDeparture(barrioId, barrioName, true) },
        { label: 'Cancel', action: () => scanOverlay.hide() },
      ],
    });
  } else {
    scanOverlay.show({
      state: 'success',
      title: barrioName,
      subtitle: 'All items returned',
      buttons: [
        { label: 'Record Departure', action: () => doDeparture(barrioId, barrioName, false) },
        { label: 'Cancel', action: () => scanOverlay.hide() },
      ],
    });
  }
}

async function doDeparture(barrioId, barrioName, force) {
  scanOverlay.hide();
  try {
    const result = await post('/barrio-departure', { barrio_id: barrioId, force });
    if (result.__offline) {
      toast('No connection — departure requires internet');
      return;
    }
    toast('Departure recorded for ' + barrioName);
    loadDetail(barrioId);
  } catch (e) {
    if (e.status === 409 && e.data?.error === 'items_outstanding') {
      confirmDeparture(barrioId, e.data.count, barrioName);
    } else {
      toast('Error: ' + e.message);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function statusLabel(s) {
  if (s === 'expected') return 'Expected';
  if (s === 'on-site')  return 'On Site';
  if (s === 'departed') return 'Departed';
  return s;
}

function fmtDateTime(dt) {
  if (!dt) return '—';
  const d = new Date(dt.replace(' ', 'T'));
  if (isNaN(d)) return dt;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function _esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
