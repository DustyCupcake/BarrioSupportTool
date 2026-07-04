/**
 * Admin: Storage Locations section.
 * Create/edit/delete physical storage locations and print QR sheets.
 */

import { get, post, put, del } from '../api.js?v=1.0.1';

let _toast;
let _locations = [];
let _barrios   = [];

export async function initStorageLocations(container, toast) {
  _toast = toast;
  renderShell(container);
  await Promise.all([load(), loadBarrios()]);
  render();
}

function renderShell(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Storage Locations</div>
        <div class="page-subtitle">Physical places where equipment is stored. Print QR codes to label each spot.</div>
      </div>
    </div>
    <div id="sl-form-area"></div>
    <div id="sl-table-area"><div class="empty"><span class="spinner"></span></div></div>
  `;

  window._sl = {
    openAdd, openEdit, save, remove, exportQR,
  };
}

async function load() {
  try {
    const data = await get('/admin/storage-locations');
    _locations = data.locations || [];
  } catch (e) {
    _toast('Failed to load locations: ' + e.message);
  }
}

async function loadBarrios() {
  try {
    const data = await get('/admin/barrios');
    _barrios = data.barrios || [];
  } catch (e) {
    _toast('Failed to load barrios: ' + e.message);
  }
}

function render() {
  const area   = document.getElementById('sl-table-area');
  if (!area) return;

  const addBtn    = `<button class="btn primary sm" style="margin-bottom:1rem;margin-right:.5rem" onclick="window._sl.openAdd()">+ Add location</button>`;
  const exportBtn = `<button class="btn sm" style="margin-bottom:1rem" onclick="window._sl.exportQR()">Print QR sheet</button>`;

  if (!_locations.length) {
    area.innerHTML = addBtn + exportBtn + '<div class="empty">No storage locations yet. Add one to get started.</div>';
    return;
  }

  area.innerHTML = addBtn + exportBtn + `
    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Description</th>
          <th>Belongs to</th>
          <th>Items here</th>
          <th>GPS</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${_locations.map(loc => `
          <tr>
            <td>${esc(loc.name)}</td>
            <td style="color:var(--text2);font-size:12px">${esc(loc.description || '—')}</td>
            <td style="color:var(--text2);font-size:12px">${loc.barrio_name ? esc(loc.barrio_name) : '—'}</td>
            <td>${loc.item_count}</td>
            <td style="font-size:12px;color:var(--text3)">${loc.latitude != null
              ? `<a href="https://maps.apple.com/?ll=${loc.latitude},${loc.longitude}" target="_blank" title="${loc.latitude}, ${loc.longitude}">📍</a>`
              : '—'}</td>
            <td>
              <div class="table-actions">
                <button class="action-btn" onclick="window._sl.openEdit(${loc.id})">Edit</button>
                <button class="action-btn danger" onclick="window._sl.remove(${loc.id})">Delete</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function openAdd() { showForm(null); }
function openEdit(id) { showForm(_locations.find(l => l.id === id)); }

function showForm(loc) {
  const form = document.getElementById('sl-form-area');
  if (!form) return;
  form.innerHTML = `
    <div class="form-card">
      <h2>${loc ? 'Edit location' : 'Add storage location'}</h2>
      <input type="hidden" id="sl-id" value="${loc?.id ?? ''}">
      <div class="field">
        <label>Name</label>
        <input type="text" id="sl-name" value="${esc(loc?.name ?? '')}" placeholder="e.g. Key Board, Container A" maxlength="128">
      </div>
      <div class="field">
        <label>Description (optional)</label>
        <input type="text" id="sl-desc" value="${esc(loc?.description ?? '')}" placeholder="e.g. Board near main gate" maxlength="255">
      </div>
      <div class="field">
        <label>Belongs to (optional)</label>
        <select id="sl-barrio">
          <option value="">— none —</option>
          ${_barrios.map(b => `<option value="${b.id}" ${loc?.barrio_id === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
        </select>
      </div>
      ${loc?.qr_code ? `<div class="hint" style="margin-bottom:.5rem">QR code: <code>${esc(loc.qr_code)}</code></div>` : ''}

      <div style="margin-top:.75rem">
        <label style="display:block;font-size:13px;font-weight:500;margin-bottom:.4rem;color:var(--text2)">
          GPS coordinates <span style="font-size:11px;font-weight:normal">(optional — enables map navigation to this location)</span>
        </label>
        <div style="display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap">
          <div class="field" style="margin:0;flex:1;min-width:120px">
            <label>Latitude</label>
            <input type="number" id="sl-lat" value="${loc?.latitude ?? ''}" step="any" placeholder="e.g. 40.7851">
          </div>
          <div class="field" style="margin:0;flex:1;min-width:120px">
            <label>Longitude</label>
            <input type="number" id="sl-lng" value="${loc?.longitude ?? ''}" step="any" placeholder="e.g. -119.2063">
          </div>
          <button class="btn sm" style="margin:0;flex-shrink:0" type="button" onclick="window._sl._useGps()">📍 Use my location</button>
        </div>
      </div>

      <div class="form-actions">
        <button class="btn primary sm" onclick="window._sl.save()">Save</button>
        <button class="btn sm" onclick="document.getElementById('sl-form-area').innerHTML=''">Cancel</button>
      </div>
    </div>
  `;
  document.getElementById('sl-name')?.focus();

  window._sl._useGps = () => {
    if (!navigator.geolocation) { _toast('Geolocation not available'); return; }
    navigator.geolocation.getCurrentPosition(
      pos => {
        const latEl = document.getElementById('sl-lat');
        const lngEl = document.getElementById('sl-lng');
        if (latEl) latEl.value = pos.coords.latitude.toFixed(7);
        if (lngEl) lngEl.value = pos.coords.longitude.toFixed(7);
      },
      () => _toast('Could not get location — check browser permissions')
    );
  };
}

async function save() {
  const id       = document.getElementById('sl-id')?.value;
  const name     = document.getElementById('sl-name')?.value.trim();
  const desc     = document.getElementById('sl-desc')?.value.trim();
  const latVal   = document.getElementById('sl-lat')?.value.trim();
  const lngVal   = document.getElementById('sl-lng')?.value.trim();
  const barrioId = document.getElementById('sl-barrio')?.value;

  if (!name) { _toast('Name required'); return; }

  const payload = {
    name,
    description: desc || null,
    latitude:  latVal !== '' ? parseFloat(latVal)  : null,
    longitude: lngVal !== '' ? parseFloat(lngVal)  : null,
    barrio_id: barrioId ? +barrioId : null,
  };

  try {
    if (id) {
      await put(`/admin/storage-locations/${id}`, { id: +id, ...payload });
      _toast('Location updated');
    } else {
      await post('/admin/storage-locations', payload);
      _toast('Location created');
    }
    document.getElementById('sl-form-area').innerHTML = '';
    await load();
    render();
  } catch (e) { _toast('Error: ' + e.message); }
}

async function remove(id) {
  const loc = _locations.find(l => l.id === id);
  if (loc?.item_count > 0) {
    if (!confirm(`"${loc?.name}" has ${loc.item_count} item(s) stored here. Delete anyway?`)) return;
  } else {
    if (!confirm(`Delete "${loc?.name}"?`)) return;
  }
  try {
    await del(`/admin/storage-locations/${id}`);
    _toast('Location deleted');
    await load();
    render();
  } catch (e) { _toast('Error: ' + e.message); }
}

function exportQR() {
  window.open('/api/admin/storage-locations/qr-sheet', '_blank');
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
