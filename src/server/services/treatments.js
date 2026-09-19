/**
 * Treatments (§ 23) and the configurable service catalogue (§ 33, § 56).
 *
 * A treatment is a procedure actually performed. Its money is calculated from
 * quantity × unit price with discount and tax in integer minor units, and it can
 * be billed (linked to an invoice item) or remain unbilled until the invoice is
 * raised — the clinic decides when to charge.
 */
import { all, get, run, withTransaction, nowIso } from '../db/connection.js';
import { resolvePaging, placeholders } from '../db/query.js';
import { assertValid } from '../domain/validation.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import { TREATMENT_STATUSES } from '../../shared/constants.js';
import { todayIso } from '../domain/dates.js';
import { calculateLine, parseAmount, parsePercentToBp } from '../domain/money.js';
import { recordAudit, diffForAudit } from './audit.js';
import { indexTreatment, removeFromIndex } from './search.js';
import { addChartEntry, isValidToothCode } from './dentalChart.js';

export const treatmentSchema = {
  patient_id: { type: 'id', required: true },
  visit_id: { type: 'id', nullable: true },
  plan_id: { type: 'id', nullable: true },
  plan_item_id: { type: 'id', nullable: true },
  service_id: { type: 'id', nullable: true },
  name: { type: 'string', required: true, minLength: 2, maxLength: 200 },
  tooth_codes: { type: 'array', default: [] },
  treatment_date: { type: 'date', required: true, default: () => todayIso() },
  practitioner_id: { type: 'id', nullable: true },
  anesthesia: { type: 'string', maxLength: 120, nullable: true },
  materials: { type: 'text', maxLength: 2000, nullable: true },
  notes: { type: 'text', maxLength: 2000, nullable: true },
  status: { type: 'enum', values: TREATMENT_STATUSES, default: 'completed' },
  fee_minor: { type: 'int', min: 0, nullable: true },
  discount_minor: { type: 'int', min: 0, default: 0 },
  tax_rate_bp: { type: 'int', min: 0, max: 10000, default: 0 },
  quantity_milli: { type: 'int', min: 0, default: 1000 },
  chart_condition_code: { type: 'string', maxLength: 40, nullable: true },
};

export function shapeTreatment(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    patientId: Number(row.patient_id),
    patientName: row.patient_name ?? null,
    patientCode: row.patient_code ?? null,
    visitId: row.visit_id ?? null,
    visitCode: row.visit_code ?? null,
    planId: row.plan_id ?? null,
    planItemId: row.plan_item_id ?? null,
    serviceId: row.service_id ?? null,
    name: row.name,
    toothCodes: safeArray(row.tooth_codes),
    treatmentDate: row.treatment_date,
    practitionerId: row.practitioner_id ?? null,
    practitionerName: row.practitioner_name ?? null,
    anesthesia: row.anesthesia,
    materials: row.materials,
    notes: row.notes,
    status: row.status,
    feeMinor: Number(row.fee_minor),
    discountMinor: Number(row.discount_minor),
    taxMinor: Number(row.tax_minor),
    quantityMilli: Number(row.quantity_milli ?? 1000),
    taxRateBp: Number(row.tax_rate_bp ?? 0),
    totalMinor: Number(row.total_minor),
    invoiceId: row.invoice_id ?? null,
    invoiceNumber: row.invoice_number ?? null,
    createdAt: row.created_at,
  };
}

function safeArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return String(value)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }
}

const TREATMENT_SELECT = `
  SELECT t.*, p.full_name AS patient_name, p.patient_code, s.full_name AS practitioner_name,
         v.visit_code, i.invoice_number
    FROM treatments t
    JOIN patients p ON p.id = t.patient_id
    LEFT JOIN staff s ON s.id = t.practitioner_id
    LEFT JOIN visits v ON v.id = t.visit_id
    LEFT JOIN invoices i ON i.id = t.invoice_id`;

