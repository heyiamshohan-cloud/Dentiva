/**
 * Appointments (§ 30), appointment types and the calendar data feed (§ 32).
 *
 * Double booking is prevented unless the clinic explicitly allows it, working
 * hours and working days are respected, and every status transition is audited.
 */
import { all, get, run, withTransaction, nowIso } from '../db/connection.js';
import { resolvePaging } from '../db/query.js';
import { assertValid } from '../domain/validation.js';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors.js';
import { APPOINTMENT_ACTIVE_STATUSES, APPOINTMENT_STATUSES } from '../../shared/constants.js';
import {
  addMinutesToTime,
  isValidIsoTime,
  minutesBetweenTimes,
  timeRangesOverlap,
  todayIso,
  toIsoDate,
} from '../domain/dates.js';
import { getSettings } from './settings.js';
import { nextNumber } from './numbering.js';
import { recordAudit } from './audit.js';
import { indexAppointment } from './search.js';

export const appointmentSchema = {
  patient_id: { type: 'id', required: true },
  practitioner_id: { type: 'id', nullable: true },
  appt_date: { type: 'date', required: true, default: () => todayIso() },
  start_time: { type: 'time', required: true },
  duration_minutes: { type: 'int', min: 5, max: 480, nullable: true },
  end_time: { type: 'time', nullable: true },
  type_id: { type: 'id', nullable: true },
  type_label: { type: 'string', maxLength: 120, nullable: true },
  reason: { type: 'text', maxLength: 1000, nullable: true },
  notes: { type: 'text', maxLength: 2000, nullable: true },
  status: { type: 'enum', values: APPOINTMENT_STATUSES, default: 'scheduled' },
  reminder_at: { type: 'text', maxLength: 30, nullable: true },
  serial_no: { type: 'int', min: 1, nullable: true },
};

/**
 * Public shape of an appointment row.
 * @param {any} row
 * @returns {any}
 */
