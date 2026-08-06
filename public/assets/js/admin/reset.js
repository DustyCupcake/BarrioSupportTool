import { get, post } from '../api.js?v=1.0.1';

const OPERATIONS = [
    { key: 'release_all',         label: 'Release all equipment',                    desc: 'Clears all holders (dept, group, person) and marks everything available. Full end-of-event wipe.' },
    { key: 'release_barrio',      label: '…group level only',                        desc: 'Clears group and person assignments only. Department assignments are preserved.', indent: true },
    { key: 'reset_barrios',       label: 'Reset group arrival statuses',             desc: 'Sets all arrival-tracking groups back to Expected. Clears arrived/departed timestamps and orientation flags.' },
    { key: 'clear_distributions', label: 'Clear consumable distributions',           desc: 'Resets distributed counts to zero and deletes the distribution event log. Purchased entitlements are preserved.' },
    { key: 'clear_fill_queue',    label: 'Clear water fill queue',                   desc: 'Cancels all pending and in-progress fill requests.' },
    { key: 'clear_item_notes',    label: 'Clear equipment notes',                    desc: 'Removes all free-text notes from equipment items.' },
    { key: 'expire_shifts',       label: 'Expire volunteer shift sessions',          desc: 'Immediately expires all active shift QR sessions.' },
];

