/**
 * Staff and payroll (§ 42, § 43).
 *
 *  - a practitioner is a staff row with `is_practitioner = 1`, which is what the
 *    appointment/treatment/visit screens list;
 *  - salary payments create their expense row so payroll is never invisible to
 *    Finance, and a paid period cannot be edited or deleted;
 *  - staff numbers are sequential per clinic (STF-…) and unique.
 */
import { all, get, run, withTransaction, nowIso } from '../db/connection.js';
import { resolvePaging } from '../db/query.js';
import { assertValid } from '../domain/validation.js';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors.js';
import { SALARY_TYPES, STAFF_STATUSES } from '../../shared/constants.js';
import { todayIso, startOfMonth, endOfMonth, addDays } from '../domain/dates.js';
import { nextNumber } from './numbering.js';
import { recordAudit, diffForAudit } from './audit.js';
import { getSettings } from './settings.js';

export const staffSchema = {
  full_name: { type: 'string', required: true, minLength: 2, maxLength: 160 },
  role_title: { type: 'string', maxLength: 80, default: 'staff' },
  designation: { type: 'string', maxLength: 120, nullable: true },
  specialty: { type: 'string', maxLength: 120, nullable: true },
  qualification: { type: 'string', maxLength: 160, nullable: true },
  registration_no: { type: 'string', maxLength: 80, nullable: true },
  responsibilities: { type: 'text', maxLength: 2000, nullable: true },
  phone: { type: 'string', maxLength: 32, nullable: true },
  email: { type: 'string', maxLength: 160, nullable: true },
  address: { type: 'text', maxLength: 400, nullable: true },
  joining_date: { type: 'date', nullable: true },
  leaving_date: { type: 'date', nullable: true },
  salary_minor: { type: 'int', min: 0, default: 0 },
  salary_type: { type: 'enum', values: SALARY_TYPES, default: 'monthly' },
  status: { type: 'enum', values: STAFF_STATUSES, default: 'active' },
  is_practitioner: { type: 'boolean', default: false },
  photo_attachment_id: { type: 'id', nullable: true },
  signature_attachment_id: { type: 'id', nullable: true },
  color: { type: 'string', maxLength: 16, default: '#0f6f9a' },
  user_id: { type: 'id', nullable: true },
  notes: { type: 'text', maxLength: 2000, nullable: true },
};

export function shapeStaff(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    staffCode: row.staff_code,
    fullName: row.full_name,
    roleTitle: row.role_title,
    designation: row.designation,
    specialty: row.specialty,
    qualification: row.qualification,
    registrationNo: row.registration_no,
    responsibilities: row.responsibilities,
    phone: row.phone,
    email: row.email,
    address: row.address,
    joiningDate: row.joining_date,
    leavingDate: row.leaving_date,
    salaryMinor: Number(row.salary_minor),
    salaryType: row.salary_type,
    status: row.status,
    isPractitioner: Boolean(row.is_practitioner),
    photoAttachmentId: row.photo_attachment_id ?? null,
    signatureAttachmentId: row.signature_attachment_id ?? null,
    color: row.color,
    userId: row.user_id ?? null,
    username: row.username ?? null,
    notes: row.notes,
    payrollPaidMinor: row.payroll_paid === undefined ? undefined : Number(row.payroll_paid),
    createdAt: row.created_at,
  };
}

const STAFF_SELECT = `
  SELECT s.*, u.username,
         (SELECT COALESCE(SUM(p.net_minor), 0) FROM payroll p WHERE p.staff_id = s.id AND p.status = 'paid') AS payroll_paid
    FROM staff s LEFT JOIN users u ON u.id = s.user_id`;

