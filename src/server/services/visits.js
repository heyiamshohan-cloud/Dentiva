/**
 * Clinical visits (§ 21).
 *
 * A visit is the clinical encounter record: complaint, examination, diagnosis,
 * procedures, materials, medication, instructions and follow-up. Visits are the
 * single source of truth for visit counts (§ 20) and drive the clinical history,
 * the timeline and most reports.
 */
import { all, get, run, withTransaction, nowIso } from '../db/connection.js';
import { resolvePaging, placeholders } from '../db/query.js';
import { assertValid } from '../domain/validation.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import { VISIT_STATUSES } from '../../shared/constants.js';
import { todayIso } from '../domain/dates.js';
import { assertValidIsoTime } from '../domain/dates.js';
import { nextNumber } from './numbering.js';
import { recordAudit, diffForAudit } from './audit.js';
import { indexVisit, removeFromIndex } from './search.js';
import { recalcPatientLastVisit } from './patients.js';

export const visitSchema = {
  patient_id: { type: 'id', required: true },
  visit_date: { type: 'date', required: true, default: () => todayIso() },
  visit_time: { type: 'time', nullable: true },
  practitioner_id: { type: 'id', nullable: true },
  appointment_id: { type: 'id', nullable: true },
  chief_complaint: { type: 'text', maxLength: 1000, nullable: true },
  reason: { type: 'text', maxLength: 1000, nullable: true },
  symptoms: { type: 'text', maxLength: 2000, nullable: true },
  examination: { type: 'text', maxLength: 4000, nullable: true },
  diagnosis: { type: 'text', maxLength: 2000, nullable: true },
  procedure_summary: { type: 'text', maxLength: 4000, nullable: true },
  materials: { type: 'text', maxLength: 2000, nullable: true },
  medication: { type: 'text', maxLength: 2000, nullable: true },
  instructions: { type: 'text', maxLength: 2000, nullable: true },
  followup_date: { type: 'date', nullable: true },
  clinical_notes: { type: 'text', maxLength: 6000, nullable: true },
  status: { type: 'enum', values: VISIT_STATUSES, default: 'completed' },
  diagnoses: { type: 'array', default: [] },
};

/** Shape a visit row for the API. */
export function shapeVisit(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    patientId: Number(row.patient_id),
    patientName: row.patient_name ?? null,
    patientCode: row.patient_code ?? null,
    visitCode: row.visit_code,
    visitDate: row.visit_date,
    visitTime: row.visit_time,
    practitionerId: row.practitioner_id ?? null,
    practitionerName: row.practitioner_name ?? null,
    appointmentId: row.appointment_id ?? null,
    chiefComplaint: row.chief_complaint,
    reason: row.reason,
    symptoms: row.symptoms,
    examination: row.examination,
    diagnosis: row.diagnosis,
    procedureSummary: row.procedure_summary,
    materials: row.materials,
    medication: row.medication,
    instructions: row.instructions,
    followupDate: row.followup_date,
    clinicalNotes: row.clinical_notes,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    treatmentCount: row.treatment_count === undefined ? undefined : Number(row.treatment_count),
    attachmentCount: row.attachment_count === undefined ? undefined : Number(row.attachment_count),
    prescriptionCount: row.prescription_count === undefined ? undefined : Number(row.prescription_count),
  };
}

const VISIT_SELECT = `
  SELECT v.*, p.full_name AS patient_name, p.patient_code, s.full_name AS practitioner_name
    FROM visits v
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN staff s ON s.id = v.practitioner_id`;

/**
 * Paged visit list with the filters used by the Clinical history and the
 * global Visits screen.
 */
