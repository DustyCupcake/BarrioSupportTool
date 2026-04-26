/**
 * Main entry point for the staff checkout app.
 * Handles session check, tab routing, and toast notifications.
 */

import { get, setCsrf } from './api.js';
import { initOfflineSync } from './offline.js';
import { init as initCheckout } from './checkout.js';
import { init as initCheckin, destroy as destroyCheckin } from './checkin.js';
import { init as initInventory } from './inventory.js';
import { init as initHistory } from './history.js';

let currentTab     = null;
let toastTimer     = null;

export function toast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

async function boot() {
  // Verify session; redirect to login if expired
  let user;
  try {
    user = await get('/auth/me');
    setCsrf(user.csrf_token);
  } catch {
    window.location.href = '/login.html';
    return;
  }

  // Show user info in header
  const userEl = document.getElementById('header-user');
  if (userEl) userEl.textContent = user.display_name;

  const adminLink = document.getElementById('admin-link');
  if (adminLink && user.role === 'admin') adminLink.style.display = '';

  // Init offline sync
  initOfflineSync(toast);

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Tab routing
  const tabs = document.querySelectorAll('nav button[data-tab]');
  tabs.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    window.location.href = '/login.html';
  });

  switchTab('checkout');
}

function switchTab(name) {
  if (currentTab === name) return;

  // Destroy previous tab state
  if (currentTab === 'checkin') destroyCheckin();

  currentTab = name;

  // Update nav
  document.querySelectorAll('nav button[data-tab]').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === name);
  });

  // Hide all panels
  document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');

  const panel = document.getElementById('tab-' + name);
  if (panel) panel.style.display = '';

  switch (name) {
    case 'checkout':  initCheckout(panel);  break;
    case 'checkin':   initCheckin(panel);   break;
    case 'inventory': initInventory(panel); break;
    case 'history':   initHistory(panel);   break;
  }
}

document.addEventListener('DOMContentLoaded', boot);
