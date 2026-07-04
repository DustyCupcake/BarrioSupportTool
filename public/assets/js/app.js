import { get, post, setCsrf } from './api.js?v=1.0.1';
import { initOfflineSync } from './offline.js?v=1.0.0';
import { init as initCheckout } from './checkout.js?v=1.0.4';
import { init as initCheckin, destroy as destroyCheckin } from './checkin.js?v=1.0.2';
import { init as initBarrios, destroy as destroyBarrios } from './barrios.js?v=1.0.2';
import { init as initInventory } from './inventory.js?v=1.0.0';
import { init as initHistory } from './history.js?v=1.0.0';
import { init as initValidate, destroy as destroyValidate } from './validate.js?v=1.0.1';
import { init as initOrders } from './order-form.js?v=1.0.1';
import { init as initHome } from './home.js?v=1.0.1';
import { init as initScanner, destroy as destroyScanner, getSession } from './unified-scanner.js?v=1.0.4';
import { initLang, applyTranslations, renderSwitcher, onLangChange, setLang, getLang } from './i18n.js?v=1.0.1';
import { init as initAccount } from './account.js?v=1.0.1';
import { init as initFillRequests, destroy as destroyFillRequests } from './fill-requests.js?v=1.0.0';

// Pending identity action — stored while the identity prompt is shown
let _pendingIdentityAction = null;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js?v=1.0.0').catch(() => {});
}

initLang();

let currentTab   = null;
let toastTimer   = null;
let _currentUser = null;

export function getCurrentUser() { return _currentUser; }

export function toast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

async function boot() {
  applyTranslations();
  renderSwitcher(document.getElementById('lang-switcher-menu'));

  onLangChange(() => {
    applyTranslations();
    rerenderCurrentTab();
    if (_currentUser) post('/auth/language', { lang: getLang() }).catch(() => {});
  });

  let user = null;
  try {
    // Use raw fetch so a 401 (not logged in) doesn't auto-redirect via api.js — guest mode is allowed
    const meResp = await fetch('/api/auth/me', { credentials: 'include' });
    if (meResp.ok) {
      user = await meResp.json();
      setCsrf(user.csrf_token);
      try { localStorage.setItem('barrio_user', JSON.stringify(user)); } catch {}
    }
  } catch {
    // Network error — try offline cache
    if (!navigator.onLine) {
      try {
        const cached = localStorage.getItem('barrio_user');
        if (cached) user = JSON.parse(cached);
      } catch {}
    }
  }

  _currentUser = user;
  if (user?.language) setLang(user.language);

  const perms = user?.permissions || [];

  // Validator-only mode: unchanged
  const isValidatorOnly = user && (user.role === 'validator' || user.is_shift) &&
    perms.includes('validate_vouchers') &&
    !perms.includes('checkout_equipment') &&
    !perms.includes('sub_checkout');
  if (isValidatorOnly) {
    bootValidator();
    return;
  }

  if (user) {
    initAccount(user);
  } else {
    // Guest mode: hide account button, show sign-in link
    const userBtn = document.getElementById('header-user-btn');
    if (userBtn) userBtn.style.display = 'none';
    const hamburger = document.getElementById('hamburger-btn');
    if (hamburger) hamburger.style.display = 'none';
    const signinLink = document.getElementById('header-signin-link');
    if (signinLink) signinLink.style.display = '';
  }

  // Set up identity prompt modal close
  document.getElementById('identity-modal-close')?.addEventListener('click', hideIdentityPrompt);
  document.getElementById('identity-modal-backdrop')?.addEventListener('click', hideIdentityPrompt);
  document.getElementById('identity-signin-btn')?.addEventListener('click', () => {
    hideIdentityPrompt();
    window.location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search);
  });
  document.getElementById('identity-badge-btn')?.addEventListener('click', () => {
    hideIdentityPrompt();
    switchTab('scanner', { identityMode: true });
  });

  // Side menu user label
  const menuUser = document.getElementById('side-menu-user');
  if (menuUser) menuUser.textContent = user?.display_name || 'Guest';

  // Show/hide side-menu items based on permissions
  configureSideMenu(perms);

  // Back bar
  document.getElementById('back-home-btn')?.addEventListener('click', () => switchTab('home'));

  // Hamburger
  const hamburger  = document.getElementById('hamburger-btn');
  const backdrop   = document.getElementById('menu-backdrop');
  const sideMenu   = document.getElementById('side-menu');
  const closeMenu  = () => { backdrop.classList.remove('open'); sideMenu.classList.remove('open'); };
  hamburger?.addEventListener('click', () => { backdrop.classList.add('open'); sideMenu.classList.add('open'); });
  backdrop?.addEventListener('click', closeMenu);

  document.querySelectorAll('.side-menu-item[data-menu]').forEach(btn => {
    btn.addEventListener('click', () => { closeMenu(); switchTab(btn.dataset.menu); });
  });

  document.getElementById('menu-logout-btn')?.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    window.location.href = '/';
  });

  initOfflineSync(toast);

  // Session banner (unified scanner progress)
  document.getElementById('session-banner')?.addEventListener('click', () => switchTab('scanner'));

  // Handle deep-link params
  const params   = new URLSearchParams(location.search);
  const barrioId = params.get('barrio') || null;
  const personQr = params.get('person') || null;
  const scanQr   = params.get('scan')   || null;

  const tabParam = params.get('tab');

  if (personQr) {
    get('/person-info', { qr: personQr }).then(data => {
      if (data?.person) {
        window._pendingPersonQr = personQr;
        window._pendingPerson   = data.person;
      }
      switchTab('scanner', { preload: { type: 'person', qr: personQr } });
    }).catch(() => switchTab('scanner'));
  } else if (barrioId) {
    // Legacy barrio deep-link: pass directly into scanner as a barrio entity
    switchTab('scanner', { entity: { type: 'barrio', id: +barrioId } });
  } else if (scanQr) {
    switchTab('scanner', { preload: { qr: scanQr } });
  } else if (tabParam) {
    switchTab(tabParam);
  } else {
    switchTab('home');
  }
}