export function listStaff(db, ctx, params = {}) {
  const where = ['s.clinic_id = ?', 's.deleted_at IS NULL'];
  const args = [ctx.clinicId];
  if (params.status && STAFF_STATUSES.includes(params.status)) {
    where.push('s.status = ?');
    args.push(params.status);
  }
  if (params.practitionersOnly === true || params.practitionersOnly === 'true') where.push('s.is_practitioner = 1');
  if (params.search) {
    where.push("(s.full_name LIKE ? ESCAPE '\\' OR s.staff_code LIKE ? ESCAPE '\\' OR COALESCE(s.phone,'') LIKE ? ESCAPE '\\' OR COALESCE(s.designation,'') LIKE ? ESCAPE '\\')");
    const pattern = `%${String(params.search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(pattern, pattern, pattern, pattern);
  }
  const page = resolvePaging(params);
  const whereSql = where.join(' AND ');
  const total = Number(get(db, `SELECT COUNT(*) AS c FROM staff s WHERE ${whereSql}`, args)?.c ?? 0);
  const rows = all(db, `${STAFF_SELECT} WHERE ${whereSql} ORDER BY s.is_practitioner DESC, s.full_name LIMIT ? OFFSET ?`, [
    ...args,
    page.pageSize,
    page.offset,
  ]);
  return { rows: rows.map(shapeStaff), total, page: page.page, pageSize: page.pageSize, pages: Math.max(1, Math.ceil(total / page.pageSize)) };
}

export function getStaff(db, ctx, staffId) {
  const row = get(db, `${STAFF_SELECT} WHERE s.id = ? AND s.clinic_id = ? AND s.deleted_at IS NULL`, [staffId, ctx.clinicId]);
  if (!row) throw new NotFoundError('staff', staffId);
  const payroll = all(
    db,
    'SELECT * FROM payroll WHERE staff_id = ? ORDER BY period_start DESC LIMIT 24',
    [staffId],
  ).map(shapePayroll);
  const stats = get(
    db,
    `SELECT
        (SELECT COUNT(*) FROM appointments WHERE practitioner_id = ? AND deleted_at IS NULL) AS appointments,
        (SELECT COUNT(*) FROM visits WHERE practitioner_id = ? AND deleted_at IS NULL) AS visits,
        (SELECT COUNT(*) FROM treatments WHERE practitioner_id = ? AND deleted_at IS NULL) AS treatments`,
    [staffId, staffId, staffId],
  );
  return {
    ...shapeStaff(row),
    payroll,
    stats: {
      appointments: Number(stats?.appointments ?? 0),
      visits: Number(stats?.visits ?? 0),
      treatments: Number(stats?.treatments ?? 0),
    },
  };
}

export function createStaff(db, ctx, input) {
  const values = assertValid(input, staffSchema);
  if (values.user_id) {
    const user = get(db, 'SELECT id FROM users WHERE id = ? AND clinic_id = ?', [values.user_id, ctx.clinicId]);
    if (!user) throw new NotFoundError('user', values.user_id);
  }
  return withTransaction(db, () => {
    const allocation = nextNumber(db, ctx.clinicId, 'staff');
    const result = run(
      db,
      `INSERT INTO staff
        (clinic_id, staff_code, full_name, role_title, designation, specialty, qualification, registration_no, responsibilities,
         phone, email, address, joining_date, leaving_date, salary_minor, salary_type, status, is_practitioner,
         photo_attachment_id, signature_attachment_id, color, user_id, notes, created_by, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ctx.clinicId,
        allocation.code,
        values.full_name,
        values.role_title,
        values.designation ?? null,
        values.specialty ?? null,
        values.qualification ?? null,
        values.registration_no ?? null,
        values.responsibilities ?? null,
        values.phone ?? null,
        values.email ?? null,
        values.address ?? null,
        values.joining_date ?? null,
        values.leaving_date ?? null,
        values.salary_minor,
        values.salary_type,
        values.status,
        values.is_practitioner ? 1 : 0,
        values.photo_attachment_id ?? null,
        values.signature_attachment_id ?? null,
        values.color,
        values.user_id ?? null,
        values.notes ?? null,
        ctx.user?.id ?? null,
        ctx.user?.id ?? null,
      ],
    );
    const id = Number(result.lastInsertRowid);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'create',
      module: 'staff',
      entity: 'staff',
      entityId: id,
      summary: `Staff ${allocation.code} (${values.full_name}) added`,
      severity: 'notice',
      after: { staff_code: allocation.code, role: values.role_title, practitioner: Boolean(values.is_practitioner) },
    });
    return { id, staffCode: allocation.code };
  });
}

