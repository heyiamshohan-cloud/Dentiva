/**
 * Financial management (§ 39, § 40).
 *
 * Two books are maintained deliberately and kept reconciled:
 *   1. the billing ledger — invoices, payments, refunds, receivables,
 *   2. the cash ledger — `incomes` (auto-created from payments and entered
 *      manually for other income) and `expenses`.
 *
 * Reported figures are always queried from the database; nothing is cached or
 * estimated, and refunds/voids reduce the reported figures because their income
 * rows are marked reversed.
 */
import { all, get, run, withTransaction, nowIso } from '../db/connection.js';
import { resolvePaging } from '../db/query.js';
import { assertValid } from '../domain/validation.js';
import { NotFoundError, ConflictError } from '../../shared/errors.js';
import { todayIso, resolveRange } from '../domain/dates.js';
import { parseAmount } from '../domain/money.js';
import { recordAudit } from './audit.js';

/* ------------------------------------------------------------- categories */

const categorySchema = {
  name_en: { type: 'string', required: true, maxLength: 120 },
  name_bn: { type: 'string', maxLength: 120, nullable: true },
  is_active: { type: 'boolean', default: true },
  sort_order: { type: 'int', default: 0 },
};

function listCategories(db, clinicId, table, { includeInactive = false } = {}) {
  return all(
    db,
    `SELECT * FROM ${table} WHERE clinic_id = ? AND deleted_at IS NULL ${includeInactive ? '' : 'AND is_active = 1'}
      ORDER BY sort_order, name_en`,
    [clinicId],
  ).map((row) => ({
    id: Number(row.id),
    nameEn: row.name_en,
    nameBn: row.name_bn,
    isSystem: Boolean(row.is_system),
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order),
  }));
}

export function listIncomeCategories(db, ctx, options) {
  return listCategories(db, ctx.clinicId, 'income_categories', options);
}

export function listExpenseCategories(db, ctx, options) {
  return listCategories(db, ctx.clinicId, 'expense_categories', options);
}

export function saveCategory(db, ctx, kind, categoryId, input) {
  const table = kind === 'income' ? 'income_categories' : 'expense_categories';
  if (categoryId) {
    const before = get(db, `SELECT * FROM ${table} WHERE id = ? AND clinic_id = ?`, [categoryId, ctx.clinicId]);
    if (!before) throw new NotFoundError(`${kind}_category`, categoryId);
    const values = assertValid(input, categorySchema, { partial: true });
    const columns = Object.keys(values);
    if (columns.length) {
      run(db, `UPDATE ${table} SET ${columns.map((col) => `${col} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [
        ...columns.map((col) => (typeof values[col] === 'boolean' ? (values[col] ? 1 : 0) : values[col])),
        nowIso(),
        categoryId,
      ]);
    }
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'update_category',
      module: 'finance',
      entity: `${kind}_category`,
      entityId: categoryId,
      summary: `${kind === 'income' ? 'Income' : 'Expense'} category "${before.name_en}" updated`,
      severity: 'info',
    });
    return { id: categoryId };
  }
  const values = assertValid(input, categorySchema);
  const result = run(
    db,
    `INSERT INTO ${table} (clinic_id, name_en, name_bn, is_active, sort_order) VALUES (?,?,?,?,?)`,
    [ctx.clinicId, values.name_en, values.name_bn ?? null, values.is_active ? 1 : 0, values.sort_order],
  );
  const id = Number(result.lastInsertRowid);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'create_category',
    module: 'finance',
    entity: `${kind}_category`,
    entityId: id,
    summary: `${kind === 'income' ? 'Income' : 'Expense'} category "${values.name_en}" created`,
    severity: 'info',
  });
  return { id };
}

