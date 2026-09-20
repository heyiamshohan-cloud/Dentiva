/**
 * Treatment plans (§ 23).
 *
 * A plan groups staged procedures with estimated cost, discount and tax.
 * Item completion drives the plan status (draft → proposed → accepted →
 * in progress → partially completed → completed), and a plan can be printed as
 * an estimate or converted into an invoice.
 */
import { all, get, run, withTransaction, nowIso } from '../db/connection.js';
import { resolvePaging } from '../db/query.js';
import { assertValid } from '../domain/validation.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import { PLAN_STATUSES, PLAN_ITEM_STATUSES } from '../../shared/constants.js';
import { todayIso } from '../domain/dates.js';
import { calculateLine, calculateTotals, parseAmount } from '../domain/money.js';
import { nextNumber } from './numbering.js';
import { recordAudit } from './audit.js';
import { refreshPlanStatus } from './treatments.js';
import { isValidToothCode } from './dentalChart.js';

const itemSchema = {
  id: { type: 'id' },
  service_id: { type: 'id', nullable: true },
  name: { type: 'string', required: true, maxLength: 200 },
  tooth_codes: { type: 'array', default: [] },
  stage: { type: 'string', maxLength: 60, nullable: true },
  quantity_milli: { type: 'int', min: 0, default: 1000 },
  unit_price_minor: { type: 'int', min: 0, default: 0 },
  discount_minor: { type: 'int', min: 0, default: 0 },
  tax_rate_bp: { type: 'int', min: 0, max: 10000, default: 0 },
  status: { type: 'enum', values: PLAN_ITEM_STATUSES, default: 'pending' },
  notes: { type: 'text', maxLength: 1000, nullable: true },
  sort_order: { type: 'int', default: 0 },
};

export const planSchema = {
  patient_id: { type: 'id', required: true },
  title: { type: 'string', required: true, maxLength: 200 },
  diagnosis: { type: 'text', maxLength: 2000, nullable: true },
  practitioner_id: { type: 'id', nullable: true },
  proposed_date: { type: 'date', nullable: true, default: () => todayIso() },
  status: { type: 'enum', values: PLAN_STATUSES, default: 'draft' },
  discount_type: { type: 'enum', values: ['amount', 'percent'], default: 'amount' },
  discount_value: { type: 'int', min: 0, default: 0 },
  notes: { type: 'text', maxLength: 4000, nullable: true },
  items: { type: 'array', default: [] },
};

function shapePlanItem(row) {
  return {
    id: Number(row.id),
    serviceId: row.service_id ?? null,
    name: row.name,
    toothCodes: safeArray(row.tooth_codes),
    stage: row.stage,
    quantityMilli: Number(row.quantity_milli),
    unitPriceMinor: Number(row.unit_price_minor),
    discountMinor: Number(row.discount_minor),
    taxRateBp: Number(row.tax_rate_bp),
    taxMinor: Number(row.tax_minor),
    lineTotalMinor: Number(row.line_total_minor),
    status: row.status,
    completedAt: row.completed_at,
    treatmentId: row.treatment_id ?? null,
    notes: row.notes,
    sortOrder: Number(row.sort_order),
  };
}

function safeArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function computeItems(items) {
  const calculated = [];
  for (const [index, item] of items.entries()) {
    const line = calculateLine({
      quantityMilli: item.quantity_milli ?? 1000,
      unitPriceMinor: item.unit_price_minor ?? 0,
      discountType: 'amount',
      discountValue: item.discount_minor ?? 0,
      taxRateBp: item.tax_rate_bp ?? 0,
    });
    calculated.push({ ...item, ...line, sort_order: item.sort_order ?? index * 10 });
  }
  const totals = calculateTotals(calculated, { discountType: 'amount', discountValue: 0 });
  return { calculated, totals };
}

