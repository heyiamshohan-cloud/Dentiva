/**
 * Configurable document numbering (§ 72).
 *
 * Formats are data, not code: prefix, padding, starting value, optional year
 * segment and a reset policy per kind. Allocation is atomic — the sequence row
 * is incremented inside the caller's transaction, so two concurrent saves can
 * never receive the same number, and the UNIQUE index on each document table is
 * the final safety net.
 */
import { get, run } from '../db/connection.js';
import { getSetting } from './settings.js';

/** Logical document kinds. */
export const NUMBER_KINDS = [
  'patient',
  'visit',
  'appointment',
  'plan',
  'prescription',
  'referral',
  'invoice',
  'receipt',
  'staff',
];

const FALLBACK_PREFIX = {
  patient: 'DEN',
  visit: 'VS',
  appointment: 'APT',
  plan: 'TP',
  prescription: 'RX',
  referral: 'REF',
  invoice: 'INV',
  receipt: 'RCP',
  staff: 'STF',
};

/** Resolve the effective format configuration for a kind. */
export function resolveFormat(db, clinicId, kind) {
  const settings = {
    patients: {
      prefix: getSetting(db, clinicId, 'patients.codePrefix'),
      padding: getSetting(db, clinicId, 'patients.codePadding'),
      start: getSetting(db, clinicId, 'patients.codeStart'),
      includeYear: getSetting(db, clinicId, 'patients.codeIncludeYear'),
      resetPolicy: getSetting(db, clinicId, 'patients.codeResetPolicy'),
    },
    staff: {
      prefix: getSetting(db, clinicId, 'staff.codePrefix'),
      padding: 4,
      start: 1,
      includeYear: false,
      resetPolicy: 'never',
    },
  };
  if (kind === 'patient') return settings.patients;
  if (kind === 'staff') return settings.staff;

  const billing = {
    prefix:
      kind === 'invoice'
        ? getSetting(db, clinicId, 'billing.invoicePrefix')
        : kind === 'receipt'
          ? getSetting(db, clinicId, 'billing.receiptPrefix')
          : null,
    padding: getSetting(db, clinicId, 'billing.padding'),
    start: 1,
    includeYear: getSetting(db, clinicId, 'billing.includeYear'),
    resetPolicy: getSetting(db, clinicId, 'billing.resetYearly') ? 'yearly' : 'never',
  };
  if (kind === 'invoice' || kind === 'receipt') return billing;

  const overrides = getSetting(db, clinicId, 'numbering.prefixes') ?? {};
  return {
    prefix: overrides[kind] ?? FALLBACK_PREFIX[kind] ?? 'DOC',
    padding: 6,
    start: 1,
    includeYear: true,
    resetPolicy: 'yearly',
  };
}

export function periodKeyFor(resetPolicy, date = new Date()) {
  if (resetPolicy === 'yearly') return String(date.getFullYear());
  if (resetPolicy === 'monthly') return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  return '';
}

export function formatNumber(format, value, date = new Date()) {
  const parts = [format.prefix ?? ''];
  if (format.includeYear) parts.push(String(date.getFullYear()));
  parts.push(String(value).padStart(format.padding ?? 6, '0'));
  return parts.filter(Boolean).join('-');
}

/**
 * Ensure the sequence row exists for the current period, then return it.
 * @param {import('bun:sqlite').Database} db
 */
function ensureSequence(db, clinicId, kind, periodKey, format) {
  let row = get(db, 'SELECT * FROM number_sequences WHERE clinic_id = ? AND kind = ? AND period_key = ?', [
    clinicId,
    kind,
    periodKey,
  ]);
  if (row) return row;
  run(
    db,
    `INSERT INTO number_sequences (clinic_id, kind, period_key, prefix, suffix, padding, next_value, start_value, reset_policy, include_year)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)
     ON CONFLICT(clinic_id, kind, period_key) DO NOTHING`,
    [
      clinicId,
      kind,
      periodKey,
      format.prefix ?? '',
      format.padding ?? 6,
      format.start ?? 1,
      format.start ?? 1,
      format.resetPolicy ?? 'never',
      format.includeYear ? 1 : 0,
    ],
  );
  row = get(db, 'SELECT * FROM number_sequences WHERE clinic_id = ? AND kind = ? AND period_key = ?', [
    clinicId,
    kind,
    periodKey,
  ]);
  return row;
}

/**
 * Allocate the next document number. Must be called inside a transaction so a
 * rollback also rolls the sequence back (no gaps caused by failed inserts).
 * @param {import('bun:sqlite').Database} db
 * @param {number} clinicId
 * @param {string} kind
 * @param {{ date?: Date, override?: { prefix?: string, padding?: number } }} [options]
 */
