/**
 * Reports, analytics and the dashboard (§ 46, § 47, § 48).
 *
 * Every figure is queried from the database at request time — nothing is cached,
 * estimated or rounded twice — and all money values stay in integer minor units
 * so the exports and the on-screen totals agree.
 */
import { all, get } from '../db/connection.js';
import { resolveRange, todayIso, addDays, startOfMonth, endOfMonth, monthName } from '../domain/dates.js';
import { buildCsv } from '../domain/csv.js';
import { formatAmount } from '../domain/money.js';
import { financeSummary, dailySeries, incomeByCategory, expensesByCategory, revenueByService, monthlyTrend } from './finance.js';
import { inventoryReport } from './inventory.js';
import { practitionerWorkload } from './staff.js';
import { receivables } from './billing.js';
import { collectionSummary } from './payments.js';

const ACTIVE_APPOINTMENT_STATUSES = "'scheduled','checked_in','waiting','in_treatment'";

/**
 * Everything the dashboard shows in one call (§ 47).
 */
export function dashboard(db, ctx, { date = todayIso() } = {}) {
  const clinic = get(db, 'SELECT * FROM clinics WHERE id = ?', [ctx.clinicId]);

  const patientsClinic = get(
    db,
    `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN registered_on = ? THEN 1 ELSE 0 END) AS new_today,
        SUM(CASE WHEN registered_on >= ? THEN 1 ELSE 0 END) AS new_this_month
      FROM patients WHERE clinic_id = ? AND deleted_at IS NULL`,
    [date, startOfMonth(date), ctx.clinicId],
  );

  const appointments = get(
    db,
    `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) AS no_show,
        SUM(CASE WHEN status IN (${ACTIVE_APPOINTMENT_STATUSES}) THEN 1 ELSE 0 END) AS upcoming
      FROM appointments WHERE clinic_id = ? AND appt_date = ? AND deleted_at IS NULL`,
    [ctx.clinicId, date],
  );

  const queue = get(
    db,
    `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waiting,
        SUM(CASE WHEN status = 'in_treatment' THEN 1 ELSE 0 END) AS in_treatment,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM queue_entries WHERE clinic_id = ? AND queue_date = ?`,
    [ctx.clinicId, date],
  );

  const visits = get(
    db,
    `SELECT COUNT(*) AS visits,
            COUNT(DISTINCT patient_id) AS patients,
            SUM(CASE WHEN followup_date = ? THEN 1 ELSE 0 END) AS followups_today
       FROM visits WHERE clinic_id = ? AND visit_date = ? AND deleted_at IS NULL`,
    [date, ctx.clinicId, date],
  );

  const treatments = get(
    db,
    `SELECT COUNT(*) AS count, COALESCE(SUM(total_minor), 0) AS value
       FROM treatments WHERE clinic_id = ? AND treatment_date = ? AND deleted_at IS NULL AND status <> 'cancelled'`,
    [ctx.clinicId, date],
  );

  const money = get(
    db,
    `SELECT
        (SELECT COALESCE(SUM(CASE WHEN kind IN ('payment','credit_used') THEN amount_minor ELSE 0 END), 0)
           FROM payments WHERE clinic_id = ? AND payment_date = ? AND voided_at IS NULL AND deleted_at IS NULL) AS collected,
        (SELECT COALESCE(SUM(amount_minor), 0) FROM payments
           WHERE clinic_id = ? AND payment_date = ? AND kind = 'refund' AND voided_at IS NULL AND deleted_at IS NULL) AS refunded,
        (SELECT COALESCE(SUM(amount_minor), 0) FROM expenses WHERE clinic_id = ? AND expense_date = ? AND deleted_at IS NULL) AS expenses,
        (SELECT COALESCE(SUM(due_minor), 0) FROM invoices WHERE clinic_id = ? AND status = 'issued' AND deleted_at IS NULL) AS outstanding,
        (SELECT COALESCE(SUM(total_minor), 0) FROM invoices WHERE clinic_id = ? AND status = 'issued' AND invoice_date = ? AND deleted_at IS NULL) AS invoiced`,
    [ctx.clinicId, date, ctx.clinicId, date, ctx.clinicId, date, ctx.clinicId, ctx.clinicId, date],
  );

  const lowStock = Number(
    get(
      db,
      'SELECT COUNT(*) AS c FROM inventory_items WHERE clinic_id = ? AND deleted_at IS NULL AND is_active = 1 AND quantity_milli <= min_stock_milli',
      [ctx.clinicId],
    )?.c ?? 0,
  );
  const expiringSoon = Number(
    get(
      db,
      'SELECT COUNT(*) AS c FROM inventory_items WHERE clinic_id = ? AND deleted_at IS NULL AND is_active = 1 AND expiry_date IS NOT NULL AND expiry_date <= ?',
      [ctx.clinicId, addDays(date, 30)],
    )?.c ?? 0,
  );
  const pendingPayroll = get(
    db,
    "SELECT COUNT(*) AS rows, COALESCE(SUM(net_minor - paid_minor), 0) AS due FROM payroll WHERE clinic_id = ? AND status IN ('pending','partial')",
    [ctx.clinicId],
  );

  const trend = dailySeries(db, ctx, { from: addDays(date, -13), to: date });
  const month = { from: startOfMonth(date), to: endOfMonth(date) };

  const upcomingAppointments = all(
    db,
    `SELECT a.id, a.appointment_code, a.appt_date, a.start_time, a.status, a.type_label,
            p.full_name AS patient_name, p.patient_code, p.phone
       FROM appointments a JOIN patients p ON p.id = a.patient_id
      WHERE a.clinic_id = ? AND a.deleted_at IS NULL AND a.status IN (${ACTIVE_APPOINTMENT_STATUSES})
        AND a.appt_date >= ? ORDER BY a.appt_date, a.start_time LIMIT 8`,
    [ctx.clinicId, date],
  );

  const queueNow = all(
    db,
    `SELECT q.id, q.serial_no, q.status, p.full_name AS patient_name, p.patient_code
       FROM queue_entries q JOIN patients p ON p.id = q.patient_id
      WHERE q.clinic_id = ? AND q.queue_date = ? AND q.status IN ('waiting','called','in_treatment')
      ORDER BY q.priority DESC, q.serial_no LIMIT 8`,
    [ctx.clinicId, date],
  );

  const recentPayments = all(
    db,
    `SELECT pm.id, pm.receipt_number, pm.amount_minor, pm.payment_date, pm.method_code, p.full_name AS patient_name
       FROM payments pm JOIN patients p ON p.id = pm.patient_id
      WHERE pm.clinic_id = ? AND pm.voided_at IS NULL AND pm.deleted_at IS NULL AND pm.kind <> 'refund'
      ORDER BY pm.created_at DESC LIMIT 6`,
    [ctx.clinicId],
  );

  const topServices = all(
    db,
    `SELECT name, COUNT(*) AS count, COALESCE(SUM(total_minor), 0) AS value
       FROM treatments
      WHERE clinic_id = ? AND deleted_at IS NULL AND status <> 'cancelled' AND treatment_date BETWEEN ? AND ?
      GROUP BY name ORDER BY value DESC LIMIT 5`,
    [ctx.clinicId, month.from, month.to],
  );

  return {
    date,
    clinic: clinic
      ? {
          id: Number(clinic.id),
          name: clinic.name,
          legalName: clinic.legal_name,
          phone: clinic.phone,
          email: clinic.email,
          address: clinic.address,
          city: clinic.city,
          country: clinic.country,
          currencyCode: clinic.currency_code,
          currencySymbol: clinic.currency_symbol,
          currencyMinorUnits: Number(clinic.currency_minor_units),
          locale: clinic.locale,
          taxEnabled: Boolean(clinic.tax_enabled),
          taxRateBp: Number(clinic.tax_rate_bp),
        }
      : null,
    patients: {
      total: Number(patientsClinic?.total ?? 0),
      active: Number(patientsClinic?.active ?? 0),
      newToday: Number(patientsClinic?.new_today ?? 0),
      newThisMonth: Number(patientsClinic?.new_this_month ?? 0),
    },
    appointments: {
      total: Number(appointments?.total ?? 0),
      completed: Number(appointments?.completed ?? 0),
      cancelled: Number(appointments?.cancelled ?? 0),
      noShow: Number(appointments?.no_show ?? 0),
      upcoming: Number(appointments?.upcoming ?? 0),
    },
    queue: {
      total: Number(queue?.total ?? 0),
      waiting: Number(queue?.waiting ?? 0),
      inTreatment: Number(queue?.in_treatment ?? 0),
      completed: Number(queue?.completed ?? 0),
    },
    clinical: {
      visitsToday: Number(visits?.visits ?? 0),
      patientsSeenToday: Number(visits?.patients ?? 0),
      followupsToday: Number(visits?.followups_today ?? 0),
      treatmentsToday: Number(treatments?.count ?? 0),
      treatmentValueTodayMinor: Number(treatments?.value ?? 0),
    },
    money: {
      collectedTodayMinor: Number(money?.collected ?? 0) - Number(money?.refunded ?? 0),
      invoicedTodayMinor: Number(money?.invoiced ?? 0),
      expensesTodayMinor: Number(money?.expenses ?? 0),
      outstandingTotalMinor: Number(money?.outstanding ?? 0),
      monthToDate: financeSummary(db, ctx, { from: month.from, to: month.to }),
    },
    alerts: {
      lowStock,
      expiringSoon,
      pendingPayrollRows: Number(pendingPayroll?.rows ?? 0),
      pendingPayrollMinor: Number(pendingPayroll?.due ?? 0),
    },
    trend14Days: trend,
    upcomingAppointments,
    queueNow,
    recentPayments: recentPayments.map((row) => ({
      id: Number(row.id),
      receiptNumber: row.receipt_number,
      amountMinor: Number(row.amount_minor),
      date: row.payment_date,
      methodCode: row.method_code,
      patientName: row.patient_name,
    })),
    topServicesThisMonth: topServices.map((row) => ({ name: row.name, count: Number(row.count), valueMinor: Number(row.value) })),
    patientTotals: { registryTotal: Number(patientsClinic?.total ?? 0) },
  };
}

