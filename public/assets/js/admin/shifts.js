/**
 * Admin Shifts section.
 * Create/edit shifts (name, dept/group scope, permission set, time window),
 * generate QR login tokens, print the token QR sheet.
 */

import { get, post, put, del } from '../api.js?v=1.0.1';

const PERMISSION_OPTIONS = [
  'checkout_equipment', 'checkin_equipment',
  'sub_checkout', 'sub_checkin',
  'validate_vouchers',
  'view_inventory', 'view_dept_inventory', 'view_groups',
  'manage_equipment', 'manage_consumables',
  'create_invites', 'submit_orders', 'label_equipment',
  'request_fills', 'fill_truck', 'update_item_location',
  'person_borrow',
];

let _toast    = null;
let _shifts   = [];
let _depts    = [];
let _groups   = [];
let _ownPerms = new Set();
let _expandedShiftId = null;
let _tokensCache     = {};

export async function initShifts(container, toast, user) {
  _toast = toast;
  _shifts = [];
  _ownPerms = new Set(user?.permissions || []);
  _expandedShiftId = null;
  _tokensCache = {};
  renderShell(container);
  await Promise.all([loadShifts(), loadDepts(), loadGroups()]);
}

async function loadShifts() {
  try {
    const data = await get('/admin/shifts');
    _shifts = data.shifts || [];
    renderList();
  } catch (e) { _toast('Error: ' + e.message); }
}

async function loadDepts() {
  try {
    const data = await get('/admin/departments');
    _depts = data.departments || [];
  } catch (e) { _toast('Error: ' + e.message); }
}

async function loadGroups() {
  try {
    const data = await get('/admin/groups');
    _groups = data.groups || [];
  } catch (e) { _toast('Error: ' + e.message); }
}