export function updateStaff(db, ctx, staffId, input) {
  const before = get(db, 'SELECT * FROM staff WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [staffId, ctx.clinicId]);
  if (!before) throw new NotFoundError('staff', staffId);
  const values = assertValid(input, staffSchema, { partial: true });
  const columns = Object.keys(values);
  if (!columns.length) return shapeStaff(before);
  run(db, `UPDATE staff SET ${columns.map((col) => `${col} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`, [
    ...columns.map((col) => (typeof values[col] === 'boolean' ? (values[col] ? 1 : 0) : values[col])),
    ctx.user?.id ?? null,
    nowIso(),
    staffId,
  ]);
  const after = get(db, 'SELECT * FROM staff WHERE id = ?', [staffId]);
  const diff = diffForAudit(before, after, [...columns, 'updated_at']);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'update',
    module: 'staff',
    entity: 'staff',
    entityId: staffId,
    summary: `Staff ${before.staff_code} updated (${diff.changed.join(', ')})`,
    severity: 'info',
    before: diff.before,
    after: diff.after,
  });
  return shapeStaff(after);
}

/**
 * @param {any} db
 * @param {any} ctx
 * @param {number} staffId
 * @param {string|null} [reason]
 */
export function archiveStaff(db, ctx, staffId, reason = null) {
  const staff = get(db, 'SELECT * FROM staff WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [staffId, ctx.clinicId]);
  if (!staff) throw new NotFoundError('staff', staffId);
  const unpaid = get(db, "SELECT COUNT(*) AS c FROM payroll WHERE staff_id = ? AND status IN ('pending','partial')", [staffId]);
  if (Number(unpaid?.c ?? 0) > 0) throw new ConflictError('staff.unpaidPayrollExists');
  run(db, 'UPDATE staff SET deleted_at = ?, status = \'left\', updated_by = ?, updated_at = ? WHERE id = ?', [
    nowIso(),
    ctx.user?.id ?? null,
    nowIso(),
    staffId,
  ]);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'archive',
    module: 'staff',
    entity: 'staff',
    entityId: staffId,
    summary: `Staff ${staff.staff_code} archived${reason ? `: ${reason}` : ''}`,
    severity: 'warning',
  });
  return { archived: true };
}

/* ------------------------------------------------------------------ payroll */

export const payrollSchema = {
  staff_id: { type: 'id', required: true },
  period_start: { type: 'date', required: true, default: () => startOfMonth(todayIso()) },
  period_end: { type: 'date', required: true, default: () => endOfMonth(todayIso()) },
  gross_minor: { type: 'int', min: 0, nullable: true },
  deduction_minor: { type: 'int', min: 0, default: 0 },
  paid_minor: { type: 'int', min: 0, default: 0 },
  method_code: { type: 'string', maxLength: 32, nullable: true },
  paid_on: { type: 'date', nullable: true },
  notes: { type: 'text', maxLength: 1000, nullable: true },
  items: { type: 'array', default: [] },
};

export function shapePayroll(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    staffId: Number(row.staff_id),
    staffName: row.full_name ?? null,
    staffCode: row.staff_code ?? null,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    grossMinor: Number(row.gross_minor),
    deductionMinor: Number(row.deduction_minor),
    netMinor: Number(row.net_minor),
    paidMinor: Number(row.paid_minor),
    dueMinor: Math.max(0, Number(row.net_minor) - Number(row.paid_minor)),
    status: row.status,
    paidOn: row.paid_on,
    methodCode: row.method_code,
    notes: row.notes,
    expenseId: row.expense_id ?? null,
    createdAt: row.created_at,
  };
}

const PAYROLL_SELECT = `
  SELECT p.*, s.full_name, s.staff_code FROM payroll p JOIN staff s ON s.id = p.staff_id`;

/**
 * One payroll row with the staff details a payslip needs.
 * @param {any} db
 * @param {any} ctx
 * @param {number} payrollId
 */
export function getPayroll(db, ctx, payrollId) {
  const row = get(db, `${PAYROLL_SELECT} WHERE p.id = ? AND p.clinic_id = ?`, [payrollId, ctx.clinicId]);
  if (!row) return null;
  return {
    ...shapePayroll(row),
    staff: {
      designation: row.designation ?? null,
      role: row.role_title ?? null,
      salaryType: row.salary_type ?? null,
      baseSalaryMinor: row.salary_minor === undefined || row.salary_minor === null ? null : Number(row.salary_minor),
      joiningDate: row.joining_date ?? null,
      phone: row.phone ?? null,
      email: row.email ?? null,
    },
  };
}

export function listPayroll(db, ctx, params = {}) {
  const where = ['p.clinic_id = ?'];
  const args = [ctx.clinicId];
  if (params.staffId) {
    where.push('p.staff_id = ?');
    args.push(Number(params.staffId));
  }
  if (params.status) {
    where.push('p.status = ?');
    args.push(String(params.status));
  }
  if (params.from) {
    where.push('p.period_end >= ?');
    args.push(params.from);
  }
  if (params.to) {
    where.push('p.period_start <= ?');
    args.push(params.to);
  }
  const page = resolvePaging(params);
  const whereSql = where.join(' AND ');
  const total = Number(get(db, `SELECT COUNT(*) AS c FROM payroll p WHERE ${whereSql}`, args)?.c ?? 0);
  const rows = all(db, `${PAYROLL_SELECT} WHERE ${whereSql} ORDER BY p.period_start DESC, s.full_name LIMIT ? OFFSET ?`, [
    ...args,
    page.pageSize,
    page.offset,
  ]);
  const totals = get(
    db,
    `SELECT COALESCE(SUM(p.net_minor),0) AS net, COALESCE(SUM(p.paid_minor),0) AS paid FROM payroll p WHERE ${whereSql}`,
    args,
  );
  return {
    rows: rows.map(shapePayroll),
    total,
    page: page.page,
    pageSize: page.pageSize,
    pages: Math.max(1, Math.ceil(total / page.pageSize)),
    totalsMinor: { net: Number(totals?.net ?? 0), paid: Number(totals?.paid ?? 0) },
  };
}

export function createPayroll(db, ctx, input) {
  const values = assertValid(input, payrollSchema);
  if (values.period_end < values.period_start) {
    throw new ValidationError('validation.failed', [{ field: 'period_end', key: 'payroll.invalidPeriod' }]);
  }
  const staff = get(db, 'SELECT * FROM staff WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [values.staff_id, ctx.clinicId]);
  if (!staff) throw new NotFoundError('staff', values.staff_id);
  const duplicate = get(db, 'SELECT id FROM payroll WHERE clinic_id = ? AND staff_id = ? AND period_start = ? AND period_end = ?', [
    ctx.clinicId,
    values.staff_id,
    values.period_start,
    values.period_end,
  ]);
  if (duplicate) throw new ConflictError('payroll.duplicatePeriod');

  const items = Array.isArray(input.items) ? input.items : [];
  const earnings = items.filter((entry) => entry.kind === 'earning').reduce((sum, entry) => sum + Number(entry.amount_minor ?? 0), 0);
  const deductionItems = items.filter((entry) => entry.kind === 'deduction').reduce((sum, entry) => sum + Number(entry.amount_minor ?? 0), 0);
  const gross = Number(values.gross_minor ?? (earnings || staff.salary_minor));
  const deduction = Number(values.deduction_minor ?? 0) + deductionItems;
  const net = Math.max(0, gross - deduction);

  return withTransaction(db, () => {
    const result = run(
      db,
      `INSERT INTO payroll (clinic_id, staff_id, period_start, period_end, gross_minor, deduction_minor, net_minor, paid_minor, status, paid_on, method_code, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ctx.clinicId,
        values.staff_id,
        values.period_start,
        values.period_end,
        gross,
        deduction,
        net,
        Number(values.paid_minor ?? 0),
        Number(values.paid_minor ?? 0) >= net && net > 0 ? 'paid' : Number(values.paid_minor ?? 0) > 0 ? 'partial' : 'pending',
        values.paid_minor ? values.paid_on ?? todayIso() : null,
        values.method_code ?? null,
        values.notes ?? null,
        ctx.user?.id ?? null,
      ],
    );
    const payrollId = Number(result.lastInsertRowid);
    writePayrollItems(db, payrollId, items);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'create_payroll',
      module: 'payroll',
      entity: 'payroll',
      entityId: payrollId,
      summary: `Payroll for ${staff.full_name} ${values.period_start}…${values.period_end}: net ${net} minor units`,
      severity: 'notice',
      after: { gross_minor: gross, deduction_minor: deduction, net_minor: net },
    });
    return { id: payrollId, netMinor: net };
  });
}

