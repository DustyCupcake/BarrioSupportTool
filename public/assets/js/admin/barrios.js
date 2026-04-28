/**
 * Admin barrios section — list, create, edit, delete, orders, CSV import.
 */

import { get, post, put, del, getCsrf } from '../api.js?v=1.0.1';

let _toast;
let _barrios = [];
let _consumable_types  = [];
let _equipment_types   = [];

export async function initBarrios(container, toast) {
  _toast = toast;
  render(container);
  await Promise.all([load(container), loadTypes()]);
}

async function loadTypes() {
  try {
    const [ct, et] = await Promise.all([
      get('/admin/consumable-types'),
      get('/admin/equipment-types'),
    ]);
    _consumable_types = ct.types  || [];
    _equipment_types  = et.types  || [];
  } catch { /* non-fatal */ }
}

function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Barrios</div>
        <div class="page-subtitle">Manage the camps and groups that can check out equipment</div>
      </div>
      <div class="btn-group">
        <button class="btn primary sm" onclick="window._barrios.openAdd()">+ Add barrio</button>
        <button class="btn sm" onclick="window._barrios.openImport()">Import CSV</button>
      </div>
    </div>

    <div class="form-card" id="import-form" style="display:none">
      <h2>Import barrios via CSV</h2>
      <p style="margin:0 0 8px;color:var(--text2);font-size:14px">
        Required column: <code>name</code>. Optional: <code>sort_order</code>,
        consumable type keys (e.g. <code>water_vouchers</code>),
        equipment type names (e.g. <code>Radio</code>).
      </p>
      <div class="field">
        <input type="file" id="import-file" accept=".csv">
      </div>
      <div class="form-actions">
        <button class="btn primary sm" onclick="window._barrios.runImport()">Import</button>
        <button class="btn sm" onclick="window._barrios.closeImport()">Cancel</button>
      </div>
    </div>

    <div class="form-card" id="barrio-form" style="display:none">
      <h2 id="barrio-form-title">Add barrio</h2>
      <input type="hidden" id="barrio-id">
      <div class="field">
        <label for="barrio-name">Name</label>
        <input type="text" id="barrio-name" placeholder="e.g. El Corazón" maxlength="128">
      </div>
      <div class="field">
        <label for="barrio-sort">Sort order</label>
        <input type="text" id="barrio-sort" placeholder="0" style="max-width:80px">
      </div>
      <div class="form-actions">
        <button class="btn primary sm" onclick="window._barrios.save()">Save</button>
        <button class="btn sm" onclick="window._barrios.closeForm()">Cancel</button>
      </div>
    </div>

    <div class="form-card" id="orders-form" style="display:none">
      <h2>Orders for <span id="orders-barrio-name"></span></h2>
      <input type="hidden" id="orders-barrio-id">

      <div id="orders-consumables-section">
        <div class="card-label" style="margin-bottom:.5rem">Consumables purchased</div>
        <div id="orders-consumables-inputs"></div>
      </div>

      <div id="orders-equipment-section" style="margin-top:1rem">
        <div class="card-label" style="margin-bottom:.5rem">Equipment ordered</div>
        <div id="orders-equipment-inputs"></div>
      </div>

      <div class="form-actions" style="margin-top:1rem">
        <button class="btn primary sm" onclick="window._barrios.saveOrders()">Save orders</button>
        <button class="btn sm" onclick="window._barrios.closeOrders()">Cancel</button>
      </div>
    </div>

    <div id="barrio-table-wrap">
      <div class="empty"><span class="spinner"></span> Loading…</div>
    </div>
  `;

  window._barrios = {
    openAdd, openEdit, save, closeForm,
    remove: removeBarrio,
    openImport, closeImport, runImport,
    openOrders, closeOrders, saveOrders,
  };
}

async function load(container) {
  const wrap = container?.querySelector('#barrio-table-wrap') ?? document.getElementById('barrio-table-wrap');
  try {
    const data = await get('/admin/barrios');
    _barrios   = data.barrios || [];
    renderTable(wrap);
  } catch (e) {
    if (wrap) wrap.innerHTML = `<div class="empty">Failed to load: ${e.message}</div>`;
    _toast('Error: ' + e.message);
  }
}

function renderTable(wrap) {
  if (!wrap) return;
  if (!_barrios.length) {
    wrap.innerHTML = '<div class="empty">No barrios yet — add one above</div>';
    return;
  }
  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Name</th><th></th></tr></thead>
      <tbody>
        ${_barrios.map(b => `
          <tr>
            <td>${esc(b.name)}</td>
            <td>
              <div class="table-actions">
                <button class="action-btn" onclick="window.open('/api/admin/barrio-qr?id=${b.id}','_blank')">QR</button>
                <button class="action-btn" onclick="window._barrios.openOrders(${b.id})">Orders</button>
                <button class="action-btn" onclick="window._barrios.openEdit(${b.id})">Edit</button>
                <button class="action-btn danger" onclick="window._barrios.remove(${b.id})">Delete</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

// ─── Barrio add/edit form ─────────────────────────────────────────────────────

function openAdd() {
  closeOrders(); closeImport();
  document.getElementById('barrio-form-title').textContent = 'Add barrio';
  document.getElementById('barrio-id').value   = '';
  document.getElementById('barrio-name').value = '';
  document.getElementById('barrio-sort').value = '0';
  document.getElementById('barrio-form').style.display = '';
  document.getElementById('barrio-name').focus();
}

function openEdit(id) {
  closeOrders(); closeImport();
  const b = _barrios.find(x => x.id === id);
  if (!b) return;
  document.getElementById('barrio-form-title').textContent = 'Edit barrio';
  document.getElementById('barrio-id').value   = id;
  document.getElementById('barrio-name').value = b.name;
  document.getElementById('barrio-sort').value = b.sort_order;
  document.getElementById('barrio-form').style.display = '';
  document.getElementById('barrio-name').focus();
}

