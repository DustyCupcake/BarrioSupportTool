/**
 * Shared scan-result renderer.
 * Used by the standalone /scan page and the in-app unified scanner.
 *
 * renderScanResult(container, lookupData, perms, onAction)
 *   onAction(type, data) — callback fired when an action button is tapped.
 *   Action types: 'checkin', 'borrow_self', 'checkout_start', 'entity_select', 'login'
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
      const { name, category, status,
              current_dept, current_group, holder_dept, current_person,
              dept_label, borrowable, borrow_eligible, borrow_reason } = lookupData;

      const holder = current_person?.name || current_group?.name
                   || holder_dept?.name || current_dept?.name || null;
      const statusLabel = formatItemStatus(status, holder);

      cardHtml = `
        <div class="scan-card">
          <div class="scan-card-icon">📦</div>
          <div class="scan-card-body">
            <div class="scan-card-name">${esc(name)}</div>
            ${category ? `<div class="scan-card-sub">${esc(category)}</div>` : ''}
            ${dept_label ? `<div class="scan-card-sub">Label: ${esc(dept_label)}</div>` : ''}
            <div class="scan-card-status ${statusClass(status)}">${statusLabel}</div>
          </div>
        </div>`;

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
        if (borrowable && has('person_borrow')) {
          if (borrow_eligible) {
            actionsHtml += actionBtn('Borrow (check out to me)', 'borrow_self', lookupData, 'primary');
          } else {
            const note = borrowReasonText(borrow_reason);
            if (note) actionsHtml += `<div class="scan-restriction-note">${esc(note)}</div>`;
          }
        }
        if (has('checkout_equipment') || has('sub_checkout')) {
          actionsHtml += actionBtn('Start lending flow', 'checkout_start', lookupData);
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

      if (has('checkout_equipment') || has('sub_checkout')) {
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

function formatItemStatus(status, holder) {
  if (status === 'checked-out' && holder) return `Out — ${holder}`;
  return { available: 'Available', 'checked-out': 'Checked out', retired: 'Retired' }[status] ?? status;
}

function statusClass(status) {
  return { available: 'status-available', 'checked-out': 'status-out', activated: 'status-activated', used: 'status-used', retired: 'status-retired' }[status] ?? '';
}

function borrowReasonText(reason) {
  return {
    restricted:    'Restricted to specific staff — ask a team member to check it out for you.',
    shift_session: "Shift sessions can't self-checkout equipment — ask a team member.",
    no_permission: "You don't have permission to borrow this — ask a team member.",
  }[reason] ?? null;
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
