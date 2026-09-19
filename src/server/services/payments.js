/**
 * Payments, receipts, refunds and patient credit (§ 34, § 36, § 71).
 *
 * Rules enforced here:
 *  - a receipt number is unique and never reused; voiding keeps the number,
 *  - partial and multiple payments are supported; the invoice balance is always
 *    recomputed from the payment ledger,
 *  - overpayment is refused unless the clinic allows it *and* the operator
 *    confirms; accepted overpayment becomes tracked patient credit,
 *  - refunds never delete the original payment — they post a linked counter-entry,
 *  - every payment creates its income row so Finance reporting cannot drift.
 */
import { all, get, run, withTransaction, nowIso } from '../db/connection.js';
import { resolvePaging } from '../db/query.js';
import { assertValid } from '../domain/validation.js';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors.js';
import { PAYMENT_KINDS } from '../../shared/constants.js';
import { todayIso } from '../domain/dates.js';
import { parseAmount } from '../domain/money.js';
import { getSettings } from './settings.js';
import { nextNumber } from './numbering.js';
import { recordAudit } from './audit.js';
import { recalculateInvoice, shapeInvoice } from './billing.js';

export const paymentSchema = {
  patient_id: { type: 'id', required: true },
  invoice_id: { type: 'id', nullable: true },
  visit_id: { type: 'id', nullable: true },
  payment_date: { type: 'date', required: true, default: () => todayIso() },
  amount_minor: { type: 'int', min: 0, nullable: true },
  method_id: { type: 'id', nullable: true },
  method_code: { type: 'string', maxLength: 32, default: 'cash' },
  reference_no: { type: 'string', maxLength: 80, nullable: true },
  notes: { type: 'text', maxLength: 1000, nullable: true },
  use_credit: { type: 'boolean', default: false },
  allow_overpayment: { type: 'boolean', default: false },
};

/**
 * Public shape of the row.
 * @param {any} row
 * @returns {any}
 */
export function shapePayment(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    receiptNumber: row.receipt_number,
    patientId: Number(row.patient_id),
    patientName: row.patient_name ?? null,
    patientCode: row.patient_code ?? null,
    invoiceId: row.invoice_id ?? null,
    invoiceNumber: row.invoice_number ?? null,
    visitId: row.visit_id ?? null,
    paymentDate: row.payment_date,
    kind: row.kind,
    amountMinor: Number(row.amount_minor),
    methodId: row.method_id ?? null,
    methodCode: row.method_code,
    methodName: row.method_name ?? null,
    referenceNo: row.reference_no,
    notes: row.notes,
    refundOfId: row.refund_of_id ?? null,
    refundReason: row.refund_reason,
    creditAppliedMinor: Number(row.credit_applied_minor ?? 0),
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    createdAt: row.created_at,
    createdBy: row.created_by_name ?? null,
    printedCount: Number(row.printed_count ?? 0),
  };
}

const PAYMENT_SELECT = `
  SELECT pm.*, p.full_name AS patient_name, p.patient_code, i.invoice_number,
         m.name_en AS method_name, u.display_name AS created_by_name
    FROM payments pm
    JOIN patients p ON p.id = pm.patient_id
    LEFT JOIN invoices i ON i.id = pm.invoice_id
    LEFT JOIN payment_methods m ON m.id = pm.method_id
    LEFT JOIN users u ON u.id = pm.created_by`;

/**
 * @param {any} db
 * @param {any} ctx
 * @param {{ method_id?: number|null, method_code?: string|null }} input
 */