export function nextNumber(db, clinicId, kind, options = {}) {
  const date = options.date ?? new Date();
  const format = resolveFormat(db, clinicId, kind);
  const effective = { ...format, ...(options.override ?? {}) };
  const periodKey = periodKeyFor(effective.resetPolicy, date);
  const sequence = ensureSequence(db, clinicId, kind, periodKey, effective);

  const updated = get(
    db,
    `UPDATE number_sequences
        SET next_value = next_value + 1,
            prefix = ?,
            padding = ?,
            include_year = ?
      WHERE id = ?
      RETURNING next_value - 1 AS allocated, prefix, padding, include_year`,
    [effective.prefix ?? sequence.prefix, effective.padding ?? sequence.padding, effective.includeYear ? 1 : 0, sequence.id],
  );

  const value = Number(updated?.allocated ?? sequence.start_value);
  const numberFormat = {
    prefix: updated?.prefix ?? effective.prefix ?? '',
    padding: Number(updated?.padding ?? effective.padding ?? 6),
    includeYear: Boolean(updated?.include_year ?? effective.includeYear),
  };
  return {
    value,
    code: formatNumber(numberFormat, value, date),
    periodKey,
    format: numberFormat,
  };
}

/** Peek at the next number without consuming it (used by the settings preview). */
export function previewNumber(db, clinicId, kind, options = {}) {
  const date = options.date ?? new Date();
  const format = { ...resolveFormat(db, clinicId, kind), ...(options.override ?? {}) };
  const periodKey = periodKeyFor(format.resetPolicy, date);
  const row = get(db, 'SELECT next_value FROM number_sequences WHERE clinic_id = ? AND kind = ? AND period_key = ?', [
    clinicId,
    kind,
    periodKey,
  ]);
  const value = Number(row?.next_value ?? format.start ?? 1);
  return formatNumber(format, value, date);
}

/**
 * Replace a sequence configuration (used by Settings → Numbering).
 * Existing documents are never renumbered.
 */
export function configureSequence(db, clinicId, kind, config = {}) {
  const format = resolveFormat(db, clinicId, kind);
  const periodKey = periodKeyFor(config.resetPolicy ?? format.resetPolicy);
  ensureSequence(db, clinicId, kind, periodKey, { ...format, ...config });
  run(
    db,
    `UPDATE number_sequences
        SET prefix = COALESCE(?, prefix),
            padding = COALESCE(?, padding),
            next_value = COALESCE(?, next_value),
            start_value = COALESCE(?, start_value),
            reset_policy = COALESCE(?, reset_policy),
            include_year = COALESCE(?, include_year)
      WHERE clinic_id = ? AND kind = ? AND period_key = ?`,
    [
      config.prefix ?? null,
      config.padding ?? null,
      config.nextValue ?? null,
      config.startValue ?? null,
      config.resetPolicy ?? null,
      config.includeYear === undefined ? null : config.includeYear ? 1 : 0,
      clinicId,
      kind,
      periodKey,
    ],
  );
}

/** Current state of every sequence — shown in Settings and used by tests. */
export function sequenceStatus(db, clinicId) {
  return NUMBER_KINDS.map((kind) => {
    const format = resolveFormat(db, clinicId, kind);
    const periodKey = periodKeyFor(format.resetPolicy);
    const row = get(db, 'SELECT next_value, period_key FROM number_sequences WHERE clinic_id = ? AND kind = ? AND period_key = ?', [
      clinicId,
      kind,
      periodKey,
    ]);
    return {
      kind,
      periodKey,
      nextValue: Number(row?.next_value ?? format.start ?? 1),
      preview: previewNumber(db, clinicId, kind),
      format,
    };
  });
}

/**
 * Retry helper: allocate a number, run `insert(code)`, and retry on a UNIQUE
 * violation caused by an out-of-band import that consumed the same number.
 * @template T
 * @param {import('bun:sqlite').Database} db
 * @param {number} clinicId
 * @param {string} kind
 * @param {(code: string, allocation: { value: number, code: string }) => T} insert
 * @param {{ attempts?: number }} [options]
 * @returns {T}
 */
export function withAllocatedNumber(db, clinicId, kind, insert, options = {}) {
  const attempts = options.attempts ?? 6;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const allocation = nextNumber(db, clinicId, kind);
    try {
      return insert(allocation.code, allocation);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/UNIQUE constraint failed/i.test(message)) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error('Unable to allocate a unique document number');
}
