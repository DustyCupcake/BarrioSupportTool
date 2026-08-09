/**
 * Admin equipment section — types and items.
 * Two sub-tabs: Equipment Types | Items
 */

import { get, post, put, del } from '../api.js?v=1.0.1';

let _toast;
let _types      = [];
let _items      = [];
let _locations  = [];
let _depts      = [];
let _deptUsers  = []; // own-department staff, for item-level "restrict to this person" picker
let _activeTab  = 'types';
let _selected   = new Set(); // selected item ids for bulk actions
let _csrf       = null;      // cached csrf token for multipart uploads
let _isFullAdmin = false;    // manage_equipment — full catalog access
let _myDeptIds   = [];       // dept-admin's own department(s), scoped via sub_checkout

async function getCsrf() {
  if (_csrf) return _csrf;
  const data = await get('/auth/csrf');
  _csrf = data.csrf_token;
  return _csrf;
}

export async function initEquipment(container, toast, user = null) {
  _toast        = toast;
  const perms   = user?.permissions || [];
  _isFullAdmin  = perms.includes('manage_equipment');
  _myDeptIds    = user?.dept_ids || [];

  renderShell(container);

  const loads = [loadTypes(), loadLocations(), loadDeptUsers()];
  if (_isFullAdmin) loads.push(loadDepartments());
  await Promise.all(loads);

  switchTab(_isFullAdmin ? 'types' : 'items');
}

async function loadLocations() {
  try {
    const data = await get('/admin/storage-locations');
    _locations = data.locations || [];
  } catch { _locations = []; }
}

async function loadDepartments() {
  try {
    const data = await get('/admin/departments');
    _depts = data.departments || [];
  } catch { _depts = []; } // dept-scoped admins can't list all departments — restrictions become view-only for them
}

