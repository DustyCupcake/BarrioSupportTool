/**
 * Public water cube status page.
 * No auth required for status check.
 * If the session has request_fills permission, the "Request fill" button appears.
 */

import { Scanner } from './scanner.js?v=1.0.0';

const wrap = document.getElementById('cb-wrap');
let scanner  = null;
let userPerms = [];
let csrfToken = null;

// Silently check session — no redirect on failure
async function loadSession() {
  try {
    const res  = await fetch('/api/auth/me', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    userPerms  = data.permissions || [];
    csrfToken  = data.csrf_token  || null;
  } catch {
    // anonymous visitor — ok
  }
}

function canRequestFills() {
  return userPerms.includes('request_fills');
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderScanner() {
  if (scanner) { scanner.stop(); scanner = null; }

  wrap.innerHTML = `
    <div class="cb-card">
      <div class="cb-card-label">Scan cube QR code</div>
      <div class="cb-video-wrap">
        <video id="cb-video" playsinline muted></video>
        <div class="cb-scan-overlay">
          <div class="cb-scan-frame"><div class="cb-scan-line"></div></div>
        </div>
      </div>
      <div class="cb-status" id="cb-status">Aim camera at the QR code on the cube…</div>
      <button class="cb-manual-link" id="cb-manual-toggle">Can't scan? Enter code manually</button>
      <div class="cb-manual-wrap" id="cb-manual-wrap" style="display:none">
        <input type="text" id="cb-manual-input" placeholder="Type cube code" autocomplete="off">
        <button class="btn sm" id="cb-manual-submit">Check</button>
      </div>
    </div>
  `;

  document.getElementById('cb-manual-toggle').onclick = () => {
    const w = document.getElementById('cb-manual-wrap');
    const shown = w.style.display !== 'none';
    w.style.display = shown ? 'none' : '';
    if (!shown) document.getElementById('cb-manual-input').focus();
  };

  document.getElementById('cb-manual-submit').onclick = () => {
    const val = document.getElementById('cb-manual-input')?.value?.trim();
    if (val) lookupQr(val);
  };

  document.getElementById('cb-manual-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const val = e.target.value.trim();
      if (val) lookupQr(val);
    }
  });

  const video = document.getElementById('cb-video');
  if (video) {
    scanner = new Scanner(video, (qr) => lookupQr(qr));
    scanner.start().catch(() => {
      const stat = document.getElementById('cb-status');
      if (stat) stat.textContent = 'Camera unavailable — enter code manually';
      document.getElementById('cb-manual-wrap').style.display = '';
    });
  }
}

async function lookupQr(qr) {
  if (scanner) { scanner.stop(); scanner = null; }
  const stat = document.getElementById('cb-status');
  if (stat) stat.textContent = 'Looking up…';

  try {
    const res  = await fetch(`/api/water/cube-status?qr=${encodeURIComponent(qr)}`);
    const data = await res.json();
    renderResult(qr, data);
  } catch {
    renderResult(qr, { status: 'not_found' });
  }
}

