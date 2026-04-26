/**
 * Admin barrios section — list, create, edit, delete.
 */

import { get, post, put, del } from '../api.js';

let _toast;
let _barrios = [];

export async function initBarrios(container, toast) {
  _toast = toast;
  render(container);
  await load(container);
}

function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Barrios</div>
        <div class="page-subtitle">Manage the camps and groups that can check out equipment</div>
      </div>
      <button class="btn primary sm" onclick="window._barrios.openAdd()">+ Add barrio</button>
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

    <div id="barrio-table-wrap">
      <div class="empty"><span class="spinner"></span> Loading…</div>
    </div>
  `;

  window._barrios = { openAdd, openEdit, save, closeForm, remove: removeBarrio };
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
      <thead><tr><th>Name</th><th>Sort</th><th>Created</th><th></th></tr></thead>
      <tbody>
        ${_barrios.map(b => `
          <tr>
            <td>${esc(b.name)}</td>
            <td>${b.sort_order}</td>
            <td style="font-size:12px;color:var(--text3)">${fmtDate(b.created_at)}</td>
            <td>
              <div class="table-actions">
                <button class="action-btn" onclick="window.open('/api/admin/barrio-qr?id=${b.id}','_blank')">QR</button>
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

function openAdd() {
  document.getElementById('barrio-form-title').textContent = 'Add barrio';
  document.getElementById('barrio-id').value   = '';
  document.getElementById('barrio-name').value = '';
  document.getElementById('barrio-sort').value = '0';
  document.getElementById('barrio-form').style.display = '';
  document.getElementById('barrio-name').focus();
}

function openEdit(id) {
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

const esc   = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmtDate = s => s ? new Date(s).toLocaleDateString() : '—';