function writePayrollItems(db, payrollId, items) {
  items.forEach((entry, index) => {
    run(db, 'INSERT INTO payroll_items (payroll_id, kind, label, amount_minor, sort_order) VALUES (?,?,?,?,?)', [
      payrollId,
      entry.kind === 'deduction' ? 'deduction' : 'earning',
      String(entry.label ?? (entry.kind === 'deduction' ? 'Deduction' : 'Earning')),
      Math.max(0, Number(entry.amount_minor ?? 0)),
      Number(entry.sort_order ?? index * 10),
    ]);
  });
}

/** Record a salary payment; the expense row keeps Finance accurate. */
/**
 * @param {any} db
 * @param {any} ctx
 * @param {number} payrollId
 * @param {{ amount_minor?: number|null, method_code?: string, paid_on?: string, notes?: string|null }} [input]
 */
export function payPayroll(db, ctx, payrollId, { amount_minor = null, method_code = 'cash', paid_on = todayIso(), notes = null } = {}) {
  const payroll = get(db, 'SELECT * FROM payroll WHERE id = ? AND clinic_id = ?', [payrollId, ctx.clinicId]);
  if (!payroll) throw new NotFoundError('payroll', payrollId);
  if (payroll.status === 'cancelled') throw new ConflictError('payroll.cancelled');
  const staff = get(db, 'SELECT full_name, staff_code FROM staff WHERE id = ?', [payroll.staff_id]);
  const due = Math.max(0, Number(payroll.net_minor) - Number(payroll.paid_minor));
  const amount = amount_minor === null ? due : Number(amount_minor);
  if (amount <= 0) throw new ConflictError('payroll.nothingToPay');
  if (amount > due) throw new ConflictError('payroll.exceedsDue', { dueMinor: due });

  return withTransaction(db, () => {
    const paid = Number(payroll.paid_minor) + amount;
    const status = paid >= Number(payroll.net_minor) ? 'paid' : 'partial';
    run(db, 'UPDATE payroll SET paid_minor = ?, status = ?, paid_on = ?, method_code = ?, notes = COALESCE(?, notes), updated_at = ? WHERE id = ?', [
      paid,
      status,
      paid_on,
      method_code,
      notes,
      nowIso(),
      payrollId,
    ]);

    // Salary expense (category "Staff salary" when present).
    const category = get(
      db,
      "SELECT id FROM expense_categories WHERE clinic_id = ? AND deleted_at IS NULL ORDER BY is_system DESC, CASE WHEN name_en LIKE '%salary%' THEN 0 ELSE 1 END, sort_order LIMIT 1",
      [ctx.clinicId],
    );
    let expenseId = payroll.expense_id;
    if (expenseId) {
      run(db, 'UPDATE expenses SET amount_minor = amount_minor + ?, updated_at = ? WHERE id = ?', [amount, nowIso(), expenseId]);
    } else {
      const settings = getSettings(db, ctx.clinicId);
      const result = run(
        db,
        `INSERT INTO expenses (clinic_id, expense_date, category_id, payee, amount_minor, method_code, staff_id, description, notes, created_by, updated_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          ctx.clinicId,
          paid_on,
          category?.id ?? null,
          staff?.full_name ?? null,
          amount,
          method_code,
          payroll.staff_id,
          `Salary ${payroll.period_start}…${payroll.period_end}${settings['clinic.name'] ? '' : ''}`,
          notes,
          ctx.user?.id ?? null,
          ctx.user?.id ?? null,
        ],
      );
      expenseId = Number(result.lastInsertRowid);
      run(db, 'UPDATE payroll SET expense_id = ? WHERE id = ?', [expenseId, payrollId]);
    }

    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'pay_payroll',
      module: 'payroll',
      entity: 'payroll',
      entityId: payrollId,
      summary: `Salary ${amount} paid to ${staff?.full_name ?? 'staff'} (${status})`,
      severity: 'notice',
      after: { amount_minor: amount, status, expense_id: expenseId },
    });
    return { id: payrollId, paidMinor: paid, status, expenseId };
  });
}

/**
 * @param {any} db
 * @param {any} ctx
 * @param {number} payrollId
 * @param {string|null} [reason]
 */
export function deletePayroll(db, ctx, payrollId, reason = null) {
  const payroll = get(db, 'SELECT * FROM payroll WHERE id = ? AND clinic_id = ?', [payrollId, ctx.clinicId]);
  if (!payroll) throw new NotFoundError('payroll', payrollId);
  if (Number(payroll.paid_minor) > 0) throw new ConflictError('payroll.paidCannotDelete');
  return withTransaction(db, () => {
    run(db, 'DELETE FROM payroll_items WHERE payroll_id = ?', [payrollId]);
    run(db, 'DELETE FROM payroll WHERE id = ?', [payrollId]);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'delete_payroll',
      module: 'payroll',
      entity: 'payroll',
      entityId: payrollId,
      summary: `Unpaid payroll row deleted${reason ? `: ${reason}` : ''}`,
      severity: 'warning',
      before: { staff_id: payroll.staff_id, net_minor: payroll.net_minor },
    });
    return { deleted: true };
  });
}

/** Draft a payroll run for every active monthly staff member for a period. */
export function draftPayrollRun(db, ctx, { period_start = startOfMonth(todayIso()), period_end = endOfMonth(todayIso()) } = {}) {
  const staffRows = all(
    db,
    "SELECT * FROM staff WHERE clinic_id = ? AND deleted_at IS NULL AND status = 'active' AND salary_minor > 0 ORDER BY full_name",
    [ctx.clinicId],
  );
  const created = [];
  const skipped = [];
  for (const member of staffRows) {
    const existing = get(db, 'SELECT id FROM payroll WHERE clinic_id = ? AND staff_id = ? AND period_start = ? AND period_end = ?', [
      ctx.clinicId,
      member.id,
      period_start,
      period_end,
    ]);
    if (existing) {
      skipped.push({ staffId: member.id, reason: 'exists' });
      continue;
    }
    const record = createPayroll(db, ctx, {
      staff_id: member.id,
      period_start,
      period_end,
      gross_minor: member.salary_minor,
      deduction_minor: 0,
      notes: 'Generated from staff salary',
    });
    created.push({ staffId: member.id, payrollId: record.id, netMinor: record.netMinor });
  }
  return { periodStart: period_start, periodEnd: period_end, created, skipped, totalCreatedMinor: created.reduce((sum, row) => sum + row.netMinor, 0) };
}

/** Attendance-style summary of booked work per practitioner (dashboard card). */
/**
 * @param {any} db
 * @param {any} ctx
 * @param {{ from?: string|null, to?: string|null }} [range]
 */
export function practitionerWorkload(db, ctx, { from = addDays(todayIso(), -30), to = todayIso() } = {}) {
  const rows = all(
    db,
    `SELECT s.id, s.full_name, s.color,
            (SELECT COUNT(*) FROM appointments a WHERE a.practitioner_id = s.id AND a.appt_date BETWEEN ? AND ? AND a.deleted_at IS NULL AND a.status <> 'cancelled') AS appointments,
            (SELECT COUNT(*) FROM visits v WHERE v.practitioner_id = s.id AND v.visit_date BETWEEN ? AND ? AND v.deleted_at IS NULL) AS visits,
            (SELECT COUNT(*) FROM treatments t WHERE t.practitioner_id = s.id AND t.treatment_date BETWEEN ? AND ? AND t.deleted_at IS NULL) AS treatments
       FROM staff s
      WHERE s.clinic_id = ? AND s.deleted_at IS NULL AND s.is_practitioner = 1
      ORDER BY s.full_name`,
    [from, to, from, to, from, to, ctx.clinicId],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    staffId: Number(row.id),
    name: row.full_name,
    color: row.color,
    appointments: Number(row.appointments),
    visits: Number(row.visits),
    treatments: Number(row.treatments),
  }));
}

export { startOfMonth, endOfMonth };
