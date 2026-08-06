/**
 * Shared scan-result renderer.
 * Used by the standalone /scan page and the in-app unified scanner.
 *
 * renderScanResult(container, lookupData, perms, onAction)
 *   onAction(type, data) — callback fired when an action button is tapped.
 *   Action types: 'checkin', 'borrow_self', 'checkout_start', 'activate',
 *                 'validate', 'entity_select', 'login'
 */

export function renderScanResult(container, lookupData, perms, onAction) {
  const { type } = lookupData;
  const authed = perms.length > 0 || perms !== null;

  const has = p => Array.isArray(perms) && perms.includes(p);

  let cardHtml = '';
  let actionsHtml = '';

  // ── Info card ──────────────────────────────────────────────────────────────
  switch (type) {
    case 'item': {
      const { name, category, status, is_voucher,
              current_dept, current_group, holder_dept, current_person,
              dept_label, borrowable, borrow_eligible } = lookupData;

      const holder = current_person?.name || current_group?.name
                   || holder_dept?.name || current_dept?.name || null;
      const statusLabel = formatItemStatus(status, holder, is_voucher);

      cardHtml = `
        <div class="scan-card">
          <div class="scan-card-icon">${is_voucher ? '🎟' : '📦'}</div>
          <div class="scan-card-body">
            <div class="scan-card-name">${esc(name)}</div>
            ${category ? `<div class="scan-card-sub">${esc(category)}</div>` : ''}
            ${dept_label ? `<div class="scan-card-sub">Label: ${esc(dept_label)}</div>` : ''}
            <div class="scan-card-status ${statusClass(status)}">${statusLabel}</div>
          </div>
        </div>`;

      // Actions for regular items
      if (!is_voucher) {
        if (['checked-out'].includes(status)) {
          const canReturn = has('checkin_equipment') || has('sub_checkin');
          const canLend   = has('checkout_equipment') || has('sub_checkout');
          if (canReturn) {
            actionsHtml += actionBtn('Return equipment', 'checkin', lookupData);
          }
          if (canLend) {
            actionsHtml += actionBtn(
              holder ? `Add to lending list (transfer from ${holder})` : 'Add to lending list',
              'checkout_start', lookupData
            );
          }
        }
        if (status === 'available') {
          if (borrowable && borrow_eligible && (has('person_borrow') || has('person_checkout'))) {
            actionsHtml += actionBtn('Borrow (check out to me)', 'borrow_self', lookupData, 'primary');
          }
          if (has('checkout_equipment') || has('sub_checkout')) {
            actionsHtml += actionBtn('Start lending flow', 'checkout_start', lookupData);
          }
        }
      }

      // Actions for vouchers
      if (is_voucher) {
        if (status === 'checked-out' && (has('validate_vouchers') || has('person_checkout'))) {
          actionsHtml += actionBtn('Activate voucher', 'activate', lookupData, 'primary');
        }
        if (status === 'activated' && has('validate_vouchers')) {
          actionsHtml += actionBtn('Validate (mark as used)', 'validate', lookupData, 'primary');
        }
      }
      break;
    }

    case 'person': {
      const { name, dept_memberships } = lookupData;
      const teams = dept_memberships?.map(m => esc(m.name)).join(', ') || null;

      cardHtml = `
        <div class="scan-card">
          <div class="scan-card-icon">👤</div>
          <div class="scan-card-body">
            <div class="scan-card-name">${esc(name)}</div>
            ${teams ? `<div class="scan-card-sub">${teams}</div>` : ''}
          </div>
        </div>`;

      if (has('checkout_equipment') || has('sub_checkout') || has('person_checkout') || has('sub_checkout')) {
        actionsHtml += actionBtn('Lend to this person', 'entity_select', lookupData, 'primary');
      }
      break;
    }

    case 'group': {
      const { name, arrival_status, item_count, enable_arrival_tracking } = lookupData;
      const statusLabel = enable_arrival_tracking
        ? ({ expected: 'Expected', 'on-site': 'On site', departed: 'Departed' }[arrival_status] ?? arrival_status)
        : null;

      cardHtml = `
        <div class="scan-card">
          <div class="scan-card-icon">⛺</div>
          <div class="scan-card-body">
            <div class="scan-card-name">${esc(name)}</div>
            <div class="scan-card-sub">${statusLabel ? statusLabel : ''}${item_count != null ? `${statusLabel ? ' · ' : ''}${item_count} item${item_count !== 1 ? 's' : ''} out` : ''}</div>
          </div>
        </div>`;

      if (has('sub_checkout') || has('checkout_equipment')) {
        actionsHtml += actionBtn('Lend to this group', 'entity_select', lookupData, 'primary');
      }
      break;
    }

    case 'department': {
      const { name, manages_groups, member_count } = lookupData;
      const subLabel = manages_groups ? ' · manages groups' : '';

      cardHtml = `
        <div class="scan-card">
          <div class="scan-card-icon">👥</div>
          <div class="scan-card-body">
            <div class="scan-card-name">${esc(name)}</div>
            <div class="scan-card-sub">Team${subLabel}${member_count != null ? ` · ${member_count} member${member_count !== 1 ? 's' : ''}` : ''}</div>
          </div>
        </div>`;

      if (has('checkout_equipment')) {
        actionsHtml += actionBtn('Lend to this team', 'entity_select', lookupData, 'primary');
      }
      break;
    }

    default:
      cardHtml = `
        <div class="scan-card scan-card--error">
          <div class="scan-card-icon">❓</div>
          <div class="scan-card-body">
            <div class="scan-card-name">Unrecognised code</div>
            <div class="scan-card-sub">This QR code is not registered in the system.</div>
          </div>
        </div>`;
  }

  // Login prompt for unauthenticated users
  if (!Array.isArray(perms) || perms.length === 0) {
    actionsHtml = actionBtn('Log in to take action', 'login', lookupData, 'primary');
  }

  container.innerHTML = `
    ${cardHtml}
    ${actionsHtml ? `<div class="scan-actions">${actionsHtml}</div>` : ''}
  `;

  // Wire up action buttons
  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      onAction(btn.dataset.action, JSON.parse(btn.dataset.payload || '{}'));
    });
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function actionBtn(label, action, data, variant = '') {
  const payload = JSON.stringify(data).replace(/"/g, '&quot;');
  return `<button class="btn${variant ? ' ' + variant : ''} scan-action-btn"
    data-action="${action}" data-payload="${payload}">${label}</button>`;
}

function formatItemStatus(status, holder, is_voucher) {
  if (is_voucher) {
    return { 'checked-out': 'Attributed — not activated', activated: 'Activated — ready to validate', used: 'Already validated', available: 'Available', retired: 'Retired' }[status] ?? status;
  }
  if (status === 'checked-out' && holder) return `Out — ${holder}`;
  return { available: 'Available', 'checked-out': 'Checked out', activated: 'Activated', used: 'Used', retired: 'Retired' }[status] ?? status;
}

function statusClass(status) {
  return { available: 'status-available', 'checked-out': 'status-out', activated: 'status-activated', used: 'status-used', retired: 'status-retired' }[status] ?? '';
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