/* ---------------------------------------------------------------- reporting */

/**
 * Report catalogue. Each entry returns `{ columns, rows, totals }` so the UI and
 * the CSV export share one implementation.
 */
export const REPORT_DEFINITIONS = [
  { key: 'patients', titleKey: 'reports.patients.title', descriptionKey: 'reports.patients.description', category: 'patients' },
  { key: 'appointments', titleKey: 'reports.appointments.title', descriptionKey: 'reports.appointments.description', category: 'scheduling' },
  { key: 'visits', titleKey: 'reports.visits.title', descriptionKey: 'reports.visits.description', category: 'clinical' },
  { key: 'treatments', titleKey: 'reports.treatments.title', descriptionKey: 'reports.treatments.description', category: 'clinical' },
  { key: 'revenue', titleKey: 'reports.revenue.title', descriptionKey: 'reports.revenue.description', category: 'finance' },
  { key: 'collections', titleKey: 'reports.collections.title', descriptionKey: 'reports.collections.description', category: 'finance' },
  { key: 'receivables', titleKey: 'reports.receivables.title', descriptionKey: 'reports.receivables.description', category: 'finance' },
  { key: 'expenses', titleKey: 'reports.expenses.title', descriptionKey: 'reports.expenses.description', category: 'finance' },
  { key: 'profit', titleKey: 'reports.profit.title', descriptionKey: 'reports.profit.description', category: 'finance' },
  { key: 'procedures', titleKey: 'reports.procedures.title', descriptionKey: 'reports.procedures.description', category: 'clinical' },
  { key: 'practitioners', titleKey: 'reports.practitioners.title', descriptionKey: 'reports.practitioners.description', category: 'staff' },
  { key: 'inventory', titleKey: 'reports.inventory.title', descriptionKey: 'reports.inventory.description', category: 'inventory' },
  { key: 'prescriptions', titleKey: 'reports.prescriptions.title', descriptionKey: 'reports.prescriptions.description', category: 'clinical' },
  { key: 'referrals', titleKey: 'reports.referrals.title', descriptionKey: 'reports.referrals.description', category: 'clinical' },
  { key: 'demographics', titleKey: 'reports.demographics.title', descriptionKey: 'reports.demographics.description', category: 'patients' },
  { key: 'audit', titleKey: 'reports.audit.title', descriptionKey: 'reports.audit.description', category: 'system' },
];

