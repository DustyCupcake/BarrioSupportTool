/**
 * Scan In tab — return equipment or validate vouchers.
 */

import { get, post, put } from './api.js?v=1.0.1';
import { Scanner, scanFeedbackSuccess, scanFeedbackError } from './scanner.js?v=1.0.1';
import { toast, getCurrentUser } from './app.js?v=1.0.1';
import { scanOverlay } from './scan-overlay.js?v=1.0.1';
import { init as initValidate, destroy as destroyValidate } from './validate.js?v=1.0.1';
import { init as initActivate, destroy as destroyActivate } from './activate.js?v=1.0.0';
import { t } from './i18n.js?v=1.0.0';

const __ = (key) => t('checkin', key);
const _c = (key) => t('common', key);

let scanner         = null;
let lastItem        = null;
let pendingLocation = null; // { id, name, qr_code } when user has scanned a location first
let mode            = 'return'; // 'return' | 'validate' | 'activate'

export function init(container) {
  render(container);
}

export function destroy() {
  if (scanner) { scanner.stop(); scanner = null; }
  pendingLocation = null;
  destroyValidate();
  destroyActivate();
}

function render(container) {
  lastItem        = null;
  pendingLocation = null;

  const toggleHTML = `
    <div class="mode-toggle-wrap">
      <div class="mode-toggle">
        <button ${mode === 'return'   ? 'class="active"' : ''} onclick="window._ci.setMode('return')">${__('modeReturn')}</button>
        <button ${mode === 'validate' ? 'class="active"' : ''} onclick="window._ci.setMode('validate')">${__('modeVoucher')}</button>
        <button ${mode === 'activate' ? 'class="active"' : ''} onclick="window._ci.setMode('activate')">${__('modeActivate')}</button>
      </div>
    </div>
  `;

  window._ci = { setMode: (v) => setMode(v, container) };

  if (mode === 'validate') {
    container.innerHTML = toggleHTML;
    const inner = document.createElement('div');
    container.appendChild(inner);
    initValidate(inner, false);
    return;
  }

  if (mode === 'activate') {
    container.innerHTML = toggleHTML;
    const inner = document.createElement('div');
    container.appendChild(inner);
    initActivate(inner);
    return;
  }

  if (scanner) { scanner.stop(); scanner = null; }

  const locationHint = pendingLocation
    ? `<div class="location-pending-badge">📍 ${pendingLocation.name} — now scan the item</div>`
    : '';

  container.innerHTML = toggleHTML + `
    <div class="card">
      <div class="card-label">Scan item to return</div>
      ${locationHint}
      <div class="video-wrap" id="ci-video-wrap">
        <video id="ci-video" playsinline muted></video>
        <div class="scan-overlay"><div class="scan-frame"><div class="scan-line"></div></div></div>
      </div>
      <div class="scan-status" id="ci-status">${_c('aimCamera')}</div>
    </div>
  `;

  startScanner(container);
}

function setMode(v, container) {
  mode = v;
  destroyValidate();
  destroyActivate();
  if (scanner) { scanner.stop(); scanner = null; }
  render(container);
}

async function startScanner(container) {
  const video = document.getElementById('ci-video');
  if (!video) return;
  scanner = new Scanner(video, (qr) => handleScan(qr, container));
  try {
    await scanner.start();
  } catch (e) {
    const stat = document.getElementById('ci-status');
    if (stat) stat.textContent = _c('cameraError');
  }
}

function _checkedOutTo(item) {
  if (item.current_person) return `${__('checkedOutTo')} ${item.current_person.name}`;
  if (item.current_barrio) return `${__('checkedOutTo')} ${item.current_barrio.name}`;
  if (item.current_artist) return `${__('checkedOutTo')} ${item.current_artist.name}`;
  if (item.current_dept)   return `${__('inDeptPool')} ${item.current_dept.name}`;
  return item.category ?? null;
}

function _borrowReasonText(reason) {
  if (reason === 'restricted')      return __('borrowRestricted');
  if (reason === 'no_permission')   return __('borrowNoPermission');
  if (reason === 'shift_session')   return __('borrowShiftSession');
  if (reason === 'not_borrowable')  return __('borrowNotBorrowable');
  return __('borrowNotEligible');
}

