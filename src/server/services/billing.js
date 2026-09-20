/**
 * Billing — invoices (§ 33, § 35) and the money rules that keep totals safe
 * (§ 71).
 *
 *  - every line is calculated from quantity × unit price with its own discount
 *    and tax, in integer minor units,
 *  - the invoice totals are recomputed from the lines on every write, so a
 *    stored total can never drift from its items,
 *  - `paid_minor` / `due_minor` are always derived from the payment ledger,
 *  - issued invoices are never deleted: they are voided with a reason and an
 *    audit entry, and the receipt/invoice numbers are never reused.
 */
import { all, get, run, withTransaction, nowIso } from '../db/connection.js';
import { resolvePaging, placeholders } from '../db/query.js';
import { assertValid } from '../domain/validation.js';
import { ConflictError, NotFoundError, ValidationError, PermissionError } from '../../shared/errors.js';
import { INVOICE_STATUSES } from '../../shared/constants.js';
import { todayIso } from '../domain/dates.js';
import { calculateLine, calculateTotals, parseAmount, percentOf, allocate } from '../domain/money.js';
import { getSettings } from './settings.js';
import { nextNumber } from './numbering.js';
import { recordAudit, diffForAudit } from './audit.js';
import { indexInvoice, removeFromIndex } from './search.js';

export const invoiceItemSchema = {
  id: { type: 'id' },
  service_id: { type: 'id', nullable: true },
  treatment_id: { type: 'id', nullable: true },
  plan_item_id: { type: 'id', nullable: true },
  description: { type: 'string', required: true, maxLength: 200 },
  tooth_codes: { type: 'array', default: [] },
  quantity_milli: { type: 'int', min: 1, default: 1000 },
  unit_price_minor: { type: 'int', min: 0, default: 0 },
  discount_type: { type: 'enum', values: ['amount', 'percent'], default: 'amount' },
  discount_value: { type: 'int', min: 0, default: 0 },
  tax_rate_bp: { type: 'int', min: 0, max: 10000, default: 0 },
  sort_order: { type: 'int', default: 0 },
  notes: { type: 'string', maxLength: 500, nullable: true },
};

export const invoiceSchema = {
  patient_id: { type: 'id', required: true },
  visit_id: { type: 'id', nullable: true },
  plan_id: { type: 'id', nullable: true },
  invoice_date: { type: 'date', required: true, default: () => todayIso() },
  due_date: { type: 'date', nullable: true },
  status: { type: 'enum', values: ['draft', 'issued'], default: 'draft' },
  notes: { type: 'text', maxLength: 2000, nullable: true },
  footer_text: { type: 'string', maxLength: 500, nullable: true },
  terms: { type: 'text', maxLength: 2000, nullable: true },
  items: { type: 'array', default: [] },
};

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

export function shapeInvoiceItem(row) {
  return {
    id: Number(row.id),
    serviceId: row.service_id ?? null,
    treatmentId: row.treatment_id ?? null,
    description: row.description,
    toothCodes: safeArray(row.tooth_codes),
    quantityMilli: Number(row.quantity_milli),
    unitPriceMinor: Number(row.unit_price_minor),
    discountType: row.discount_type,
    discountValue: Number(row.discount_value),
    discountMinor: Number(row.discount_minor),
    taxRateBp: Number(row.tax_rate_bp),
    taxMinor: Number(row.tax_minor),
    lineSubtotalMinor: Number(row.line_subtotal_minor),
    lineTotalMinor: Number(row.line_total_minor),
    sortOrder: Number(row.sort_order),
    notes: row.notes,
  };
}