export function deleteCategory(db, ctx, kind, categoryId) {
  const table = kind === 'income' ? 'income_categories' : 'expense_categories';
  const category = get(db, `SELECT * FROM ${table} WHERE id = ? AND clinic_id = ?`, [categoryId, ctx.clinicId]);
  if (!category) throw new NotFoundError(`${kind}_category`, categoryId);
  const usageTable = kind === 'income' ? 'incomes' : 'expenses';
  const usage = get(db, `SELECT COUNT(*) AS c FROM ${usageTable} WHERE category_id = ?`, [categoryId]);
  if (Number(usage?.c ?? 0) > 0) {
    // Categories with history are archived instead of removed.
    run(db, `UPDATE ${table} SET is_active = 0, updated_at = ? WHERE id = ?`, [nowIso(), categoryId]);
    return { archived: true, reason: 'in_use' };
  }
  run(db, `UPDATE ${table} SET deleted_at = ?, is_active = 0, updated_at = ? WHERE id = ?`, [nowIso(), nowIso(), categoryId]);
  return { deleted: true };
}

/* ----------------------------------------------------------------- income */

export const incomeSchema = {
  income_date: { type: 'date', required: true, default: () => todayIso() },
  category_id: { type: 'id', nullable: true },
  source: { type: 'enum', values: ['treatment', 'consultation', 'other', 'collection'], default: 'other' },
  patient_id: { type: 'id', nullable: true },
  amount_minor: { type: 'int', min: 0, nullable: true },
  method_code: { type: 'string', maxLength: 32, default: 'cash' },
  reference_no: { type: 'string', maxLength: 80, nullable: true },
  description: { type: 'string', maxLength: 200, nullable: true },
  notes: { type: 'text', maxLength: 1000, nullable: true },
};

export function listIncomes(db, ctx, params = {}) {
  const where = ['inc.clinic_id = ?', 'inc.deleted_at IS NULL'];
  const args = [ctx.clinicId];
  if (params.from) {
    where.push('inc.income_date >= ?');
    args.push(params.from);
  }
  if (params.to) {
    where.push('inc.income_date <= ?');
    args.push(params.to);
  }
  if (params.categoryId) {
    where.push('inc.category_id = ?');
    args.push(Number(params.categoryId));
  }
  if (params.source) {
    where.push('inc.source = ?');
    args.push(params.source);
  }
  if (params.methodCode) {
    where.push('inc.method_code = ?');
    args.push(params.methodCode);
  }
  if (params.includeReversed !== true && params.includeReversed !== 'true') {
    where.push('inc.is_reversed = 0');
  }
  if (params.search) {
    where.push("(COALESCE(inc.description,'') LIKE ? ESCAPE '\\' OR COALESCE(inc.reference_no,'') LIKE ? ESCAPE '\\' OR p.full_name LIKE ? ESCAPE '\\')");
    const pattern = `%${String(params.search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(pattern, pattern, pattern);
  }
  const page = resolvePaging(params);
  const whereSql = where.join(' AND ');
  const total = Number(
    get(db, `SELECT COUNT(*) AS c FROM incomes inc LEFT JOIN patients p ON p.id = inc.patient_id WHERE ${whereSql}`, args)?.c ?? 0,
  );
  const rows = all(
    db,
    `SELECT inc.*, c.name_en AS category_name, c.name_bn AS category_name_bn,
            p.full_name AS patient_name, p.patient_code, pm.receipt_number, i.invoice_number,
            u.display_name AS created_by_name
       FROM incomes inc
       LEFT JOIN income_categories c ON c.id = inc.category_id
       LEFT JOIN patients p ON p.id = inc.patient_id
       LEFT JOIN payments pm ON pm.id = inc.payment_id
       LEFT JOIN invoices i ON i.id = inc.invoice_id
       LEFT JOIN users u ON u.id = inc.created_by
      WHERE ${whereSql}
      ORDER BY inc.income_date DESC, inc.id DESC LIMIT ? OFFSET ?`,
    [...args, page.pageSize, page.offset],
  );
  const totalRow = get(
    db,
    `SELECT COALESCE(SUM(inc.amount_minor),0) AS amount FROM incomes inc LEFT JOIN patients p ON p.id = inc.patient_id WHERE ${whereSql}`,
    args,
  );
  return {
    rows: rows.map((row) => ({
      id: Number(row.id),
      incomeDate: row.income_date,
      categoryId: row.category_id,
      categoryName: row.category_name,
      categoryNameBn: row.category_name_bn,
      source: row.source,
      patientId: row.patient_id,
      patientName: row.patient_name,
      patientCode: row.patient_code,
      amountMinor: Number(row.amount_minor),
      methodCode: row.method_code,
      referenceNo: row.reference_no,
      description: row.description,
      notes: row.notes,
      receiptNumber: row.receipt_number,
      invoiceNumber: row.invoice_number,
      isAuto: row.payment_id !== null,
      isReversed: Boolean(row.is_reversed),
      createdBy: row.created_by_name,
    })),
    total,
    page: page.page,
    pageSize: page.pageSize,
    pages: Math.max(1, Math.ceil(total / page.pageSize)),
    totalMinor: Number(totalRow?.amount ?? 0),
  };
}

export function createIncome(db, ctx, input) {
  const values = assertValid(input, incomeSchema);
  const amountMinor = values.amount_minor ?? parseAmount(input.amount, 2) ?? 0;
  if (!amountMinor || amountMinor <= 0) {
    throw new ConflictError('finance.amountRequired');
  }
  const result = run(
    db,
    `INSERT INTO incomes (clinic_id, income_date, category_id, source, patient_id, amount_minor, method_code, reference_no, description, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      ctx.clinicId,
      values.income_date,
      values.category_id ?? null,
      values.source,
      values.patient_id ?? null,
      amountMinor,
      values.method_code,
      values.reference_no ?? null,
      values.description ?? null,
      values.notes ?? null,
      ctx.user?.id ?? null,
    ],
  );
  const id = Number(result.lastInsertRowid);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'create_income',
    module: 'finance',
    entity: 'income',
    entityId: id,
    summary: `Income of ${amountMinor} recorded (${values.description ?? values.source})`,
    severity: 'notice',
    after: { amount_minor: amountMinor, date: values.income_date, source: values.source },
  });
  return { id, amountMinor };
}

