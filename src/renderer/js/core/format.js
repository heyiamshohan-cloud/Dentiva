/**
 * Formatting helpers.
 *
 * Money lives in the database as integer minor units and never as a float, so
 * every conversion is integer-safe: `minorToInput()` and `inputToMinor()` are the
 * only place decimals appear, and they round rather than truncate.
 */
import { state } from './store.js';

const BN_DIGITS = { 0: '০', 1: '১', 2: '২', 3: '৩', 4: '৪', 5: '৫', 6: '৬', 7: '৭', 8: '৮', 9: '৯' };

/** @param {string|number} value */
export function localizeDigits(value) {
  const text = String(value);
  if (state.locale !== 'bn') return text;
  return text.replace(/[0-9]/g, (digit) => BN_DIGITS[digit] ?? digit);
}

/** @param {number} minor @param {{ symbol?: boolean, decimals?: boolean }} [options] */
export function money(minor, { symbol = true, decimals = true } = {}) {
  const value = Number(minor ?? 0);
  const units = state.currencyMinorUnits;
  const major = value / 10 ** units;
  const formatted = major.toLocaleString('en-US', {
    minimumFractionDigits: decimals ? units : 0,
    maximumFractionDigits: decimals ? units : 0,
  });
  const withSymbol = symbol ? `${state.currencySymbol} ${formatted}` : formatted;
  return localizeDigits(withSymbol);
}

/** Plain signed amount used inside tables (no symbol duplication). */
export function amount(minor) {
  const value = Number(minor ?? 0);
  const major = value / 10 ** state.currencyMinorUnits;
  return localizeDigits(major.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}

/** @param {string|number|null|undefined} value e.g. "1200.50" */
export function inputToMinor(value) {
  if (value === null || value === undefined || value === '') return 0;
  const text = String(value).replace(/[^0-9.\-]/g, '');
  const number = Number(text);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 10 ** state.currencyMinorUnits);
}

/** @param {number} minor */
export function minorToInput(minor) {
  const units = state.currencyMinorUnits;
  return (Number(minor ?? 0) / 10 ** units).toFixed(units);
}

/** Quantity is stored in thousandths (integer). */
export function qty(milli) {
  const value = Number(milli ?? 0) / 1000;
  return localizeDigits(Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));
}

export function qtyToMilli(value) {
  const number = Number(String(value ?? '0').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 1000);
}

/** `2026-09-19` -> `19/09/2026` (per settings). */
export function date(iso, { empty = '—' } = {}) {
  if (!iso) return empty;
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  if (!y || !m || !d) return String(iso);
  const pattern = state.settings?.['locale.dateFormat'] ?? 'DD/MM/YYYY';
  const formatted = pattern
    .replace('YYYY', y)
    .replace('MM', m)
    .replace('DD', d)
    .replace('DD-MM-YYYY', `${d}-${m}-${y}`);
  return localizeDigits(formatted);
}

/** `14:30` -> `2:30 PM` when the clinic uses 12-hour time. */
export function time(value, { empty = '—' } = {}) {
  if (!value) return empty;
  const [hRaw, mRaw = '00'] = String(value).slice(0, 5).split(':');
  const h = Number(hRaw);
  if (!Number.isFinite(h)) return String(value);
  if ((state.settings?.['locale.timeFormat'] ?? '12h') === '24h') return localizeDigits(`${String(h).padStart(2, '0')}:${mRaw}`);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return localizeDigits(`${hour12}:${mRaw} ${suffix}`);
}

export function dateTime(iso) {
  if (!iso) return '—';
  const text = String(iso);
  if (text.length <= 10) return date(text);
  return `${date(text.slice(0, 10))} ${time(text.slice(11, 16))}`;
}

export function today() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

/** Add days to an ISO date without touching the timezone. */
export function addDays(iso, days) {
  const base = new Date(`${iso}T00:00:00`);
  base.setDate(base.getDate() + Number(days ?? 0));
  const offset = base.getTimezoneOffset() * 60000;
  return new Date(base.getTime() - offset).toISOString().slice(0, 10);
}

export function startOfMonth(iso = today()) {
  return `${iso.slice(0, 7)}-01`;
}

export function monthName(month, { short = false } = {}) {
  if (!month) return '—';
  const [y, m] = String(month).split('-');
  const index = Number(m) - 1;
  const names = short
    ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    : ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${names[index] ?? m} ${localizeDigits(y ?? '')}`.trim();
}

/** Age from a `YYYY-MM-DD` birth date, honouring the birthday. */
export function age(dob, { detailed = false } = {}) {
  if (!dob) return '—';
  const birth = new Date(`${String(dob).slice(0, 10)}T00:00:00`);
  const now = new Date();
  let years = now.getFullYear() - birth.getFullYear();
  let months = now.getMonth() - birth.getMonth();
  let days = now.getDate() - birth.getDate();
  if (days < 0) {
    months -= 1;
    days += new Date(now.getFullYear(), now.getMonth(), 0).getDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  if (!detailed) return localizeDigits(years);
  if (years <= 0) return localizeDigits(`${months}m ${days}d`);
  return localizeDigits(months ? `${years}y ${months}m` : `${years}y`);
}

export function percent(value, digits = 1) {
  return localizeDigits(`${Number(value ?? 0).toFixed(digits)}%`);
}

export function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part.charAt(0).toUpperCase()).join('') || '?';
}

export function truncate(text, length = 60) {
  const value = String(text ?? '');
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

/** `title_key` values from services are i18n keys; fall back to the raw text. */
export function keyed(t, key, fallback) {
  if (!key) return fallback ?? '—';
  const translated = t(key);
  return translated === key ? fallback ?? key : translated;
}