async function loadDeptUsers() {
  try {
    const data = await get('/admin/users');
    // Full admins get every user in the system from this endpoint (not dept-scoped) —
    // filter to active staff so the item-restriction picker isn't cluttered with
    // person-badge holders. Dept-scoped callers already only see their own dept's staff.
    _deptUsers = (data.users || []).filter(u => u.role !== 'person' && u.is_active);
  } catch { _deptUsers = []; } // dept_staff (sub_checkout via a group-managing dept) lacks manage_dept_users — picker just stays empty
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
      <button class="section-tab${_isFullAdmin ? ' active' : ''}" data-etab="types" onclick="window._eq.tab('types')"
        ${_isFullAdmin ? '' : 'style="display:none"'}>Types</button>
      <button class="section-tab${_isFullAdmin ? '' : ' active'}" data-etab="items" onclick="window._eq.tab('items')">Items</button>
    </div>

    <div id="eq-form-area"></div>
    <div id="eq-table-area"><div class="empty"><span class="spinner"></span></div></div>
  `;

  window._eq = {
    tab: switchTab,
    openAddType, openEditType, saveType, deleteType,
    openAddItems, saveItems,
    editItem, deleteItem,
    saveItemEdit, cancelItemEdit,
    toggleSelect, toggleSelectAll, applyBulk,
    exportQR,
    addSpecField, removeSpecField, moveSpecField,
    uploadItemPhoto,
    openImportStatus, runImportStatus,
    addBorrowRule, removeBorrowRule,
    manageItemRules, addItemBorrowRule, removeItemBorrowRule,
    _useGps: () => {},
    _slugLabel(labelEl, keyId) {
      const keyEl = document.getElementById(keyId);
      if (!keyEl || keyEl.dataset.manual) return;
      keyEl.value = labelEl.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    },
    _autoKey(el) { el.dataset.manual = '1'; },
    _sfTypeChange(sel) {
      const optRow = document.getElementById('sf-options-row');
      if (optRow) optRow.style.display = sel.value === 'select' ? 'block' : 'none';
    },
  };
}

function switchTab(name) {
  if (name === 'types' && !_isFullAdmin) name = 'items';
  _activeTab = name;
  _selected  = new Set();
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
      <thead><tr><th>Name</th><th>Active items</th><th>Home location</th><th></th></tr></thead>
      <tbody>
        ${_types.map(t => `
          <tr>
            <td>
              ${esc(t.name)}
              ${t.borrowable ? '<span class="badge" style="margin-left:.4rem;font-size:10px;background:var(--accent-light);color:var(--accent-text)">Borrowable</span>' : ''}
              ${t.is_crate ? '<span class="badge" style="margin-left:.4rem;font-size:10px;background:var(--surface2);color:var(--text2)">Crate</span>' : ''}
            </td>
            <td>${t.item_count}</td>
            <td style="font-size:12px;color:var(--text2)">
              ${t.home_location_name ? esc(t.home_location_name) + (t.require_home_location ? ' ★' : '') : '—'}
            </td>
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
  const locOptions = _locations.map(l =>
    `<option value="${l.id}" ${String(t?.home_location_id) === String(l.id) ? 'selected' : ''}>${esc(l.name)}</option>`
  ).join('');

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
        <input type="checkbox" id="et-borrowable" ${t?.borrowable ? 'checked' : ''}>
        Borrowable — staff can personally check out items of this type
      </label>
      <label class="checkbox-row">
        <input type="checkbox" id="et-crate" ${t?.is_crate ? 'checked' : ''}
               onchange="document.getElementById('et-crate-dest').style.display=this.checked?'block':'none'">
        Crate — holds unlabeled items tracked by manifest (ladles, supplies, etc.)
      </label>
      <div id="et-crate-dest" style="${t?.is_crate ? '' : 'display:none;'}margin-top:.25rem">
        <div class="field" style="margin-top:0">
          <label>Deployment destination <span style="font-size:11px;color:var(--text3)">(where this crate goes at the event)</span></label>
          <input type="text" id="et-dest" value="${esc(t?.deployment_destination ?? '')}"
                 placeholder="e.g. Cantina kitchen area" maxlength="255">
        </div>
      </div>

      <div class="field" style="margin-top:.75rem">
        <label>Home storage location (optional — default for all items of this type)</label>
        <select id="et-home-loc">
          <option value="">— None —</option>
          ${locOptions}
        </select>
      </div>
      <label class="checkbox-row">
        <input type="checkbox" id="et-req-home" ${t?.require_home_location ? 'checked' : ''}>
        Must be returned to its home location to count as returned
      </label>
      <label class="checkbox-row">
        <input type="checkbox" id="et-req-any" ${t?.require_any_location ? 'checked' : ''}>
        Must scan any storage location QR when returning
      </label>

      ${t?.id ? `
      <div style="margin-top:1rem">
        <div style="font-size:13px;font-weight:500;margin-bottom:.2rem;color:var(--text2)">Self-checkout restrictions</div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:.5rem">
          Applies when "Borrowable" is on. With no departments listed, anyone with borrow permission can
          self-checkout items of this type. Add one or more departments to restrict it to their staff.
        </div>
        <div id="et-borrow-rules"><span class="spinner" style="width:14px;height:14px"></span></div>
        <div style="display:flex;gap:.5rem;margin-top:.5rem">
          <select id="et-rule-dept" style="flex:1"><option value="">— Select department —</option></select>
          <button class="btn sm" onclick="window._eq.addBorrowRule(${t.id})">+ Restrict</button>
        </div>
      </div>
      ` : ''}

      <div style="margin-top:1rem">
        <div style="font-size:13px;font-weight:500;margin-bottom:.5rem;color:var(--text2)">Spec fields for this type</div>
        <div id="et-spec-fields">${_renderSpecFieldsList(t?.spec_fields ?? [])}</div>
        <div id="et-spec-add-form" style="display:none;margin-top:.5rem;padding:.75rem;background:var(--surface2);border-radius:var(--radius)">
          <div class="form-row" style="margin-bottom:.5rem">
            <div class="field" style="margin:0">
              <label>Key <span style="font-size:10px;color:var(--text3)">(a–z, 0–9, _)</span></label>
              <input type="text" id="sf-key" placeholder="e.g. input_16a" maxlength="64" oninput="window._eq._autoKey(this)">
            </div>
            <div class="field" style="margin:0">
              <label>Label</label>
              <input type="text" id="sf-label" placeholder="e.g. 16A Inputs" maxlength="128"
                oninput="window._eq._slugLabel(this,'sf-key')">
            </div>
          </div>
          <div class="form-row" style="margin-bottom:.5rem">
            <div class="field" style="margin:0">
              <label>Type</label>
              <select id="sf-type" onchange="window._eq._sfTypeChange(this)">
                <option value="number">Number</option>
                <option value="text">Text</option>
                <option value="boolean">Boolean (yes/no)</option>
                <option value="select">Select (dropdown)</option>
              </select>
            </div>
            <div class="field" style="margin:0">
              <label>Unit <span style="font-size:10px;color:var(--text3)">(optional)</span></label>
              <input type="text" id="sf-unit" placeholder="e.g. kVA, seats" maxlength="32">
            </div>
          </div>
          <div id="sf-options-row" style="display:none;margin-bottom:.5rem">
            <div class="field" style="margin:0">
              <label>Options <span style="font-size:10px;color:var(--text3)">(one per line)</span></label>
              <textarea id="sf-options" rows="3" placeholder="Diesel&#10;Petrol&#10;LPG"></textarea>
            </div>
          </div>
          <div style="display:flex;gap:.5rem">
            <button class="btn primary sm" onclick="window._eq.addSpecField()">Add field</button>
            <button class="btn sm" onclick="document.getElementById('et-spec-add-form').style.display='none'">Cancel</button>
          </div>
        </div>
        <button class="btn sm" style="margin-top:.5rem" onclick="document.getElementById('et-spec-add-form').style.display='block';document.getElementById('sf-label').focus()">+ Add spec field</button>
      </div>

      <div class="form-actions">
        <button class="btn primary sm" onclick="window._eq.saveType()">Save</button>
        <button class="btn sm" onclick="document.getElementById('eq-form-area').innerHTML=''">Cancel</button>
      </div>
    </div>
  `;
  document.getElementById('et-name').focus();
  if (t?.id) loadBorrowRules(t.id);
}

async function loadBorrowRules(typeId) {
  const listEl = document.getElementById('et-borrow-rules');
  const selEl  = document.getElementById('et-rule-dept');
  if (!listEl) return;
  try {
    const data  = await get('/admin/borrow-rules?type_id=' + typeId);
    const rules = data.rules || [];
    renderBorrowRulesList(typeId, rules);
    if (selEl) {
      const used = new Set(rules.map(r => r.allowed_dept_id));
      selEl.innerHTML = '<option value="">— Select department —</option>' +
        _depts.filter(d => !used.has(d.id))
          .map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
    }
  } catch {
    listEl.innerHTML = '<div style="font-size:12px;color:var(--text3)">Could not load restrictions</div>';
    if (selEl) selEl.innerHTML = '<option value="">— No departments available —</option>';
  }
}

function renderBorrowRulesList(typeId, rules) {
  const listEl = document.getElementById('et-borrow-rules');
  if (!listEl) return;
  const deptRules = rules.filter(r => r.allowed_dept_id);
  if (!deptRules.length) {
    listEl.innerHTML = '<div style="font-size:12px;color:var(--text3)">No restrictions — open to anyone with borrow permission</div>';
    return;
  }
  listEl.innerHTML = deptRules.map(r => `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:.5rem;padding:.35rem 0;font-size:13px">
      <span>${esc(r.dept_name || 'Unknown department')}</span>
      <button class="action-btn danger" onclick="window._eq.removeBorrowRule(${r.id}, ${typeId})">Remove</button>
    </div>
  `).join('');
}

async function addBorrowRule(typeId) {
  const sel = document.getElementById('et-rule-dept');
  const deptId = sel?.value;
  if (!deptId) { _toast('Select a department first'); return; }
  try {
    await post('/admin/borrow-rules', { type_id: typeId, allowed_dept_id: +deptId });
    await loadBorrowRules(typeId);
    _toast('Restriction added');
  } catch (e) {
    _toast('Error: ' + e.message);
  }
}

async function removeBorrowRule(ruleId, typeId) {
  try {
    await del('/admin/borrow-rules/' + ruleId);
    await loadBorrowRules(typeId);
    _toast('Restriction removed');
  } catch (e) {
    _toast('Error: ' + e.message);
  }
}

async function saveType() {
  const id                  = document.getElementById('et-id').value;
  const name                = document.getElementById('et-name').value.trim();
  const cat                 = document.getElementById('et-cat').value.trim();
  const borrowable          = document.getElementById('et-borrowable').checked;
  const is_crate            = document.getElementById('et-crate').checked;
  const deployment_destination = document.getElementById('et-dest')?.value.trim() || null;
  const home_location_id    = document.getElementById('et-home-loc').value || null;
  const require_home_location = document.getElementById('et-req-home').checked;
  const require_any_location  = document.getElementById('et-req-any').checked;

  if (!name) { _toast('Name required'); return; }

  // Only prompt when actually turning a flag on, not on every save of an
  // already-required type.
  const existing  = id ? _types.find(t => String(t.id) === String(id)) : null;
  const turningOn = (require_home_location && !existing?.require_home_location)
                  || (require_any_location  && !existing?.require_any_location);
  if (turningOn && !confirm(
    'This will block checkin for every item of this type (that doesn\'t have its own override) until a storage location is scanned — including items just dropped off somewhere. Continue?'
  )) return;

  const payload = { name, category: cat, borrowable, is_crate, deployment_destination,
    home_location_id: home_location_id ? +home_location_id : null,
    require_home_location, require_any_location };

  try {
    if (id) {
      await put('/admin/equipment-types', { id: +id, ...payload });
      _toast('Type updated');
    } else {
      await post('/admin/equipment-types', payload);
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

// Flags when an item's require_home_location/require_any_location overrides
// its type's setting — otherwise the type-level checkbox silently has no
// effect on that item.
function _returnRuleBadge(it) {
  const homeSet = it.require_home_location !== null;
  const anySet   = it.require_any_location  !== null;
  if (!homeSet && !anySet) {
    return '<span style="color:var(--text3)">Inherits from type</span>';
  }
  const parts = [];
  if (homeSet) parts.push(`must return home: ${it.require_home_location ? 'yes' : 'no'}`);
  if (anySet)  parts.push(`must scan a location: ${it.require_any_location ? 'yes' : 'no'}`);
  return `<span class="badge admin" title="${esc(parts.join(', '))} — set on this item, not its type">⚠ Override</span>`;
}

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

  const addBtn    = _isFullAdmin ? `<button class="btn primary sm" style="margin-bottom:1rem;margin-right:.5rem" onclick="window._eq.openAddItems()">+ Add items</button>` : '';
  const exportBtn = _isFullAdmin ? `<button class="btn sm" style="margin-bottom:1rem;margin-right:.5rem" onclick="window._eq.exportQR('${filter_type_id}')">Export QR sheet</button>` : '';
  const importBtn = _isFullAdmin ? `<button class="btn sm" style="margin-bottom:1rem" onclick="window._eq.openImportStatus()">Import status updates (CSV)</button>` : '';

  const filter = `
    <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem">
      <span style="font-size:13px;color:var(--text2)">Filter by type:</span>
      <select id="items-type-filter" style="width:auto;margin:0">
        <option value="">All types</option>
        ${typeOptions}
      </select>
    </div>
  `;

  setTimeout(() => {
    const sel = document.getElementById('items-type-filter');
    if (sel) sel.addEventListener('change', () => renderItemsTable(sel.value));
  }, 0);

  if (!_items.length) {
    area.innerHTML = addBtn + exportBtn + importBtn + filter + '<div class="empty">No items found</div>';
    return;
  }

  const bulkBar = _isFullAdmin ? `
    <div id="eq-bulk-bar" style="display:none;align-items:center;gap:.5rem;flex-wrap:wrap;
         padding:.6rem .75rem;margin-bottom:.5rem;background:var(--accent-light);
         border:0.5px solid var(--accent);border-radius:var(--radius);font-size:13px">
      <span id="eq-bulk-count" style="color:var(--accent-text);font-weight:500;white-space:nowrap"></span>
      <select id="eq-bulk-loc" style="margin:0;width:auto">
        <option value="">— Set home location —</option>
        ${_locations.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}
        <option value="clear">Clear home location</option>
      </select>
      <select id="eq-bulk-req" style="margin:0;width:auto">
        <option value="">— Set require flag —</option>
        <option value="require_home">Must return to home location</option>
        <option value="require_any">Must scan any location</option>
        <option value="inherit">Inherit from type</option>
      </select>
      <button class="btn primary sm" onclick="window._eq.applyBulk()">Apply to selected</button>
    </div>
  ` : '';

  area.innerHTML = addBtn + exportBtn + importBtn + filter + bulkBar + `
    <table class="data-table">
      <thead>
        <tr>
          ${_isFullAdmin ? `<th style="width:32px"><input type="checkbox" id="eq-sel-all" title="Select all" onchange="window._eq.toggleSelectAll(this.checked)"></th>` : ''}
          <th>Item</th><th>QR code</th><th>Status</th><th>Home location</th><th>Return rule</th><th>GPS</th><th></th>
        </tr>
      </thead>
      <tbody>
        ${_items.map(it => {
          const sel = _selected.has(it.id);
          const homeLoc = it.home_location_name
            ? `<span title="Per-item override">📍 ${esc(it.home_location_name)}</span>`
            : '<span style="color:var(--text3)">—</span>';
          const returnRule = _returnRuleBadge(it);
          const hasGps = it.latitude != null;
          return `
          <tr id="item-row-${it.id}">
            ${_isFullAdmin ? `<td><input type="checkbox" data-id="${it.id}" ${sel ? 'checked' : ''}
              onchange="window._eq.toggleSelect(${it.id}, this.checked)"></td>` : ''}
            <td>
              <div>${esc(it.display_name)}</div>
              <div style="font-size:11px;color:var(--text3)">${esc(it.type_name)}</div>
            </td>
            <td style="font-family:monospace;font-size:12px">${esc(it.qr_code)}</td>
            <td><span class="badge ${it.status}">${it.status}</span></td>
            <td style="font-size:12px">${homeLoc}</td>
            <td style="font-size:12px">${returnRule}</td>
            <td style="font-size:12px;color:var(--text3)">${hasGps ? '✓' : '—'}</td>
            <td>
              <div class="table-actions">
                ${_isFullAdmin ? `
                  <button class="action-btn" onclick="window._eq.editItem(${it.id})">Edit</button>
                  <button class="action-btn danger" onclick="window._eq.deleteItem(${it.id})">Retire</button>
                ` : ''}
                <button class="action-btn" onclick="window._eq.manageItemRules(${it.id})">Restrictions</button>
              </div>
            </td>
          </tr>
        `}).join('')}
      </tbody>
    </table>
  `;

  if (_isFullAdmin) _updateBulkBar();
}

function toggleSelect(id, checked) {
  if (checked) _selected.add(id);
  else _selected.delete(id);
  _updateBulkBar();
  const allBox = document.getElementById('eq-sel-all');
  if (allBox) allBox.checked = _selected.size === _items.length;
}

function toggleSelectAll(checked) {
  _selected = checked ? new Set(_items.map(i => i.id)) : new Set();
  document.querySelectorAll('input[data-id]').forEach(cb => { cb.checked = checked; });
  _updateBulkBar();
}

function _updateBulkBar() {
  const bar = document.getElementById('eq-bulk-bar');
  if (!bar) return;
  const n = _selected.size;
  bar.style.display = n > 0 ? 'flex' : 'none';
  const cnt = document.getElementById('eq-bulk-count');
  if (cnt) cnt.textContent = `${n} item${n !== 1 ? 's' : ''} selected`;
}

async function applyBulk() {
  if (!_selected.size) return;
  const locVal = document.getElementById('eq-bulk-loc')?.value;
  const reqVal = document.getElementById('eq-bulk-req')?.value;

  const fields = {};
  if (locVal === 'clear') {
    fields.home_location_id = null;
  } else if (locVal) {
    fields.home_location_id = +locVal;
  }

  if (reqVal === 'require_home') {
    fields.require_home_location = true;
    fields.require_any_location  = false;
  } else if (reqVal === 'require_any') {
    fields.require_home_location = false;
    fields.require_any_location  = true;
  } else if (reqVal === 'inherit') {
    fields.require_home_location = null;
    fields.require_any_location  = null;
  }

  if (!Object.keys(fields).length) { _toast('Select something to apply'); return; }

  if ((reqVal === 'require_home' || reqVal === 'require_any') && !confirm(
    `This will block checkin for ${_selected.size} item${_selected.size !== 1 ? 's' : ''} until a storage location is scanned — including if they're just dropped off somewhere. Continue?`
  )) return;

  try {
    const res = await post('/admin/items/bulk-update', { item_ids: [..._selected], fields });
    _toast(`Updated ${res.updated} item${res.updated !== 1 ? 's' : ''}`);
    _selected = new Set();
    await renderItemsTable(document.getElementById('items-type-filter')?.value || '');
  } catch (e) { _toast('Error: ' + e.message); }
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

