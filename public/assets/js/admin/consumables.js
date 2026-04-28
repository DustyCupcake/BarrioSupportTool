/**
 * Admin consumable types section — define item kinds (water vouchers, ice tokens, etc.)
 */

import { get, post, put, del } from '../api.js?v=1.0.1';

let _toast;
let _types = [];

export async function initConsumables(container, toast) {
  _toast = toast;
  render(container);
  await load(container);
}

function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Consumable Types</div>
        <div class="page-subtitle">Define item kinds that barrios can purchase (water vouchers, ice tokens, etc.)</div>
      </div>
      <button class="btn primary sm" onclick="window._consumables.openAdd()">+ Add type</button>
    </div>

    <div class="form-card" id="cons-form" style="display:none">
      <h2 id="cons-form-title">Add type</h2>
      <input type="hidden" id="cons-id">
      <div class="field">
        <label for="cons-name">Display name</label>
        <input type="text" id="cons-name" placeholder="e.g. Water Vouchers" maxlength="128">
      </div>
      <div class="field" id="cons-key-field">
        <label for="cons-key">Key name <span style="color:var(--text3);font-size:12px">(lowercase, underscores — used as CSV column header)</span></label>
        <input type="text" id="cons-key" placeholder="e.g. water_vouchers" maxlength="64">
      </div>
      <div class="field">
        <label for="cons-sort">Sort order</label>
        <input type="text" id="cons-sort" placeholder="0" style="max-width:80px">
      </div>
      <div class="form-actions">
        <button class="btn primary sm" onclick="window._consumables.save()">Save</button>
        <button class="btn sm" onclick="window._consumables.closeForm()">Cancel</button>
      </div>
    </div>

    <div id="cons-table-wrap">
      <div class="empty"><span class="spinner"></span> Loading…</div>
    </div>
  `;

  window._consumables = { openAdd, openEdit, save, closeForm, remove: removeType };
}

async function load(container) {
  const wrap = container?.querySelector('#cons-table-wrap') ?? document.getElementById('cons-table-wrap');
  try {
    const data = await get('/admin/consumable-types');
    _types = data.types || [];
    renderTable(wrap);
  } catch (e) {
    if (wrap) wrap.innerHTML = `<div class="empty">Failed to load: ${e.message}</div>`;
    _toast('Error: ' + e.message);
  }
}

function renderTable(wrap) {
  if (!wrap) return;
  if (!_types.length) {
    wrap.innerHTML = '<div class="empty">No consumable types yet — add one above</div>';
    return;
  }
  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Name</th><th>Key</th><th>Sort</th><th></th></tr></thead>
      <tbody>
        ${_types.map(t => `
          <tr>
            <td>${esc(t.name)}</td>
            <td><code style="font-size:12px">${esc(t.key_name)}</code></td>
            <td>${t.sort_order}</td>
            <td>
              <div class="table-actions">
                <button class="action-btn" onclick="window._consumables.openEdit(${t.id})">Edit</button>
                <button class="action-btn danger" onclick="window._consumables.remove(${t.id})"
                  ${t.entitlement_count > 0 ? `title="Has ${t.entitlement_count} entitlement record(s)"` : ''}>
                  Delete
                </button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function openAdd() {
  document.getElementById('cons-form-title').textContent = 'Add type';
  document.getElementById('cons-id').value   = '';
  document.getElementById('cons-name').value = '';
  document.getElementById('cons-key').value  = '';
  document.getElementById('cons-sort').value = '0';
  document.getElementById('cons-key-field').style.display = '';
  document.getElementById('cons-form').style.display = '';
  document.getElementById('cons-name').focus();
}

function openEdit(id) {
  const t = _types.find(x => x.id === id);
  if (!t) return;
  document.getElementById('cons-form-title').textContent = 'Edit type';
  document.getElementById('cons-id').value   = id;
  document.getElementById('cons-name').value = t.name;
  document.getElementById('cons-key').value  = t.key_name;
  document.getElementById('cons-sort').value = t.sort_order;
  document.getElementById('cons-key-field').style.display = 'none'; // key_name immutable after creation
  document.getElementById('cons-form').style.display = '';
  document.getElementById('cons-name').focus();
}

function closeForm() {
  document.getElementById('cons-form').style.display = 'none';
}

async function save() {
  const id   = document.getElementById('cons-id').value;
  const name = document.getElementById('cons-name').value.trim();
  const key  = document.getElementById('cons-key').value.trim().toLowerCase().replace(/\s+/g, '_');
  const sort = parseInt(document.getElementById('cons-sort').value || '0');

  if (!name) { _toast('Name required'); return; }
  if (!id && !key) { _toast('Key name required'); return; }

  try {
    if (id) {
      await put('/admin/consumable-types', { id: +id, name, sort_order: sort });
      _toast('Type updated');
    } else {
      await post('/admin/consumable-types', { name, key_name: key, sort_order: sort });
      _toast('Type created');
    }
    closeForm();
    await load();
  } catch (e) {
    _toast('Error: ' + e.message);
  }
}

async function removeType(id) {
  const t = _types.find(x => x.id === id);
  if (t?.entitlement_count > 0) {
    _toast(`Cannot delete — ${t.entitlement_count} entitlement record(s) use this type`);
    return;
  }
  if (!confirm(`Delete "${t?.name}"?`)) return;
  try {
    await del('/admin/consumable-types', { id });
    _toast('Type deleted');
    await load();
  } catch (e) {
    _toast('Error: ' + e.message);
  }
}

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
