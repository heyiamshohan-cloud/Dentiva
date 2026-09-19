/**
 * Patient management (§ 15–21, § 29).
 *
 * Responsibilities: validated create/update, mandatory structured gender,
 * duplicate detection, configurable patient codes (§ 16), soft delete/restore,
 * medical & dental background, contacts, notes, statistics and the timeline.
 * Visit counts are always derived from real visit records — never stored as an
 * editable field (§ 20).
 */
import { all, get, run, withTransaction, nowIso } from '../db/connection.js';
import { pagedQuery, resolvePaging, resolveSort, placeholders } from '../db/query.js';
import { assertValid, validate } from '../domain/validation.js';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../shared/errors.js';
import { GENDERS, PATIENT_STATUSES, BLOOD_GROUPS } from '../../shared/constants.js';
import { getSettings } from './settings.js';
import { nextNumber } from './numbering.js';
import { recordAudit, diffForAudit } from './audit.js';
import { indexPatient, removeFromIndex } from './search.js';
import { ageFromDob, todayIso } from '../domain/dates.js';

const COMMUNICATION_CHANNELS = ['sms', 'whatsapp', 'call', 'email'];

export const patientSchema = {
  full_name: { type: 'string', required: true, minLength: 2, maxLength: 160 },
  preferred_name: { type: 'string', maxLength: 80, nullable: true },
  gender: { type: 'enum', required: true, values: GENDERS },
  dob: { type: 'date', nullable: true },
  age_estimated: { type: 'int', min: 0, max: 130, nullable: true },
  phone: { type: 'string', maxLength: 40, nullable: true },
  phone_alt: { type: 'string', maxLength: 40, nullable: true },
  email: { type: 'string', maxLength: 160, nullable: true },
  address: { type: 'string', maxLength: 400, nullable: true },
  city: { type: 'string', maxLength: 120, nullable: true },
  postal_code: { type: 'string', maxLength: 24, nullable: true },
  national_id: { type: 'string', maxLength: 60, nullable: true },
  occupation: { type: 'string', maxLength: 120, nullable: true },
  blood_group: { type: 'string', maxLength: 12, nullable: true },
  emergency_name: { type: 'string', maxLength: 120, nullable: true },
  emergency_relation: { type: 'string', maxLength: 60, nullable: true },
  emergency_phone: { type: 'string', maxLength: 40, nullable: true },
  referrer_source: { type: 'string', maxLength: 160, nullable: true },
  status: { type: 'enum', values: PATIENT_STATUSES, default: 'active' },
  communication_prefs: { type: 'json', default: {} },
  notes: { type: 'text', nullable: true },
  registered_on: { type: 'date', default: () => todayIso() },
  photo_attachment_id: { type: 'id', nullable: true },
};

/**
 * The medical endpoint reads camelCase flag names (`heartDisease`, `smoker`, …)
 * and writes database columns. Accept both spellings on write so a record read
 * from the API can be sent back unchanged and older windows keep working.
 */
const MEDICAL_FLAG_ALIASES = {
  diabetes: 'has_diabetes',
  hypertension: 'has_hypertension',
  heartDisease: 'has_heart_disease',
  asthma: 'has_asthma',
  bleedingDisorder: 'has_bleeding_disorder',
  pregnant: 'is_pregnant',
  smoker: 'is_smoker',
  anticoagulant: 'takes_anticoagulant',
  hepatitis: 'has_hepatitis',
  kidneyDisease: 'has_kidney_disease',
  thyroidDisorder: 'has_thyroid_disorder',
  alert: 'alert_flag',
};

/** @param {Record<string, any>} input */
function normaliseMedicalInput(input) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    out[MEDICAL_FLAG_ALIASES[key] ?? key] = value;
  }
  return out;
}

export const medicalSchema = {
  allergies: { type: 'text', nullable: true },
  medical_history: { type: 'text', nullable: true },
  current_medications: { type: 'text', nullable: true },
  conditions: { type: 'text', nullable: true },
  previous_surgery: { type: 'text', nullable: true },
  family_history: { type: 'text', nullable: true },
  notes: { type: 'text', nullable: true },
  has_diabetes: { type: 'boolean', default: false },
  has_hypertension: { type: 'boolean', default: false },
  has_heart_disease: { type: 'boolean', default: false },
  has_asthma: { type: 'boolean', default: false },
  has_bleeding_disorder: { type: 'boolean', default: false },
  is_pregnant: { type: 'boolean', default: false },
  is_smoker: { type: 'boolean', default: false },
  takes_anticoagulant: { type: 'boolean', default: false },
  has_hepatitis: { type: 'boolean', default: false },
  has_kidney_disease: { type: 'boolean', default: false },
  has_thyroid_disorder: { type: 'boolean', default: false },
  alert_flag: { type: 'boolean', default: false },
};

export const dentalSchema = {
  dental_history: { type: 'text', nullable: true },
  oral_hygiene: { type: 'enum', values: ['good', 'fair', 'poor'], nullable: true },
  brushing_frequency: { type: 'string', maxLength: 60, nullable: true },
  uses_floss: { type: 'boolean', default: false },
  uses_mouthwash: { type: 'boolean', default: false },
  has_braces: { type: 'boolean', default: false },
  had_orthodontics: { type: 'boolean', default: false },
  had_implant: { type: 'boolean', default: false },
  has_partial_denture: { type: 'boolean', default: false },
  has_full_denture: { type: 'boolean', default: false },
  grinds_teeth: { type: 'boolean', default: false },
  sensitive_teeth: { type: 'boolean', default: false },
  habits_tobacco: { type: 'boolean', default: false },
  habits_betel: { type: 'boolean', default: false },
  habits_alcohol: { type: 'boolean', default: false },
  notes: { type: 'text', nullable: true },
};

export const patientSorts = {
  code: 'p.patient_code',
  name: 'p.full_name COLLATE NOCASE',
  gender: 'p.gender',
  age: 'p.dob IS NULL, p.dob',
  registered: 'p.registered_on',
  lastVisit: 'last_visit_on',
  nextAppointment: 'next_appointment_on',
  outstanding: 'outstanding_minor',
  status: 'p.status',
};

