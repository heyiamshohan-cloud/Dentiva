/**
 * Clinic provisioning and profile management.
 *
 * `provisionClinic` is the single code path that creates a clinic: it is used by
 * the first-run wizard, by the tests and by the clinic factory used in
 * deployments. Everything it creates is *configuration* required to operate
 * (categories, payment methods, appointment types, numbering) — never fake
 * patients, staff or money (§ 6).
 */
import { all, get, run, withTransaction, nowIso } from '../db/connection.js';
import { assertValid } from '../domain/validation.js';
import { getSettings, setSettings } from './settings.js';
import { recordAudit } from './audit.js';
import { hashPassword, passwordProblems } from '../security/passwords.js';
import { ValidationError, ConflictError, NotFoundError } from '../../shared/errors.js';
import { DEFAULT_LOCALE, LOCALES } from '../../shared/constants.js';

export const clinicSchema = {
  code: { type: 'string', required: true, maxLength: 24, pattern: /^[A-Za-z0-9_-]+$/ },
  name: { type: 'string', required: true, maxLength: 160 },
  legal_name: { type: 'string', maxLength: 200, nullable: true },
  phone: { type: 'string', maxLength: 40, nullable: true },
  phone_alt: { type: 'string', maxLength: 40, nullable: true },
  email: { type: 'string', maxLength: 160, nullable: true },
  website: { type: 'string', maxLength: 200, nullable: true },
  address: { type: 'string', maxLength: 400, nullable: true },
  city: { type: 'string', maxLength: 120, nullable: true },
  country: { type: 'string', maxLength: 120, nullable: true },
  postal_code: { type: 'string', maxLength: 24, nullable: true },
  registration_no: { type: 'string', maxLength: 80, nullable: true },
  tax_no: { type: 'string', maxLength: 80, nullable: true },
  currency_code: { type: 'string', maxLength: 8, default: 'BDT' },
  currency_symbol: { type: 'string', maxLength: 8, default: '৳' },
  currency_minor_units: { type: 'int', min: 0, max: 4, default: 2 },
  locale: { type: 'enum', values: LOCALES, default: DEFAULT_LOCALE },
  date_format: { type: 'string', maxLength: 16, default: 'DD/MM/YYYY' },
  time_format: { type: 'enum', values: ['12h', '24h'], default: '12h' },
  working_days: { type: 'json', default: ['sun', 'mon', 'tue', 'wed', 'thu'] },
  working_hours_start: { type: 'string', maxLength: 5, default: '10:00' },
  working_hours_end: { type: 'string', maxLength: 5, default: '21:00' },
  appointment_minutes: { type: 'int', min: 5, max: 480, default: 30 },
  tax_enabled: { type: 'boolean', default: false },
  tax_label: { type: 'string', maxLength: 24, default: 'VAT' },
  tax_rate_bp: { type: 'int', min: 0, max: 10000, default: 0 },
  notes: { type: 'text', nullable: true },
};

export const practitionerSchema = {
  full_name: { type: 'string', required: true, maxLength: 160 },
  designation: { type: 'string', maxLength: 120, nullable: true },
  phone: { type: 'string', maxLength: 40, nullable: true },
  email: { type: 'string', maxLength: 160, nullable: true },
  registration_no: { type: 'string', maxLength: 80, nullable: true },
  specialty: { type: 'string', maxLength: 120, nullable: true },
  qualification: { type: 'string', maxLength: 200, nullable: true },
};

export const adminSchema = {
  username: { type: 'string', required: true, minLength: 3, maxLength: 60, pattern: /^[A-Za-z0-9._-]+$/ },
  display_name: { type: 'string', required: true, maxLength: 120 },
  password: { type: 'string', required: true, minLength: 8, maxLength: 200 },
  email: { type: 'string', maxLength: 160, nullable: true },
  phone: { type: 'string', maxLength: 40, nullable: true },
};

/** True when no clinic exists yet — the first-run wizard is required. */
export function isFirstRun(db) {
  const row = get(db, 'SELECT COUNT(*) AS c FROM clinics WHERE deleted_at IS NULL');
  return Number(row?.c ?? 0) === 0;
}

/**
 * The clinic row (default clinic when no id is given).
 * @param {import('bun:sqlite').Database} db
 * @param {number|null} [clinicId]
 */
export function getClinic(db, clinicId = null) {
  const row = clinicId
    ? get(db, 'SELECT * FROM clinics WHERE id = ? AND deleted_at IS NULL', [clinicId])
    : get(db, 'SELECT * FROM clinics WHERE deleted_at IS NULL ORDER BY is_default DESC, id LIMIT 1');
  return row ?? null;
}

export function listClinics(db) {
  return all(db, 'SELECT * FROM clinics WHERE deleted_at IS NULL ORDER BY is_default DESC, name');
}