export function reportCatalogue() {
  return REPORT_DEFINITIONS.map((definition) => ({ ...definition }));
}

/**
 * Run a report over a date range.
 * @param {{ clinicId: number, user?: any }} ctx
 * @param {string} key
 * @param {{ from?: string, to?: string, preset?: string }} params
 */
/**
 * @param {any} db
 * @param {any} ctx
 * @param {string} key
 * @param {Record<string, any>} [params]
 * @returns {any}
 */
export function runReport(db, ctx, key, params = {}) {
  const range = params.from || params.to ? { from: params.from ?? params.to, to: params.to ?? params.from } : resolveRange(params.preset ?? 'this_month');
  const { from, to } = range;

  switch (key) {
    case 'patients': {
      const rows = all(
        db,
        `SELECT p.patient_code, p.full_name, p.gender, p.dob, p.phone, p.city, p.status, p.registered_on,
                (SELECT COUNT(*) FROM visits v WHERE v.patient_id = p.id AND v.deleted_at IS NULL) AS visits,
                (SELECT COALESCE(SUM(i.due_minor),0) FROM invoices i WHERE i.patient_id = p.id AND i.status = 'issued' AND i.deleted_at IS NULL) AS due_minor
           FROM patients p
          WHERE p.clinic_id = ? AND p.deleted_at IS NULL AND p.registered_on BETWEEN ? AND ?
          ORDER BY p.registered_on DESC LIMIT 5000`,
        [ctx.clinicId, from, to],
      );
      return {
        key,
        range: { from, to },
        columns: [
          { key: 'patient_code', labelKey: 'reports.columns.code' },
          { key: 'full_name', labelKey: 'reports.columns.patient' },
          { key: 'gender', labelKey: 'reports.columns.gender' },
          { key: 'dob', labelKey: 'reports.columns.dob' },
          { key: 'phone', labelKey: 'reports.columns.phone' },
          { key: 'city', labelKey: 'reports.columns.city' },
          { key: 'registered_on', labelKey: 'reports.columns.registered' },
          { key: 'visits', labelKey: 'reports.columns.visits' },
          { key: 'due_minor', labelKey: 'reports.columns.outstanding', money: true },
        ],
        rows,
        totals: { count: rows.length, due_minor: rows.reduce((sum, row) => sum + Number(row.due_minor), 0) },
      };
    }

    case 'appointments': {
      const rows = all(
        db,
        `SELECT a.appt_date, a.start_time, a.end_time, a.appointment_code, a.status, a.type_label,
                p.patient_code, p.full_name AS patient_name, COALESCE(s.full_name, '—') AS practitioner,
                a.reason
           FROM appointments a
           JOIN patients p ON p.id = a.patient_id
           LEFT JOIN staff s ON s.id = a.practitioner_id
          WHERE a.clinic_id = ? AND a.deleted_at IS NULL AND a.appt_date BETWEEN ? AND ?
          ORDER BY a.appt_date, a.start_time LIMIT 5000`,
        [ctx.clinicId, from, to],
      );
      const byStatus = rows.reduce((acc, row) => ({ ...acc, [row.status]: (acc[row.status] ?? 0) + 1 }), {});
      return {
        key,
        range: { from, to },
        columns: [
          { key: 'appt_date', labelKey: 'reports.columns.date' },
          { key: 'start_time', labelKey: 'reports.columns.start' },
          { key: 'end_time', labelKey: 'reports.columns.end' },
          { key: 'appointment_code', labelKey: 'reports.columns.code' },
          { key: 'patient_code', labelKey: 'reports.columns.patientCode' },
          { key: 'patient_name', labelKey: 'reports.columns.patient' },
          { key: 'practitioner', labelKey: 'reports.columns.practitioner' },
          { key: 'type_label', labelKey: 'reports.columns.type' },
          { key: 'status', labelKey: 'reports.columns.status' },
        ],
        rows,
        totals: { count: rows.length, byStatus },
      };
    }

    case 'visits': {
      const rows = all(
        db,
        `SELECT v.visit_code, v.visit_date, v.visit_time, p.patient_code, p.full_name AS patient_name,
                COALESCE(s.full_name, '—') AS practitioner, v.diagnosis, v.followup_date, v.status
           FROM visits v JOIN patients p ON p.id = v.patient_id
           LEFT JOIN staff s ON s.id = v.practitioner_id
          WHERE v.clinic_id = ? AND v.deleted_at IS NULL AND v.visit_date BETWEEN ? AND ?
          ORDER BY v.visit_date DESC LIMIT 5000`,
        [ctx.clinicId, from, to],
      );
      return {
        key,
        range: { from, to },
        columns: [
          { key: 'visit_code', labelKey: 'reports.columns.code' },
          { key: 'visit_date', labelKey: 'reports.columns.date' },
          { key: 'visit_time', labelKey: 'reports.columns.time' },
          { key: 'patient_code', labelKey: 'reports.columns.patientCode' },
          { key: 'patient_name', labelKey: 'reports.columns.patient' },
          { key: 'practitioner', labelKey: 'reports.columns.practitioner' },
          { key: 'diagnosis', labelKey: 'reports.columns.diagnosis' },
          { key: 'followup_date', labelKey: 'reports.columns.followup' },
          { key: 'status', labelKey: 'reports.columns.status' },
        ],
        rows,
        totals: { count: rows.length },
      };
    }

    case 'treatments':
    case 'procedures': {
      const rows = all(
        db,
        `SELECT t.treatment_date, t.name, t.tooth_codes, p.patient_code, p.full_name AS patient_name,
                COALESCE(s.full_name, '—') AS practitioner, t.status, t.fee_minor, t.discount_minor, t.tax_minor, t.total_minor,
                i.invoice_number
           FROM treatments t
           JOIN patients p ON p.id = t.patient_id
           LEFT JOIN staff s ON s.id = t.practitioner_id
           LEFT JOIN invoices i ON i.id = t.invoice_id
          WHERE t.clinic_id = ? AND t.deleted_at IS NULL AND t.treatment_date BETWEEN ? AND ?
          ORDER BY t.treatment_date DESC LIMIT 5000`,
        [ctx.clinicId, from, to],
      );
      return {
        key,
        range: { from, to },
        columns: [
          { key: 'treatment_date', labelKey: 'reports.columns.date' },
          { key: 'name', labelKey: 'reports.columns.treatment' },
          { key: 'tooth_codes', labelKey: 'reports.columns.teeth' },
          { key: 'patient_code', labelKey: 'reports.columns.patientCode' },
          { key: 'patient_name', labelKey: 'reports.columns.patient' },
          { key: 'practitioner', labelKey: 'reports.columns.practitioner' },
          { key: 'status', labelKey: 'reports.columns.status' },
          { key: 'fee_minor', labelKey: 'reports.columns.fee', money: true },
          { key: 'discount_minor', labelKey: 'reports.columns.discount', money: true },
          { key: 'tax_minor', labelKey: 'reports.columns.tax', money: true },
          { key: 'total_minor', labelKey: 'reports.columns.total', money: true },
          { key: 'invoice_number', labelKey: 'reports.columns.invoice' },
        ],
        rows,
        totals: {
          count: rows.length,
          fee_minor: rows.reduce((sum, row) => sum + Number(row.fee_minor), 0),
          discount_minor: rows.reduce((sum, row) => sum + Number(row.discount_minor), 0),
          tax_minor: rows.reduce((sum, row) => sum + Number(row.tax_minor), 0),
          total_minor: rows.reduce((sum, row) => sum + Number(row.total_minor), 0),
        },
      };
    }

    case 'revenue': {
      const summary = financeSummary(db, ctx, { from, to });
      const byService = revenueByService(db, ctx, { from, to, limit: 100 });
      const byCategory = incomeByCategory(db, ctx, { from, to });
      return {
        key,
        range: { from, to },
        columns: [
          { key: 'name', labelKey: 'reports.columns.service' },
          { key: 'count', labelKey: 'reports.columns.count' },
          { key: 'amount_minor', labelKey: 'reports.columns.amount', money: true },
        ],
        rows: byService.map((row) => ({ name: row.name, count: row.count, amount_minor: row.amountMinor })),
        totals: { amount_minor: summary.invoicedMinor, discount_minor: summary.discountMinor, tax_minor: summary.taxMinor },
        summary,
        breakdown: {
          byService,
          byIncomeCategory: byCategory,
          daily: dailySeries(db, ctx, { from, to }),
          monthly: monthlyTrend(db, ctx, { months: 12 }),
        },
      };
    }

    case 'collections': {
      const collections = collectionSummary(db, ctx, { from, to });
      const rows = all(
        db,
        `SELECT pm.payment_date, pm.receipt_number, pm.kind, pm.amount_minor, pm.method_code,
                p.patient_code, p.full_name AS patient_name, COALESCE(i.invoice_number, '—') AS invoice_number,
                COALESCE(u.display_name, '—') AS received_by
           FROM payments pm
           JOIN patients p ON p.id = pm.patient_id
           LEFT JOIN invoices i ON i.id = pm.invoice_id
           LEFT JOIN users u ON u.id = pm.created_by
          WHERE pm.clinic_id = ? AND pm.voided_at IS NULL AND pm.deleted_at IS NULL AND pm.payment_date BETWEEN ? AND ?
          ORDER BY pm.payment_date DESC, pm.id DESC LIMIT 5000`,
        [ctx.clinicId, from, to],
      );
      return {
        key,
        range: { from, to },
        columns: [
          { key: 'payment_date', labelKey: 'reports.columns.date' },
          { key: 'receipt_number', labelKey: 'reports.columns.receipt' },
          { key: 'kind', labelKey: 'reports.columns.kind' },
          { key: 'patient_code', labelKey: 'reports.columns.patientCode' },
          { key: 'patient_name', labelKey: 'reports.columns.patient' },
          { key: 'invoice_number', labelKey: 'reports.columns.invoice' },
          { key: 'method_code', labelKey: 'reports.columns.method' },
          { key: 'amount_minor', labelKey: 'reports.columns.amount', money: true },
          { key: 'received_by', labelKey: 'reports.columns.receivedBy' },
        ],
        rows,
        totals: {
          collected_minor: collections.totalCollectedMinor,
          refunded_minor: collections.totalRefundedMinor,
          byMethod: collections.byMethod,
          daily: collections.daily,
        },
      };
    }

    case 'receivables': {
      const outstanding = receivables(db, ctx, { asOf: to });
      return {
        key,
        range: { from, to },
        columns: [
          { key: 'invoiceNumber', labelKey: 'reports.columns.invoice' },
          { key: 'invoiceDate', labelKey: 'reports.columns.date' },
          { key: 'dueDate', labelKey: 'reports.columns.dueDate' },
          { key: 'patientCode', labelKey: 'reports.columns.patientCode' },
          { key: 'patientName', labelKey: 'reports.columns.patient' },
          { key: 'phone', labelKey: 'reports.columns.phone' },
          { key: 'totalMinor', labelKey: 'reports.columns.total', money: true },
          { key: 'paidMinor', labelKey: 'reports.columns.paid', money: true },
          { key: 'dueMinor', labelKey: 'reports.columns.outstanding', money: true },
          { key: 'ageDays', labelKey: 'reports.columns.age' },
        ],
        rows: outstanding.items,
        totals: { ...outstanding.totals, due_minor: outstanding.totalDueMinor, patients: outstanding.patientCount },
      };
    }

    case 'expenses': {
      const rows = all(
        db,
        `SELECT e.expense_date, COALESCE(c.name_en, '—') AS category, e.payee, e.amount_minor, e.method_code,
                COALESCE(s.name, '—') AS supplier, e.description, e.reference_no
           FROM expenses e
           LEFT JOIN expense_categories c ON c.id = e.category_id
           LEFT JOIN suppliers s ON s.id = e.supplier_id
          WHERE e.clinic_id = ? AND e.deleted_at IS NULL AND e.expense_date BETWEEN ? AND ?
          ORDER BY e.expense_date DESC LIMIT 5000`,
        [ctx.clinicId, from, to],
      );
      return {
        key,
        range: { from, to },
        columns: [
          { key: 'expense_date', labelKey: 'reports.columns.date' },
          { key: 'category', labelKey: 'reports.columns.category' },
          { key: 'payee', labelKey: 'reports.columns.payee' },
          { key: 'supplier', labelKey: 'reports.columns.supplier' },
          { key: 'description', labelKey: 'reports.columns.description' },
          { key: 'method_code', labelKey: 'reports.columns.method' },
          { key: 'amount_minor', labelKey: 'reports.columns.amount', money: true },
        ],
        rows,
        totals: {
          amount_minor: rows.reduce((sum, row) => sum + Number(row.amount_minor), 0),
          count: rows.length,
          byCategory: expensesByCategory(db, ctx, { from, to }),
        },
      };
    }

    case 'profit': {
      const summary = financeSummary(db, ctx, { from, to });
      const monthly = monthlyTrend(db, ctx, { months: 12 });
      return {
        key,
        range: { from, to },
        columns: [
          { key: 'month', labelKey: 'reports.columns.month' },
          { key: 'incomeMinor', labelKey: 'reports.columns.income', money: true },
          { key: 'refundMinor', labelKey: 'reports.columns.refunds', money: true },
          { key: 'expenseMinor', labelKey: 'reports.columns.expenses', money: true },
          { key: 'netMinor', labelKey: 'reports.columns.net', money: true },
        ],
        rows: monthly,
        totals: {
          collected_minor: summary.collectedMinor,
          refunded_minor: summary.refundedMinor,
          expenses_minor: summary.expensesMinor,
          net_minor: summary.netCashMinor,
        },
        summary,
      };
    }

    case 'practitioners': {
      const rows = practitionerWorkload(db, ctx, { from, to });
      return {
        key,
        range: { from, to },
        columns: [
          { key: 'name', labelKey: 'reports.columns.practitioner' },
          { key: 'appointments', labelKey: 'reports.columns.appointments' },
          { key: 'visits', labelKey: 'reports.columns.visits' },
          { key: 'treatments', labelKey: 'reports.columns.treatments' },
        ],
        rows,
        totals: {
          appointments: rows.reduce((sum, row) => sum + row.appointments, 0),
          visits: rows.reduce((sum, row) => sum + row.visits, 0),
          treatments: rows.reduce((sum, row) => sum + row.treatments, 0),
        },
      };
    }

    case 'inventory': {
      const report = inventoryReport(db, ctx, { expiringWithinDays: 60 });
      return {
        key,
        range: { from, to },
        columns: [
          { key: 'name', labelKey: 'reports.columns.item' },
          { key: 'quantityMilli', labelKey: 'reports.columns.quantity' },
          { key: 'unit', labelKey: 'reports.columns.unit' },
          { key: 'purchasePriceMinor', labelKey: 'reports.columns.purchasePrice', money: true },
          { key: 'salePriceMinor', labelKey: 'reports.columns.salePrice', money: true },
          { key: 'expiryDate', labelKey: 'reports.columns.expiry' },
          { key: 'condition', labelKey: 'reports.columns.condition' },
          { key: 'stockValueMinor', labelKey: 'reports.columns.value', money: true },
        ],
        rows: lowStockAndAll(db, ctx),
        totals: { ...report.valuation, lowStock: report.lowStock.length, expiring: report.expiring.length },
        extras: report,
      };
    }

    case 'prescriptions': {
      const rows = all(
        db,
        `SELECT rx.rx_code, rx.rx_date, p.patient_code, p.full_name AS patient_name,
                COALESCE(s.full_name, '—') AS practitioner,
                (SELECT COUNT(*) FROM prescription_items pi WHERE pi.prescription_id = rx.id) AS items,
                SUBSTR(COALESCE((SELECT GROUP_CONCAT(pi.medication, ', ') FROM prescription_items pi WHERE pi.prescription_id = rx.id), ''), 1, 200) AS medications
           FROM prescriptions rx
           JOIN patients p ON p.id = rx.patient_id
           LEFT JOIN staff s ON s.id = rx.practitioner_id
          WHERE rx.clinic_id = ? AND rx.deleted_at IS NULL AND rx.rx_date BETWEEN ? AND ?
          ORDER BY rx.rx_date DESC LIMIT 5000`,
        [ctx.clinicId, from, to],
      );
      return {
        key,
        range: { from, to },
        columns: [
          { key: 'rx_code', labelKey: 'reports.columns.code' },
          { key: 'rx_date', labelKey: 'reports.columns.date' },
          { key: 'patient_code', labelKey: 'reports.columns.patientCode' },
          { key: 'patient_name', labelKey: 'reports.columns.patient' },
          { key: 'practitioner', labelKey: 'reports.columns.practitioner' },
          { key: 'items', labelKey: 'reports.columns.items' },
          { key: 'medications', labelKey: 'reports.columns.medications' },
        ],
        rows,
        totals: { count: rows.length },
      };
    }

    case 'referrals': {
      const rows = all(
        db,
        `SELECT r.referral_code, r.referral_date, r.provider_name, COALESCE(r.specialty, '—') AS specialty,
                COALESCE(r.institution, '—') AS institution, p.patient_code, p.full_name AS patient_name,
                r.status, r.followup_date, r.outcome
           FROM referrals r JOIN patients p ON p.id = r.patient_id
          WHERE r.clinic_id = ? AND r.deleted_at IS NULL AND r.referral_date BETWEEN ? AND ?
          ORDER BY r.referral_date DESC LIMIT 5000`,
        [ctx.clinicId, from, to],
      );
      return {
        key,
        range: { from, to },
        columns: [
          { key: 'referral_code', labelKey: 'reports.columns.code' },
          { key: 'referral_date', labelKey: 'reports.columns.date' },
          { key: 'patient_code', labelKey: 'reports.columns.patientCode' },
          { key: 'patient_name', labelKey: 'reports.columns.patient' },
          { key: 'provider_name', labelKey: 'reports.columns.provider' },
          { key: 'specialty', labelKey: 'reports.columns.specialty' },
          { key: 'institution', labelKey: 'reports.columns.institution' },
          { key: 'status', labelKey: 'reports.columns.status' },
        ],
        rows,
        totals: { count: rows.length, completed: rows.filter((row) => row.status === 'completed').length },
      };
    }

    case 'demographics': {
      const byGender = all(
        db,
        `SELECT gender, COUNT(*) AS count FROM patients WHERE clinic_id = ? AND deleted_at IS NULL GROUP BY gender ORDER BY count DESC`,
        [ctx.clinicId],
      );
      const byAge = all(
        db,
        `SELECT CASE
                  WHEN dob IS NULL THEN 'unknown'
                  WHEN CAST((julianday(?) - julianday(dob)) / 365.25 AS INTEGER) < 13 THEN '0-12'
                  WHEN CAST((julianday(?) - julianday(dob)) / 365.25 AS INTEGER) < 20 THEN '13-19'
                  WHEN CAST((julianday(?) - julianday(dob)) / 365.25 AS INTEGER) < 40 THEN '20-39'
                  WHEN CAST((julianday(?) - julianday(dob)) / 365.25 AS INTEGER) < 60 THEN '40-59'
                  ELSE '60+'
                END AS band,
                COUNT(*) AS count
           FROM patients WHERE clinic_id = ? AND deleted_at IS NULL GROUP BY band ORDER BY band`,
        [todayIso(), todayIso(), todayIso(), todayIso(), ctx.clinicId],
      );
      const byCity = all(
        db,
        `SELECT COALESCE(NULLIF(TRIM(city), ''), '—') AS city, COUNT(*) AS count
           FROM patients WHERE clinic_id = ? AND deleted_at IS NULL GROUP BY city ORDER BY count DESC LIMIT 50`,
        [ctx.clinicId],
      );
      return {
        key,
        range: { from, to },
        columns: [
          { key: 'group', labelKey: 'reports.columns.group' },
          { key: 'count', labelKey: 'reports.columns.count' },
        ],
        rows: [
          ...byGender.map((row) => ({ group: `gender:${row.gender}`, count: Number(row.count) })),
          ...byAge.map((row) => ({ group: `age:${row.band}`, count: Number(row.count) })),
          ...byCity.map((row) => ({ group: `city:${row.city}`, count: Number(row.count) })),
        ],
        totals: { patients: byGender.reduce((sum, row) => sum + Number(row.count), 0) },
        breakdown: { byGender, byAge, byCity },
      };
    }

    case 'audit': {
      const rows = all(
        db,
        `SELECT a.created_at, a.user_name, a.action, a.module, a.entity, a.entity_id, a.summary, a.severity
           FROM audit_logs a
          WHERE a.clinic_id = ? AND SUBSTR(a.created_at, 1, 10) BETWEEN ? AND ?
          ORDER BY a.id DESC LIMIT 5000`,
        [ctx.clinicId, from, to],
      );
      return {
        key,
        range: { from, to },
        columns: [
          { key: 'created_at', labelKey: 'reports.columns.timestamp' },
          { key: 'user_name', labelKey: 'reports.columns.user' },
          { key: 'action', labelKey: 'reports.columns.action' },
          { key: 'module', labelKey: 'reports.columns.module' },
          { key: 'summary', labelKey: 'reports.columns.summary' },
          { key: 'severity', labelKey: 'reports.columns.severity' },
        ],
        rows,
        totals: { count: rows.length },
      };
    }

    default:
      return { key, range: { from, to }, columns: [], rows: [], totals: {}, unknown: true };
  }
}