export function listTreatments(db, ctx, params = {}) {
  const where = ['t.clinic_id = ?', 't.deleted_at IS NULL'];
  const args = [ctx.clinicId];
  if (params.patientId) {
    where.push('t.patient_id = ?');
    args.push(Number(params.patientId));
  }
  if (params.visitId) {
    where.push('t.visit_id = ?');
    args.push(Number(params.visitId));
  }
  if (params.planId) {
    where.push('t.plan_id = ?');
    args.push(Number(params.planId));
  }
  if (params.practitionerId) {
    where.push('t.practitioner_id = ?');
    args.push(Number(params.practitionerId));
  }
  if (params.status && TREATMENT_STATUSES.includes(params.status)) {
    where.push('t.status = ?');
    args.push(params.status);
  }
  if (params.unbilled === true || params.unbilled === 'true') {
    where.push("t.invoice_id IS NULL AND t.status = 'completed' AND t.total_minor > 0");
  }
  if (params.tooth) {
    where.push("t.tooth_codes LIKE ? ESCAPE '\\'");
    args.push(`%"${String(params.tooth)}"%`);
  }
  if (params.from) {
    where.push('t.treatment_date >= ?');
    args.push(params.from);
  }
  if (params.to) {
    where.push('t.treatment_date <= ?');
    args.push(params.to);
  }
  if (params.search) {
    where.push("(t.name LIKE ? ESCAPE '\\' OR p.full_name LIKE ? ESCAPE '\\' OR p.patient_code LIKE ? ESCAPE '\\')");
    const pattern = `%${String(params.search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(pattern, pattern, pattern);
  }
  const page = resolvePaging(params);
  const whereSql = where.join(' AND ');
  const total = Number(
    get(db, `SELECT COUNT(*) AS c FROM treatments t JOIN patients p ON p.id = t.patient_id WHERE ${whereSql}`, args)?.c ?? 0,
  );
  const rows = all(db, `${TREATMENT_SELECT} WHERE ${whereSql} ORDER BY t.treatment_date DESC, t.id DESC LIMIT ? OFFSET ?`, [
    ...args,
    page.pageSize,
    page.offset,
  ]);
  const totals = get(
    db,
    `SELECT COALESCE(SUM(t.total_minor),0) AS total, COALESCE(SUM(t.discount_minor),0) AS discount
       FROM treatments t JOIN patients p ON p.id = t.patient_id WHERE ${whereSql} AND t.status <> 'cancelled'`,
    args,
  );
  return {
    rows: rows.map(shapeTreatment),
    total,
    page: page.page,
    pageSize: page.pageSize,
    pages: Math.max(1, Math.ceil(total / page.pageSize)),
    totalsMinor: { total: Number(totals?.total ?? 0), discount: Number(totals?.discount ?? 0) },
  };
}

function computeTreatmentMoney(values) {
  const quantityMilli = Number(values.quantity_milli ?? 1000) || 1000;
  const line = calculateLine({
    quantityMilli,
    unitPriceMinor: Number(values.fee_minor ?? 0),
    discountType: 'amount',
    discountValue: Number(values.discount_minor ?? 0),
    taxRateBp: Number(values.tax_rate_bp ?? 0),
  });
  return { ...line, quantityMilli };
}

export function createTreatment(db, ctx, input) {
  const values = assertValid(input, treatmentSchema);
  const patient = get(db, 'SELECT id, patient_code FROM patients WHERE id = ? AND clinic_id = ?', [
    values.patient_id,
    ctx.clinicId,
  ]);
  if (!patient) throw new NotFoundError('patient', values.patient_id);

  const teeth = (values.tooth_codes ?? []).map(String);
  const invalid = teeth.filter((code) => !isValidToothCode(code));
  if (invalid.length) {
    throw new ValidationError('validation.failed', [{ field: 'tooth_codes', key: 'chart.invalidTooth', params: { values: invalid.join(', ') } }]);
  }

  let feeMinor = values.fee_minor;
  if ((feeMinor === null || feeMinor === undefined) && values.service_id) {
    const service = get(db, 'SELECT default_price_minor, tax_rate_bp FROM services WHERE id = ? AND clinic_id = ?', [
      values.service_id,
      ctx.clinicId,
    ]);
    feeMinor = service?.default_price_minor ?? 0;
    if (!values.tax_rate_bp) values.tax_rate_bp = service?.tax_rate_bp ?? 0;
  }
  const money = computeTreatmentMoney({ ...values, fee_minor: feeMinor ?? 0 });

  return withTransaction(db, () => {
    const result = run(
      db,
      `INSERT INTO treatments
        (clinic_id, patient_id, visit_id, plan_id, plan_item_id, service_id, name, tooth_codes, treatment_date,
         practitioner_id, anesthesia, materials, notes, status, fee_minor, discount_minor, tax_minor, total_minor,
         quantity_milli, tax_rate_bp, created_by, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ctx.clinicId,
        values.patient_id,
        values.visit_id ?? null,
        values.plan_id ?? null,
        values.plan_item_id ?? null,
        values.service_id ?? null,
        values.name,
        JSON.stringify(teeth),
        values.treatment_date,
        values.practitioner_id ?? null,
        values.anesthesia ?? null,
        values.materials ?? null,
        values.notes ?? null,
        values.status,
        money.unitPriceMinor,
        money.discountMinor,
        money.taxMinor,
        money.lineTotalMinor,
        money.quantityMilli,
        Number(values.tax_rate_bp ?? 0),
        ctx.user?.id ?? null,
        ctx.user?.id ?? null,
      ],
    );
    const treatmentId = Number(result.lastInsertRowid);

    // Completing a plan item keeps the plan progress truthful.
    if (values.plan_item_id && values.status === 'completed') {
      run(
        db,
        `UPDATE treatment_plan_items SET status = 'completed', completed_at = ?, treatment_id = ?, updated_at = ? WHERE id = ?`,
        [nowIso(), treatmentId, nowIso(), values.plan_item_id],
      );
      refreshPlanStatus(db, values.plan_id ?? get(db, 'SELECT plan_id FROM treatment_plan_items WHERE id = ?', [values.plan_item_id])?.plan_id);
    }
    if (values.chart_condition_code && teeth.length) {
      for (const tooth of teeth) {
        addChartEntry(db, ctx, {
          patient_id: values.patient_id,
          tooth_code: tooth,
          dentition: Number(tooth[0]) >= 5 && Number(tooth[0]) <= 8 ? 'primary' : 'adult',
          condition_code: values.chart_condition_code,
          status: 'completed',
          visit_id: values.visit_id ?? null,
          surfaces: [],
        });
      }
    }
    indexTreatment(db, treatmentId);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'create',
      module: 'treatments',
      entity: 'treatment',
      entityId: treatmentId,
      summary: `Treatment "${values.name}" recorded for ${patient.patient_code}`,
      severity: 'info',
      after: { name: values.name, teeth, total_minor: money.lineTotalMinor, status: values.status },
      ip: ctx.ip,
    });
    return { id: treatmentId, totalMinor: money.lineTotalMinor };
  });
}