function renderShell(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Shifts</div>
        <div class="page-subtitle">Time-boxed volunteer sessions with QR login and a fixed permission set</div>
      </div>
      <button class="btn primary sm" onclick="window._shifts.openCreate()">+ Create shift</button>
    </div>
    <div id="shift-form-area"></div>
    <div id="shifts-list"><div class="empty"><span class="spinner"></span></div></div>
    <div id="shift-panel-area"></div>`;

  window._shifts = {
    openCreate, openEdit, saveShift, deleteShift, closeForm,
    toggleTokens, generateTokens, printSheet, closePanel,
  };
}

function renderList() {
  const area = document.getElementById('shifts-list');
  if (!area) return;

  if (!_shifts.length) {
    area.innerHTML = '<div class="empty">No shifts yet — create one above</div>';
    return;
  }

  area.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th>Name</th><th>Scope</th><th>Active window</th><th>Tokens</th><th></th>
      </tr></thead>
      <tbody>
        ${_shifts.map(s => `
          <tr>
            <td>${esc(s.name)}</td>
            <td style="font-size:12px;color:var(--text3)">${esc(s.dept_name || s.group_name || '—')}</td>
            <td style="font-size:12px;color:var(--text3)">${fmtWindow(s.active_from, s.active_until)}</td>
            <td>${s.tokens_used}/${s.token_count}</td>
            <td style="white-space:nowrap">
              <button class="btn sm" onclick="window._shifts.toggleTokens(${s.id})">
                ${_expandedShiftId === s.id ? 'Close' : 'Tokens'}
              </button>
              <button class="btn sm" style="margin-left:.25rem"
                onclick="window._shifts.openEdit(${s.id})">Edit</button>
              <button class="btn sm danger" style="margin-left:.25rem"
                onclick="window._shifts.deleteShift(${s.id}, '${esc(s.name)}')">Delete</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// ── Shift CRUD ────────────────────────────────────────────────────────────────

function openCreate() {
  closePanel();
  renderForm(null);
}

function openEdit(id) {
  closePanel();
  const shift = _shifts.find(s => s.id === id);
  if (!shift) return;
  renderForm(shift);
}

function renderForm(shift) {
  const area = document.getElementById('shift-form-area');
  if (!area) return;

  const deptOptions = _depts.map(d =>
    `<option value="${d.id}" ${shift?.dept_id === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
  const groupOptions = _groups.map(g =>
    `<option value="${g.id}" ${shift?.group_id === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('');

  const selectedPerms = new Set(shift?.permissions || []);
  const editablePerms = PERMISSION_OPTIONS.filter(p => _ownPerms.has(p));
  // Permissions already on the shift that this admin can't grant themselves (e.g. set by a
  // higher-privileged admin) — kept out of the checkbox list but preserved on save.
  const lockedPerms = (shift?.permissions || []).filter(p => !_ownPerms.has(p));

  area.innerHTML = `
    <div class="form-card" style="margin-bottom:1rem">
      <h2>${shift ? 'Edit shift' : 'Create shift'}</h2>
      <input type="hidden" id="sf-id" value="${shift?.id ?? ''}">
      <div class="form-row">
        <div class="field">
          <label>Name</label>
          <input type="text" id="sf-name" value="${esc(shift?.name ?? '')}" placeholder="Saturday night gate">
        </div>
        <div class="field">
          <label>Department scope <span style="color:var(--text3);font-weight:400">(optional)</span></label>
          <select id="sf-dept">
            <option value="">None</option>
            ${deptOptions}
          </select>
        </div>
        <div class="field">
          <label>Group scope <span style="color:var(--text3);font-weight:400">(optional)</span></label>
          <select id="sf-group">
            <option value="">None</option>
            ${groupOptions}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="field">
          <label>Active from</label>
          <input type="datetime-local" id="sf-from" value="${toLocalInput(shift?.active_from) || nowLocalInput()}">
        </div>
        <div class="field">
          <label>Active until</label>
          <input type="datetime-local" id="sf-until" value="${toLocalInput(shift?.active_until) || nowLocalInput()}">
        </div>
      </div>
      <div class="field">
        <label>Permissions <span style="color:var(--text3);font-weight:400">(only permissions you hold can be granted)</span></label>
        <input type="hidden" id="sf-locked-perms" value="${esc(lockedPerms.join(','))}">
        <div style="display:flex;flex-wrap:wrap;gap:.4rem .9rem;margin-top:.3rem">
          ${editablePerms.map(p => `
            <label style="display:flex;align-items:center;gap:.3rem;font-size:13px;font-weight:400">
              <input type="checkbox" class="sf-perm" value="${p}" ${selectedPerms.has(p) ? 'checked' : ''}>
              ${p}
            </label>`).join('')}
        </div>
        ${lockedPerms.length ? `
          <div style="font-size:12px;color:var(--text3);margin-top:.5rem">
            Also granted by a higher-privileged admin (unchanged by you): ${lockedPerms.map(esc).join(', ')}
          </div>` : ''}
      </div>
      <div class="form-actions">
        <button class="btn primary sm" onclick="window._shifts.saveShift()">
          ${shift ? 'Save changes' : 'Create shift'}
        </button>
        <button class="btn sm" onclick="window._shifts.closeForm()">Cancel</button>
      </div>
    </div>`;

  document.getElementById('sf-name').focus();
}

async function saveShift() {
  const id       = document.getElementById('sf-id').value;
  const name     = document.getElementById('sf-name').value.trim();
  const deptId   = document.getElementById('sf-dept').value;
  const groupId  = document.getElementById('sf-group').value;
  const from     = document.getElementById('sf-from').value;
  const until    = document.getElementById('sf-until').value;
  const lockedPerms = (document.getElementById('sf-locked-perms').value || '').split(',').filter(Boolean);
  const perms = [
    ...new Set([
      ...Array.from(document.querySelectorAll('.sf-perm:checked')).map(el => el.value),
      ...lockedPerms,
    ]),
  ];

  if (!name)  { _toast('Name required'); return; }
  if (!from || !until) { _toast('Active window required'); return; }
  if (!perms.length) { _toast('Select at least one permission'); return; }

  const payload = {
    name,
    dept_id: deptId ? +deptId : null,
    group_id: groupId ? +groupId : null,
    permissions: perms,
    active_from: from.replace('T', ' '),
    active_until: until.replace('T', ' '),
  };

  try {
    if (id) {
      await put('/admin/shifts', { id: +id, ...payload });
      _toast('Shift updated');
    } else {
      await post('/admin/shifts', payload);
      _toast('Shift created');
    }
    closeForm();
    await loadShifts();
  } catch (e) { _toast('Error: ' + e.message); }
}

async function deleteShift(id, name) {
  if (!confirm(`Delete shift "${name}"? This cannot be undone.`)) return;
  try {
    await del('/admin/shifts', { id });
    _toast(`"${name}" deleted`);
    if (_expandedShiftId === id) closePanel();
    await loadShifts();
  } catch (e) { _toast('Error: ' + e.message); }
}

function closeForm() {
  const area = document.getElementById('shift-form-area');
  if (area) area.innerHTML = '';
}

// ── Token management ─────────────────────────────────────────────────────────

async function toggleTokens(shiftId) {
  if (_expandedShiftId === shiftId) {
    closePanel();
    return;
  }
  _expandedShiftId = shiftId;
  renderList();

  const shift = _shifts.find(s => s.id === shiftId);
  renderPanel(shift, null);

  try {
    const data = await get('/admin/shifts/tokens?shift_id=' + shiftId);
    _tokensCache[shiftId] = data.tokens || [];
    renderPanel(shift, _tokensCache[shiftId]);
  } catch (e) { _toast('Error: ' + e.message); }
}

function renderPanel(shift, tokens) {
  const area = document.getElementById('shift-panel-area');
  if (!area) return;

  area.innerHTML = `
    <div class="form-card" style="margin-top:1rem">
      <div class="user-panel-header">
        <span>${esc(shift.name)} — tokens</span>
        <button class="btn-icon" onclick="window._shifts.closePanel()" aria-label="Close">✕</button>
      </div>

      <div class="user-panel-section">
        <div id="shift-tokens-list">
          ${tokens === null
            ? '<div class="empty"><span class="spinner"></span></div>'
            : renderTokenRows(tokens)}
        </div>
      </div>

      <div class="user-panel-section">
        <div class="user-panel-title">Generate tokens</div>
        <div style="display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap">
          <div class="field" style="margin-bottom:0">
            <label>Count</label>
            <input type="number" id="st-gen-count" value="10" min="1" max="200" style="width:80px">
          </div>
          <div class="field" style="margin-bottom:0;flex:1;min-width:140px">
            <label>Label prefix <span style="color:var(--text3);font-weight:400">(optional)</span></label>
            <input type="text" id="st-gen-prefix" placeholder="e.g. Gate">
          </div>
          <button class="btn primary sm" onclick="window._shifts.generateTokens(${shift.id})">Generate</button>
          <button class="btn sm" onclick="window._shifts.printSheet(${shift.id})">🖨 Print QR sheet</button>
        </div>
      </div>
    </div>`;

  area.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderTokenRows(tokens) {
  if (!tokens.length) {
    return '<div style="color:var(--text3);font-size:13px;padding:.5rem 0">No tokens yet — generate some below</div>';
  }
  const used = tokens.filter(t => t.used_at).length;
  return `
    <div style="font-size:13px;color:var(--text3);margin-bottom:.5rem">
      ${tokens.length} total · ${used} used · ${tokens.length - used} unused
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr>
        <th style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.07em;
          color:var(--text3);padding:5px 0;border-bottom:0.5px solid var(--border)">Label</th>
        <th style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.07em;
          color:var(--text3);padding:5px 0;border-bottom:0.5px solid var(--border)">Status</th>
      </tr></thead>
      <tbody>
        ${tokens.map(t => `
          <tr>
            <td style="padding:7px 0;border-bottom:0.5px solid var(--border)">${esc(t.label || ('Slot ' + t.id))}</td>
            <td style="padding:7px 0;border-bottom:0.5px solid var(--border)">
              ${t.used_at
                ? '<span class="badge claimed">Used</span>'
                : '<span class="badge unclaimed">Unused</span>'}
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

async function generateTokens(shiftId) {
  const count  = parseInt(document.getElementById('st-gen-count')?.value, 10) || 0;
  const prefix = document.getElementById('st-gen-prefix')?.value.trim();

  if (count < 1 || count > 200) { _toast('Count must be between 1 and 200'); return; }

  try {
    await post('/admin/shifts/tokens', { shift_id: shiftId, count, label_prefix: prefix || null });
    _toast(`Generated ${count} token${count !== 1 ? 's' : ''}`);
    const data = await get('/admin/shifts/tokens?shift_id=' + shiftId);
    _tokensCache[shiftId] = data.tokens || [];
    const shift = _shifts.find(s => s.id === shiftId);
    renderPanel(shift, _tokensCache[shiftId]);
    await loadShifts();
  } catch (e) { _toast('Error: ' + e.message); }
}

function printSheet(shiftId) {
  window.open('/api/admin/shifts/qr-sheet?shift_id=' + shiftId, '_blank');
}

function closePanel() {
  _expandedShiftId = null;
  renderList();
  const area = document.getElementById('shift-panel-area');
  if (area) area.innerHTML = '';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toLocalInput(iso) {
  if (!iso) return '';
  return iso.slice(0, 16).replace(' ', 'T');
}

function nowLocalInput() {
  const d      = new Date();
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 16);
}

function fmtWindow(from, until) {
  if (!from || !until) return '—';
  const f = new Date(from.replace(' ', 'T'));
  const u = new Date(until.replace(' ', 'T'));
  const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  return `${f.toLocaleString(undefined, opts)} – ${u.toLocaleString(undefined, opts)}`;
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
