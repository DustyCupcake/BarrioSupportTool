import { get, post, put, del } from '../api.js?v=1.0.1';

let _toast;
let _depts          = [];
let _expandedDeptId = null;
let _membersCache   = {};
let _searchTimer    = null;

export async function initTeams(container, toast) {
  _toast          = toast;
  _depts          = [];
  _membersCache   = {};
  _expandedDeptId = null;
  renderShell(container);
  await loadDepts();
}

function renderShell(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Teams</div>
        <div class="page-subtitle">Manage teams and their membership</div>
      </div>
      <button class="btn primary sm" onclick="window._teams.openCreateTeam()">+ Create team</button>
    </div>
    <div id="team-form-area"></div>
    <div id="teams-list"><div class="empty"><span class="spinner"></span></div></div>
    <div id="team-panel-area"></div>`;

  window._teams = {
    toggleDept, addMember, changeMemberRole, removeMember, closePanel, searchUser,
    openCreateTeam, openEditTeam, saveTeam, deleteTeam, autoSlug, closeTeamForm,
  };
}

async function loadDepts() {
  try {
    const data = await get('/admin/departments');
    _depts = data.departments || [];
    renderDeptList();
  } catch (e) { _toast('Error: ' + e.message); }
}

function renderDeptList() {
  const area = document.getElementById('teams-list');
  if (!area) return;

  if (!_depts.length) {
    area.innerHTML = '<div class="empty">No teams yet — create one above</div>';
    return;
  }

  area.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Team</th><th>Manages groups</th><th>Members</th><th></th></tr></thead>
      <tbody>
        ${_depts.map(d => `
          <tr>
            <td>${esc(d.name)}</td>
            <td style="font-size:12px;color:var(--text3)">${d.manages_groups ? 'Yes' : '—'}</td>
            <td>${d.member_count}</td>
            <td style="white-space:nowrap">
              <button class="btn sm" onclick="window._teams.toggleDept(${d.id})">
                ${_expandedDeptId === d.id ? 'Close' : 'Members'}
              </button>
              <button class="btn sm" style="margin-left:.25rem"
                onclick="window._teams.openEditTeam(${d.id})">Edit</button>
              <button class="btn sm danger" style="margin-left:.25rem"
                onclick="window._teams.deleteTeam(${d.id}, '${esc(d.name)}')">Delete</button>
              ${d.qr_code ? `<a class="btn sm" href="/api/admin/dept-qr?id=${d.id}" target="_blank"
                style="text-decoration:none;margin-left:.25rem">QR</a>` : ''}
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// ── Team CRUD ────────────────────────────────────────────────────────────────

function openCreateTeam() {
  closePanel();
  renderTeamForm(null);
}

function openEditTeam(deptId) {
  closePanel();
  const dept = _depts.find(d => d.id === deptId);
  if (!dept) return;
  renderTeamForm(dept);
}

function renderTeamForm(dept) {
  const area = document.getElementById('team-form-area');
  if (!area) return;

  area.innerHTML = `
    <div class="form-card" style="margin-bottom:1rem">
      <h2>${dept ? 'Edit team' : 'Create team'}</h2>
      <input type="hidden" id="tf-id" value="${dept?.id ?? ''}">
      <div class="form-row">
        <div class="field">
          <label>Name</label>
          <input type="text" id="tf-name" value="${esc(dept?.name ?? '')}" placeholder="Sound & Stage"
            oninput="window._teams.autoSlug(this.value)">
        </div>
        <div class="field">
          <label>Slug</label>
          <input type="text" id="tf-slug" value="${esc(dept?.slug ?? '')}" placeholder="sound_stage"
            pattern="[a-z0-9_]+" title="Lowercase letters, digits, and underscores only">
        </div>
      </div>
      <div class="form-row">
        <div class="field" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="tf-manages-groups" style="width:auto;margin:0"
            ${dept?.manages_groups ? 'checked' : ''}>
          <label for="tf-manages-groups" style="margin:0">Manages groups</label>
        </div>
        <div class="field">
          <label>Sort order</label>
          <input type="number" id="tf-sort" value="${dept?.sort_order ?? 0}" min="0" style="width:100%">
        </div>
      </div>
      <div class="form-actions">
        <button class="btn primary sm" onclick="window._teams.saveTeam()">
          ${dept ? 'Save changes' : 'Create team'}
        </button>
        <button class="btn sm" onclick="window._teams.closeTeamForm()">Cancel</button>
      </div>
    </div>`;

  document.getElementById('tf-name').focus();
}

function autoSlug(name) {
  const slugEl = document.getElementById('tf-slug');
  if (!slugEl) return;
  slugEl.value = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

async function saveTeam() {
  const id             = document.getElementById('tf-id').value;
  const name           = document.getElementById('tf-name').value.trim();
  const slug           = document.getElementById('tf-slug').value.trim();
  const manages_groups = document.getElementById('tf-manages-groups').checked;
  const sort_order     = parseInt(document.getElementById('tf-sort').value, 10) || 0;

  if (!name) { _toast('Name required'); return; }
  if (!slug)  { _toast('Slug required'); return; }
  if (!/^[a-z0-9_]+$/.test(slug)) { _toast('Slug must be lowercase letters, digits, and underscores only'); return; }

  try {
    if (id) {
      await put('/admin/departments', { id: +id, name, slug, manages_groups, sort_order });
      _toast('Team updated');
    } else {
      await post('/admin/departments', { name, slug, manages_groups, sort_order });
      _toast('Team created');
    }
    closeTeamForm();
    await loadDepts();
  } catch (e) { _toast('Error: ' + e.message); }
}

async function deleteTeam(deptId, name) {
  if (!confirm(`Delete team "${name}"? This cannot be undone.`)) return;
  try {
    await del('/admin/departments', { id: deptId });
    _toast(`"${name}" deleted`);
    if (_expandedDeptId === deptId) closePanel();
    await loadDepts();
  } catch (e) { _toast('Error: ' + e.message); }
}

function closeTeamForm() {
  const area = document.getElementById('team-form-area');
  if (area) area.innerHTML = '';
}

// ── Member management ────────────────────────────────────────────────────────

async function toggleDept(deptId) {
  if (_expandedDeptId === deptId) {
    closePanel();
    return;
  }
  _expandedDeptId = deptId;
  renderDeptList();

  const dept = _depts.find(d => d.id === deptId);
  renderPanel(dept, null);

  try {
    const data = await get('/admin/dept-members?dept_id=' + deptId);
    _membersCache[deptId] = data.members || [];
    renderPanel(dept, _membersCache[deptId]);
  } catch (e) { _toast('Error: ' + e.message); }
}

function renderPanel(dept, members) {
  const area = document.getElementById('team-panel-area');
  if (!area) return;

  area.innerHTML = `
    <div class="form-card" style="margin-top:1rem">
      <div class="user-panel-header">
        <span>${esc(dept.name)}</span>
        <button class="btn-icon" onclick="window._teams.closePanel()" aria-label="Close">✕</button>
      </div>

      <div class="user-panel-section">
        <div class="user-panel-title">Current members</div>
        <div id="team-members-list">
          ${members === null
            ? '<div class="empty"><span class="spinner"></span></div>'
            : renderMemberRows(members, dept.id)}
        </div>
      </div>

      <div class="user-panel-section">
        <div class="user-panel-title">Add member</div>
        <div style="display:flex;gap:.5rem">
          <input type="text" id="team-search-input" placeholder="Search by name or username…"
            style="flex:1" oninput="window._teams.searchUser(this.value, ${dept.id})">
        </div>
        <div id="team-search-results"></div>
      </div>
    </div>`;

  area.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderMemberRows(members, deptId) {
  if (!members.length) {
    return '<div style="color:var(--text3);font-size:13px;padding:.5rem 0">No members yet</div>';
  }
  return `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr>
        <th style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.07em;
          color:var(--text3);padding:5px 0;border-bottom:0.5px solid var(--border)">Name</th>
        <th style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.07em;
          color:var(--text3);padding:5px 0;border-bottom:0.5px solid var(--border)">Team role</th>
        <th style="border-bottom:0.5px solid var(--border)"></th>
      </tr></thead>
      <tbody>
        ${members.map(m => `
          <tr>
            <td style="padding:7px 0;border-bottom:0.5px solid var(--border)">
              ${esc(m.display_name)}
              <span style="font-size:12px;color:var(--text3);margin-left:.3rem">@${esc(m.username)}</span>
            </td>
            <td style="padding:7px 0;border-bottom:0.5px solid var(--border)">
              <select style="width:auto;padding:3px 8px;font-size:12px;margin:0"
                onchange="window._teams.changeMemberRole(${m.id}, ${deptId}, this.value)">
                <option value="dept_staff" ${m.dept_role === 'dept_staff' ? 'selected' : ''}>Team Staff</option>
                <option value="dept_admin" ${m.dept_role === 'dept_admin' ? 'selected' : ''}>Team Admin</option>
              </select>
            </td>
            <td style="padding:7px 0;border-bottom:0.5px solid var(--border);text-align:right">
              <button class="btn sm danger"
                onclick="window._teams.removeMember(${m.id}, ${deptId}, '${esc(m.display_name)}')">
                Remove
              </button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function searchUser(q, deptId) {
  clearTimeout(_searchTimer);
  const results = document.getElementById('team-search-results');
  if (!results) return;
  if (q.trim().length < 2) { results.innerHTML = ''; return; }

  _searchTimer = setTimeout(async () => {
    try {
      const data    = await get('/admin/users');
      const existing = new Set((_membersCache[deptId] || []).map(m => m.id));
      const lower   = q.trim().toLowerCase();
      const users   = (data.users || [])
        .filter(u => u.is_active && !existing.has(u.id) &&
          (u.display_name.toLowerCase().includes(lower) || u.username.toLowerCase().includes(lower)))
        .slice(0, 10);

      if (!users.length) {
        results.innerHTML = '<div style="padding:.5rem 0;color:var(--text3);font-size:13px">No users found</div>';
        return;
      }

      results.innerHTML = `
        <div style="margin-top:.5rem;border-top:0.5px solid var(--border);padding-top:.5rem">
          ${users.map(u => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:.3rem 0">
              <span style="font-size:14px">
                ${esc(u.display_name)}
                <span style="font-size:12px;color:var(--text3);margin-left:.3rem">@${esc(u.username)}</span>
              </span>
              <div style="display:flex;gap:.3rem;align-items:center">
                <select id="add-role-${u.id}" style="width:auto;padding:3px 6px;font-size:12px;margin:0">
                  <option value="dept_staff">Team Staff</option>
                  <option value="dept_admin">Team Admin</option>
                </select>
                <button class="btn sm"
                  onclick="window._teams.addMember(${u.id}, ${deptId}, '${esc(u.display_name)}')">Add</button>
              </div>
            </div>`).join('')}
        </div>`;
    } catch (e) { _toast('Search error: ' + e.message); }
  }, 300);
}

async function addMember(userId, deptId, displayName) {
  const roleEl = document.getElementById('add-role-' + userId);
  const role   = roleEl?.value || 'dept_staff';
  try {
    await put('/admin/dept-roles', { user_id: userId, dept_id: deptId, role });
    _toast(`${displayName} added as ${role === 'dept_admin' ? 'Team Admin' : 'Team Staff'}`);
    document.getElementById('team-search-input').value = '';
    document.getElementById('team-search-results').innerHTML = '';
    await refreshMembersPanel(deptId);
    await loadDepts();
  } catch (e) { _toast('Error: ' + e.message); }
}

async function changeMemberRole(userId, deptId, newRole) {
  try {
    await put('/admin/dept-roles', { user_id: userId, dept_id: deptId, role: newRole });
    _toast('Role updated');
    await refreshMembersPanel(deptId);
  } catch (e) {
    _toast('Error: ' + e.message);
    await refreshMembersPanel(deptId);
  }
}

async function removeMember(userId, deptId, displayName) {
  if (!confirm(`Remove ${displayName} from this team?`)) return;
  try {
    await put('/admin/dept-roles', { user_id: userId, dept_id: deptId, role: 'remove' });
    _toast(`${displayName} removed`);
    await refreshMembersPanel(deptId);
    await loadDepts();
  } catch (e) { _toast('Error: ' + e.message); }
}

async function refreshMembersPanel(deptId) {
  try {
    const data = await get('/admin/dept-members?dept_id=' + deptId);
    _membersCache[deptId] = data.members || [];
    const el = document.getElementById('team-members-list');
    if (el) el.innerHTML = renderMemberRows(_membersCache[deptId], deptId);
  } catch (e) { _toast('Refresh error: ' + e.message); }
}

function closePanel() {
  _expandedDeptId = null;
  renderDeptList();
  document.getElementById('team-panel-area').innerHTML = '';
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
