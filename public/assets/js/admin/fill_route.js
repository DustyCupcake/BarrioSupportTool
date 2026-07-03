/**
 * Admin: Fill Route section.
 * Ordering of water cube stops via drag-and-drop list or click-to-order map, plus credit management.
 */

import { get, put, post } from '../api.js?v=1.0.1';

let _toast;
let _onRoute  = [];   // cubes with route_position, sorted
let _offRoute = [];   // cubes with no route_position
let _dirty    = false;

let _viewMode      = 'list'; // 'list' | 'map'
let _anchorId      = null;   // id of the last-clicked cube on the map, or null
let _map           = null;
let _mapMarkers    = new Map(); // cube id → L.Marker
let _mapBoundsSet  = false;

export async function initFillRoute(container, toast) {
  _toast = toast;
  renderShell(container);
  await load();
  renderLists();
  setDirty(false);
}

// ── Shell ─────────────────────────────────────────────────────────────────────

function renderShell(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Fill Route</div>
        <div class="page-subtitle" id="fr-subtitle">Drag cubes to set the circular route order. The truck crew will see stops in this sequence.</div>
      </div>
      <div style="display:flex;gap:.5rem;align-items:center">
        <div class="fr-view-toggle" role="tablist">
          <button class="fr-view-btn active" data-view="list" onclick="window._fr.setView('list')">List</button>
          <button class="fr-view-btn" data-view="map" onclick="window._fr.setView('map')">Map</button>
        </div>
        <button class="btn primary sm" id="fr-save-btn" style="display:none" onclick="window._fr.save()">Save route</button>
        <button class="btn sm" id="fr-apply-loc-btn" onclick="window._fr.applyBarrioLocations()" title="Fill in GPS coordinates for already-checked-out cubes that don't have any yet, using their barrio's storage location">📍 Apply barrio locations</button>
        <button class="btn sm" onclick="window._fr.reload()">Refresh</button>
      </div>
    </div>

    <div id="fr-status" style="margin-bottom:1rem"></div>

    <div id="fr-list-view" style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;align-items:start">
      <div>
        <div class="section-label" style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text3);margin-bottom:.6rem">
          On route <span id="fr-on-count" style="color:var(--text2)"></span>
        </div>
        <div id="fr-on-list" class="fr-drop-zone"></div>
      </div>
      <div>
        <div class="section-label" style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text3);margin-bottom:.6rem">
          Not on route
        </div>
        <div id="fr-off-list" class="fr-drop-zone fr-off-zone">
          <div class="fr-drop-placeholder" style="display:none">Drop here to remove from route</div>
        </div>
      </div>
    </div>

    <div id="fr-map-view" style="display:none">
      <div class="fr-map-hint">
        Click a cube to select it, then click another cube to insert it right after — chain clicks to lay out the whole route.
        Click the selected cube again (or the empty map) to deselect. Only cubes with GPS coordinates appear here.
      </div>
      <div id="fr-map" class="fr-map-container"></div>
      <div id="fr-map-legend" class="fr-map-legend"></div>
    </div>

    <style>
      .fr-view-toggle {
        display: flex;
        border: 0.5px solid var(--border);
        border-radius: var(--radius);
        overflow: hidden;
      }
      .fr-view-btn {
        border: none;
        background: var(--surface);
        color: var(--text2);
        padding: .4rem .9rem;
        font-size: 12px;
        cursor: pointer;
      }
      .fr-view-btn.active { background: var(--accent); color: #fff; }
      .fr-map-hint { font-size: 12px; color: var(--text2); margin-bottom: .6rem; max-width: 60rem; }
      .fr-map-container {
        height: 520px;
        border-radius: var(--radius-lg);
        border: 0.5px solid var(--border);
        overflow: hidden;
        position: relative;
      }
      .fr-map-no-coords {
        position: absolute; inset: 0;
        display: flex; align-items: center; justify-content: center;
        text-align: center; font-size: 13px; color: var(--text2);
        background: var(--surface); z-index: 500; padding: 1rem;
      }
      .fr-map-legend { display: flex; gap: 1rem; flex-wrap: wrap; font-size: 11px; color: var(--text3); margin-top: .6rem; }
      .fr-map-legend span { display: inline-flex; align-items: center; gap: .35rem; }
      .fr-map-legend i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
      .fr-drop-zone {
        min-height: 80px;
        border: 1.5px dashed var(--border);
        border-radius: var(--radius-lg);
        padding: .5rem;
        transition: border-color .15s, background .15s;
      }
      .fr-drop-zone.drag-over {
        border-color: var(--accent);
        background: var(--accent-light);
      }
      .fr-item {
        background: var(--surface);
        border: 0.5px solid var(--border);
        border-radius: var(--radius);
        padding: .6rem .85rem;
        margin-bottom: .4rem;
        display: flex;
        align-items: center;
        gap: .75rem;
        cursor: grab;
        user-select: none;
        transition: opacity .15s, box-shadow .15s;
      }
      .fr-item:active { cursor: grabbing; }
      .fr-item.dragging { opacity: .35; box-shadow: none; }
      .fr-item.drag-target { box-shadow: 0 0 0 2px var(--accent); }
      .fr-item-num {
        flex-shrink: 0;
        width: 28px; height: 28px;
        background: var(--accent-light);
        border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 12px; font-weight: bold; color: var(--accent-text);
      }
      .fr-item-num.off { background: var(--surface); color: var(--text3); border: 0.5px solid var(--border); }
      .fr-item-info { flex: 1; min-width: 0; }
      .fr-item-label { font-size: 13px; color: var(--text); font-weight: 500; }
      .fr-item-entity { font-size: 11px; color: var(--text3); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .fr-item-handle { font-size: 16px; color: var(--text3); cursor: grab; }
      .fr-drop-placeholder {
        text-align: center; font-size: 12px; color: var(--text3);
        padding: 1rem; width: 100%;
      }
      .fr-empty-list {
        text-align: center; font-size: 12px; color: var(--text3); padding: 1.25rem .5rem;
      }
    </style>
  `;

  window._fr = {
    save:    saveRoute,
    reload:  () => { _mapBoundsSet = false; load().then(() => { renderLists(); setDirty(false); }); },
    setView,
    applyBarrioLocations,
  };
}

async function applyBarrioLocations() {
  const btn = document.getElementById('fr-apply-loc-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }

  try {
    const res = await post('/admin/fill-route/apply-barrio-locations', {});
    const parts = [`${res.applied} cube${res.applied !== 1 ? 's' : ''} updated`];
    if (res.skipped) parts.push(`${res.skipped} skipped (no unambiguous barrio location on file)`);
    _toast(parts.join(' — '));

    if (res.applied) {
      _mapBoundsSet = false;
      await load();
      renderLists();
      if (_viewMode === 'map') renderMapMarkers();
    }
  } catch (e) {
    _toast('Failed to apply locations: ' + (e.message ?? 'unknown error'));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📍 Apply barrio locations'; }
  }
}

// ── View mode ─────────────────────────────────────────────────────────────────

function setView(mode) {
  if (_viewMode === mode) return;
  _viewMode = mode;
  document.querySelectorAll('.fr-view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === mode));
  document.getElementById('fr-list-view').style.display = mode === 'list' ? '' : 'none';
  document.getElementById('fr-map-view').style.display  = mode === 'map'  ? '' : 'none';
  document.getElementById('fr-subtitle').textContent = mode === 'map'
    ? 'Click cubes on the map to set the route order. The truck crew will see stops in this sequence.'
    : 'Drag cubes to set the circular route order. The truck crew will see stops in this sequence.';
  if (mode === 'map') {
    ensureMap();
    renderMapMarkers();
  }
}

// ── Load ──────────────────────────────────────────────────────────────────────

async function load() {
  try {
    const data = await get('/admin/fill-route/cubes');
    const all  = data.cubes || [];
    _onRoute   = all.filter(c => c.route_position !== null).sort((a, b) => a.route_position - b.route_position);
    _offRoute  = all.filter(c => c.route_position === null);
  } catch (e) {
    _toast('Failed to load cubes: ' + (e.message ?? 'unknown error'));
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderLists() {
  renderOnList();
  renderOffList();
}

function renderOnList() {
  const list  = document.getElementById('fr-on-list');
  const count = document.getElementById('fr-on-count');
  if (!list) return;

  if (count) count.textContent = `(${_onRoute.length})`;

  if (_onRoute.length === 0) {
    list.innerHTML = '<div class="fr-empty-list">No cubes on route yet — drag from the right column</div>';
    attachZoneListeners(list, 'on');
    return;
  }

  list.innerHTML = _onRoute.map((c, i) => itemHtml(c, i + 1, 'on')).join('');
  attachZoneListeners(list, 'on');
  list.querySelectorAll('.fr-item').forEach(el => attachItemListeners(el));
}

function renderOffList() {
  const list = document.getElementById('fr-off-list');
  if (!list) return;

  const ph = list.querySelector('.fr-drop-placeholder');

  if (_offRoute.length === 0) {
    list.innerHTML = `
      <div class="fr-drop-placeholder" style="${_onRoute.length ? 'display:block' : 'display:none'}">
        Drop here to remove from route
      </div>
      ${_onRoute.length === 0 ? '<div class="fr-empty-list">All cubes are on the route</div>' : ''}
    `;
    attachZoneListeners(list, 'off');
    return;
  }

  list.innerHTML = `
    <div class="fr-drop-placeholder" style="display:none">Drop here to remove from route</div>
    ${_offRoute.map(c => itemHtml(c, null, 'off')).join('')}
  `;
  attachZoneListeners(list, 'off');
  list.querySelectorAll('.fr-item').forEach(el => attachItemListeners(el));
}

function itemHtml(cube, position, zone) {
  const numHtml = position !== null
    ? `<div class="fr-item-num">${position}</div>`
    : `<div class="fr-item-num off">–</div>`;
  const entity = cube.barrio_name ? escHtml(cube.barrio_name) : '<em>unassigned</em>';
  return `
    <div class="fr-item" draggable="true" data-id="${cube.id}" data-zone="${zone}">
      <span class="fr-item-handle">⠿</span>
      ${numHtml}
      <div class="fr-item-info">
        <div class="fr-item-label">${escHtml(cube.cube_label)}</div>
        <div class="fr-item-entity">${entity}</div>
      </div>
    </div>
  `;
}

// ── Drag and drop ─────────────────────────────────────────────────────────────

let _dragId   = null;
let _dragZone = null;

function attachItemListeners(el) {
  el.addEventListener('dragstart', e => {
    _dragId   = +el.dataset.id;
    _dragZone = el.dataset.zone;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    document.querySelectorAll('.fr-item.drag-target').forEach(t => t.classList.remove('drag-target'));
  });
  el.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.fr-item.drag-target').forEach(t => t.classList.remove('drag-target'));
    el.classList.add('drag-target');
  });
  el.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drag-target');
    if (_dragId === null || _dragId === +el.dataset.id) return;

    const targetId   = +el.dataset.id;
    const targetZone = el.dataset.zone;
    moveItem(_dragId, _dragZone, targetId, targetZone);
  });
}

function attachZoneListeners(zone, zoneName) {
  zone.addEventListener('dragover', e => {
    e.preventDefault();
    zone.classList.add('drag-over');
    const ph = zone.querySelector('.fr-drop-placeholder');
    if (ph) ph.style.display = 'block';
  });
  zone.addEventListener('dragleave', e => {
    if (!zone.contains(e.relatedTarget)) {
      zone.classList.remove('drag-over');
      const ph = zone.querySelector('.fr-drop-placeholder');
      if (ph && zoneName === 'off') ph.style.display = _offRoute.length ? 'none' : 'block';
    }
  });
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');

    if (_dragId === null) return;
    if (_dragZone === zoneName) return; // already in this zone — handled by item drop

    // Dropped on zone background (not on a specific item)
    if (zoneName === 'off') {
      moveToOff(_dragId);
    } else {
      moveToEnd(_dragId);
    }
  });
}

function moveItem(dragId, dragZone, targetId, targetZone) {
  // Remove from source list
  const srcList = dragZone === 'on' ? _onRoute : _offRoute;
  const idx     = srcList.findIndex(c => c.id === dragId);
  if (idx === -1) return;
  const [item]  = srcList.splice(idx, 1);

  // Insert into target list before/after the target
  const dstList  = targetZone === 'on' ? _onRoute : _offRoute;
  const targetIdx = dstList.findIndex(c => c.id === targetId);
  if (targetIdx === -1) {
    dstList.push(item);
  } else {
    dstList.splice(targetIdx, 0, item);
  }

  setDirty(true);
  renderLists();
}

function moveToOff(dragId) {
  const idx = _onRoute.findIndex(c => c.id === dragId);
  if (idx === -1) return;
  const [item] = _onRoute.splice(idx, 1);
  _offRoute.unshift(item);
  setDirty(true);
  renderLists();
}

function moveToEnd(dragId) {
  const idx = _offRoute.findIndex(c => c.id === dragId);
  if (idx === -1) return;
  const [item] = _offRoute.splice(idx, 1);
  _onRoute.push(item);
  setDirty(true);
  renderLists();
}

// ── Map view ──────────────────────────────────────────────────────────────────
//
// Click a cube marker to select it as the "anchor". Clicking a different cube
// then inserts it immediately after the anchor (removing it from wherever it
// was), and that cube becomes the new anchor — so a chain of clicks lays out
// the route in order. Clicking an off-route cube while no anchor is selected
// appends it to the end of the route. Clicking the anchor again, or the empty
// map, clears the selection.

function ensureMap() {
  if (_map) { _map.invalidateSize(); return; }
  // eslint-disable-next-line no-undef
  _map = L.map('fr-map', { zoomControl: true });
  // eslint-disable-next-line no-undef
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(_map);
  _map.on('click', () => {
    if (_anchorId !== null) {
      _anchorId = null;
      renderMapMarkers();
    }
  });
}

function _cubeIcon(onRoute, position, isAnchor) {
  const bg   = isAnchor ? '#d97706' : onRoute ? '#1d6ef5' : '#9ca3af';
  const size = isAnchor ? 30 : onRoute ? 26 : 18;
  const label = onRoute ? String(position) : '';
  // eslint-disable-next-line no-undef
  return L.divIcon({
    html: `<div style="
      width:${size}px;height:${size}px;background:${bg};
      border:2px solid #fff;border-radius:50%;cursor:pointer;
      box-shadow:0 2px 6px rgba(0,0,0,.4);
      display:flex;align-items:center;justify-content:center;
      font-size:${onRoute ? 11 : 9}px;color:#fff;font-weight:bold;
      font-family:-apple-system,sans-serif;
    ">${label}</div>`,
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2 + 4)],
  });
}

