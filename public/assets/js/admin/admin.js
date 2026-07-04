/**
 * Admin panel entry point.
 * Handles session check, nav routing, and shared toast.
 */

import { get, setCsrf }          from '../api.js?v=1.0.1';
import { initBarrios }           from './barrios.js?v=1.0.1';
import { initArtists }           from './artists.js?v=1.0.0';
import { initEquipment }         from './equipment.js?v=1.0.3';
import { initUsers }             from './users.js?v=1.1.0';
import { initTeams }             from './teams.js?v=1.1.0';
import { initShifts }            from './shifts.js?v=1.0.1';
import { initConsumables }       from './consumables.js?v=1.0.0';
import { initOrders }            from './orders.js?v=1.0.0';
import { initStorageLocations }  from './storage_locations.js?v=1.0.0';
import { initPersonTokens }      from './person_tokens.js?v=1.0.0';
import { initFillRoute }         from './fill_route.js?v=1.3.0';
import { initSiteMap }           from './site_map.js?v=1.0.1';
import { initPrintTemplates }   from './print_templates.js?v=1.0.4';
import { initReset }            from './reset.js?v=1.0.0';

let toastTimer = null;
let _user      = null;
let _perms     = [];

// Sections and the permission required to see them (any match → show)
const SECTION_PERMS = {
  barrios:            ['manage_barrios'],
  artists:            ['manage_artists'],
  equipment:          ['manage_equipment'],
  users:              ['manage_users', 'manage_dept_users'],
  teams:              ['manage_departments'],
  shifts:             ['manage_shifts'],
  consumables:        ['manage_consumables'],
  orders:             ['manage_orders'],
  'storage-locations': ['manage_equipment'],
  'person-badges':     ['manage_users'],
  'fill-route':        ['manage_barrios', 'manage_equipment'],
  'site-map':          ['manage_barrios', 'manage_equipment'],
  'print-templates':   ['manage_equipment'],
  'reset':             ['manage_equipment', 'manage_barrios'],
};

export function toast(msg, duration = 3500) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

async function boot() {
  try {
    _user = await get('/auth/me');
    setCsrf(_user.csrf_token);
  } catch {
    window.location.href = '/login.html';
    return;
  }

  _perms = _user.permissions || [];

  const hasAdminAccess = Object.values(SECTION_PERMS)
    .flat()
    .some(p => _perms.includes(p));

  if (!hasAdminAccess) {
    document.body.innerHTML = '<p style="padding:2rem;font-family:sans-serif">Access denied.</p>';
    return;
  }

  const userEl = document.getElementById('admin-username');
  if (userEl) userEl.textContent = _user.display_name;

  document.getElementById('admin-logout')?.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    window.location.href = '/login.html';
  });

  // Hide nav links the user can't access
  document.querySelectorAll('.admin-nav a[data-section]').forEach(a => {
    const required = SECTION_PERMS[a.dataset.section] ?? [];
    const allowed  = required.length === 0 || required.some(p => _perms.includes(p));
    if (!allowed) a.style.display = 'none';
  });

  // Mobile hamburger
  const sidebar   = document.getElementById('admin-sidebar');
  const backdrop  = document.getElementById('admin-mobile-backdrop');
  const hamburger = document.getElementById('admin-hamburger-btn');

  function openSidebar()  { sidebar?.classList.add('open'); backdrop?.classList.add('open'); }
  function closeSidebar() { sidebar?.classList.remove('open'); backdrop?.classList.remove('open'); }

  hamburger?.addEventListener('click', openSidebar);
  backdrop?.addEventListener('click', closeSidebar);

  // Nav link clicks
  document.querySelectorAll('.admin-nav a[data-section]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      closeSidebar();
      navigate(a.dataset.section);
    });
  });

  // Default to first section this user can access
  const defaultSection = Object.keys(SECTION_PERMS)
    .find(s => (SECTION_PERMS[s] ?? []).some(p => _perms.includes(p))) ?? 'barrios';
  const section = location.hash.replace('#', '') || defaultSection;
  navigate(section);
}

function navigate(section) {
  location.hash = section;
  document.querySelectorAll('.admin-nav a').forEach(a => {
    a.classList.toggle('active', a.dataset.section === section);
  });

  const content = document.getElementById('admin-content');
  if (!content) return;

  switch (section) {
    case 'barrios':            initBarrios(content, toast);             break;
    case 'artists':            initArtists(content, toast, _user);      break;
    case 'equipment':          initEquipment(content, toast);           break;
    case 'users':              initUsers(content, toast, _user);        break;
    case 'teams':              initTeams(content, toast);               break;
    case 'shifts':             initShifts(content, toast, _user);       break;
    case 'consumables':        initConsumables(content, toast);         break;
    case 'orders':             initOrders(content, toast);              break;
    case 'storage-locations':  initStorageLocations(content, toast);    break;
    case 'person-badges':      initPersonTokens(content, toast);        break;
    case 'fill-route':         initFillRoute(content, toast);           break;
    case 'site-map':           initSiteMap(content, toast);             break;
    case 'print-templates':    initPrintTemplates(content, toast);      break;
    case 'reset':              initReset(content, toast);               break;
    default:            navigate(
      Object.keys(SECTION_PERMS).find(s => SECTION_PERMS[s].some(p => _perms.includes(p))) ?? 'barrios'
    );
  }
}

document.addEventListener('DOMContentLoaded', boot);
