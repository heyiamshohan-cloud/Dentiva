/**
 * DENTIVA — clinic defaults.
 *
 * `resources/clinic-defaults.json` describes what a brand-new clinic starts
 * with: expense and income categories, appointment types, inventory categories,
 * payment methods and the (deliberately empty) service and diagnosis lists.
 * Nothing in it is patient data, and no price is ever invented for a clinic.
 *
 * The file is read once per process:
 *
 *   • from `resources/clinic-defaults.json` while running from source;
 *   • from the embedded asset map when packaged, so the executable needs no
 *     files beside it.
 *
 * `applyClinicDefaults(db)` refreshes the provisioning template row. It is
 * idempotent: clinics that already exist keep every row they have, and a
 * template that already matches the file is left untouched (no write, no
 * timestamp churn).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get, run, withTransaction, nowIso } from './connection.js';

export const DEFAULTS_KEY = 'defaults';
export const DEFAULTS_VERSION = 1;

/** Categories that exist in every clinic and must never be deleted. */
export const SYSTEM_INCOME_CATEGORIES = ['Treatment income', 'Consultation fee'];

/** A shape the rest of the application can rely on. @type {Record<string, any[]>} */
const EMPTY = {
  expenseCategories: [],
  incomeCategories: [],
  appointmentTypes: [],
  inventoryCategories: [],
  paymentMethods: [],
  services: [],
  diagnoses: [],
};

/**
 * Normalise whatever the file contains so a hand-edited (or truncated) file can
 * never break provisioning: unknown keys are dropped, missing lists are empty
 * and every entry keeps only the fields the database has.
 * @param {any} parsed
 */
export function normaliseDefaults(parsed) {
  /** @type {Record<string, any[]>} */
  const out = { ...EMPTY };
  const source = parsed && typeof parsed === 'object' ? parsed : {};
  const strings = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const number = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

  const lists = /** @type {const} */ ([
    ['expenseCategories', ['name_en', 'name_bn']],
    ['incomeCategories', ['name_en', 'name_bn']],
    ['inventoryCategories', ['name_en', 'name_bn']],
    ['appointmentTypes', ['name_en', 'name_bn']],
    ['paymentMethods', ['code', 'name_en', 'name_bn']],
    ['services', ['name_en']],
    ['diagnoses', ['label_en']],
  ]);

  for (const [key, required] of lists) {
    const rows = Array.isArray(source[key]) ? source[key] : [];
    out[key] = rows
      .filter((row) => row && typeof row === 'object')
      .filter((row) => required.every((field) => strings(row[field]) !== null))
      .map((row, index) => {
        /** @type {Record<string, any>} */
        const entry = {};
        for (const [field, value] of Object.entries(row)) {
          if (typeof value === 'string') entry[field] = value.trim();
          else if (typeof value === 'boolean') entry[field] = value;
          else if (Number.isFinite(Number(value))) entry[field] = Number(value);
        }
        entry.sort_order = number(entry.sort_order, (index + 1) * 10);
        if (entry.is_system !== undefined) entry.is_system = entry.is_system ? 1 : 0;
        if (entry.requires_reference !== undefined) entry.requires_reference = entry.requires_reference ? 1 : 0;
        return entry;
      });
  }
  return out;
}

/** Built-in fallback used when the file cannot be read at all. */
export function builtInDefaults() {
  return normaliseDefaults(EMPTY);
}

/**
 * Locate and parse the defaults file.
 * @param {{ projectRoot?: string|null }} [options]
 */
export async function loadClinicDefaults(options = {}) {
  // Packaged builds carry the file inside the executable.
  try {
    const module = await import('../generated/assets.js');
    const entry = module.ASSETS?.['resources/clinic-defaults.json'];
    if (entry?.text) return normaliseDefaults(JSON.parse(entry.text));
  } catch {
    /* running from source, or no asset map */
  }

  const root = options.projectRoot;
  if (root) {
    try {
      const text = readFileSync(join(root, 'resources', 'clinic-defaults.json'), 'utf8');
      return normaliseDefaults(JSON.parse(text));
    } catch {
      /* fall through to the built-in list */
    }
  }
  return builtInDefaults();
}

/** The template stored in the database, or null. @param {any} db */
function storedTemplate(db) {
  const row = get(db, 'SELECT payload, updated_at FROM clinic_provisioning_templates WHERE key = ?', [DEFAULTS_KEY]);
  if (!row?.payload) return null;
  try {
    return { payload: JSON.parse(row.payload), updatedAt: row.updated_at ?? null };
  } catch {
    return null;
  }
}

