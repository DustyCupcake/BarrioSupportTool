/**
 * Admin users section — list, create, update, deactivate, reset password.
 */

import { get, post, put } from '../api.js?v=1.0.1';

let _toast;
let _users = [];

export async function initUsers(container, toast) {
  _toast = toast;
  renderShell(container);
  await load();
}

function renderShell(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Users</div>
        <div class="page-subtitle">Manage who can log in and their role</div>
      </div>
      <button class="btn primary sm" onclick="window._users.openAdd()">+ Add user</button>
    </div>
    <div id="user-form-area"></div>
    <div id="user-table-area"><div class="empty"><span class="spinner"></span></div></div>
  `;

  window._users = { openAdd, openPanel, save, savePwd, toggleActive, closeForm };
}

async function load() {
  try {
    const data = await get('/admin/users');
    _users = data.users || [];
    renderTable();
  } catch (e) { _toast('Error: ' + e.message); }
}

function renderTable() {
  const area = document.getElementById('user-table-area');
  if (!area) return;

  if (!_users.length) {
    area.innerHTML = '<div class="empty">No users yet</div>';
    return;
  }

  area.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Last login</th></tr></thead>
      <tbody>
        ${_users.map(u => `
          <tr class="user-row" onclick="window._users.openPanel(${u.id})">
            <td>${esc(u.display_name)}</td>
            <td style="font-family:monospace;font-size:13px;color:var(--text2)">${esc(u.username)}</td>
            <td><span class="badge ${u.role}">${u.role === 'validator' ? 'Validator' : u.role}</span></td>
            <td><span class="badge ${u.is_active ? 'active' : 'inactive'}">${u.is_active ? 'Active' : 'Inactive'}</span></td>
            <td style="font-size:12px;color:var(--text3)">${u.last_login ? fmtDate(u.last_login) : 'Never'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function openAdd() {
  showForm(null);
}

function openPanel(id) {
  const u = _users.find(x => x.id === id);
  if (!u) return;
  const form = document.getElementById('user-form-area');
  form.innerHTML = `
    <div class="form-card user-panel">
      <div class="user-panel-header">
        <span>${esc(u.display_name)}</span>
        <button class="btn-icon" onclick="window._users.closeForm()" aria-label="Close">✕</button>
      </div>

      <input type="hidden" id="u-id" value="${u.id}">

      <div class="user-panel-section">
        <div class="user-panel-title">Edit details</div>
        <div class="field">
          <label>Display name</label>
          <input type="text" id="u-name" value="${esc(u.display_name)}" placeholder="Display name">
        </div>
        <div class="form-row">
          <div class="field">
            <label>Role</label>
            <select id="u-role">
              <option value="staff" ${u.role === 'staff' ? 'selected' : ''}>Staff</option>
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
              <option value="validator" ${u.role === 'validator' ? 'selected' : ''}>Validator</option>
            </select>
          </div>
          <div class="field">
            <label>Status</label>
            <select id="u-active">
              <option value="1" ${u.is_active ? 'selected' : ''}>Active</option>
              <option value="0" ${!u.is_active ? 'selected' : ''}>Inactive</option>
            </select>
          </div>
        </div>
        <div class="form-actions">
          <button class="btn primary sm" onclick="window._users.save()">Save changes</button>
          <button class="btn sm" onclick="window._users.closeForm()">Cancel</button>
        </div>
      </div>

      <div class="user-panel-section">
        <div class="user-panel-title">Reset password</div>
        <div class="field">
          <label>New password (min 8 chars)</label>
          <input type="password" id="u-new-pass" placeholder="••••••••">
        </div>
        <div class="form-actions">
          <button class="btn sm" onclick="window._users.savePwd()">Reset password</button>
        </div>
      </div>

      <div class="user-panel-section">
        <div class="user-panel-title">Danger zone</div>
        <button class="btn danger sm" onclick="window._users.toggleActive(${u.id})">${u.is_active ? 'Deactivate user' : 'Re-activate user'}</button>
      </div>
    </div>
  `;
  document.getElementById('u-name').focus();
}

function closeForm() {
  document.getElementById('user-form-area').innerHTML = '';
}

function showForm(u) {
  const form = document.getElementById('user-form-area');
  form.innerHTML = `
    <div class="form-card">
      <h2>${u ? 'Edit user' : 'Add user'}</h2>
      <input type="hidden" id="u-id" value="${u?.id ?? ''}">
      <div class="form-row">
        <div class="field">
          <label>Display name</label>
          <input type="text" id="u-name" value="${esc(u?.display_name ?? '')}" placeholder="Rosa Luxemburg">
        </div>
        <div class="field">
          <label>Username</label>
          <input type="text" id="u-username" value="${esc(u?.username ?? '')}" placeholder="rosa" ${u ? 'disabled' : ''}>
        </div>
      </div>
      <div class="form-row">
        ${!u ? `
        <div class="field">
          <label>Password (min 8 chars)</label>
          <input type="password" id="u-pass" placeholder="••••••••">
        </div>
        ` : ''}
        <div class="field">
          <label>Role</label>
          <select id="u-role">
            <option value="staff" ${u?.role === 'staff' ? 'selected' : ''}>Staff</option>
            <option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>Admin</option>
            <option value="validator" ${u?.role === 'validator' ? 'selected' : ''}>Validator</option>
          </select>
        </div>
        ${u ? `
        <div class="field">
          <label>Status</label>
          <select id="u-active">
            <option value="1" ${u.is_active ? 'selected' : ''}>Active</option>
            <option value="0" ${!u.is_active ? 'selected' : ''}>Inactive</option>
          </select>
        </div>
        ` : ''}
      </div>
      <div class="form-actions">
        <button class="btn primary sm" onclick="window._users.save()">Save</button>
        <button class="btn sm" onclick="window._users.closeForm()">Cancel</button>
      </div>
    </div>
  `;
  document.getElementById('u-name').focus();
}

async function save() {
  const id        = document.getElementById('u-id').value;
  const name      = document.getElementById('u-name').value.trim();
  const username  = document.getElementById('u-username')?.value?.trim();
  const password  = document.getElementById('u-pass')?.value;
  const role      = document.getElementById('u-role').value;
  const is_active = document.getElementById('u-active')?.value;

  if (!name) { _toast('Display name required'); return; }

  try {
    if (id) {
      const body = { id: +id, display_name: name, role };
      if (is_active !== undefined) body.is_active = is_active === '1';
      await put('/admin/users', body);
      _toast('User updated');
    } else {
      if (!username) { _toast('Username required'); return; }
      if (!password || password.length < 8) { _toast('Password must be at least 8 characters'); return; }
      await post('/admin/users', { username, display_name: name, password, role });
      _toast('User created');
    }
    closeForm();
    await load();
  } catch (e) { _toast('Error: ' + e.message); }
}

async function savePwd() {
  const id  = document.getElementById('u-id').value;
  const pwd = document.getElementById('u-new-pass').value;
  if (!pwd || pwd.length < 8) { _toast('Password must be at least 8 characters'); return; }
  try {
    await post('/admin/users/reset-password', { id: +id, new_password: pwd });
    _toast('Password reset');
    document.getElementById('u-new-pass').value = '';
  } catch (e) { _toast('Error: ' + e.message); }
}

async function toggleActive(id) {
  const u = _users.find(x => x.id === id);
  const action = u?.is_active ? 'deactivate' : 're-activate';
  if (!confirm(`${action.charAt(0).toUpperCase() + action.slice(1)} user "${u?.display_name}"?`)) return;
  try {
    await put('/admin/users', { id, is_active: !u.is_active });
    _toast(`User ${action}d`);
    closeForm();
    await load();
  } catch (e) { _toast('Error: ' + e.message); }
}

const esc     = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmtDate = s => new Date(s).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
