/**
 * Inventory tab — shows all active items with status.
 */

import { get } from './api.js?v=1.0.1';
import { toast } from './app.js?v=1.0.0';

export async function init(container) {
  container.innerHTML = `
    <div class="stats" id="inv-stats">
      <div class="stat-card"><div class="stat-label">Available</div><div class="stat-val" id="inv-avail">—</div></div>
      <div class="stat-card"><div class="stat-label">Checked out</div><div class="stat-val" id="inv-out">—</div></div>
    </div>
    <div class="section-actions">
      <div style="font-size:13px;color:var(--text2)" id="inv-title">Inventory</div>
      <button class="btn sm" onclick="window._inv.refresh()">Refresh</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <div id="inv-body"><div class="empty">Tap refresh to load</div></div>
    </div>
  `;
  window._inv = { refresh: load };
  await load();
}

async function load() {
  const body = document.getElementById('inv-body');
  if (body) body.innerHTML = '<div class="empty"><span class="spinner"></span> Loading…</div>';

  try {
    const data  = await get('/inventory');
    const items = data.items || [];
    const stats = data.stats;

    const avail = document.getElementById('inv-avail');
    const out   = document.getElementById('inv-out');
    if (avail) avail.textContent = stats.available;
    if (out)   out.textContent   = stats.checked_out;

    if (!body) return;
    if (!items.length) {
      body.innerHTML = '<div class="empty">No items in inventory</div>';
      return;
    }

    body.innerHTML = `
      <table class="inv-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Status</th>
            <th>Barrio</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(it => `
            <tr>
              <td>
                <div style="font-size:14px">${it.name}</div>
                ${it.category ? `<div style="font-size:11px;color:var(--text3)">${it.category}</div>` : ''}
              </td>
              <td>
                ${it.status === 'available'
                  ? '<span class="pill available"><span class="dot g"></span>Available</span>'
                  : '<span class="pill out"><span class="dot a"></span>Out</span>'
                }
              </td>
              <td style="color:var(--text2);font-size:13px">${it.current_barrio ?? '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    if (body) body.innerHTML = '<div class="empty">Failed to load — check connection</div>';
    toast('Inventory error: ' + e.message);
  }
}