export function updateTreatment(db, ctx, treatmentId, input) {
  const before = get(db, 'SELECT * FROM treatments WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [treatmentId, ctx.clinicId]);
  if (!before) throw new NotFoundError('treatment', treatmentId);
  const values = assertValid(input, treatmentSchema, { partial: true });
  if (values.tooth_codes) {
    const invalid = values.tooth_codes.map(String).filter((code) => !isValidToothCode(code));
    if (invalid.length) {
      throw new ValidationError('validation.failed', [{ field: 'tooth_codes', key: 'chart.invalidTooth', params: { values: invalid.join(', ') } }]);
    }
  }
  // Money is only recalculated when a money field is part of the patch: the
  // stored row keeps the fee/discount/tax/total it was recorded with otherwise.
  const moneyFields = ['fee_minor', 'discount_minor', 'tax_rate_bp', 'quantity_milli'];
  const moneyTouched = moneyFields.some((field) => values[field] !== undefined);
  // The stored line detail is authoritative: a patch that does not mention the
  // quantity or the rate keeps what the treatment was recorded with, so editing
  // an unrelated field can never change the amount the patient owes.
  const taxRateBp = values.tax_rate_bp ?? Number(before.tax_rate_bp ?? 0);
  const money = moneyTouched
    ? computeTreatmentMoney({
        fee_minor: values.fee_minor ?? before.fee_minor,
        discount_minor: values.discount_minor ?? before.discount_minor,
        tax_rate_bp: taxRateBp,
        quantity_milli: values.quantity_milli ?? Number(before.quantity_milli ?? 1000),
      })
    : null;

  const columns = Object.keys(values).filter((key) => ![...moneyFields, 'chart_condition_code'].includes(key));
  return withTransaction(db, () => {
    const sets = columns.map((col) => `${col} = ?`);
    const params = columns.map((col) => (col === 'tooth_codes' ? JSON.stringify(values[col] ?? []) : values[col]));
    if (money) {
      sets.push('fee_minor = ?', 'discount_minor = ?', 'tax_minor = ?', 'total_minor = ?', 'quantity_milli = ?', 'tax_rate_bp = ?');
      params.push(money.unitPriceMinor, money.discountMinor, money.taxMinor, money.lineTotalMinor, money.quantityMilli, taxRateBp);
    }
    sets.push('updated_by = ?', 'updated_at = ?');
    params.push(ctx.user?.id ?? null, nowIso(), treatmentId);
    run(db, `UPDATE treatments SET ${sets.join(', ')} WHERE id = ?`, params);
    const after = get(db, 'SELECT * FROM treatments WHERE id = ?', [treatmentId]);
    if (after.plan_item_id && after.status === 'completed' && before.status !== 'completed') {
      run(db, "UPDATE treatment_plan_items SET status = 'completed', completed_at = ?, treatment_id = ?, updated_at = ? WHERE id = ?", [
        nowIso(),
        treatmentId,
        nowIso(),
        after.plan_item_id,
      ]);
      refreshPlanStatus(db, after.plan_id);
    }
    const diff = diffForAudit(before, after, [...columns, 'total_minor']);
    indexTreatment(db, treatmentId);
    if (diff.changed.length) {
      recordAudit(db, {
        clinicId: ctx.clinicId,
        userId: ctx.user?.id ?? null,
        userName: ctx.user?.displayName ?? null,
        action: 'update',
        module: 'treatments',
        entity: 'treatment',
        entityId: treatmentId,
        summary: `Treatment "${after.name}" updated (${diff.changed.join(', ')})`,
        severity: 'notice',
        before: diff.before,
        after: diff.after,
      });
    }
    return shapeTreatment(after);
  });
}

/**
 * @param {any} db
 * @param {any} ctx
 * @param {number} treatmentId
 * @param {string|null} [reason]
 */
export function deleteTreatment(db, ctx, treatmentId, reason = null) {
  const treatment = get(db, 'SELECT * FROM treatments WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [
    treatmentId,
    ctx.clinicId,
  ]);
  if (!treatment) throw new NotFoundError('treatment', treatmentId);
  if (treatment.invoice_id) {
    throw new ValidationError('validation.failed', [{ field: 'id', key: 'treatments.billedCannotDelete' }]);
  }
  return withTransaction(db, () => {
    run(db, 'UPDATE treatments SET deleted_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), treatmentId]);
    removeFromIndex(db, 'treatment', treatmentId);
    if (treatment.plan_item_id) {
      run(db, "UPDATE treatment_plan_items SET status = 'pending', completed_at = NULL, treatment_id = NULL, updated_at = ? WHERE id = ?", [
        nowIso(),
        treatment.plan_item_id,
      ]);
      refreshPlanStatus(db, treatment.plan_id);
    }
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'delete',
      module: 'treatments',
      entity: 'treatment',
      entityId: treatmentId,
      summary: `Treatment "${treatment.name}" deleted${reason ? `: ${reason}` : ''}`,
      severity: 'warning',
      before: { name: treatment.name, total_minor: treatment.total_minor },
    });
    return { deleted: true };
  });
}

