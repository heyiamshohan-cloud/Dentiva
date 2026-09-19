/**
 * Today's serial / patient queue (§ 31).
 *
 * Serial numbers are unique per clinic per day (enforced by a UNIQUE index) and
 * allocated inside the same transaction that creates the entry, so two
 * receptionists checking patients in at the same second can never hand out the
 * same serial.
 */
import { all, get, run, withTransaction, nowIso } from '../db/connection.js';
import { NotFoundError, ValidationError, ConflictError } from '../../shared/errors.js';
import { QUEUE_STATUSES } from '../../shared/constants.js';
import { todayIso } from '../domain/dates.js';
import { getSettings } from './settings.js';
import { recordAudit } from './audit.js';

/**
 * Public shape of a queue entry.
 * @param {any} row
 * @returns {any}
 */
export function shapeQueueEntry(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    serialNo: Number(row.serial_no),
    patientId: Number(row.patient_id),
    patientName: row.patient_name ?? null,
    patientCode: row.patient_code ?? null,
    patientPhone: row.patient_phone ?? null,
    appointmentId: row.appointment_id ?? null,
    appointmentCode: row.appointment_code ?? null,
    appointmentTime: row.start_time ?? null,
    status: row.status,
    priority: Number(row.priority ?? 0),
    note: row.note,
    checkedInAt: row.checked_in_at,
    calledAt: row.called_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    visitId: row.visit_id ?? null,
    queueDate: row.queue_date,
  };
}

const QUEUE_SELECT = `
  SELECT q.*, p.full_name AS patient_name, p.patient_code, p.phone AS patient_phone,
         a.appointment_code, a.start_time, a.visit_id
    FROM queue_entries q
    JOIN patients p ON p.id = q.patient_id
    LEFT JOIN appointments a ON a.id = q.appointment_id`;

/** Allocate the next serial for a date (inside a transaction). */
function nextSerial(db, clinicId, date) {
  const settings = getSettings(db, clinicId);
  const start = Number(settings['queue.startNumber'] ?? 1);
  const row = get(db, 'SELECT COALESCE(MAX(serial_no), ?) AS max_serial FROM queue_entries WHERE clinic_id = ? AND queue_date = ?', [
    start - 1,
    clinicId,
    date,
  ]);
  return Math.max(start, Number(row?.max_serial ?? start - 1) + 1);
}

/**
 * Check a patient into today's queue (from an appointment or as a walk-in).
 * @param {any} db
 * @param {any} ctx
 * @param {{ appointmentId?: number|null, patientId?: number|null, date?: string, note?: string|null, priority?: number }} input
 */
export function checkIn(db, ctx, { appointmentId = null, patientId = null, date = todayIso(), note = null, priority = 0 }) {
  const queueDate = date ?? todayIso();
  let resolvedPatientId = patientId ? Number(patientId) : null;
  let appointment = null;

  if (appointmentId) {
    appointment = get(db, 'SELECT * FROM appointments WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [
      Number(appointmentId),
      ctx.clinicId,
    ]);
    if (!appointment) throw new NotFoundError('appointment', appointmentId);
    if (['cancelled', 'no_show'].includes(appointment.status)) {
      throw new ConflictError('queue.cannotCheckInCancelled');
    }
    resolvedPatientId = appointment.patient_id;
  }
  if (!resolvedPatientId) throw new ValidationError('validation.failed', [{ field: 'patientId', key: 'validation.required' }]);
  const patient = get(db, 'SELECT id, patient_code, full_name FROM patients WHERE id = ? AND clinic_id = ?', [
    resolvedPatientId,
    ctx.clinicId,
  ]);
  if (!patient) throw new NotFoundError('patient', resolvedPatientId);

  const existing = get(
    db,
    `SELECT * FROM queue_entries
      WHERE clinic_id = ? AND queue_date = ? AND patient_id = ?
        AND status IN ('waiting','called','in_treatment')
      ORDER BY id DESC LIMIT 1`,
    [ctx.clinicId, queueDate, resolvedPatientId],
  );
  if (existing) {
    return { id: Number(existing.id), serialNo: Number(existing.serial_no), alreadyCheckedIn: true };
  }

  return withTransaction(db, () => {
    const serial = nextSerial(db, ctx.clinicId, queueDate);
    let result;
    try {
      result = run(
        db,
        `INSERT INTO queue_entries
          (clinic_id, queue_date, appointment_id, patient_id, serial_no, status, priority, checked_in_at, note, created_by)
         VALUES (?,?,?,?,?, 'waiting', ?, ?, ?, ?)`,
        [
          ctx.clinicId,
          queueDate,
          appointment?.id ?? null,
          resolvedPatientId,
          serial,
          Number(priority) || 0,
          nowIso(),
          note,
          ctx.user?.id ?? null,
        ],
      );
    } catch (error) {
      // A concurrent check-in may have taken the serial; retry once with a fresh one.
      const message = error instanceof Error ? error.message : String(error);
      if (!/UNIQUE constraint failed/i.test(message)) throw error;
      const retrySerial = nextSerial(db, ctx.clinicId, queueDate);
      result = run(
        db,
        `INSERT INTO queue_entries
          (clinic_id, queue_date, appointment_id, patient_id, serial_no, status, priority, checked_in_at, note, created_by)
         VALUES (?,?,?,?,?, 'waiting', ?, ?, ?, ?)`,
        [ctx.clinicId, queueDate, appointment?.id ?? null, resolvedPatientId, retrySerial, Number(priority) || 0, nowIso(), note, ctx.user?.id ?? null],
      );
    }
    const entryId = Number(result.lastInsertRowid);
    if (appointment) {
      run(
        db,
        `UPDATE appointments SET status = 'checked_in', checked_in_at = COALESCE(checked_in_at, ?),
            serial_no = ?, updated_at = ? WHERE id = ?`,
        [nowIso(), serial, nowIso(), appointment.id],
      );
    }
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'check_in',
      module: 'queue',
      entity: 'queue_entry',
      entityId: entryId,
      summary: `${patient.patient_code} checked in — serial ${serial}`,
      severity: 'info',
      after: { serial, patient: patient.patient_code, appointment: appointment?.appointment_code ?? null },
    });
    return { id: entryId, serialNo: serial, patientId: resolvedPatientId, alreadyCheckedIn: false };
  });
}

