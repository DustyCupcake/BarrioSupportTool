/**
 * Groups tab — list + detail views for group arrival/departure tracking and
 * consumable entitlements. Replaces the old separate barrios/artists tabs:
 * a group is any team/camp/collective a department lends equipment to, with
 * enable_arrival_tracking / enable_consumable_entitlements as per-group flags
 * instead of a hardcoded entity type.
 */

import { get, post } from './api.js?v=1.0.1';
import { toast } from './app.js?v=1.0.1';
import { scanOverlay } from './scan-overlay.js?v=1.0.1';
import { t } from './i18n.js?v=1.0.1';

const __ = (key) => t('barrios', key);
const _c = (key) => t('common', key);

let container    = null;
let detailId     = null;   // null = list view, number = detail view
let arrivalOpen  = false;  // whether inline arrival form is expanded
let allBarrios   = [];
let activeFilter = null;   // null | 'expected' | 'on-site' | 'departed'

export function init(el, groupId = null) {
  container   = el;
  detailId    = null;
  arrivalOpen = false;
  if (groupId) {
    loadDetail(groupId);
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
  container.innerHTML = `<div class="card"><div class="empty" style="padding:1.5rem 0">${__('loading')}</div></div>`;
  try {
    const data = await get('/groups');
    renderList(data.groups || []);
  } catch (e) {
    toast('Could not load groups: ' + e.message);
    container.innerHTML = `<div class="card"><div class="empty">${__('loadFailed')}</div></div>`;
  }
}

function renderList(groups) {
  allBarrios = groups;
  renderFiltered();
}

function renderFiltered() {
  // Arrival status filtering/stats only make sense for arrival-tracking groups.
  const tracked = allBarrios.filter(b => b.enable_arrival_tracking);
  const untracked = allBarrios.filter(b => !b.enable_arrival_tracking);

  const counts = {
    expected: tracked.filter(b => b.arrival_status === 'expected').length,
    'on-site': tracked.filter(b => b.arrival_status === 'on-site').length,
    departed:  tracked.filter(b => b.arrival_status === 'departed').length,
  };

  const visibleTracked = activeFilter
    ? tracked.filter(b => b.arrival_status === activeFilter)
    : tracked;

  const clearChip = activeFilter
    ? `<div class="barrio-clear-chip" data-action="clear">${__('clearFilter')}</div>`
    : '';

  const statsHTML = tracked.length ? `
    <div class="barrio-stats">
      <div class="barrio-stat-chip expected${activeFilter === 'expected' ? ' active' : ''}" data-filter="expected">
        <span class="status-dot expected"></span>
        ${counts.expected} ${__('statusExpected')}
      </div>
      <div class="barrio-stat-chip on-site${activeFilter === 'on-site' ? ' active' : ''}" data-filter="on-site">
        <span class="status-dot on-site"></span>
        ${counts['on-site']} ${__('statusOnSite')}
      </div>
      <div class="barrio-stat-chip departed${activeFilter === 'departed' ? ' active' : ''}" data-filter="departed">
        <span class="status-dot departed"></span>
        ${counts.departed} ${__('statusDeparted')}
      </div>
      ${clearChip}
    </div>
  ` : '';

  const visible = [...visibleTracked, ...(activeFilter ? [] : untracked)];

  container.innerHTML = `
    ${statsHTML}
    <div class="card" style="padding:0">
      ${visible.length
        ? visible.map(b => barrioCardHTML(b)).join('')
        : `<div class="empty">${__('noneConfigured')}</div>`
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
  const badge = b.items_out_count > 0
    ? `<span class="items-out-badge">${__('itemsOut').replace('[N]', b.items_out_count)}</span>`
    : '';
  const statusDot = b.enable_arrival_tracking
    ? `<span class="status-dot ${b.arrival_status}"></span>`
    : '';
  const statusLbl = b.enable_arrival_tracking
    ? `<div class="barrio-status-label ${b.arrival_status}">${statusLabel(b.arrival_status)}</div>`
    : '';
  return `
    <div class="barrio-card" data-barrio-id="${b.id}">
      ${statusDot}
      <div class="barrio-card-body">
        <div class="barrio-card-name">${_esc(b.name)}</div>
        ${statusLbl}
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
  container.innerHTML = `<div class="card"><div class="empty" style="padding:1.5rem 0">${__('loading')}</div></div>`;
  try {
    const data = await get('/groups/' + id);
    renderDetail(data.group || data.barrio, data.items_out || [], data.entitlements || [], data.equipment_orders || []);
  } catch (e) {
    toast('Could not load group: ' + e.message);
    loadList();
  }
}

function renderDetail(barrio, itemsOut, entitlements, equipmentOrders) {
  const tracksArrival  = !!barrio.enable_arrival_tracking;
  const tracksEnt      = !!barrio.enable_consumable_entitlements;
  const status = tracksArrival ? barrio.arrival_status : null;

  const arrivalSection = tracksArrival && status !== 'expected' ? `
    <div class="barrio-detail-section">
      <div class="card-label">${__('sectionArrival')}</div>
      <div class="barrio-detail-row">
        <span class="barrio-detail-key">${__('arrived')}</span>
        <span>${fmtDateTime(barrio.arrived_at)}</span>
      </div>
      <div class="barrio-detail-row">
        <span class="barrio-detail-key">${__('by')}</span>
        <span>${_esc(barrio.arrived_by_name ?? '—')}</span>
      </div>
      <div class="barrio-detail-row">
        <span class="barrio-detail-key">${__('orientation')}</span>
        <span>${barrio.orientation_done ? __('orientationDone') : __('orientationNone')}</span>
      </div>
      ${tracksEnt ? entitlementsHTML(entitlements, status) : ''}
    </div>
  ` : (tracksEnt && entitlements.length ? `
    <div class="barrio-detail-section">
      ${entitlementsHTML(entitlements, status)}
    </div>
  ` : '');

  const equipOrdersSection = equipmentOrders.length ? `
    <div class="barrio-detail-section" style="margin-top:.75rem">
      <div class="card-label">${__('sectionEquipment')}</div>
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

  const departureSection = tracksArrival && status === 'departed' ? `
    <div class="barrio-detail-section" style="margin-top:.75rem">
      <div class="card-label">${__('sectionDeparture')}</div>
      <div class="barrio-detail-row">
        <span class="barrio-detail-key">${__('departed')}</span>
        <span>${fmtDateTime(barrio.departed_at)}</span>
      </div>
      <div class="barrio-detail-row">
        <span class="barrio-detail-key">${__('by')}</span>
        <span>${_esc(barrio.departed_by_name ?? '—')}</span>
      </div>
    </div>
  ` : '';

  const itemsSection = `
    <div class="barrio-detail-section" style="margin-top:.75rem">
      <div class="card-label">${__('sectionItems')} (${itemsOut.length})</div>
      ${itemsOut.length
        ? itemsOut.map(i => `
            <div class="item-row">
              <div class="item-row-info">
                <div class="item-row-name">${_esc(i.name)}</div>
                <div class="item-row-sub">${_esc(i.qr_code)}${i.category ? ' · ' + _esc(i.category) : ''}</div>
              </div>
            </div>
          `).join('')
        : `<div class="empty-list">${__('none')}</div>`
      }
    </div>
  `;

  let actionSection = '';
  if (tracksArrival && status === 'expected') {
    actionSection = `
      <div id="barrio-arrival-area">
        <button class="btn primary" id="barrio-arrival-btn" style="margin-top:0">${__('recordArrival')}</button>
      </div>
    `;
  } else if (tracksArrival && status === 'on-site') {
    actionSection = `
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        ${tracksEnt && entitlements.length ? `<button class="btn" id="barrio-distribute-btn" style="margin-top:0;flex:1">${__('distributeItems')}</button>` : ''}
        <button class="btn danger" id="barrio-departure-btn" style="margin-top:0;flex:1">${__('recordDeparture')}</button>
      </div>
      <div id="barrio-distribute-area"></div>
    `;
  } else if (!tracksArrival && tracksEnt && entitlements.length) {
    actionSection = `
      <div id="barrio-distribute-area"></div>
      <button class="btn" id="barrio-distribute-btn" style="margin-top:0">${__('distributeItems')}</button>
    `;
  }

  const statusDot   = tracksArrival ? `<span class="status-dot ${status}" style="flex-shrink:0"></span>` : '';
  const statusLabelEl = tracksArrival ? `<span class="barrio-status-label ${status}">${statusLabel(status)}</span>` : '';

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:1rem">
      <button class="btn ghost" style="width:auto;margin:0;padding:6px 10px" id="barrio-back">← ${_c('back')}</button>
      ${statusDot}
      <span style="font-size:16px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(barrio.name)}</span>
      ${statusLabelEl}
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

  if (tracksArrival && status === 'expected') {
    container.querySelector('#barrio-arrival-btn')?.addEventListener('click', () => {
      showArrivalForm(barrio, entitlements);
    });
  } else if (tracksArrival && status === 'on-site') {
    container.querySelector('#barrio-distribute-btn')?.addEventListener('click', () => {
      showDistributeForm(barrio, entitlements);
    });
    container.querySelector('#barrio-departure-btn')?.addEventListener('click', () => {
      confirmDeparture(barrio.id, itemsOut.length, barrio.name);
    });
  } else if (!tracksArrival) {
    container.querySelector('#barrio-distribute-btn')?.addEventListener('click', () => {
      showDistributeForm(barrio, entitlements);
    });
  }
}

// ─── Entitlements HTML helper ─────────────────────────────────────────────────

function entitlementsHTML(entitlements, status) {
  if (!entitlements.length) return '';
  return `
    <div style="margin-top:.75rem">
      <div class="card-label">${__('consumables')}</div>
      <div style="display:grid;grid-template-columns:1fr repeat(3,auto);gap:.25rem .75rem;align-items:center;font-size:13px;margin-top:.4rem">
        <span style="color:var(--text3)">${t('inventory', 'colItem')}</span>
        <span style="color:var(--text3);text-align:right">${__('purchased')}</span>
        <span style="color:var(--text3);text-align:right">${__('given')}</span>
        <span style="color:var(--text3);text-align:right">${__('remaining')}</span>
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

  // water_fill is excluded here — its real credit ledger is only ever written
  // by the truck confirm/adhoc-fill flow, never by generic arrival distribution
  // (the backend rejects it too; this just keeps it off the form in the first
  // place so staff aren't offered a control that wouldn't do anything).
  const arrivalEntitlements = entitlements.filter(e => e.key_name !== 'water_fill');

  const itemInputsHTML = arrivalEntitlements.length
    ? arrivalEntitlements.map(e => `
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
    : '<p style="font-size:13px;color:var(--text3)">No consumable entitlements set for this group.</p>';

  area.innerHTML = `
    <div class="card arrival-form-section" style="margin-top:0">
      <div class="card-label">${__('recordArrival')}</div>
      ${itemInputsHTML}
      <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text);margin-bottom:.75rem;margin-top:.25rem">
        <input type="checkbox" id="ba-orientation" style="width:auto;margin:0;accent-color:var(--accent)">
        ${t('checkout', 'orientation')}
      </label>
      <button class="btn primary" id="ba-confirm" style="margin-top:0">${__('confirmArrival')}</button>
      <button class="btn ghost" id="ba-cancel">${_c('cancel')}</button>
    </div>
  `;

  area.querySelector('#ba-cancel')?.addEventListener('click', () => {
    area.innerHTML = `<button class="btn primary" id="barrio-arrival-btn" style="margin-top:0">${__('recordArrival')}</button>`;
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
      await post('/group-arrival', {
        group_id:         barrio.id,
        items,
        orientation_done: orient,
      });
      toast(__('arrivalDone').replace('[BARRIO]', barrio.name));
      loadDetail(barrio.id);
    } catch (e) {
      if (e.status === 409) {
        toast(__('alreadyRecorded') + ' ' + e.message);
        loadDetail(barrio.id);
      } else {
        toast('Error: ' + e.message);
        btn.disabled = false;
        btn.textContent = __('confirmArrival');
      }
    }
  });
}

// ─── Distribute form ──────────────────────────────────────────────────────────

function showDistributeForm(barrio, entitlements) {
  const area = container.querySelector('#barrio-distribute-area');
  if (!area) return;

  // water_fill is excluded here — its real credit ledger is only ever written
  // by the truck confirm/adhoc-fill flow, never by generic distribution (the
  // backend rejects it too; this just keeps it off the form in the first
  // place so staff aren't offered a control that wouldn't do anything).
  const distEntitlements = entitlements.filter(e => e.key_name !== 'water_fill');

  const allDone = distEntitlements.every(e => e.remaining <= 0);

  const itemInputsHTML = distEntitlements.map(e => {
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
      <div class="card-label">${__('distributeItems')}${allDone ? ' <span style="color:var(--success,#22c55e);font-size:12px">— all distributed</span>' : ''}</div>
      ${itemInputsHTML}
      <button class="btn primary" id="dist-confirm" style="margin-top:.5rem">${_c('confirm')}</button>
      <button class="btn ghost" id="dist-cancel">${_c('cancel')}</button>
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

    if (!items.length) { toast(__('enterQuantity')); return; }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Recording…';

    try {
      await post('/barrio-distribute', { group_id: barrio.id, items });
      toast(__('distributeDone').replace('[BARRIO]', barrio.name));
      loadDetail(barrio.id);
    } catch (e) {
      toast('Error: ' + e.message);
      btn.disabled = false;
      btn.textContent = _c('confirm');
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
      subtitle: __('itemsStillOut').replace('[N]', n),
      buttons: [
        { label: __('confirmDeparture'), action: () => doDeparture(barrioId, barrioName, true) },
        { label: _c('cancel'),           action: () => scanOverlay.hide() },
      ],
    });
  } else {
    scanOverlay.show({
      state: 'success',
      title: barrioName,
      subtitle: __('allReturned'),
      buttons: [
        { label: __('recordDeparture'), action: () => doDeparture(barrioId, barrioName, false) },
        { label: _c('cancel'),          action: () => scanOverlay.hide() },
      ],
    });
  }
}

async function doDeparture(barrioId, barrioName, force) {
  scanOverlay.hide();
  try {
    const result = await post('/group-departure', { group_id: barrioId, force });
    if (result.__offline) {
      toast(__('noConnection'));
      return;
    }
    toast(__('departureDone').replace('[BARRIO]', barrioName));
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
  if (s === 'expected') return __('statusExpected');
  if (s === 'on-site')  return __('statusOnSite');
  if (s === 'departed') return __('statusDeparted');
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