function renderMapMarkers() {
  if (!_map) return;

  _mapMarkers.forEach(m => m.remove());
  _mapMarkers.clear();

  const all        = [..._onRoute, ..._offRoute];
  const withCoords = all.filter(c => c.latitude != null && c.longitude != null);

  document.getElementById('fr-map-no-coords')?.remove();

  if (!withCoords.length) {
    const msg = document.createElement('div');
    msg.id = 'fr-map-no-coords';
    msg.className = 'fr-map-no-coords';
    msg.innerHTML = 'No cubes have GPS coordinates yet.<br><span style="font-size:12px;opacity:.7">Set coordinates in Admin → Equipment → Items, then come back to Map view.</span>';
    document.getElementById('fr-map').appendChild(msg);
    renderMapLegend(0, all.length);
    return;
  }

  const bounds = [];
  withCoords.forEach(c => {
    const onIdx    = _onRoute.findIndex(o => o.id === c.id);
    const position = onIdx === -1 ? null : onIdx + 1;
    const isAnchor = c.id === _anchorId;
    const latlng   = [c.latitude, c.longitude];
    bounds.push(latlng);

    // eslint-disable-next-line no-undef
    const marker = L.marker(latlng, { icon: _cubeIcon(position !== null, position, isAnchor) })
      .addTo(_map)
      .bindTooltip(
        `<b>${escHtml(c.cube_label)}</b><br>${escHtml(c.barrio_name || 'unassigned')}<br>` +
        (position !== null ? `Stop #${position}` : 'Not on route'),
        { direction: 'top', offset: [0, -(isAnchor ? 17 : 15)] }
      );
    marker.on('click', e => {
      // eslint-disable-next-line no-undef
      L.DomEvent.stopPropagation(e);
      handleMapClick(c.id);
    });

    _mapMarkers.set(c.id, marker);
  });

  if (!_mapBoundsSet && bounds.length) {
    if (bounds.length === 1) _map.setView(bounds[0], 16);
    else _map.fitBounds(bounds, { padding: [48, 48] });
    _mapBoundsSet = true;
  }

  renderMapLegend(withCoords.length, all.length - withCoords.length);
}

