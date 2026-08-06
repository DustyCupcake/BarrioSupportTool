/**
 * Inventory tab — shows all active items with status and spec filtering.
 */

import { get } from './api.js?v=1.0.1';
import { toast } from './app.js?v=1.0.1';
import { t } from './i18n.js?v=1.0.0';

const __ = (key) => t('inventory', key);
const _c = (key) => t('common', key);

let _allItems     = [];
let _specSchemas  = {};
let _specFilters  = {};
let _typeFilter   = '';

export async function init(container) {
  container.innerHTML = `
    <div class="stats" id="inv-stats">
      <div class="stat-card"><div class="stat-label" id="inv-lbl-avail">${__('colStatus')}</div><div class="stat-val" id="inv-avail">—</div></div>
      <div class="stat-card"><div class="stat-label" id="inv-lbl-out">${_c('statusCheckedOut')}</div><div class="stat-val" id="inv-out">—</div></div>
    </div>
    <div class="section-actions">
      <div style="font-size:13px;color:var(--text2)" id="inv-title">${__('title')}</div>
      <button class="btn sm" onclick="window._inv.refresh()">${_c('refresh')}</button>
    </div>
    <div id="inv-filters" style="display:none"></div>
    <div class="card" style="padding:0;overflow:hidden">
      <div id="inv-body"><div class="empty">${__('emptyHint')}</div></div>
    </div>
  `;
  window._inv = { refresh: load, applyFilters };
  await load();
}

async function load() {
  const body = document.getElementById('inv-body');
  if (body) body.innerHTML = '<div class="empty"><span class="spinner"></span> Loading…</div>';

  const lblAvail = document.getElementById('inv-lbl-avail');
  const lblOut   = document.getElementById('inv-lbl-out');
  const title    = document.getElementById('inv-title');
  if (lblAvail) lblAvail.textContent = _c('statusAvailable');
  if (lblOut)   lblOut.textContent   = _c('statusCheckedOut');
  if (title)    title.textContent    = __('title');

  try {
    const data  = await get('/inventory');
    _allItems    = data.items || [];
    _specSchemas = data.spec_schemas || {};
    _specFilters = {};
    _typeFilter  = '';

    const avail = document.getElementById('inv-avail');
    const out   = document.getElementById('inv-out');
    if (avail) avail.textContent = data.stats.available;
    if (out)   out.textContent   = data.stats.checked_out;

    _renderTypeFilter();
    _applyAndRender();
  } catch (e) {
    const body = document.getElementById('inv-body');
    if (body) body.innerHTML = `<div class="empty">${__('failed')}</div>`;
    toast('Inventory error: ' + e.message);
  }
}

