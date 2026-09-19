/**
 * Structured referral module (§ 25–27).
 *
 * A referral records who the patient was sent to, why, what came back and the
 * documents that travelled with it. Attachments stay linked to
 * Patient → Referral → Attachment so the report, X-ray or hospital summary is
 * always found in its clinical context.
 */
import { all, get, run, withTransaction, nowIso } from '../db/connection.js';
import { resolvePaging } from '../db/query.js';
import { assertValid } from '../domain/validation.js';
import { NotFoundError } from '../../shared/errors.js';
import { REFERRAL_STATUSES } from '../../shared/constants.js';
import { todayIso } from '../domain/dates.js';
import { nextNumber } from './numbering.js';
import { recordAudit } from './audit.js';
import { indexReferral, removeFromIndex } from './search.js';

export const referralSchema = {
  patient_id: { type: 'id', required: true },
  visit_id: { type: 'id', nullable: true },
  plan_id: { type: 'id', nullable: true },
  referral_date: { type: 'date', required: true, default: () => todayIso() },
  practitioner_id: { type: 'id', nullable: true },
  provider_name: { type: 'string', required: true, minLength: 2, maxLength: 160 },
  provider_title: { type: 'string', maxLength: 120, nullable: true },
  specialty: { type: 'string', maxLength: 120, nullable: true },
  institution: { type: 'string', maxLength: 160, nullable: true },
  provider_phone: { type: 'string', maxLength: 40, nullable: true },
  provider_email: { type: 'string', maxLength: 160, nullable: true },
  provider_address: { type: 'string', maxLength: 300, nullable: true },
  reason: { type: 'text', required: true, maxLength: 2000 },
  clinical_context: { type: 'text', maxLength: 4000, nullable: true },
  instructions: { type: 'text', maxLength: 2000, nullable: true },
  status: { type: 'enum', values: REFERRAL_STATUSES, default: 'draft' },
  followup_date: { type: 'date', nullable: true },
  outcome: { type: 'text', maxLength: 2000, nullable: true },
  outcome_notes: { type: 'text', maxLength: 4000, nullable: true },
  external_treatment_summary: { type: 'text', maxLength: 4000, nullable: true },
  returned_report_attachment_id: { type: 'id', nullable: true },
  notes: { type: 'text', maxLength: 2000, nullable: true },
};

export function shapeReferral(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    referralCode: row.referral_code,
    patientId: Number(row.patient_id),
    patientName: row.patient_name ?? null,
    patientCode: row.patient_code ?? null,
    visitId: row.visit_id ?? null,
    visitCode: row.visit_code ?? null,
    planId: row.plan_id ?? null,
    referralDate: row.referral_date,
    practitionerId: row.practitioner_id ?? null,
    practitionerName: row.practitioner_name ?? null,
    providerName: row.provider_name,
    providerTitle: row.provider_title,
    specialty: row.specialty,
    institution: row.institution,
    providerPhone: row.provider_phone,
    providerEmail: row.provider_email,
    providerAddress: row.provider_address,
    reason: row.reason,
    clinicalContext: row.clinical_context,
    instructions: row.instructions,
    status: row.status,
    sentOn: row.sent_on,
    followupDate: row.followup_date,
    outcome: row.outcome,
    outcomeNotes: row.outcome_notes,
    externalTreatmentSummary: row.external_treatment_summary,
    returnedReportAttachmentId: row.returned_report_attachment_id ?? null,
    notes: row.notes,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    attachmentCount: row.attachment_count === undefined ? undefined : Number(row.attachment_count),
  };
}

const REFERRAL_SELECT = `
  SELECT r.*, p.full_name AS patient_name, p.patient_code, s.full_name AS practitioner_name, v.visit_code
    FROM referrals r
    JOIN patients p ON p.id = r.patient_id
    LEFT JOIN staff s ON s.id = r.practitioner_id
    LEFT JOIN visits v ON v.id = r.visit_id`;