function resolveMethod(db, ctx, { method_id, method_code }) {
  if (method_id) {
    const method = get(db, 'SELECT * FROM payment_methods WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [
      method_id,
      ctx.clinicId,
    ]);
    if (!method) throw new NotFoundError('payment_method', method_id);
    return method;
  }
  const code = String(method_code ?? 'cash').toLowerCase();
  const method = get(db, 'SELECT * FROM payment_methods WHERE clinic_id = ? AND lower(code) = ? AND deleted_at IS NULL', [
    ctx.clinicId,
    code,
  ]);
  if (!method) {
    // Legacy/unknown codes fall back to the generic "other" method rather than failing.
    const fallback = get(db, "SELECT * FROM payment_methods WHERE clinic_id = ? AND code = 'other' AND deleted_at IS NULL", [
      ctx.clinicId,
    ]);
    if (!fallback) throw new ValidationError('validation.failed', [{ field: 'method_code', key: 'payments.unknownMethod' }]);
    return fallback;
  }
  return method;
}

export function patientCreditBalance(db, clinicId, patientId) {
  const row = get(db, 'SELECT COALESCE(SUM(amount_minor), 0) AS balance FROM patient_credits WHERE patient_id = ? AND clinic_id = ?', [
    patientId,
    clinicId,
  ]);
  return Number(row?.balance ?? 0);
}

/**
 * @param {any} db
 * @param {any} ctx
 * @param {{ patientId: number, amountMinor: number, kind: string, paymentId?: number|null, invoiceId?: number|null, note?: string|null }} entry
 */