export function shapeInvoice(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    invoiceNumber: row.invoice_number,
    patientId: Number(row.patient_id),
    patientName: row.patient_name ?? null,
    patientCode: row.patient_code ?? null,
    patientPhone: row.patient_phone ?? null,
    visitId: row.visit_id ?? null,
    planId: row.plan_id ?? null,
    invoiceDate: row.invoice_date,
    dueDate: row.due_date,
    status: row.status,
    subtotalMinor: Number(row.subtotal_minor),
    discountMinor: Number(row.discount_minor),
    taxMinor: Number(row.tax_minor),
    roundOffMinor: Number(row.round_off_minor ?? 0),
    totalMinor: Number(row.total_minor),
    paidMinor: Number(row.paid_minor),
    dueMinor: Number(row.due_minor),
    notes: row.notes,
    footerText: row.footer_text,
    terms: row.terms,
    issuedAt: row.issued_at,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    printedCount: Number(row.printed_count ?? 0),
    createdAt: row.created_at,
    isOverdue: row.status === 'issued' && Number(row.due_minor) > 0 && row.due_date ? row.due_date < todayIso() : false,
    paymentStatus:
      row.status === 'void'
        ? 'void'
        : Number(row.due_minor) <= 0 && Number(row.total_minor) > 0
          ? 'paid'
          : Number(row.paid_minor) > 0
            ? 'partial'
            : 'unpaid',
  };
}

const INVOICE_SELECT = `
  SELECT i.*, p.full_name AS patient_name, p.patient_code, p.phone AS patient_phone
    FROM invoices i JOIN patients p ON p.id = i.patient_id`;

/** Accept the camelCase shapes produced by `planItemsForInvoice`/`unbilledTreatments`. */
function normalizeInvoiceItem(item) {
  if (!item || typeof item !== 'object') return item;
  return {
    ...item,
    service_id: item.service_id ?? item.serviceId ?? null,
    treatment_id: item.treatment_id ?? item.treatmentId ?? null,
    plan_item_id: item.plan_item_id ?? item.planItemId ?? null,
    description: item.description ?? item.name ?? null,
    tooth_codes: item.tooth_codes ?? item.toothCodes ?? [],
    quantity_milli: item.quantity_milli ?? item.quantityMilli,
    unit_price_minor: item.unit_price_minor ?? item.unitPriceMinor,
    discount_value: item.discount_value ?? item.discountMinor,
    tax_rate_bp: item.tax_rate_bp ?? item.taxRateBp,
  };
}

function calculateItems(items) {
  return items.map((item, index) => {
    const line = calculateLine({
      quantityMilli: item.quantity_milli ?? 1000,
      unitPriceMinor: item.unit_price_minor ?? 0,
      discountType: item.discount_type ?? 'amount',
      discountValue: item.discount_value ?? 0,
      taxRateBp: item.tax_rate_bp ?? 0,
    });
    return {
      ...item,
      ...line,
      discountType: item.discount_type ?? 'amount',
      discountValue: item.discount_value ?? 0,
      taxRateBp: item.tax_rate_bp ?? 0,
      sort_order: item.sort_order ?? index * 10,
    };
  });
}

/**
 * Recalculate an invoice from its stored items and the payment ledger.
 * This is the only place invoice money is written.
 */
export function recalculateInvoice(db, invoiceId) {
  const items = all(db, 'SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order', [invoiceId]);
  const lines = items.map((item) => ({
    lineSubtotalMinor: Number(item.line_subtotal_minor),
    discountMinor: Number(item.discount_minor),
    taxMinor: Number(item.tax_minor),
    lineTotalMinor: Number(item.line_total_minor),
  }));
  const totals = calculateTotals(lines, { discountType: 'amount', discountValue: 0 });

  const payments = get(
    db,
    `SELECT
       COALESCE(SUM(CASE WHEN kind = 'payment' THEN amount_minor ELSE 0 END), 0) AS collected,
       COALESCE(SUM(CASE WHEN kind = 'refund' THEN amount_minor ELSE 0 END), 0) AS refunded,
       COALESCE(SUM(CASE WHEN kind = 'credit_used' THEN amount_minor ELSE 0 END), 0) AS credit
     FROM payments WHERE invoice_id = ? AND voided_at IS NULL AND deleted_at IS NULL`,
    [invoiceId],
  );
  const paid = Math.max(0, Number(payments?.collected ?? 0) + Number(payments?.credit ?? 0) - Number(payments?.refunded ?? 0));
  const total = totals.totalMinor;
  const due = Math.max(0, total - paid);
  run(
    db,
    `UPDATE invoices SET subtotal_minor = ?, discount_minor = ?, tax_minor = ?, total_minor = ?, paid_minor = ?, due_minor = ?, updated_at = ?
      WHERE id = ?`,
    [totals.subtotalMinor, totals.discountMinor, totals.taxMinor, total, paid, due, nowIso(), invoiceId],
  );
  return { ...totals, totalMinor: total, paidMinor: paid, dueMinor: due };
}