export function listVisits(db, ctx, params = {}) {
  const where = ['v.clinic_id = ?', 'v.deleted_at IS NULL'];
  const args = [ctx.clinicId];
  if (params.patientId) {
    where.push('v.patient_id = ?');
    args.push(Number(params.patientId));
  }
  if (params.practitionerId) {
    where.push('v.practitioner_id = ?');
    args.push(Number(params.practitionerId));
  }
  if (params.status && VISIT_STATUSES.includes(params.status)) {
    where.push('v.status = ?');
    args.push(params.status);
  }
  if (params.from) {
    where.push('v.visit_date >= ?');
    args.push(params.from);
  }
  if (params.to) {
    where.push('v.visit_date <= ?');
    args.push(params.to);
  }
  if (params.followupFrom) {
    where.push('v.followup_date >= ?');
    args.push(params.followupFrom);
  }
  if (params.followupTo) {
    where.push('v.followup_date <= ?');
    args.push(params.followupTo);
  }
  if (params.search) {
    where.push(
      "(p.full_name LIKE ? ESCAPE '\\' OR p.patient_code LIKE ? ESCAPE '\\' OR v.visit_code LIKE ? ESCAPE '\\' OR COALESCE(v.diagnosis,'') LIKE ? ESCAPE '\\' OR COALESCE(v.chief_complaint,'') LIKE ? ESCAPE '\\')",
    );
    const pattern = `%${String(params.search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(pattern, pattern, pattern, pattern, pattern);
  }

  const page = resolvePaging(params);
  const whereSql = where.join(' AND ');
  const total = Number(get(db, `SELECT COUNT(*) AS c FROM visits v JOIN patients p ON p.id = v.patient_id WHERE ${whereSql}`, args)?.c ?? 0);
  const rows = all(
    db,
    `${VISIT_SELECT} WHERE ${whereSql} ORDER BY v.visit_date DESC, v.id DESC LIMIT ? OFFSET ?`,
    [...args, page.pageSize, page.offset],
  );
  return {
    rows: rows.map(shapeVisit),
    total,
    page: page.page,
    pageSize: page.pageSize,
    pages: Math.max(1, Math.ceil(total / page.pageSize)),
  };
}

/** Complete visit record including related treatments, prescriptions and files. */
export function getVisit(db, ctx, visitId) {
  const row = get(db, `${VISIT_SELECT} WHERE v.id = ? AND v.clinic_id = ? AND v.deleted_at IS NULL`, [visitId, ctx.clinicId]);
  if (!row) throw new NotFoundError('visit', visitId);
  const diagnoses = all(
    db,
    `SELECT vd.*, d.label_en AS catalogue_label FROM visit_diagnoses vd
     LEFT JOIN diagnoses d ON d.id = vd.diagnosis_id WHERE vd.visit_id = ? ORDER BY vd.id`,
    [visitId],
  );
  const treatments = all(
    db,
    'SELECT * FROM treatments WHERE visit_id = ? AND deleted_at IS NULL ORDER BY treatment_date, id',
    [visitId],
  );
  const prescriptions = all(
    db,
    'SELECT id, rx_code, rx_date, diagnosis FROM prescriptions WHERE visit_id = ? AND deleted_at IS NULL ORDER BY id',
    [visitId],
  );
  const chartEntries = all(
    db,
    `SELECT de.*, tc.label_en, tc.color, tc.category FROM dental_chart_entries de
       JOIN tooth_conditions tc ON tc.code = de.condition_code
      WHERE de.visit_id = ? AND de.is_active = 1 ORDER BY de.tooth_code`,
    [visitId],
  );
  const attachments = all(
    db,
    'SELECT id, original_name, category, extension, size_bytes, created_at, title FROM attachments WHERE visit_id = ? AND deleted_at IS NULL ORDER BY created_at DESC',
    [visitId],
  );
  const invoices = all(
    db,
    'SELECT id, invoice_number, invoice_date, status, total_minor, due_minor FROM invoices WHERE visit_id = ? AND deleted_at IS NULL ORDER BY id',
    [visitId],
  );
  return {
    ...shapeVisit(row),
    diagnoses: diagnoses.map((item) => ({
      id: item.id,
      diagnosisId: item.diagnosis_id,
      label: item.label ?? item.catalogue_label,
      toothCodes: safeParse(item.tooth_codes, []),
      notes: item.notes,
    })),
    treatments: treatments.map((item) => ({
      id: item.id,
      name: item.name,
      toothCodes: safeParse(item.tooth_codes, []),
      status: item.status,
      feeMinor: Number(item.fee_minor),
      totalMinor: Number(item.total_minor),
      treatmentDate: item.treatment_date,
    })),
    prescriptions,
    chartEntries: chartEntries.map((item) => ({
      id: item.id,
      toothCode: item.tooth_code,
      conditionCode: item.condition_code,
      label: item.label_en,
      color: item.color,
      surfaces: safeParse(item.surfaces, []),
      status: item.status,
      notes: item.notes,
    })),
    attachments,
    invoices,
  };
}

function safeParse(value, fallback) {
  if (!value) return fallback;
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return String(value)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }
}

/**
 * Open a clinical visit.
 * When the visit originates from an appointment, the appointment is marked
 * completed and linked — the queue and dashboard then stay consistent.
 */
export function createVisit(db, ctx, input) {
  const values = assertValid(input, visitSchema);
  if (values.visit_time && !assertValidIsoTime(values.visit_time)) {
    throw new ValidationError('validation.failed', [{ field: 'visit_time', key: 'validation.time' }]);
  }
  const patient = get(db, 'SELECT id, patient_code, full_name FROM patients WHERE id = ? AND clinic_id = ?', [
    values.patient_id,
    ctx.clinicId,
  ]);
  if (!patient) throw new NotFoundError('patient', values.patient_id);
  if (values.practitioner_id) {
    const practitioner = get(db, 'SELECT id FROM staff WHERE id = ? AND clinic_id = ?', [values.practitioner_id, ctx.clinicId]);
    if (!practitioner) throw new NotFoundError('practitioner', values.practitioner_id);
  }

  return withTransaction(db, () => {
    const allocation = nextNumber(db, ctx.clinicId, 'visit');
    const result = run(
      db,
      `INSERT INTO visits
        (clinic_id, patient_id, visit_code, visit_date, visit_time, practitioner_id, appointment_id, chief_complaint,
         reason, symptoms, examination, diagnosis, procedure_summary, materials, medication, instructions,
         followup_date, clinical_notes, status, created_by, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ctx.clinicId,
        values.patient_id,
        allocation.code,
        values.visit_date,
        values.visit_time ?? null,
        values.practitioner_id ?? null,
        values.appointment_id ?? null,
        values.chief_complaint ?? null,
        values.reason ?? null,
        values.symptoms ?? null,
        values.examination ?? null,
        values.diagnosis ?? null,
        values.procedure_summary ?? null,
        values.materials ?? null,
        values.medication ?? null,
        values.instructions ?? null,
        values.followup_date ?? null,
        values.clinical_notes ?? null,
        values.status,
        ctx.user?.id ?? null,
        ctx.user?.id ?? null,
      ],
    );
    const visitId = Number(result.lastInsertRowid);

    if (Array.isArray(values.diagnoses) && values.diagnoses.length) {
      replaceVisitDiagnoses(db, visitId, values.diagnoses);
    }
    if (values.appointment_id) {
      run(
        db,
        `UPDATE appointments SET visit_id = ?, status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND clinic_id = ?`,
        [visitId, nowIso(), nowIso(), values.appointment_id, ctx.clinicId],
      );
      run(db, `UPDATE queue_entries SET status = 'completed', completed_at = ? WHERE appointment_id = ?`, [
        nowIso(),
        values.appointment_id,
      ]);
    }
    recalcPatientLastVisit(db, values.patient_id);
    indexVisit(db, visitId);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'create',
      module: 'clinical',
      entity: 'visit',
      entityId: visitId,
      summary: `Visit ${allocation.code} recorded for ${patient.patient_code}`,
      severity: 'info',
      after: { visit_code: allocation.code, visit_date: values.visit_date, diagnosis: values.diagnosis ?? null },
      ip: ctx.ip,
    });
    return { id: visitId, visitCode: allocation.code };
  });
}