/** Completed, unbilled procedures available to invoice (§ 35). */
/**
 * @param {any} db
 * @param {any} ctx
 * @param {number|null} [patientId]
 */
export function unbilledTreatments(db, ctx, patientId = null) {
  const args = [ctx.clinicId];
  let filter = '';
  if (patientId) {
    filter = ' AND t.patient_id = ?';
    args.push(Number(patientId));
  }
  const rows = all(
    db,
    `SELECT t.id, t.name, t.tooth_codes, t.treatment_date, t.total_minor, t.fee_minor, t.discount_minor,
            p.id AS patient_id, p.full_name AS patient_name, p.patient_code
       FROM treatments t JOIN patients p ON p.id = t.patient_id
      WHERE t.clinic_id = ? AND t.deleted_at IS NULL AND t.invoice_id IS NULL AND t.status = 'completed' AND t.total_minor > 0
      ${filter}
      ORDER BY t.treatment_date DESC, t.id DESC LIMIT 300`,
    args,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    toothCodes: safeArray(row.tooth_codes),
    treatmentDate: row.treatment_date,
    totalMinor: Number(row.total_minor),
    feeMinor: Number(row.fee_minor),
    discountMinor: Number(row.discount_minor),
    patientId: Number(row.patient_id),
    patientName: row.patient_name,
    patientCode: row.patient_code,
  }));
}