async function handleScan(qr, container) {
  const stat = document.getElementById('ci-status');
  if (stat) stat.textContent = _c('lookingUp');

  const doReset = () => {
    scanOverlay.hide();
    render(container);
  };

  // Detect shift QR scanned into the equipment scanner — warn and ignore
  try {
    const url = new URL(qr);
    if (url.pathname === '/shift' && url.searchParams.has('token')) {
      scanOverlay.show({
        state: 'warning',
        title: 'Shift QR detected',
        subtitle: "This is a volunteer shift login code — scan it with your phone's camera app, not here",
        buttons: [{ label: _c('ok'), action: doReset }],
      });
      return;
    }
  } catch { /* not a URL */ }

  // Build the action that triggers the actual checkin POST
  const doConfirmReturn = async (itemQr) => {
    scanOverlay.hide();
    await confirmCheckin(itemQr, container);
  };

  // ── Check if this QR is a storage location first ─────────────────────────
  try {
    const locData = await get('/locations/lookup', { qr });
    if (locData && locData.type === 'storage_location') {
      pendingLocation = { id: locData.id, name: locData.name, qr_code: qr };
      scanFeedbackSuccess();
      render(container); // re-render with "now scan the item" badge
      startScanner(container);
      return;
    }
  } catch { /* not a location — continue with item lookup */ }

  try {
    let item;

    if (!navigator.onLine) {
      const cached = localStorage.getItem('barrio_item:' + qr);
      if (cached) item = JSON.parse(cached);
    }

    if (!item) {
      item = await get('/items/lookup', { qr });
      try { localStorage.setItem('barrio_item:' + qr, JSON.stringify(item)); } catch {}
    }

    lastItem = item;
    scanFeedbackSuccess();

    if (item.status === 'available') {
      if (item.borrowable && item.borrow_eligible) {
        scanOverlay.show({
          state: 'success',
          title: item.name,
          subtitle: __('availableForBorrow'),
          buttons: [
            { label: __('borrowCheckOut'), action: () => startPersonBorrowFlow(item, container, false) },
            { label: _c('cancel'),         action: doReset },
          ],
        });
      } else if (item.borrowable && !item.borrow_eligible) {
        scanOverlay.show({
          state: 'warning',
          title: item.name,
          subtitle: _borrowReasonText(item.borrow_reason),
          buttons: [{ label: _c('ok'), action: doReset }],
        });
      } else {
        scanOverlay.show({
          state: 'warning',
          title: item.name,
          subtitle: __('alreadyReturned'),
          buttons: [{ label: _c('ok'), action: doReset }],
        });
      }
      return;
    }

    // ── Checked-out item ──────────────────────────────────────────────────
    const subtitle = _checkedOutTo(item);

    // Determine location requirement
    const requireHome = item.require_home_location;
    const requireAny  = item.require_any_location;
    const homeLocName = item.home_location?.name;

    // If a location is required but not yet scanned, prompt for it
    if ((requireHome || requireAny) && !pendingLocation) {
      const hint = requireHome
        ? `Scan location QR to return (must go to: ${homeLocName || 'home location'})`
        : 'Scan a storage location QR to return this item';

      scanOverlay.show({
        state: 'info',
        title: item.name,
        subtitle: hint,
        buttons: [
          {
            label: 'Scan location',
            action: () => {
              scanOverlay.hide();
              // Remember the item and start scanner waiting for a location QR
              lastItem = item;
              _awaitLocationThenCheckin(item, qr, container);
            },
          },
          { label: _c('cancel'), action: doReset },
        ],
      });
      return;
    }

    // Build location subtitle addition
    let locSubtitle = subtitle;
    if (pendingLocation) {
      locSubtitle = (subtitle ? subtitle + ' · ' : '') + '📍 ' + pendingLocation.name;
    }

    const buttons = [];

    // Navigation button — opens maps to guide user to home location (doesn't close overlay)
    const homeLat = item.home_location?.latitude;
    const homeLng = item.home_location?.longitude;
    const navBtn = (homeLat != null)
      ? [{
          label: `Navigate to ${item.home_location.name}`,
          action: () => window.open(
            `https://maps.apple.com/?daddr=${homeLat},${homeLng}`, '_blank'
          ),
        }]
      : [];

    if (item.current_person && item.borrowable && item.borrow_eligible) {
      buttons.push({ label: __('confirmReturn'), action: () => doConfirmReturn(qr) });
      buttons.push({ label: __('borrowTransfer'), action: () => startPersonBorrowFlow(item, container, true) });
      buttons.push(...navBtn);
      buttons.push({ label: _c('undo'), action: doReset });
    } else {
      buttons.push({ label: __('confirmReturn'), action: () => doConfirmReturn(qr) });
      buttons.push(...navBtn);
      buttons.push({ label: _c('undo'),          action: doReset });
    }

    scanOverlay.show({
      state: 'success',
      title: item.name,
      subtitle: locSubtitle,
      buttons,
    });

  } catch (e) {
    scanFeedbackError();

    const doManual = () => {
      scanOverlay.showManualEntry({
        placeholder: _c('enterManually'),
        onSubmit: (typed) => handleScan(typed, container),
        onCancel: doReset,
      });
    };

    if (!e.status && !navigator.onLine) {
      scanOverlay.show({
        state: 'warning',
        title: _c('offline'),
        subtitle: __('unavailableQueue'),
        buttons: [
          { label: __('returnAnyway'), action: () => doConfirmReturn(qr) },
          { label: _c('cancel'),       action: doReset },
        ],
      });
      return;
    }

    scanOverlay.show({
      state: 'error',
      title: _c('notFound'),
      subtitle: e.status === 404 ? _c('notFound') : _c('lookingUp'),
      buttons: [
        { label: _c('ok'),            action: doReset },
        { label: _c('enterManually'), action: doManual },
      ],
    });

    toast(e.message);
  }
}

