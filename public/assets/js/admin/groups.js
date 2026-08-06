/**
 * Admin groups section — list, create, edit, delete, orders, CSV import.
 * Merges what used to be separate admin/barrios.js and admin/artists.js:
 * a group is any team/camp/collective a department lends equipment to, with
 * "Track arrival status" / "Track consumable entitlements" as per-group
 * capability checkboxes instead of a hardcoded barrio/artist type.
 */

import { get, post, put, del, getCsrf } from '../api.js?v=1.0.1';

let _toast;
let _groups = [];
let _consumable_types  = [];
let _equipment_types   = [];
let _depts    = [];      // populated for manage_departments users only
let _myDeptId = null;    // dept admin's own dept id
let _isFullAdmin = false;

export async function initGroups(container, toast, user = null) {
  _toast       = toast;
  const perms  = user?.permissions ?? [];
  _isFullAdmin = perms.includes('manage_departments');

  if (!_isFullAdmin && user?.dept_ids?.length) {
    _myDeptId = user.dept_ids[0];
  }

  render(container);

  const loads = [load(container), loadTypes()];
  if (_isFullAdmin) loads.push(loadDepts());
  await Promise.all(loads);
}

async function loadTypes() {
  try {
    const [ct, et] = await Promise.all([
      get('/admin/consumable-types'),
      get('/admin/equipment-types'),
    ]);
    _consumable_types = ct.types || [];
    _equipment_types  = et.types || [];
  } catch { /* non-fatal */ }
}

async function loadDepts() {
  try {
    const data = await get('/admin/departments');
    _depts = data.departments || [];
  } catch { /* non-fatal */ }
}