const PATIENT_AGGREGATES = `
  (SELECT COALESCE(SUM(i.due_minor), 0) FROM invoices i
     WHERE i.patient_id = p.id AND i.status = 'issued' AND i.deleted_at IS NULL) AS outstanding_minor,
  (SELECT COALESCE(SUM(i.total_minor), 0) FROM invoices i
     WHERE i.patient_id = p.id AND i.status = 'issued' AND i.deleted_at IS NULL) AS invoiced_minor,
  (SELECT COALESCE(SUM(i.paid_minor), 0) FROM invoices i
     WHERE i.patient_id = p.id AND i.status = 'issued' AND i.deleted_at IS NULL) AS paid_minor,
  (SELECT COUNT(*) FROM visits v WHERE v.patient_id = p.id AND v.deleted_at IS NULL) AS total_visits,
  (SELECT COUNT(*) FROM visits v WHERE v.patient_id = p.id AND v.deleted_at IS NULL AND v.status = 'completed') AS completed_visits,
  (SELECT MIN(v.visit_date) FROM visits v WHERE v.patient_id = p.id AND v.deleted_at IS NULL) AS first_visit_on,
  (SELECT MAX(v.visit_date) FROM visits v WHERE v.patient_id = p.id AND v.deleted_at IS NULL) AS last_visit_on,
  (SELECT MIN(a.appt_date) FROM appointments a
     WHERE a.patient_id = p.id AND a.deleted_at IS NULL AND a.status = 'scheduled' AND a.appt_date >= ?) AS next_appointment_on,
  (SELECT COUNT(*) FROM appointments a WHERE a.patient_id = p.id AND a.deleted_at IS NULL AND a.status = 'no_show') AS no_shows,
  (SELECT COUNT(*) FROM appointments a WHERE a.patient_id = p.id AND a.deleted_at IS NULL AND a.status = 'cancelled') AS cancelled_appointments
`;

/**
 * Paged, filtered, sortable patient list (§ 17).
 * @param {import('bun:sqlite').Database} db
 * @param {{ clinicId: number }} ctx
 */