export function getInvoice(db, ctx, invoiceId) {
  const row = get(db, `${INVOICE_SELECT} WHERE i.id = ? AND i.clinic_id = ? AND i.deleted_at IS NULL`, [invoiceId, ctx.clinicId]);
  if (!row) throw new NotFoundError('invoice', invoiceId);
  const items = all(db, 'SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id', [invoiceId]);
  const payments = all(
    db,
    `SELECT pm.id, pm.receipt_number, pm.payment_date, pm.kind, pm.amount_minor, pm.method_code, pm.reference_no,
            pm.notes, pm.voided_at, u.display_name AS created_by_name
       FROM payments pm LEFT JOIN users u ON u.id = pm.created_by
      WHERE pm.invoice_id = ? AND pm.deleted_at IS NULL
      ORDER BY pm.payment_date, pm.id`,
    [invoiceId],
  );
  const treatments = all(
    db,
    'SELECT id, name, tooth_codes, treatment_date, total_minor FROM treatments WHERE invoice_id = ? AND deleted_at IS NULL',
    [invoiceId],
  );
  const credit = get(
    db,
    `SELECT COALESCE(SUM(amount_minor),0) AS balance FROM patient_credits WHERE invoice_id = ?`,
    [invoiceId],
  );
  return {
    ...shapeInvoice(row),
    items: items.map(shapeInvoiceItem),
    payments: payments.map((payment) => ({
      id: Number(payment.id),
      receiptNumber: payment.receipt_number,
      paymentDate: payment.payment_date,
      kind: payment.kind,
      amountMinor: Number(payment.amount_minor),
      methodCode: payment.method_code,
      referenceNo: payment.reference_no,
      notes: payment.notes,
      voidedAt: payment.voided_at,
      createdBy: payment.created_by_name,
    })),
    treatments: treatments.map((treatment) => ({
      id: Number(treatment.id),
      name: treatment.name,
      toothCodes: safeArray(treatment.tooth_codes),
      treatmentDate: treatment.treatment_date,
      totalMinor: Number(treatment.total_minor),
    })),
    creditMinor: Number(credit?.balance ?? 0),
  };
}