/**
 * Install/refresh the provisioning template from the shipped defaults.
 *
 * - No stored template (fresh database or an upgrade from a build that shipped
 *   an empty one) → the file is written.
 * - Stored template already equal to the file → nothing happens.
 * - Stored template differs → it is replaced; clinics that already exist are
 *   never touched, because provisioning only reads the template when a *new*
 *   clinic is created.
 *
 * @param {any} db
 * @param {{ projectRoot?: string|null, quiet?: boolean, force?: boolean }} [options]
 * @returns {Promise<{ applied: boolean, reason: string, counts: Record<string, number>, updatedAt: string|null }>}
 */
export async function applyClinicDefaults(db, options = {}) {
  const defaults = await loadClinicDefaults(options);
  const payload = JSON.stringify(defaults);
  const counts = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, value.length]));
  const stored = storedTemplate(db);

  if (stored && stored.payload && !options.force) {
    const same = JSON.stringify(normaliseDefaults(stored.payload)) === payload;
    const hasContent = counts.expenseCategories + counts.appointmentTypes + counts.paymentMethods > 0;
    if (same || !hasContent) {
      return { applied: false, reason: same ? 'already-current' : 'defaults-empty', counts, updatedAt: stored.updatedAt };
    }
  }

  const updatedAt = nowIso();
  withTransaction(db, () => {
    run(
      db,
      `INSERT INTO clinic_provisioning_templates (key, payload, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      [DEFAULTS_KEY, payload, updatedAt],
    );
  });
  return { applied: true, reason: stored ? 'refreshed' : 'installed', counts, updatedAt };
}

/**
 * Synchronous variant used while the server starts: reads the file from disk
 * only (the embedded copy is handled by the async loader used by the CLI).
 * @param {any} db
 * @param {{ projectRoot?: string|null, quiet?: boolean, force?: boolean }} [options]
 */
export function applyClinicDefaultsSync(db, options = {}) {
  let defaults = builtInDefaults();
  const root = options.projectRoot ?? defaultProjectRoot;
  if (root) {
    try {
      defaults = normaliseDefaults(JSON.parse(readFileSync(join(root, 'resources', 'clinic-defaults.json'), 'utf8')));
    } catch {
      /* keep the built-in list */
    }
  }
  const payload = JSON.stringify(defaults);
  const counts = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, value.length]));
  const stored = storedTemplate(db);
  const isEmpty = counts.expenseCategories + counts.appointmentTypes + counts.paymentMethods === 0;
  if (isEmpty) return { applied: false, reason: 'defaults-empty', counts, updatedAt: stored?.updatedAt ?? null };
  if (stored && stored.payload && !options.force && JSON.stringify(normaliseDefaults(stored.payload)) === payload) {
    return { applied: false, reason: 'already-current', counts, updatedAt: stored.updatedAt };
  }
  const updatedAt = nowIso();
  withTransaction(db, () => {
    run(
      db,
      `INSERT INTO clinic_provisioning_templates (key, payload, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      [DEFAULTS_KEY, payload, updatedAt],
    );
  });
  return { applied: true, reason: stored ? 'refreshed' : 'installed', counts, updatedAt };
}

/** The project root used when no explicit one is passed (source checkouts). */
const defaultProjectRoot = (() => {
  try {
    return fileURLToPath(new URL('../../../', import.meta.url));
  } catch {
    return null;
  }
})();

/**
 * Copy the provisioning template onto an existing clinic that has no
 * configuration yet (used by `bun run seed:defaults` for clinics created by an
 * older build). Existing rows always win.
 * @param {any} db
 * @param {number} clinicId
 * @param {{ projectRoot?: string|null }} [options]
 */