export function listQueue(db, ctx, { date = todayIso(), includeFinished = true } = {}) {
  const args = [ctx.clinicId, date];
  let filter = '';
  if (!includeFinished) filter = " AND q.status IN ('waiting','called','in_treatment')";
  const rows = all(
    db,
    `${QUEUE_SELECT} WHERE q.clinic_id = ? AND q.queue_date = ? ${filter}
      ORDER BY q.priority DESC, q.serial_no ASC`,
    args,
  );
  const entries = rows.map(shapeQueueEntry);
  const stats = {
    total: entries.length,
    waiting: entries.filter((entry) => entry.status === 'waiting').length,
    called: entries.filter((entry) => entry.status === 'called').length,
    inTreatment: entries.filter((entry) => entry.status === 'in_treatment').length,
    completed: entries.filter((entry) => entry.status === 'completed').length,
    skipped: entries.filter((entry) => entry.status === 'skipped').length,
    cancelled: entries.filter((entry) => entry.status === 'cancelled').length,
  };
  const current =
    entries.find((entry) => entry.status === 'in_treatment') ??
    entries.find((entry) => entry.status === 'called') ??
    null;
  const next = entries.find((entry) => entry.status === 'waiting' && entry.id !== current?.id) ?? null;
  return { date, entries, stats, current, next };
}

function transition(db, ctx, entryId, status, extras = {}) {
  const entry = get(db, 'SELECT * FROM queue_entries WHERE id = ? AND clinic_id = ?', [entryId, ctx.clinicId]);
  if (!entry) throw new NotFoundError('queue_entry', entryId);
  if (!QUEUE_STATUSES.includes(status)) {
    throw new ValidationError('validation.failed', [{ field: 'status', key: 'validation.option' }]);
  }
  const sets = ['status = ?', 'updated_at = ?'];
  const params = [status, nowIso()];
  if (status === 'called' && !entry.called_at) {
    sets.push('called_at = ?');
    params.push(nowIso());
  }
  if (status === 'in_treatment' && !entry.started_at) {
    sets.push('started_at = ?');
    params.push(nowIso());
  }
  if (status === 'completed' && !entry.completed_at) {
    sets.push('completed_at = ?');
    params.push(nowIso());
  }
  if (extras.note !== undefined) {
    sets.push('note = ?');
    params.push(extras.note);
  }
  if (extras.priority !== undefined) {
    sets.push('priority = ?');
    params.push(Number(extras.priority) || 0);
  }
  run(db, `UPDATE queue_entries SET ${sets.join(', ')} WHERE id = ?`, [...params, entryId]);

  const appointmentStatus = { called: 'checked_in', in_treatment: 'in_treatment', completed: 'completed', cancelled: 'cancelled' }[status];
  if (entry.appointment_id && appointmentStatus) {
    const appointmentSets = ['status = ?', 'updated_at = ?'];
    const appointmentParams = [appointmentStatus, nowIso()];
    if (appointmentStatus === 'in_treatment') {
      appointmentSets.push('started_at = COALESCE(started_at, ?)');
      appointmentParams.push(nowIso());
    }
    if (appointmentStatus === 'completed') {
      appointmentSets.push('completed_at = COALESCE(completed_at, ?)');
      appointmentParams.push(nowIso());
    }
    run(db, `UPDATE appointments SET ${appointmentSets.join(', ')} WHERE id = ?`, [...appointmentParams, entry.appointment_id]);
  }
  if (status === 'completed' && entry.appointment_id && !extras.skipAppointmentUpdate) {
    // Visits created from the queue link themselves to the appointment.
  }
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'queue_status',
    module: 'queue',
    entity: 'queue_entry',
    entityId: entryId,
    summary: `Serial ${entry.serial_no}: ${entry.status} → ${status}`,
    severity: 'info',
    before: { status: entry.status },
    after: { status },
  });
  return get(db, `${QUEUE_SELECT} WHERE q.id = ?`, [entryId]);
}