export function getPlan(db, ctx, planId) {
  const plan = get(
    db,
    `SELECT tp.*, p.full_name AS patient_name, p.patient_code, p.gender, p.dob, p.phone,
            s.full_name AS practitioner_name
       FROM treatment_plans tp
       JOIN patients p ON p.id = tp.patient_id
       LEFT JOIN staff s ON s.id = tp.practitioner_id
      WHERE tp.id = ? AND tp.clinic_id = ?`,
    [planId, ctx.clinicId],
  );
  if (!plan) throw new NotFoundError('treatment_plan', planId);
  const items = all(db, 'SELECT * FROM treatment_plan_items WHERE plan_id = ? ORDER BY sort_order, id', [planId]);
  const payments = get(
    db,
    `SELECT COALESCE(SUM(i.paid_minor),0) AS paid, COALESCE(SUM(i.total_minor),0) AS invoiced
       FROM invoices i WHERE i.plan_id = ? AND i.status = 'issued' AND i.deleted_at IS NULL`,
    [planId],
  );
  return {
    id: Number(plan.id),
    planCode: plan.plan_code,
    patientId: Number(plan.patient_id),
    patientName: plan.patient_name,
    patientCode: plan.patient_code,
    title: plan.title,
    diagnosis: plan.diagnosis,
    practitionerId: plan.practitioner_id ?? null,
    practitionerName: plan.practitioner_name,
    proposedDate: plan.proposed_date,
    status: plan.status,
    subtotalMinor: Number(plan.subtotal_minor),
    discountMinor: Number(plan.discount_minor),
    discountType: plan.discount_type,
    discountValue: Number(plan.discount_value),
    taxMinor: Number(plan.tax_minor),
    totalMinor: Number(plan.total_minor),
    notes: plan.notes,
    acceptedAt: plan.accepted_at,
    completedAt: plan.completed_at,
    createdAt: plan.created_at,
    items: items.map(shapePlanItem),
    progress: {
      total: items.length,
      completed: items.filter((item) => item.status === 'completed').length,
      inProgress: items.filter((item) => item.status === 'in_progress').length,
      pending: items.filter((item) => item.status === 'pending').length,
      cancelled: items.filter((item) => item.status === 'cancelled').length,
    },
    billing: { invoicedMinor: Number(payments?.invoiced ?? 0), paidMinor: Number(payments?.paid ?? 0) },
  };
}

