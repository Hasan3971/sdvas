// Fetch wrapper: same-origin session cookie, CSRF header for writes, uniform ApiError.

let csrfToken = '';
let unauthorizedHandler = null;

export function setCsrf(token) {
  csrfToken = token || '';
}

export function onUnauthorized(fn) {
  unauthorizedHandler = fn;
}

export class ApiError extends Error {
  constructor(status, code, message, retryAfter = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export const isAbort = (err) => Boolean(err) && err.name === 'AbortError';

export function qs(params) {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [key, val] of Object.entries(params)) {
    if (val === undefined || val === null || val === '' || val === false) continue;
    if (Array.isArray(val)) {
      if (val.length) sp.set(key, val.join(','));
    } else sp.set(key, val === true ? '1' : String(val));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

function fallbackMessage(status, retryAfter) {
  if (status === 429) return `Забагато запитів. Повторіть через ${retryAfter || 'кілька'} с.`;
  if (status === 401) return 'Потрібно увійти знову.';
  if (status === 403) return 'Недостатньо прав для цієї дії.';
  if (status === 404) return 'Не знайдено.';
  if (status === 413) return 'Запит або файл завеликий (максимум 25 МБ).';
  if (status === 503) return 'Пошта тимчасово недоступна. Спробуйте пізніше.';
  if (status >= 500) return 'Внутрішня помилка сервера.';
  return `Помилка запиту (HTTP ${status}).`;
}

export async function request(method, path, { query, body, signal, raw = false, authRedirect = true, retryCsrf = true } = {}) {
  const headers = { Accept: 'application/json' };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = csrfToken;

  let res;
  try {
    res = await fetch(path + qs(query), { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store', signal });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ApiError(0, 'network', 'Немає зв’язку із сервером. Перевірте з’єднання та спробуйте ще раз.');
  }

  if (res.ok) {
    if (raw) return res;
    if (res.status === 204) return null;
    const type = res.headers.get('Content-Type') || '';
    return type.includes('json') ? res.json() : res.text();
  }

  let code = `http_${res.status}`;
  let message = '';
  try {
    const data = await res.json();
    if (data && typeof data.error === 'object' && data.error) {
      code = data.error.code || code;
      message = data.error.message || '';
    } else if (data && typeof data.error === 'string') message = data.error;
  } catch { /* non-JSON error body */ }
  const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10) || 0;

  // The CSRF token rotates with the session (e.g. after a password change in another tab): refresh once.
  if (res.status === 403 && code === 'csrf' && retryCsrf) {
    try {
      const me = await request('GET', '/api/v1/me', { signal });
      setCsrf(me.csrf);
      return request(method, path, { query, body, signal, raw, authRedirect, retryCsrf: false });
    } catch (err) {
      if (isAbort(err)) throw err;
    }
  }

  const error = new ApiError(res.status, code, message || fallbackMessage(res.status, retryAfter), retryAfter);
  if (res.status === 401 && authRedirect && unauthorizedHandler) unauthorizedHandler(error);
  throw error;
}

export const api = {
  get: (path, query, opts) => request('GET', path, { ...opts, query }),
  post: (path, body, opts) => request('POST', path, { ...opts, body }),
  put: (path, body, opts) => request('PUT', path, { ...opts, body }),
  patch: (path, body, opts) => request('PATCH', path, { ...opts, body }),
  del: (path, opts) => request('DELETE', path, opts),
};

export const mbPath = (email, suffix = '') => `/api/v1/mailboxes/${encodeURIComponent(email)}${suffix}`;

/** Fetches a file (GET with query or POST with JSON) and saves it through a temporary object URL. */
export async function download(method, path, { query, body, signal, fallbackName = 'export.txt' } = {}) {
  const res = await request(method, path, { query, body, signal, raw: true });
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const name = match ? match[1] : fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { name, size: blob.size };
}