export async function initReset(el, toast) {
    let activeEvent = null;
    try {
        const res = await get('/admin/system/active-event');
        activeEvent = res.event;
    } catch { /* non-fatal */ }

    el.innerHTML = `
        <div class="section-header">
            <h2>Reset / New Event</h2>
            <p class="section-desc">
                Creates a new named event and makes it the active event for deployment logging.
                Optionally run clean-up operations at the same time.
            </p>
        </div>

        ${activeEvent ? `
        <div class="reset-active-event">
            <span class="reset-active-label">Current active event</span>
            <strong>${esc(activeEvent.name)}</strong>${activeEvent.event_date ? ` &mdash; ${esc(activeEvent.event_date)}` : ''}
        </div>` : `
        <div class="reset-active-event reset-active-event--none">
            No active event set.
        </div>`}

        <div class="reset-card">
            <div class="reset-section-title">New event</div>
            <div class="form-row">
                <label class="field-label">Event name <span class="required">*</span></label>
                <input type="text" id="reset-event-name" class="field-input" placeholder="e.g. Elsewhere 2027" autocomplete="off">
            </div>
            <div class="form-row">
                <label class="field-label">Event date <span class="optional">(optional)</span></label>
                <input type="date" id="reset-event-date" class="field-input">
            </div>
        </div>

        <div class="reset-card">
            <div class="reset-section-title">Reset operations</div>
            <label class="reset-option reset-option--all">
                <input type="checkbox" id="reset-select-all">
                <div class="reset-option-body">
                    <div class="reset-option-label">Select all operations</div>
                    <div class="reset-option-desc">Tick every operation below at once.</div>
                </div>
            </label>
            ${OPERATIONS.map(op => `
            <label class="reset-option${op.indent ? ' reset-option--indent' : ''}${op.danger ? ' reset-option--danger' : ''}" data-key="${esc(op.key)}">
                <input type="checkbox" class="reset-op-check" data-key="${esc(op.key)}">
                <div class="reset-option-body">
                    <div class="reset-option-label">${esc(op.label)}</div>
                    <div class="reset-option-desc">${esc(op.desc)}</div>
                </div>
            </label>`).join('')}
        </div>

        <div class="reset-card reset-confirm-card">
            <div class="reset-section-title">Confirm</div>
            <p class="reset-confirm-note">Type <strong>RESET</strong> to enable the button.</p>
            <input type="text" id="reset-confirm-input" class="field-input reset-confirm-input" placeholder="RESET" autocomplete="off" spellcheck="false">
            <button id="reset-submit-btn" class="btn danger" disabled>Start New Event</button>
        </div>

        <div id="reset-result" style="display:none" class="reset-result"></div>
    `;

    const nameInput    = el.querySelector('#reset-event-name');
    const dateInput    = el.querySelector('#reset-event-date');
    const selectAll    = el.querySelector('#reset-select-all');
    const opChecks     = el.querySelectorAll('.reset-op-check');
    const confirmInput = el.querySelector('#reset-confirm-input');
    const submitBtn    = el.querySelector('#reset-submit-btn');
    const resultEl     = el.querySelector('#reset-result');

    function updateSubmitState() {
        submitBtn.disabled = !(nameInput.value.trim() !== '' && confirmInput.value === 'RESET');
    }

    // release_all and release_barrio are mutually exclusive
    const releaseAllCheck    = el.querySelector('[data-key="release_all"] input');
    const releaseBarrioCheck = el.querySelector('[data-key="release_barrio"] input');
    releaseAllCheck?.addEventListener('change', () => {
        if (releaseAllCheck.checked) releaseBarrioCheck.checked = false;
    });
    releaseBarrioCheck?.addEventListener('change', () => {
        if (releaseBarrioCheck.checked) releaseAllCheck.checked = false;
    });

    selectAll.addEventListener('change', () => {
        opChecks.forEach(c => { c.checked = selectAll.checked; });
        // Enforce mutual exclusion after select-all
        if (selectAll.checked && releaseBarrioCheck) releaseBarrioCheck.checked = false;
    });

    opChecks.forEach(c => {
        c.addEventListener('change', () => {
            if (!c.checked) selectAll.checked = false;
            else if ([...opChecks].every(x => x.checked)) selectAll.checked = true;
            updateSubmitState();
        });
    });

    nameInput.addEventListener('input', updateSubmitState);
    confirmInput.addEventListener('input', updateSubmitState);

    submitBtn.addEventListener('click', async () => {
        const eventName = nameInput.value.trim();
        if (!eventName) return;

        const operations = {};
        opChecks.forEach(c => { operations[c.dataset.key] = c.checked; });

        submitBtn.disabled    = true;
        submitBtn.textContent = 'Working…';
        resultEl.style.display = 'none';

        try {
            const res = await post('/admin/system/reset', {
                event_name: eventName,
                event_date: dateInput.value || null,
                operations,
            });

            const activeEl = el.querySelector('.reset-active-event');
            if (activeEl) {
                activeEl.className = 'reset-active-event';
                activeEl.innerHTML = `<span class="reset-active-label">Current active event</span>
                    <strong>${esc(res.event.name)}</strong>${res.event.event_date ? ` &mdash; ${esc(res.event.event_date)}` : ''}`;
            }

            const lines = [`Event <strong>${esc(res.event.name)}</strong> is now active.`];
            const c = res.counts ?? {};
            if (c.equipment_released          != null) lines.push(`${c.equipment_released} items released.`);
            if (c.barrios_reset               != null) lines.push(`${c.barrios_reset} groups reset.`);
            if (c.entitlements_cleared        != null) lines.push(`Consumable distributions cleared.`);
            if (c.fill_requests_cleared       != null) lines.push(`${c.fill_requests_cleared} fill requests cleared.`);
            if (c.items_notes_cleared         != null) lines.push(`${c.items_notes_cleared} item notes cleared.`);
            if (c.shifts_expired              != null) lines.push(`${c.shifts_expired} shift sessions expired.`);

            resultEl.innerHTML  = lines.join(' ');
            resultEl.className  = 'reset-result reset-result--ok';
            resultEl.style.display = 'block';

            nameInput.value    = '';
            dateInput.value    = '';
            confirmInput.value = '';
            selectAll.checked  = false;
            opChecks.forEach(c => { c.checked = false; });
            toast('New event started: ' + res.event.name);

        } catch (err) {
            resultEl.innerHTML  = 'Error: ' + esc(err?.message ?? 'unknown error');
            resultEl.className  = 'reset-result reset-result--err';
            resultEl.style.display = 'block';
            toast('Reset failed');
        }

        submitBtn.disabled    = true;
        submitBtn.textContent = 'Start New Event';
    });
}

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