export function listInvoices(db, ctx, params = {}) {
  const where = ['i.clinic_id = ?'];
  const args = [ctx.clinicId];
  if (!params.includeDeleted) where.push('i.deleted_at IS NULL');
  if (params.patientId) {
    where.push('i.patient_id = ?');
    args.push(Number(params.patientId));
  }
  if (params.status && INVOICE_STATUSES.includes(params.status)) {
    where.push('i.status = ?');
    args.push(params.status);
  }
  if (params.onlyOutstanding === true || params.onlyOutstanding === 'true') {
    where.push("i.status = 'issued' AND i.due_minor > 0");
  }
  if (params.overdue === true || params.overdue === 'true') {
    where.push("i.status = 'issued' AND i.due_minor > 0 AND i.due_date IS NOT NULL AND i.due_date < ?");
    args.push(todayIso());
  }
  if (params.from) {
    where.push('i.invoice_date >= ?');
    args.push(params.from);
  }
  if (params.to) {
    where.push('i.invoice_date <= ?');
    args.push(params.to);
  }
  if (params.minDue) {
    where.push('i.due_minor >= ?');
    args.push(Number(params.minDue));
  }
  if (params.search) {
    where.push("(i.invoice_number LIKE ? ESCAPE '\\' OR p.full_name LIKE ? ESCAPE '\\' OR p.patient_code LIKE ? ESCAPE '\\')");
    const pattern = `%${String(params.search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(pattern, pattern, pattern);
  }
  const page = resolvePaging(params);
  const whereSql = where.join(' AND ');
  const total = Number(
    get(db, `SELECT COUNT(*) AS c FROM invoices i JOIN patients p ON p.id = i.patient_id WHERE ${whereSql}`, args)?.c ?? 0,
  );
  const rows = all(
    db,
    `${INVOICE_SELECT} WHERE ${whereSql} ORDER BY i.invoice_date DESC, i.id DESC LIMIT ? OFFSET ?`,
    [...args, page.pageSize, page.offset],
  );
  const totals = get(
    db,
    `SELECT
       COALESCE(SUM(CASE WHEN i.status = 'issued' THEN i.total_minor ELSE 0 END), 0) AS invoiced,
       COALESCE(SUM(CASE WHEN i.status = 'issued' THEN i.paid_minor ELSE 0 END), 0) AS paid,
       COALESCE(SUM(CASE WHEN i.status = 'issued' THEN i.due_minor ELSE 0 END), 0) AS due
     FROM invoices i JOIN patients p ON p.id = i.patient_id WHERE ${whereSql}`,
    args,
  );
  return {
    rows: rows.map(shapeInvoice),
    total,
    page: page.page,
    pageSize: page.pageSize,
    pages: Math.max(1, Math.ceil(total / page.pageSize)),
    totalsMinor: {
      invoiced: Number(totals?.invoiced ?? 0),
      paid: Number(totals?.paid ?? 0),
      due: Number(totals?.due ?? 0),
    },
  };
}

/**
 * Create an invoice.
 * @param {import('bun:sqlite').Database} db
 * @param {{ clinicId: number, user?: any, ip?: string|null }} ctx
 */
export function createInvoice(db, ctx, input) {
  const values = assertValid(input, invoiceSchema);
  const settings = getSettings(db, ctx.clinicId);
  const patient = get(db, 'SELECT id, patient_code, full_name FROM patients WHERE id = ? AND clinic_id = ?', [
    values.patient_id,
    ctx.clinicId,
  ]);
  if (!patient) throw new NotFoundError('patient', values.patient_id);

  const rawItems = (Array.isArray(input.items) ? input.items : []).map(normalizeInvoiceItem);
  const validatedItems = rawItems.map((item, index) => {
    const parsed = assertValid(item, invoiceItemSchema, { partial: true });
    const missing = ['description'].filter((field) => parsed[field] === undefined);
    if (missing.length) {
      throw new ValidationError('validation.failed', [
        ...missing.map((field) => ({ field: `items.${index}.${field}`, key: 'validation.required' })),
      ]);
    }
    return parsed;
  });
  if (!validatedItems.length && (values.status ?? 'draft') === 'issued') {
    throw new ValidationError('validation.failed', [{ field: 'items', key: 'billing.invoiceNeedsItems' }]);
  }
  const calculated = calculateItems(validatedItems);
  const totals = calculateTotals(calculated, {
    discountType: 'amount',
    discountValue: 0,
    roundToWhole: Boolean(settings['billing.roundToWhole']),
    minorUnits: get(db, 'SELECT currency_minor_units FROM clinics WHERE id = ?', [ctx.clinicId])?.currency_minor_units ?? 2,
  });

  return withTransaction(db, () => {
    const status = values.status === 'issued' ? 'issued' : 'draft';
    let invoiceNumber;
    if (status === 'issued') {
      invoiceNumber = nextNumber(db, ctx.clinicId, 'invoice').code;
    } else {
      invoiceNumber = `DRAFT-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}`;
    }
    const result = run(
      db,
      `INSERT INTO invoices
        (clinic_id, patient_id, visit_id, plan_id, invoice_number, invoice_date, due_date, status, subtotal_minor,
         discount_minor, tax_minor, total_minor, paid_minor, due_minor, round_off_minor, notes, footer_text, terms,
         issued_at, created_by, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?)`,
      [
        ctx.clinicId,
        values.patient_id,
        values.visit_id ?? null,
        values.plan_id ?? null,
        invoiceNumber,
        values.invoice_date,
        values.due_date ?? null,
        status,
        totals.subtotalMinor,
        totals.discountMinor,
        totals.taxMinor,
        totals.totalMinor,
        totals.totalMinor,
        totals.roundOffMinor,
        values.notes ?? null,
        values.footer_text ?? settings['billing.invoiceFooter'] ?? null,
        values.terms ?? settings['billing.terms'] ?? null,
        status === 'issued' ? nowIso() : null,
        ctx.user?.id ?? null,
        ctx.user?.id ?? null,
      ],
    );
    const invoiceId = Number(result.lastInsertRowid);
    insertInvoiceItems(db, invoiceId, calculated);
    markTreatmentsInvoiced(db, invoiceId, calculated);
    recalculateInvoice(db, invoiceId);
    indexInvoice(db, invoiceId);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'create',
      module: 'billing',
      entity: 'invoice',
      entityId: invoiceId,
      summary: `Invoice ${invoiceNumber} created for ${patient.patient_code} (${totals.totalMinor} minor units)`,
      severity: 'notice',
      after: { invoice: invoiceNumber, total_minor: totals.totalMinor, items: calculated.length, status },
      ip: ctx.ip,
    });
    return { id: invoiceId, invoiceNumber, totalMinor: totals.totalMinor, status };
  });
}

function insertInvoiceItems(db, invoiceId, items) {
  for (const item of items) {
    run(
      db,
      `INSERT INTO invoice_items
        (invoice_id, service_id, treatment_id, description, tooth_codes, quantity_milli, unit_price_minor, discount_type,
         discount_value, discount_minor, tax_rate_bp, tax_minor, line_subtotal_minor, line_total_minor, sort_order, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        invoiceId,
        item.service_id ?? null,
        item.treatment_id ?? null,
        item.description,
        JSON.stringify(item.tooth_codes ?? []),
        item.quantityMilli,
        item.unitPriceMinor,
        item.discountType,
        item.discountValue,
        item.discountMinor,
        item.taxRateBp,
        item.taxMinor,
        item.lineSubtotalMinor,
        item.lineTotalMinor,
        item.sort_order,
        item.notes ?? null,
      ],
    );
  }
}