function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Groups</div>
        <div class="page-subtitle">Manage the camps, artists, and other groups that can check out equipment</div>
      </div>
      <div class="btn-group">
        <button class="btn primary sm" onclick="window._groups.openAdd()">+ Add group</button>
        <button class="btn sm" onclick="window._groups.openImport()">Import CSV (barrio-style)</button>
        <button class="btn sm" onclick="window._groups.openDeptImport()">Import CSV (dept-scoped)</button>
        <button class="btn sm" onclick="window._groups.openImportLocations()">Import locations</button>
      </div>
    </div>

    <div class="form-card" id="import-form" style="display:none">
      <h2>Import groups via CSV</h2>
      <p style="margin:0 0 8px;color:var(--text2);font-size:14px">
        Required column: <code>name</code>. Optional: <code>sort_order</code>,
        consumable type keys (e.g. <code>water_fill</code> for fill credits — see the
        "key" column under Consumables for the exact keys to use),
        equipment type names (e.g. <code>Radio</code>). Groups created this way have
        arrival tracking and consumable entitlements enabled by default (barrio-style).
      </p>
      <div class="field">
        <input type="file" id="import-file" accept=".csv">
      </div>
      <div class="form-actions">
        <button class="btn primary sm" onclick="window._groups.runImport()">Import</button>
        <button class="btn sm" onclick="window._groups.closeImport()">Cancel</button>
      </div>
    </div>

    <div class="form-card" id="dept-import-form" style="display:none">
      <h2>Import groups via CSV (dept-scoped)</h2>
      <p style="margin:0 0 8px;color:var(--text2);font-size:14px">
        Required column: <code>name</code>. Optional: <code>sort_order</code>, <code>assigned_staff</code> (username).
        All groups are created under one selected department (artist-style — no arrival tracking).
      </p>
      <div id="dept-import-dept-field"></div>
      <div class="field">
        <input type="file" id="dept-import-file" accept=".csv">
      </div>
      <div class="form-actions">
        <button class="btn primary sm" onclick="window._groups.runDeptImport()">Import</button>
        <button class="btn sm" onclick="window._groups.closeDeptImport()">Cancel</button>
      </div>
    </div>

    <div class="form-card" id="import-locations-form" style="display:none">
      <h2>Import group locations via CSV</h2>
      <p style="margin:0 0 8px;color:var(--text2);font-size:14px">
        Required columns: <code>group_name</code>, <code>location_name</code>, <code>latitude</code>, <code>longitude</code>.<br>
        Upserts by group + location name. Creates storage location entries linked to each group.
      </p>
      <div class="field">
        <input type="file" id="import-locations-file" accept=".csv">
      </div>
      <div class="form-actions">
        <button class="btn primary sm" onclick="window._groups.runImportLocations()">Import</button>
        <button class="btn sm" onclick="window._groups.closeImportLocations()">Cancel</button>
      </div>
      <div id="import-locations-result" style="font-size:13px;margin-top:.5rem;color:var(--text2)"></div>
    </div>

    <div class="form-card" id="group-form" style="display:none">
      <h2 id="group-form-title">Add group</h2>
      <input type="hidden" id="group-id">
      <div class="field">
        <label for="group-name">Name</label>
        <input type="text" id="group-name" placeholder="e.g. El Corazón or Soundscape Collective" maxlength="128">
      </div>
      <div id="group-dept-field"></div>
      <div class="field">
        <label for="group-sort">Sort order</label>
        <input type="text" id="group-sort" placeholder="0" style="max-width:80px">
      </div>
      <div class="field">
        <label for="group-staff">Assigned staff username <span style="color:var(--text3)">(optional)</span></label>
        <input type="text" id="group-staff" placeholder="username">
      </div>
      <div class="field" style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" id="group-arrival-track" style="width:auto;margin:0">
        <label for="group-arrival-track" style="margin:0">Track arrival status</label>
      </div>
      <div class="field" style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" id="group-ent-track" style="width:auto;margin:0">
        <label for="group-ent-track" style="margin:0">Track consumable entitlements</label>
      </div>
      <div class="field" id="group-status-field" style="display:none">
        <label for="group-status">Arrival status</label>
        <select id="group-status">
          <option value="expected">Expected</option>
          <option value="on-site">On-site</option>
          <option value="departed">Departed</option>
        </select>
      </div>
      <div class="form-actions">
        <button class="btn primary sm" onclick="window._groups.save()">Save</button>
        <button class="btn sm" onclick="window._groups.closeForm()">Cancel</button>
      </div>
    </div>

    <div class="form-card" id="locations-form" style="display:none">
      <h2>Storage locations for <span id="locations-group-name"></span></h2>
      <div id="locations-list"></div>
      <div class="form-actions">
        <button class="btn sm" onclick="window._groups.closeLocations()">Close</button>
      </div>
    </div>

    <div class="form-card" id="orders-form" style="display:none">
      <h2>Orders for <span id="orders-group-name"></span></h2>
      <input type="hidden" id="orders-group-id">

      <div id="orders-consumables-section">
        <div class="card-label" style="margin-bottom:.5rem">Consumables purchased</div>
        <div id="orders-consumables-inputs"></div>
      </div>

      <div id="orders-equipment-section" style="margin-top:1rem">
        <div class="card-label" style="margin-bottom:.5rem">Equipment ordered</div>
        <div id="orders-equipment-inputs"></div>
      </div>

      <div class="form-actions" style="margin-top:1rem">
        <button class="btn primary sm" onclick="window._groups.saveOrders()">Save orders</button>
        <button class="btn sm" onclick="window._groups.closeOrders()">Cancel</button>
      </div>
    </div>

    <div id="group-table-wrap">
      <div class="empty"><span class="spinner"></span> Loading…</div>
    </div>
  `;

  window._groups = {
    openAdd, openEdit, save, closeForm,
    remove: removeGroup,
    openImport, closeImport, runImport,
    openDeptImport, closeDeptImport, runDeptImport,
    openImportLocations, closeImportLocations, runImportLocations,
    openOrders, closeOrders, saveOrders,
    openLocations, closeLocations,
  };
}

async function load(container) {
  const wrap = container?.querySelector('#group-table-wrap') ?? document.getElementById('group-table-wrap');
  try {
    const data = await get('/admin/groups');
    _groups    = data.groups || [];
    renderTable(wrap);
  } catch (e) {
    if (wrap) wrap.innerHTML = `<div class="empty">Failed to load: ${e.message}</div>`;
    _toast('Error: ' + e.message);
  }
}

function renderTable(wrap) {
  if (!wrap) return;
  if (!_groups.length) {
    wrap.innerHTML = '<div class="empty">No groups yet — add one above</div>';
    return;
  }
  const statusBadge = g => {
    if (!g.enable_arrival_tracking) return `<span style="color:var(--text3);font-size:12px">—</span>`;
    const s = g.arrival_status || 'expected';
    if (s === 'on-site')  return `<span class="badge available" style="font-size:11px">On-site</span>`;
    if (s === 'departed') return `<span class="badge" style="font-size:11px;background:var(--danger-bg);color:var(--danger)">Departed</span>`;
    return `<span style="color:var(--text3);font-size:12px">Expected</span>`;
  };
  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Name</th><th>Team</th><th>Status</th><th>Assigned staff</th><th></th></tr></thead>
      <tbody>
        ${_groups.map(g => `
          <tr>
            <td>${esc(g.name)}</td>
            <td style="color:var(--text2);font-size:13px">${g.dept_name ? esc(g.dept_name) : '—'}</td>
            <td>${statusBadge(g)}</td>
            <td style="color:var(--text2);font-size:13px">${g.assigned_staff_name ? esc(g.assigned_staff_name) : '—'}</td>
            <td>
              <div class="table-actions">
                <button class="action-btn" onclick="window.open('/api/admin/group-qr?id=${g.id}','_blank')">QR</button>
                <button class="action-btn" onclick="window._groups.openOrders(${g.id})">Orders</button>
                <button class="action-btn" onclick="window._groups.openLocations(${g.id})">Locations</button>
                <button class="action-btn" onclick="window._groups.openEdit(${g.id})">Edit</button>
                <button class="action-btn danger" onclick="window._groups.remove(${g.id})">Delete</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