export function shapeAppointment(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    appointmentCode: row.appointment_code,
    patientId: Number(row.patient_id),
    patientName: row.patient_name ?? null,
    patientCode: row.patient_code ?? null,
    patientPhone: row.patient_phone ?? null,
    practitionerId: row.practitioner_id ?? null,
    practitionerName: row.practitioner_name ?? null,
    practitionerColor: row.practitioner_color ?? null,
    typeId: row.type_id ?? null,
    typeLabel: row.type_label ?? null,
    typeColor: row.type_color ?? null,
    apptDate: row.appt_date,
    startTime: row.start_time,
    endTime: row.end_time,
    durationMinutes: Number(row.duration_minutes),
    reason: row.reason,
    notes: row.notes,
    status: row.status,
    serialNo: row.serial_no === null || row.serial_no === undefined ? null : Number(row.serial_no),
    reminderAt: row.reminder_at,
    reminderSent: Boolean(row.reminder_sent),
    visitId: row.visit_id ?? null,
    cancelReason: row.cancel_reason,
    checkedInAt: row.checked_in_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    rescheduledFrom: row.rescheduled_from ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const APPOINTMENT_SELECT = `
  SELECT a.*, p.full_name AS patient_name, p.patient_code, p.phone AS patient_phone,
         s.full_name AS practitioner_name, s.color AS practitioner_color, t.color AS type_color
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    LEFT JOIN staff s ON s.id = a.practitioner_id
    LEFT JOIN appointment_types t ON t.id = a.type_id`;

export function listAppointments(db, ctx, params = {}) {
  const where = ['a.clinic_id = ?', 'a.deleted_at IS NULL'];
  const args = [ctx.clinicId];
  if (params.patientId) {
    where.push('a.patient_id = ?');
    args.push(Number(params.patientId));
  }
  if (params.practitionerId) {
    where.push('a.practitioner_id = ?');
    args.push(Number(params.practitionerId));
  }
  if (params.date) {
    where.push('a.appt_date = ?');
    args.push(params.date);
  }
  if (params.from) {
    where.push('a.appt_date >= ?');
    args.push(params.from);
  }
  if (params.to) {
    where.push('a.appt_date <= ?');
    args.push(params.to);
  }
  if (params.status) {
    const statuses = String(params.status).split(',').filter((status) => APPOINTMENT_STATUSES.includes(status));
    if (statuses.length) {
      where.push(`a.status IN (${statuses.map(() => '?').join(',')})`);
      args.push(...statuses);
    }
  }
  if (params.upcoming === true || params.upcoming === 'true') {
    where.push('a.appt_date >= ? AND a.status IN (\'scheduled\',\'checked_in\',\'waiting\',\'in_treatment\')');
    args.push(todayIso());
  }
  if (params.search) {
    where.push("(p.full_name LIKE ? ESCAPE '\\' OR p.patient_code LIKE ? ESCAPE '\\' OR a.appointment_code LIKE ? ESCAPE '\\' OR p.phone LIKE ? ESCAPE '\\')");
    const pattern = `%${String(params.search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(pattern, pattern, pattern, pattern);
  }
  const page = resolvePaging(params);
  const whereSql = where.join(' AND ');
  const total = Number(
    get(db, `SELECT COUNT(*) AS c FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE ${whereSql}`, args)?.c ?? 0,
  );
  const rows = all(
    db,
    `${APPOINTMENT_SELECT} WHERE ${whereSql} ORDER BY a.appt_date ${params.order === 'asc' ? 'ASC' : 'DESC'}, a.start_time ASC, a.serial_no ASC LIMIT ? OFFSET ?`,
    [...args, page.pageSize, page.offset],
  );
  return {
    rows: rows.map(shapeAppointment),
    total,
    page: page.page,
    pageSize: page.pageSize,
    pages: Math.max(1, Math.ceil(total / page.pageSize)),
  };
}

/** Single appointment with its joined patient/staff/type labels. */
export function getAppointment(db, ctx, appointmentId) {
  const row = get(db, `${APPOINTMENT_SELECT} WHERE a.id = ? AND a.clinic_id = ? AND a.deleted_at IS NULL`, [
    appointmentId,
    ctx.clinicId,
  ]);
  if (!row) throw new NotFoundError('appointment', appointmentId);
  const queue = get(db, 'SELECT id, serial_no, status FROM queue_entries WHERE appointment_id = ? ORDER BY id DESC LIMIT 1', [row.id]);
  return {
    ...shapeAppointment(row),
    queueEntryId: queue?.id ?? null,
    queueSerialNo: queue?.serial_no ?? null,
    queueStatus: queue?.status ?? null,
  };
}

function resolveDuration(db, ctx, values) {
  const settings = getSettings(db, ctx.clinicId);
  if (values.duration_minutes) return values.duration_minutes;
  if (values.type_id) {
    const type = get(db, 'SELECT duration_minutes FROM appointment_types WHERE id = ? AND clinic_id = ?', [values.type_id, ctx.clinicId]);
    if (type) return Number(type.duration_minutes);
  }
  return Number(settings['appointments.defaultDuration'] ?? 30);
}

/**
 * Detect a clash with another active appointment for the same practitioner.
 * @returns {any|null} the conflicting appointment
 */
/**
 * @param {any} db
 * @param {any} ctx
 * @param {{ practitionerId?: number|null, date: string, startTime: string, endTime: string, excludeId?: number|null }} input
 */
export function findConflict(db, ctx, { practitionerId, date, startTime, endTime, excludeId = null }) {
  if (!practitionerId) return null;
  const rows = all(
    db,
    `SELECT id, appointment_code, start_time, end_time, patient_id FROM appointments
      WHERE clinic_id = ? AND practitioner_id = ? AND appt_date = ? AND deleted_at IS NULL
        AND status IN ('scheduled','checked_in','waiting','in_treatment')
        ${excludeId ? 'AND id <> ?' : ''}`,
    excludeId ? [ctx.clinicId, practitionerId, date, excludeId] : [ctx.clinicId, practitionerId, date],
  );
  for (const row of rows) {
    if (timeRangesOverlap(startTime, endTime, row.start_time, row.end_time)) return row;
  }
  return null;
}

export function createAppointment(db, ctx, input) {
  const values = assertValid(input, appointmentSchema);
  if (!isValidIsoTime(values.start_time)) {
    throw new ValidationError('validation.failed', [{ field: 'start_time', key: 'validation.time' }]);
  }
  const patient = get(db, 'SELECT id, patient_code, full_name FROM patients WHERE id = ? AND clinic_id = ?', [
    values.patient_id,
    ctx.clinicId,
  ]);
  if (!patient) throw new NotFoundError('patient', values.patient_id);
  const settings = getSettings(db, ctx.clinicId);

  const duration = resolveDuration(db, ctx, values);
  const endTime = values.end_time ?? addMinutesToTime(values.start_time, duration);
  if (!settings['appointments.allowDoubleBooking']) {
    const conflict = findConflict(db, ctx, {
      practitionerId: values.practitioner_id,
      date: values.appt_date,
      startTime: values.start_time,
      endTime,
    });
    if (conflict) {
      throw new ConflictError('appointments.doubleBooking', {
        appointmentCode: conflict.appointment_code,
        startTime: conflict.start_time,
        endTime: conflict.end_time,
      });
    }
  }

  return withTransaction(db, () => {
    const allocation = nextNumber(db, ctx.clinicId, 'appointment');
    let serial = values.serial_no ?? null;
    if (serial === null) {
      const maxSerial = get(
        db,
        'SELECT COALESCE(MAX(serial_no), 0) AS c FROM appointments WHERE clinic_id = ? AND appt_date = ?',
        [ctx.clinicId, values.appt_date],
      );
      serial = Number(maxSerial?.c ?? 0) + 1;
    }
    let typeLabel = values.type_label ?? null;
    if (!typeLabel && values.type_id) {
      const type = get(db, 'SELECT name_en FROM appointment_types WHERE id = ?', [values.type_id]);
      typeLabel = type?.name_en ?? null;
    }
    const reminder = values.reminder_at ?? null;
    const result = run(
      db,
      `INSERT INTO appointments
        (clinic_id, patient_id, practitioner_id, appointment_code, type_id, type_label, appt_date, start_time, end_time,
         duration_minutes, reason, notes, status, serial_no, reminder_at, created_by, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ctx.clinicId,
        values.patient_id,
        values.practitioner_id ?? null,
        allocation.code,
        values.type_id ?? null,
        typeLabel,
        values.appt_date,
        values.start_time,
        endTime,
        duration,
        values.reason ?? null,
        values.notes ?? null,
        values.status,
        serial,
        reminder,
        ctx.user?.id ?? null,
        ctx.user?.id ?? null,
      ],
    );
    const appointmentId = Number(result.lastInsertRowid);
    indexAppointment(db, appointmentId);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'create',
      module: 'appointments',
      entity: 'appointment',
      entityId: appointmentId,
      summary: `Appointment ${allocation.code} booked for ${patient.patient_code} on ${values.appt_date} ${values.start_time}`,
      severity: 'info',
      after: { date: values.appt_date, start: values.start_time, end: endTime, serial },
      ip: ctx.ip,
    });
    return { id: appointmentId, appointmentCode: allocation.code, serialNo: serial, endTime, durationMinutes: duration };
  });
}

