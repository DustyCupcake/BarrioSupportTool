/**
 * Fill request creation tab.
 * Used by noinfo staff (barrio lookup by name or QR) and NWP reps (cube QR or entity QR).
 * Requires request_fills permission.
 */

import { get, post, del } from './api.js?v=1.0.1';
import { Scanner } from './scanner.js?v=1.0.0';

let _panel  = null;
let scanner = null;

export function init(panel, user) {
  _panel = panel;
  render(user);
}

export function destroy() {
  stopScanner();
  _panel = null;
}

function stopScanner() {
  if (scanner) { scanner.stop(); scanner = null; }
}

// ── Main render ───────────────────────────────────────────────────────────────

function render(user) {
  _panel.innerHTML = `
    <div style="padding:1rem 1.25rem 2rem;max-width:560px;margin:0 auto">
      <div class="section-header" style="margin-bottom:1.25rem">
        <div class="section-title">Water fill requests</div>
        <div class="section-sub">Request water cube fills for barrios and NWP</div>
      </div>

      <div style="display:flex;gap:.5rem;margin-bottom:1rem">
        <button class="btn" id="fr-barrio-btn">Barrio request</button>
        <button class="btn secondary" id="fr-cube-btn">Scan cube (NWP)</button>
      </div>

      <div id="fr-barrio-section" style="display:none"></div>
      <div id="fr-cube-section"   style="display:none"></div>
      <div id="fr-result"         style="margin-top:1rem"></div>
    </div>
  `;

  _panel.querySelector('#fr-barrio-btn').onclick = () => showBarrioSection();
  _panel.querySelector('#fr-cube-btn').onclick   = () => showCubeSection();
}

// ── Barrio section ────────────────────────────────────────────────────────────

function showBarrioSection() {
  const sect = _panel.querySelector('#fr-barrio-section');
  const cubeSect = _panel.querySelector('#fr-cube-section');
  stopScanner();
  cubeSect.style.display = 'none';
  sect.style.display = '';

  sect.innerHTML = `
    <div class="card" style="padding:1rem 1.25rem;margin-bottom:.75rem">
      <div class="card-label" style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--text3);margin-bottom:.75rem">
        Find barrio
      </div>

      <div style="display:flex;gap:.5rem;margin-bottom:.75rem">
        <input type="text" id="fr-barrio-search" placeholder="Barrio name…"
          style="flex:1;padding:9px 12px;font-family:Georgia,serif;font-size:14px;
                 border:0.5px solid var(--border-med);border-radius:var(--radius);
                 background:var(--surface);color:var(--text)">
        <button class="btn sm" id="fr-barrio-search-btn">Search</button>
      </div>

      <div style="position:relative;margin-bottom:.5rem">
        <div style="text-align:center;font-size:12px;color:var(--text3);margin-bottom:.5rem">or scan barrio QR</div>
        <div id="fr-barrio-scan-wrap">
          <button class="btn secondary sm" id="fr-barrio-scan-btn" style="width:100%">Open scanner</button>
        </div>
      </div>

      <div id="fr-barrio-results" style="margin-top:.5rem"></div>
    </div>
    <div id="fr-barrio-detail"></div>
  `;

  const searchInput = sect.querySelector('#fr-barrio-search');
  const searchBtn   = sect.querySelector('#fr-barrio-search-btn');

  let _allBarrios = null;

  const doSearch = async () => {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) return;
    const res = sect.querySelector('#fr-barrio-results');
    res.innerHTML = '<div style="font-size:13px;color:var(--text3)">Searching…</div>';
    try {
      if (!_allBarrios) {
        const data = await get('/groups');
        _allBarrios = data.groups || [];
      }
      const matches = _allBarrios.filter(b => b.name.toLowerCase().includes(q)).slice(0, 8);
      if (!matches.length) {
        res.innerHTML = '<div style="font-size:13px;color:var(--text3)">No barrios found</div>';
        return;
      }
      res.innerHTML = matches.map(b => `
        <button class="btn secondary sm" data-id="${b.id}"
          style="display:block;width:100%;text-align:left;margin-bottom:.35rem">
          ${escHtml(b.name)}
        </button>
      `).join('');
      res.querySelectorAll('button[data-id]').forEach(btn => {
        btn.onclick = () => loadBarrioDetail(+btn.dataset.id);
      });
    } catch {
      res.innerHTML = '<div style="font-size:13px;color:var(--warn)">Search failed</div>';
    }
  };

  searchBtn.onclick = doSearch;
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  // Barrio QR scan
  sect.querySelector('#fr-barrio-scan-btn').onclick = () => {
    const wrap = sect.querySelector('#fr-barrio-scan-wrap');
    wrap.innerHTML = `
      <div style="position:relative;width:100%;aspect-ratio:1;background:#000;border-radius:var(--radius);overflow:hidden;margin-bottom:.5rem">
        <video id="fr-bscan-video" playsinline muted style="width:100%;height:100%;object-fit:cover;display:block"></video>
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none">
          <div style="width:58%;aspect-ratio:1;border:2px solid rgba(255,255,255,.7);border-radius:12px"></div>
        </div>
      </div>
      <button class="btn secondary sm" id="fr-bscan-cancel" style="width:100%">Cancel</button>
    `;
    wrap.querySelector('#fr-bscan-cancel').onclick = () => {
      stopScanner();
      wrap.innerHTML = `<button class="btn secondary sm" id="fr-barrio-scan-btn" style="width:100%">Open scanner</button>`;
      wrap.querySelector('#fr-barrio-scan-btn').onclick = arguments.callee;
    };

    const video = wrap.querySelector('#fr-bscan-video');
    scanner = new Scanner(video, (qr) => {
      stopScanner();
      lookupBarrioByQr(qr, sect);
    });
    scanner.start().catch(() => {
      wrap.innerHTML = `<div style="font-size:12px;color:var(--warn)">Camera unavailable</div>`;
    });
  };
}

