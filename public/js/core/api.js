// 前端 API 客户端：统一 auth、错误 envelope、AbortSignal 与下载。
import { parseApiError } from './api-error.js';

export const authEvents = new EventTarget();

export function getToken(){
  return localStorage.getItem('ekh_token') || '';
}

export function setToken(token){
  if (token) localStorage.setItem('ekh_token', token);
  else localStorage.removeItem('ekh_token');
}

function buildBody(opts, headers){
  if (opts.body == null) return undefined;
  if (opts.body instanceof FormData) return opts.body;
  if (opts.body instanceof Blob) return opts.body;
  headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  return JSON.stringify(opts.body);
}

export async function request(path, opts = {}){
  const headers = { ...(opts.headers || {}) };
  const token = opts.token === undefined ? getToken() : opts.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  const body = buildBody(opts, headers);
  const res = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    headers,
    body,
    signal: opts.signal,
  });
  if (res.status === 401 && !String(path).startsWith('/auth/')){
    authEvents.dispatchEvent(new CustomEvent('expired'));
  }
  const text = await res.text();
  let data = null;
  if (text){
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok){
    throw parseApiError(res.status, data, res.headers.get('Retry-After'));
  }
  return data;
}

export const api = {
  request,
  get: (path, opts = {}) => request(path, opts),
  post: (path, body, opts = {}) => request(path, { ...opts, method: 'POST', body }),
  patch: (path, body, opts = {}) => request(path, { ...opts, method: 'PATCH', body }),
  put: (path, body, opts = {}) => request(path, { ...opts, method: 'PUT', body }),
  del: (path, opts = {}) => request(path, { ...opts, method: 'DELETE' }),
  upload: (path, formData, opts = {}) => request(path, { ...opts, method: 'POST', body: formData }),
};

export async function fetchBlob(path, opts = {}){
  const headers = { ...(opts.headers || {}) };
  const token = opts.token === undefined ? getToken() : opts.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, { headers, signal: opts.signal });
  if (!res.ok){
    let data = null;
    try { data = await res.json(); } catch {}
    throw parseApiError(res.status, data, res.headers.get('Retry-After'));
  }
  return res.blob();
}

export async function downloadUrl(path, filename, opts = {}){
  const blob = await fetchBlob(path, opts);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename || 'download';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function apiErrorMessage(error){
  return error?.message || '请求失败';
}