export function updateAppointment(db, ctx, appointmentId, input) {
  const before = get(db, 'SELECT * FROM appointments WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [
    appointmentId,
    ctx.clinicId,
  ]);
  if (!before) throw new NotFoundError('appointment', appointmentId);
  const values = assertValid(input, appointmentSchema, { partial: true });
  const settings = getSettings(db, ctx.clinicId);

  const date = values.appt_date ?? before.appt_date;
  const startTime = values.start_time ?? before.start_time;
  const duration = values.duration_minutes ?? before.duration_minutes;
  const endTime = values.end_time ?? addMinutesToTime(startTime, duration) ?? before.end_time;
  const practitionerId = values.practitioner_id !== undefined ? values.practitioner_id : before.practitioner_id;

  if (!settings['appointments.allowDoubleBooking'] && APPOINTMENT_ACTIVE_STATUSES.includes(values.status ?? before.status)) {
    const conflict = findConflict(db, ctx, { practitionerId, date, startTime, endTime, excludeId: appointmentId });
    if (conflict) {
      throw new ConflictError('appointments.doubleBooking', {
        appointmentCode: conflict.appointment_code,
        startTime: conflict.start_time,
        endTime: conflict.end_time,
      });
    }
  }

  return withTransaction(db, () => {
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(values)) {
      sets.push(`${key} = ?`);
      params.push(value);
    }
    sets.push('end_time = ?', 'updated_by = ?', 'updated_at = ?');
    params.push(endTime, ctx.user?.id ?? null, nowIso(), appointmentId);
    if (values.status === 'checked_in' && !before.checked_in_at) {
      sets.push('checked_in_at = ?');
      params.push(nowIso());
    }
    if (values.status === 'in_treatment' && !before.started_at) {
      sets.push('started_at = ?');
      params.push(nowIso());
    }
    if (values.status === 'completed' && !before.completed_at) {
      sets.push('completed_at = ?');
      params.push(nowIso());
    }
    if (values.status === 'cancelled') {
      sets.push('cancelled_at = ?', 'cancel_reason = ?');
      params.push(nowIso(), input.cancel_reason ?? values.reason ?? before.cancel_reason ?? null);
    }
    run(db, `UPDATE appointments SET ${sets.join(', ')} WHERE id = ?`, params);
    indexAppointment(db, appointmentId);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'update',
      module: 'appointments',
      entity: 'appointment',
      entityId: appointmentId,
      summary: `Appointment ${before.appointment_code} updated`,
      severity: 'info',
      before: { date: before.appt_date, start: before.start_time, status: before.status },
      after: { date, start: startTime, status: values.status ?? before.status },
    });
    return shapeAppointment(get(db, `${APPOINTMENT_SELECT} WHERE a.id = ?`, [appointmentId]));
  });
}

