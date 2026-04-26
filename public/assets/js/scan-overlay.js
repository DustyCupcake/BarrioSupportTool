/**
 * Full-screen confirmation overlay shown after each QR scan result.
 * Usage: import { scanOverlay } from './scan-overlay.js'
 */

class ScanOverlay {
  constructor() {
    this._el = null;
    this._primaryAction = null;
  }

  _mount() {
    if (this._el) return;
    this._el = document.createElement('div');
    this._el.id = 'scan-overlay-full';
    this._el.addEventListener('click', (e) => {
      if (e.target === this._el && this._primaryAction) {
        this._primaryAction();
      }
    });
    document.body.appendChild(this._el);
  }

  // state: 'success' | 'warning' | 'error'
  // buttons: [{ label, action }] — first is primary, last is ghost/undo
  show({ state, title, subtitle, buttons }) {
    this._mount();
    this._primaryAction = buttons[0]?.action ?? null;

    this._el.className = `sof sof-${state} sof-open`;
    this._el.innerHTML = `
      <div class="sof-body">
        <div class="sof-title">${_esc(title)}</div>
        ${subtitle ? `<div class="sof-subtitle">${_esc(subtitle)}</div>` : ''}
      </div>
      <div class="sof-buttons">
        ${buttons.map((b, i) => {
          const cls = i === 0 ? 'sof-btn-primary'
            : i === buttons.length - 1 && buttons.length > 1 ? 'sof-btn-ghost'
            : 'sof-btn-secondary';
          return `<button class="sof-btn ${cls}" data-idx="${i}">${_esc(b.label)}</button>`;
        }).join('')}
      </div>
    `;

    buttons.forEach((b, i) => {
      this._el.querySelector(`[data-idx="${i}"]`).addEventListener('click', (e) => {
        e.stopPropagation();
        b.action();
      });
    });
  }

  showManualEntry({ placeholder, onSubmit, onCancel }) {
    this._mount();
    this._primaryAction = onCancel;

    this._el.className = 'sof sof-manual sof-open';
    this._el.innerHTML = `
      <div class="sof-manual-card">
        <div class="sof-manual-title">Enter manually</div>
        <input class="sof-manual-input" type="text"
          placeholder="${_esc(placeholder)}"
          autocomplete="off" autocorrect="off" spellcheck="false">
        <div class="sof-manual-actions">
          <button class="sof-btn sof-btn-manual-primary" id="sof-submit">Submit</button>
          <button class="sof-btn sof-btn-ghost-dark" id="sof-cancel">Cancel</button>
        </div>
      </div>
    `;

    const input = this._el.querySelector('.sof-manual-input');
    const doSubmit = () => { const v = input.value.trim(); if (v) onSubmit(v); };

    this._el.querySelector('#sof-submit').addEventListener('click', (e) => { e.stopPropagation(); doSubmit(); });
    this._el.querySelector('#sof-cancel').addEventListener('click', (e) => { e.stopPropagation(); onCancel(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSubmit(); });

    setTimeout(() => input.focus(), 60);
  }

  hide() {
    if (!this._el) return;
    this._el.className = 'sof';
    this._primaryAction = null;
  }
}

function _esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const scanOverlay = new ScanOverlay();