export function listReferrals(db, ctx, params = {}) {
  const where = ['r.clinic_id = ?', 'r.deleted_at IS NULL'];
  const args = [ctx.clinicId];
  if (params.patientId) {
    where.push('r.patient_id = ?');
    args.push(Number(params.patientId));
  }
  if (params.status && REFERRAL_STATUSES.includes(params.status)) {
    where.push('r.status = ?');
    args.push(params.status);
  }
  if (params.specialty) {
    where.push("r.specialty LIKE ? ESCAPE '\\'");
    args.push(`%${String(params.specialty).replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }
  if (params.provider) {
    where.push("(r.provider_name LIKE ? ESCAPE '\\' OR r.institution LIKE ? ESCAPE '\\')");
    const pattern = `%${String(params.provider).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(pattern, pattern);
  }
  if (params.from) {
    where.push('r.referral_date >= ?');
    args.push(params.from);
  }
  if (params.to) {
    where.push('r.referral_date <= ?');
    args.push(params.to);
  }
  if (params.pendingOnly === true || params.pendingOnly === 'true') {
    where.push("r.status IN ('referred','awaiting_response')");
  }
  if (params.followupDue) {
    where.push('r.followup_date IS NOT NULL AND r.followup_date <= ?');
    args.push(params.followupDue);
  }
  if (params.search) {
    where.push(
      "(r.referral_code LIKE ? ESCAPE '\\' OR r.provider_name LIKE ? ESCAPE '\\' OR p.full_name LIKE ? ESCAPE '\\' OR p.patient_code LIKE ? ESCAPE '\\' OR COALESCE(r.specialty,'') LIKE ? ESCAPE '\\')",
    );
    const pattern = `%${String(params.search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(pattern, pattern, pattern, pattern, pattern);
  }
  const page = resolvePaging(params);
  const whereSql = where.join(' AND ');
  const total = Number(
    get(db, `SELECT COUNT(*) AS c FROM referrals r JOIN patients p ON p.id = r.patient_id WHERE ${whereSql}`, args)?.c ?? 0,
  );
  const rows = all(
    db,
    `${REFERRAL_SELECT}
      WHERE ${whereSql}
      ORDER BY r.referral_date DESC, r.id DESC LIMIT ? OFFSET ?`,
    [...args, page.pageSize, page.offset],
  );
  const counts = get(
    db,
    `SELECT
        SUM(CASE WHEN r.status IN ('referred','awaiting_response') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN r.status = 'report_received' THEN 1 ELSE 0 END) AS reported
       FROM referrals r JOIN patients p ON p.id = r.patient_id WHERE ${whereSql}`,
    args,
  );
  return {
    rows: rows.map(shapeReferral),
    total,
    page: page.page,
    pageSize: page.pageSize,
    pages: Math.max(1, Math.ceil(total / page.pageSize)),
    summary: { pending: Number(counts?.pending ?? 0), reported: Number(counts?.reported ?? 0) },
  };
}

export function getReferral(db, ctx, referralId) {
  const row = get(db, `${REFERRAL_SELECT} WHERE r.id = ? AND r.clinic_id = ? AND r.deleted_at IS NULL`, [referralId, ctx.clinicId]);
  if (!row) throw new NotFoundError('referral', referralId);
  const attachments = all(
    db,
    `SELECT a.id, a.original_name, a.category, a.extension, a.mime_type, a.size_bytes, a.sha256, a.title,
            a.description, a.captured_on, a.created_at, u.display_name AS uploaded_by_name
       FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.referral_id = ? AND a.deleted_at IS NULL
      ORDER BY a.created_at DESC`,
    [referralId],
  );
  const visit = row.visit_id ? get(db, 'SELECT id, visit_code, visit_date, diagnosis FROM visits WHERE id = ?', [row.visit_id]) : null;
  const plan = row.plan_id ? get(db, 'SELECT id, plan_code, title, status FROM treatment_plans WHERE id = ?', [row.plan_id]) : null;
  return {
    ...shapeReferral(row),
    attachments: attachments.map((item) => ({
      id: Number(item.id),
      originalName: item.original_name,
      category: item.category,
      extension: item.extension,
      mimeType: item.mime_type,
      sizeBytes: Number(item.size_bytes),
      sha256: item.sha256,
      title: item.title,
      description: item.description,
      capturedOn: item.captured_on,
      uploadedAt: item.created_at,
      uploadedBy: item.uploaded_by_name,
      isReturnedReport: Number(item.id) === Number(row.returned_report_attachment_id),
    })),
    visit,
    plan,
  };
}

export function createReferral(db, ctx, input) {
  const values = assertValid(input, referralSchema);
  const patient = get(db, 'SELECT id, patient_code FROM patients WHERE id = ? AND clinic_id = ?', [values.patient_id, ctx.clinicId]);
  if (!patient) throw new NotFoundError('patient', values.patient_id);

  return withTransaction(db, () => {
    const allocation = nextNumber(db, ctx.clinicId, 'referral');
    const status = values.status === 'draft' ? 'draft' : values.status;
    const result = run(
      db,
      `INSERT INTO referrals
        (clinic_id, patient_id, visit_id, plan_id, referral_code, referral_date, practitioner_id, provider_name, provider_title,
         specialty, institution, provider_phone, provider_email, provider_address, reason, clinical_context, instructions, status,
         sent_on, followup_date, notes, created_by, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ctx.clinicId,
        values.patient_id,
        values.visit_id ?? null,
        values.plan_id ?? null,
        allocation.code,
        values.referral_date,
        values.practitioner_id ?? null,
        values.provider_name,
        values.provider_title ?? null,
        values.specialty ?? null,
        values.institution ?? null,
        values.provider_phone ?? null,
        values.provider_email ?? null,
        values.provider_address ?? null,
        values.reason,
        values.clinical_context ?? null,
        values.instructions ?? null,
        status,
        status === 'referred' ? nowIso() : null,
        values.followup_date ?? null,
        values.notes ?? null,
        ctx.user?.id ?? null,
        ctx.user?.id ?? null,
      ],
    );
    const referralId = Number(result.lastInsertRowid);
    indexReferral(db, referralId);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'create',
      module: 'referrals',
      entity: 'referral',
      entityId: referralId,
      summary: `Referral ${allocation.code} to ${values.provider_name} for ${patient.patient_code}`,
      severity: 'notice',
      after: { provider: values.provider_name, specialty: values.specialty ?? null, status },
      ip: ctx.ip,
    });
    return { id: referralId, referralCode: allocation.code };
  });
}