/** Status changes coming from the queue board and the appointment list. */
export function setAppointmentStatus(db, ctx, appointmentId, status, { reason = null, visitId = null } = {}) {
  if (!APPOINTMENT_STATUSES.includes(status)) {
    throw new ValidationError('validation.failed', [{ field: 'status', key: 'validation.option' }]);
  }
  const before = get(db, 'SELECT * FROM appointments WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [
    appointmentId,
    ctx.clinicId,
  ]);
  if (!before) throw new NotFoundError('appointment', appointmentId);
  const sets = ['status = ?', 'updated_by = ?', 'updated_at = ?'];
  const params = [status, ctx.user?.id ?? null, nowIso()];
  if (status === 'checked_in') {
    sets.push('checked_in_at = ?');
    params.push(nowIso());
  }
  if (status === 'in_treatment') {
    sets.push('started_at = ?');
    params.push(nowIso());
  }
  if (status === 'completed') {
    sets.push('completed_at = ?');
    params.push(nowIso());
  }
  if (status === 'cancelled') {
    sets.push('cancelled_at = ?', 'cancel_reason = ?');
    params.push(nowIso(), reason);
  }
  if (visitId) {
    sets.push('visit_id = ?');
    params.push(visitId);
  }
  run(db, `UPDATE appointments SET ${sets.join(', ')} WHERE id = ?`, [...params, appointmentId]);
  if (before.visit_id && ['checked_in', 'waiting', 'in_treatment', 'completed'].includes(status)) {
    run(db, `UPDATE queue_entries SET status = ? WHERE appointment_id = ? AND status NOT IN ('completed','cancelled')`, [
      status === 'in_treatment' ? 'in_treatment' : status === 'completed' ? 'completed' : 'waiting',
      appointmentId,
    ]);
  }
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'status_change',
    module: 'appointments',
    entity: 'appointment',
    entityId: appointmentId,
    summary: `Appointment ${before.appointment_code}: ${before.status} → ${status}${reason ? ` (${reason})` : ''}`,
    severity: status === 'no_show' || status === 'cancelled' ? 'notice' : 'info',
    before: { status: before.status },
    after: { status },
  });
  return shapeAppointment(get(db, `${APPOINTMENT_SELECT} WHERE a.id = ?`, [appointmentId]));
}