function lowStockAndAll(db, ctx) {
  return all(
    db,
    `SELECT i.*, c.name_en AS category_name, s.name AS supplier_name
       FROM inventory_items i
       LEFT JOIN inventory_categories c ON c.id = i.category_id
       LEFT JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.clinic_id = ? AND i.deleted_at IS NULL
      ORDER BY i.name COLLATE NOCASE LIMIT 5000`,
    [ctx.clinicId],
  ).map((row) => ({
    name: row.name,
    quantityMilli: Number(row.quantity_milli),
    unit: row.unit,
    purchasePriceMinor: Number(row.purchase_price_minor),
    salePriceMinor: Number(row.sale_price_minor),
    expiryDate: row.expiry_date,
    condition: row.condition,
    stockValueMinor: Math.round((Number(row.quantity_milli) * Number(row.purchase_price_minor)) / 1000),
  }));
}

/** CSV export of any report (§ 48, § 74). */
export function reportCsv(db, ctx, key, params = {}) {
  const report = runReport(db, ctx, key, params);
  const minorUnits = Number(get(db, 'SELECT currency_minor_units FROM clinics WHERE id = ?', [ctx.clinicId])?.currency_minor_units ?? 2);
  const moneyColumns = report.columns.filter((column) => column.money).map((column) => column.key);
  const rows = report.rows.map((row) => {
    const copy = { ...row };
    for (const column of moneyColumns) {
      if (typeof copy[column] === 'number') copy[column] = formatAmount(copy[column], { minorUnits });
    }
    return copy;
  });
  return {
    ...report,
    rows,
    csv: buildCsv(report.columns, rows),
  };
}