function openImportStatus() {
  document.getElementById('eq-form-area').innerHTML = `
    <div class="form-card">
      <h2>Import status updates (CSV)</h2>
      <div class="hint">
        Required column: <code>qr_code</code>. Optional columns — only the ones present in the
        file are applied, and a blank cell leaves that field unchanged:
        <ul style="margin:.35rem 0 0 1.1rem">
          <li><code>status</code> — available / checked-out / retired</li>
          <li><code>barrio</code> — group name to check the item out to; leave blank to check it
              back in from its current group</li>
          <li><code>notes</code></li>
        </ul>
      </div>
      <div class="field">
        <label>CSV file</label>
        <input type="file" id="isc-file" accept=".csv">
      </div>
      <div class="form-actions">
        <button class="btn primary sm" onclick="window._eq.runImportStatus()">Import</button>
        <button class="btn sm" onclick="document.getElementById('eq-form-area').innerHTML=''">Cancel</button>
      </div>
      <div id="isc-result"></div>
    </div>
  `;
}

async function runImportStatus() {
  const fileInput = document.getElementById('isc-file');
  const file = fileInput?.files?.[0];
  if (!file) { _toast('Select a CSV file first'); return; }

  try {
    const csrf = await getCsrf();
    const fd = new FormData();
    fd.append('file', file);
    const resp = await fetch('/api/admin/items/import-status-csv', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      credentials: 'include',
      body: fd,
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Import failed');

    _toast(`Updated ${data.updated} of ${data.processed} row(s) — ${data.checked_out} checked out, ${data.checked_in} checked in`);

    const resultEl = document.getElementById('isc-result');
    if (resultEl) {
      resultEl.innerHTML = data.errors.length
        ? `<div class="hint" style="color:var(--danger,#c00);margin-top:.5rem">
             ${data.errors.length} row(s) had problems:
             <ul style="margin:.35rem 0 0 1.1rem">${data.errors.map(e =>
               `<li>Row ${e.row} (${esc(e.qr_code)}): ${esc(e.error)}</li>`).join('')}</ul>
           </div>`
        : '';
    }
    await renderItemsTable();
  } catch (e) { _toast('Error: ' + e.message); }
}

function editItem(id) {
  const it = _items.find(x => x.id === id);
  if (!it) return;

  const locOptions = _locations.map(l =>
    `<option value="${l.id}" ${String(it.home_location_id) === String(l.id) ? 'selected' : ''}>${esc(l.name)}</option>`
  ).join('');

  // Tri-state for require flags: null = inherit, true = yes, false = no
  const reqHomeVal  = it.require_home_location === null  ? '' : (it.require_home_location  ? 'yes' : 'no');
  const reqAnyVal   = it.require_any_location  === null  ? '' : (it.require_any_location   ? 'yes' : 'no');

  const form = document.getElementById('eq-form-area');
  form.innerHTML = `
    <div class="form-card">
      <h2>Edit item: ${esc(it.display_name)}</h2>
      <input type="hidden" id="ei-id" value="${it.id}">

      <div class="field">
        <label>Per-item home location <span style="font-size:11px;color:var(--text3)">(overrides type default)</span></label>
        <select id="ei-home-loc">
          <option value="">— Use type default —</option>
          ${locOptions}
        </select>
      </div>

      <div class="form-row" style="margin-top:.5rem">
        <div class="field">
          <label>Require home location</label>
          <select id="ei-req-home" style="margin:0">
            <option value="" ${reqHomeVal === '' ? 'selected' : ''}>Inherit from type</option>
            <option value="yes" ${reqHomeVal === 'yes' ? 'selected' : ''}>Yes — must return to home</option>
            <option value="no"  ${reqHomeVal === 'no'  ? 'selected' : ''}>No — override type</option>
          </select>
        </div>
        <div class="field">
          <label>Require any location scan</label>
          <select id="ei-req-any" style="margin:0">
            <option value="" ${reqAnyVal === '' ? 'selected' : ''}>Inherit from type</option>
            <option value="yes" ${reqAnyVal === 'yes' ? 'selected' : ''}>Yes — must scan any location</option>
            <option value="no"  ${reqAnyVal === 'no'  ? 'selected' : ''}>No — override type</option>
          </select>
        </div>
      </div>

      <div class="field" style="margin-top:.5rem">
        <label>Notes</label>
        <input type="text" id="ei-notes" value="${esc(it.notes ?? '')}" maxlength="255" placeholder="Optional notes">
      </div>

      <div style="margin-top:.75rem">
        <label style="display:block;font-size:13px;font-weight:500;margin-bottom:.4rem;color:var(--text2)">
          GPS coordinates <span style="font-size:11px;font-weight:normal">(for water cubes or mobile assets)</span>
        </label>
        <div style="display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap">
          <div class="field" style="margin:0;flex:1;min-width:120px">
            <label>Latitude</label>
            <input type="number" id="ei-lat" value="${it.latitude ?? ''}" step="any" placeholder="e.g. 40.7851">
          </div>
          <div class="field" style="margin:0;flex:1;min-width:120px">
            <label>Longitude</label>
            <input type="number" id="ei-lng" value="${it.longitude ?? ''}" step="any" placeholder="e.g. -119.2063">
          </div>
          <button class="btn sm" style="margin:0;flex-shrink:0" onclick="window._eq._useGps('ei-lat','ei-lng')">📍 Use my location</button>
        </div>
      </div>

      ${_renderItemSpecFields(it)}

      ${_renderItemPhoto(it)}

      <div class="form-actions">
        <button class="btn primary sm" onclick="window._eq.saveItemEdit()">Save</button>
        <button class="btn sm" onclick="window._eq.cancelItemEdit()">Cancel</button>
      </div>
    </div>
  `;
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  window._eq._useGps = (latId, lngId) => {
    if (!navigator.geolocation) { _toast('Geolocation not available'); return; }
    navigator.geolocation.getCurrentPosition(
      pos => {
        const latEl = document.getElementById(latId);
        const lngEl = document.getElementById(lngId);
        if (latEl) latEl.value = pos.coords.latitude.toFixed(7);
        if (lngEl) lngEl.value = pos.coords.longitude.toFixed(7);
      },
      () => _toast('Could not get location — check permissions')
    );
  };
}

// ─── Spec fields ──────────────────────────────────────────────────────────────

async function saveItemEdit() {
  const id       = +document.getElementById('ei-id').value;
  const homeLoc  = document.getElementById('ei-home-loc').value;
  const reqHome  = document.getElementById('ei-req-home').value;
  const reqAny   = document.getElementById('ei-req-any').value;
  const notes    = document.getElementById('ei-notes').value.trim();
  const latVal   = document.getElementById('ei-lat').value.trim();
  const lngVal   = document.getElementById('ei-lng').value.trim();

  if (!id) return;

  const existingItem = _items.find(x => x.id === id);
  const turningOn = (reqHome === 'yes' && existingItem?.require_home_location !== true)
                  || (reqAny  === 'yes' && existingItem?.require_any_location  !== true);
  if (turningOn && !confirm(
    'This will block checkin for this item until a storage location is scanned — including if it\'s just dropped off somewhere. Continue?'
  )) return;

  const payload = { id };
  payload.home_location_id       = homeLoc !== '' ? +homeLoc : null;
  payload.require_home_location  = reqHome === '' ? null : reqHome === 'yes';
  payload.require_any_location   = reqAny  === '' ? null : reqAny  === 'yes';
  payload.notes                  = notes || null;
  payload.latitude               = latVal  !== '' ? parseFloat(latVal)  : null;
  payload.longitude              = lngVal  !== '' ? parseFloat(lngVal)  : null;

  // Collect spec values
  const it = _items.find(x => x.id === id);
  const type = _types.find(t => t.id === it?.type_id);
  if (type?.spec_fields?.length) {
    const sv = {};
    for (const f of type.spec_fields) {
      const el = document.getElementById('ei-sf-' + f.field_key);
      if (!el) continue;
      if (f.field_type === 'boolean') {
        sv[f.field_key] = el.checked;
      } else if (f.field_type === 'number') {
        sv[f.field_key] = el.value !== '' ? parseFloat(el.value) : null;
      } else {
        sv[f.field_key] = el.value !== '' ? el.value : null;
      }
    }
    payload.spec_values = sv;
  }

  try {
    await put('/admin/items', payload);
    _toast('Item updated');
    document.getElementById('eq-form-area').innerHTML = '';
    await renderItemsTable(document.getElementById('items-type-filter')?.value || '');
  } catch (e) { _toast('Error: ' + e.message); }
}

function cancelItemEdit() {
  document.getElementById('eq-form-area').innerHTML = '';
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

// ─── Item-level self-checkout restrictions ─────────────────────────────────
// Restrict a specific item to a specific staff member — the item-level
// counterpart to the type-level department restrictions in showTypeForm().
// Reachable by both full admins and dept admins (borrow_rules.php scopes
// dept admins to items owned by their own department).

function manageItemRules(id) {
  const it = _items.find(x => x.id === id);
  if (!it) return;

  const form = document.getElementById('eq-form-area');
  form.innerHTML = `
    <div class="form-card">
      <h2>Self-checkout restrictions</h2>
      <div style="font-size:13px;color:var(--text2);margin-bottom:.5rem">${esc(it.display_name)}</div>
      <div style="font-size:11px;color:var(--text3);margin-bottom:.5rem">
        With no restrictions, anyone with borrow permission can self-checkout this item.
        Add a specific staff member to restrict it to just them.
      </div>
      <div id="ei-borrow-rules"><span class="spinner" style="width:14px;height:14px"></span></div>
      <div style="display:flex;gap:.5rem;margin-top:.5rem">
        <select id="ei-rule-user" style="flex:1"><option value="">— Select staff member —</option></select>
        <button class="btn sm" onclick="window._eq.addItemBorrowRule(${id})">+ Restrict</button>
      </div>
      <div class="form-actions">
        <button class="btn sm" onclick="window._eq.cancelItemEdit()">Close</button>
      </div>
    </div>
  `;
  loadItemBorrowRules(id);
}

async function loadItemBorrowRules(itemId) {
  const listEl = document.getElementById('ei-borrow-rules');
  const selEl  = document.getElementById('ei-rule-user');
  if (!listEl) return;
  try {
    const data  = await get('/admin/borrow-rules?item_id=' + itemId);
    const rules = data.rules || [];
    renderItemBorrowRulesList(itemId, rules);
    if (selEl) {
      const used = new Set(rules.map(r => r.allowed_user_id));
      selEl.innerHTML = '<option value="">— Select staff member —</option>' +
        _deptUsers.filter(u => !used.has(u.id))
          .map(u => `<option value="${u.id}">${esc(u.display_name)}</option>`).join('');
    }
  } catch {
    listEl.innerHTML = '<div style="font-size:12px;color:var(--text3)">Could not load restrictions</div>';
    if (selEl) selEl.innerHTML = '<option value="">— No staff list available —</option>';
  }
}

function renderItemBorrowRulesList(itemId, rules) {
  const listEl = document.getElementById('ei-borrow-rules');
  if (!listEl) return;
  const userRules = rules.filter(r => r.allowed_user_id);
  if (!userRules.length) {
    listEl.innerHTML = '<div style="font-size:12px;color:var(--text3)">No restrictions — open to anyone with borrow permission</div>';
    return;
  }
  listEl.innerHTML = userRules.map(r => `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:.5rem;padding:.35rem 0;font-size:13px">
      <span>${esc(r.user_name || 'Unknown user')}</span>
      <button class="action-btn danger" onclick="window._eq.removeItemBorrowRule(${r.id}, ${itemId})">Remove</button>
    </div>
  `).join('');
}

async function addItemBorrowRule(itemId) {
  const sel = document.getElementById('ei-rule-user');
  const userId = sel?.value;
  if (!userId) { _toast('Select a staff member first'); return; }
  try {
    await post('/admin/borrow-rules', { item_id: itemId, allowed_user_id: +userId });
    await loadItemBorrowRules(itemId);
    _toast('Restriction added');
  } catch (e) {
    _toast('Error: ' + e.message);
  }
}

async function removeItemBorrowRule(ruleId, itemId) {
  try {
    await del('/admin/borrow-rules/' + ruleId);
    await loadItemBorrowRules(itemId);
    _toast('Restriction removed');
  } catch (e) {
    _toast('Error: ' + e.message);
  }
}

function exportQR(type_id = '') {
  const url = '/api/admin/items/qr-sheet' + (type_id ? '?type_id=' + type_id : '');
  window.open(url, '_blank');
}

// ─── Spec field helpers ───────────────────────────────────────────────────────

function _renderSpecFieldsList(fields) {
  if (!fields.length) return '<div style="font-size:12px;color:var(--text3);margin-bottom:.25rem">No spec fields defined yet.</div>';
  return fields.map((f, i) => `
    <div style="display:flex;align-items:center;gap:.4rem;padding:.35rem .5rem;background:var(--surface2);border-radius:var(--radius);margin-bottom:.25rem;font-size:12px" data-sf-id="${f.id}">
      <span style="flex:1;font-weight:500">${esc(f.label)}</span>
      <span style="color:var(--text3)">${esc(f.field_key)}</span>
      <span style="color:var(--text3);background:var(--surface3);padding:.1rem .35rem;border-radius:3px">${f.field_type}${f.unit ? ' · ' + esc(f.unit) : ''}</span>
      <button class="action-btn" title="Move up" onclick="window._eq.moveSpecField(${f.id},-1)" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="action-btn" title="Move down" onclick="window._eq.moveSpecField(${f.id},1)" ${i === fields.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="action-btn danger" onclick="window._eq.removeSpecField(${f.id})">×</button>
    </div>
  `).join('');
}

function _renderItemSpecFields(it) {
  const type = _types.find(t => t.id === it.type_id);
  if (!type?.spec_fields?.length) return '';
  const sv = it.spec_values || {};
  const rows = type.spec_fields.map(f => {
    const val = sv[f.field_key] ?? '';
    let input;
    if (f.field_type === 'boolean') {
      input = `<input type="checkbox" id="ei-sf-${esc(f.field_key)}" ${val ? 'checked' : ''} style="width:auto;margin-top:.3rem">`;
    } else if (f.field_type === 'select') {
      const opts = (f.options || []).map(o => `<option value="${esc(o)}" ${val === o ? 'selected' : ''}>${esc(o)}</option>`).join('');
      input = `<select id="ei-sf-${esc(f.field_key)}" style="margin:0"><option value="">—</option>${opts}</select>`;
    } else if (f.field_type === 'number') {
      input = `<input type="number" id="ei-sf-${esc(f.field_key)}" value="${esc(val)}" step="any"${f.unit ? ` placeholder="${esc(f.unit)}"` : ''}>`;
    } else {
      input = `<input type="text" id="ei-sf-${esc(f.field_key)}" value="${esc(val)}" maxlength="255">`;
    }
    const unitLabel = f.unit ? `<span style="font-size:11px;color:var(--text3);margin-left:.25rem">${esc(f.unit)}</span>` : '';
    return `
      <div class="field" style="margin:0;min-width:120px">
        <label>${esc(f.label)}${unitLabel}</label>
        ${input}
      </div>`;
  }).join('');

  return `
    <div style="margin-top:.75rem">
      <label style="display:block;font-size:13px;font-weight:500;margin-bottom:.4rem;color:var(--text2)">Specs</label>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">${rows}</div>
    </div>`;
}

function _renderItemPhoto(it) {
  const thumb = it.photo
    ? `<div style="margin-bottom:.5rem"><img src="/${it.photo}?t=${Date.now()}" style="max-width:200px;max-height:140px;border-radius:var(--radius);border:1px solid var(--border)"></div>`
    : `<div style="font-size:12px;color:var(--text3);margin-bottom:.5rem">No photo yet.</div>`;
  return `
    <div style="margin-top:.75rem">
      <label style="display:block;font-size:13px;font-weight:500;margin-bottom:.4rem;color:var(--text2)">Photo</label>
      <div id="ei-photo-thumb">${thumb}</div>
      <input type="file" id="ei-photo-file" accept="image/*" style="font-size:12px">
      <button class="btn sm" style="margin-top:.35rem" onclick="window._eq.uploadItemPhoto()">Upload photo</button>
    </div>`;
}

async function uploadItemPhoto() {
  const id   = +document.getElementById('ei-id')?.value;
  const file = document.getElementById('ei-photo-file')?.files?.[0];
  if (!id || !file) { _toast('Select a photo file first'); return; }

  try {
    const csrf = await getCsrf();
    const fd   = new FormData();
    fd.append('photo', file);
    const resp = await fetch(`/api/items/${id}/photo`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      credentials: 'include',
      body: fd,
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Upload failed');
    _toast('Photo uploaded');
    const thumb = document.getElementById('ei-photo-thumb');
    if (thumb) thumb.innerHTML = `<img src="/${data.photo}?t=${Date.now()}" style="max-width:200px;max-height:140px;border-radius:var(--radius);border:1px solid var(--border)">`;
  } catch (e) { _toast('Error: ' + e.message); }
}

async function addSpecField() {
  const typeId = +document.getElementById('et-id').value;
  const key    = document.getElementById('sf-key').value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const label  = document.getElementById('sf-label').value.trim();
  const ftype  = document.getElementById('sf-type').value;
  const unit   = document.getElementById('sf-unit').value.trim();
  const rawOpts = document.getElementById('sf-options')?.value ?? '';
  const options  = rawOpts.split('\n').map(s => s.trim()).filter(Boolean);

  if (!key)   { _toast('Key required'); return; }
  if (!label) { _toast('Label required'); return; }
  if (!/^[a-z0-9_]+$/.test(key)) { _toast('Key must be lowercase letters, numbers, and underscores'); return; }
  if (ftype === 'select' && !options.length) { _toast('Options required for select type'); return; }

  if (!typeId) {
    // New type — queue field for after save. Not supported yet; show guidance.
    _toast('Save the type first, then add spec fields.');
    return;
  }

  try {
    const payload = { field_key: key, label, field_type: ftype, unit: unit || null };
    if (ftype === 'select') payload.options = options;
    await post(`/admin/equipment-types/${typeId}/spec-fields`, payload);
    _toast('Spec field added');
    document.getElementById('et-spec-add-form').style.display = 'none';
    document.getElementById('sf-key').value   = '';
    document.getElementById('sf-label').value = '';
    document.getElementById('sf-unit').value  = '';
    if (document.getElementById('sf-options')) document.getElementById('sf-options').value = '';
    await loadTypes();
    const type = _types.find(t => t.id === typeId);
    document.getElementById('et-spec-fields').innerHTML = _renderSpecFieldsList(type?.spec_fields ?? []);
  } catch (e) { _toast('Error: ' + e.message); }
}

async function removeSpecField(sfId) {
  if (!confirm('Remove this spec field? Values stored on items will be deleted.')) return;
  const typeId = +document.getElementById('et-id').value;
  try {
    await del(`/admin/spec-fields/${sfId}`, {});
    _toast('Spec field removed');
    await loadTypes();
    const type = _types.find(t => t.id === typeId);
    document.getElementById('et-spec-fields').innerHTML = _renderSpecFieldsList(type?.spec_fields ?? []);
  } catch (e) { _toast('Error: ' + e.message); }
}

async function moveSpecField(sfId, dir) {
  const typeId = +document.getElementById('et-id').value;
  const type   = _types.find(t => t.id === typeId);
  if (!type) return;
  const fields = [...(type.spec_fields || [])];
  const idx    = fields.findIndex(f => f.id === sfId);
  if (idx < 0) return;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= fields.length) return;
  [fields[idx], fields[newIdx]] = [fields[newIdx], fields[idx]];
  try {
    await put(`/admin/equipment-types/${typeId}/spec-fields/reorder`, { order: fields.map(f => f.id) });
    await loadTypes();
    const updated = _types.find(t => t.id === typeId);
    document.getElementById('et-spec-fields').innerHTML = _renderSpecFieldsList(updated?.spec_fields ?? []);
  } catch (e) { _toast('Error: ' + e.message); }
}

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