/** Apply a validated update to a clinic profile. */
export function updateClinic(db, clinicId, patch, userId = null) {
  const before = get(db, 'SELECT * FROM clinics WHERE id = ?', [clinicId]);
  if (!before) throw new NotFoundError('clinic', clinicId);
  const values = assertValid(patch, clinicSchema, { partial: true });
  if (!Object.keys(values).length) return before;

  const jsonFields = new Set(['working_days']);
  const columns = Object.keys(values);
  const assignments = columns.map((col) => `${col} = ?`).join(', ');
  const params = columns.map((col) => (jsonFields.has(col) ? JSON.stringify(values[col]) : values[col]));
  run(db, `UPDATE clinics SET ${assignments}, updated_at = ? WHERE id = ?`, [...params, nowIso(), clinicId]);

  const after = get(db, 'SELECT * FROM clinics WHERE id = ?', [clinicId]);
  const changed = Object.keys(values);
  recordAudit(db, {
    clinicId,
    userId,
    action: 'update',
    module: 'settings',
    entity: 'clinic',
    entityId: clinicId,
    summary: `Clinic profile updated (${changed.join(', ')})`,
    severity: 'notice',
    before: Object.fromEntries(changed.map((key) => [key, before[key]])),
    after: Object.fromEntries(changed.map((key) => [key, after[key]])),
  });
  return after;
}

/**
 * Create the clinic, its configuration and the first administrator.
 * @param {import('bun:sqlite').Database} db
 * @param {{ clinic: any, dentist?: any, admin: any, settings?: Record<string, any>, userId?: number|null, silent?: boolean }} input
 */