// Scan-for-location flow: shows a mini scanner waiting for a location QR,
// then proceeds to confirm checkin with both the item and location QR.
function _awaitLocationThenCheckin(item, itemQr, container) {
  if (scanner) { scanner.stop(); scanner = null; }

  const wrap = document.getElementById('ci-video-wrap');
  if (wrap) {
    const stat = document.getElementById('ci-status');
    if (stat) stat.textContent = 'Scan storage location QR…';
  }

  const video = document.getElementById('ci-video');
  if (!video) { render(container); return; }

  scanner = new Scanner(video, async (locQr) => {
    try {
      const locData = await get('/locations/lookup', { qr: locQr });
      if (!locData || locData.type !== 'storage_location') {
        toast('That is not a storage location QR');
        startScanner(container);
        return;
      }

      // Validate home-location requirement
      if (item.require_home_location && item.home_location && locData.id !== item.home_location.id) {
        scanFeedbackError();
        toast(`Must return to: ${item.home_location.name}`);
        startScanner(container);
        return;
      }

      scanFeedbackSuccess();
      pendingLocation = { id: locData.id, name: locData.name, qr_code: locQr };
      await confirmCheckin(itemQr, container);
    } catch (e) {
      scanFeedbackError();
      toast('Location lookup failed');
      startScanner(container);
    }
  });

  scanner.start().catch(() => {
    const stat = document.getElementById('ci-status');
    if (stat) stat.textContent = _c('cameraError');
  });
}

async function confirmCheckin(qr, container) {
  const body = { item_qr: qr };
  if (pendingLocation) body.location_qr = pendingLocation.qr_code;

  try {
    const res = await post('/checkin', body);
    if (res.__offline) {
      toast(_c('offlineSaved'));
    } else if (res.success) {
      const locMsg = pendingLocation ? ` → ${pendingLocation.name}` : '';
      toast((__('returned') || 'Returned').replace('[NAME]', lastItem?.name ?? qr) + locMsg);
      // Offer to update home location if returned to a different spot
      const snapItem = lastItem;
      const snapLoc  = pendingLocation;
      await _maybePromptHomeLocation(snapItem, snapLoc, container);
      return;
    } else {
      toast(__('notCheckedOut'));
    }
  } catch (e) {
    scanFeedbackError();
    toast(e.message || 'Error returning item');
    render(container);
    return;
  }

  render(container);
}