function replaceVisitDiagnoses(db, visitId, diagnoses) {
  run(db, 'DELETE FROM visit_diagnoses WHERE visit_id = ?', [visitId]);
  for (const item of diagnoses) {
    const label = String(item.label ?? item.label_en ?? '').trim();
    if (!label) continue;
    run(
      db,
      'INSERT INTO visit_diagnoses (visit_id, diagnosis_id, label, tooth_codes, notes) VALUES (?,?,?,?,?)',
      [
        visitId,
        item.diagnosis_id ?? item.diagnosisId ?? null,
        label,
        JSON.stringify(item.tooth_codes ?? item.toothCodes ?? []),
        item.notes ?? null,
      ],
    );
  }
}

export function updateVisit(db, ctx, visitId, input) {
  const before = get(db, 'SELECT * FROM visits WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [visitId, ctx.clinicId]);
  if (!before) throw new NotFoundError('visit', visitId);
  const { diagnoses, ...schema } = visitSchema;
  const values = assertValid(input, schema, { partial: true });
  if (values.visit_time && !assertValidIsoTime(values.visit_time)) {
    throw new ValidationError('validation.failed', [{ field: 'visit_time', key: 'validation.time' }]);
  }
  const columns = Object.keys(values);
  return withTransaction(db, () => {
    if (columns.length) {
      run(db, `UPDATE visits SET ${columns.map((col) => `${col} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`, [
        ...columns.map((col) => values[col]),
        ctx.user?.id ?? null,
        nowIso(),
        visitId,
      ]);
    }
    if (input.diagnoses !== undefined) replaceVisitDiagnoses(db, visitId, input.diagnoses);
    const after = get(db, 'SELECT * FROM visits WHERE id = ?', [visitId]);
    const diff = diffForAudit(before, after, columns);
    recalcPatientLastVisit(db, before.patient_id);
    indexVisit(db, visitId);
    if (diff.changed.length || input.diagnoses !== undefined) {
      recordAudit(db, {
        clinicId: ctx.clinicId,
        userId: ctx.user?.id ?? null,
        userName: ctx.user?.displayName ?? null,
        action: 'update',
        module: 'clinical',
        entity: 'visit',
        entityId: visitId,
        summary: `Visit ${before.visit_code} updated (${diff.changed.join(', ') || 'diagnoses'})`,
        severity: 'notice',
        before: diff.before,
        after: diff.after,
      });
    }
    return { id: visitId, changed: diff.changed };
  });
}

/** Soft delete keeps the clinical history auditable; the audit log records who. */
/**
 * Soft-delete a visit.
 * @param {any} db
 * @param {any} ctx
 * @param {number} visitId
 * @param {string|null} [reason]
 */
export function deleteVisit(db, ctx, visitId, reason = null) {
  const visit = get(db, 'SELECT * FROM visits WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [visitId, ctx.clinicId]);
  if (!visit) throw new NotFoundError('visit', visitId);
  return withTransaction(db, () => {
    run(db, 'UPDATE visits SET deleted_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), visitId]);
    removeFromIndex(db, 'visit', visitId);
    recalcPatientLastVisit(db, visit.patient_id);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'delete',
      module: 'clinical',
      entity: 'visit',
      entityId: visitId,
      summary: `Visit ${visit.visit_code} deleted${reason ? `: ${reason}` : ''}`,
      severity: 'warning',
      before: { visit_code: visit.visit_code, visit_date: visit.visit_date, diagnosis: visit.diagnosis },
    });
    return { deleted: true };
  });
}

/** Compact clinical history used by the Patient 360° "Clinical history" tab. */
export function patientClinicalHistory(db, ctx, patientId, { limit = 100 } = {}) {
  const visits = all(
    db,
    `${VISIT_SELECT} WHERE v.patient_id = ? AND v.clinic_id = ? AND v.deleted_at IS NULL
      ORDER BY v.visit_date DESC, v.id DESC LIMIT ?`,
    [patientId, ctx.clinicId, Math.min(500, Math.max(1, limit))],
  );
  if (!visits.length) return [];
  const ids = visits.map((v) => v.id);
  const treatmentCounts = new Map();
  for (const row of all(
    db,
    `SELECT visit_id, COUNT(*) AS c FROM treatments WHERE visit_id IN (${placeholders(ids.length)}) AND deleted_at IS NULL GROUP BY visit_id`,
    ids,
  )) {
    treatmentCounts.set(row.visit_id, Number(row.c));
  }
  const prescriptionCounts = new Map();
  for (const row of all(
    db,
    `SELECT visit_id, COUNT(*) AS c FROM prescriptions WHERE visit_id IN (${placeholders(ids.length)}) AND deleted_at IS NULL GROUP BY visit_id`,
    ids,
  )) {
    prescriptionCounts.set(row.visit_id, Number(row.c));
  }
  return visits.map((row) =>
    shapeVisit({
      ...row,
      treatment_count: treatmentCounts.get(row.id) ?? 0,
      prescription_count: prescriptionCounts.get(row.id) ?? 0,
    }),
  );
}

/** Follow-ups due (dashboard + notifications). */
/**
 * @param {any} db
 * @param {any} ctx
 * @param {{ from?: string, to?: string|null, limit?: number }} [options]
 */
export function followupsDue(db, ctx, { from = todayIso(), to = null, limit = 50 } = {}) {
  const where = ['v.clinic_id = ?', 'v.deleted_at IS NULL', 'v.followup_date IS NOT NULL', 'v.followup_date >= ?'];
  const args = [ctx.clinicId, from];
  if (to) {
    where.push('v.followup_date <= ?');
    args.push(to);
  }
  return all(
    db,
    `SELECT v.id, v.visit_code, v.visit_date, v.followup_date, v.diagnosis, v.instructions,
            p.id AS patient_id, p.full_name AS patient_name, p.patient_code, p.phone,
            (SELECT COUNT(*) FROM appointments a
              WHERE a.patient_id = p.id AND a.appt_date >= v.followup_date AND a.deleted_at IS NULL
                AND a.status IN ('scheduled','checked_in','waiting','in_treatment')) AS booked_appointments
       FROM visits v JOIN patients p ON p.id = v.patient_id
      WHERE ${where.join(' AND ')}
      ORDER BY v.followup_date ASC
      LIMIT ?`,
    [...args, Math.min(200, Math.max(1, limit))],
  );
}