export function provisionClinic(db, input) {
  const clinicValues = assertValid(input.clinic, clinicSchema);
  const adminValues = assertValid(input.admin, adminSchema);
  const dentistValues = input.dentist ? assertValid(input.dentist, practitionerSchema) : null;

  if (!/^[A-Za-z0-9._-]+$/.test(adminValues.username)) {
    throw new ValidationError('validation.failed', [{ field: 'username', key: 'validation.format' }]);
  }
  const problems = passwordProblems(adminValues.password, { minLength: 8, requireStrong: true });
  if (problems.length) {
    throw new ValidationError('validation.failed', problems.map((key) => ({ field: 'password', key })));
  }

  return withTransaction(db, () => {
    const existing = get(db, 'SELECT id FROM clinics WHERE code = ? AND deleted_at IS NULL', [clinicValues.code]);
    if (existing) throw new ConflictError('clinic.codeTaken', { code: clinicValues.code });
    const usernameTaken = get(db, 'SELECT id FROM users WHERE lower(username) = lower(?) AND deleted_at IS NULL', [
      adminValues.username,
    ]);
    if (usernameTaken) throw new ConflictError('users.usernameTaken', { username: adminValues.username });

    const clinicCount = Number(get(db, 'SELECT COUNT(*) AS c FROM clinics')?.c ?? 0);
    const clinicResult = run(
      db,
      `INSERT INTO clinics
        (code, name, legal_name, phone, phone_alt, email, website, address, city, country, postal_code,
         registration_no, tax_no, currency_code, currency_symbol, currency_minor_units, locale, date_format,
         time_format, working_days, working_hours_start, working_hours_end, appointment_minutes, tax_enabled,
         tax_label, tax_rate_bp, is_default, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        clinicValues.code,
        clinicValues.name,
        clinicValues.legal_name,
        clinicValues.phone,
        clinicValues.phone_alt,
        clinicValues.email,
        clinicValues.website,
        clinicValues.address,
        clinicValues.city,
        clinicValues.country,
        clinicValues.postal_code,
        clinicValues.registration_no,
        clinicValues.tax_no,
        clinicValues.currency_code,
        clinicValues.currency_symbol,
        clinicValues.currency_minor_units,
        clinicValues.locale,
        clinicValues.date_format,
        clinicValues.time_format,
        JSON.stringify(clinicValues.working_days),
        clinicValues.working_hours_start,
        clinicValues.working_hours_end,
        clinicValues.appointment_minutes,
        clinicValues.tax_enabled ? 1 : 0,
        clinicValues.tax_label,
        clinicValues.tax_rate_bp,
        clinicCount === 0 ? 1 : 0,
        clinicValues.notes,
      ],
    );
    const clinicId = Number(clinicResult.lastInsertRowid);

    // ---------------------------------------------------- configuration rows
    const templateRow = get(db, 'SELECT payload FROM clinic_provisioning_templates WHERE key = ?', ['defaults']);
    const template = templateRow ? JSON.parse(templateRow.payload) : null;

    if (template) {
      for (const item of template.expenseCategories ?? []) {
        run(
          db,
          'INSERT OR IGNORE INTO expense_categories (clinic_id, name_en, name_bn, is_system, sort_order) VALUES (?,?,?,?,?)',
          [clinicId, item.name_en, item.name_bn, item.is_system ?? 0, item.sort_order ?? 0],
        );
      }
      for (const item of template.incomeCategories ?? []) {
        run(
          db,
          'INSERT OR IGNORE INTO income_categories (clinic_id, name_en, name_bn, is_system, sort_order) VALUES (?,?,?,?,?)',
          [clinicId, item.name_en, item.name_bn, item.is_system ?? 0, item.sort_order ?? 0],
        );
      }
      for (const item of template.appointmentTypes ?? []) {
        run(
          db,
          `INSERT INTO appointment_types (clinic_id, name_en, name_bn, duration_minutes, color, sort_order)
           VALUES (?,?,?,?,?,?)`,
          [clinicId, item.name_en, item.name_bn, item.duration_minutes, item.color, item.sort_order],
        );
      }
      for (const item of template.inventoryCategories ?? []) {
        run(
          db,
          'INSERT INTO inventory_categories (clinic_id, name_en, name_bn, sort_order) VALUES (?,?,?,?)',
          [clinicId, item.name_en, item.name_bn, item.sort_order],
        );
      }
      for (const item of template.paymentMethods ?? []) {
        run(
          db,
          `INSERT INTO payment_methods (clinic_id, code, name_en, name_bn, requires_reference, is_system, sort_order)
           VALUES (?,?,?,?,?,?,?)`,
          [clinicId, item.code, item.name_en, item.name_bn, item.requires_reference, item.is_system, item.sort_order],
        );
      }
      for (const item of template.services ?? []) {
        run(
          db,
          `INSERT INTO services (clinic_id, code, name_en, name_bn, category, default_price_minor, sort_order)
           VALUES (?,?,?,?,?,?,?)`,
          [clinicId, item.code ?? null, item.name_en, item.name_bn ?? null, item.category ?? 'general', item.default_price_minor ?? 0, item.sort_order ?? 0],
        );
      }
      for (const item of template.diagnoses ?? []) {
        run(db, 'INSERT INTO diagnoses (clinic_id, code, label_en, label_bn, category) VALUES (?,?,?,?,?)', [
          clinicId,
          item.code ?? null,
          item.label_en,
          item.label_bn ?? null,
          item.category ?? 'general',
        ]);
      }
    }

    // ---------------------------------------------------- practitioner
    let practitionerId = null;
    if (dentistValues) {
      const staffCode = get(db, 'SELECT COUNT(*) AS c FROM staff')?.c ?? 0;
      const result = run(
        db,
        `INSERT INTO staff
          (clinic_id, staff_code, full_name, role_title, designation, specialty, qualification, registration_no,
           phone, email, is_practitioner, status, salary_type, salary_minor)
         VALUES (?,?,?,?,?,?,?,?,?,?,1,'active','monthly',0)`,
        [
          clinicId,
          `D-${String(Number(staffCode) + 1).padStart(3, '0')}`,
          dentistValues.full_name,
          'dentist',
          dentistValues.designation,
          dentistValues.specialty,
          dentistValues.qualification,
          dentistValues.registration_no,
          dentistValues.phone,
          dentistValues.email,
        ],
      );
      practitionerId = Number(result.lastInsertRowid);
    }

    // ---------------------------------------------------- administrator
    const ownerRole = get(db, "SELECT id FROM roles WHERE name = 'owner'");
    if (!ownerRole) throw new Error('System roles are missing — migrations did not run correctly');
    const hashed = hashPassword(adminValues.password);
    const adminResult = run(
      db,
      `INSERT INTO users
        (clinic_id, role_id, staff_id, username, display_name, email, phone, password_hash, password_salt,
         password_algo, password_params, password_changed_at, must_change_password, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,'active')`,
      [
        clinicId,
        ownerRole.id,
        practitionerId,
        adminValues.username,
        adminValues.display_name,
        adminValues.email ?? null,
        adminValues.phone ?? null,
        hashed.hash,
        hashed.salt,
        hashed.algo,
        hashed.params,
        nowIso(),
      ],
    );
    const adminId = Number(adminResult.lastInsertRowid);
    if (practitionerId) {
      run(db, 'UPDATE staff SET user_id = ? WHERE id = ?', [adminId, practitionerId]);
    }

    // ---------------------------------------------------- settings wiring
    /** @type {Record<string, any>} */
    const settingsPatch = {
      'locale.language': clinicValues.locale,
      'locale.dateFormat': clinicValues.date_format,
      'locale.timeFormat': clinicValues.time_format,
      'appointments.workingDays': clinicValues.working_days,
      'appointments.openTime': clinicValues.working_hours_start,
      'appointments.closeTime': clinicValues.working_hours_end,
      'appointments.defaultDuration': clinicValues.appointment_minutes,
      'billing.taxEnabled': clinicValues.tax_enabled,
      'billing.taxLabel': clinicValues.tax_label,
      'billing.taxRateBp': clinicValues.tax_rate_bp,
      ...(input.settings ?? {}),
    };
    setSettings(db, clinicId, settingsPatch, adminId ?? null);

    if (!input.silent) {
      recordAudit(db, {
        clinicId,
        userId: adminId,
        userName: adminValues.display_name,
        action: 'provision',
        module: 'settings',
        entity: 'clinic',
        entityId: clinicId,
        summary: 'Clinic provisioned through first-run setup',
        severity: 'notice',
        after: { name: clinicValues.name, code: clinicValues.code, locale: clinicValues.locale },
      });
    }

    return {
      clinicId,
      clinicCode: clinicValues.code,
      adminId,
      practitionerId,
      settings: getSettings(db, clinicId),
    };
  });
}
