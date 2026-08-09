/**
 * Admin users section — list, create, update, deactivate, reset password.
 * In dept-admin mode (manage_dept_users but not manage_users): shows
 * dept-scoped user list with permission-override toggles only.
 */

import { get, post, put } from '../api.js?v=1.0.1';

let _toast;
let _users          = [];
let _depts          = [];
let _isDeptAdmin    = false;
let _isFullAdmin    = false;
let _grantablePerms = [];
let _myDeptId       = null;
let _searchTimer    = null;

const ROLE_LABELS = {
  production_admin: 'Production Admin',
  production_staff: 'Production Staff',
  dept_admin:       'Team Admin',
  dept_staff:       'Team Staff',
  // legacy
  admin:     'Admin (legacy)',
  staff:     'Staff (legacy)',
  validator: 'Validator (legacy)',
};

export async function initUsers(container, toast, user = null) {
  _toast = toast;
  const perms = user?.permissions ?? [];
  _isDeptAdmin    = perms.includes('manage_dept_users') && !perms.includes('manage_users');
  _isFullAdmin    = perms.includes('manage_users');
  // Full admins can grant any permission they hold too (the backend imposes no
  // restriction for manage_users callers) — previously there was no UI for it
  // at all, so e.g. view_fill_status had no way to reach a non-admin user.
  _grantablePerms = _isDeptAdmin ? perms.filter(p => p !== 'manage_dept_users')
                   : _isFullAdmin ? perms
                   : [];
  _myDeptId       = _isDeptAdmin ? (user?.dept_ids?.[0] ?? null) : null;

  renderShell(container);
  await Promise.all([load(), loadDepts()]);
}

async function loadDepts() {
  if (_isDeptAdmin) return;
  try {
    const data = await get('/admin/departments');
    _depts = (data.departments || []).filter(d => d.is_active);
  } catch { _depts = []; }
}

function renderShell(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Users</div>
        <div class="page-subtitle">${_isDeptAdmin
          ? 'Manage permissions for your team members'
          : 'Manage who can log in and their role'}</div>
      </div>
      ${_isDeptAdmin ? '' : '<button class="btn primary sm" onclick="window._users.openAdd()">+ Add user</button>'}
    </div>
    ${_isDeptAdmin ? `
    <div class="form-card" style="margin-bottom:1rem">
      <div class="user-panel-title" style="margin-bottom:.5rem">Add existing user to your team</div>
      <div style="display:flex;gap:.5rem;align-items:center">
        <input type="text" id="user-search-input" placeholder="Search by name or username…"
          style="flex:1" oninput="window._users.onSearch(this.value)">
      </div>
      <div id="user-search-results"></div>
    </div>` : ''}
    <div id="user-form-area"></div>
    <div id="user-table-area"><div class="empty"><span class="spinner"></span></div></div>
  `;

  window._users = { openAdd, openPanel, save, savePwd, toggleActive, closeForm, togglePerm, onSearch, addToTeam };
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
      <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Teams</th><th>Status</th><th>Last login</th></tr></thead>
      <tbody>
        ${_users.map(u => `
          <tr class="user-row" onclick="window._users.openPanel(${u.id})">
            <td>${esc(u.display_name)}</td>
            <td style="font-family:monospace;font-size:13px;color:var(--text2)">${esc(u.username)}</td>
            <td><span class="badge ${u.role}">${ROLE_LABELS[u.role] ?? esc(u.role)}</span></td>
            <td style="font-size:12px;color:var(--text2)">${u.dept_memberships?.length ? u.dept_memberships.map(m => esc(m.dept_name)).join(', ') : '—'}</td>
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

  if (_isDeptAdmin) {
    form.innerHTML = buildPermissionsPanel(u);
    return;
  }

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
              ${roleOptions(u.role)}
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

      ${_depts.length ? `
      <div class="user-panel-section">
        <div class="user-panel-title">Team memberships</div>
        ${_depts.map(d => {
          const existing = (u.dept_memberships ?? []).find(m => m.dept_id === d.id);
          return `
            <div style="display:flex;align-items:center;justify-content:space-between;
              padding:.35rem 0;border-bottom:0.5px solid var(--border);font-size:13px">
              <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer;margin:0">
                <input type="checkbox" class="dept-check" data-dept-id="${d.id}"
                  ${existing ? 'checked' : ''}
                  style="width:15px;height:15px;accent-color:var(--accent);cursor:pointer">
                ${esc(d.name)}
              </label>
              <select data-dept-role="${d.id}"
                style="width:auto;padding:3px 8px;font-size:12px;margin:0;${!existing ? 'opacity:.4' : ''}"
                ${!existing ? 'disabled' : ''}>
                <option value="dept_staff" ${existing?.role === 'dept_staff' ? 'selected' : ''}>Team Staff</option>
                <option value="dept_admin" ${existing?.role === 'dept_admin' ? 'selected' : ''}>Team Admin</option>
              </select>
            </div>`;
        }).join('')}
      </div>` : ''}

      ${_grantablePerms.length ? `
      <div class="user-panel-section">
        <div class="user-panel-title">Permission overrides</div>
        <p style="font-size:13px;color:var(--text2);margin-bottom:.75rem">
          Grant or revoke individual permissions for this member, on top of their role defaults.
          Changes take effect on their next login.
        </p>
        ${permissionToggles(u)}
      </div>` : ''}

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

  // Enable/disable role selector when checkbox changes
  document.querySelectorAll('.dept-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const sel = document.querySelector(`[data-dept-role="${cb.dataset.deptId}"]`);
      if (sel) { sel.disabled = !cb.checked; sel.style.opacity = cb.checked ? '' : '.4'; }
    });
  });
}