function renderResult(qr, data) {
  if (data.status === 'not_found') {
    wrap.innerHTML = `
      <div class="cb-result not_found">
        <div class="cb-result-icon">⚠</div>
        <div class="cb-result-title">QR not recognised</div>
        <div class="cb-result-body">This QR code doesn't match a water cube — check the label or speak to production.</div>
      </div>
      <button class="btn" id="cb-scan-again">Scan another cube</button>
    `;
    document.getElementById('cb-scan-again').onclick = renderScanner;
    return;
  }

  const {
    cube_label, entity_name, fill_state,
    last_filled_at, last_sanitized_at,
    fill_requested, fills_remaining, credits_remaining,
    latitude, longitude, location_source,
  } = data;

  let statusClass, icon, title, body;

  if (fill_requested) {
    statusClass = 'requested';
    icon  = '💧';
    title = 'Fill requested';
    body  = `${escHtml(entity_name)} has requested a fill. The water truck will fill this cube on the next run.`;
  } else if (fill_state === 'delivered') {
    statusClass = 'validated';  // amber
    icon  = '⏳';
    title = 'Water delivered — sanitation pending';
    body  = `Delivered ${formatDate(last_filled_at)}. The truck crew will confirm sanitation shortly.`;
  } else if (fill_state === 'sanitized') {
    statusClass = 'filled';
    icon  = '✓';
    title = 'Sanitized';
    body  = `Water filled and sanitized on ${formatDate(last_sanitized_at ?? last_filled_at)}`;
  } else if (fill_state === 'flagged') {
    statusClass = 'flagged';
    icon  = '⚠';
    title = 'Fill flagged';
    body  = `The truck crew flagged this fill on ${formatDate(last_filled_at)} — speak to production before drinking.`;
  } else {
    statusClass = 'ready';
    icon  = '🪣';
    title = escHtml(cube_label);
    body  = entity_name ? `Assigned to ${escHtml(entity_name)}` : 'Assigned — no fills yet';
  }

  const metaItems = [];
  if (data.route_position !== null && data.route_position !== undefined) {
    metaItems.push(`<span>Route stop #${data.route_position}</span>`);
  }
  if (entity_name) {
    metaItems.push(`<span>${escHtml(entity_name)}</span>`);
  }

  const showRequestBtn   = canRequestFills() && !fill_requested && credits_remaining > 0;
  const noCreditWarning  = canRequestFills() && !fill_requested && credits_remaining <= 0;
  const showIdentifyBtn  = !canRequestFills() && !fill_requested && !!entity_name;

  let locationHtml = '';
  if (latitude != null && longitude != null) {
    const label = location_source === 'cube'
      ? 'Custom location set for this cube'
      : `Using ${escHtml(entity_name)}'s default location`;
    locationHtml = `
      <div class="cb-meta">
        <a href="https://maps.google.com/?q=${latitude},${longitude}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">📍 ${label}</a>
      </div>`;
  }

  const canSetLocation = userPerms.includes('update_item_location') || (canRequestFills() && !!entity_name);
  const locationBtnHtml = canSetLocation ? `
    <button class="btn secondary" id="cb-loc-btn">📍 Use my current location for this cube</button>
    <div class="cb-credits-info" id="cb-loc-msg"></div>
  ` : '';

  wrap.innerHTML = `
    <div class="cb-result ${escAttr(statusClass)}">
      <div class="cb-result-icon">${icon}</div>
      <div class="cb-result-title">${escHtml(title)}</div>
      <div class="cb-result-body">${body}</div>
      ${metaItems.length ? `<div class="cb-meta">${metaItems.join('')}</div>` : ''}
      ${locationHtml}
      ${showRequestBtn ? `
        <button class="btn cb-request-btn" id="cb-request-btn">Request a fill</button>
        <div class="cb-credits-info">${credits_remaining} fill credit${credits_remaining !== 1 ? 's' : ''} remaining</div>
      ` : ''}
      ${noCreditWarning ? `
        <div class="cb-result no_credits" style="margin-top:.75rem">
          <div class="cb-result-title" style="font-size:13px">No fill credits remaining</div>
          <div class="cb-result-body">Contact production to purchase more fills.</div>
        </div>
      ` : ''}
      ${showIdentifyBtn ? `
        <button class="btn cb-request-btn" id="cb-identify-btn">Scan your barrio's QR to request a fill</button>
        <div class="cb-credits-info">For ${escHtml(entity_name)}</div>
      ` : ''}
      ${fill_requested ? `
        <div class="cb-credits-info" style="margin-top:.5rem">
          ${fills_remaining !== null ? `${fills_remaining} fill${fills_remaining !== 1 ? 's' : ''} still pending` : ''}
        </div>
      ` : ''}
      ${locationBtnHtml}
    </div>
    <button class="btn secondary" id="cb-scan-again">Scan another cube</button>
  `;

  document.getElementById('cb-scan-again').onclick = renderScanner;

  const reqBtn = document.getElementById('cb-request-btn');
  if (reqBtn) {
    reqBtn.onclick = () => requestFill(qr, reqBtn, data);
  }

  const idBtn = document.getElementById('cb-identify-btn');
  if (idBtn) {
    idBtn.onclick = () => renderIdentifyScanner(qr, data);
  }

  const locBtn = document.getElementById('cb-loc-btn');
  if (locBtn) {
    locBtn.onclick = () => captureLocation(qr, locBtn);
  }
}

// ─── Cube location ──────────────────────────────────────────────────────────