export function listPatients(db, ctx, params = {}) {
  const sort = resolveSort({ sortable: patientSorts, defaultSort: 'name', defaultDir: 'asc', sort: params.sort, dir: params.dir });
  const where = ['p.clinic_id = ?', 'p.deleted_at IS NULL'];
  /** @type {any[]} */
  const args = [ctx.clinicId];

  if (params.search) {
    where.push(
      "(p.full_name LIKE ? ESCAPE '\\' OR p.patient_code LIKE ? ESCAPE '\\' OR p.phone LIKE ? ESCAPE '\\' OR p.phone_alt LIKE ? ESCAPE '\\' OR p.email LIKE ? ESCAPE '\\')",
    );
    const pattern = `%${String(params.search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(pattern, pattern, pattern, pattern, pattern);
  }
  if (params.status && PATIENT_STATUSES.includes(params.status)) {
    where.push('p.status = ?');
    args.push(params.status);
  }
  if (params.gender && GENDERS.includes(params.gender)) {
    where.push('p.gender = ?');
    args.push(params.gender);
  }
  if (params.from) {
    where.push('p.registered_on >= ?');
    args.push(params.from);
  }
  if (params.to) {
    where.push('p.registered_on <= ?');
    args.push(params.to);
  }
  if (params.city) {
    where.push("p.city LIKE ? ESCAPE '\\'");
    args.push(`%${String(params.city).replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }
  if (params.bloodGroup) {
    where.push('p.blood_group = ?');
    args.push(params.bloodGroup);
  }
  if (params.ageMin !== undefined && params.ageMin !== null && params.ageMin !== '') {
    where.push("(p.dob IS NOT NULL AND (CAST(strftime('%Y', 'now') AS INTEGER) - CAST(strftime('%Y', p.dob) AS INTEGER)) >= ?)");
    args.push(Number(params.ageMin));
  }
  if (params.ageMax !== undefined && params.ageMax !== null && params.ageMax !== '') {
    where.push("(p.dob IS NOT NULL AND (CAST(strftime('%Y', 'now') AS INTEGER) - CAST(strftime('%Y', p.dob) AS INTEGER)) <= ?)");
    args.push(Number(params.ageMax));
  }
  if (params.hasOutstanding === true || params.hasOutstanding === 'true' || params.hasOutstanding === '1') {
    where.push(`(SELECT COALESCE(SUM(i.due_minor),0) FROM invoices i WHERE i.patient_id = p.id AND i.status='issued' AND i.deleted_at IS NULL) > 0`);
  }
  if (params.alertsOnly === true || params.alertsOnly === 'true' || params.alertsOnly === '1') {
    where.push('EXISTS (SELECT 1 FROM patient_medical m WHERE m.patient_id = p.id AND (m.alert_flag = 1 OR COALESCE(m.allergies, \'\') <> \'\'))');
  }

  const page = resolvePaging(params);
  const total = Number(get(db, `SELECT COUNT(*) AS c FROM patients p WHERE ${where.join(' AND ')}`, args)?.c ?? 0);
  // Parameter order follows the statement: the aggregate placeholder (today)
  // appears in the SELECT list, before the WHERE filters.
  const rows = all(
    db,
    `SELECT p.*, ${PATIENT_AGGREGATES}
       FROM patients p
      WHERE ${where.join(' AND ')}
      ORDER BY ${sort.sql}, p.id ASC
      LIMIT ? OFFSET ?`,
    [todayIso(), ...args, page.pageSize, page.offset],
  );

  const ids = rows.map((row) => row.id);
  const medical = new Map();
  if (ids.length) {
    for (const item of all(
      db,
      `SELECT patient_id, allergies, alert_flag, conditions FROM patient_medical WHERE patient_id IN (${placeholders(ids.length)})`,
      ids,
    )) {
      medical.set(item.patient_id, item);
    }
  }

  return {
    rows: rows.map((row) => shapePatientRow(row, medical.get(row.id))),
    total,
    page: page.page,
    pageSize: page.pageSize,
    pages: Math.max(1, Math.ceil(total / page.pageSize)),
    sort: sort.key,
    dir: sort.direction.toLowerCase(),
  };
}

function shapePatientRow(row, medical) {
  const age = row.dob ? ageFromDob(row.dob) : row.age_estimated ? { years: Number(row.age_estimated), months: 0, days: 0 } : null;
  return {
    id: Number(row.id),
    patientCode: row.patient_code,
    fullName: row.full_name,
    preferredName: row.preferred_name,
    gender: row.gender,
    dob: row.dob,
    age: age ? age.years : null,
    ageDetail: age,
    ageEstimated: !row.dob && row.age_estimated ? Number(row.age_estimated) : null,
    phone: row.phone,
    phoneAlt: row.phone_alt,
    email: row.email,
    city: row.city,
    status: row.status,
    bloodGroup: row.blood_group,
    registeredOn: row.registered_on,
    createdAt: row.created_at,
    lastVisitOn: row.last_visit_on,
    firstVisitOn: row.first_visit_on,
    nextAppointmentOn: row.next_appointment_on,
    totalVisits: Number(row.total_visits ?? 0),
    completedVisits: Number(row.completed_visits ?? 0),
    noShows: Number(row.no_shows ?? 0),
    cancelledAppointments: Number(row.cancelled_appointments ?? 0),
    outstandingMinor: Number(row.outstanding_minor ?? 0),
    invoicedMinor: Number(row.invoiced_minor ?? 0),
    paidMinor: Number(row.paid_minor ?? 0),
    alerts: {
      allergy: Boolean(medical?.allergies),
      allergies: medical?.allergies ?? null,
      medicalAlert: Boolean(medical?.alert_flag),
      conditions: medical?.conditions ?? null,
    },
  };
}

/** Fetch a single patient with all related background information. */
export function getPatientDetail(db, ctx, patientId) {
  const row = get(
    db,
    `SELECT p.*, ${PATIENT_AGGREGATES}
       FROM patients p
      WHERE p.id = ? AND p.clinic_id = ?`,
    [todayIso(), patientId, ctx.clinicId],
  );
  if (!row) throw new NotFoundError('patient', patientId);
  const medical = get(db, 'SELECT * FROM patient_medical WHERE patient_id = ?', [patientId]);
  const dental = get(db, 'SELECT * FROM patient_dental WHERE patient_id = ?', [patientId]);
  const contacts = all(db, 'SELECT * FROM patient_contacts WHERE patient_id = ? ORDER BY is_primary DESC, id', [patientId]);
  const customValues = all(
    db,
    `SELECT f.field_key, f.label_en, f.label_bn, f.field_type, v.value
       FROM patient_custom_fields f
       LEFT JOIN patient_custom_values v ON v.field_id = f.id AND v.patient_id = ?
      WHERE f.clinic_id = ? AND f.is_enabled = 1
      ORDER BY f.sort_order, f.id`,
    [patientId, ctx.clinicId],
  );
  return {
    ...shapePatientRow(row, medical),
    address: row.address,
    postalCode: row.postal_code,
    nationalId: row.national_id,
    occupation: row.occupation,
    emergencyName: row.emergency_name,
    emergencyRelation: row.emergency_relation,
    emergencyPhone: row.emergency_phone,
    referrerSource: row.referrer_source,
    communicationPrefs: safeJson(row.communication_prefs, {}),
    notes: row.notes,
    photoAttachmentId: row.photo_attachment_id ?? null,
    deletedAt: row.deleted_at,
    medical: medical
      ? {
          allergies: medical.allergies,
          medicalHistory: medical.medical_history,
          currentMedications: medical.current_medications,
          conditions: medical.conditions,
          previousSurgery: medical.previous_surgery,
          familyHistory: medical.family_history,
          notes: medical.notes,
          flags: {
            diabetes: Boolean(medical.has_diabetes),
            hypertension: Boolean(medical.has_hypertension),
            heartDisease: Boolean(medical.has_heart_disease),
            asthma: Boolean(medical.has_asthma),
            bleedingDisorder: Boolean(medical.has_bleeding_disorder),
            pregnant: Boolean(medical.is_pregnant),
            smoker: Boolean(medical.is_smoker),
            anticoagulant: Boolean(medical.takes_anticoagulant),
            hepatitis: Boolean(medical.has_hepatitis),
            kidneyDisease: Boolean(medical.has_kidney_disease),
            thyroidDisorder: Boolean(medical.has_thyroid_disorder),
            alert: Boolean(medical.alert_flag),
          },
        }
      : null,
    dental: dental
      ? {
          dentalHistory: dental.dental_history,
          oralHygiene: dental.oral_hygiene,
          brushingFrequency: dental.brushing_frequency,
          usesFloss: Boolean(dental.uses_floss),
          usesMouthwash: Boolean(dental.uses_mouthwash),
          hasBraces: Boolean(dental.has_braces),
          hadOrthodontics: Boolean(dental.had_orthodontics),
          hadImplant: Boolean(dental.had_implant),
          hasPartialDenture: Boolean(dental.has_partial_denture),
          hasFullDenture: Boolean(dental.has_full_denture),
          grindsTeeth: Boolean(dental.grinds_teeth),
          sensitiveTeeth: Boolean(dental.sensitive_teeth),
          habits: { tobacco: Boolean(dental.habits_tobacco), betel: Boolean(dental.habits_betel), alcohol: Boolean(dental.habits_alcohol) },
          notes: dental.notes,
        }
      : null,
    contacts: contacts.map((contact) => ({
      id: contact.id,
      kind: contact.kind,
      name: contact.name,
      relation: contact.relation,
      phone: contact.phone,
      email: contact.email,
      address: contact.address,
      isPrimary: Boolean(contact.is_primary),
      notes: contact.notes,
    })),
    customFields: customValues.map((item) => ({
      key: item.field_key,
      labelEn: item.label_en,
      labelBn: item.label_bn,
      type: item.field_type,
      value: item.value,
    })),
  };
}

function safeJson(value, fallback) {
  if (!value) return fallback;
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return fallback;
  }
}