// ─── Group add/edit form ───────────────────────────────────────────────────────

function deptSelectHtml(selectedId = null) {
  if (!_isFullAdmin) return '';
  const options = ['<option value="">— None —</option>', ..._depts.map(d =>
    `<option value="${d.id}" ${d.id === selectedId ? 'selected' : ''}>${esc(d.name)}</option>`
  )].join('');
  return `
    <div class="field">
      <label for="group-dept">Team</label>
      <select id="group-dept">${options}</select>
    </div>`;
}

function openAdd() {
  closeOrders(); closeImport(); closeDeptImport(); closeImportLocations(); closeLocations();
  document.getElementById('group-form-title').textContent = 'Add group';
  document.getElementById('group-id').value    = '';
  document.getElementById('group-name').value  = '';
  document.getElementById('group-sort').value  = '0';
  document.getElementById('group-staff').value = '';
  document.getElementById('group-arrival-track').checked = false;
  document.getElementById('group-ent-track').checked     = false;
  document.getElementById('group-status-field').style.display = 'none';
  document.getElementById('group-dept-field').innerHTML = deptSelectHtml();
  document.getElementById('group-form').style.display = '';
  document.getElementById('group-name').focus();
}

function openEdit(id) {
  closeOrders(); closeImport(); closeDeptImport(); closeImportLocations(); closeLocations();
  const g = _groups.find(x => x.id === id);
  if (!g) return;
  document.getElementById('group-form-title').textContent = 'Edit group';
  document.getElementById('group-id').value    = id;
  document.getElementById('group-name').value  = g.name;
  document.getElementById('group-sort').value  = g.sort_order ?? 0;
  document.getElementById('group-staff').value = g.assigned_staff_name ?? '';
  document.getElementById('group-arrival-track').checked = !!g.enable_arrival_tracking;
  document.getElementById('group-ent-track').checked     = !!g.enable_consumable_entitlements;
  document.getElementById('group-status').value = g.arrival_status || 'expected';
  document.getElementById('group-status-field').style.display = g.enable_arrival_tracking ? '' : 'none';
  document.getElementById('group-dept-field').innerHTML = deptSelectHtml(g.dept_id);
  document.getElementById('group-form').style.display = '';

  document.getElementById('group-arrival-track').onchange = (e) => {
    document.getElementById('group-status-field').style.display = e.target.checked ? '' : 'none';
  };

  document.getElementById('group-name').focus();
}

function closeForm() {
  document.getElementById('group-form').style.display = 'none';
}