export function listPlans(db, ctx, params = {}) {
  const where = ['tp.clinic_id = ?', 'tp.deleted_at IS NULL'];
  const args = [ctx.clinicId];
  if (params.patientId) {
    where.push('tp.patient_id = ?');
    args.push(Number(params.patientId));
  }
  if (params.status && PLAN_STATUSES.includes(params.status)) {
    where.push('tp.status = ?');
    args.push(params.status);
  }
  if (params.from) {
    where.push('tp.proposed_date >= ?');
    args.push(params.from);
  }
  if (params.to) {
    where.push('tp.proposed_date <= ?');
    args.push(params.to);
  }
  if (params.search) {
    where.push("(tp.title LIKE ? ESCAPE '\\' OR p.full_name LIKE ? ESCAPE '\\' OR p.patient_code LIKE ? ESCAPE '\\' OR tp.plan_code LIKE ? ESCAPE '\\')");
    const pattern = `%${String(params.search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(pattern, pattern, pattern, pattern);
  }
  const page = resolvePaging(params);
  const whereSql = where.join(' AND ');
  const total = Number(
    get(db, `SELECT COUNT(*) AS c FROM treatment_plans tp JOIN patients p ON p.id = tp.patient_id WHERE ${whereSql}`, args)?.c ?? 0,
  );
  const rows = all(
    db,
    `SELECT tp.*, p.full_name AS patient_name, p.patient_code,
            (SELECT COUNT(*) FROM treatment_plan_items i WHERE i.plan_id = tp.id) AS item_count,
            (SELECT COUNT(*) FROM treatment_plan_items i WHERE i.plan_id = tp.id AND i.status = 'completed') AS completed_count
       FROM treatment_plans tp JOIN patients p ON p.id = tp.patient_id
      WHERE ${whereSql}
      ORDER BY tp.created_at DESC, tp.id DESC LIMIT ? OFFSET ?`,
    [...args, page.pageSize, page.offset],
  );
  return {
    rows: rows.map((row) => ({
      id: Number(row.id),
      planCode: row.plan_code,
      patientId: Number(row.patient_id),
      patientName: row.patient_name,
      patientCode: row.patient_code,
      title: row.title,
      diagnosis: row.diagnosis,
      status: row.status,
      proposedDate: row.proposed_date,
      totalMinor: Number(row.total_minor),
      discountMinor: Number(row.discount_minor),
      itemCount: Number(row.item_count),
      completedCount: Number(row.completed_count),
      createdAt: row.created_at,
    })),
    total,
    page: page.page,
    pageSize: page.pageSize,
    pages: Math.max(1, Math.ceil(total / page.pageSize)),
  };
}

export function createPlan(db, ctx, input) {
  const values = assertValid(input, planSchema);
  const patient = get(db, 'SELECT id, patient_code FROM patients WHERE id = ? AND clinic_id = ?', [values.patient_id, ctx.clinicId]);
  if (!patient) throw new NotFoundError('patient', values.patient_id);
  const items = Array.isArray(input.items) ? input.items : [];
  const validatedItems = items.map((item, index) => {
    const parsed = assertValid(item, itemSchema, { partial: true });
    const teeth = (parsed.tooth_codes ?? []).map(String);
    const invalid = teeth.filter((code) => !isValidToothCode(code));
    if (invalid.length) {
      throw new ValidationError('validation.failed', [
        { field: `items.${index}.tooth_codes`, key: 'chart.invalidTooth', params: { values: invalid.join(', ') } },
      ]);
    }
    return { ...parsed, tooth_codes: teeth };
  });
  const { calculated, totals } = computeItems(validatedItems);

  return withTransaction(db, () => {
    const allocation = nextNumber(db, ctx.clinicId, 'plan');
    const result = run(
      db,
      `INSERT INTO treatment_plans
        (clinic_id, patient_id, plan_code, title, diagnosis, practitioner_id, proposed_date, status,
         subtotal_minor, discount_minor, tax_minor, total_minor, discount_type, discount_value, notes, created_by, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ctx.clinicId,
        values.patient_id,
        allocation.code,
        values.title,
        values.diagnosis ?? null,
        values.practitioner_id ?? null,
        values.proposed_date ?? null,
        values.status,
        totals.subtotalMinor,
        totals.discountMinor,
        totals.taxMinor,
        totals.totalMinor,
        values.discount_type,
        values.discount_value,
        values.notes ?? null,
        ctx.user?.id ?? null,
        ctx.user?.id ?? null,
      ],
    );
    const planId = Number(result.lastInsertRowid);
    insertPlanItems(db, planId, calculated);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'create',
      module: 'plans',
      entity: 'treatment_plan',
      entityId: planId,
      summary: `Treatment plan ${allocation.code} created for ${patient.patient_code}`,
      severity: 'info',
      after: { title: values.title, items: calculated.length, total_minor: totals.totalMinor },
    });
    return { id: planId, planCode: allocation.code, totalMinor: totals.totalMinor, itemCount: calculated.length };
  });
}

/**
 * `computeItems` returns the calculated money fields (`taxMinor`,
 * `lineTotalMinor`, …) alongside the validated snake_case input, so the stored
 * row is taken from the calculated value first and only falls back to the raw
 * input. Storing `item.tax_minor` alone would silently write zeros.
 * @param {Record<string, any>} item
 * @param {string} camel
 * @param {string} snake
 */
function lineValue(item, camel, snake) {
  return item[camel] ?? item[snake] ?? 0;
}