/** Recalculate plan status from its items (single place, always consistent). */
export function refreshPlanStatus(db, planId) {
  if (!planId) return null;
  const items = all(db, 'SELECT status FROM treatment_plan_items WHERE plan_id = ? AND status <> \'cancelled\'', [planId]);
  const plan = get(db, 'SELECT * FROM treatment_plans WHERE id = ?', [planId]);
  if (!plan) return null;
  const done = items.filter((item) => item.status === 'completed').length;
  const inProgress = items.filter((item) => item.status === 'in_progress').length;
  let status = plan.status;
  if (plan.status !== 'cancelled' && plan.status !== 'draft') {
    if (items.length && done === items.length) status = 'completed';
    else if (done > 0) status = 'partially_completed';
    else if (inProgress > 0) status = 'in_progress';
    else if (status === 'completed' || status === 'partially_completed') status = 'accepted';
  }
  run(db, 'UPDATE treatment_plans SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?', [
    status,
    status === 'completed' ? nowIso() : null,
    nowIso(),
    planId,
  ]);
  return status;
}

/* ------------------------------------------------------------------ services */

export const serviceSchema = {
  name_en: { type: 'string', required: true, maxLength: 160 },
  name_bn: { type: 'string', maxLength: 160, nullable: true },
  code: { type: 'string', maxLength: 32, nullable: true },
  category: { type: 'string', maxLength: 60, default: 'general' },
  description: { type: 'text', maxLength: 1000, nullable: true },
  default_price_minor: { type: 'int', min: 0, default: 0 },
  tax_rate_bp: { type: 'int', min: 0, max: 10000, default: 0 },
  unit: { type: 'string', maxLength: 24, default: 'session' },
  is_active: { type: 'boolean', default: true },
  sort_order: { type: 'int', default: 0 },
};

export function listServices(db, ctx, { includeInactive = false, search = null, limit = 300 } = {}) {
  const where = ['clinic_id = ?', 'deleted_at IS NULL'];
  const args = [ctx.clinicId];
  if (!includeInactive) where.push('is_active = 1');
  if (search) {
    where.push("(name_en LIKE ? ESCAPE '\\' OR COALESCE(name_bn,'') LIKE ? ESCAPE '\\' OR COALESCE(code,'') LIKE ? ESCAPE '\\')");
    const pattern = `%${String(search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(pattern, pattern, pattern);
  }
  return all(
    db,
    `SELECT * FROM services WHERE ${where.join(' AND ')} ORDER BY sort_order, name_en LIMIT ?`,
    [...args, Math.min(1000, Math.max(1, limit))],
  ).map((row) => ({
    id: Number(row.id),
    code: row.code,
    nameEn: row.name_en,
    nameBn: row.name_bn,
    category: row.category,
    description: row.description,
    defaultPriceMinor: Number(row.default_price_minor),
    taxRateBp: Number(row.tax_rate_bp),
    unit: row.unit,
    isActive: Boolean(row.is_active),
  }));
}

export function createService(db, ctx, input) {
  const values = assertValid(input, serviceSchema);
  const result = run(
    db,
    `INSERT INTO services (clinic_id, code, name_en, name_bn, category, description, default_price_minor, tax_rate_bp, unit, is_active, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      ctx.clinicId,
      values.code ?? null,
      values.name_en,
      values.name_bn ?? null,
      values.category,
      values.description ?? null,
      values.default_price_minor,
      values.tax_rate_bp,
      values.unit,
      values.is_active ? 1 : 0,
      values.sort_order,
    ],
  );
  const id = Number(result.lastInsertRowid);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'create',
    module: 'settings',
    entity: 'service',
    entityId: id,
    summary: `Service "${values.name_en}" added`,
    severity: 'info',
    after: values,
  });
  return { id };
}