async function _maybePromptHomeLocation(item, location, container) {
  const user       = getCurrentUser();
  const canManage  = user?.permissions?.includes('manage_equipment');
  const homeId     = item?.home_location?.id;
  const locId      = location?.id;

  if (canManage && homeId && locId && locId !== homeId) {
    scanOverlay.show({
      state: 'info',
      title: 'Update home location?',
      subtitle: `Home is "${item.home_location.name}". Make "${location.name}" the new home for ${item.name}?`,
      buttons: [
        {
          label: `Set home to ${location.name}`,
          action: async () => {
            scanOverlay.hide();
            try {
              await put('/admin/items', { id: item.id, home_location_id: location.id });
              toast(`Home location updated to ${location.name}`);
            } catch (e) {
              toast('Could not update: ' + e.message);
            }
            render(container);
          },
        },
        {
          label: 'Keep current home',
          action: () => { scanOverlay.hide(); render(container); },
        },
      ],
    });
  } else {
    render(container);
  }
}

// ─── Person borrow flow ───────────────────────────────────────────────────────

function startPersonBorrowFlow(item, container, isTransfer) {
  scanOverlay.hide();
  if (scanner) { scanner.stop(); scanner = null; }

  const label = isTransfer ? __('borrowTransfer') : __('borrowCheckOut');

  container.innerHTML = `
    <div class="card">
      <div class="card-label">${label}: ${item.name}</div>
      <input class="search-input" id="borrow-search" type="search"
        placeholder="${__('borrowSearchPlaceholder')}" autocomplete="off" autocorrect="off" spellcheck="false">
      <div id="borrow-results" class="search-results"></div>
    </div>
    <button class="btn-ghost" id="borrow-cancel" style="margin-top:1rem">${_c('cancel')}</button>
  `;

  document.getElementById('borrow-cancel').addEventListener('click', () => render(container));

  let searchTimeout;
  const searchInput = document.getElementById('borrow-search');
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const q = searchInput.value.trim();
    const resultsEl = document.getElementById('borrow-results');
    if (!resultsEl) return;
    if (q.length < 2) { resultsEl.innerHTML = ''; return; }
    searchTimeout = setTimeout(() => doPersonSearch(q, item, container, isTransfer), 300);
  });

  setTimeout(() => searchInput.focus(), 60);
}

async function doPersonSearch(q, item, container, isTransfer) {
  const resultsEl = document.getElementById('borrow-results');
  if (!resultsEl) return;

  try {
    const data    = await get('/persons', { q });
    const persons = data.persons || [];

    if (!persons.length) {
      resultsEl.innerHTML = `<div class="search-no-results">${_c('noResults')}</div>`;
      return;
    }

    resultsEl.innerHTML = persons.map(p =>
      `<button class="search-result-item" data-id="${p.id}" data-qr="${p.qr_token}"
        data-name="${p.display_name.replace(/"/g, '&quot;')}">${p.display_name}</button>`
    ).join('');

    resultsEl.querySelectorAll('.search-result-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const person = { id: +btn.dataset.id, qr_token: btn.dataset.qr, display_name: btn.dataset.name };
        confirmPersonBorrow(item, person, container, isTransfer);
      });
    });
  } catch (e) {
    resultsEl.innerHTML = `<div class="search-no-results">${_c('error') ?? 'Error'}</div>`;
  }
}

function confirmPersonBorrow(item, person, container, isTransfer) {
  const action = isTransfer ? __('borrowTransfer') : __('borrowCheckOut');
  scanOverlay.show({
    state: 'success',
    title: item.name,
    subtitle: `${action}: ${person.display_name}`,
    buttons: [
      { label: _c('confirm'), action: () => doPersonBorrow(item, person, container) },
      { label: _c('cancel'),  action: () => startPersonBorrowFlow(item, container, isTransfer) },
    ],
  });
}

async function doPersonBorrow(item, person, container) {
  scanOverlay.hide();
  try {
    const user  = getCurrentUser();
    const perms = user?.permissions || [];
    let result;

    if (perms.includes('checkout_equipment')) {
      result = await post('/person-checkout', {
        person_qr: person.qr_token,
        item_qrs:  [item.qr_code],
        force:     true,
      });
    } else {
      const deptId = (user?.dept_ids || [])[0];
      result = await post('/sub-person-checkout', {
        dept_id:   deptId,
        person_qr: person.qr_token,
        item_qrs:  [item.qr_code],
        force:     true,
      });
    }

    if (result.success !== false) {
      toast(__('borrowDone').replace('[PERSON]', person.display_name));
    }
  } catch (e) {
    toast('Error: ' + e.message);
  }

  render(container);
}
