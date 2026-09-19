/**
 * Printing.
 *
 * Documents are rendered by the server (same HTML as the print engine uses) and
 * opened in a dedicated window so paper size, margins and orientation come from
 * the clinic's printing settings instead of the app shell.
 */
import { toast } from './dom.js';

/** @param {string} kind @param {number|string} id @param {Record<string, any>} [query] */
export function documentUrl(kind, id, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return `/documents/${kind}/${encodeURIComponent(String(id))}${qs ? `?${qs}` : ''}`;
}

/**
 * Open a print document.
 * @param {string} kind
 * @param {number|string} id
 * @param {{ query?: Record<string, any>, t?: any, autoPrint?: boolean }} [options]
 */
export function printDocument(kind, id, { query = {}, t, autoPrint = true } = {}) {
  const url = documentUrl(kind, id, { ...query, autoprint: autoPrint ? 1 : undefined });
  const win = window.open(url, `dentiva-doc-${kind}-${id}`, 'width=980,height=760');
  if (!win) {
    if (t) toast({ message: t('documents.popupBlocked', {}), tone: 'warn' });
    else window.location.assign(url);
    return null;
  }
  win.focus();
  return win;
}

/** Reports print through the same route (key + range instead of an id). */
export function printReport(key, range, options = {}) {
  return printDocument('report', key, { query: range, ...options });
}