/** Aggregated statistics shown in the Patient 360° header (§ 20). */
export function patientStats(db, ctx, patientId) {
  const visits = get(
    db,
    `SELECT
        COUNT(*) AS total_visits,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_visits,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_visits,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_visits,
        MIN(visit_date) AS first_visit_on,
        MAX(visit_date) AS last_visit_on
      FROM visits WHERE patient_id = ? AND deleted_at IS NULL`,
    [patientId],
  );
  const appointments = get(
    db,
    `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) AS no_shows,
        SUM(CASE WHEN status = 'scheduled' AND appt_date >= ? THEN 1 ELSE 0 END) AS upcoming
      FROM appointments WHERE patient_id = ? AND deleted_at IS NULL`,
    [todayIso(), patientId],
  );
  const nextAppointment = get(
    db,
    `SELECT id, appointment_code, appt_date, start_time, status, type_label
       FROM appointments
      WHERE patient_id = ? AND deleted_at IS NULL AND appt_date >= ? AND status IN ('scheduled','checked_in','waiting','in_treatment')
      ORDER BY appt_date, start_time LIMIT 1`,
    [patientId, todayIso()],
  );
  const billing = get(
    db,
    `SELECT
        COALESCE(SUM(CASE WHEN status = 'issued' THEN total_minor END), 0) AS invoiced,
        COALESCE(SUM(CASE WHEN status = 'issued' THEN paid_minor END), 0) AS paid,
        COALESCE(SUM(CASE WHEN status = 'issued' THEN due_minor END), 0) AS due,
        COUNT(CASE WHEN status = 'issued' THEN 1 END) AS invoice_count
      FROM invoices WHERE patient_id = ? AND deleted_at IS NULL`,
    [patientId],
  );
  const credit = get(
    db,
    'SELECT COALESCE(SUM(amount_minor), 0) AS balance FROM patient_credits WHERE patient_id = ?',
    [patientId],
  );
  const counts = get(
    db,
    `SELECT
      (SELECT COUNT(*) FROM treatments WHERE patient_id = ? AND deleted_at IS NULL) AS treatments,
      (SELECT COUNT(*) FROM treatment_plans WHERE patient_id = ? AND deleted_at IS NULL) AS plans,
      (SELECT COUNT(*) FROM prescriptions WHERE patient_id = ? AND deleted_at IS NULL) AS prescriptions,
      (SELECT COUNT(*) FROM referrals WHERE patient_id = ? AND deleted_at IS NULL) AS referrals,
      (SELECT COUNT(*) FROM attachments WHERE patient_id = ? AND deleted_at IS NULL) AS attachments,
      (SELECT COUNT(*) FROM dental_chart_entries WHERE patient_id = ? AND is_active = 1) AS chart_entries,
      (SELECT COUNT(*) FROM patient_notes WHERE patient_id = ? AND deleted_at IS NULL) AS notes`,
    [patientId, patientId, patientId, patientId, patientId, patientId, patientId],
  );
  return {
    visits: {
      total: Number(visits?.total_visits ?? 0),
      completed: Number(visits?.completed_visits ?? 0),
      cancelled: Number(visits?.cancelled_visits ?? 0),
      open: Number(visits?.open_visits ?? 0),
      firstVisitOn: visits?.first_visit_on ?? null,
      lastVisitOn: visits?.last_visit_on ?? null,
    },
    appointments: {
      total: Number(appointments?.total ?? 0),
      completed: Number(appointments?.completed ?? 0),
      cancelled: Number(appointments?.cancelled ?? 0),
      noShows: Number(appointments?.no_shows ?? 0),
      upcoming: Number(appointments?.upcoming ?? 0),
      next: nextAppointment
        ? {
            id: Number(nextAppointment.id),
            code: nextAppointment.appointment_code,
            date: nextAppointment.appt_date,
            time: nextAppointment.start_time,
            status: nextAppointment.status,
            typeLabel: nextAppointment.type_label,
          }
        : null,
    },
    billing: {
      invoicedMinor: Number(billing?.invoiced ?? 0),
      paidMinor: Number(billing?.paid ?? 0),
      dueMinor: Number(billing?.due ?? 0),
      invoiceCount: Number(billing?.invoice_count ?? 0),
      creditMinor: Number(credit?.balance ?? 0),
    },
    counts: {
      treatments: Number(counts?.treatments ?? 0),
      plans: Number(counts?.plans ?? 0),
      prescriptions: Number(counts?.prescriptions ?? 0),
      referrals: Number(counts?.referrals ?? 0),
      attachments: Number(counts?.attachments ?? 0),
      chartEntries: Number(counts?.chart_entries ?? 0),
      notes: Number(counts?.notes ?? 0),
    },
  };
}

/**
 * Duplicate detection (§ 67) — same phone, or same name + date of birth.
 * @param {any} db
 * @param {any} ctx
 * @param {{ full_name?: string|null, phone?: string|null, phone_alt?: string|null, dob?: string|null, excludeId?: number|null }} input
 */
export function findPotentialDuplicates(db, ctx, { full_name, phone, phone_alt, dob, excludeId = null }) {
  const matches = [];
  const name = String(full_name ?? '').trim();
  const phones = [phone, phone_alt].filter(Boolean).map((value) => String(value).trim());
  if (!name && !phones.length) return matches;

  for (const value of phones) {
    const rows = all(
      db,
      `SELECT id, patient_code, full_name, phone, dob, status FROM patients
        WHERE clinic_id = ? AND deleted_at IS NULL AND (phone = ? OR phone_alt = ?) ${excludeId ? 'AND id <> ?' : ''}`,
      excludeId ? [ctx.clinicId, value, value, excludeId] : [ctx.clinicId, value, value],
    );
    for (const row of rows) matches.push({ reason: 'phone', ...row });
  }
  if (name) {
    const rows = all(
      db,
      `SELECT id, patient_code, full_name, phone, dob, status FROM patients
        WHERE clinic_id = ? AND deleted_at IS NULL AND lower(full_name) = lower(?)
          ${dob ? 'AND dob = ?' : ''} ${excludeId ? 'AND id <> ?' : ''}`,
      [...(dob ? [ctx.clinicId, name, dob] : [ctx.clinicId, name]), ...(excludeId ? [excludeId] : [])],
    );
    for (const row of rows) matches.push({ reason: 'name', ...row });
  }
  const seen = new Set();
  return matches.filter((match) => {
    if (seen.has(match.id)) return false;
    seen.add(match.id);
    return true;
  });
}