/**
 * Reschedule: the original appointment is marked `rescheduled` (history kept)
 * and a fresh appointment is created for the new slot.
 */
/**
 * @param {any} db
 * @param {any} ctx
 * @param {number} appointmentId
 * @param {{ appt_date: string, start_time: string, duration_minutes?: number|null, reason?: string|null }} input
 */
export function rescheduleAppointment(db, ctx, appointmentId, { appt_date, start_time, duration_minutes, reason = null }) {
  const before = get(db, 'SELECT * FROM appointments WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [
    appointmentId,
    ctx.clinicId,
  ]);
  if (!before) throw new NotFoundError('appointment', appointmentId);
  return withTransaction(db, () => {
    const created = createAppointment(db, ctx, {
      patient_id: before.patient_id,
      practitioner_id: before.practitioner_id,
      appt_date,
      start_time,
      duration_minutes: duration_minutes ?? before.duration_minutes,
      type_id: before.type_id,
      type_label: before.type_label,
      reason: reason ?? before.reason,
      notes: before.notes,
      status: 'scheduled',
    });
    run(db, 'UPDATE appointments SET status = \'rescheduled\', rescheduled_from = NULL, updated_at = ? WHERE id = ?', [
      nowIso(),
      appointmentId,
    ]);
    run(db, 'UPDATE appointments SET rescheduled_from = ? WHERE id = ?', [appointmentId, created.id]);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'reschedule',
      module: 'appointments',
      entity: 'appointment',
      entityId: appointmentId,
      summary: `Appointment ${before.appointment_code} rescheduled to ${appt_date} ${start_time}`,
      severity: 'notice',
      before: { date: before.appt_date, start: before.start_time },
      after: { date: appt_date, start: start_time, newCode: created.appointmentCode },
    });
    return getAppointment(db, ctx, created.id);
  });
}

/**
 * @param {any} db
 * @param {any} ctx
 * @param {number} appointmentId
 * @param {string|null} [reason]
 */
export function deleteAppointment(db, ctx, appointmentId, reason = null) {
  const appointment = get(db, 'SELECT * FROM appointments WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [
    appointmentId,
    ctx.clinicId,
  ]);
  if (!appointment) throw new NotFoundError('appointment', appointmentId);
  if (appointment.visit_id) {
    throw new ValidationError('validation.failed', [{ field: 'id', key: 'appointments.hasVisitCannotDelete' }]);
  }
  run(db, 'UPDATE appointments SET deleted_at = ?, status = \'cancelled\', cancel_reason = ?, updated_at = ? WHERE id = ?', [
    nowIso(),
    reason,
    nowIso(),
    appointmentId,
  ]);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'delete',
    module: 'appointments',
    entity: 'appointment',
    entityId: appointmentId,
    summary: `Appointment ${appointment.appointment_code} deleted${reason ? `: ${reason}` : ''}`,
    severity: 'warning',
  });
  return { deleted: true };
}

/**
 * Calendar feed for day / week / month / list views (§ 32).
 * @param {any} db
 * @param {any} ctx
 * @param {{ from: string, to: string, practitionerId?: number|null, statuses?: string[]|null }} input
 */
export function calendarFeed(db, ctx, { from, to, practitionerId = null, statuses = null }) {
  const where = ['a.clinic_id = ?', 'a.deleted_at IS NULL', 'a.appt_date >= ?', 'a.appt_date <= ?'];
  const args = [ctx.clinicId, from, to];
  if (practitionerId) {
    where.push('a.practitioner_id = ?');
    args.push(Number(practitionerId));
  }
  if (statuses?.length) {
    where.push(`a.status IN (${statuses.map(() => '?').join(',')})`);
    args.push(...statuses);
  }
  const rows = all(db, `${APPOINTMENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.appt_date, a.start_time`, args);
  const grouped = {};
  for (const row of rows) {
    const shaped = shapeAppointment(row);
    if (!grouped[shaped.apptDate]) grouped[shaped.apptDate] = [];
    grouped[shaped.apptDate].push(shaped);
  }
  return { from, to, days: grouped, total: rows.length };
}