function _renderTypeFilter() {
  const filtersEl = document.getElementById('inv-filters');
  if (!filtersEl) return;

  // Collect unique types that have items
  const typeIds = [...new Set(_allItems.map(it => it.equipment_type_id))].filter(Boolean);
  if (!typeIds.length) { filtersEl.style.display = 'none'; return; }

  // Build type name map
  const typeNames = {};
  for (const it of _allItems) {
    if (it.equipment_type_id && !typeNames[it.equipment_type_id]) {
      typeNames[it.equipment_type_id] = it.name.replace(/ #\d+$/, '');
    }
  }

  const typeOpts = typeIds.map(id =>
    `<option value="${id}" ${String(_typeFilter) === String(id) ? 'selected' : ''}>${_esc(typeNames[id] || id)}</option>`
  ).join('');

  filtersEl.style.display = 'block';
  filtersEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;padding:.5rem 0;margin-bottom:.25rem">
      <span style="font-size:13px;color:var(--text2)">Type:</span>
      <select id="inv-type-filter" style="width:auto;margin:0" onchange="window._inv.applyFilters()">
        <option value="">All types</option>
        ${typeOpts}
      </select>
    </div>
    <div id="inv-spec-filters"></div>
  `;

  _renderSpecFilters();
}

function _renderSpecFilters() {
  const specEl = document.getElementById('inv-spec-filters');
  if (!specEl) return;

  const typeId = +(_typeFilter || 0);
  const schema = typeId ? (_specSchemas[typeId] || []) : [];

  if (!schema.length) { specEl.innerHTML = ''; return; }

  const controls = schema.map(f => {
    const cur = _specFilters[f.field_key] || {};
    let ctrl;
    if (f.field_type === 'number') {
      ctrl = `
        <span style="font-size:12px;color:var(--text3)">≥</span>
        <input type="number" step="any" style="width:70px;margin:0;font-size:12px"
          value="${cur.min ?? ''}" placeholder="min"
          onchange="window._inv._setSpecFilter('${f.field_key}','min',this.value);window._inv.applyFilters()">
        <span style="font-size:12px;color:var(--text3)">≤</span>
        <input type="number" step="any" style="width:70px;margin:0;font-size:12px"
          value="${cur.max ?? ''}" placeholder="max"
          onchange="window._inv._setSpecFilter('${f.field_key}','max',this.value);window._inv.applyFilters()">`;
    } else if (f.field_type === 'select') {
      const opts = (f.options || []).map(o =>
        `<option value="${_esc(o)}" ${cur.value === o ? 'selected' : ''}>${_esc(o)}</option>`
      ).join('');
      ctrl = `<select style="width:auto;margin:0;font-size:12px"
        onchange="window._inv._setSpecFilter('${f.field_key}','value',this.value);window._inv.applyFilters()">
        <option value="">Any</option>${opts}</select>`;
    } else if (f.field_type === 'boolean') {
      ctrl = `<select style="width:auto;margin:0;font-size:12px"
        onchange="window._inv._setSpecFilter('${f.field_key}','value',this.value);window._inv.applyFilters()">
        <option value="" ${!cur.value ? 'selected' : ''}>Any</option>
        <option value="true"  ${cur.value === 'true'  ? 'selected' : ''}>Yes</option>
        <option value="false" ${cur.value === 'false' ? 'selected' : ''}>No</option>
      </select>`;
    } else {
      ctrl = `<input type="text" style="width:120px;margin:0;font-size:12px" value="${_esc(cur.value ?? '')}"
        placeholder="filter…"
        oninput="window._inv._setSpecFilter('${f.field_key}','value',this.value);window._inv.applyFilters()">`;
    }

    const unitLabel = f.unit ? ` <span style="font-size:11px;color:var(--text3)">${_esc(f.unit)}</span>` : '';
    return `<span style="display:inline-flex;align-items:center;gap:.3rem;font-size:12px;font-weight:500;color:var(--text2)">${_esc(f.label)}${unitLabel}</span>${ctrl}`;
  }).join('');

  specEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;padding-bottom:.5rem;border-bottom:1px solid var(--border);margin-bottom:.25rem">
      ${controls}
      <button class="btn sm" style="font-size:11px" onclick="window._inv._clearSpecFilters()">Clear</button>
    </div>`;
}

function applyFilters() {
  const typeEl = document.getElementById('inv-type-filter');
  _typeFilter  = typeEl ? typeEl.value : '';
  _specFilters = {};
  _renderSpecFilters();
  _applyAndRender();
}

function _applyAndRender() {
  let items = _allItems;

  if (_typeFilter) {
    items = items.filter(it => String(it.equipment_type_id) === String(_typeFilter));
  }

  const typeId = +(_typeFilter || 0);
  const schema = typeId ? (_specSchemas[typeId] || []) : [];
  if (schema.length) {
    items = items.filter(it => {
      const sv = it.spec_values || {};
      for (const f of schema) {
        const filter = _specFilters[f.field_key];
        if (!filter) continue;
        const val = sv[f.field_key];
        if (f.field_type === 'number') {
          if (filter.min !== '' && filter.min != null && (val == null || +val < +filter.min)) return false;
          if (filter.max !== '' && filter.max != null && (val == null || +val > +filter.max)) return false;
        } else if (f.field_type === 'boolean') {
          if (filter.value) {
            const bval = String(val === true || val === 'true' || val === 1);
            if (bval !== filter.value) return false;
          }
        } else if (filter.value) {
          if (f.field_type === 'select') {
            if (val !== filter.value) return false;
          } else {
            if (!String(val ?? '').toLowerCase().includes(filter.value.toLowerCase())) return false;
          }
        }
      }
      return true;
    });
  }

  _renderTable(items);
}

function _renderTable(items) {
  const body = document.getElementById('inv-body');
  if (!body) return;

  if (!items.length) {
    body.innerHTML = `<div class="empty">${__('empty')}</div>`;
    return;
  }

  // Determine if we should show a spec summary column
  const typeId = +(_typeFilter || 0);
  const schema = typeId ? (_specSchemas[typeId] || []) : [];
  const showSpecs = schema.length > 0;

  body.innerHTML = `
    <table class="inv-table">
      <thead>
        <tr>
          <th>${__('colItem')}</th>
          <th>${__('colStatus')}</th>
          ${showSpecs ? `<th>Specs</th>` : ''}
          <th>${__('colBarrio')}</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(it => {
          let specsCell = '';
          if (showSpecs) {
            const sv  = it.spec_values || {};
            const bits = schema
              .filter(f => sv[f.field_key] != null && sv[f.field_key] !== '')
              .map(f => {
                const v = sv[f.field_key];
                const disp = f.field_type === 'boolean' ? (v ? 'Yes' : 'No') : v;
                return `<span>${_esc(f.label)}: <strong>${_esc(String(disp))}${f.unit ? ' ' + _esc(f.unit) : ''}</strong></span>`;
              });
            specsCell = `<td style="font-size:11px;color:var(--text2)">${bits.join(' &nbsp;·&nbsp; ') || '<span style="color:var(--text3)">—</span>'}</td>`;
          }
          return `
            <tr>
              <td>
                <div style="font-size:14px">${_esc(it.name)}</div>
                ${it.category ? `<div style="font-size:11px;color:var(--text3)">${_esc(it.category)}</div>` : ''}
              </td>
              <td>
                ${it.status === 'available'
                  ? `<span class="pill available"><span class="dot g"></span>${_c('statusAvailable')}</span>`
                  : `<span class="pill out"><span class="dot a"></span>${_c('statusOut')}</span>`
                }
              </td>
              ${specsCell}
              <td style="color:var(--text2);font-size:13px">${_esc(it.current_group ?? '—')}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

window._inv = window._inv || {};
Object.assign(window._inv, {
  _setSpecFilter(key, prop, val) {
    if (!_specFilters[key]) _specFilters[key] = {};
    _specFilters[key][prop] = val;
  },
  _clearSpecFilters() {
    _specFilters = {};
    _renderSpecFilters();
    _applyAndRender();
  },
});

const _esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