export function updateService(db, ctx, serviceId, input) {
  const before = get(db, 'SELECT * FROM services WHERE id = ? AND clinic_id = ?', [serviceId, ctx.clinicId]);
  if (!before) throw new NotFoundError('service', serviceId);
  const values = assertValid(input, serviceSchema, { partial: true });
  const columns = Object.keys(values);
  if (!columns.length) return before;
  run(db, `UPDATE services SET ${columns.map((col) => `${col} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [
    ...columns.map((col) => (typeof values[col] === 'boolean' ? (values[col] ? 1 : 0) : values[col])),
    nowIso(),
    serviceId,
  ]);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'update',
    module: 'settings',
    entity: 'service',
    entityId: serviceId,
    summary: `Service "${before.name_en}" updated`,
    severity: 'info',
    after: values,
  });
  return get(db, 'SELECT * FROM services WHERE id = ?', [serviceId]);
}

/**
 * Deactivate a catalogue service. Historical treatments keep their name/price
 * (they copy the values), so the row is only deactivated — never deleted.
 */
export function archiveService(db, ctx, serviceId) {
  const before = get(db, 'SELECT * FROM services WHERE id = ? AND clinic_id = ?', [serviceId, ctx.clinicId]);
  if (!before) throw new NotFoundError('service', serviceId);
  run(db, 'UPDATE services SET is_active = 0, updated_at = ? WHERE id = ?', [nowIso(), serviceId]);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'archive',
    module: 'settings',
    entity: 'service',
    entityId: serviceId,
    summary: `Service "${before.name_en}" archived`,
    severity: 'notice',
  });
  return { archived: true };
}

/** Optional starter catalogue (Settings → Services) — prices are zero and must be set by the clinic. */
export function starterServiceCatalogue() {
  return [
    { name_en: 'Consultation', name_bn: 'পরামর্শ', category: 'diagnostic', sort_order: 10 },
    { name_en: 'Examination & treatment plan', name_bn: 'পরীক্ষা ও চিকিৎসা পরিকল্পনা', category: 'diagnostic', sort_order: 20 },
    { name_en: 'Intraoral X-ray (IOPA)', name_bn: 'ইন্ট্রাঅরাল এক্স-রে (আইওপিএ)', category: 'radiology', sort_order: 30 },
    { name_en: 'Scaling & polishing', name_bn: 'স্কেলিং ও পলিশিং', category: 'preventive', sort_order: 40 },
    { name_en: 'Composite filling', name_bn: 'কম্পোজিট ফিলিং', category: 'restorative', sort_order: 50 },
    { name_en: 'Glass ionomer filling', name_bn: 'গ্লাস আয়োনোমার ফিলিং', category: 'restorative', sort_order: 60 },
    { name_en: 'Extraction (simple)', name_bn: 'দাঁত তোলা (সাধারণ)', category: 'surgery', sort_order: 70 },
    { name_en: 'Surgical extraction', name_bn: 'সার্জিক্যাল দন্ত উত্তোলন', category: 'surgery', sort_order: 80 },
    { name_en: 'Root canal treatment (anterior)', name_bn: 'রুট ক্যানেল চিকিৎসা (সামনের দাঁত)', category: 'endodontics', sort_order: 90 },
    { name_en: 'Root canal treatment (molar)', name_bn: 'রুট ক্যানেল চিকিৎসা (মোলার)', category: 'endodontics', sort_order: 100 },
    { name_en: 'Porcelain crown', name_bn: 'পোরসেলিন ক্রাউন', category: 'prosthodontics', sort_order: 110 },
    { name_en: 'Dental bridge (per unit)', name_bn: 'ডেন্টাল ব্রিজ (প্রতি ইউনিট)', category: 'prosthodontics', sort_order: 120 },
    { name_en: 'Complete denture (upper/lower)', name_bn: 'সম্পূর্ণ ডেনচার (উপর/নিচ)', category: 'prosthodontics', sort_order: 130 },
    { name_en: 'Dental implant (fixture)', name_bn: 'ডেন্টাল ইমপ্ল্যান্ট (ফিক্সচার)', category: 'implantology', sort_order: 140 },
    { name_en: 'Teeth whitening', name_bn: 'দাঁত সাদা করা', category: 'cosmetic', sort_order: 150 },
    { name_en: 'Medication', name_bn: 'ঔষধ', category: 'pharmacy', sort_order: 160 },
    { name_en: 'Dental materials', name_bn: 'ডেন্টাল ম্যাটেরিয়াল', category: 'materials', sort_order: 170 },
  ];
}

export { parseAmount, parsePercentToBp };