function configureSideMenu(perms) {
  const show = (id, cond) => {
    const el = document.getElementById(id) || document.querySelector(`[data-menu="${id}"]`);
    if (el) el.style.display = cond ? '' : 'none';
  };
  document.querySelector('[data-menu="barrios"]')?.style &&
    (document.querySelector('[data-menu="barrios"]').style.display =
      perms.includes('view_barrios') ? '' : 'none');
  document.querySelector('[data-menu="orders"]')?.style &&
    (document.querySelector('[data-menu="orders"]').style.display =
      (perms.includes('submit_orders') || perms.includes('manage_orders')) ? '' : 'none');

  document.querySelector('[data-menu="fill-requests"]')?.style &&
    (document.querySelector('[data-menu="fill-requests"]').style.display =
      perms.includes('request_fills') ? '' : 'none');

  const adminLink = document.getElementById('menu-admin-link');
  if (adminLink) {
    adminLink.style.display = (perms.includes('manage_departments') || perms.includes('manage_dept_users'))
      ? '' : 'none';
  }
}

function bootValidator() {
  document.querySelector('header')?.querySelectorAll('nav, #back-bar').forEach(el => el.style.display = 'none');

  document.getElementById('menu-logout-btn')?.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    window.location.href = '/';
  });

  document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
  const panel = document.getElementById('tab-validate');
  if (panel) {
    panel.style.display = '';
    currentTab = 'validate';
    initValidate(panel, true);
  }
}

function rerenderCurrentTab() {
  if (!currentTab) return;
  if (currentTab === 'checkin')       destroyCheckin();
  if (currentTab === 'barrios')       destroyBarrios();
  if (currentTab === 'validate')      destroyValidate();
  if (currentTab === 'scanner')       destroyScanner();
  if (currentTab === 'fill-requests') destroyFillRequests();

  const panel = document.getElementById('tab-' + currentTab);
  if (!panel) return;

  switch (currentTab) {
    case 'home':          initHome(panel, _currentUser);        break;
    case 'scanner':       initScanner(panel, _currentUser, { onTabSwitch: switchTab, toast, requireIdentityFn: requireIdentity, onIdentityResolvedFn: onIdentityResolved }); break;
    case 'checkout':      initCheckout(panel, null);            break;
    case 'checkin':       initCheckin(panel);                   break;
    case 'barrios':       initBarrios(panel, null);             break;
    case 'inventory':     initInventory(panel);                 break;
    case 'history':       initHistory(panel);                   break;
    case 'orders':        initOrders(panel);                    break;
    case 'validate':      initValidate(panel, true);            break;
    case 'fill-requests': initFillRequests(panel, _currentUser); break;
  }
}