function captureLocation(qr, btn) {
  const msgEl = document.getElementById('cb-loc-msg');
  if (!navigator.geolocation) {
    if (msgEl) msgEl.textContent = 'Geolocation not supported on this device';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Locating…';
  if (msgEl) msgEl.textContent = '';

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      btn.textContent = 'Saving…';
      try {
        const res = await fetch('/api/items/location', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken || '' },
          body: JSON.stringify({
            qr,
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
          }),
        });
        const data = await res.json();

        if (res.ok && data.success) {
          const upd = await fetch(`/api/water/cube-status?qr=${encodeURIComponent(qr)}`);
          renderResult(qr, await upd.json());
        } else {
          btn.disabled = false;
          btn.textContent = '📍 Use my current location for this cube';
          if (msgEl) msgEl.textContent = data.error || 'Could not save location — try again.';
        }
      } catch {
        btn.disabled = false;
        btn.textContent = '📍 Use my current location for this cube';
        if (msgEl) msgEl.textContent = 'Save failed — check connection.';
      }
    },
    () => {
      btn.disabled = false;
      btn.textContent = '📍 Use my current location for this cube';
      if (msgEl) msgEl.textContent = 'Location unavailable — check browser permissions.';
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ─── Barrio self-identify ───────────────────────────────────────────────────

function renderIdentifyScanner(cubeQr, prevData) {
  if (scanner) { scanner.stop(); scanner = null; }

  wrap.innerHTML = `
    <div class="cb-card">
      <div class="cb-card-label">Scan your barrio's QR code</div>
      <div class="cb-video-wrap">
        <video id="cb-id-video" playsinline muted></video>
        <div class="cb-scan-overlay">
          <div class="cb-scan-frame"><div class="cb-scan-line"></div></div>
        </div>
      </div>
      <div class="cb-status" id="cb-id-status">Aim camera at your barrio's QR code…</div>
      <button class="cb-manual-link" id="cb-id-manual-toggle">Can't scan? Enter code manually</button>
      <div class="cb-manual-wrap" id="cb-id-manual-wrap" style="display:none">
        <input type="text" id="cb-id-manual-input" placeholder="Type barrio code" autocomplete="off">
        <button class="btn sm" id="cb-id-manual-submit">Identify</button>
      </div>
      <button class="btn secondary" id="cb-id-cancel" style="width:100%;margin-top:.75rem">Cancel</button>
    </div>
  `;

  document.getElementById('cb-id-cancel').onclick = () => renderResult(cubeQr, prevData);

  document.getElementById('cb-id-manual-toggle').onclick = () => {
    const w = document.getElementById('cb-id-manual-wrap');
    const shown = w.style.display !== 'none';
    w.style.display = shown ? 'none' : '';
    if (!shown) document.getElementById('cb-id-manual-input').focus();
  };

  document.getElementById('cb-id-manual-submit').onclick = () => {
    const val = document.getElementById('cb-id-manual-input')?.value?.trim();
    if (val) identifyBarrio(val, cubeQr, prevData);
  };

  document.getElementById('cb-id-manual-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const val = e.target.value.trim();
      if (val) identifyBarrio(val, cubeQr, prevData);
    }
  });

  const video = document.getElementById('cb-id-video');
  scanner = new Scanner(video, (qr) => identifyBarrio(qr, cubeQr, prevData));
  scanner.start().catch(() => {
    const stat = document.getElementById('cb-id-status');
    if (stat) stat.textContent = 'Camera unavailable — enter code manually';
    document.getElementById('cb-id-manual-wrap').style.display = '';
  });
}

async function identifyBarrio(barrioQr, cubeQr, prevData) {
  if (scanner) { scanner.stop(); scanner = null; }
  const stat = document.getElementById('cb-id-status');
  if (stat) stat.textContent = 'Checking…';

  try {
    const res = await fetch('/api/auth/shift-login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: barrioQr }),
    });
    const data = await res.json();

    if (res.ok && data.success) {
      await loadSession();
      lookupQr(cubeQr);
    } else if (stat) {
      stat.textContent = data.error || 'QR not recognised — try again';
    }
  } catch {
    if (stat) stat.textContent = 'Lookup failed — check connection';
  }
}

async function requestFill(cube_qr, btn, prevData) {
  btn.disabled = true;
  btn.textContent = 'Requesting…';

  try {
    const res = await fetch('/api/fill-requests', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken || '',
      },
      body: JSON.stringify({ cube_qr }),
    });
    const data = await res.json();

    if (res.ok && data.success) {
      // Re-fetch status to show updated state
      const upd = await fetch(`/api/water/cube-status?qr=${encodeURIComponent(cube_qr)}`);
      renderResult(cube_qr, await upd.json());
    } else {
      btn.disabled = false;
      btn.textContent = 'Request a fill';
      const errEl = document.createElement('div');
      errEl.className = 'cb-credits-info';
      errEl.style.color = 'var(--warn)';
      errEl.textContent = data.error || 'Request failed — please try again.';
      btn.insertAdjacentElement('afterend', errEl);
    }
  } catch {
    btn.disabled = false;
    btn.textContent = 'Request a fill';
  }
}

function escAttr(str) {
  return String(str).replace(/[^a-z0-9_-]/gi, '');
}

// Boot
const _preloadQr = new URLSearchParams(window.location.search).get('qr');
loadSession().then(() => {
  if (_preloadQr) {
    lookupQr(_preloadQr);
  } else {
    renderScanner();
  }
});
