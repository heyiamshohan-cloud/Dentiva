/**
 * Local API client.
 *
 * The renderer never talks to Node: everything goes through the loopback HTTP
 * API with the launch token (`x-dentiva-app`, injected into the shell as a meta
 * tag) and the session cookie the server sets. Errors are normalised into
 * `ApiError` so views can show the server's localized message.
 */

/**
 * Translator hook. `main.js` installs the active locale's translator during
 * boot; errors raised before that fall back to the server's developer string.
 * @type {null | ((key: string, params?: Record<string, any>) => string)}
 */
let errorTranslator = null;

/** @param {null | ((key: string, params?: Record<string, any>) => string)} translator */
export function setErrorTranslator(translator) {
  errorTranslator = translator;
}

/**
 * Turn a server error envelope into a message the user can act on.
 * Validation failures carry a `details` list; the first entry has the specific
 * reason (`security.password.tooCommon`) which beats the generic
 * "check the highlighted fields" text.
 * @param {any} error
 * @param {string} fallback
 */
function localisedMessage(error, fallback) {
  if (!errorTranslator) return fallback;
  const details = Array.isArray(error.details) ? error.details : [];
  const detail = details.find((entry) => entry && typeof entry.key === 'string') ?? null;
  const baseKey = typeof error.messageKey === 'string' ? error.messageKey : '';
  const key = baseKey && baseKey !== 'validation.failed' ? baseKey : (detail?.key ?? baseKey);
  if (!key) return fallback;
  const text = errorTranslator(key, { ...(error.params ?? {}), ...(detail?.params ?? {}) });
  return text && text !== key ? text : fallback;
}

/** @returns {string} */
function launchToken() {
  const meta = document.querySelector('meta[name="dentiva-app-token"]');
  return meta ? String(meta.getAttribute('content') ?? '') : '';
}

/**
 * Preview sessions.
 *
 * The token lives in memory only (never in storage) and is cleared when the tab
 * closes or the user signs out. In the desktop application the server never
 * returns a token in a body, so this stays unused.
 * @type {string}
 */
let previewSessionToken = '';

/** @returns {Record<string, string>} */
function sessionHeader() {
  return previewSessionToken ? { 'x-dentiva-session': previewSessionToken } : {};
}

/** @param {any} payload @param {string} path */
function rememberSession(payload, path) {
  if (path === '/api/auth/logout') {
    previewSessionToken = '';
    return;
  }
  if (payload && typeof payload.token === 'string' && payload.token) previewSessionToken = payload.token;
}

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, details?: any, messageKey?: string | null, params?: Record<string, any> }} [options]
   */
  constructor(message, { status = 0, code = 'errors.internal', details = null, messageKey = null, params = {} } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.messageKey = messageKey;
    this.params = params;
  }

  /** Field errors keyed by field name, for inline form messages. */
  fieldErrors() {
    const out = {};
    if (Array.isArray(this.details)) {
      for (const detail of this.details) {
        if (detail && detail.field) out[detail.field] = detail;
      }
    }
    return out;
  }
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: any, query?: Record<string, any>, raw?: boolean, headers?: Record<string,string> }} [options]
 */
export async function request(path, options = {}) {
  const { method = 'GET', body, query, raw = false, headers = {} } = options;
  let url = path;
  if (query && Object.keys(query).length) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item)));
      else params.append(key, String(value));
    }
    const qs = params.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }

  /** @type {Record<string, any>} */
  const init = {
    method,
    headers: { 'x-dentiva-app': launchToken(), ...sessionHeader(), ...headers },
    credentials: 'same-origin',
  };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const response = await fetch(url, init);
  if (raw) return response;

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  // The packaged application keeps its session in an HttpOnly cookie. A browser
  // preview embedded in a page from another origin cannot rely on that cookie
  // (third-party cookie policies), so when the server hands the session token
  // back in the body it is kept for this tab in memory and sent as a header.
  rememberSession(payload, path);
  if (!response.ok) {
    const error = payload && payload.error ? payload.error : {};
    const fallback = error.message || `HTTP ${response.status}`;
    throw new ApiError(localisedMessage(error, fallback), {
      status: response.status,
      code: error.code || 'errors.internal',
      details: error.details ?? null,
      messageKey: error.messageKey ?? null,
      params: error.params ?? {},
    });
  }
  return payload;
}

/**
 * Save a base64 payload (as returned by `/api/reports/export` or
 * `/api/backup/export`) as a real file on disk.
 * @param {string} fileName
 * @param {string} mimeType
 * @param {string} base64
 */
export function saveBase64File(fileName, mimeType, base64) {
  /** @type {any} */
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Export a report through the API and hand the bytes to the browser download.
 * @param {string} key
 * @param {{ from?: string, to?: string, preset?: string }} [range]
 * @returns {Promise<any>}
 */
export async function exportReport(key, range = {}) {
  const payload = await request('/api/reports/export', { query: { key, ...range } });
  saveBase64File(payload?.fileName ?? `dentiva-${key}.csv`, payload?.mimeType ?? 'text/csv;charset=utf-8', payload?.content ?? '');
  return payload;
}

export const api = {
  get: (path, query) => request(path, { query }),
  post: (path, body) => request(path, { method: 'POST', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  del: (path, body) => request(path, { method: 'DELETE', body }),
  upload: (path, formData) => request(path, { method: 'POST', body: formData }),
  raw: (path, options) => request(path, { raw: true, ...options }),
};