export function switchTab(name, extra = null) {
  if (currentTab === name && !extra) return;

  if (currentTab === 'checkin')       destroyCheckin();
  if (currentTab === 'barrios')       destroyBarrios();
  if (currentTab === 'validate')      destroyValidate();
  if (currentTab === 'scanner')       destroyScanner();
  if (currentTab === 'fill-requests') destroyFillRequests();

  currentTab = name;

  // Back bar: visible on every tab except home and validate
  const backBar = document.getElementById('back-bar');
  if (backBar) backBar.classList.toggle('visible', name !== 'home' && name !== 'validate');

  document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
  const panel = document.getElementById('tab-' + name);
  if (panel) panel.style.display = '';

  switch (name) {
    case 'home':          initHome(panel, _currentUser);        break;
    case 'scanner':       initScanner(panel, _currentUser, { extra, onTabSwitch: switchTab, toast, updateBannerFn: refreshSessionBanner, requireIdentityFn: requireIdentity, onIdentityResolvedFn: onIdentityResolved }); break;
    case 'checkout':      initCheckout(panel, extra);           break;
    case 'checkin':       initCheckin(panel);                   break;
    case 'barrios':       initBarrios(panel, extra);            break;
    case 'inventory':     initInventory(panel);                 break;
    case 'history':       initHistory(panel);                   break;
    case 'orders':        initOrders(panel);                    break;
    case 'validate':      initValidate(panel, true);            break;
    case 'fill-requests': initFillRequests(panel, _currentUser); break;
  }
}

export function refreshSessionBanner() {
  const banner  = document.getElementById('session-banner');
  if (!banner) return;
  const session = getSession();
  if (!session || (session.items.length === 0 && !session.entity)) {
    banner.style.display = 'none';
    return;
  }
  const entityLabel = session.entity ? session.entity.name : null;
  const itemCount   = session.items.length;
  const label = entityLabel
    ? `Lending to ${entityLabel} · ${itemCount} item${itemCount !== 1 ? 's' : ''}`
    : `${itemCount} item${itemCount !== 1 ? 's' : ''} · no recipient yet`;

  banner.style.display = '';
  banner.innerHTML = `
    <div class="session-banner" id="session-banner-inner">
      <span class="session-banner-label">${label}</span>
      <button class="session-banner-done" id="session-done-btn">Done →</button>
    </div>`;

  banner.querySelector('#session-done-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    switchTab('scanner', { mode: 'confirm' });
  });
}

// ─── Identity prompt ─────────────────────────────────────────────────────────
// Call this to gate an action behind authentication.
// If already authenticated, calls action() immediately.
// If not, shows the identity modal; action is called after successful sign-in/claim.
export function requireIdentity(action) {
  if (_currentUser) {
    action();
  } else {
    _pendingIdentityAction = action;
    showIdentityPrompt();
  }
}

export function showIdentityPrompt(message) {
  const modal = document.getElementById('identity-modal');
  if (!modal) return;
  if (message) {
    const msgEl = document.getElementById('identity-modal-message');
    if (msgEl) msgEl.textContent = message;
  }
  modal.style.display = '';
  document.getElementById('identity-modal-backdrop').style.display = '';
}

export function hideIdentityPrompt() {
  document.getElementById('identity-modal')?.style && (document.getElementById('identity-modal').style.display = 'none');
  document.getElementById('identity-modal-backdrop')?.style && (document.getElementById('identity-modal-backdrop').style.display = 'none');
}

// Called by scanner after a badge scan succeeds during identityMode
export function onIdentityResolved(user) {
  _currentUser = user;
  setCsrf(user.csrf_token);
  // Update header to show user name
  const userBtn = document.getElementById('header-user-btn');
  if (userBtn) { userBtn.textContent = user.display_name; userBtn.style.display = ''; }
  const signinLink = document.getElementById('header-signin-link');
  if (signinLink) signinLink.style.display = 'none';

  hideIdentityPrompt();

  if (_pendingIdentityAction) {
    const action = _pendingIdentityAction;
    _pendingIdentityAction = null;
    action();
  } else {
    switchTab('home');
  }
}

document.addEventListener('DOMContentLoaded', boot);