export async function seedClinicConfiguration(db, clinicId, options = {}) {
  const defaults = await loadClinicDefaults(options);
  const inserted = {
    expenseCategories: 0,
    incomeCategories: 0,
    appointmentTypes: 0,
    inventoryCategories: 0,
    paymentMethods: 0,
    services: 0,
    diagnoses: 0,
  };

  withTransaction(db, () => {
    for (const item of defaults.expenseCategories) {
      const before = get(db, 'SELECT id FROM expense_categories WHERE clinic_id = ? AND lower(name_en) = lower(?)', [clinicId, item.name_en]);
      if (before) continue;
      run(
        db,
        'INSERT INTO expense_categories (clinic_id, name_en, name_bn, is_system, sort_order) VALUES (?,?,?,?,?)',
        [clinicId, item.name_en, item.name_bn, item.is_system ?? 0, item.sort_order ?? 0],
      );
      inserted.expenseCategories += 1;
    }
    for (const item of defaults.incomeCategories) {
      const before = get(db, 'SELECT id FROM income_categories WHERE clinic_id = ? AND lower(name_en) = lower(?)', [clinicId, item.name_en]);
      if (before) continue;
      run(
        db,
        'INSERT INTO income_categories (clinic_id, name_en, name_bn, is_system, sort_order) VALUES (?,?,?,?,?)',
        [clinicId, item.name_en, item.name_bn, item.is_system ?? 0, item.sort_order ?? 0],
      );
      inserted.incomeCategories += 1;
    }
    for (const item of defaults.appointmentTypes) {
      const before = get(db, 'SELECT id FROM appointment_types WHERE clinic_id = ? AND lower(name_en) = lower(?)', [clinicId, item.name_en]);
      if (before) continue;
      run(
        db,
        `INSERT INTO appointment_types (clinic_id, name_en, name_bn, duration_minutes, color, sort_order)
         VALUES (?,?,?,?,?,?)`,
        [clinicId, item.name_en, item.name_bn, item.duration_minutes ?? 30, item.color ?? '#0d9488', item.sort_order ?? 0],
      );
      inserted.appointmentTypes += 1;
    }
    for (const item of defaults.inventoryCategories) {
      const before = get(db, 'SELECT id FROM inventory_categories WHERE clinic_id = ? AND lower(name_en) = lower(?)', [clinicId, item.name_en]);
      if (before) continue;
      run(db, 'INSERT INTO inventory_categories (clinic_id, name_en, name_bn, sort_order) VALUES (?,?,?,?)', [
        clinicId,
        item.name_en,
        item.name_bn,
        item.sort_order ?? 0,
      ]);
      inserted.inventoryCategories += 1;
    }
    for (const item of defaults.paymentMethods) {
      const before = get(db, 'SELECT id FROM payment_methods WHERE clinic_id = ? AND code = ?', [clinicId, item.code]);
      if (before) continue;
      run(
        db,
        `INSERT INTO payment_methods (clinic_id, code, name_en, name_bn, requires_reference, is_system, sort_order)
         VALUES (?,?,?,?,?,?,?)`,
        [clinicId, item.code, item.name_en, item.name_bn, item.requires_reference ?? 0, item.is_system ?? 0, item.sort_order ?? 0],
      );
      inserted.paymentMethods += 1;
    }
    for (const item of defaults.services) {
      const before = get(db, 'SELECT id FROM services WHERE clinic_id = ? AND lower(name_en) = lower(?)', [clinicId, item.name_en]);
      if (before) continue;
      run(
        db,
        `INSERT INTO services (clinic_id, code, name_en, name_bn, category, default_price_minor, sort_order)
         VALUES (?,?,?,?,?,?,?)`,
        [
          clinicId,
          item.code ?? null,
          item.name_en,
          item.name_bn ?? null,
          item.category ?? 'general',
          item.default_price_minor ?? 0,
          item.sort_order ?? 0,
        ],
      );
      inserted.services += 1;
    }
    for (const item of defaults.diagnoses) {
      const before = get(db, 'SELECT id FROM diagnoses WHERE clinic_id = ? AND lower(label_en) = lower(?)', [clinicId, item.label_en]);
      if (before) continue;
      run(db, 'INSERT INTO diagnoses (clinic_id, code, label_en, label_bn, category) VALUES (?,?,?,?,?)', [
        clinicId,
        item.code ?? null,
        item.label_en,
        item.label_bn ?? null,
        item.category ?? 'general',
      ]);
      inserted.diagnoses += 1;
    }
  });

  return inserted;
}

/** Clinics in the database (used by the CLI). @param {any} db */
export function listClinicIds(db) {
  return all(db, 'SELECT id, name, code FROM clinics ORDER BY id').map((row) => ({
    id: Number(row.id),
    name: row.name,
    code: row.code,
  }));
}

export default { loadClinicDefaults, applyClinicDefaults, seedClinicConfiguration, normaliseDefaults, DEFAULTS_KEY };
