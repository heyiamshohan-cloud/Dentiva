/**
 * Date / time helpers.
 *
 * Dentiva stores calendar dates as `YYYY-MM-DD` local strings and instants as
 * ISO-8601 UTC strings. Clinic-local operations (Schedules, Today, Queue) work
 * on the local calendar day, which is what a dental practice expects.
 */
import { toBengaliDigits } from './money.js';

const MONTH_NAMES_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_NAMES_BN = [
  'জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন',
  'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর',
];
const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS_BN = ['রবিবার', 'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার'];
const WEEKDAYS_SHORT_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_SHORT_BN = ['রবি', 'সোম', 'মঙ্গল', 'বুধ', 'বৃহঃ', 'শুক্র', 'শনি'];

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const ISO_TIME = /^\d{2}:\d{2}$/;

export function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

/** Local calendar date for a Date (or now). */
export function toIsoDate(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function todayIso() {
  return toIsoDate(new Date());
}

/** Parse `YYYY-MM-DD` into a local Date at midnight (no UTC drift). */
export function parseIsoDate(value) {
  if (!value) return null;
  if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

export function isValidIsoDate(value) {
  if (!value || !ISO_DATE.test(String(value))) return false;
  const date = parseIsoDate(value);
  return !!date && toIsoDate(date) === value;
}

export function isValidIsoTime(value) {
  if (!value || !ISO_TIME.test(String(value))) return false;
  const [h, m] = String(value).split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

/**
 * Add days to an ISO date. Returns `null` when the input is not a valid date.
 * @param {string|number|Date} value
 * @param {number} days
 * @returns {string|null}
 */
export function addDays(value, days) {
  const date = typeof value === 'string' ? parseIsoDate(value) : new Date(value);
  if (!date) return null;
  date.setDate(date.getDate() + days);
  return toIsoDate(date);
}

export function addMonths(value, months) {
  const date = typeof value === 'string' ? parseIsoDate(value) : new Date(value);
  if (!date) return null;
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay));
  return toIsoDate(date);
}

export function addYears(value, years) {
  return addMonths(value, years * 12);
}

export function diffDays(fromIso, toIsoValue) {
  const a = parseIsoDate(fromIso);
  const b = parseIsoDate(toIsoValue);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

export function compareIso(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''));
}

/** Boolean guard used by the services before writing a time to the database. */
export function assertValidIsoTime(value) {
  return isValidIsoTime(value);
}

/** Boolean guard for ISO dates (kept symmetrical with `assertValidIsoTime`). */
export function assertValidIsoDate(value) {
  return isValidIsoDate(value);
}

export function isWeekendLike(value, workingDays = ['sun', 'mon', 'tue', 'wed', 'thu']) {
  const date = parseIsoDate(value);
  if (!date) return false;
  const key = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][date.getDay()];
  return !workingDays.includes(key);
}

/** Clinic-configured date rendering (DD/MM/YYYY …). */
export function formatDate(value, format = 'DD/MM/YYYY', locale = 'en') {
  const date = parseIsoDate(value);
  if (!date) return '';
  const d = pad(date.getDate());
  const m = pad(date.getMonth() + 1);
  const y = String(date.getFullYear());
  let out;
  switch (format) {
    case 'MM/DD/YYYY':
      out = `${m}/${d}/${y}`;
      break;
    case 'YYYY-MM-DD':
      out = `${y}-${m}-${d}`;
      break;
    case 'DD-MM-YYYY':
      out = `${d}-${m}-${y}`;
      break;
    case 'DD.MM.YYYY':
      out = `${d}.${m}.${y}`;
      break;
    default:
      out = `${d}/${m}/${y}`;
  }
  return locale === 'bn' ? toBengaliDigits(out) : out;
}

export function formatDateLong(value, locale = 'en') {
  const date = parseIsoDate(value);
  if (!date) return '';
  const month = (locale === 'bn' ? MONTH_NAMES_BN : MONTH_NAMES_EN)[date.getMonth()];
  const weekday = (locale === 'bn' ? WEEKDAYS_BN : WEEKDAYS_EN)[date.getDay()];
  if (locale === 'bn') {
    return `${toBengaliDigits(date.getDate())} ${month} ${toBengaliDigits(date.getFullYear())}, ${weekday}`;
  }
  return `${weekday}, ${date.getDate()} ${month} ${date.getFullYear()}`;
}

export function monthName(monthIndex, locale = 'en') {
  return (locale === 'bn' ? MONTH_NAMES_BN : MONTH_NAMES_EN)[monthIndex] ?? '';
}

export function weekdayName(dayIndex, locale = 'en', short = false) {
  if (short) return (locale === 'bn' ? WEEKDAYS_SHORT_BN : WEEKDAYS_SHORT_EN)[dayIndex] ?? '';
  return (locale === 'bn' ? WEEKDAYS_BN : WEEKDAYS_EN)[dayIndex] ?? '';
}

/** `10:30` → `10:30 AM` (12-hour) or `10:30` (24-hour). */
export function formatTime(value, format = '12h', locale = 'en') {
  if (!value || !ISO_TIME.test(String(value))) return '';
  const [h, m] = String(value).split(':').map(Number);
  let out;
  if (format === '12h') {
    const suffix = h >= 12 ? 'PM' : 'AM';
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    out = `${hour12}:${pad(m)} ${suffix}`;
  } else {
    out = `${pad(h)}:${pad(m)}`;
  }
  return locale === 'bn' ? toBengaliDigits(out) : out;
}