export function updateReferral(db, ctx, referralId, input) {
  const before = get(db, 'SELECT * FROM referrals WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [referralId, ctx.clinicId]);
  if (!before) throw new NotFoundError('referral', referralId);
  const values = assertValid(input, referralSchema, { partial: true });
  const columns = Object.keys(values);
  return withTransaction(db, () => {
    if (columns.length) {
      const sets = columns.map((col) => `${col} = ?`);
      const params = columns.map((col) => values[col]);
      if (values.status === 'referred' && !before.sent_on) {
        sets.push('sent_on = ?');
        params.push(nowIso());
      }
      if (values.status === 'completed' && !before.completed_at) {
        sets.push('completed_at = ?');
        params.push(nowIso());
      }
      run(db, `UPDATE referrals SET ${sets.join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`, [
        ...params,
        ctx.user?.id ?? null,
        nowIso(),
        referralId,
      ]);
    }
    const after = get(db, 'SELECT * FROM referrals WHERE id = ?', [referralId]);
    indexReferral(db, referralId);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: values.status && values.status !== before.status ? 'status_change' : 'update',
      module: 'referrals',
      entity: 'referral',
      entityId: referralId,
      summary: `Referral ${before.referral_code} updated${values.status && values.status !== before.status ? `: ${before.status} → ${values.status}` : ''}`,
      severity: 'notice',
      before: { status: before.status },
      after: { status: after.status },
    });
    return shapeReferral(after);
  });
}

