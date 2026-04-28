/**
 * Central API client. Wraps fetch with session credentials, CSRF token,
 * and offline fallback via the offline queue.
 */

import { enqueue as offlineEnqueue } from './offline.js?v=1.0.0';

let _csrfToken = null;

export function setCsrf(token) {
  _csrfToken = token;
}

export async function api(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (_csrfToken && method !== 'GET') headers['X-CSRF-Token'] = _csrfToken;

  const opts = {
    method,
    credentials: 'include',
    headers,
  };
  if (body !== null) opts.body = JSON.stringify(body);

  let resp;
  try {
    resp = await fetch('/api' + path, opts);
  } catch (networkErr) {
    // Offline — queue checkout/checkin for later sync
    if (body && (path === '/checkout' || path === '/checkin')) {
      await offlineEnqueue({ method, path, body });
      return { __offline: true };
    }
    throw networkErr;
  }

  if (resp.status === 401) {
    // Session expired — redirect to login
    window.location.href = '/login.html';
    return;
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function get(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return api('GET', path + (qs ? '?' + qs : ''));
}

export const post   = (path, body) => api('POST',   path, body);
export const put    = (path, body) => api('PUT',    path, body);
export const del    = (path, body) => api('DELETE', path, body);
