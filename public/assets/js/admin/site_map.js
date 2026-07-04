/**
 * Admin: Site Map section.
 * Upload a per-event KMZ/KML site plan (structures, containers, barrio
 * footprints). Stored as a singleton — a new upload replaces the previous
 * one. Rendered as a reference layer on the Fill Route maps.
 */

import { get, del, getCsrf }  from '../api.js?v=1.0.1';
import { renderSiteOverlay }  from '../map-overlay.js?v=1.0.0';

let _toast;
let _status = null; // { present, name, feature_count, created_at, uploaded_by_name }
let _previewMap = null;

export async function initSiteMap(container, toast) {
  _toast = toast;
  _previewMap = null;
  renderShell(container);
  await load();
  render();
}

function renderShell(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Site Map</div>
        <div class="page-subtitle">
          Upload a KMZ/KML site plan (e.g. from Google My Maps) each event edition. It's shown as a
          reference layer under the pins on the admin Fill Route map and the crew water fill route map.
        </div>
      </div>
    </div>
    <div id="sm-status-area"></div>
    <div id="sm-preview-area"></div>
  `;

  window._sm = { upload, remove };
}

async function load() {
  try {
    _status = await get('/admin/map-overlay');
  } catch (e) {
    _toast('Failed to load site map status: ' + e.message);
    _status = { present: false };
  }
}

function render() {
  renderStatus();
  renderPreview();
}

function renderStatus() {
  const area = document.getElementById('sm-status-area');
  if (!area) return;

  const summary = _status?.present
    ? `
      <div class="hint" style="margin-bottom:.75rem">
        Current: <b>${esc(_status.name)}</b> — ${_status.feature_count} shape${_status.feature_count !== 1 ? 's' : ''}
        · uploaded ${formatDate(_status.created_at)}${_status.uploaded_by_name ? ' by ' + esc(_status.uploaded_by_name) : ''}
      </div>
    `
    : `<div class="hint" style="margin-bottom:.75rem">No site map uploaded yet.</div>`;

  area.innerHTML = `
    <div class="form-card">
      ${summary}
      <div class="field">
        <label>${_status?.present ? 'Replace with a new file' : 'Upload a .kmz or .kml file'}</label>
        <input type="file" id="sm-file" accept=".kmz,.kml">
      </div>
      <div class="form-actions">
        <button class="btn primary sm" id="sm-upload-btn" onclick="window._sm.upload()">Upload</button>
        ${_status?.present ? `<button class="btn sm danger" onclick="window._sm.remove()">Remove</button>` : ''}
      </div>
    </div>
  `;
}

function renderPreview() {
  const area = document.getElementById('sm-preview-area');
  if (!area) return;

  if (!_status?.present) {
    area.innerHTML = '';
    _previewMap = null;
    return;
  }

  area.innerHTML = `
    <div id="sm-preview-map" style="
      height:420px;margin-top:1rem;border-radius:var(--radius-lg);
      border:0.5px solid var(--border);overflow:hidden;position:relative;
    "></div>
  `;

  // eslint-disable-next-line no-undef
  _previewMap = L.map('sm-preview-map', { zoomControl: true, attributionControl: false });
  // Base tile layer disabled — OSM was returning 403s (referrer required) in this
  // deployment. The site map KML overlay stands in as the visual reference for now.

  renderSiteOverlay(_previewMap).then(layer => {
    if (layer && _previewMap) {
      const bounds = layer.getBounds();
      if (bounds.isValid()) _previewMap.fitBounds(bounds, { padding: [24, 24] });
    }
  });
}

async function upload() {
  const fileInput = document.getElementById('sm-file');
  const file = fileInput?.files?.[0];
  if (!file) { _toast('Select a .kmz or .kml file first'); return; }

  const btn = document.getElementById('sm-upload-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Uploading…'; }

  try {
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch('/api/admin/map-overlay', {
      method:      'POST',
      credentials: 'include',
      headers:     { 'X-CSRF-Token': getCsrf() },
      body:        formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');

    _toast(`Site map uploaded — ${data.feature_count} shape${data.feature_count !== 1 ? 's' : ''}`);
    await load();
    render();
  } catch (e) {
    _toast('Error: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Upload'; }
  }
}

async function remove() {
  if (!confirm('Remove the current site map overlay?')) return;
  try {
    await del('/admin/map-overlay');
    _toast('Site map removed');
    await load();
    render();
  } catch (e) { _toast('Error: ' + e.message); }
}

function formatDate(iso) {
  if (!iso) return '';
  try { return new Date(iso.replace(' ', 'T')).toLocaleString(); } catch { return iso; }
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