export function updateIncome(db, ctx, incomeId, input) {
  const before = get(db, 'SELECT * FROM incomes WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [incomeId, ctx.clinicId]);
  if (!before) throw new NotFoundError('income', incomeId);
  if (before.payment_id) throw new ConflictError('finance.autoIncomeLocked');
  const values = assertValid(input, incomeSchema, { partial: true });
  const columns = Object.keys(values);
  if (!columns.length) return { id: incomeId };
  run(db, `UPDATE incomes SET ${columns.map((col) => `${col} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [
    ...columns.map((col) => values[col]),
    nowIso(),
    incomeId,
  ]);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'update_income',
    module: 'finance',
    entity: 'income',
    entityId: incomeId,
    summary: `Income entry updated`,
    severity: 'info',
    before: { amount_minor: before.amount_minor },
    after: values,
  });
  return { id: incomeId };
}

export function deleteIncome(db, ctx, incomeId, reason = null) {
  const income = get(db, 'SELECT * FROM incomes WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [incomeId, ctx.clinicId]);
  if (!income) throw new NotFoundError('income', incomeId);
  if (income.payment_id) throw new ConflictError('finance.autoIncomeLocked');
  run(db, 'UPDATE incomes SET deleted_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), incomeId]);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'delete_income',
    module: 'finance',
    entity: 'income',
    entityId: incomeId,
    summary: `Income entry of ${income.amount_minor} removed${reason ? `: ${reason}` : ''}`,
    severity: 'warning',
    before: { amount_minor: income.amount_minor, date: income.income_date },
  });
  return { deleted: true };
}

/* ---------------------------------------------------------------- expenses */

export const expenseSchema = {
  expense_date: { type: 'date', required: true, default: () => todayIso() },
  category_id: { type: 'id', nullable: true },
  payee: { type: 'string', maxLength: 160, nullable: true },
  amount_minor: { type: 'int', min: 0, nullable: true },
  method_code: { type: 'string', maxLength: 32, default: 'cash' },
  reference_no: { type: 'string', maxLength: 80, nullable: true },
  supplier_id: { type: 'id', nullable: true },
  staff_id: { type: 'id', nullable: true },
  attachment_id: { type: 'id', nullable: true },
  description: { type: 'string', maxLength: 200, nullable: true },
  notes: { type: 'text', maxLength: 1000, nullable: true },
  is_recurring: { type: 'boolean', default: false },
  recurrence: { type: 'string', maxLength: 40, nullable: true },
};