/**
 * @param {any} db
 * @param {any} ctx
 * @param {string} [date]
 * @param {{ practitionerId?: number|null }} [options]
 */
export function dayAgenda(db, ctx, date = todayIso(), { practitionerId = null } = {}) {
  const appointments = listAppointments(db, ctx, { date, practitionerId, pageSize: 200, order: 'asc' });
  const counts = { scheduled: 0, checked_in: 0, waiting: 0, in_treatment: 0, completed: 0, cancelled: 0, no_show: 0, rescheduled: 0 };
  for (const row of appointments.rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  const busyMinutes = appointments.rows
    .filter((row) => ['completed', 'in_treatment', 'waiting', 'checked_in', 'scheduled'].includes(row.status))
    .reduce((sum, row) => sum + (minutesBetweenTimes(row.startTime, row.endTime) || row.durationMinutes), 0);
  return { date, appointments: appointments.rows, counts, total: appointments.total, busyMinutes };
}

/* ------------------------------------------------------- appointment types */

export const appointmentTypeSchema = {
  name_en: { type: 'string', required: true, maxLength: 120 },
  name_bn: { type: 'string', maxLength: 120, nullable: true },
  color: { type: 'string', maxLength: 16, default: '#0f6f9a' },
  duration_minutes: { type: 'int', min: 5, max: 480, default: 30 },
  is_active: { type: 'boolean', default: true },
  sort_order: { type: 'int', default: 0 },
};

export function listAppointmentTypes(db, ctx, { includeInactive = false } = {}) {
  return all(
    db,
    `SELECT * FROM appointment_types WHERE clinic_id = ? AND deleted_at IS NULL ${includeInactive ? '' : 'AND is_active = 1'}
      ORDER BY sort_order, name_en`,
    [ctx.clinicId],
  ).map((row) => ({
    id: Number(row.id),
    nameEn: row.name_en,
    nameBn: row.name_bn,
    color: row.color,
    durationMinutes: Number(row.duration_minutes),
    isActive: Boolean(row.is_active),
  }));
}

export function saveAppointmentType(db, ctx, typeId, input) {
  const values = assertValid(input, typeId ? appointmentTypeSchema : appointmentTypeSchema, { partial: Boolean(typeId) });
  if (typeId) {
    const before = get(db, 'SELECT * FROM appointment_types WHERE id = ? AND clinic_id = ?', [typeId, ctx.clinicId]);
    if (!before) throw new NotFoundError('appointment_type', typeId);
    const columns = Object.keys(values);
    if (columns.length) {
      run(db, `UPDATE appointment_types SET ${columns.map((col) => `${col} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [
        ...columns.map((col) => (typeof values[col] === 'boolean' ? (values[col] ? 1 : 0) : values[col])),
        nowIso(),
        typeId,
      ]);
    }
    return { id: typeId };
  }
  const result = run(
    db,
    `INSERT INTO appointment_types (clinic_id, name_en, name_bn, color, duration_minutes, is_active, sort_order)
     VALUES (?,?,?,?,?,?,?)`,
    [
      ctx.clinicId,
      values.name_en,
      values.name_bn ?? null,
      values.color,
      values.duration_minutes,
      values.is_active ? 1 : 0,
      values.sort_order,
    ],
  );
  return { id: Number(result.lastInsertRowid) };
}

export function deleteAppointmentType(db, ctx, typeId) {
  const type = get(db, 'SELECT * FROM appointment_types WHERE id = ? AND clinic_id = ?', [typeId, ctx.clinicId]);
  if (!type) throw new NotFoundError('appointment_type', typeId);
  run(db, 'UPDATE appointment_types SET deleted_at = ?, is_active = 0, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), typeId]);
  return { deleted: true };
}

export { minutesBetweenTimes };