/**
 * Register a patient. Allocates the configurable patient code, refuses silent
 * duplicates, writes the audit entry and refreshes the search index.
 * @param {import('bun:sqlite').Database} db
 * @param {{ clinicId: number, user?: any, ip?: string|null }} ctx
 */
export function createPatient(db, ctx, input) {
  const settings = getSettings(db, ctx.clinicId);
  const values = assertValid(input, patientSchema);

  if (settings['patients.requirePhone'] && !values.phone && !values.phone_alt) {
    throw new ValidationError('validation.failed', [{ field: 'phone', key: 'validation.required' }]);
  }
  if (settings['patients.duplicateCheck'] && !input.forceDuplicate) {
    const duplicates = findPotentialDuplicates(db, ctx, {
      full_name: values.full_name,
      phone: values.phone,
      phone_alt: values.phone_alt,
      dob: values.dob,
    });
    if (duplicates.length) {
      throw new ConflictError('patients.duplicateFound', { duplicates });
    }
  }

  return withTransaction(db, () => {
    const allocation = nextNumber(db, ctx.clinicId, 'patient');
    const result = run(
      db,
      `INSERT INTO patients
        (clinic_id, patient_code, full_name, preferred_name, gender, dob, age_estimated, phone, phone_alt, email, address,
         city, postal_code, national_id, occupation, blood_group, emergency_name, emergency_relation, emergency_phone,
         referrer_source, status, communication_prefs, notes, registered_on, photo_attachment_id, created_by, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ctx.clinicId,
        allocation.code,
        values.full_name,
        values.preferred_name ?? null,
        values.gender,
        values.dob ?? null,
        values.age_estimated ?? null,
        values.phone ?? null,
        values.phone_alt ?? null,
        values.email ?? null,
        values.address ?? null,
        values.city ?? null,
        values.postal_code ?? null,
        values.national_id ?? null,
        values.occupation ?? null,
        values.blood_group ?? null,
        values.emergency_name ?? null,
        values.emergency_relation ?? null,
        values.emergency_phone ?? null,
        values.referrer_source ?? null,
        values.status ?? 'active',
        JSON.stringify(values.communication_prefs ?? {}),
        values.notes ?? null,
        values.registered_on ?? todayIso(),
        values.photo_attachment_id ?? null,
        ctx.user?.id ?? null,
        ctx.user?.id ?? null,
      ],
    );
    const patientId = Number(result.lastInsertRowid);
    run(db, 'INSERT INTO patient_medical (patient_id) VALUES (?)', [patientId]);
    run(db, 'INSERT INTO patient_dental (patient_id) VALUES (?)', [patientId]);
    indexPatient(db, patientId);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'create',
      module: 'patients',
      entity: 'patient',
      entityId: patientId,
      summary: `Patient ${allocation.code} registered`,
      severity: 'info',
      after: { patient_code: allocation.code, full_name: values.full_name, gender: values.gender },
      ip: ctx.ip,
    });
    return { id: patientId, patientCode: allocation.code };
  });
}

/** Update patient demographics (partial patch, audited field by field). */
export function updatePatient(db, ctx, patientId, input) {
  const before = get(db, 'SELECT * FROM patients WHERE id = ? AND clinic_id = ?', [patientId, ctx.clinicId]);
  if (!before) throw new NotFoundError('patient', patientId);
  const settings = getSettings(db, ctx.clinicId);
  const values = assertValid(input, patientSchema, { partial: true });
  if (!Object.keys(values).length) return getPatientDetail(db, ctx, patientId);

  if (settings['patients.duplicateCheck'] && (values.phone || values.phone_alt || values.full_name)) {
    const duplicates = findPotentialDuplicates(db, ctx, {
      full_name: values.full_name ?? before.full_name,
      phone: values.phone ?? before.phone,
      phone_alt: values.phone_alt ?? before.phone_alt,
      dob: values.dob ?? before.dob,
      excludeId: patientId,
    });
    if (duplicates.length && !input.forceDuplicate) throw new ConflictError('patients.duplicateFound', { duplicates });
  }

  const jsonFields = new Set(['communication_prefs']);
  const columns = Object.keys(values).filter((key) => key !== 'forceDuplicate');
  if (!columns.length) return getPatientDetail(db, ctx, patientId);
  const assignments = columns.map((col) => `${col} = ?`).join(', ');
  const params = columns.map((col) => (jsonFields.has(col) ? JSON.stringify(values[col] ?? {}) : values[col]));

  run(db, `UPDATE patients SET ${assignments}, updated_by = ?, updated_at = ? WHERE id = ?`, [
    ...params,
    ctx.user?.id ?? null,
    nowIso(),
    patientId,
  ]);

  const after = get(db, 'SELECT * FROM patients WHERE id = ?', [patientId]);
  const diff = diffForAudit(before, after, columns);
  indexPatient(db, patientId);
  if (diff.changed.length) {
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'update',
      module: 'patients',
      entity: 'patient',
      entityId: patientId,
      summary: `Patient ${after.patient_code} updated (${diff.changed.join(', ')})`,
      severity: 'info',
      before: diff.before,
      after: diff.after,
      ip: ctx.ip,
    });
  }
  return getPatientDetail(db, ctx, patientId);
}

export function saveMedicalRecord(db, ctx, patientId, input) {
  const patient = get(db, 'SELECT id, patient_code FROM patients WHERE id = ? AND clinic_id = ?', [patientId, ctx.clinicId]);
  if (!patient) throw new NotFoundError('patient', patientId);
  const before = get(db, 'SELECT * FROM patient_medical WHERE patient_id = ?', [patientId]) ?? {};
  const values = assertValid(normaliseMedicalInput(input), medicalSchema, { partial: true });
  if (!Object.keys(values).length) return before;

  if (!before.id) {
    run(db, 'INSERT INTO patient_medical (patient_id) VALUES (?)', [patientId]);
  }
  const columns = Object.keys(values);
  const assignments = columns.map((col) => `${col} = ?`).join(', ');
  run(db, `UPDATE patient_medical SET ${assignments}, updated_at = ? WHERE patient_id = ?`, [
    ...columns.map((col) => (typeof values[col] === 'boolean' ? (values[col] ? 1 : 0) : values[col])),
    nowIso(),
    patientId,
  ]);
  indexPatient(db, patientId);
  const after = get(db, 'SELECT * FROM patient_medical WHERE patient_id = ?', [patientId]);
  const diff = diffForAudit(before, after, columns);
  if (diff.changed.length) {
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'update_medical',
      module: 'patients',
      entity: 'patient_medical',
      entityId: patientId,
      summary: `Medical background updated for ${patient.patient_code}`,
      severity: 'notice',
      before: diff.before,
      after: diff.after,
      ip: ctx.ip,
    });
  }
  return after;
}

export function saveDentalRecord(db, ctx, patientId, input) {
  const patient = get(db, 'SELECT id, patient_code FROM patients WHERE id = ? AND clinic_id = ?', [patientId, ctx.clinicId]);
  if (!patient) throw new NotFoundError('patient', patientId);
  const before = get(db, 'SELECT * FROM patient_dental WHERE patient_id = ?', [patientId]) ?? {};
  const values = assertValid(input, dentalSchema, { partial: true });
  if (!Object.keys(values).length) return before;
  if (!before.id) run(db, 'INSERT INTO patient_dental (patient_id) VALUES (?)', [patientId]);
  const columns = Object.keys(values);
  const assignments = columns.map((col) => `${col} = ?`).join(', ');
  run(db, `UPDATE patient_dental SET ${assignments}, updated_at = ? WHERE patient_id = ?`, [
    ...columns.map((col) => (typeof values[col] === 'boolean' ? (values[col] ? 1 : 0) : values[col])),
    nowIso(),
    patientId,
  ]);
  const after = get(db, 'SELECT * FROM patient_dental WHERE patient_id = ?', [patientId]);
  const diff = diffForAudit(before, after, columns);
  if (diff.changed.length) {
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'update_dental',
      module: 'patients',
      entity: 'patient_dental',
      entityId: patientId,
      summary: `Dental background updated for ${patient.patient_code}`,
      severity: 'info',
      before: diff.before,
      after: diff.after,
    });
  }
  return after;
}

const contactSchema = {
  kind: { type: 'enum', values: ['primary', 'emergency', 'guardian', 'insurance', 'employer', 'other'], default: 'other' },
  name: { type: 'string', required: true, maxLength: 120 },
  relation: { type: 'string', maxLength: 60, nullable: true },
  phone: { type: 'string', maxLength: 40, nullable: true },
  email: { type: 'string', maxLength: 160, nullable: true },
  address: { type: 'string', maxLength: 300, nullable: true },
  is_primary: { type: 'boolean', default: false },
  notes: { type: 'text', nullable: true },
};

/** Replace the contact list for a patient (transactional). */
/**
 * @param {any} db
 * @param {any} ctx
 * @param {number} patientId
 * @param {any[]} contacts
 */
export function replaceContacts(db, ctx, patientId, contacts) {
  const patient = get(db, 'SELECT id FROM patients WHERE id = ? AND clinic_id = ?', [patientId, ctx.clinicId]);
  if (!patient) throw new NotFoundError('patient', patientId);
  const list = Array.isArray(contacts) ? contacts : [];
  const validated = list.map((contact, index) => {
    const { values, errors } = validate(contact, contactSchema);
    if (errors.length) {
      throw new ValidationError(
        'validation.failed',
        errors.map((error) => ({ field: `contacts.${index}.${error.field}`, key: error.key, params: error.params })),
      );
    }
    return values;
  });
  return withTransaction(db, () => {
    run(db, 'DELETE FROM patient_contacts WHERE patient_id = ?', [patientId]);
    for (const contact of validated) {
      run(
        db,
        `INSERT INTO patient_contacts (patient_id, kind, name, relation, phone, email, address, is_primary, notes)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          patientId,
          contact.kind,
          contact.name,
          contact.relation ?? null,
          contact.phone ?? null,
          contact.email ?? null,
          contact.address ?? null,
          contact.is_primary ? 1 : 0,
          contact.notes ?? null,
        ],
      );
    }
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'update_contacts',
      module: 'patients',
      entity: 'patient',
      entityId: patientId,
      summary: `Patient contacts updated (${validated.length})`,
      severity: 'info',
    });
    return all(db, 'SELECT * FROM patient_contacts WHERE patient_id = ? ORDER BY is_primary DESC, id', [patientId]);
  });
}