function closeForm() {
  document.getElementById('barrio-form').style.display = 'none';
}

async function save() {
  const id   = document.getElementById('barrio-id').value;
  const name = document.getElementById('barrio-name').value.trim();
  const sort = parseInt(document.getElementById('barrio-sort').value || '0');

  if (!name) { _toast('Name required'); return; }

  try {
    if (id) {
      await put('/admin/barrios', { id: +id, name, sort_order: sort });
      _toast('Barrio updated');
    } else {
      await post('/admin/barrios', { name, sort_order: sort });
      _toast('Barrio created');
    }
    closeForm();
    await load();
  } catch (e) {
    _toast('Error: ' + e.message);
  }
}

async function removeBarrio(id) {
  const b = _barrios.find(x => x.id === id);
  if (!confirm(`Delete "${b?.name}"?`)) return;
  try {
    await del('/admin/barrios', { id });
    _toast('Barrio deleted');
    await load();
  } catch (e) {
    _toast('Error: ' + e.message);
  }
}

// ─── Orders form ──────────────────────────────────────────────────────────────

async function openOrders(id) {
  closeForm(); closeImport();
  const b = _barrios.find(x => x.id === id);
  if (!b) return;

  document.getElementById('orders-barrio-id').value      = id;
  document.getElementById('orders-barrio-name').textContent = esc(b.name);

  // Fetch current entitlements & equipment orders for this barrio
  let entitlements = [];
  let equipment_orders = [];
  try {
    const data = await get('/barrios/' + id);
    entitlements     = data.entitlements     || [];
    equipment_orders = data.equipment_orders || [];
  } catch { /* show empty */ }

  // Build consumable inputs
  const consWrap = document.getElementById('orders-consumables-inputs');
  if (_consumable_types.length) {
    consWrap.innerHTML = _consumable_types.map(ct => {
      const existing = entitlements.find(e => e.type_id === ct.id);
      const val = existing ? existing.purchased : 0;
      return `
        <div class="field" style="display:flex;align-items:center;gap:.75rem;margin-bottom:.5rem">
          <label style="min-width:160px;margin:0">${esc(ct.name)}</label>
          <input type="number" min="0" value="${val}"
            data-cons-type-id="${ct.id}"
            style="max-width:100px">
        </div>`;
    }).join('');
  } else {
    consWrap.innerHTML = '<div style="color:var(--text3);font-size:13px">No consumable types defined</div>';
  }

  // Build equipment inputs
  const eqWrap = document.getElementById('orders-equipment-inputs');
  if (_equipment_types.length) {
    eqWrap.innerHTML = _equipment_types.map(et => {
      const existing = equipment_orders.find(o => o.equipment_type_id === et.id);
      const val = existing ? existing.quantity_ordered : 0;
      return `
        <div class="field" style="display:flex;align-items:center;gap:.75rem;margin-bottom:.5rem">
          <label style="min-width:160px;margin:0">${esc(et.name)}</label>
          <input type="number" min="0" value="${val}"
            data-eq-type-id="${et.id}"
            style="max-width:100px">
        </div>`;
    }).join('');
  } else {
    eqWrap.innerHTML = '<div style="color:var(--text3);font-size:13px">No equipment types defined</div>';
  }

  document.getElementById('orders-form').style.display = '';
  document.getElementById('orders-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeOrders() {
  document.getElementById('orders-form').style.display = 'none';
}

async function saveOrders() {
  const barrio_id = +document.getElementById('orders-barrio-id').value;
  if (!barrio_id) return;

  const btn = document.querySelector('#orders-form .btn.primary');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving…'; }

  try {
    // Save consumable entitlements
    const consInputs = document.querySelectorAll('[data-cons-type-id]');
    for (const inp of consInputs) {
      await put('/admin/barrio-entitlements', {
        barrio_id,
        type_id:   +inp.dataset.consTypeId,
        purchased: Math.max(0, parseInt(inp.value || '0')),
      });
    }

    // Save equipment orders
    const eqInputs = document.querySelectorAll('[data-eq-type-id]');
    for (const inp of eqInputs) {
      await put('/admin/barrio-equipment-orders', {
        barrio_id,
        equipment_type_id: +inp.dataset.eqTypeId,
        quantity_ordered:  Math.max(0, parseInt(inp.value || '0')),
      });
    }

    _toast('Orders saved');
    closeOrders();
  } catch (e) {
    _toast('Error: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Save orders'; }
  }
}

// ─── CSV import ───────────────────────────────────────────────────────────────

function openImport() {
  closeForm(); closeOrders();
  document.getElementById('import-file').value = '';
  document.getElementById('import-form').style.display = '';
}

function closeImport() {
  document.getElementById('import-form').style.display = 'none';
}

async function runImport() {
  const fileInput = document.getElementById('import-file');
  const file = fileInput?.files?.[0];
  if (!file) { _toast('Select a CSV file first'); return; }

  const btn = document.querySelector('#import-form .btn.primary');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Importing…'; }

  try {
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch('/api/admin/barrios/import-csv', {
      method:      'POST',
      credentials: 'include',
      headers:     { 'X-CSRF-Token': getCsrf() },
      body:        formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import failed');

    const { created = 0, updated = 0, skipped = 0 } = data;
    _toast(`Imported: ${created} created, ${updated} updated${skipped ? `, ${skipped} skipped` : ''}`);
    closeImport();
    await load();
  } catch (e) {
    _toast('Error: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Import'; }
  }
}

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
