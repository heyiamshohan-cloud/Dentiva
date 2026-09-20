/**
 * Hash router.
 *
 * Routes look like `#/patients/42?tab=clinical`. The router resolves the first
 * matching pattern, runs the view factory and unwinds cleanly on navigation.
 */
const routes = [];
let current = null;
let cleanup = null;

/**
 * @param {string} pattern e.g. '/patients/:id'
 * @param {(context: { params: Record<string,string>, query: URLSearchParams, path: string }) => any} factory
 */
export function route(pattern, factory) {
  const names = [];
  const regex = new RegExp(
    `^${pattern
      .split('/')
      .map((segment) => {
        if (!segment) return '';
        if (segment.startsWith(':')) {
          names.push(segment.slice(1));
          return '([^/]+)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/')}$`,
  );
  routes.push({ pattern, regex, names, factory });
}

export function parseHash(hash = window.location.hash) {
  const raw = String(hash || '').replace(/^#/, '') || '/';
  const [pathPart, queryPart] = raw.split('?');
  const path = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  return { path: path.replace(/\/+$/, '') || '/', query: new URLSearchParams(queryPart ?? '') };
}

export function navigate(to, { replace = false } = {}) {
  const target = to.startsWith('#') ? to : `#${to.startsWith('/') ? to : `/${to}`}`;
  if (window.location.hash === target) {
    render();
    return;
  }
  if (replace) window.location.replace(target);
  else window.location.hash = target;
}

export function currentPath() {
  return parseHash().path;
}

/** Re-render the active route (after a save, a language switch or a setting change). */
export function refresh() {
  return render({ force: true });
}

/** @param {{ notFound?: any, onError?: any }} [options] */
export function startRouter({ notFound, onError } = /** @type {any} */ ({})) {
  window.addEventListener('hashchange', () => render());
  return render({ notFound, onError });
}

async function render({ force = false, notFound, onError } = /** @type {any} */ ({})) {
  const { path, query } = parseHash();
  if (!force && current && current.path === path && current.full === window.location.hash) return;

  const match = routes
    .map((entry) => ({ entry, result: entry.regex.exec(path) }))
    .find((item) => item.result);

  if (cleanup) {
    try {
      cleanup();
    } catch (error) {
      console.error('[dentiva] view cleanup failed', error);
    }
    cleanup = null;
  }
  current = { path, full: window.location.hash };

  if (!match) {
    if (notFound) notFound({ path, query });
    return;
  }

  const params = {};
  match.entry.names.forEach((name, index) => {
    params[name] = decodeURIComponent(match.result[index + 1]);
  });

  try {
    const result = await match.entry.factory({ params, query, path });
    if (typeof result === 'function') cleanup = result;
    else if (result && typeof result.cleanup === 'function') cleanup = result.cleanup;
  } catch (error) {
    if (onError) onError(error);
    else throw error;
  }
}

/** In-object routing must survive a full reload of the window. */
export function pathFor(name, params = {}) {
  return `#${name}${Object.entries(params).map(([key, value]) => `/${encodeURIComponent(String(value))}`).join('')}`;
}
