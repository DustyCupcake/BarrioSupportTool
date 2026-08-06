/**
 * Orders tab — dept equipment order form.
 * dept_admin / dept_staff (submit_orders): order form for their department.
 * production_admin (manage_orders): aggregate pivot view across all departments.
 */

import { get, put } from './api.js?v=1.0.1';
import { toast, getCurrentUser } from './app.js?v=1.0.1';

export function init(container) {
  const user = getCurrentUser();
  if (!user) return;

  const isProdAdmin = (user.permissions || []).includes('manage_orders');
  isProdAdmin ? renderAggregate(container) : renderDeptForm(container);
}

// ─── Dept order form ───────────────────────────────────────────────────────────

async function renderDeptForm(container) {
  container.innerHTML = `
    <div class="section-actions"><div style="font-size:15px">Equipment Orders</div></div>
    <div id="orders-body"><div style="text-align:center;padding:2rem">Loading…</div></div>
  `;

  try {
    const data = await get('/dept-orders');
    renderDeptTable(container, data.orders || [], data.dept_id);
  } catch (e) {
    container.querySelector('#orders-body').innerHTML =
      `<div class="empty-list">Could not load orders: ${_esc(e.message)}</div>`;
  }
}

function renderDeptTable(container, orders, deptId) {
  const body = container.querySelector('#orders-body');

  if (!orders.length) {
    body.innerHTML = `<div class="empty-list">No equipment types available for ordering.</div>`;
    return;
  }

  const available = orders.filter(o => !o.deadline_passed);
  const closed    = orders.filter(o => o.deadline_passed);

  const renderRow = (o) => {
    const deadlineText = o.order_deadline
      ? new Date(o.order_deadline.replace(' ', 'T')).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })
      : '—';
    const deadlineCls = o.deadline_passed ? 'color:var(--danger)' : 'color:var(--text3)';
    return `
      <tr>
        <td>${_esc(o.type_name)}</td>
        <td style="text-align:center">${o.quantity_ordered}</td>
        <td style="text-align:center">${o.qty_in_pool}</td>
        <td style="font-size:12px;${deadlineCls}">${deadlineText}</td>
        <td style="text-align:center">
          ${o.deadline_passed
            ? '<span style="font-size:12px;color:var(--text3)">Closed</span>'
            : `<input type="number" class="order-qty-input" data-type-id="${o.equipment_type_id}"
                 min="0" value="" placeholder="+0" inputmode="numeric">`
          }
        </td>
      </tr>
    `;
  };

  const user = getCurrentUser();
  const managesGroups = user?.dept_manages_groups || {};
  const isGroupSupport = Object.values(managesGroups).some(Boolean);
  const prefillBtn = isGroupSupport
    ? `<button class="btn ghost" id="orders-prefill-btn" style="margin-bottom:.75rem;font-size:13px">Pre-fill from group orders</button>`
    : '';

  body.innerHTML = `
    ${prefillBtn}
    <div class="card" style="padding:0;overflow:hidden">
      <table class="inv-table" style="width:100%">
        <thead>
          <tr>
            <th>Equipment type</th>
            <th style="text-align:center">Ordered</th>
            <th style="text-align:center">In pool</th>
            <th>Deadline</th>
            <th style="text-align:center">Add</th>
          </tr>
        </thead>
        <tbody>
          ${available.map(renderRow).join('')}
          ${closed.length ? `<tr><td colspan="5" style="font-size:12px;color:var(--text3);padding:.4rem 1rem;border-top:1px solid var(--border)">Closed orders</td></tr>` : ''}
          ${closed.map(renderRow).join('')}
        </tbody>
      </table>
    </div>
    <button class="btn primary" id="orders-save-btn" style="margin-top:.75rem">Save orders</button>
  `;

  document.getElementById('orders-save-btn')?.addEventListener('click', () => saveOrders(deptId, container));

  document.getElementById('orders-prefill-btn')?.addEventListener('click', async () => {
    try {
      const agg = await get('/admin/barrio-orders-aggregate');
      // aggregate: [{equipment_type_id, total}]
      const totals = {};
      for (const row of (agg.aggregate || [])) totals[row.equipment_type_id] = row.total;
      document.querySelectorAll('.order-qty-input').forEach(inp => {
        const tid = +inp.dataset.typeId;
        if (totals[tid] != null) inp.value = totals[tid];
      });
      toast('Pre-filled from group orders');
    } catch (e) {
      toast('Could not load group orders: ' + e.message);
    }
  });
}

async function saveOrders(deptId, container) {
  const inputs = document.querySelectorAll('.order-qty-input');
  const orders = [];
  inputs.forEach(inp => {
    const qty = parseInt(inp.value || '0', 10);
    if (qty > 0) orders.push({ equipment_type_id: +inp.dataset.typeId, quantity_ordered: qty });
  });

  if (!orders.length) {
    toast('No quantities entered');
    return;
  }

  const btn = document.getElementById('orders-save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    await put('/dept-orders', { dept_id: deptId, orders });
    toast('Orders saved');
    await renderDeptForm(container);
  } catch (e) {
    toast('Save failed: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Save orders';
  }
}

// ─── Production aggregate view ─────────────────────────────────────────────────

async function renderAggregate(container) {
  container.innerHTML = `
    <div class="section-actions"><div style="font-size:15px">Equipment Orders — All Teams</div></div>
    <div id="orders-body"><div style="text-align:center;padding:2rem">Loading…</div></div>
  `;

  try {
    const data = await get('/admin/dept-orders');
    renderAggregateTable(container, data);
  } catch (e) {
    container.querySelector('#orders-body').innerHTML =
      `<div class="empty-list">Could not load orders: ${_esc(e.message)}</div>`;
  }
}

function renderAggregateTable(container, data) {
  const body    = container.querySelector('#orders-body');
  const depts   = data.departments || [];
  const types   = data.types       || [];
  const pivot   = data.pivot       || {};

  if (!types.length) {
    body.innerHTML = `<div class="empty-list">No equipment types configured.</div>`;
    return;
  }

  const deptCols = depts.map(d =>
    `<th style="text-align:center;font-size:12px">${_esc(d.name)}</th>`
  ).join('');

  const tableRows = types.map(t => {
    const typePivot = pivot[t.id] || {};
    const total = depts.reduce((sum, d) => sum + (typePivot[d.id] || 0), 0);
    const deptQtys = depts.map(d => {
      const qty = typePivot[d.id] || 0;
      return `<td style="text-align:center">${qty || '—'}</td>`;
    }).join('');
    return `
      <tr>
        <td>${_esc(t.name)}</td>
        <td style="text-align:center;font-weight:600">${total || '—'}</td>
        ${deptQtys}
      </tr>
    `;
  }).join('');

  body.innerHTML = `
    <div style="overflow-x:auto">
      <table class="inv-table" style="width:100%;min-width:400px">
        <thead>
          <tr>
            <th>Equipment type</th>
            <th style="text-align:center">Total</th>
            ${deptCols}
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
  `;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
