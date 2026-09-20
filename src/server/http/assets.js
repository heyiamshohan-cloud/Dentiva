/**
 * Static asset delivery for the application window.
 *
 * Assets live on disk while developing and inside the compiled executable when
 * packaged: this module prefers the file on disk and falls back to the generated
 * map (`scripts/gen-assets.mjs`), so the same code serves both builds.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** @type {Record<string, { type: string, text?: string, base64?: string }> | null} */
/** @type {Record<string, { type?: string, text?: string, base64?: string }>|null} */
let embeddedCache = null;

async function embeddedAssets() {
  if (embeddedCache) return embeddedCache;
  try {
    const module = await import('../generated/assets.js');
    embeddedCache = module.ASSETS ?? {};
  } catch {
    embeddedCache = {};
  }
  return embeddedCache;
}

/**
 * Resolve one asset by its URL path (already decoded, no query string).
 * @param {string} assetPath e.g. `/app/app.css`
 * @param {{ projectRoot?: string|null, root?: string }} options
 */
export async function loadAsset(assetPath, options = {}) {
  const relativePath = safeRelative(assetPath);
  if (!relativePath) return null;

  if (options.projectRoot) {
    // `root` lets the caller serve another source folder (e.g. `/shared`).
    const segments = options.root ? [options.root, relativePath] : ['src', 'renderer', relativePath];
    const diskPath = join(options.projectRoot, ...segments);
    if (existsSync(diskPath) && statSync(diskPath).isFile()) {
      return {
        body: readFileSync(diskPath),
        type: MIME_TYPES[extname(diskPath).toLowerCase()] ?? 'application/octet-stream',
        encoding: 'binary',
      };
    }
  }

  const assets = await embeddedAssets();
  const entry = assets[relativePath];
  if (entry) {
    return {
      body: entry.text !== undefined ? entry.text : Buffer.from(entry.base64 ?? '', 'base64'),
      type: entry.type ?? MIME_TYPES[extname(relativePath).toLowerCase()] ?? 'application/octet-stream',
      encoding: entry.text !== undefined ? 'text' : 'binary',
    };
  }

  if (relativePath.startsWith('fonts/')) {
    const font = await loadFont(relativePath, options);
    if (font) return font;
  }
  return null;
}

/** Fonts are read from node_modules in development, from the map when packaged. */
async function loadFont(relativePath, options) {
  const assets = await embeddedAssets();
  const entry = assets[relativePath];
  if (entry) {
    return {
      body: entry.text !== undefined ? entry.text : Buffer.from(entry.base64 ?? '', 'base64'),
      type: MIME_TYPES[extname(relativePath).toLowerCase()] ?? 'font/woff2',
      encoding: 'binary',
    };
  }
  if (!options.projectRoot) return null;
  const packageName = relativePath.includes('bengali') ? 'noto-sans-bengali' : 'inter';
  const fileName = relativePath.split('/').pop();
  const diskPath = join(options.projectRoot, 'node_modules', '@fontsource', packageName, 'files', fileName);
  if (!existsSync(diskPath)) return null;
  return { body: readFileSync(diskPath), type: 'font/woff2', encoding: 'binary' };
}

/** Reject traversal attempts before they touch the filesystem. */
export function safeRelative(assetPath) {
  const withoutQuery = String(assetPath).split('?')[0].split('#')[0];
  const decoded = decodeURIComponent(withoutQuery).replace(/\\/g, '/');
  if (decoded.includes('\0')) return null;
  const normalised = normalize(decoded).replace(/^([/\\])+/, '');
  if (!normalised || normalised.startsWith('..') || normalised.includes(`..${sep}`)) return null;
  if (!/^[A-Za-z0-9._/@-]+$/.test(normalised)) return null;
  return normalised;
}

export async function assetManifest() {
  const assets = await embeddedAssets();
  const names = Object.keys(assets);
  let bytes = 0;
  for (const name of names) {
    const entry = assets[name];
    bytes += entry.text !== undefined ? Buffer.byteLength(entry.text, 'utf8') : Math.floor((entry.base64?.length ?? 0) * 0.75);
  }
  return { files: names.length, bytes, generated: names.length > 0 };
}