export function callEntry(db, ctx, entryId) {
  return transition(db, ctx, entryId, 'called');
}

export function startEntry(db, ctx, entryId) {
  return transition(db, ctx, entryId, 'in_treatment');
}

/**
 * @param {any} db
 * @param {any} ctx
 * @param {number} entryId
 * @param {{ note?: string|null }} [options]
 */
export function completeEntry(db, ctx, entryId, { note } = {}) {
  return transition(db, ctx, entryId, 'completed', { note });
}

/**
 * @param {any} db
 * @param {any} ctx
 * @param {number} entryId
 * @param {string|null} [note]
 */
export function skipEntry(db, ctx, entryId, note = null) {
  return transition(db, ctx, entryId, 'skipped', { note });
}

export function cancelEntry(db, ctx, entryId, note = null) {
  return transition(db, ctx, entryId, 'cancelled', { note });
}

export function setPriority(db, ctx, entryId, priority) {
  return transition(db, ctx, entryId, get(db, 'SELECT status FROM queue_entries WHERE id = ?', [entryId])?.status ?? 'waiting', {
    priority,
  });
}

/** Move an entry up/down by swapping serial numbers with its neighbour. */
export function moveEntry(db, ctx, entryId, direction) {
  const entry = get(db, 'SELECT * FROM queue_entries WHERE id = ? AND clinic_id = ?', [entryId, ctx.clinicId]);
  if (!entry) throw new NotFoundError('queue_entry', entryId);
  const neighbour = get(
    db,
    `SELECT * FROM queue_entries
      WHERE clinic_id = ? AND queue_date = ? AND status IN ('waiting','called')
        AND serial_no ${direction === 'up' ? '<' : '>'} ?
      ORDER BY serial_no ${direction === 'up' ? 'DESC' : 'ASC'} LIMIT 1`,
    [ctx.clinicId, entry.queue_date, entry.serial_no],
  );
  if (!neighbour) return { moved: false, serialNo: Number(entry.serial_no) };
  return withTransaction(db, () => {
    // Swap through a free temporary serial so the UNIQUE(clinic, date, serial)
    // index and the CHECK (serial_no > 0) constraint both stay satisfied.
    const tempSerial = Number(
      get(db, 'SELECT COALESCE(MAX(serial_no), 0) + 1 AS next FROM queue_entries WHERE clinic_id = ? AND queue_date = ?', [
        ctx.clinicId,
        entry.queue_date,
      ])?.next ?? 1000000,
    );
    run(db, 'UPDATE queue_entries SET serial_no = ? WHERE id = ?', [tempSerial, entry.id]);
    run(db, 'UPDATE queue_entries SET serial_no = ?, updated_at = ? WHERE id = ?', [entry.serial_no, nowIso(), neighbour.id]);
    run(db, 'UPDATE queue_entries SET serial_no = ?, updated_at = ? WHERE id = ?', [neighbour.serial_no, nowIso(), entry.id]);
    return { moved: true, serialNo: neighbour.serial_no };
  });
}

export function queueSummary(db, ctx, { from, to }) {
  const rows = all(
    db,
    `SELECT queue_date,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waiting,
            SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
       FROM queue_entries
      WHERE clinic_id = ? AND queue_date BETWEEN ? AND ?
      GROUP BY queue_date ORDER BY queue_date DESC`,
    [ctx.clinicId, from, to],
  );
  return rows.map((row) => ({
    date: row.queue_date,
    total: Number(row.total),
    completed: Number(row.completed),
    waiting: Number(row.waiting),
    skipped: Number(row.skipped),
  }));
}

/** Used by the appointment slip and the queue ticket printouts. */
export function queueTicketData(db, ctx, entryId) {
  const row = get(db, `${QUEUE_SELECT} WHERE q.id = ? AND q.clinic_id = ?`, [entryId, ctx.clinicId]);
  if (!row) throw new NotFoundError('queue_entry', entryId);
  const ahead = Number(
    get(
      db,
      `SELECT COUNT(*) AS c FROM queue_entries
        WHERE clinic_id = ? AND queue_date = ? AND status IN ('waiting','called') AND serial_no < ?`,
      [ctx.clinicId, row.queue_date, row.serial_no],
    )?.c ?? 0,
  );
  return { entry: shapeQueueEntry(row), ahead };
}
