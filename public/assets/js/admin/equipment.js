/**
 * Admin equipment section — types and items.
 * Two sub-tabs: Equipment Types | Items
 */

import { get, post, put, del } from '../api.js?v=1.0.1';

let _toast;
let _types = [];
let _items = [];
let _activeTab = 'types';

export async function initEquipment(container, toast) {
  _toast = toast;
  renderShell(container);
  await loadTypes();
  switchTab('types');
}

function renderShell(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Equipment</div>
        <div class="page-subtitle">Manage equipment types and individual items</div>
      </div>
    </div>

    <div class="section-tabs">
      <button class="section-tab active" data-etab="types" onclick="window._eq.tab('types')">Types</button>
      <button class="section-tab" data-etab="items" onclick="window._eq.tab('items')">Items</button>
    </div>

    <div id="eq-form-area"></div>
    <div id="eq-table-area"><div class="empty"><span class="spinner"></span></div></div>
  `;

  window._eq = {
    tab: switchTab,
    openAddType, openEditType, saveType, deleteType,
    openAddItems, saveItems,
    editItem, deleteItem,
    exportQR,
  };
}

function switchTab(name) {
  _activeTab = name;
  document.querySelectorAll('.section-tab[data-etab]').forEach(b => {
    b.classList.toggle('active', b.dataset.etab === name);
  });
  document.getElementById('eq-form-area').innerHTML = '';
  if (name === 'types') renderTypesTable();
  else renderItemsTable();
}

// ─── Types ────────────────────────────────────────────────────────────────

async function loadTypes() {
  try {
    const data = await get('/admin/equipment-types');
    _types = data.types || [];
  } catch (e) {
    _toast('Failed to load types: ' + e.message);
  }
}

function renderTypesTable() {
  const area = document.getElementById('eq-table-area');
  const addBtn = `<button class="btn primary sm" style="margin-bottom:1rem" onclick="window._eq.openAddType()">+ Add type</button>`;

  if (!_types.length) {
    area.innerHTML = addBtn + '<div class="empty">No equipment types yet</div>';
    return;
  }
  area.innerHTML = addBtn + `
    <table class="data-table">
      <thead><tr><th>Name</th><th>Active items</th><th></th></tr></thead>
      <tbody>
        ${_types.map(t => `
          <tr>
            <td>
              ${esc(t.name)}
              ${t.secure_qr ? '<span class="badge voucher" style="margin-left:.4rem;font-size:10px">Voucher</span>' : ''}
            </td>
            <td>${t.item_count}</td>
            <td>
              <div class="table-actions">
                <button class="action-btn" onclick="window._eq.openEditType(${t.id})">Edit</button>
                <button class="action-btn danger" onclick="window._eq.deleteType(${t.id})">Delete</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function openAddType() {
  showTypeForm(null);
}
function openEditType(id) {
  showTypeForm(_types.find(t => t.id === id));
}

function showTypeForm(t) {
  const form = document.getElementById('eq-form-area');
  form.innerHTML = `
    <div class="form-card">
      <h2>${t ? 'Edit type' : 'Add equipment type'}</h2>
      <input type="hidden" id="et-id" value="${t?.id ?? ''}">
      <div class="form-row">
        <div class="field">
          <label>Name</label>
          <input type="text" id="et-name" value="${esc(t?.name ?? '')}" placeholder="e.g. Generator" maxlength="128">
        </div>
        <div class="field">
          <label>Category (optional)</label>
          <input type="text" id="et-cat" value="${esc(t?.category ?? '')}" placeholder="e.g. Power" maxlength="64">
        </div>
      </div>
      <label class="checkbox-row">
        <input type="checkbox" id="et-secure" ${t?.secure_qr ? 'checked' : ''}>
        Secure QR — random 5-digit codes, voucher mode
      </label>
      <div class="form-actions">
        <button class="btn primary sm" onclick="window._eq.saveType()">Save</button>
        <button class="btn sm" onclick="document.getElementById('eq-form-area').innerHTML=''">Cancel</button>
      </div>
    </div>
  `;
  document.getElementById('et-name').focus();
}

async function saveType() {
  const id        = document.getElementById('et-id').value;
  const name      = document.getElementById('et-name').value.trim();
  const cat       = document.getElementById('et-cat').value.trim();
  const secure_qr = document.getElementById('et-secure').checked;
  if (!name) { _toast('Name required'); return; }

  try {
    if (id) {
      await put('/admin/equipment-types', { id: +id, name, category: cat, secure_qr });
      _toast('Type updated');
    } else {
      await post('/admin/equipment-types', { name, category: cat, secure_qr });
      _toast('Type created');
    }
    document.getElementById('eq-form-area').innerHTML = '';
    await loadTypes();
    renderTypesTable();
  } catch (e) { _toast('Error: ' + e.message); }
}

async function deleteType(id) {
  const t = _types.find(x => x.id === id);
  if (!confirm(`Delete type "${t?.name}"? This will fail if active items exist.`)) return;
  try {
    await del('/admin/equipment-types', { id });
    _toast('Type deleted');
    await loadTypes();
    renderTypesTable();
  } catch (e) { _toast('Error: ' + e.message); }
}

// ─── Items ────────────────────────────────────────────────────────────────

async function loadItems(type_id = '') {
  try {
    const data = await get('/admin/items', type_id ? { type_id } : {});
    _items = data.items || [];
  } catch (e) {
    _toast('Failed to load items: ' + e.message);
  }
}

async function renderItemsTable(filter_type_id = '') {
  const area = document.getElementById('eq-table-area');
  await loadItems(filter_type_id);

  const typeOptions = _types.map(t =>
    `<option value="${t.id}" ${String(filter_type_id) === String(t.id) ? 'selected' : ''}>${esc(t.name)}</option>`
  ).join('');

  const addBtn = `<button class="btn primary sm" style="margin-bottom:1rem;margin-right:.5rem" onclick="window._eq.openAddItems()">+ Add items</button>`;
  const exportBtn = `<button class="btn sm" style="margin-bottom:1rem" onclick="window._eq.exportQR('${filter_type_id}')">Export QR sheet</button>`;

  const filter = `
    <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem">
      <span style="font-size:13px;color:var(--text2)">Filter by type:</span>
      <select id="items-type-filter" style="width:auto;margin:0" onchange="window._eq.tab('items')">
        <option value="">All types</option>
        ${typeOptions}
      </select>
    </div>
  `;

  // Re-read filter after rendering
  setTimeout(() => {
    const sel = document.getElementById('items-type-filter');
    if (sel) sel.addEventListener('change', () => renderItemsTable(sel.value));
  }, 0);

  if (!_items.length) {
    area.innerHTML = addBtn + exportBtn + filter + '<div class="empty">No items found</div>';
    return;
  }

  area.innerHTML = addBtn + exportBtn + filter + `
    <table class="data-table">
      <thead><tr><th>Item</th><th>QR code</th><th>Status</th><th>Barrio</th><th></th></tr></thead>
      <tbody>
        ${_items.map(it => `
          <tr>
            <td>
              <div>${esc(it.display_name)}</div>
              <div style="font-size:11px;color:var(--text3)">${esc(it.type_name)}</div>
            </td>
            <td style="font-family:monospace;font-size:12px">${esc(it.qr_code)}</td>
            <td><span class="badge ${it.status}">${it.status}</span></td>
            <td style="font-size:13px;color:var(--text2)">${it.current_barrio ? esc(it.current_barrio) : '—'}</td>
            <td>
              <div class="table-actions">
                <button class="action-btn danger" onclick="window._eq.deleteItem(${it.id})">Retire</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function openAddItems() {
  const typeOptions = _types.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  document.getElementById('eq-form-area').innerHTML = `
    <div class="form-card">
      <h2>Add items</h2>
      <div class="form-row">
        <div class="field">
          <label>Equipment type</label>
          <select id="ai-type">${typeOptions}</select>
        </div>
        <div class="field">
          <label>Number to create</label>
          <input type="text" id="ai-count" value="1" style="max-width:80px">
        </div>
      </div>
      <div class="field">
        <label>QR code prefix</label>
        <input type="text" id="ai-prefix" placeholder="e.g. GEN" maxlength="12" style="text-transform:uppercase">
        <div class="hint">Leave blank to auto-generate from type name. Items will be: PREFIX-001, PREFIX-002…</div>
      </div>
      <div class="form-actions">
        <button class="btn primary sm" onclick="window._eq.saveItems()">Create</button>
        <button class="btn sm" onclick="document.getElementById('eq-form-area').innerHTML=''">Cancel</button>
      </div>
    </div>
  `;
  document.getElementById('ai-type').focus();
}

async function saveItems() {
  const type_id   = +document.getElementById('ai-type').value;
  const count     = parseInt(document.getElementById('ai-count').value || '1');
  const qr_prefix = document.getElementById('ai-prefix').value.trim().toUpperCase();

  if (!type_id || isNaN(count) || count < 1) { _toast('Select a type and enter a valid count'); return; }

  try {
    const res = await post('/admin/items', { equipment_type_id: type_id, count, qr_prefix });
    _toast(`Created ${res.created.length} item(s)`);
    document.getElementById('eq-form-area').innerHTML = '';
    await renderItemsTable();
  } catch (e) { _toast('Error: ' + e.message); }
}

async function editItem(id) {
  // Currently just status/notes edit — kept simple
  _toast('Use retire to remove items from service');
}

async function deleteItem(id) {
  const it = _items.find(x => x.id === id);
  if (!confirm(`Retire "${it?.display_name}"? It will be hidden from inventory.`)) return;
  try {
    await del('/admin/items', { id });
    _toast('Item retired');
    await renderItemsTable();
  } catch (e) { _toast('Error: ' + e.message); }
}

function exportQR(type_id = '') {
  const url = '/api/admin/items/qr-sheet' + (type_id ? '?type_id=' + type_id : '');
  window.open(url, '_blank');
}

const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