export function listExpenses(db, ctx, params = {}) {
  const where = ['e.clinic_id = ?', 'e.deleted_at IS NULL'];
  const args = [ctx.clinicId];
  if (params.from) {
    where.push('e.expense_date >= ?');
    args.push(params.from);
  }
  if (params.to) {
    where.push('e.expense_date <= ?');
    args.push(params.to);
  }
  if (params.categoryId) {
    where.push('e.category_id = ?');
    args.push(Number(params.categoryId));
  }
  if (params.methodCode) {
    where.push('e.method_code = ?');
    args.push(params.methodCode);
  }
  if (params.supplierId) {
    where.push('e.supplier_id = ?');
    args.push(Number(params.supplierId));
  }
  if (params.search) {
    where.push("(COALESCE(e.description,'') LIKE ? ESCAPE '\\' OR COALESCE(e.payee,'') LIKE ? ESCAPE '\\' OR COALESCE(e.reference_no,'') LIKE ? ESCAPE '\\')");
    const pattern = `%${String(params.search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(pattern, pattern, pattern);
  }
  const page = resolvePaging(params);
  const whereSql = where.join(' AND ');
  const total = Number(get(db, `SELECT COUNT(*) AS c FROM expenses e WHERE ${whereSql}`, args)?.c ?? 0);
  const rows = all(
    db,
    `SELECT e.*, c.name_en AS category_name, c.name_bn AS category_name_bn, s.name AS supplier_name,
            u.display_name AS created_by_name
       FROM expenses e
       LEFT JOIN expense_categories c ON c.id = e.category_id
       LEFT JOIN suppliers s ON s.id = e.supplier_id
       LEFT JOIN users u ON u.id = e.created_by
      WHERE ${whereSql}
      ORDER BY e.expense_date DESC, e.id DESC LIMIT ? OFFSET ?`,
    [...args, page.pageSize, page.offset],
  );
  const totalRow = get(db, `SELECT COALESCE(SUM(e.amount_minor),0) AS amount FROM expenses e WHERE ${whereSql}`, args);
  return {
    rows: rows.map((row) => ({
      id: Number(row.id),
      expenseDate: row.expense_date,
      categoryId: row.category_id,
      categoryName: row.category_name,
      categoryNameBn: row.category_name_bn,
      payee: row.payee,
      amountMinor: Number(row.amount_minor),
      methodCode: row.method_code,
      referenceNo: row.reference_no,
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      staffId: row.staff_id,
      attachmentId: row.attachment_id,
      description: row.description,
      notes: row.notes,
      isRecurring: Boolean(row.is_recurring),
      recurrence: row.recurrence,
      createdBy: row.created_by_name,
    })),
    total,
    page: page.page,
    pageSize: page.pageSize,
    pages: Math.max(1, Math.ceil(total / page.pageSize)),
    totalMinor: Number(totalRow?.amount ?? 0),
  };
}

export function createExpense(db, ctx, input) {
  const values = assertValid(input, expenseSchema);
  const amountMinor = values.amount_minor ?? parseAmount(input.amount, 2) ?? 0;
  if (!amountMinor || amountMinor <= 0) throw new ConflictError('finance.amountRequired');
  if (values.attachment_id) {
    const attachment = get(db, 'SELECT id FROM attachments WHERE id = ? AND clinic_id = ?', [values.attachment_id, ctx.clinicId]);
    if (!attachment) throw new NotFoundError('attachment', values.attachment_id);
  }
  const result = run(
    db,
    `INSERT INTO expenses
      (clinic_id, expense_date, category_id, payee, amount_minor, method_code, reference_no, supplier_id, staff_id,
       attachment_id, description, notes, is_recurring, recurrence, created_by, updated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      ctx.clinicId,
      values.expense_date,
      values.category_id ?? null,
      values.payee ?? null,
      amountMinor,
      values.method_code,
      values.reference_no ?? null,
      values.supplier_id ?? null,
      values.staff_id ?? null,
      values.attachment_id ?? null,
      values.description ?? null,
      values.notes ?? null,
      values.is_recurring ? 1 : 0,
      values.recurrence ?? null,
      ctx.user?.id ?? null,
      ctx.user?.id ?? null,
    ],
  );
  const id = Number(result.lastInsertRowid);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'create_expense',
    module: 'finance',
    entity: 'expense',
    entityId: id,
    summary: `Expense of ${amountMinor} recorded (${values.description ?? values.payee ?? 'expense'})`,
    severity: 'notice',
    after: { amount_minor: amountMinor, date: values.expense_date, category_id: values.category_id ?? null },
  });
  return { id, amountMinor };
}

