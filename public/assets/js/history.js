/**
 * History tab — paginated transaction log.
 */

import { get } from './api.js?v=1.0.1';
import { toast } from './app.js?v=1.0.0';

const PAGE = 50;
let offset = 0;
let total  = 0;

export async function init(container) {
  offset = 0;
  container.innerHTML = `
    <div class="section-actions">
      <div style="font-size:13px;color:var(--text2)" id="hist-title">Transaction log</div>
      <button class="btn sm" onclick="window._hist.refresh()">Refresh</button>
    </div>
    <div class="card" id="hist-card">
      <div id="hist-body"><div class="empty">Tap refresh to load</div></div>
    </div>
    <div id="hist-more" style="display:none">
      <button class="btn ghost" onclick="window._hist.loadMore()">Load more</button>
    </div>
  `;
  window._hist = { refresh: () => { offset = 0; load(true); }, loadMore: () => load(false) };
  await load(true);
}

async function load(reset) {
  if (reset) offset = 0;
  const body = document.getElementById('hist-body');
  if (!body) return;

  if (offset === 0) body.innerHTML = '<div class="empty"><span class="spinner"></span> Loading…</div>';

  try {
    const data = await get('/history', { limit: PAGE, offset });
    total = data.total;
    const log = data.log || [];

    if (offset === 0) body.innerHTML = '';

    if (!log.length && offset === 0) {
      body.innerHTML = '<div class="empty">No transactions recorded yet</div>';
    } else {
      body.insertAdjacentHTML('beforeend', log.map(row => `
        <div class="history-row">
          <div class="h-icon ${row.type === 'checkout' ? 'out' : 'in'}">
            ${row.type === 'checkout' ? '↑' : '↓'}
          </div>
          <div class="h-main">
            <div>
              ${row.item_name}
              ${row.is_offline_entry ? '<span class="offline-badge">offline</span>' : ''}
            </div>
            <div class="h-detail">
              ${row.type === 'checkout'
                ? `Checked out to ${row.barrio_name}`
                : `Returned${row.barrio_name ? ' from ' + row.barrio_name : ''}`
              }
            </div>
            <div class="h-user">by ${row.performed_by_name ?? 'unknown'}</div>
          </div>
          <div class="h-time">${formatTime(row.occurred_at)}</div>
        </div>
      `).join(''));
    }

    offset += log.length;
    const more = document.getElementById('hist-more');
    if (more) more.style.display = offset < total ? '' : 'none';

    const title = document.getElementById('hist-title');
    if (title) title.textContent = `Transaction log (${total})`;
  } catch (e) {
    body.innerHTML = '<div class="empty">Failed to load — check connection</div>';
    toast('History error: ' + e.message);
  }
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