/** Per-patient statement (ledger) used by the print/PDF export. */
/**
 * @param {any} db
 * @param {any} ctx
 * @param {number} patientId
 * @param {{ from?: string, to?: string }} [range]
 */
export function patientStatement(db, ctx, patientId, { from = '0000-01-01', to = todayIso() } = {}) {
  const patient = get(
    db,
    'SELECT id, patient_code, full_name, phone, address, city FROM patients WHERE id = ? AND clinic_id = ?',
    [patientId, ctx.clinicId],
  );
  if (!patient) return null;
  const invoices = all(
    db,
    `SELECT id, invoice_number AS reference, invoice_date AS date, 'invoice' AS kind, total_minor AS amount_minor, due_minor
       FROM invoices WHERE patient_id = ? AND clinic_id = ? AND status = 'issued' AND deleted_at IS NULL
         AND invoice_date BETWEEN ? AND ?`,
    [patientId, ctx.clinicId, from, to],
  );
  const payments = all(
    db,
    `SELECT id, receipt_number AS reference, payment_date AS date, kind, amount_minor, 0 AS due_minor
       FROM payments WHERE patient_id = ? AND clinic_id = ? AND voided_at IS NULL AND deleted_at IS NULL
         AND payment_date BETWEEN ? AND ?`,
    [patientId, ctx.clinicId, from, to],
  );
  const entries = [
    ...invoices.map((row) => ({ ...row, direction: 'debit' })),
    ...payments.map((row) => ({
      ...row,
      direction: row.kind === 'refund' ? 'debit' : 'credit',
      amount_minor: Number(row.amount_minor),
    })),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)));

  let balance = 0;
  const ledger = entries.map((entry) => {
    balance += entry.direction === 'debit' ? Number(entry.amount_minor) : -Number(entry.amount_minor);
    return { ...entry, amountMinor: Number(entry.amount_minor), balanceMinor: balance };
  });
  const credit = get(db, 'SELECT COALESCE(SUM(amount_minor),0) AS balance FROM patient_credits WHERE patient_id = ?', [patientId]);
  const outstanding = get(
    db,
    "SELECT COALESCE(SUM(due_minor),0) AS due, COUNT(*) AS invoices FROM invoices WHERE patient_id = ? AND status = 'issued' AND deleted_at IS NULL",
    [patientId],
  );
  return {
    patient,
    range: { from, to },
    ledger,
    summary: {
      invoicedMinor: invoices.reduce((sum, row) => sum + Number(row.amount_minor), 0),
      paidMinor: payments
        .filter((row) => row.kind !== 'refund')
        .reduce((sum, row) => sum + Number(row.amount_minor), 0),
      refundedMinor: payments.filter((row) => row.kind === 'refund').reduce((sum, row) => sum + Number(row.amount_minor), 0),
      outstandingMinor: Number(outstanding?.due ?? 0),
      openInvoices: Number(outstanding?.invoices ?? 0),
      creditMinor: Number(credit?.balance ?? 0),
    },
  };
}

export { monthName };
