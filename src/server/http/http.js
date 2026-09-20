/**
 * Tiny HTTP toolkit for the local API.
 *
 * The app talks to itself over a loopback HTTP server (no Electron, no remote
 * calls). Everything here is deliberately dependency-free and strict: sized
 * bodies, JSON in / JSON out, typed error mapping, and cookie helpers that only
 * ever set `HttpOnly` + `SameSite=Strict` cookies.
 */
import { AppError, ValidationError } from '../../shared/errors.js';

export const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

export function json(data, init = {}) {
  const status = init.status ?? 200;
  const headers = new Headers(init.headers ?? {});
  for (const [key, value] of Object.entries(JSON_HEADERS)) headers.set(key, value);
  return new Response(JSON.stringify(data ?? null), { status, headers });
}

export function noContent(init = {}) {
  return new Response(null, { status: 204, headers: init.headers ?? {} });
}

export function text(body, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8');
  return new Response(body, { status: init.status ?? 200, headers });
}

export function html(body, init = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(body, { status: init.status ?? 200, headers });
}

/** Read a JSON body, guarding against oversized or malformed payloads. */
export async function readJson(request, { limitBytes = 4 * 1024 * 1024 } = {}) {
  const declared = Number(request.headers.get('content-length') ?? 0);
  const tooLarge = () => new AppError('errors.payloadTooLarge', { code: 'payload_too_large', status: 413, messageKey: 'errors.payloadTooLarge' });
  if (declared && declared > limitBytes) throw tooLarge();
  const raw = await request.text();
  if (raw.length > limitBytes) throw tooLarge();
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch {
    throw new ValidationError('errors.invalidJson', [{ field: 'body', key: 'errors.invalidJson' }]);
  }
}

/** Read a multipart body with a hard cap (attachments go through this). */
export async function readMultipart(request, { limitBytes = 64 * 1024 * 1024 } = {}) {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared && declared > limitBytes) {
    throw new AppError('files.tooLarge', { code: 'file_error', status: 413, messageKey: 'files.tooLarge' });
  }
  return request.formData();
}

export function parseCookies(request) {
  const header = request.headers.get('cookie');
  /** @type {Record<string,string>} */
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

/**
 * Build the session cookie.
 *
 * The default — `SameSite=Strict`, no `Secure` — is what the desktop application
 * uses: the window talks to its own loopback server, so a strict cookie can never
 * be sent anywhere else. `sameSite: 'None'` with `secure: true` exists only for
 * the development browser preview, where the application is embedded in a page
 * served from another origin (`bun run preview`, see docs/ARCHITECTURE.md).
 *
 * @param {string} token
 * @param {{ maxAgeSeconds?: number, secure?: boolean, sameSite?: 'Strict'|'Lax'|'None' }} [options]
 */
export function sessionCookie(token, { maxAgeSeconds = 12 * 3600, secure = false, sameSite = 'Strict' } = {}) {
  const parts = [
    `dentiva_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${sameSite}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  // A cookie with SameSite=None is rejected by browsers unless it is Secure.
  if (secure || sameSite === 'None') parts.push('Secure');
  return parts.join('; ');
}

/** @param {string} [name] @param {{ sameSite?: string }} [options] */
export function clearCookie(name = 'dentiva_session', { sameSite = 'Strict' } = {}) {
  return `${name}=; Path=/; HttpOnly; SameSite=${sameSite}${sameSite === 'None' ? '; Secure' : ''}; Max-Age=0`;
}

/**
 * Build a `Content-Disposition` value for a download.
 *
 * HTTP header values are bytes, not text, so a clinic file named
 * `রোগীর_এক্সরে.png` cannot go into one directly — the fetch/Bun header parser
 * rejects it and the download fails with a 500. RFC 6266 defines the fix and it
 * is used here: an ASCII-only `filename` fallback every client understands, plus
 * `filename*=UTF-8''…` carrying the real name, which browsers prefer.
 *
 * @param {'inline'|'attachment'} kind
 * @param {string} name
 */
export function contentDisposition(kind, name) {
  const cleaned = String(name ?? '').replace(/["\\\u0000-\u001f\u007f]/g, '').trim();
  // Latin-1 is what a header may hold; anything else becomes a placeholder in
  // the fallback and survives in the RFC 5987 parameter.
  const ascii = cleaned
    .replace(/[^\u0020-\u007e]/g, '_')
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  const fallback = ascii && /[A-Za-z0-9]/.test(ascii) ? ascii : 'attachment';
  const encoded = encodeURIComponent(cleaned)
    .replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .slice(0, 600);
  const plain = `${kind}; filename="${fallback}"`;
  return encoded && encoded !== fallback ? `${plain}; filename*=UTF-8''${encoded}` : plain;
}

/** Convert anything thrown by a service into a stable JSON error envelope. */
export function errorResponse(error, { log = true } = {}) {
  if (error instanceof AppError) {
    const body = {
      error: {
        code: error.code,
        message: error.message,
        // The renderer translates `messageKey`; `message` is the developer
        // string and is only shown when no translation is available.
        messageKey: error.messageKey ?? 'errors.generic',
        params: error.params ?? {},
        status: error.status ?? 400,
        details: error.details ?? null,
      },
    };
    return json(body, { status: error.status ?? 400 });
  }
  if (log) console.error('[dentiva] unhandled error:', error);
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: { code: 'errors.internal', message, status: 500, details: null } }, { status: 500 });
}

/**
 * Match a pathname against a `:param` style pattern.
 * @returns {Record<string,string>|null}
 */
export function matchPath(pattern, pathname) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  /** @type {Record<string,string>} */
  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    const pathPart = pathParts[index];
    if (patternPart.startsWith(':')) {
      params[patternPart.slice(1)] = decodeURIComponent(pathPart);
      continue;
    }
    if (patternPart !== pathPart) return null;
  }
  return params;
}

/**
 * Ordered route table.
 * @typedef {{ method: string|string[], path: string, handler: Function, permission?: string|null, description?: string }} Route
 */
export class Router {
  /** @param {Route[]} routes */
  constructor(routes) {
    this.routes = routes;
  }

  match(method, pathname) {
    for (const route of this.routes) {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      if (!methods.includes(method)) continue;
      const params = matchPath(route.path, pathname);
      if (params) return { route, params };
    }
    return null;
  }

  /** Public description of every endpoint (used by the About → diagnostics panel). */
  describe() {
    return this.routes.map((route) => ({
      method: Array.isArray(route.method) ? route.method.join('|') : route.method,
      path: route.path,
      permission: route.permission ?? null,
      description: route.description ?? null,
    }));
  }
}

/** Query string → plain object, with numbers coerced on demand by services. */
export function queryObject(url) {
  /** @type {Record<string,string|boolean>} */
  const out = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (value === 'true') out[key] = true;
    else if (value === 'false') out[key] = false;
    else out[key] = value;
  }
  return out;
}

/**
 * Read a positive integer path/query parameter.
 * @param {Record<string, any>} params
 * @param {string} [name]
 * @param {{ required?: boolean, fallback?: number|null }} [options]
 * @returns {number|null}
 */
export function intParam(params, name = 'id', { required = true, fallback = null } = {}) {
  const raw = params?.[name];
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new ValidationError('errors.invalidArgument', [{ field: name, key: 'validation.required' }]);
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError('errors.invalidArgument', [{ field: name, key: 'validation.invalidId' }]);
  }
  return value;
}
