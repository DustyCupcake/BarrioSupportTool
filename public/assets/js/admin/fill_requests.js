/**
 * Admin: Fill Requests / status board.
 * Read-only visibility (requests history, flagged fills, truck direction/run
 * status, pending sanitation) for anyone with view_fill_status — plus the
 * existing cancel action for anyone who also holds request_fills. All of the
 * status-board data is built from reads over what the system already
 * persists; nothing here introduces new tracked state.
 */

import { get, del } from '../api.js?v=1.0.1';

let _toast;
let _canCancel   = false;
let _requests    = [];
let _statusFilter = 'active';

export async function initFillRequests(container, toast, user) {
  _toast     = toast;
  _canCancel = !!user?.permissions?.includes('request_fills');
  renderShell(container);
  await loadAll();
}

function renderShell(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Fill Requests</div>
        <div class="page-subtitle">Water fill request history, flagged fills, truck run status, and pending sanitation across the whole event.</div>
      </div>
      <button class="btn sm" onclick="window._frq.reload()">Refresh</button>
    </div>

    <div class="frq-tabs" style="display:flex;gap:.4rem;margin-bottom:1rem">
      ${tabButton('active', 'Active')}
      ${tabButton('filled', 'Filled')}
      ${tabButton('cancelled', 'Cancelled')}
      ${tabButton('all', 'All')}
    </div>
    <div id="frq-table-area"><div class="empty"><span class="spinner"></span></div></div>

    <div class="page-header" style="margin-top:2rem">
      <div>
        <div class="page-title" style="font-size:16px">Flagged fills</div>
        <div class="page-subtitle">Sanitation checks the truck crew flagged as a problem.</div>
      </div>
    </div>
    <div id="frq-flags-area"><div class="empty"><span class="spinner"></span></div></div>

    <div class="page-header" style="margin-top:2rem">
      <div>
        <div class="page-title" style="font-size:16px">Pending sanitation</div>
        <div class="page-subtitle">Cubes the truck has delivered water to, but sanitation hasn't been confirmed (or flagged) yet.</div>
      </div>
    </div>
    <div id="frq-sanitation-area"><div class="empty"><span class="spinner"></span></div></div>

    <div class="page-header" style="margin-top:2rem">
      <div>
        <div class="page-title" style="font-size:16px">Truck run status</div>
        <div class="page-subtitle">Which route directions are currently claimed.</div>
      </div>
    </div>
    <div id="frq-directions-area"><div class="empty"><span class="spinner"></span></div></div>
  `;

  container.querySelectorAll('.frq-tab').forEach(btn => {
    btn.onclick = () => {
      _statusFilter = btn.dataset.status;
      container.querySelectorAll('.frq-tab').forEach(b => b.classList.toggle('active', b === btn));
      loadRequests();
    };
  });

  window._frq = { reload: loadAll, cancel };
}

function tabButton(status, label) {
  const active = status === _statusFilter;
  return `<button class="frq-tab btn sm ${active ? 'active' : 'secondary'}" data-status="${status}"
    style="${active ? '' : 'background:var(--surface);color:var(--text2)'}">${label}</button>`;
}

async function loadAll() {
  await Promise.all([loadRequests(), loadFlags(), loadPendingSanitation(), loadDirections()]);
}

// ── Requests ─────────────────────────────────────────────────────────────────

async function loadRequests() {
  try {
    const data = await get('/admin/fill-requests', { status: _statusFilter });
    _requests = data.requests || [];
  } catch (e) {
    _toast('Failed to load fill requests: ' + e.message);
    _requests = [];
  }
  renderTable();
}

function renderTable() {
  const area = document.getElementById('frq-table-area');
  if (!area) return;

  if (!_requests.length) {
    area.innerHTML = '<div class="empty">No fill requests in this view.</div>';
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
            <td>${r.cube_item_id !== null ? esc(r.cube_label ?? 'Specific cube') : '<em>Any cube</em>'}
              ${r.via_physical_voucher ? '<span class="badge" style="font-size:10px;margin-left:.35rem;background:var(--surface2);color:var(--text2)" title="Requested via a redeemed physical voucher">Voucher</span>' : ''}</td>
            <td>${r.fills_completed}/${r.fills_requested}</td>
            <td>${statusBadge(r.status)}</td>
            <td style="font-size:12px;color:var(--text3)">${formatDate(r.requested_at)}</td>
            <td style="font-size:12px;color:var(--text3)">${esc(r.requested_by_name || '—')}</td>
            <td>
              ${_canCancel && (r.status === 'pending' || r.status === 'partial') ? `
              <div class="table-actions">
                <button class="action-btn danger" onclick="window._frq.cancel(${r.id})">Cancel</button>
              </div>` : ''}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function statusBadge(status) {
  if (status === 'partial')   return `<span class="badge" style="font-size:11px;background:var(--accent-light);color:var(--accent-text)">Partial</span>`;
  if (status === 'filled')    return `<span class="badge" style="font-size:11px;background:var(--surface2);color:var(--text2)">Filled</span>`;
  if (status === 'cancelled') return `<span class="badge" style="font-size:11px;background:var(--surface2);color:var(--text3)">Cancelled</span>`;
  return `<span style="color:var(--text3);font-size:12px">Pending</span>`;
}

async function cancel(id) {
  const req = _requests.find(r => r.id === id);
  if (!confirm(`Cancel the fill request for "${req?.barrio_name}"?`)) return;
  try {
    await del('/fill-requests/' + id);
    _toast('Fill request cancelled');
    await loadRequests();
  } catch (e) {
    _toast('Error: ' + e.message);
  }
}

// ── Flagged fills ───────────────────────────────────────────────────────────

async function loadFlags() {
  const area = document.getElementById('frq-flags-area');
  try {
    const data  = await get('/admin/fill-flags');
    const flags = data.flags || [];
    if (!area) return;
    if (!flags.length) {
      area.innerHTML = '<div class="empty">No flagged fills.</div>';
      return;
    }
    area.innerHTML = `
      <table class="data-table">
        <thead><tr><th>Group</th><th>Cube</th><th>Flagged</th><th>By</th><th>Notes</th></tr></thead>
        <tbody>
          ${flags.map(f => `
            <tr>
              <td>${f.group_name ? esc(f.group_name) : '<em>—</em>'}</td>
              <td>${esc(f.cube_label)}</td>
              <td style="font-size:12px;color:var(--text3)">${formatDate(f.occurred_at)}</td>
              <td style="font-size:12px;color:var(--text3)">${esc(f.flagged_by_name || '—')}</td>
              <td style="font-size:12px;color:var(--warn)">${esc(f.notes || '—')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    if (area) area.innerHTML = '<div class="empty">Failed to load flagged fills.</div>';
  }
}

// ── Pending sanitation ──────────────────────────────────────────────────────

async function loadPendingSanitation() {
  const area = document.getElementById('frq-sanitation-area');
  try {
    const data  = await get('/admin/fill-pending-sanitation');
    const items = data.pending_sanitation || [];
    if (!area) return;
    if (!items.length) {
      area.innerHTML = '<div class="empty">Nothing awaiting sanitation.</div>';
      return;
    }
    area.innerHTML = `
      <table class="data-table">
        <thead><tr><th>Group</th><th>Cube</th><th>Delivered</th></tr></thead>
        <tbody>
          ${items.map(p => `
            <tr>
              <td>${p.group_name ? esc(p.group_name) : '<em>—</em>'}</td>
              <td>${esc(p.cube_label)}</td>
              <td style="font-size:12px;color:var(--text3)">${formatDate(p.delivered_at)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    if (area) area.innerHTML = '<div class="empty">Failed to load pending sanitation.</div>';
  }
}

// ── Truck direction/run status ──────────────────────────────────────────────

async function loadDirections() {
  const area = document.getElementById('frq-directions-area');
  try {
    const data   = await get('/fill/direction-status');
    const claims = data.claims || [];
    if (!area) return;
    if (!claims.length) {
      area.innerHTML = '<div class="empty">No route direction currently claimed.</div>';
      return;
    }
    area.innerHTML = `
      <table class="data-table">
        <thead><tr><th>Direction</th><th>Crew</th><th>Claimed</th></tr></thead>
        <tbody>
          ${claims.map(c => `
            <tr>
              <td>${c.direction === 'asc' ? 'Clockwise →' : '← Counterclockwise'}</td>
              <td>${esc(c.user_name || '—')}</td>
              <td style="font-size:12px;color:var(--text3)">${formatDate(c.claimed_at)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    if (area) area.innerHTML = '<div class="empty">Failed to load run status.</div>';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