function insertPlanItems(db, planId, items) {
  for (const item of items) {
    run(
      db,
      `INSERT INTO treatment_plan_items
        (plan_id, service_id, name, tooth_codes, stage, quantity_milli, unit_price_minor, discount_minor,
         tax_rate_bp, tax_minor, line_total_minor, status, notes, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        planId,
        item.service_id ?? null,
        item.name,
        JSON.stringify(item.tooth_codes ?? []),
        item.stage ?? null,
        lineValue(item, 'quantityMilli', 'quantity_milli') || 1000,
        lineValue(item, 'unitPriceMinor', 'unit_price_minor'),
        lineValue(item, 'discountMinor', 'discount_minor'),
        lineValue(item, 'taxRateBp', 'tax_rate_bp'),
        lineValue(item, 'taxMinor', 'tax_minor'),
        lineValue(item, 'lineTotalMinor', 'line_total_minor'),
        item.status ?? 'pending',
        item.notes ?? null,
        item.sort_order ?? 0,
      ],
    );
  }
}

export function updatePlan(db, ctx, planId, input) {
  const before = get(db, 'SELECT * FROM treatment_plans WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [planId, ctx.clinicId]);
  if (!before) throw new NotFoundError('treatment_plan', planId);
  const values = assertValid(input, planSchema, { partial: true });
  const replaceItems = input.items !== undefined;

  return withTransaction(db, () => {
    let totals = null;
    if (replaceItems) {
      const validatedItems = (Array.isArray(input.items) ? input.items : []).map((item, index) => {
        const parsed = assertValid(item, itemSchema, { partial: true });
        const teeth = (parsed.tooth_codes ?? []).map(String);
        const invalid = teeth.filter((code) => !isValidToothCode(code));
        if (invalid.length) {
          throw new ValidationError('validation.failed', [
            { field: `items.${index}.tooth_codes`, key: 'chart.invalidTooth', params: { values: invalid.join(', ') } },
          ]);
        }
        return { ...parsed, tooth_codes: teeth };
      });
      const computed = computeItems(validatedItems);
      totals = computed.totals;
      run(db, 'DELETE FROM treatment_plan_items WHERE plan_id = ?', [planId]);
      insertPlanItems(db, planId, computed.calculated);
    }

    const columns = Object.keys(values).filter((col) => col !== 'items');
    if (columns.length || totals) {
      const sets = columns.map((col) => `${col} = ?`);
      const params = columns.map((col) => values[col]);
      if (totals) {
        sets.push('subtotal_minor = ?', 'discount_minor = ?', 'tax_minor = ?', 'total_minor = ?');
        params.push(totals.subtotalMinor, totals.discountMinor, totals.taxMinor, totals.totalMinor);
      }
      sets.push('updated_by = ?', 'updated_at = ?');
      params.push(ctx.user?.id ?? null, nowIso(), planId);
      run(db, `UPDATE treatment_plans SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    if (values.status === 'accepted' && !before.accepted_at) {
      run(db, 'UPDATE treatment_plans SET accepted_at = ? WHERE id = ?', [nowIso(), planId]);
    }
    refreshPlanStatus(db, planId);
    const after = get(db, 'SELECT * FROM treatment_plans WHERE id = ?', [planId]);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'update',
      module: 'plans',
      entity: 'treatment_plan',
      entityId: planId,
      summary: `Treatment plan ${before.plan_code} updated`,
      severity: 'notice',
      before: { status: before.status, total_minor: before.total_minor },
      after: { status: after.status, total_minor: after.total_minor },
    });
    return getPlan(db, ctx, planId);
  });
}