function markTreatmentsInvoiced(db, invoiceId, items) {
  for (const item of items) {
    if (!item.treatment_id) continue;
    run(db, 'UPDATE treatments SET invoice_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', [invoiceId, nowIso(), item.treatment_id]);
  }
}

export function updateInvoice(db, ctx, invoiceId, input) {
  const before = get(db, 'SELECT * FROM invoices WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [invoiceId, ctx.clinicId]);
  if (!before) throw new NotFoundError('invoice', invoiceId);
  if (before.status === 'void') throw new ConflictError('billing.voidCannotEdit');
  const settings = getSettings(db, ctx.clinicId);
  const values = assertValid(input, invoiceSchema, { partial: true });
  const replaceItems = input.items !== undefined;

  // Issued invoices with payments may not have their money changed.
  if (before.status === 'issued' && Number(before.paid_minor) > 0 && (replaceItems || input.notes === undefined)) {
    const moneyFields = ['invoice_date', 'due_date', 'items'];
    const touchingMoney = moneyFields.some((field) => input[field] !== undefined);
    if (touchingMoney) throw new ConflictError('billing.paidInvoiceLocked');
  }

  return withTransaction(db, () => {
    if (replaceItems) {
      const validatedItems = (Array.isArray(input.items) ? input.items : []).map(normalizeInvoiceItem).map((item, index) => {
        const parsed = assertValid(item, invoiceItemSchema, { partial: true });
        const missing = ['description'].filter((field) => parsed[field] === undefined);
        if (missing.length) {
          throw new ValidationError('validation.failed', missing.map((field) => ({ field: `items.${index}.${field}`, key: 'validation.required' })));
        }
        return parsed;
      });
      const calculated = calculateItems(validatedItems);
      run(db, 'DELETE FROM invoice_items WHERE invoice_id = ?', [invoiceId]);
      insertInvoiceItems(db, invoiceId, calculated);
      markTreatmentsInvoiced(db, invoiceId, calculated);
    }
    const columns = Object.keys(values).filter((col) => col !== 'items' && col !== 'status');
    if (columns.length) {
      run(db, `UPDATE invoices SET ${columns.map((col) => `${col} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`, [
        ...columns.map((col) => values[col]),
        ctx.user?.id ?? null,
        nowIso(),
        invoiceId,
      ]);
    }
    // Issuing a draft allocates the official document number.
    if (values.status === 'issued' && before.status === 'draft') {
      const allocation = nextNumber(db, ctx.clinicId, 'invoice');
      run(db, 'UPDATE invoices SET status = \'issued\', invoice_number = ?, issued_at = ?, updated_at = ? WHERE id = ?', [
        allocation.code,
        nowIso(),
        nowIso(),
        invoiceId,
      ]);
    }
    recalculateInvoice(db, invoiceId);
    const after = get(db, 'SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    indexInvoice(db, invoiceId);
    const diff = diffForAudit(before, after, ['invoice_number', 'invoice_date', 'due_date', 'status', 'total_minor', 'notes']);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'update',
      module: 'billing',
      entity: 'invoice',
      entityId: invoiceId,
      summary: `Invoice ${after.invoice_number} updated`,
      severity: 'notice',
      before: diff.before,
      after: diff.after,
    });
    return getInvoice(db, ctx, invoiceId);
  });
}

/**
 * Void an issued invoice. The document number is retained (never reused) and the
 * record stays visible in history with its void reason (§ 35).
 */
export function voidInvoice(db, ctx, invoiceId, reason) {
  const invoice = get(db, 'SELECT * FROM invoices WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [invoiceId, ctx.clinicId]);
  if (!invoice) throw new NotFoundError('invoice', invoiceId);
  if (invoice.status === 'void') throw new ConflictError('billing.alreadyVoid');
  if (!reason || String(reason).trim().length < 3) {
    throw new ValidationError('validation.failed', [{ field: 'reason', key: 'billing.voidReasonRequired' }]);
  }
  const payments = get(db, 'SELECT COUNT(*) AS c FROM payments WHERE invoice_id = ? AND voided_at IS NULL AND deleted_at IS NULL', [invoiceId]);
  if (Number(payments?.c ?? 0) > 0) {
    throw new ConflictError('billing.voidWithPayments');
  }
  return withTransaction(db, () => {
    run(
      db,
      'UPDATE invoices SET status = \'void\', voided_at = ?, void_reason = ?, voided_by = ?, updated_at = ? WHERE id = ?',
      [nowIso(), reason, ctx.user?.id ?? null, nowIso(), invoiceId],
    );
    run(db, 'UPDATE treatments SET invoice_id = NULL WHERE invoice_id = ?', [invoiceId]);
    indexInvoice(db, invoiceId);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'void',
      module: 'billing',
      entity: 'invoice',
      entityId: invoiceId,
      summary: `Invoice ${invoice.invoice_number} voided: ${reason}`,
      severity: 'warning',
      before: { status: invoice.status, total_minor: invoice.total_minor },
      after: { status: 'void', reason },
    });
    return { voided: true };
  });
}

export function deleteDraftInvoice(db, ctx, invoiceId) {
  const invoice = get(db, 'SELECT * FROM invoices WHERE id = ? AND clinic_id = ?', [invoiceId, ctx.clinicId]);
  if (!invoice) throw new NotFoundError('invoice', invoiceId);
  if (invoice.status !== 'draft') {
    throw new PermissionError('billing.void', { hint: 'Only draft invoices can be deleted' });
  }
  run(db, 'UPDATE invoices SET deleted_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), invoiceId]);
  removeFromIndex(db, 'invoice', invoiceId);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'delete_draft',
    module: 'billing',
    entity: 'invoice',
    entityId: invoiceId,
    summary: `Draft invoice ${invoice.invoice_number} discarded`,
    severity: 'info',
  });
  return { deleted: true };
}

export function markInvoicePrinted(db, ctx, invoiceId) {
  run(db, 'UPDATE invoices SET printed_count = printed_count + 1 WHERE id = ? AND clinic_id = ?', [invoiceId, ctx.clinicId]);
  return { ok: true };
}

/** Outstanding receivables with ageing buckets (§ 40). */
export function receivables(db, ctx, { asOf = todayIso(), patientId = null } = {}) {
  const args = [ctx.clinicId];
  let filter = '';
  if (patientId) {
    filter = ' AND i.patient_id = ?';
    args.push(Number(patientId));
  }
  const rows = all(
    db,
    `SELECT i.id, i.invoice_number, i.invoice_date, i.due_date, i.total_minor, i.paid_minor, i.due_minor,
            p.id AS patient_id, p.full_name AS patient_name, p.patient_code, p.phone
       FROM invoices i JOIN patients p ON p.id = i.patient_id
      WHERE i.clinic_id = ? AND i.status = 'issued' AND i.due_minor > 0 AND i.deleted_at IS NULL ${filter}
      ORDER BY i.invoice_date ASC`,
    args,
  );
  const buckets = { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 };
  const items = rows.map((row) => {
    const age = row.due_date
      ? Math.max(0, Math.round((new Date(asOf).getTime() - new Date(row.due_date).getTime()) / 86400000))
      : 0;
    const bucket = age <= 0 ? 'current' : age <= 30 ? 'days1to30' : age <= 60 ? 'days31to60' : age <= 90 ? 'days61to90' : 'over90';
    buckets[bucket] += Number(row.due_minor);
    return {
      invoiceId: Number(row.id),
      invoiceNumber: row.invoice_number,
      invoiceDate: row.invoice_date,
      dueDate: row.due_date,
      totalMinor: Number(row.total_minor),
      paidMinor: Number(row.paid_minor),
      dueMinor: Number(row.due_minor),
      patientId: Number(row.patient_id),
      patientName: row.patient_name,
      patientCode: row.patient_code,
      phone: row.phone,
      ageDays: age,
      bucket,
    };
  });
  return {
    items,
    totals: buckets,
    totalDueMinor: rows.reduce((sum, row) => sum + Number(row.due_minor), 0),
    patientCount: new Set(rows.map((row) => row.patient_id)).size,
  };
}

/** Outstanding summary per patient (used by the patient list and reports). */
export function outstandingSummary(db, ctx, { limit = 200 } = {}) {
  const rows = all(
    db,
    `SELECT p.id, p.patient_code, p.full_name, p.phone,
            SUM(i.due_minor) AS due_minor, COUNT(i.id) AS invoice_count,
            MIN(i.invoice_date) AS oldest_invoice
       FROM invoices i JOIN patients p ON p.id = i.patient_id
      WHERE i.clinic_id = ? AND i.status = 'issued' AND i.due_minor > 0 AND i.deleted_at IS NULL AND p.deleted_at IS NULL
      GROUP BY p.id
      ORDER BY due_minor DESC
      LIMIT ?`,
    [ctx.clinicId, Math.min(1000, Math.max(1, limit))],
  );
  return rows.map((row) => ({
    patientId: Number(row.id),
    patientCode: row.patient_code,
    patientName: row.full_name,
    phone: row.phone,
    dueMinor: Number(row.due_minor),
    invoiceCount: Number(row.invoice_count),
    oldestInvoice: row.oldest_invoice,
  }));
}

/** Data used by the printed invoice/receipt documents (§ 37, § 38). */
export function invoiceDocument(db, ctx, invoiceId) {
  const invoice = getInvoice(db, ctx, invoiceId);
  const clinic = get(db, 'SELECT * FROM clinics WHERE id = ?', [ctx.clinicId]);
  const settings = getSettings(db, ctx.clinicId);
  return {
    invoice,
    clinic,
    settings: {
      taxLabel: settings['billing.taxLabel'],
      taxRateBp: settings['billing.taxRateBp'],
      footer: settings['billing.invoiceFooter'],
      terms: settings['billing.terms'],
      showLogo: settings['print.showClinicLogo'],
      showSignatures: settings['print.showSignatures'],
      termLabel: settings['billing.taxEnabled'] ? settings['billing.taxLabel'] : null,
    },
  };
}

export { allocate, percentOf, parseAmount, placeholders };
