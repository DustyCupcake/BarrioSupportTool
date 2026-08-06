/**
 * Admin: Fill Requests section.
 * Status board of every group's currently pending/partial water fill requests.
 */

import { get, del } from '../api.js?v=1.0.1';

let _toast;
let _requests = [];

export async function initFillRequests(container, toast) {
  _toast = toast;
  renderShell(container);
  await load();
  renderTable();
}

function renderShell(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Fill Requests</div>
        <div class="page-subtitle">Every group's currently pending or partially-filled water fill request, across the whole event.</div>
      </div>
      <button class="btn sm" onclick="window._frq.reload()">Refresh</button>
    </div>
    <div id="frq-table-area"><div class="empty"><span class="spinner"></span></div></div>
  `;

  window._frq = { reload: () => load().then(renderTable), cancel };
}

async function load() {
  try {
    const data = await get('/admin/fill-requests');
    _requests = data.requests || [];
  } catch (e) {
    _toast('Failed to load fill requests: ' + e.message);
  }
}

function renderTable() {
  const area = document.getElementById('frq-table-area');
  if (!area) return;

  if (!_requests.length) {
    area.innerHTML = '<div class="empty">No pending fill requests right now.</div>';
    return;
  }

  area.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Group</th>
          <th>Type</th>
          <th>Fills</th>
          <th>Status</th>
          <th>Requested</th>
          <th>By</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${_requests.map(r => `
          <tr>
            <td>${esc(r.barrio_name)}</td>
            <td>${r.cube_item_id !== null ? esc(r.cube_label ?? 'Specific cube') : '<em>Any cube</em>'}</td>
            <td>${r.fills_completed}/${r.fills_requested}</td>
            <td>${statusBadge(r.status)}</td>
            <td style="font-size:12px;color:var(--text3)">${formatDate(r.requested_at)}</td>
            <td style="font-size:12px;color:var(--text3)">${esc(r.requested_by_name || '—')}</td>
            <td>
              <div class="table-actions">
                <button class="action-btn danger" onclick="window._frq.cancel(${r.id})">Cancel</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function statusBadge(status) {
  if (status === 'partial') return `<span class="badge" style="font-size:11px;background:var(--accent-light);color:var(--accent-text)">Partial</span>`;
  return `<span style="color:var(--text3);font-size:12px">Pending</span>`;
}

async function cancel(id) {
  const req = _requests.find(r => r.id === id);
  if (!confirm(`Cancel the fill request for "${req?.barrio_name}"?`)) return;
  try {
    await del('/fill-requests/' + id);
    _toast('Fill request cancelled');
    await load();
    renderTable();
  } catch (e) {
    _toast('Error: ' + e.message);
  }
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