export function updateExpense(db, ctx, expenseId, input) {
  const before = get(db, 'SELECT * FROM expenses WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [expenseId, ctx.clinicId]);
  if (!before) throw new NotFoundError('expense', expenseId);
  const values = assertValid(input, expenseSchema, { partial: true });
  const columns = Object.keys(values);
  if (!columns.length) return { id: expenseId };
  run(db, `UPDATE expenses SET ${columns.map((col) => `${col} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`, [
    ...columns.map((col) => (typeof values[col] === 'boolean' ? (values[col] ? 1 : 0) : values[col])),
    ctx.user?.id ?? null,
    nowIso(),
    expenseId,
  ]);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'update_expense',
    module: 'finance',
    entity: 'expense',
    entityId: expenseId,
    summary: 'Expense updated',
    severity: 'info',
    before: { amount_minor: before.amount_minor },
    after: values,
  });
  return { id: expenseId };
}

/**
 * @param {any} db
 * @param {any} ctx
 * @param {number} expenseId
 * @param {string|null} [reason]
 */
export function deleteExpense(db, ctx, expenseId, reason = null) {
  const expense = get(db, 'SELECT * FROM expenses WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [expenseId, ctx.clinicId]);
  if (!expense) throw new NotFoundError('expense', expenseId);
  run(db, 'UPDATE expenses SET deleted_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), expenseId]);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'delete_expense',
    module: 'finance',
    entity: 'expense',
    entityId: expenseId,
    summary: `Expense of ${expense.amount_minor} removed${reason ? `: ${reason}` : ''}`,
    severity: 'warning',
    before: { amount_minor: expense.amount_minor, date: expense.expense_date },
  });
  return { deleted: true };
}

/* --------------------------------------------------------------- reporting */

/**
 * Complete finance summary for a range: billing ledger + cash ledger + series.
 */
/**
 * @param {any} db
 * @param {any} ctx
 * @param {{ from?: string|null, to?: string|null, preset?: string|null }} [range]
 */
export function financeSummary(db, ctx, { from, to, preset = null } = {}) {
  const range = preset && !from ? resolveRange(preset) : { from: from ?? todayIso(), to: to ?? from ?? todayIso() };

  const billing = get(
    db,
    `SELECT
        COALESCE(SUM(CASE WHEN status = 'issued' THEN total_minor END), 0) AS invoiced,
        COALESCE(SUM(CASE WHEN status = 'issued' THEN discount_minor END), 0) AS discount,
        COALESCE(SUM(CASE WHEN status = 'issued' THEN tax_minor END), 0) AS tax,
        COUNT(CASE WHEN status = 'issued' THEN 1 END) AS invoice_count
      FROM invoices WHERE clinic_id = ? AND deleted_at IS NULL AND invoice_date BETWEEN ? AND ?`,
    [ctx.clinicId, range.from, range.to],
  );

  const payments = get(
    db,
    `SELECT
        COALESCE(SUM(CASE WHEN kind = 'payment' THEN amount_minor END), 0) AS cash_collected,
        COALESCE(SUM(CASE WHEN kind = 'credit_used' THEN amount_minor END), 0) AS credit_used,
        COALESCE(SUM(CASE WHEN kind = 'refund' THEN amount_minor END), 0) AS refunded,
        COUNT(*) AS payment_count
      FROM payments
      WHERE clinic_id = ? AND deleted_at IS NULL AND voided_at IS NULL AND payment_date BETWEEN ? AND ?`,
    [ctx.clinicId, range.from, range.to],
  );

  const income = get(
    db,
    `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM incomes
      WHERE clinic_id = ? AND deleted_at IS NULL AND is_reversed = 0 AND income_date BETWEEN ? AND ?`,
    [ctx.clinicId, range.from, range.to],
  );

  const expense = get(
    db,
    `SELECT COALESCE(SUM(amount_minor), 0) AS total, COUNT(*) AS count FROM expenses
      WHERE clinic_id = ? AND deleted_at IS NULL AND expense_date BETWEEN ? AND ?`,
    [ctx.clinicId, range.from, range.to],
  );

  const outstanding = get(
    db,
    `SELECT COALESCE(SUM(due_minor), 0) AS due FROM invoices
      WHERE clinic_id = ? AND status = 'issued' AND deleted_at IS NULL`,
  );

  const collected = Number(payments?.cash_collected ?? 0) + Number(payments?.credit_used ?? 0);
  const refunded = Number(payments?.refunded ?? 0);
  const expenses = Number(expense?.total ?? 0);
  const netCash = collected - refunded - expenses;

  return {
    range,
    invoicedMinor: Number(billing?.invoiced ?? 0),
    discountMinor: Number(billing?.discount ?? 0),
    taxMinor: Number(billing?.tax ?? 0),
    invoiceCount: Number(billing?.invoice_count ?? 0),
    collectedMinor: collected,
    cashCollectedMinor: Number(payments?.cash_collected ?? 0),
    creditUsedMinor: Number(payments?.credit_used ?? 0),
    refundedMinor: refunded,
    paymentCount: Number(payments?.payment_count ?? 0),
    incomeLedgerMinor: Number(income?.total ?? 0),
    expensesMinor: expenses,
    expenseCount: Number(expense?.count ?? 0),
    outstandingMinor: Number(outstanding?.due ?? 0),
    netMinor: collected - refunded,
    netCashMinor: netCash,
  };
}

/** Daily series used by charts and the Finance screen. */
export function dailySeries(db, ctx, { from, to }) {
  const income = all(
    db,
    `SELECT income_date AS date, COALESCE(SUM(amount_minor),0) AS amount, COUNT(*) AS entries
       FROM incomes WHERE clinic_id = ? AND deleted_at IS NULL AND is_reversed = 0 AND income_date BETWEEN ? AND ?
      GROUP BY income_date`,
    [ctx.clinicId, from, to],
  );
  const refunds = all(
    db,
    `SELECT payment_date AS date, COALESCE(SUM(amount_minor),0) AS amount
       FROM payments WHERE clinic_id = ? AND deleted_at IS NULL AND voided_at IS NULL AND kind = 'refund' AND payment_date BETWEEN ? AND ?
      GROUP BY payment_date`,
    [ctx.clinicId, from, to],
  );
  const expenses = all(
    db,
    `SELECT expense_date AS date, COALESCE(SUM(amount_minor),0) AS amount, COUNT(*) AS entries
       FROM expenses WHERE clinic_id = ? AND deleted_at IS NULL AND expense_date BETWEEN ? AND ?
      GROUP BY expense_date`,
    [ctx.clinicId, from, to],
  );
  const map = new Map();
  const ensure = (date) => {
    if (!map.has(date)) map.set(date, { date, incomeMinor: 0, refundMinor: 0, expenseMinor: 0, netMinor: 0, incomeEntries: 0, expenseEntries: 0 });
    return map.get(date);
  };
  for (const row of income) {
    const entry = ensure(row.date);
    entry.incomeMinor = Number(row.amount);
    entry.incomeEntries = Number(row.entries);
  }
  for (const row of refunds) ensure(row.date).refundMinor = Number(row.amount);
  for (const row of expenses) {
    const entry = ensure(row.date);
    entry.expenseMinor = Number(row.amount);
    entry.expenseEntries = Number(row.entries);
  }
  return [...map.values()]
    .map((entry) => ({ ...entry, netMinor: entry.incomeMinor - entry.refundMinor - entry.expenseMinor }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function incomeByCategory(db, ctx, { from, to }) {
  const rows = all(
    db,
    `SELECT COALESCE(c.name_en, 'Uncategorised') AS name, COALESCE(c.name_bn,'') AS name_bn,
            COALESCE(SUM(inc.amount_minor), 0) AS amount, COUNT(*) AS entries
       FROM incomes inc LEFT JOIN income_categories c ON c.id = inc.category_id
      WHERE inc.clinic_id = ? AND inc.deleted_at IS NULL AND inc.is_reversed = 0 AND inc.income_date BETWEEN ? AND ?
      GROUP BY c.id ORDER BY amount DESC`,
    [ctx.clinicId, from, to],
  );
  return rows.map((row) => ({ name: row.name, nameBn: row.name_bn, amountMinor: Number(row.amount), entries: Number(row.entries) }));
}

export function expensesByCategory(db, ctx, { from, to }) {
  const rows = all(
    db,
    `SELECT COALESCE(c.name_en, 'Uncategorised') AS name, COALESCE(c.name_bn,'') AS name_bn,
            COALESCE(SUM(e.amount_minor), 0) AS amount, COUNT(*) AS entries
       FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id
      WHERE e.clinic_id = ? AND e.deleted_at IS NULL AND e.expense_date BETWEEN ? AND ?
      GROUP BY c.id ORDER BY amount DESC`,
    [ctx.clinicId, from, to],
  );
  return rows.map((row) => ({ name: row.name, nameBn: row.name_bn, amountMinor: Number(row.amount), entries: Number(row.entries) }));
}

/** Revenue split by service/treatment for the finance reports. */
export function revenueByService(db, ctx, { from, to, limit = 25 }) {
  const rows = all(
    db,
    `SELECT t.name, COALESCE(SUM(t.total_minor),0) AS amount, COUNT(*) AS count
       FROM treatments t
      WHERE t.clinic_id = ? AND t.deleted_at IS NULL AND t.status <> 'cancelled' AND t.treatment_date BETWEEN ? AND ?
      GROUP BY t.name ORDER BY amount DESC LIMIT ?`,
    [ctx.clinicId, from, to, Math.min(200, Math.max(1, limit))],
  );
  return rows.map((row) => ({ name: row.name, amountMinor: Number(row.amount), count: Number(row.count) }));
}

/** Month-by-month trend for the last N months (charts + reports). */
export function monthlyTrend(db, ctx, { months = 12 } = {}) {
  const rows = all(
    db,
    `WITH months(m) AS (
        SELECT strftime('%Y-%m', date('now','start of month', ?)) 
        UNION ALL SELECT strftime('%Y-%m', date(m || '-01', '+1 month')) FROM months WHERE m < strftime('%Y-%m','now')
     )
     SELECT m AS month,
            (SELECT COALESCE(SUM(amount_minor),0) FROM incomes WHERE clinic_id = :clinic AND is_reversed = 0 AND deleted_at IS NULL AND strftime('%Y-%m', income_date) = m) AS income,
            (SELECT COALESCE(SUM(amount_minor),0) FROM expenses WHERE clinic_id = :clinic AND deleted_at IS NULL AND strftime('%Y-%m', expense_date) = m) AS expense,
            (SELECT COALESCE(SUM(amount_minor),0) FROM payments WHERE clinic_id = :clinic AND deleted_at IS NULL AND voided_at IS NULL AND kind = 'refund' AND strftime('%Y-%m', payment_date) = m) AS refunds
       FROM months ORDER BY month`,
    [{ clinic: ctx.clinicId, m: `-${Math.max(1, months) - 1} months` }],
  );
  return rows.map((row) => ({
    month: row.month,
    incomeMinor: Number(row.income),
    expenseMinor: Number(row.expense),
    refundMinor: Number(row.refunds),
    netMinor: Number(row.income) - Number(row.refunds) - Number(row.expense),
  }));
}