/**
 * Record the external provider's outcome (§ 26) — what was found, what was done
 * and what the clinic should do next.
 */
export function recordReferralOutcome(db, ctx, referralId, input) {
  const before = get(db, 'SELECT * FROM referrals WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [referralId, ctx.clinicId]);
  if (!before) throw new NotFoundError('referral', referralId);
  const values = assertValid(
    input,
    {
      outcome: { type: 'text', maxLength: 2000, nullable: true },
      outcome_notes: { type: 'text', maxLength: 4000, nullable: true },
      external_treatment_summary: { type: 'text', maxLength: 4000, nullable: true },
      returned_report_attachment_id: { type: 'id', nullable: true },
      status: { type: 'enum', values: REFERRAL_STATUSES, default: 'report_received' },
      followup_date: { type: 'date', nullable: true },
    },
    { partial: true },
  );
  return withTransaction(db, () => {
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(values)) {
      sets.push(`${key} = ?`);
      params.push(value);
    }
    const status = values.status ?? 'report_received';
    sets.push('status = ?');
    params.push(status);
    if (status === 'completed') {
      sets.push('completed_at = ?');
      params.push(nowIso());
    }
    run(db, `UPDATE referrals SET ${sets.join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`, [
      ...params,
      ctx.user?.id ?? null,
      nowIso(),
      referralId,
    ]);
    indexReferral(db, referralId);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'record_outcome',
      module: 'referrals',
      entity: 'referral',
      entityId: referralId,
      summary: `Referral outcome recorded for ${before.referral_code} (${status})`,
      severity: 'notice',
      before: { status: before.status },
      after: { status, outcome: values.outcome ?? before.outcome },
    });
    return getReferral(db, ctx, referralId);
  });
}

/**
 * @param {any} db
 * @param {any} ctx
 * @param {number} referralId
 * @param {string|null} [reason]
 */
export function deleteReferral(db, ctx, referralId, reason = null) {
  const referral = get(db, 'SELECT * FROM referrals WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [referralId, ctx.clinicId]);
  if (!referral) throw new NotFoundError('referral', referralId);
  return withTransaction(db, () => {
    run(db, 'UPDATE referrals SET deleted_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), referralId]);
    removeFromIndex(db, 'referral', referralId);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'delete',
      module: 'referrals',
      entity: 'referral',
      entityId: referralId,
      summary: `Referral ${referral.referral_code} archived${reason ? `: ${reason}` : ''}`,
      severity: 'warning',
    });
    return { deleted: true };
  });
}

/** Distinct providers/specialities — powers the referral filters and autocomplete. */
export function referralDirectory(db, ctx) {
  const providers = all(
    db,
    `SELECT provider_name AS name, provider_title AS title, specialty, institution, provider_phone AS phone,
            provider_email AS email, provider_address AS address, COUNT(*) AS referrals,
            MAX(referral_date) AS last_referral
       FROM referrals
      WHERE clinic_id = ? AND deleted_at IS NULL
      GROUP BY lower(provider_name), COALESCE(specialty,'')
      ORDER BY referrals DESC, name LIMIT 200`,
    [ctx.clinicId],
  );
  const specialties = all(
    db,
    `SELECT COALESCE(specialty, '') AS specialty, COUNT(*) AS c FROM referrals
      WHERE clinic_id = ? AND deleted_at IS NULL AND COALESCE(specialty,'') <> ''
      GROUP BY lower(specialty) ORDER BY c DESC LIMIT 100`,
    [ctx.clinicId],
  );
  return {
    providers: providers.map((row) => ({ ...row, referrals: Number(row.referrals) })),
    specialties: specialties.map((row) => ({ specialty: row.specialty, count: Number(row.c) })),
  };
}