function renderMapLegend(shown, hidden) {
  const el = document.getElementById('fr-map-legend');
  if (!el) return;
  el.innerHTML = `
    <span><i style="background:#1d6ef5"></i> On route</span>
    <span><i style="background:#9ca3af"></i> Not on route</span>
    <span><i style="background:#d97706"></i> Selected</span>
    ${hidden ? `<span>${hidden} cube${hidden !== 1 ? 's' : ''} hidden — no GPS coordinates</span>` : ''}
  `;
}

function handleMapClick(id) {
  if (_anchorId === null) {
    if (!_onRoute.find(c => c.id === id)) {
      moveToEnd(id);
    }
    _anchorId = id;
  } else if (_anchorId === id) {
    _anchorId = null;
  } else {
    insertAfterId(id, _anchorId);
    setDirty(true);
    renderLists();
    _anchorId = id;
  }
  renderMapMarkers();
}

// Removes the cube `id` from wherever it currently sits and reinserts it
// immediately after cube `afterId` in the route.
function insertAfterId(id, afterId) {
  let item = null;
  let idx  = _onRoute.findIndex(c => c.id === id);
  if (idx !== -1) {
    [item] = _onRoute.splice(idx, 1);
  } else {
    idx = _offRoute.findIndex(c => c.id === id);
    if (idx !== -1) [item] = _offRoute.splice(idx, 1);
  }
  if (!item) return;

  const afterIdx = _onRoute.findIndex(c => c.id === afterId);
  if (afterIdx === -1) {
    _onRoute.push(item);
  } else {
    _onRoute.splice(afterIdx + 1, 0, item);
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────

async function saveRoute() {
  const btn = document.getElementById('fr-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    await put('/admin/fill-route/order', {
      ordered_ids: _onRoute.map(c => c.id),
      unset_ids:   _offRoute.map(c => c.id),
    });
    _toast(`Route saved — ${_onRoute.length} stop${_onRoute.length !== 1 ? 's' : ''}`);
    // Refresh to confirm saved positions
    await load();
    renderLists();
    setDirty(false);
    if (_viewMode === 'map') renderMapMarkers();
  } catch (e) {
    _toast('Failed to save: ' + (e.message ?? 'unknown error'));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save route'; }
  }
}

function setDirty(dirty) {
  _dirty = dirty;
  const btn = document.getElementById('fr-save-btn');
  if (btn) btn.style.display = dirty ? '' : 'none';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
