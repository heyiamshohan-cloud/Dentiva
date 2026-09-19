/**
 * Billing, payment and finance integration tests (§ 33–§ 41, § 71):
 * invoice maths, numbering, partial/over payments, refunds, voiding, patient
 * credit, receivables ageing and the finance summaries.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { createTestEnv } from '../helpers/testEnv.js';
import { createPatient } from '../../src/server/services/patients.js';
import { createTreatment } from '../../src/server/services/treatments.js';
import { createInvoice, deleteDraftInvoice, getInvoice, invoiceDocument, listInvoices, receivables, recalculateInvoice, updateInvoice, voidInvoice } from '../../src/server/services/billing.js';
import {
  applyCredit,
  collectionSummary,
  getPayment,
  listPaymentMethods,
  listPayments,
  patientCreditBalance,
  receiptDocument,
  recordPayment,
  refundPayment,
  voidPayment,
} from '../../src/server/services/payments.js';
import {
  createExpense,
  createIncome,
  dailySeries,
  deleteExpense,
  expenseSchema,
  financeSummary,
  incomeByCategory,
  listExpenseCategories,
  listIncomeCategories,
  monthlyTrend,
  expensesByCategory,
  revenueByService,
} from '../../src/server/services/finance.js';
import { ConflictError, NotFoundError, ValidationError } from '../../src/shared/errors.js';
import { setSettings } from '../../src/server/services/settings.js';
import { todayIso } from '../../src/server/domain/dates.js';

let env;
afterEach(() => env?.cleanup());

function setup() {
  env = createTestEnv();
  const ctx = { clinicId: env.clinicId, user: { id: env.admin.id, displayName: 'Admin' }, ip: '127.0.0.1' };
  return { env, ctx };
}

let seq = 0;
function patient(e, ctx, name = 'Billing Patient') {
  seq += 1;
  return createPatient(e.db, ctx, { full_name: name, gender: 'male', phone: `019${String(20000000 + seq).slice(-8)}` });
}

const item = (overrides = {}) => ({ description: 'Consultation', quantity_milli: 1000, unit_price_minor: 100000, ...overrides });

describe('invoices', () => {
  test('recomputes line and document totals from validated items', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Invoice Math');
    const invoice = createInvoice(e.db, ctx, {
      patient_id: p.id,
      items: [
        item({ description: 'Scaling', unit_price_minor: 200000, discount_type: 'percent', discount_value: 1000 }), // 10% off
        item({ description: 'Filling', unit_price_minor: 150000, tax_rate_bp: 500, quantity_milli: 2000 }),
      ],
    });
    // Line 1: 200000 − 20000 = 180000 ; Line 2: 300000 + 5% (15000) = 315000
    expect(invoice.totalMinor).toBe(495000);
    const detail = getInvoice(e.db, ctx, invoice.id);
    expect(detail.status).toBe('draft');
    expect(detail.dueMinor).toBe(495000);
    expect(detail.items.length).toBe(2);
    expect(detail.items[0].discountMinor).toBe(20000);
    expect(detail.items[1].taxMinor).toBe(15000);
    expect(detail.subtotalMinor).toBe(500000);
  });

  test('assigns official numbers on issue and never reuses them', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Numbering Patient');
    const first = createInvoice(e.db, ctx, { patient_id: p.id, status: 'issued', items: [item()] });
    const second = createInvoice(e.db, ctx, { patient_id: p.id, status: 'issued', items: [item()] });
    expect(first.invoiceNumber).toMatch(/^INV-/);
    expect(first.invoiceNumber).not.toBe(second.invoiceNumber);

    voidInvoice(e.db, ctx, second.id, 'Raised for the wrong patient');
    const third = createInvoice(e.db, ctx, { patient_id: p.id, status: 'issued', items: [item()] });
    expect(third.invoiceNumber).not.toBe(second.invoiceNumber);

    const voided = getInvoice(e.db, ctx, second.id);
    expect(voided.status).toBe('void');
    expect(voided.voidReason).toContain('wrong patient');
  });

  test('an issued but unpaid invoice can be edited, then locked once paid', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Invoice Lock');
    const invoice = createInvoice(e.db, ctx, { patient_id: p.id, status: 'issued', items: [item({ unit_price_minor: 300000 })] });
    updateInvoice(e.db, ctx, invoice.id, { items: [item({ unit_price_minor: 400000 })] });
    expect(getInvoice(e.db, ctx, invoice.id).totalMinor).toBe(400000);

    recordPayment(e.db, ctx, { patient_id: p.id, invoice_id: invoice.id, amount_minor: 100000 });
    expect(() => updateInvoice(e.db, ctx, invoice.id, { items: [item({ unit_price_minor: 500000 })] })).toThrow(ConflictError);
    // Notes can still be corrected.
    updateInvoice(e.db, ctx, invoice.id, { notes: 'Patient paid in cash' });
    expect(getInvoice(e.db, ctx, invoice.id).notes).toBe('Patient paid in cash');
  });

  test('draft invoices can be discarded, issued ones voided only when unpaid', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Invoice Delete');
    const draft = createInvoice(e.db, ctx, { patient_id: p.id, items: [item()] });
    deleteDraftInvoice(e.db, ctx, draft.id);
    expect(() => getInvoice(e.db, ctx, draft.id)).toThrow(NotFoundError);
    expect(listInvoices(e.db, ctx, { patientId: p.id }).total).toBe(0);

    const issued = createInvoice(e.db, ctx, { patient_id: p.id, status: 'issued', items: [item()] });
    expect(() => deleteDraftInvoice(e.db, ctx, issued.id)).toThrow();
    recordPayment(e.db, ctx, { patient_id: p.id, invoice_id: issued.id, amount_minor: 50000 });
    expect(() => voidInvoice(e.db, ctx, issued.id, 'Attempted void')).toThrow(ConflictError);
    expect(() => voidInvoice(e.db, ctx, issued.id, 'x')).toThrow(ValidationError);
  });

  test('outstanding balances, receivables ageing and the printed document data', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Receivables Patient');
    const invoice = createInvoice(e.db, ctx, { patient_id: p.id, status: 'issued', items: [item({ unit_price_minor: 250000 })] });
    recordPayment(e.db, ctx, { patient_id: p.id, invoice_id: invoice.id, amount_minor: 100000 });
    const open = receivables(e.db, ctx, { asOf: todayIso() });
    expect(open.items.length).toBe(1);
    expect(open.totalDueMinor).toBe(150000);
    expect(open.totals.current).toBe(150000);
    expect(open.patientCount).toBe(1);

    const document = invoiceDocument(e.db, ctx, invoice.id);
    expect(document.invoice.invoiceNumber).toBe(invoice.invoiceNumber);
    expect(document.clinic.name).toBe('Test Dental Care');
    expect(listInvoices(e.db, ctx, { onlyOutstanding: true }).totalsMinor.due).toBe(150000);

    const recalculated = recalculateInvoice(e.db, invoice.id);
    expect(recalculated.dueMinor).toBe(150000);
  });

  test('treatment invoices pick up unbilled procedures', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Treatment Invoice');
    const treatment = createTreatment(e.db, ctx, { patient_id: p.id, name: 'Extraction', fee_minor: 120000 });
    const invoice = createInvoice(e.db, ctx, { patient_id: p.id, status: 'issued', items: [{ treatment_id: treatment.id, description: 'Extraction', unit_price_minor: 120000 }] });
    expect(e.db.query('SELECT invoice_id FROM treatments WHERE id = ?').get(treatment.id).invoice_id).toBe(invoice.id);
    expect(getInvoice(e.db, ctx, invoice.id).treatments.length).toBe(1);
  });
});

describe('payments', () => {
  test('supports partial payments and keeps the invoice balance exact', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Partial Payment');
    const invoice = createInvoice(e.db, ctx, { patient_id: p.id, status: 'issued', items: [item({ unit_price_minor: 500000 })] });
    const first = recordPayment(e.db, ctx, { patient_id: p.id, invoice_id: invoice.id, amount_minor: 200000, method_code: 'cash' });
    expect(first.receipts[0].receiptNumber).toMatch(/^RCP-/);
    expect(getInvoice(e.db, ctx, invoice.id).dueMinor).toBe(300000);
    expect(getInvoice(e.db, ctx, invoice.id).paymentStatus).toBe('partial');

    recordPayment(e.db, ctx, { patient_id: p.id, invoice_id: invoice.id, amount_minor: 300000, method_code: 'bkash', reference_no: 'TX123' });
    const settled = getInvoice(e.db, ctx, invoice.id);
    expect(settled.dueMinor).toBe(0);
    expect(settled.paidMinor).toBe(500000);
    expect(settled.paymentStatus).toBe('paid');
    expect(settled.payments.length).toBe(2);

    // Overpayment is refused unless the operator explicitly confirms it.
    expect(() => recordPayment(e.db, ctx, { patient_id: p.id, invoice_id: invoice.id, amount_minor: 10000 })).toThrow(ConflictError);
  });

  test('accepted overpayment becomes tracked patient credit', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Overpayment Patient');
    setSettings(e.db, e.clinicId, { 'billing.allowOverpayment': true }, e.admin.id);
    const invoice = createInvoice(e.db, ctx, { patient_id: p.id, status: 'issued', items: [item({ unit_price_minor: 100000 })] });
    // Even with the setting on, the operator has to confirm the excess.
    expect(() => recordPayment(e.db, ctx, { patient_id: p.id, invoice_id: invoice.id, amount_minor: 150000 })).toThrow(ConflictError);
    const payment = recordPayment(e.db, ctx, { patient_id: p.id, invoice_id: invoice.id, amount_minor: 150000, allow_overpayment: true });
    expect(payment.overpaymentMinor).toBe(50000);
    expect(patientCreditBalance(e.db, e.clinicId, p.id)).toBe(50000);
    expect(getInvoice(e.db, ctx, invoice.id).dueMinor).toBe(0);

    // Credit can be applied to a later invoice.
    const second = createInvoice(e.db, ctx, { patient_id: p.id, status: 'issued', items: [item({ unit_price_minor: 80000 })] });
    const applied = applyCredit(e.db, ctx, { patient_id: p.id, invoice_id: second.id });
    expect(applied.appliedMinor).toBe(50000);
    expect(getInvoice(e.db, ctx, second.id).dueMinor).toBe(30000);
    expect(patientCreditBalance(e.db, e.clinicId, p.id)).toBe(0);
    expect(() => applyCredit(e.db, ctx, { patient_id: p.id, invoice_id: second.id })).toThrow(ConflictError);
  });

  test('payments create mirrored income rows and can be voided or refunded', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Payment Lifecycle');
    const invoice = createInvoice(e.db, ctx, { patient_id: p.id, status: 'issued', items: [item({ unit_price_minor: 200000 })] });
    const payment = recordPayment(e.db, ctx, { patient_id: p.id, invoice_id: invoice.id, amount_minor: 200000 });
    const paymentId = payment.receipts[0].id;
    expect(Number(e.db.query('SELECT COUNT(*) AS c FROM incomes WHERE payment_id = ?').get(paymentId).c)).toBe(1);

    const refund = refundPayment(e.db, ctx, { payment_id: paymentId, amount_minor: 50000, reason: 'Treatment not performed' });
    expect(refund.amountMinor).toBe(50000);
    expect(getInvoice(e.db, ctx, invoice.id).dueMinor).toBe(50000);
    expect(Number(e.db.query("SELECT COALESCE(SUM(amount_minor),0) AS s FROM payments WHERE kind = 'refund'").get().s)).toBe(50000);

    const receipt = receiptDocument(e.db, ctx, paymentId);
    expect(receipt.payment.receiptNumber).toBe(payment.receipts[0].receiptNumber);
    expect(receipt.invoice?.invoiceNumber).toBe(invoice.invoiceNumber);

    voidPayment(e.db, ctx, paymentId, 'Entered twice');
    expect(getPayment(e.db, ctx, paymentId).voidedAt).toBeTruthy();
    expect(Number(e.db.query('SELECT is_reversed FROM incomes WHERE payment_id = ?').get(paymentId).is_reversed)).toBe(1);
    expect(() => voidPayment(e.db, ctx, paymentId, 'again')).toThrow(ConflictError);

    const listed = listPayments(e.db, ctx, { patientId: p.id, includeVoided: true });
    expect(listed.rows.length).toBe(2);
    expect(listed.totalsMinor.refunded).toBe(50000);
  });

  test('payment methods come seeded and stay configurable', () => {
    const { env: e, ctx } = setup();
    const methods = listPaymentMethods(e.db, ctx);
    expect(methods.length).toBeGreaterThanOrEqual(4);
    expect(methods.some((method) => method.code === 'cash')).toBe(true);
    const summary = collectionSummary(e.db, ctx, { from: todayIso(), to: todayIso() });
    expect(summary.totalCollectedMinor).toBe(0);
  });
});

describe('finance', () => {
  test('summarises income, expenses and net position for a range', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Finance Patient');
    const invoice = createInvoice(e.db, ctx, { patient_id: p.id, status: 'issued', items: [item({ unit_price_minor: 400000 })] });
    recordPayment(e.db, ctx, { patient_id: p.id, invoice_id: invoice.id, amount_minor: 400000 });

    const incomeCategories = listIncomeCategories(e.db, ctx);
    const expenseCategories = listExpenseCategories(e.db, ctx);
    expect(incomeCategories.length).toBeGreaterThan(0);
    expect(expenseCategories.length).toBeGreaterThan(0);

    createExpense(e.db, ctx, { expense_date: todayIso(), category_id: expenseCategories[0].id, amount_minor: 150000, payee: 'Landlord', description: 'Clinic rent' });
    createIncome(e.db, ctx, { income_date: todayIso(), amount_minor: 25000, description: 'Report fee', source: 'other' });

    const summary = financeSummary(e.db, ctx, { from: todayIso(), to: todayIso() });
    expect(summary.invoicedMinor).toBe(400000);
    expect(summary.collectedMinor).toBe(400000);
    expect(summary.expensesMinor).toBe(150000);
    expect(summary.incomeLedgerMinor).toBe(425000);
    expect(summary.netCashMinor).toBe(400000 - 150000);

    const series = dailySeries(e.db, ctx, { from: todayIso(), to: todayIso() });
    expect(series.length).toBe(1);
    expect(series[0].incomeMinor).toBe(425000);
    expect(series[0].expenseMinor).toBe(150000);

    const incomeCats = incomeByCategory(e.db, ctx, { from: todayIso(), to: todayIso() });
    expect(incomeCats.length).toBeGreaterThan(0);
    expect(expensesByCategory(e.db, ctx, { from: todayIso(), to: todayIso() })[0].amountMinor).toBe(150000);
    expect(Array.isArray(monthlyTrend(e.db, ctx, { months: 3 }))).toBe(true);
  });

  test('manual entries can be corrected and removed without touching automatic ones', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Ledger Patient');
    const invoice = createInvoice(e.db, ctx, { patient_id: p.id, status: 'issued', items: [item({ unit_price_minor: 100000 })] });
    const payment = recordPayment(e.db, ctx, { patient_id: p.id, invoice_id: invoice.id, amount_minor: 100000 });
    const autoIncome = e.db.query('SELECT id, amount_minor FROM incomes WHERE payment_id = ?').get(payment.receipts[0].id);
    expect(autoIncome).toBeTruthy();

    const manual = createIncome(e.db, ctx, { income_date: todayIso(), amount_minor: 30000, description: 'X-ray fee' });
    expect(Number(e.db.query('SELECT amount_minor FROM incomes WHERE id = ?').get(manual.id).amount_minor)).toBe(30000);
    const expense = createExpense(e.db, ctx, { expense_date: todayIso(), amount_minor: 12000, description: 'Gloves' });
    deleteExpense(e.db, ctx, expense.id, 'Duplicate');
    expect(Number(e.db.query('SELECT COUNT(*) AS c FROM expenses WHERE deleted_at IS NULL').get().c)).toBe(0);
    expect(expenseSchema.amount_minor.min).toBe(0);
    expect(revenueByService(e.db, ctx, { from: todayIso(), to: todayIso() }).length).toBe(0);
  });
});