async function lookupBarrioByQr(qr, sect) {
  const res = sect.querySelector('#fr-barrio-results');
  if (res) res.innerHTML = '<div style="font-size:13px;color:var(--text3)">Looking up…</div>';
  try {
    // Use the scan/lookup endpoint which handles entity QRs
    const data = await get('/scan/lookup', { qr });
    if (data?.type === 'group' && data.id) {
      if (res) res.innerHTML = '';
      loadBarrioDetail(data.id);
    } else {
      if (res) res.innerHTML = '<div style="font-size:13px;color:var(--warn)">Barrio QR not found</div>';
    }
  } catch {
    if (res) res.innerHTML = '<div style="font-size:13px;color:var(--warn)">Lookup failed</div>';
  }
}

async function loadBarrioDetail(barrio_id) {
  const detail = _panel.querySelector('#fr-barrio-detail');
  detail.innerHTML = '<div style="font-size:13px;color:var(--text3);padding:.5rem 0">Loading…</div>';

  try {
    const data = await get(`/groups/${barrio_id}/cubes`);
    renderBarrioDetail(data, detail);
  } catch (e) {
    detail.innerHTML = `<div style="font-size:13px;color:var(--warn)">Failed to load barrio details</div>`;
  }
}

function renderBarrioDetail(data, container) {
  const { barrio, group, cubes, credits_available, credits_purchased, credits_used, active_request } = data;
  const maxRequest = Math.min(cubes.length, credits_available);

  if (active_request) {
    container.innerHTML = `
      <div class="card" style="padding:1rem 1.25rem">
        <div style="font-size:15px;font-weight:bold;color:var(--text);margin-bottom:.5rem">${escHtml(barrio.name)}</div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:.75rem">
          Active fill request: <b>${active_request.fills_requested - active_request.fills_completed} fill${(active_request.fills_requested - active_request.fills_completed) !== 1 ? 's' : ''} pending</b>
          (${active_request.fills_completed}/${active_request.fills_requested} completed)
        </div>
        <div style="display:flex;gap:.5rem">
          <button class="btn secondary sm" id="fr-cancel-req-btn" data-id="${active_request.id}">Cancel request</button>
        </div>
      </div>
    `;
    container.querySelector('#fr-cancel-req-btn').onclick = async () => {
      try {
        await del('/fill-requests/' + active_request.id);
        showResult('Fill request cancelled.', false);
        loadBarrioDetail(barrio.id);
      } catch {
        showResult('Failed to cancel request.', true);
      }
    };
    return;
  }

  if (credits_available <= 0) {
    container.innerHTML = `
      <div class="card" style="padding:1rem 1.25rem">
        <div style="font-size:15px;font-weight:bold;color:var(--text);margin-bottom:.25rem">${escHtml(barrio.name)}</div>
        <div style="font-size:13px;color:var(--warn);margin-bottom:.5rem">No fill credits remaining</div>
        <div style="font-size:12px;color:var(--text3)">${cubes.length} cube${cubes.length !== 1 ? 's' : ''} assigned — ${credits_used} fills used of ${credits_purchased} total</div>
      </div>
    `;
    return;
  }

  const cubeListHtml = cubes.length ? cubes.map(c => `
    <div style="font-size:12px;color:var(--text3);padding:2px 0">
      ${escHtml(c.cube_label)}
      ${c.route_position !== null ? ` · stop #${c.route_position}` : ''}
      ${c.last_filled_at ? ` · last filled ${formatDate(c.last_filled_at)}` : ''}
    </div>
  `).join('') : '<div style="font-size:12px;color:var(--text3)">No cubes checked out</div>';

  container.innerHTML = `
    <div class="card" style="padding:1rem 1.25rem">
      <div style="font-size:15px;font-weight:bold;color:var(--text);margin-bottom:.25rem">${escHtml(barrio.name)}</div>
      <div style="font-size:12px;color:var(--text3);margin-bottom:.75rem">
        ${credits_available} fill credit${credits_available !== 1 ? 's' : ''} available
        · ${cubes.length} cube${cubes.length !== 1 ? 's' : ''}
      </div>
      <div style="margin-bottom:.75rem">${cubeListHtml}</div>
      <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:.75rem">
        <label style="font-size:13px;color:var(--text2)">Fills to request:</label>
        <input type="number" id="fr-fills-input" value="${Math.min(1, maxRequest)}"
          min="1" max="${maxRequest}"
          style="width:60px;padding:6px 8px;font-family:Georgia,serif;font-size:14px;
                 border:0.5px solid var(--border-med);border-radius:var(--radius);
                 background:var(--surface);color:var(--text);text-align:center">
        <span style="font-size:12px;color:var(--text3)">of ${maxRequest} max</span>
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text2);margin-bottom:.75rem">
        <input type="checkbox" id="fr-physical-voucher" style="width:auto;margin:0;accent-color:var(--accent)">
        Redeemed physical voucher (offline fallback)
      </label>
      <button class="btn" id="fr-submit-barrio-btn" data-barrio-id="${barrio.id}">
        Request fills
      </button>
    </div>
  `;

  container.querySelector('#fr-submit-barrio-btn').onclick = async (e) => {
    const fills_requested = parseInt(_panel.querySelector('#fr-fills-input')?.value ?? '1', 10);
    const via_physical_voucher = !!_panel.querySelector('#fr-physical-voucher')?.checked;
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Requesting…';
    try {
      await post('/fill-requests', { entity_id: barrio.id, fills_requested, via_physical_voucher });
      showResult(`Fill request created: ${fills_requested} fill${fills_requested !== 1 ? 's' : ''} for ${barrio.name}.`);
      loadBarrioDetail(barrio.id);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Request fills';
      showResult(err?.message || 'Request failed', true);
    }
  };
}

// ── Cube (NWP) section ────────────────────────────────────────────────────────

function showCubeSection() {
  const sect    = _panel.querySelector('#fr-cube-section');
  const barSect = _panel.querySelector('#fr-barrio-section');
  stopScanner();
  barSect.style.display = 'none';
  sect.style.display = '';

  sect.innerHTML = `
    <div class="card" style="padding:1rem 1.25rem">
      <div class="card-label" style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--text3);margin-bottom:.75rem">
        Scan cube QR (NWP)
      </div>
      <div id="fr-cube-scan-wrap">
        <button class="btn secondary" id="fr-cube-scan-btn" style="width:100%">Open scanner</button>
      </div>
      <div id="fr-cube-result" style="margin-top:.75rem"></div>
    </div>
  `;

  sect.querySelector('#fr-cube-scan-btn').onclick = () => startCubeScanner(sect);
}

function startCubeScanner(sect) {
  const wrap = sect.querySelector('#fr-cube-scan-wrap');
  wrap.innerHTML = `
    <div style="position:relative;width:100%;aspect-ratio:1;background:#000;border-radius:var(--radius);overflow:hidden;margin-bottom:.5rem">
      <video id="fr-cscan-video" playsinline muted style="width:100%;height:100%;object-fit:cover;display:block"></video>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none">
        <div style="width:58%;aspect-ratio:1;border:2px solid rgba(255,255,255,.7);border-radius:12px"></div>
      </div>
    </div>
    <button class="btn secondary sm" id="fr-cscan-cancel" style="width:100%">Cancel</button>
  `;
  wrap.querySelector('#fr-cscan-cancel').onclick = () => {
    stopScanner();
    wrap.innerHTML = `<button class="btn secondary" id="fr-cube-scan-btn" style="width:100%">Open scanner</button>`;
    wrap.querySelector('#fr-cube-scan-btn').onclick = () => startCubeScanner(sect);
  };

  const video = wrap.querySelector('#fr-cscan-video');
  scanner = new Scanner(video, (qr) => {
    stopScanner();
    loadCubeDetail(qr, sect);
  });
  scanner.start().catch(() => {
    wrap.innerHTML = `<div style="font-size:12px;color:var(--warn)">Camera unavailable</div>`;
  });
}

async function loadCubeDetail(cube_qr, sect) {
  const res = sect.querySelector('#fr-cube-result');
  res.innerHTML = '<div style="font-size:13px;color:var(--text3)">Looking up…</div>';

  try {
    const r    = await fetch(`/api/water/cube-status?qr=${encodeURIComponent(cube_qr)}`);
    const data = await r.json();

    if (data.status === 'not_found') {
      res.innerHTML = '<div style="font-size:13px;color:var(--warn)">QR not found — not a water cube</div>';
      return;
    }

    const { cube_label, entity_name, fill_requested, fills_remaining, credits_remaining, last_filled_at } = data;

    if (fill_requested) {
      res.innerHTML = `
        <div style="background:var(--accent-light);border:0.5px solid var(--accent);border-radius:var(--radius-lg);padding:.85rem 1rem">
          <div style="font-size:14px;font-weight:bold;color:var(--accent-text);margin-bottom:.2rem">${escHtml(cube_label)}</div>
          <div style="font-size:13px;color:var(--text2)">
            Fill already requested for <b>${escHtml(entity_name ?? '—')}</b>
            ${fills_remaining !== null ? ` (${fills_remaining} pending)` : ''}
          </div>
        </div>
        <button class="btn secondary sm" id="fr-scan-another" style="margin-top:.5rem;width:100%">Scan another cube</button>
      `;
    } else if (credits_remaining <= 0) {
      res.innerHTML = `
        <div style="background:var(--warn-bg);border:0.5px solid var(--warn-border);border-radius:var(--radius-lg);padding:.85rem 1rem">
          <div style="font-size:14px;font-weight:bold;color:var(--warn);margin-bottom:.2rem">${escHtml(cube_label)}</div>
          <div style="font-size:13px;color:var(--text2)">No fill credits remaining for ${escHtml(entity_name ?? 'this entity')}</div>
        </div>
        <button class="btn secondary sm" id="fr-scan-another" style="margin-top:.5rem;width:100%">Scan another cube</button>
      `;
    } else {
      res.innerHTML = `
        <div style="background:var(--surface);border:0.5px solid var(--border);border-radius:var(--radius-lg);padding:.85rem 1rem;margin-bottom:.5rem">
          <div style="font-size:14px;font-weight:bold;color:var(--text);margin-bottom:.2rem">${escHtml(cube_label)}</div>
          <div style="font-size:13px;color:var(--text2)">
            ${escHtml(entity_name ?? '—')}
            · ${credits_remaining} credit${credits_remaining !== 1 ? 's' : ''} remaining
            ${last_filled_at ? `· last filled ${formatDate(last_filled_at)}` : ''}
          </div>
        </div>
        <button class="btn" id="fr-request-cube-btn" data-qr="${escAttr(cube_qr)}" style="width:100%">
          Request fill for this cube
        </button>
        <button class="btn secondary sm" id="fr-scan-another" style="margin-top:.5rem;width:100%">Scan another cube</button>
      `;
      res.querySelector('#fr-request-cube-btn').onclick = async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Requesting…';
        try {
          await post('/fill-requests', { cube_qr });
          showResult(`Fill request created for ${cube_label}.`);
          loadCubeDetail(cube_qr, sect);
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Request fill for this cube';
          showResult(err?.message || 'Request failed', true);
        }
      };
    }

    res.querySelector('#fr-scan-another')?.addEventListener('click', () => {
      res.innerHTML = '';
      startCubeScanner(sect);
    });
  } catch {
    res.innerHTML = '<div style="font-size:13px;color:var(--warn)">Lookup failed — check connection</div>';
  }
}

// ── Result banner ─────────────────────────────────────────────────────────────

function showResult(msg, isError = false) {
  const el = _panel.querySelector('#fr-result');
  if (!el) return;
  el.innerHTML = `
    <div style="padding:.75rem 1rem;border-radius:var(--radius-lg);font-size:13px;
      background:${isError ? 'var(--warn-bg)' : 'var(--accent-light)'};
      border:0.5px solid ${isError ? 'var(--warn-border)' : 'var(--accent)'};
      color:${isError ? 'var(--warn)' : 'var(--accent-text)'}">
      ${escHtml(msg)}
    </div>
  `;
  setTimeout(() => { if (el) el.innerHTML = ''; }, 5000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(str) {
  return String(str ?? '').replace(/"/g, '&quot;');
}