/** Archive (soft delete) — clinical and financial history is preserved (§ 70). */
/**
 * Archive a patient (never a hard delete when records exist).
 * @param {any} db
 * @param {any} ctx
 * @param {number} patientId
 * @param {string|null} [reason]
 */
export function archivePatient(db, ctx, patientId, reason = null) {
  const patient = get(db, 'SELECT * FROM patients WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [patientId, ctx.clinicId]);
  if (!patient) throw new NotFoundError('patient', patientId);
  const openBalance = Number(
    get(
      db,
      "SELECT COALESCE(SUM(due_minor),0) AS due FROM invoices WHERE patient_id = ? AND status = 'issued' AND deleted_at IS NULL",
      [patientId],
    )?.due ?? 0,
  );
  run(
    db,
    `UPDATE patients SET status = 'archived', deleted_at = ?, deleted_by = ?, delete_reason = ?, updated_at = ? WHERE id = ?`,
    [nowIso(), ctx.user?.id ?? null, reason, nowIso(), patientId],
  );
  removeFromIndex(db, 'patient', patientId);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'archive',
    module: 'patients',
    entity: 'patient',
    entityId: patientId,
    summary: `Patient ${patient.patient_code} archived${openBalance > 0 ? ` with outstanding balance ${openBalance}` : ''}`,
    severity: 'warning',
    before: { status: patient.status },
    after: { status: 'archived', reason },
  });
  return { archived: true, outstandingMinor: openBalance };
}

