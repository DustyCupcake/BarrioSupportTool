/**
 * Admin panel entry point.
 * Handles session check, nav routing, and shared toast.
 */

import { get, setCsrf } from '../api.js?v=1.0.0';
import { initBarrios }   from './barrios.js?v=1.0.0';
import { initEquipment } from './equipment.js?v=1.0.0';
import { initUsers }     from './users.js?v=1.0.0';

let toastTimer = null;

export function toast(msg, duration = 3500) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

async function boot() {
  let user;
  try {
    user = await get('/auth/me');
    setCsrf(user.csrf_token);
  } catch {
    window.location.href = '/login.html';
    return;
  }

  if (user.role !== 'admin') {
    document.body.innerHTML = '<p style="padding:2rem;font-family:sans-serif">Access denied.</p>';
    return;
  }

  const userEl = document.getElementById('admin-username');
  if (userEl) userEl.textContent = user.display_name;

  document.getElementById('admin-logout')?.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    window.location.href = '/login.html';
  });

  // Nav links
  document.querySelectorAll('.admin-nav a[data-section]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      navigate(a.dataset.section);
    });
  });

  // Route from hash
  const section = location.hash.replace('#', '') || 'barrios';
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
    case 'barrios':   initBarrios(content, toast);   break;
    case 'equipment': initEquipment(content, toast); break;
    case 'users':     initUsers(content, toast);     break;
    default:          initBarrios(content, toast);
  }
}

document.addEventListener('DOMContentLoaded', boot);
