/**
 * Barrios tab — list + detail views for barrio arrival/departure tracking.
 */

import { get, post } from './api.js?v=1.0.1';
import { toast } from './app.js?v=1.0.1';
import { scanOverlay } from './scan-overlay.js?v=1.0.0';

let container    = null;
let detailId     = null;   // null = list view, number = detail view
let arrivalOpen  = false;  // whether inline arrival form is expanded
let allBarrios   = [];
let activeFilter = null;   // null | 'expected' | 'on-site' | 'departed'

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
  detailId     = null;
  arrivalOpen  = false;
  activeFilter = null;
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
  allBarrios = barrios;
  renderFiltered();
}

function renderFiltered() {
  const counts = {
    expected: allBarrios.filter(b => b.arrival_status === 'expected').length,
    'on-site': allBarrios.filter(b => b.arrival_status === 'on-site').length,
    departed:  allBarrios.filter(b => b.arrival_status === 'departed').length,
  };

  const visible = activeFilter
    ? allBarrios.filter(b => b.arrival_status === activeFilter)
    : allBarrios;

  const clearChip = activeFilter
    ? `<div class="barrio-clear-chip" data-action="clear">× Clear</div>`
    : '';

  container.innerHTML = `
    <div class="barrio-stats">
      <div class="barrio-stat-chip expected${activeFilter === 'expected' ? ' active' : ''}" data-filter="expected">
        <span class="status-dot expected"></span>
        ${counts.expected} Expected
      </div>
      <div class="barrio-stat-chip on-site${activeFilter === 'on-site' ? ' active' : ''}" data-filter="on-site">
        <span class="status-dot on-site"></span>
        ${counts['on-site']} On Site
      </div>
      <div class="barrio-stat-chip departed${activeFilter === 'departed' ? ' active' : ''}" data-filter="departed">
        <span class="status-dot departed"></span>
        ${counts.departed} Departed
      </div>
      ${clearChip}
    </div>
    <div class="card" style="padding:0">
      ${visible.length
        ? visible.map(b => barrioCardHTML(b)).join('')
        : '<div class="empty">No barrios configured</div>'
      }
    </div>
  `;

  container.querySelectorAll('.barrio-stat-chip[data-filter]').forEach(chip => {
    chip.addEventListener('click', () => {
      const f = chip.dataset.filter;
      activeFilter = activeFilter === f ? null : f;
      renderFiltered();
    });
  });

  container.querySelector('.barrio-clear-chip')
    ?.addEventListener('click', () => { activeFilter = null; renderFiltered(); });

  visible.forEach(b => {
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
    renderDetail(data.barrio, data.items_out || [], data.entitlements || [], data.equipment_orders || []);
  } catch (e) {
    toast('Could not load barrio: ' + e.message);
    loadList();
  }
}

function renderDetail(barrio, itemsOut, entitlements, equipmentOrders) {
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
        <span class="barrio-detail-key">Orientation</span>
        <span>${barrio.orientation_done ? '✓ Complete' : '✗ Not recorded'}</span>
      </div>
      ${entitlementsHTML(entitlements, status)}
    </div>
  ` : (entitlements.length ? `
    <div class="barrio-detail-section">
      ${entitlementsHTML(entitlements, status)}
    </div>
  ` : '');

  const equipOrdersSection = equipmentOrders.length ? `
    <div class="barrio-detail-section" style="margin-top:.75rem">
      <div class="card-label">Equipment orders</div>
      ${equipmentOrders.map(o => {
        const over = o.quantity_checked_out > o.quantity_ordered;
        return `
          <div class="barrio-detail-row">
            <span class="barrio-detail-key">${_esc(o.type_name)}</span>
            <span style="${over ? 'color:var(--warn)' : ''}">
              ${o.quantity_checked_out} / ${o.quantity_ordered} out
              ${over ? ' ⚠' : o.quantity_checked_out === o.quantity_ordered && o.quantity_ordered > 0 ? ' ✓' : ''}
            </span>
          </div>`;
      }).join('')}
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
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        ${entitlements.length ? `<button class="btn" id="barrio-distribute-btn" style="margin-top:0;flex:1">Distribute Items</button>` : ''}
        <button class="btn danger" id="barrio-departure-btn" style="margin-top:0;flex:1">Record Departure</button>
      </div>
      <div id="barrio-distribute-area"></div>
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
      ${equipOrdersSection}
      ${departureSection}
      ${itemsSection}
    </div>
    ${actionSection}
  `;

  container.querySelector('#barrio-back')?.addEventListener('click', loadList);

  if (status === 'expected') {
    container.querySelector('#barrio-arrival-btn')?.addEventListener('click', () => {
      showArrivalForm(barrio, entitlements);
    });
  } else if (status === 'on-site') {
    container.querySelector('#barrio-distribute-btn')?.addEventListener('click', () => {
      showDistributeForm(barrio, entitlements);
    });
    container.querySelector('#barrio-departure-btn')?.addEventListener('click', () => {
      confirmDeparture(barrio.id, itemsOut.length, barrio.name);
    });
  }
}

// ─── Entitlements HTML helper ─────────────────────────────────────────────────

function entitlementsHTML(entitlements, status) {
  if (!entitlements.length) return '';
  return `
    <div style="margin-top:.75rem">
      <div class="card-label">Consumables</div>
      <div style="display:grid;grid-template-columns:1fr repeat(3,auto);gap:.25rem .75rem;align-items:center;font-size:13px;margin-top:.4rem">
        <span style="color:var(--text3)">Item</span>
        <span style="color:var(--text3);text-align:right">Purchased</span>
        <span style="color:var(--text3);text-align:right">Given</span>
        <span style="color:var(--text3);text-align:right">Remaining</span>
        ${entitlements.map(e => {
          const rem = e.remaining;
          const remColor = rem < 0 ? 'color:var(--danger)' : rem === 0 ? 'color:var(--success,#22c55e)' : 'color:var(--warn)';
          return `
            <span>${_esc(e.name)}</span>
            <span style="text-align:right">${e.purchased}</span>
            <span style="text-align:right">${e.distributed}</span>
            <span style="text-align:right;font-weight:600;${remColor}">${rem < 0 ? '⚠ ' : ''}${rem}</span>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

// ─── Arrival form ──────────────────────────────────────────────────────────────

function showArrivalForm(barrio, entitlements) {
  const area = container.querySelector('#barrio-arrival-area');
  if (!area) return;

  const itemInputsHTML = entitlements.length
    ? entitlements.map(e => `
        <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:.5rem">
          <label style="flex:1;font-size:14px;color:var(--text);margin:0">
            ${_esc(e.name)} given
            ${e.purchased > 0 ? `<span style="color:var(--text3);font-size:12px">(${e.purchased} purchased)</span>` : ''}
          </label>
          <input type="number" class="arrival-item-input" data-type-id="${e.type_id}"
            min="0" value="${e.remaining > 0 ? e.remaining : 0}"
            inputmode="numeric" style="max-width:90px">
        </div>
      `).join('')
    : '<p style="font-size:13px;color:var(--text3)">No consumable entitlements set for this barrio.</p>';

  area.innerHTML = `
    <div class="card arrival-form-section" style="margin-top:0">
      <div class="card-label">Record Arrival</div>
      ${itemInputsHTML}
      <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text);margin-bottom:.75rem;margin-top:.25rem">
        <input type="checkbox" id="ba-orientation" style="width:auto;margin:0;accent-color:var(--accent)">
        Orientation completed
      </label>
      <button class="btn primary" id="ba-confirm" style="margin-top:0">Confirm Arrival</button>
      <button class="btn ghost" id="ba-cancel">Cancel</button>
    </div>
  `;

  area.querySelector('#ba-cancel')?.addEventListener('click', () => {
    area.innerHTML = `<button class="btn primary" id="barrio-arrival-btn" style="margin-top:0">Record Arrival</button>`;
    area.querySelector('#barrio-arrival-btn')?.addEventListener('click', () => showArrivalForm(barrio, entitlements));
  });

  area.querySelector('#ba-confirm')?.addEventListener('click', async () => {
    const btn    = area.querySelector('#ba-confirm');
    const orient = area.querySelector('#ba-orientation').checked;

    const items = [];
    area.querySelectorAll('.arrival-item-input').forEach(inp => {
      const qty = parseInt(inp.value || '0', 10);
      if (qty > 0) items.push({ type_id: +inp.dataset.typeId, quantity: qty });
    });

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Recording…';

    try {
      await post('/barrio-arrival', {
        barrio_id:        barrio.id,
        items,
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

// ─── Distribute form ──────────────────────────────────────────────────────────

function showDistributeForm(barrio, entitlements) {
  const area = container.querySelector('#barrio-distribute-area');
  if (!area) return;

  const allDone = entitlements.every(e => e.remaining <= 0);

  const itemInputsHTML = entitlements.map(e => {
    const defaultVal = Math.max(0, e.remaining);
    const remColor = e.remaining < 0 ? 'color:var(--danger)' : e.remaining === 0 ? 'color:var(--success,#22c55e)' : 'color:var(--warn)';
    return `
      <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:.5rem">
        <label style="flex:1;font-size:14px;color:var(--text);margin:0">
          ${_esc(e.name)}
          <span style="font-size:12px;${remColor}">(${e.remaining} remaining)</span>
        </label>
        <input type="number" class="dist-item-input" data-type-id="${e.type_id}"
          min="0" value="${defaultVal}" inputmode="numeric" style="max-width:90px">
      </div>
    `;
  }).join('');

  area.innerHTML = `
    <div class="card arrival-form-section" style="margin-top:.75rem">
      <div class="card-label">Distribute Items${allDone ? ' <span style="color:var(--success,#22c55e);font-size:12px">— all distributed</span>' : ''}</div>
      ${itemInputsHTML}
      <button class="btn primary" id="dist-confirm" style="margin-top:.5rem">Confirm</button>
      <button class="btn ghost" id="dist-cancel">Cancel</button>
    </div>
  `;

  area.querySelector('#dist-cancel')?.addEventListener('click', () => { area.innerHTML = ''; });

  area.querySelector('#dist-confirm')?.addEventListener('click', async () => {
    const btn = area.querySelector('#dist-confirm');
    const items = [];
    area.querySelectorAll('.dist-item-input').forEach(inp => {
      const qty = parseInt(inp.value || '0', 10);
      if (qty !== 0) items.push({ type_id: +inp.dataset.typeId, quantity: qty });
    });

    if (!items.length) { toast('Enter at least one quantity'); return; }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Recording…';

    try {
      await post('/barrio-distribute', { barrio_id: barrio.id, items });
      toast('Distribution recorded for ' + barrio.name);
      loadDetail(barrio.id);
    } catch (e) {
      toast('Error: ' + e.message);
      btn.disabled = false;
      btn.textContent = 'Confirm';
    }
  });
}

// ─── Departure ────────────────────────────────────────────────────────────────

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