function postCreditEntry(db, ctx, { patientId, amountMinor, kind, paymentId = null, invoiceId = null, note = null }) {
  const balance = patientCreditBalance(db, ctx.clinicId, patientId) + amountMinor;
  run(
    db,
    `INSERT INTO patient_credits (clinic_id, patient_id, entry_date, kind, amount_minor, balance_after_minor, payment_id, invoice_id, note, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      ctx.clinicId,
      patientId,
      todayIso(),
      kind,
      amountMinor,
      balance,
      paymentId,
      invoiceId,
      note,
      ctx.user?.id ?? null,
    ],
  );
  return balance;
}

function resolveIncomeCategoryId(db, ctx, source) {
  const preferred =
    source === 'treatment'
      ? db.query("SELECT id FROM income_categories WHERE clinic_id = ? AND is_system = 1 ORDER BY sort_order LIMIT 1").get(ctx.clinicId)
      : null;
  if (preferred) return preferred.id;
  const fallback = db.query('SELECT id FROM income_categories WHERE clinic_id = ? ORDER BY sort_order LIMIT 1').get(ctx.clinicId);
  return fallback?.id ?? null;
}

/**
 * Record a payment against an invoice (or as an advance on the patient account).
 */
export function recordPayment(db, ctx, input) {
  const values = assertValid(input, paymentSchema);
  const settings = getSettings(db, ctx.clinicId);
  const patient = get(db, 'SELECT id, patient_code, full_name FROM patients WHERE id = ? AND clinic_id = ?', [
    values.patient_id,
    ctx.clinicId,
  ]);
  if (!patient) throw new NotFoundError('patient', values.patient_id);

  let amountMinor = values.amount_minor ?? parseAmount(input.amount, 2) ?? 0;
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new ValidationError('validation.failed', [{ field: 'amount', key: 'payments.amountRequired' }]);
  }

  const invoice = values.invoice_id
    ? get(db, 'SELECT * FROM invoices WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [values.invoice_id, ctx.clinicId])
    : null;
  if (values.invoice_id && !invoice) throw new NotFoundError('invoice', values.invoice_id);
  if (invoice && invoice.patient_id !== values.patient_id) {
    throw new ValidationError('validation.failed', [{ field: 'invoice_id', key: 'payments.invoicePatientMismatch' }]);
  }
  if (invoice && invoice.status !== 'issued') {
    throw new ConflictError('payments.invoiceNotIssued');
  }

  const method = resolveMethod(db, ctx, values);
  const dueMinor = invoice ? Number(invoice.due_minor) : 0;
  const creditAvailable = patientCreditBalance(db, ctx.clinicId, values.patient_id);

  let creditApplied = 0;
  let cashPortion = amountMinor;
  if (values.use_credit && creditAvailable > 0 && invoice) {
    creditApplied = Math.min(creditAvailable, dueMinor, amountMinor);
    cashPortion = amountMinor - creditApplied;
  }

  let overpayment = 0;
  if (invoice) {
    const remainingAfterCredit = Math.max(0, dueMinor - creditApplied);
    if (cashPortion > remainingAfterCredit) {
      overpayment = cashPortion - remainingAfterCredit;
      const allowed = Boolean(settings['billing.allowOverpayment']) && Boolean(values.allow_overpayment);
      if (!allowed) {
        throw new ConflictError('payments.overpaymentConfirm', {
          dueMinor: remainingAfterCredit,
          excessMinor: overpayment,
          allowSetting: Boolean(settings['billing.allowOverpayment']),
        });
      }
    }
  }

  return withTransaction(db, () => {
    const created = [];
    if (creditApplied > 0) {
      const allocation = nextNumber(db, ctx.clinicId, 'receipt');
      const result = run(
        db,
        `INSERT INTO payments
          (clinic_id, patient_id, invoice_id, visit_id, receipt_number, payment_date, kind, amount_minor, method_id, method_code,
           reference_no, notes, created_by, updated_by)
         VALUES (?,?,?,?,?,?, 'credit_used', ?, ?, ?, NULL, ?, ?, ?)`,
        [
          ctx.clinicId,
          values.patient_id,
          invoice?.id ?? null,
          values.visit_id ?? null,
          allocation.code,
          values.payment_date,
          creditApplied,
          method.id,
          method.code,
          'Applied from patient credit',
          ctx.user?.id ?? null,
          ctx.user?.id ?? null,
        ],
      );
      const paymentId = Number(result.lastInsertRowid);
      postCreditEntry(db, ctx, {
        patientId: values.patient_id,
        amountMinor: -creditApplied,
        kind: 'used',
        paymentId,
        invoiceId: invoice?.id ?? null,
        note: 'Credit applied to invoice',
      });
      created.push({ id: paymentId, receiptNumber: allocation.code, kind: 'credit_used', amountMinor: creditApplied });
    }

    if (cashPortion > 0) {
      const allocation = nextNumber(db, ctx.clinicId, 'receipt');
      const result = run(
        db,
        `INSERT INTO payments
          (clinic_id, patient_id, invoice_id, visit_id, receipt_number, payment_date, kind, amount_minor, method_id, method_code,
           reference_no, notes, credit_applied_minor, created_by, updated_by)
         VALUES (?,?,?,?,?,?, 'payment', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ctx.clinicId,
          values.patient_id,
          invoice?.id ?? null,
          values.visit_id ?? null,
          allocation.code,
          values.payment_date,
          cashPortion,
          method.id,
          method.code,
          values.reference_no ?? null,
          values.notes ?? null,
          creditApplied,
          ctx.user?.id ?? null,
          ctx.user?.id ?? null,
        ],
      );
      const paymentId = Number(result.lastInsertRowid);
      created.push({ id: paymentId, receiptNumber: allocation.code, kind: 'payment', amountMinor: cashPortion });

      if (settings['billing.autoCreateIncome']) {
        const categoryId = resolveIncomeCategoryId(db, ctx, invoice ? 'treatment' : 'other');
        run(
          db,
          `INSERT INTO incomes (clinic_id, income_date, category_id, source, patient_id, invoice_id, payment_id, amount_minor,
             method_code, reference_no, description, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            ctx.clinicId,
            values.payment_date,
            categoryId,
            invoice ? 'treatment' : 'other',
            values.patient_id,
            invoice?.id ?? null,
            paymentId,
            cashPortion,
            method.code,
            values.reference_no ?? null,
            invoice ? `Payment against ${invoice.invoice_number}` : 'Advance payment',
            ctx.user?.id ?? null,
          ],
        );
      }

      if (overpayment > 0) {
        postCreditEntry(db, ctx, {
          patientId: values.patient_id,
          amountMinor: overpayment,
          kind: 'overpayment',
          paymentId,
          invoiceId: invoice?.id ?? null,
          note: 'Overpayment held as patient credit',
        });
      }
    }

    if (invoice) recalculateInvoice(db, invoice.id);

    const primary = created.find((entry) => entry.kind === 'payment') ?? created[0];
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'payment',
      module: 'payments',
      entity: 'payment',
      entityId: primary?.id ?? null,
      summary: `Payment of ${amountMinor} received for ${patient.patient_code}${invoice ? ` against ${invoice.invoice_number}` : ''}`,
      severity: 'notice',
      after: {
        amount_minor: amountMinor,
        method: method.code,
        invoice: invoice?.invoice_number ?? null,
        credit_applied_minor: creditApplied,
        overpayment_minor: overpayment,
      },
      ip: ctx.ip,
    });

    return {
      receipts: created,
      amountMinor,
      creditAppliedMinor: creditApplied,
      overpaymentMinor: overpayment,
      creditBalanceMinor: patientCreditBalance(db, ctx.clinicId, values.patient_id),
      invoice: invoice ? shapeInvoice(get(db, 'SELECT * FROM invoices WHERE id = ?', [invoice.id])) : null,
    };
  });
}

export function getPayment(db, ctx, paymentId) {
  const row = get(db, `${PAYMENT_SELECT} WHERE pm.id = ? AND pm.clinic_id = ?`, [paymentId, ctx.clinicId]);
  if (!row) throw new NotFoundError('payment', paymentId);
  return shapePayment(row);
}

export function listPayments(db, ctx, params = {}) {
  const where = ['pm.clinic_id = ?', 'pm.deleted_at IS NULL'];
  const args = [ctx.clinicId];
  if (params.patientId) {
    where.push('pm.patient_id = ?');
    args.push(Number(params.patientId));
  }
  if (params.invoiceId) {
    where.push('pm.invoice_id = ?');
    args.push(Number(params.invoiceId));
  }
  if (params.kind && PAYMENT_KINDS.includes(params.kind)) {
    where.push('pm.kind = ?');
    args.push(params.kind);
  }
  if (params.methodCode) {
    where.push('pm.method_code = ?');
    args.push(String(params.methodCode));
  }
  if (params.from) {
    where.push('pm.payment_date >= ?');
    args.push(params.from);
  }
  if (params.to) {
    where.push('pm.payment_date <= ?');
    args.push(params.to);
  }
  if (params.includeVoided !== true && params.includeVoided !== 'true') {
    where.push('pm.voided_at IS NULL');
  }
  if (params.search) {
    where.push("(pm.receipt_number LIKE ? ESCAPE '\\' OR p.full_name LIKE ? ESCAPE '\\' OR p.patient_code LIKE ? ESCAPE '\\' OR COALESCE(i.invoice_number,'') LIKE ? ESCAPE '\\')");
    const pattern = `%${String(params.search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(pattern, pattern, pattern, pattern);
  }
  const page = resolvePaging(params);
  const whereSql = where.join(' AND ');
  const total = Number(
    get(db, `SELECT COUNT(*) AS c FROM payments pm JOIN patients p ON p.id = pm.patient_id LEFT JOIN invoices i ON i.id = pm.invoice_id WHERE ${whereSql}`, args)?.c ?? 0,
  );
  const rows = all(
    db,
    `${PAYMENT_SELECT} WHERE ${whereSql} ORDER BY pm.payment_date DESC, pm.id DESC LIMIT ? OFFSET ?`,
    [...args, page.pageSize, page.offset],
  );
  const totals = get(
    db,
    `SELECT
        COALESCE(SUM(CASE WHEN pm.kind IN ('payment','credit_used') THEN pm.amount_minor ELSE 0 END), 0) AS collected,
        COALESCE(SUM(CASE WHEN pm.kind = 'refund' THEN pm.amount_minor ELSE 0 END), 0) AS refunded
      FROM payments pm JOIN patients p ON p.id = pm.patient_id LEFT JOIN invoices i ON i.id = pm.invoice_id WHERE ${whereSql}`,
    args,
  );
  return {
    rows: rows.map(shapePayment),
    total,
    page: page.page,
    pageSize: page.pageSize,
    pages: Math.max(1, Math.ceil(total / page.pageSize)),
    totalsMinor: {
      collected: Number(totals?.collected ?? 0),
      refunded: Number(totals?.refunded ?? 0),
      net: Number(totals?.collected ?? 0) - Number(totals?.refunded ?? 0),
    },
  };
}

/** Void a payment (mistake) — keeps the receipt number and reverses the income. */
export function voidPayment(db, ctx, paymentId, reason) {
  const payment = get(db, 'SELECT * FROM payments WHERE id = ? AND clinic_id = ?', [paymentId, ctx.clinicId]);
  if (!payment) throw new NotFoundError('payment', paymentId);
  if (payment.voided_at) throw new ConflictError('payments.alreadyVoid');
  if (!reason || String(reason).trim().length < 3) {
    throw new ValidationError('validation.failed', [{ field: 'reason', key: 'payments.voidReasonRequired' }]);
  }
  return withTransaction(db, () => {
    run(db, 'UPDATE payments SET voided_at = ?, void_reason = ?, voided_by = ?, updated_at = ? WHERE id = ?', [
      nowIso(),
      reason,
      ctx.user?.id ?? null,
      nowIso(),
      paymentId,
    ]);
    run(db, 'UPDATE incomes SET is_reversed = 1, updated_at = ? WHERE payment_id = ?', [nowIso(), paymentId]);

    // Credit effects are reversed so the patient balance stays truthful.
    if (payment.kind === 'credit_used') {
      postCreditEntry(db, ctx, {
        patientId: payment.patient_id,
        amountMinor: Number(payment.amount_minor),
        kind: 'reversal',
        paymentId,
        note: `Credit usage voided: ${reason}`,
      });
    } else {
      const creditEntries = all(db, 'SELECT * FROM patient_credits WHERE payment_id = ? AND kind = \'overpayment\'', [paymentId]);
      for (const entry of creditEntries) {
        postCreditEntry(db, ctx, {
          patientId: payment.patient_id,
          amountMinor: -Number(entry.amount_minor),
          kind: 'reversal',
          paymentId,
          note: `Overpayment credit reversed: ${reason}`,
        });
      }
    }
    if (payment.invoice_id) recalculateInvoice(db, payment.invoice_id);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'void_payment',
      module: 'payments',
      entity: 'payment',
      entityId: paymentId,
      summary: `Receipt ${payment.receipt_number} voided: ${reason}`,
      severity: 'warning',
      before: { amount_minor: payment.amount_minor, kind: payment.kind },
      after: { voided: true, reason },
    });
    return { voided: true };
  });
}

/** Refund money to the patient against an earlier receipt. */
export function refundPayment(db, ctx, input) {
  const values = assertValid(
    input,
    {
      payment_id: { type: 'id', required: true },
      amount_minor: { type: 'int', min: 0, nullable: true },
      refund_date: { type: 'date', nullable: true },
      method_id: { type: 'id', nullable: true },
      method_code: { type: 'string', maxLength: 32, default: 'cash' },
      reason: { type: 'string', required: true, minLength: 3, maxLength: 500 },
      reference_no: { type: 'string', maxLength: 80, nullable: true },
    },
  );
  const original = get(db, 'SELECT * FROM payments WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [
    values.payment_id,
    ctx.clinicId,
  ]);
  if (!original) throw new NotFoundError('payment', values.payment_id);
  if (original.voided_at) throw new ConflictError('payments.cannotRefundVoided');
  if (original.kind !== 'payment') throw new ConflictError('payments.cannotRefundNonPayment');

  const alreadyRefunded = Number(
    get(
      db,
      'SELECT COALESCE(SUM(amount_minor),0) AS refunded FROM payments WHERE refund_of_id = ? AND voided_at IS NULL AND deleted_at IS NULL',
      [original.id],
    )?.refunded ?? 0,
  );
  const refundable = Number(original.amount_minor) - alreadyRefunded;
  const amountMinor = values.amount_minor ?? refundable;
  if (amountMinor <= 0) throw new ValidationError('validation.failed', [{ field: 'amount', key: 'payments.amountRequired' }]);
  if (amountMinor > refundable) {
    throw new ConflictError('payments.refundExceeds', { refundableMinor: refundable, requestedMinor: amountMinor });
  }

  const method = resolveMethod(db, ctx, values);
  const refundDate = values.refund_date ?? todayIso();

  return withTransaction(db, () => {
    const allocation = nextNumber(db, ctx.clinicId, 'receipt');
    const result = run(
      db,
      `INSERT INTO payments
        (clinic_id, patient_id, invoice_id, visit_id, receipt_number, payment_date, kind, amount_minor, method_id, method_code,
         reference_no, notes, refund_of_id, refund_reason, created_by, updated_by)
       VALUES (?,?,?,?,?,?, 'refund', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ctx.clinicId,
        original.patient_id,
        original.invoice_id,
        original.visit_id,
        allocation.code,
        refundDate,
        amountMinor,
        method.id,
        method.code,
        values.reference_no ?? null,
        `Refund of ${original.receipt_number}`,
        original.id,
        values.reason,
        ctx.user?.id ?? null,
        ctx.user?.id ?? null,
      ],
    );
    const refundId = Number(result.lastInsertRowid);
    // Income recognition is reduced (or reversed) rather than deleted.
    const income = get(db, 'SELECT * FROM incomes WHERE payment_id = ?', [original.id]);
    if (income) {
      run(db, 'UPDATE incomes SET is_reversed = 1, updated_at = ? WHERE id = ?', [nowIso(), income.id]);
    }
    if (original.invoice_id) recalculateInvoice(db, original.invoice_id);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'refund',
      module: 'payments',
      entity: 'payment',
      entityId: refundId,
      summary: `Refund ${allocation.code} of ${amountMinor} against ${original.receipt_number}: ${values.reason}`,
      severity: 'warning',
      after: { amount_minor: amountMinor, method: method.code, refund_of: original.receipt_number },
    });
    return { id: refundId, receiptNumber: allocation.code, amountMinor, refundableRemaining: refundable - amountMinor };
  });
}

/** Apply existing patient credit to an outstanding invoice. */
export function applyCredit(db, ctx, { patient_id, invoice_id, amount_minor = null }) {
  const invoice = get(db, 'SELECT * FROM invoices WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [invoice_id, ctx.clinicId]);
  if (!invoice) throw new NotFoundError('invoice', invoice_id);
  if (invoice.patient_id !== Number(patient_id)) throw new ConflictError('payments.invoicePatientMismatch');
  if (invoice.status !== 'issued') throw new ConflictError('payments.invoiceNotIssued');
  const balance = patientCreditBalance(db, ctx.clinicId, invoice.patient_id);
  if (balance <= 0) throw new ConflictError('payments.noCredit');
  const amount = Math.min(amount_minor ?? balance, balance, Number(invoice.due_minor));
  if (amount <= 0) throw new ConflictError('payments.nothingToApply');

  return withTransaction(db, () => {
    const allocation = nextNumber(db, ctx.clinicId, 'receipt');
    const result = run(
      db,
      `INSERT INTO payments (clinic_id, patient_id, invoice_id, receipt_number, payment_date, kind, amount_minor, method_code, notes, created_by, updated_by)
       VALUES (?,?,?,?,?, 'credit_used', ?, 'credit', 'Patient credit applied', ?, ?)`,
      [ctx.clinicId, invoice.patient_id, invoice.id, allocation.code, todayIso(), amount, ctx.user?.id ?? null, ctx.user?.id ?? null],
    );
    const paymentId = Number(result.lastInsertRowid);
    postCreditEntry(db, ctx, {
      patientId: invoice.patient_id,
      amountMinor: -amount,
      kind: 'used',
      paymentId,
      invoiceId: invoice.id,
      note: 'Credit applied to invoice',
    });
    recalculateInvoice(db, invoice.id);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'apply_credit',
      module: 'payments',
      entity: 'payment',
      entityId: paymentId,
      summary: `Credit of ${amount} applied to ${invoice.invoice_number}`,
      severity: 'notice',
    });
    return { id: paymentId, appliedMinor: amount, remainingCreditMinor: balance - amount };
  });
}

export function markReceiptPrinted(db, ctx, paymentId) {
  run(db, 'UPDATE payments SET printed_count = printed_count + 1 WHERE id = ? AND clinic_id = ?', [paymentId, ctx.clinicId]);
  return { ok: true };
}

/** Receipt document data (§ 36). */
export function receiptDocument(db, ctx, paymentId) {
  const payment = getPayment(db, ctx, paymentId);
  if (!payment) throw new NotFoundError('payment', paymentId);
  const clinic = get(db, 'SELECT * FROM clinics WHERE id = ?', [ctx.clinicId]);
  const settings = getSettings(db, ctx.clinicId);
  const invoiceRow = payment.invoiceId
    ? get(db, 'SELECT id, invoice_number, invoice_date, total_minor, paid_minor, due_minor, status FROM invoices WHERE id = ?', [
        payment.invoiceId,
      ])
    : null;
  const invoice = invoiceRow
    ? {
        id: Number(invoiceRow.id),
        invoiceNumber: invoiceRow.invoice_number,
        invoiceDate: invoiceRow.invoice_date,
        totalMinor: Number(invoiceRow.total_minor),
        paidMinor: Number(invoiceRow.paid_minor),
        dueMinor: Number(invoiceRow.due_minor),
        status: invoiceRow.status,
      }
    : null;
  const patientCredit = patientCreditBalance(db, ctx.clinicId, payment.patientId);
  return {
    payment,
    clinic,
    invoice,
    patientCreditMinor: patientCredit,
    settings: {
      footer: settings['billing.receiptFooter'],
      showLogo: settings['print.showClinicLogo'],
      showSignatures: settings['print.showSignatures'],
      currencyMinimal: settings['print.showClinicLogo'],
    },
  };
}

/** Daily collection summary (dashboard + Finance). */
export function collectionSummary(db, ctx, { from, to }) {
  const rows = all(
    db,
    `SELECT payment_date AS date,
            COALESCE(SUM(CASE WHEN kind IN ('payment','credit_used') THEN amount_minor ELSE 0 END), 0) AS collected,
            COALESCE(SUM(CASE WHEN kind = 'refund' THEN amount_minor ELSE 0 END), 0) AS refunded,
            COUNT(*) AS transactions
       FROM payments
      WHERE clinic_id = ? AND deleted_at IS NULL AND voided_at IS NULL AND payment_date BETWEEN ? AND ?
      GROUP BY payment_date ORDER BY payment_date`,
    [ctx.clinicId, from, to],
  );
  const methods = all(
    db,
    `SELECT method_code,
            COALESCE(SUM(CASE WHEN kind IN ('payment','credit_used') THEN amount_minor ELSE 0 END), 0) AS collected,
            COUNT(*) AS transactions
       FROM payments
      WHERE clinic_id = ? AND deleted_at IS NULL AND voided_at IS NULL AND payment_date BETWEEN ? AND ?
      GROUP BY method_code ORDER BY collected DESC`,
    [ctx.clinicId, from, to],
  );
  return {
    daily: rows.map((row) => ({
      date: row.date,
      collectedMinor: Number(row.collected),
      refundedMinor: Number(row.refunded),
      netMinor: Number(row.collected) - Number(row.refunded),
      transactions: Number(row.transactions),
    })),
    byMethod: methods.map((row) => ({
      methodCode: row.method_code,
      collectedMinor: Number(row.collected),
      transactions: Number(row.transactions),
    })),
    totalCollectedMinor: rows.reduce((sum, row) => sum + Number(row.collected), 0),
    totalRefundedMinor: rows.reduce((sum, row) => sum + Number(row.refunded), 0),
    totalNetMinor:
      rows.reduce((sum, row) => sum + Number(row.collected), 0) - rows.reduce((sum, row) => sum + Number(row.refunded), 0),
    transactions: rows.reduce((sum, row) => sum + Number(row.transactions), 0),
  };
}

/* --------------------------------------------------------- payment methods */

export const paymentMethodSchema = {
  code: { type: 'string', required: true, maxLength: 32, pattern: /^[a-z0-9_-]+$/ },
  name_en: { type: 'string', required: true, maxLength: 80 },
  name_bn: { type: 'string', maxLength: 80, nullable: true },
  requires_reference: { type: 'boolean', default: false },
  is_active: { type: 'boolean', default: true },
  sort_order: { type: 'int', default: 0 },
};

export function listPaymentMethods(db, ctx, { includeInactive = false } = {}) {
  return all(
    db,
    `SELECT * FROM payment_methods WHERE clinic_id = ? AND deleted_at IS NULL ${includeInactive ? '' : 'AND is_active = 1'}
      ORDER BY sort_order, name_en`,
    [ctx.clinicId],
  ).map((row) => ({
    id: Number(row.id),
    code: row.code,
    nameEn: row.name_en,
    nameBn: row.name_bn,
    requiresReference: Boolean(row.requires_reference),
    isSystem: Boolean(row.is_system),
    isActive: Boolean(row.is_active),
  }));
}

export function savePaymentMethod(db, ctx, methodId, input) {
  const values = assertValid(input, methodId ? { ...paymentMethodSchema, code: { ...paymentMethodSchema.code, required: false } } : paymentMethodSchema, {
    partial: Boolean(methodId),
  });
  if (methodId) {
    const before = get(db, 'SELECT * FROM payment_methods WHERE id = ? AND clinic_id = ?', [methodId, ctx.clinicId]);
    if (!before) throw new NotFoundError('payment_method', methodId);
    const columns = Object.keys(values);
    if (columns.length) {
      run(db, `UPDATE payment_methods SET ${columns.map((col) => `${col} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [
        ...columns.map((col) => (typeof values[col] === 'boolean' ? (values[col] ? 1 : 0) : values[col])),
        nowIso(),
        methodId,
      ]);
    }
    return { id: methodId };
  }
  const result = run(
    db,
    `INSERT INTO payment_methods (clinic_id, code, name_en, name_bn, requires_reference, is_active, sort_order)
     VALUES (?,?,?,?,?,?,?)`,
    [
      ctx.clinicId,
      values.code,
      values.name_en,
      values.name_bn ?? null,
      values.requires_reference ? 1 : 0,
      values.is_active ? 1 : 0,
      values.sort_order,
    ],
  );
  return { id: Number(result.lastInsertRowid) };
}

export function deletePaymentMethod(db, ctx, methodId) {
  const method = get(db, 'SELECT * FROM payment_methods WHERE id = ? AND clinic_id = ?', [methodId, ctx.clinicId]);
  if (!method) throw new NotFoundError('payment_method', methodId);
  if (method.is_system) {
    throw new ConflictError('payments.systemMethodCannotDelete');
  }
  run(db, 'UPDATE payment_methods SET is_active = 0, deleted_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), methodId]);
  return { deleted: true };
}

export { parseAmount };