function permissionToggles(u) {
  const existing = Object.fromEntries(
    (u.permission_overrides ?? []).map(o => [o.permission, o.granted])
  );

  return _grantablePerms.map(p => `
    <label class="perm-toggle" style="display:flex;align-items:center;gap:.5rem;padding:.35rem 0;cursor:pointer">
      <input type="checkbox" data-perm="${p}" data-uid="${u.id}"
        ${existing[p] === true ? 'checked' : ''}
        onchange="window._users.togglePerm(${u.id}, '${p}', this.checked)">
      <span style="font-family:monospace;font-size:13px">${p}</span>
      ${existing[p] !== undefined ? `<span style="font-size:11px;color:var(--text3)">(overridden)</span>` : ''}
    </label>
  `).join('');
}

function buildPermissionsPanel(u) {
  return `
    <div class="form-card user-panel">
      <div class="user-panel-header">
        <span>${esc(u.display_name)}</span>
        <button class="btn-icon" onclick="window._users.closeForm()" aria-label="Close">✕</button>
      </div>
      <div class="user-panel-section">
        <div class="user-panel-title">Permission overrides</div>
        <p style="font-size:13px;color:var(--text2);margin-bottom:.75rem">
          Grant or revoke permissions for this member. Changes take effect on their next login.
        </p>
        ${permissionToggles(u) || '<div style="color:var(--text3);font-size:13px">No grantable permissions</div>'}
      </div>
    </div>
  `;
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
            ${roleOptions(u?.role)}
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
      ${_depts.length ? `
      <div style="margin-top:1rem;padding-top:1rem;border-top:0.5px solid var(--border)">
        <div class="user-panel-title" style="margin-bottom:.5rem">Team memberships</div>
        <p style="font-size:13px;color:var(--text2);margin-bottom:.75rem">
          Assign to one or more teams. Applies to Team Admin and Team Staff roles.
        </p>
        ${_depts.map(d => {
          const existing = (u?.dept_memberships ?? []).find(m => m.dept_id === d.id);
          return `
            <div style="display:flex;align-items:center;justify-content:space-between;
              padding:.35rem 0;border-bottom:0.5px solid var(--border);font-size:13px">
              <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer;margin:0">
                <input type="checkbox" class="dept-check" data-dept-id="${d.id}"
                  ${existing ? 'checked' : ''}
                  style="width:15px;height:15px;accent-color:var(--accent);cursor:pointer">
                ${esc(d.name)}
              </label>
              <select data-dept-role="${d.id}"
                style="width:auto;padding:3px 8px;font-size:12px;margin:0;${!existing ? 'opacity:.4' : ''}"
                ${!existing ? 'disabled' : ''}>
                <option value="dept_staff"  ${existing?.role === 'dept_staff'  ? 'selected' : ''}>Team Staff</option>
                <option value="dept_admin"  ${existing?.role === 'dept_admin'  ? 'selected' : ''}>Team Admin</option>
              </select>
            </div>`;
        }).join('')}
      </div>` : ''}

      <div class="form-actions">
        <button class="btn primary sm" onclick="window._users.save()">Save</button>
        <button class="btn sm" onclick="window._users.closeForm()">Cancel</button>
      </div>
    </div>
  `;
  document.getElementById('u-name').focus();

  // Enable/disable role selector when checkbox changes
  document.querySelectorAll('.dept-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const sel = document.querySelector(`[data-dept-role="${cb.dataset.deptId}"]`);
      if (sel) { sel.disabled = !cb.checked; sel.style.opacity = cb.checked ? '' : '.4'; }
    });
  });
}

function roleOptions(current) {
  const roles = [
    ['production_admin', 'Production Admin'],
    ['production_staff', 'Production Staff'],
    ['dept_admin',       'Team Admin'],
    ['dept_staff',       'Team Staff'],
  ];
  return roles.map(([val, label]) =>
    `<option value="${val}" ${current === val ? 'selected' : ''}>${label}</option>`
  ).join('');
}

async function save() {
  const id        = document.getElementById('u-id').value;
  const name      = document.getElementById('u-name').value.trim();
  const username  = document.getElementById('u-username')?.value?.trim();
  const password  = document.getElementById('u-pass')?.value;
  const role      = document.getElementById('u-role').value;
  const is_active = document.getElementById('u-active')?.value;

  if (!name) { _toast('Display name required'); return; }

  // Collect dept memberships from checkboxes (production admin form only)
  const dept_memberships = [];
  document.querySelectorAll('.dept-check:checked').forEach(cb => {
    const dept_id = +cb.dataset.deptId;
    const roleEl  = document.querySelector(`[data-dept-role="${dept_id}"]`);
    dept_memberships.push({ dept_id, role: roleEl?.value || 'dept_staff' });
  });

  try {
    if (id) {
      const body = { id: +id, display_name: name, role };
      if (is_active !== undefined) body.is_active = is_active === '1';
      if (dept_memberships.length || document.querySelector('.dept-check')) body.dept_memberships = dept_memberships;
      await put('/admin/users', body);
      _toast('User updated');
    } else {
      if (!username) { _toast('Username required'); return; }
      if (!password || password.length < 8) { _toast('Password must be at least 8 characters'); return; }
      await post('/admin/users', { username, display_name: name, password, role, dept_memberships });
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

async function togglePerm(userId, perm, granted) {
  try {
    await put('/admin/users/permissions', { user_id: userId, permission: perm, granted });
    _toast(granted ? `Granted: ${perm}` : `Revoked: ${perm}`);
    await load();
    // Re-open the panel so overrides refresh
    openPanel(userId);
  } catch (e) {
    _toast('Error: ' + e.message);
    // Revert checkbox visually
    const cb = document.querySelector(`input[data-perm="${perm}"][data-uid="${userId}"]`);
    if (cb) cb.checked = !granted;
  }
}

function onSearch(q) {
  clearTimeout(_searchTimer);
  const results = document.getElementById('user-search-results');
  if (!results) return;
  if (q.trim().length < 2) { results.innerHTML = ''; return; }
  _searchTimer = setTimeout(async () => {
    try {
      const data = await get('/admin/users/search?q=' + encodeURIComponent(q.trim()));
      const users = data.users || [];
      if (!users.length) {
        results.innerHTML = '<div style="padding:.5rem 0;color:var(--text3);font-size:13px">No users found outside your team</div>';
        return;
      }
      results.innerHTML = `
        <div style="margin-top:.5rem;border-top:1px solid var(--border);padding-top:.5rem">
          ${users.map(u => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:.3rem 0">
              <span style="font-size:14px">
                ${esc(u.display_name)}
                <span style="font-size:12px;color:var(--text3);margin-left:.4rem">@${esc(u.username)}</span>
              </span>
              <button class="btn sm" onclick="window._users.addToTeam(${u.id}, '${esc(u.display_name)}')">Add to team</button>
            </div>
          `).join('')}
        </div>`;
    } catch (e) { _toast('Search error: ' + e.message); }
  }, 300);
}

async function addToTeam(userId, displayName) {
  if (!_myDeptId) { _toast('No team found'); return; }
  try {
    await put('/admin/dept-roles', { user_id: userId, dept_id: _myDeptId, role: 'dept_staff' });
    _toast(`${displayName} added to team`);
    document.getElementById('user-search-input').value = '';
    document.getElementById('user-search-results').innerHTML = '';
    await load();
  } catch (e) { _toast('Error: ' + e.message); }
}

const esc     = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmtDate = s => new Date(s).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