/** Update one item's status (used by the plan progress UI and the treatment flow). */
export function updatePlanItem(db, ctx, itemId, input) {
  const item = get(
    db,
    `SELECT i.*, tp.clinic_id FROM treatment_plan_items i JOIN treatment_plans tp ON tp.id = i.plan_id WHERE i.id = ?`,
    [itemId],
  );
  if (!item || item.clinic_id !== ctx.clinicId) throw new NotFoundError('treatment_plan_item', itemId);
  const values = assertValid(input, {
    status: { type: 'enum', values: PLAN_ITEM_STATUSES },
    notes: { type: 'text', maxLength: 1000, nullable: true },
    name: { type: 'string', maxLength: 200 },
    stage: { type: 'string', maxLength: 60, nullable: true },
    quantity_milli: { type: 'int', min: 0 },
    unit_price_minor: { type: 'int', min: 0 },
    discount_minor: { type: 'int', min: 0 },
    tooth_codes: { type: 'array' },
  }, { partial: true });
  const columns = Object.keys(values);
  if (columns.length) {
    run(
      db,
      `UPDATE treatment_plan_items SET ${columns.map((col) => `${col} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [
        ...columns.map((col) => (col === 'tooth_codes' ? JSON.stringify(values[col] ?? []) : values[col])),
        nowIso(),
        itemId,
      ],
    );
  }
  if (values.status === 'completed') {
    run(db, 'UPDATE treatment_plan_items SET completed_at = COALESCE(completed_at, ?) WHERE id = ?', [nowIso(), itemId]);
  }
  recomputePlanTotals(db, item.plan_id);
  refreshPlanStatus(db, item.plan_id);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'update_item',
    module: 'plans',
    entity: 'treatment_plan_item',
    entityId: itemId,
    summary: `Plan item "${item.name}" updated${values.status ? ` → ${values.status}` : ''}`,
    severity: 'info',
  });
  return { id: itemId };
}

function recomputePlanTotals(db, planId) {
  const items = all(db, 'SELECT * FROM treatment_plan_items WHERE plan_id = ?', [planId]);
  const { totals } = computeItems(items.map((item) => ({ ...item })));
  run(db, 'UPDATE treatment_plans SET subtotal_minor = ?, discount_minor = ?, tax_minor = ?, total_minor = ? WHERE id = ?', [
    totals.subtotalMinor,
    totals.discountMinor,
    totals.taxMinor,
    totals.totalMinor,
    planId,
  ]);
  return totals;
}

/**
 * @param {any} db
 * @param {any} ctx
 * @param {number} planId
 * @param {string|null} [reason]
 */
export function deletePlan(db, ctx, planId, reason = null) {
  const plan = get(db, 'SELECT * FROM treatment_plans WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [planId, ctx.clinicId]);
  if (!plan) throw new NotFoundError('treatment_plan', planId);
  const related = get(db, "SELECT COUNT(*) AS c FROM invoices WHERE plan_id = ? AND status = 'issued' AND deleted_at IS NULL", [planId]);
  if (Number(related?.c ?? 0) > 0) {
    throw new ValidationError('validation.failed', [{ field: 'id', key: 'plans.invoicedCannotDelete' }]);
  }
  run(db, 'UPDATE treatment_plans SET deleted_at = ?, status = \'cancelled\', updated_at = ? WHERE id = ?', [
    nowIso(),
    nowIso(),
    planId,
  ]);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'delete',
    module: 'plans',
    entity: 'treatment_plan',
    entityId: planId,
    summary: `Treatment plan ${plan.plan_code} deleted${reason ? `: ${reason}` : ''}`,
    severity: 'warning',
  });
  return { deleted: true };
}

/** Items ready to be invoiced (pending/completed items of an accepted plan). */
export function planItemsForInvoice(db, ctx, planId) {
  const plan = get(db, 'SELECT * FROM treatment_plans WHERE id = ? AND clinic_id = ?', [planId, ctx.clinicId]);
  if (!plan) throw new NotFoundError('treatment_plan', planId);
  const items = all(
    db,
    "SELECT * FROM treatment_plan_items WHERE plan_id = ? AND status <> 'cancelled' ORDER BY sort_order, id",
    [planId],
  );
  return items.map((item) => ({
    planItemId: Number(item.id),
    serviceId: item.service_id,
    description: `${item.name}${safeArray(item.tooth_codes).length ? ` (${safeArray(item.tooth_codes).join(', ')})` : ''}`,
    quantityMilli: Number(item.quantity_milli),
    unitPriceMinor: Number(item.unit_price_minor),
    discountMinor: Number(item.discount_minor),
    taxRateBp: Number(item.tax_rate_bp),
    status: item.status,
  }));
}

export { parseAmount };