export function restorePatient(db, ctx, patientId) {
  const patient = get(db, 'SELECT * FROM patients WHERE id = ? AND clinic_id = ? AND deleted_at IS NOT NULL', [
    patientId,
    ctx.clinicId,
  ]);
  if (!patient) throw new NotFoundError('patient', patientId);
  run(db, "UPDATE patients SET status = 'active', deleted_at = NULL, deleted_by = NULL, delete_reason = NULL, updated_at = ? WHERE id = ?", [
    nowIso(),
    patientId,
  ]);
  indexPatient(db, patientId);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'restore',
    module: 'patients',
    entity: 'patient',
    entityId: patientId,
    summary: `Patient ${patient.patient_code} restored`,
    severity: 'notice',
  });
  return { restored: true };
}

/**
 * Permanent deletion. Guarded by: an explicit confirmation string equal to the
 * patient code, the `patients.archive` permission and a clean financial record.
 */
export function deletePatientPermanently(db, ctx, patientId, { confirmation }) {
  const patient = get(db, 'SELECT * FROM patients WHERE id = ? AND clinic_id = ?', [patientId, ctx.clinicId]);
  if (!patient) throw new NotFoundError('patient', patientId);
  if (String(confirmation ?? '').trim() !== patient.patient_code) {
    throw new ValidationError('validation.failed', [{ field: 'confirmation', key: 'patients.confirmDeleteMismatch' }]);
  }
  const financial = get(
    db,
    `SELECT
       (SELECT COUNT(*) FROM invoices WHERE patient_id = ?) AS invoices,
       (SELECT COUNT(*) FROM payments WHERE patient_id = ?) AS payments`,
    [patientId, patientId],
  );
  if (Number(financial?.invoices ?? 0) > 0 || Number(financial?.payments ?? 0) > 0) {
    throw new AppError('Patient has financial records', {
      code: 'has_financial_records',
      status: 409,
      messageKey: 'patients.cannotDeleteFinancial',
    });
  }
  return withTransaction(db, () => {
    const attachments = all(db, 'SELECT id FROM attachments WHERE patient_id = ?', [patientId]).map((row) => row.id);
    run(db, 'DELETE FROM attachments WHERE patient_id = ?', [patientId]);
    run(db, 'DELETE FROM dental_chart_entries WHERE patient_id = ?', [patientId]);
    run(db, 'DELETE FROM patient_notes WHERE patient_id = ?', [patientId]);
    run(db, 'DELETE FROM patient_contacts WHERE patient_id = ?', [patientId]);
    run(db, 'DELETE FROM patient_medical WHERE patient_id = ?', [patientId]);
    run(db, 'DELETE FROM patient_dental WHERE patient_id = ?', [patientId]);
    run(db, 'DELETE FROM patient_custom_values WHERE patient_id = ?', [patientId]);
    run(db, 'DELETE FROM visits WHERE patient_id = ?', [patientId]);
    run(db, 'DELETE FROM treatments WHERE patient_id = ?', [patientId]);
    run(db, 'DELETE FROM treatment_plans WHERE patient_id = ?', [patientId]);
    run(db, 'DELETE FROM prescriptions WHERE patient_id = ?', [patientId]);
    run(db, 'DELETE FROM referrals WHERE patient_id = ?', [patientId]);
    run(db, 'DELETE FROM appointments WHERE patient_id = ?', [patientId]);
    run(db, 'DELETE FROM queue_entries WHERE patient_id = ?', [patientId]);
    run(db, 'DELETE FROM patients WHERE id = ?', [patientId]);
    removeFromIndex(db, 'patient', patientId);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'delete',
      module: 'patients',
      entity: 'patient',
      entityId: patientId,
      summary: `Patient ${patient.patient_code} permanently deleted`,
      severity: 'critical',
      before: { patient_code: patient.patient_code, full_name: patient.full_name, deleted_attachments: attachments.length },
    });
    return { deleted: true, attachmentsRemoved: attachments.length };
  });
}

/** Notes tab (§ 19.13). */
export function listNotes(db, ctx, patientId, { includeArchived = false } = {}) {
  return all(
    db,
    `SELECT n.*, u.display_name AS author_name
       FROM patient_notes n
       LEFT JOIN users u ON u.id = n.created_by
      WHERE n.patient_id = ? ${includeArchived ? '' : 'AND n.deleted_at IS NULL'}
      ORDER BY n.is_pinned DESC, n.created_at DESC`,
    [patientId],
  );
}

const noteSchema = {
  note: { type: 'text', required: true, maxLength: 4000 },
  category: { type: 'enum', values: ['general', 'clinical', 'administrative', 'billing', 'followup'], default: 'general' },
  is_pinned: { type: 'boolean', default: false },
  visit_id: { type: 'id', nullable: true },
};

export function addNote(db, ctx, patientId, input) {
  const patient = get(db, 'SELECT id FROM patients WHERE id = ? AND clinic_id = ?', [patientId, ctx.clinicId]);
  if (!patient) throw new NotFoundError('patient', patientId);
  const values = assertValid(input, noteSchema);
  const result = run(
    db,
    'INSERT INTO patient_notes (patient_id, note, category, is_pinned, visit_id, created_by) VALUES (?,?,?,?,?,?)',
    [patientId, values.note, values.category, values.is_pinned ? 1 : 0, values.visit_id ?? null, ctx.user?.id ?? null],
  );
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'add_note',
    module: 'patients',
    entity: 'patient_note',
    entityId: Number(result.lastInsertRowid),
    summary: `Note added to patient #${patientId}`,
    severity: 'info',
  });
  return { id: Number(result.lastInsertRowid) };
}