async function save() {
  const id             = document.getElementById('group-id').value;
  const name           = document.getElementById('group-name').value.trim();
  const sort           = parseInt(document.getElementById('group-sort').value || '0');
  const staffName      = document.getElementById('group-staff').value.trim();
  const enableArrival  = document.getElementById('group-arrival-track').checked;
  const enableEnt      = document.getElementById('group-ent-track').checked;
  const dept_id        = _isFullAdmin
    ? (document.getElementById('group-dept')?.value ? +document.getElementById('group-dept').value : null)
    : _myDeptId;

  if (!name) { _toast('Name required'); return; }

  const body = {
    name, sort_order: sort, dept_id,
    enable_arrival_tracking: enableArrival,
    enable_consumable_entitlements: enableEnt,
  };
  if (staffName) body.assigned_staff_username = staffName;

  try {
    if (id) {
      body.id = +id;
      if (enableArrival) body.arrival_status = document.getElementById('group-status').value;
      await put('/admin/groups', body);
      _toast('Group updated');
    } else {
      await post('/admin/groups', body);
      _toast('Group created');
    }
    closeForm();
    await load();
  } catch (e) {
    _toast('Error: ' + e.message);
  }
}

async function removeGroup(id) {
  const g = _groups.find(x => x.id === id);
  if (!confirm(`Delete "${g?.name}"?`)) return;
  try {
    await del('/admin/groups', { id });
    _toast('Group deleted');
    await load();
  } catch (e) {
    _toast('Error: ' + e.message);
  }
}

// ─── Storage locations (read-only view) ────────────────────────────────────────

async function openLocations(id) {
  closeForm(); closeImport(); closeDeptImport(); closeImportLocations(); closeOrders();
  const g = _groups.find(x => x.id === id);
  if (!g) return;

  document.getElementById('locations-group-name').textContent = esc(g.name);
  const list = document.getElementById('locations-list');
  list.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  document.getElementById('locations-form').style.display = '';
  document.getElementById('locations-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const data = await get('/admin/storage-locations');
    const locs = (data.locations || []).filter(l => l.group_id === id || l.barrio_id === id);
    if (!locs.length) {
      list.innerHTML = `<div style="color:var(--text3);font-size:13px">
        No storage locations linked to this group yet. Add one under
        Storage Locations, or use "Import locations" above.</div>`;
      return;
    }
    list.innerHTML = locs.map(l => `
      <div class="field" style="display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-bottom:.4rem">
        <span>${esc(l.name)}</span>
        <span style="font-size:12px;color:var(--text3)">${l.latitude != null
          ? `<a href="https://maps.apple.com/?ll=${l.latitude},${l.longitude}" target="_blank">${l.latitude}, ${l.longitude}</a>`
          : 'no coordinates'}</span>
      </div>`).join('');
  } catch (e) {
    list.innerHTML = `<div class="empty">Failed to load: ${e.message}</div>`;
  }
}

function closeLocations() {
  document.getElementById('locations-form').style.display = 'none';
}

// ─── Orders form ──────────────────────────────────────────────────────────────