export function formatTimestamp(value, options = {}) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const datePart = formatDate(toIsoDate(date), options.dateFormat ?? 'DD/MM/YYYY', options.locale ?? 'en');
  const timePart = formatTime(`${pad(date.getHours())}:${pad(date.getMinutes())}`, options.timeFormat ?? '12h', options.locale ?? 'en');
  return `${datePart} ${timePart}`;
}

export function toMinutes(time) {
  if (!time || !ISO_TIME.test(String(time))) return null;
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + m;
}

export function fromMinutes(totalMinutes) {
  const normalized = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(normalized / 60))}:${pad(normalized % 60)}`;
}

export function addMinutesToTime(time, minutes) {
  const base = toMinutes(time);
  if (base === null) return null;
  return fromMinutes(base + minutes);
}

export function timeRangesOverlap(startA, endA, startB, endB) {
  const a1 = toMinutes(startA);
  const a2 = toMinutes(endA);
  const b1 = toMinutes(startB);
  const b2 = toMinutes(endB);
  if (a1 === null || a2 === null || b1 === null || b2 === null) return false;
  return a1 < b2 && b1 < a2;
}

export function minutesBetweenTimes(start, end) {
  const a = toMinutes(start);
  const b = toMinutes(end);
  if (a === null || b === null) return 0;
  return Math.max(0, b - a);
}

/** Age from date of birth, with month/day precision for paediatric care. */
export function ageFromDob(dob, asOf = todayIso()) {
  const birth = parseIsoDate(dob);
  const reference = parseIsoDate(asOf);
  if (!birth || !reference || birth > reference) return null;
  let years = reference.getFullYear() - birth.getFullYear();
  let months = reference.getMonth() - birth.getMonth();
  let days = reference.getDate() - birth.getDate();
  if (days < 0) {
    months -= 1;
    const previousMonth = new Date(reference.getFullYear(), reference.getMonth(), 0).getDate();
    days += previousMonth;
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return { years, months, days, totalMonths: years * 12 + months };
}

/**
 * Human readable age: "34 years", "7 months", "3 years 2 months".
 * Localised through the caller's translation function.
 */
export function ageLabel(age, t) {
  if (!age) return '';
  if (age.years <= 0) return t('common.ageMonths', { count: age.months });
  if (age.years < 3 && age.months > 0) return t('common.ageYearsMonths', { years: age.years, months: age.months });
  return t('common.ageYears', { count: age.years });
}

export function startOfMonth(value) {
  const date = parseIsoDate(value) ?? new Date();
  return toIsoDate(new Date(date.getFullYear(), date.getMonth(), 1));
}

export function endOfMonth(value) {
  const date = parseIsoDate(value) ?? new Date();
  return toIsoDate(new Date(date.getFullYear(), date.getMonth() + 1, 0));
}

export function startOfWeek(value, weekStartsOn = 0) {
  const date = parseIsoDate(value) ?? new Date();
  const day = date.getDay();
  const diff = (day - weekStartsOn + 7) % 7;
  return addDays(toIsoDate(date), -diff);
}

export function startOfYear(value) {
  const date = parseIsoDate(value) ?? new Date();
  return `${date.getFullYear()}-01-01`;
}

export function endOfYear(value) {
  const date = parseIsoDate(value) ?? new Date();
  return `${date.getFullYear()}-12-31`;
}

/**
 * Resolve a standard date-range preset into `{ from, to, preset }`.
 * Presets are shared by every list, report and dashboard (§ 48).
 */
export function resolveRange(preset = 'today', options = {}) {
  const today = options.today ?? todayIso();
  switch (preset) {
    case 'today':
      return { from: today, to: today, preset };
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1), preset };
    case 'last7':
      return { from: addDays(today, -6), to: today, preset };
    case 'last30':
      return { from: addDays(today, -29), to: today, preset };
    case 'last90':
      return { from: addDays(today, -89), to: today, preset };
    case 'last180':
      return { from: addDays(today, -179), to: today, preset };
    case 'last365':
      return { from: addDays(today, -364), to: today, preset };
    case 'this_month':
      return { from: startOfMonth(today), to: endOfMonth(today), preset };
    case 'last_month':
      return {
        from: startOfMonth(addMonths(today, -1)),
        to: endOfMonth(addMonths(today, -1)),
        preset,
      };
    case 'this_year':
      return { from: startOfYear(today), to: endOfYear(today), preset };
    case 'week': {
      const weekStart = startOfWeek(today, options.weekStartsOn ?? 0) ?? today;
      return { from: weekStart, to: addDays(weekStart, 6) ?? today, preset };
    }
    case 'custom':
      return { from: options.from ?? today, to: options.to ?? today, preset: 'custom' };
    default:
      return { from: today, to: today, preset: 'today' };
  }
}

export function rangeLabelKey(preset) {
  return `dates.range.${preset}`;
}

/** Month grid used by the calendar screen. */
export function monthMatrix(year, monthIndex, weekStartsOn = 0) {
  const first = new Date(year, monthIndex, 1);
  const start = startOfWeek(toIsoDate(first), weekStartsOn) ?? toIsoDate(first);
  const weeks = [];
  let cursor = start;
  for (let w = 0; w < 6; w += 1) {
    const days = [];
    for (let d = 0; d < 7; d += 1) {
      days.push(cursor);
      cursor = addDays(cursor, 1) ?? cursor;
    }
    weeks.push(days);
    const monthEnd = new Date(year, monthIndex + 1, 0);
    if ((parseIsoDate(cursor) ?? monthEnd) > monthEnd) break;
  }
  return weeks;
}