export function updateNote(db, ctx, noteId, input) {
  const note = get(db, 'SELECT * FROM patient_notes WHERE id = ?', [noteId]);
  if (!note) throw new NotFoundError('patient_note', noteId);
  const values = assertValid(input, { note: noteSchema.note, category: noteSchema.category, is_pinned: noteSchema.is_pinned }, { partial: true });
  if (!Object.keys(values).length) return note;
  const columns = Object.keys(values);
  run(
    db,
    `UPDATE patient_notes SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    [...columns.map((c) => (typeof values[c] === 'boolean' ? (values[c] ? 1 : 0) : values[c])), nowIso(), noteId],
  );
  return get(db, 'SELECT * FROM patient_notes WHERE id = ?', [noteId]);
}

export function deleteNote(db, ctx, noteId) {
  const note = get(db, 'SELECT * FROM patient_notes WHERE id = ?', [noteId]);
  if (!note) throw new NotFoundError('patient_note', noteId);
  run(db, 'UPDATE patient_notes SET deleted_at = ? WHERE id = ?', [nowIso(), noteId]);
  return { deleted: true };
}

/**
 * Chronological timeline for the Patient 360° profile (§ 29).
 * Built as a UNION in SQL so it stays fast on large histories.
 */
/**
 * @param {any} db
 * @param {any} ctx
 * @param {number} patientId
 * @param {{ limit?: number, types?: string[]|null }} [options]
 */
export function patientTimeline(db, ctx, patientId, { limit = 60, types = null } = {}) {
  const wanted = types?.length ? types : ['visit', 'treatment', 'prescription', 'referral', 'appointment', 'invoice', 'payment', 'attachment', 'note', 'registration', 'chart'];
  const parts = [];
  const args = [];
  const push = (type, sql, params) => {
    if (!wanted.includes(type)) return;
    parts.push(sql);
    args.push(...params);
  };

  push(
    'registration',
    `SELECT 'registration' AS event_type, p.registered_on AS event_date, p.created_at AS created_at,
            'patients.event.registered' AS title_key, NULL AS title_text, p.patient_code AS reference,
            p.id AS reference_id, NULL AS amount_minor, NULL AS meta FROM patients p WHERE p.id = ?`,
    [patientId],
  );
  push(
    'visit',
    `SELECT 'visit', v.visit_date, v.created_at, 'patients.event.visit', COALESCE(v.diagnosis, v.chief_complaint), v.visit_code, v.id,
            NULL, v.status FROM visits v WHERE v.patient_id = ? AND v.deleted_at IS NULL`,
    [patientId],
  );
  push(
    'treatment',
    `SELECT 'treatment', t.treatment_date, t.created_at, 'patients.event.treatment', t.name, NULL, t.id, t.total_minor, t.status
       FROM treatments t WHERE t.patient_id = ? AND t.deleted_at IS NULL`,
    [patientId],
  );
  push(
    'prescription',
    `SELECT 'prescription', rx.rx_date, rx.created_at, 'patients.event.prescription', rx.diagnosis, rx.rx_code, rx.id, NULL, NULL
       FROM prescriptions rx WHERE rx.patient_id = ? AND rx.deleted_at IS NULL`,
    [patientId],
  );
  push(
    'referral',
    `SELECT 'referral', r.referral_date, r.created_at, 'patients.event.referral', r.provider_name, r.referral_code, r.id, NULL, r.status
       FROM referrals r WHERE r.patient_id = ? AND r.deleted_at IS NULL`,
    [patientId],
  );
  push(
    'appointment',
    `SELECT 'appointment', a.appt_date, a.created_at, 'patients.event.appointment', COALESCE(a.type_label, a.reason), a.appointment_code, a.id, NULL, a.status
       FROM appointments a WHERE a.patient_id = ? AND a.deleted_at IS NULL`,
    [patientId],
  );
  push(
    'invoice',
    `SELECT 'invoice', i.invoice_date, i.created_at, 'patients.event.invoice', i.invoice_number, i.invoice_number, i.id, i.total_minor, i.status
       FROM invoices i WHERE i.patient_id = ? AND i.deleted_at IS NULL`,
    [patientId],
  );
  push(
    'payment',
    `SELECT 'payment', pm.payment_date, pm.created_at, 'patients.event.payment', pm.receipt_number, pm.receipt_number, pm.id, pm.amount_minor, pm.kind
       FROM payments pm WHERE pm.patient_id = ? AND pm.deleted_at IS NULL AND pm.voided_at IS NULL`,
    [patientId],
  );
  push(
    'attachment',
    `SELECT 'attachment', COALESCE(at.captured_on, substr(at.created_at,1,10)), at.created_at, 'patients.event.attachment', at.original_name, at.category, at.id, NULL, NULL
       FROM attachments at WHERE at.patient_id = ? AND at.deleted_at IS NULL`,
    [patientId],
  );
  push(
    'note',
    `SELECT 'note', substr(n.created_at,1,10), n.created_at, 'patients.event.note', n.note, n.category, n.id, NULL, NULL
       FROM patient_notes n WHERE n.patient_id = ? AND n.deleted_at IS NULL`,
    [patientId],
  );
  push(
    'chart',
    `SELECT 'chart', substr(d.recorded_at,1,10), d.recorded_at, 'patients.event.chart', tc.label_en, d.tooth_code, d.id, NULL, d.status
       FROM dental_chart_entries d JOIN tooth_conditions tc ON tc.code = d.condition_code
      WHERE d.patient_id = ? AND d.is_active = 1`,
    [patientId],
  );

  if (!parts.length) return [];
  const sql = `SELECT * FROM (${parts.join(' UNION ALL ')}) ORDER BY event_date DESC, created_at DESC LIMIT ?`;
  return all(db, sql, [...args, Math.min(400, Math.max(1, limit))]);
}

/** Recalculate a denormalised helper column after visit changes. */
export function recalcPatientLastVisit(db, patientId) {
  const row = get(db, 'SELECT MAX(visit_date) AS last_visit FROM visits WHERE patient_id = ? AND deleted_at IS NULL', [
    patientId,
  ]);
  run(db, 'UPDATE patients SET last_visit_on = ? WHERE id = ?', [row?.last_visit ?? null, patientId]);
  return row?.last_visit ?? null;
}

export function patientListSummary(db, ctx) {
  const row = get(
    db,
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END) AS inactive,
       SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived,
       SUM(CASE WHEN registered_on = ? THEN 1 ELSE 0 END) AS registered_today
     FROM patients WHERE clinic_id = ? AND deleted_at IS NULL`,
    [todayIso(), ctx.clinicId],
  );
  return {
    total: Number(row?.total ?? 0),
    active: Number(row?.active ?? 0),
    inactive: Number(row?.inactive ?? 0),
    archived: Number(row?.archived ?? 0),
    registeredToday: Number(row?.registered_today ?? 0),
  };
}