async function openOrders(id) {
  closeForm(); closeImport(); closeDeptImport(); closeImportLocations(); closeLocations();
  const g = _groups.find(x => x.id === id);
  if (!g) return;

  document.getElementById('orders-group-id').value        = id;
  document.getElementById('orders-group-name').textContent = esc(g.name);

  // Fetch current entitlements & equipment orders for this group
  let entitlements = [];
  let equipment_orders = [];
  try {
    const data = await get('/groups/' + id);
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
  const group_id = +document.getElementById('orders-group-id').value;
  if (!group_id) return;

  const btn = document.querySelector('#orders-form .btn.primary');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving…'; }

  try {
    // Save consumable entitlements
    const consInputs = document.querySelectorAll('[data-cons-type-id]');
    for (const inp of consInputs) {
      await put('/admin/barrio-entitlements', {
        group_id,
        type_id:   +inp.dataset.consTypeId,
        purchased: Math.max(0, parseInt(inp.value || '0')),
      });
    }

    // Save equipment orders
    const eqInputs = document.querySelectorAll('[data-eq-type-id]');
    for (const inp of eqInputs) {
      await put('/admin/barrio-equipment-orders', {
        group_id,
        equipment_type_id: +inp.dataset.eqTypeId,
        quantity_ordered:  Math.max(0, parseInt(inp.value || '0')),
      });
    }

    if (btn) { btn.disabled = false; btn.textContent = 'Save orders'; }
    _toast('Orders saved');
    closeOrders();
  } catch (e) {
    _toast('Error: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Save orders'; }
  }
}

// ─── CSV import (barrio-style: consumables + equipment order columns) ────────

function openImport() {
  closeForm(); closeOrders(); closeDeptImport(); closeImportLocations(); closeLocations();
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

    const res = await fetch('/api/admin/groups/import-csv', {
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

// ─── CSV import (dept-scoped, artist-style) ───────────────────────────────────

function openDeptImport() {
  closeForm(); closeOrders(); closeImport(); closeImportLocations(); closeLocations();
  document.getElementById('dept-import-file').value = '';

  const deptField = document.getElementById('dept-import-dept-field');
  if (_isFullAdmin) {
    const options = _depts.map(d =>
      `<option value="${d.id}">${esc(d.name)}</option>`
    ).join('');
    deptField.innerHTML = `
      <div class="field">
        <label for="dept-import-dept">Team</label>
        <select id="dept-import-dept">${options}</select>
      </div>`;
  } else {
    deptField.innerHTML = '';
  }

  document.getElementById('dept-import-form').style.display = '';
}

function closeDeptImport() {
  document.getElementById('dept-import-form').style.display = 'none';
}

async function runDeptImport() {
  const fileInput = document.getElementById('dept-import-file');
  const file = fileInput?.files?.[0];
  if (!file) { _toast('Select a CSV file first'); return; }

  const deptId = _isFullAdmin
    ? +(document.getElementById('dept-import-dept')?.value ?? 0)
    : _myDeptId;

  if (!deptId) { _toast('Team required'); return; }

  const btn = document.querySelector('#dept-import-form .btn.primary');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Importing…'; }

  try {
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch(`/api/admin/groups/import-dept-csv?dept_id=${deptId}`, {
      method:      'POST',
      credentials: 'include',
      headers:     { 'X-CSRF-Token': getCsrf() },
      body:        formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import failed');

    const { created = 0, updated = 0, skipped = 0 } = data;
    _toast(`Imported: ${created} created, ${updated} updated${skipped ? `, ${skipped} skipped` : ''}`);
    closeDeptImport();
    await load();
  } catch (e) {
    _toast('Error: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Import'; }
  }
}

// ─── Group locations CSV import ───────────────────────────────────────────────

function openImportLocations() {
  closeForm(); closeImport(); closeDeptImport(); closeOrders(); closeLocations();
  document.getElementById('import-locations-file').value = '';
  document.getElementById('import-locations-result').textContent = '';
  document.getElementById('import-locations-form').style.display = '';
}

function closeImportLocations() {
  document.getElementById('import-locations-form').style.display = 'none';
}

async function runImportLocations() {
  const fileInput = document.getElementById('import-locations-file');
  const file = fileInput?.files?.[0];
  if (!file) { _toast('Select a CSV file first'); return; }

  const btn    = document.querySelector('#import-locations-form .btn.primary');
  const result = document.getElementById('import-locations-result');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Importing…'; }
  if (result) result.textContent = '';

  try {
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch('/api/admin/groups/import-locations-csv', {
      method:      'POST',
      credentials: 'include',
      headers:     { 'X-CSRF-Token': getCsrf() },
      body:        formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import failed');

    const { created = 0, updated = 0, skipped = 0, errors = [] } = data;
    const summary = `${created} created, ${updated} updated${skipped ? `, ${skipped} skipped` : ''}`;
    _toast('Locations imported: ' + summary);
    if (result) {
      result.innerHTML = summary + (errors.length
        ? '<br><span style="color:var(--danger)">' + errors.map(e => esc(e)).join('<br>') + '</span>'
        : '');
    }
  } catch (e) {
    _toast('Error: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Import'; }
  }
}

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
