/**
 * Scheduling integration tests (§ 29, § 30, § 31, § 32): appointments,
 * double-booking protection, rescheduling, calendar feeds and the daily serial
 * queue with its appointment status sync.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { createTestEnv } from '../helpers/testEnv.js';
import { createPatient } from '../../src/server/services/patients.js';
import {
  appointmentTypeSchema,
  calendarFeed,
  createAppointment,
  dayAgenda,
  deleteAppointment,
  findConflict,
  getAppointment,
  listAppointmentTypes,
  listAppointments,
  rescheduleAppointment,
  saveAppointmentType,
  setAppointmentStatus,
  updateAppointment,
} from '../../src/server/services/appointments.js';
import {
  callEntry,
  checkIn,
  completeEntry,
  listQueue,
  moveEntry,
  queueSummary,
  queueTicketData,
  setPriority,
  skipEntry,
  startEntry,
} from '../../src/server/services/queue.js';
import { ConflictError, NotFoundError, ValidationError } from '../../src/shared/errors.js';
import { getSettings, setSettings } from '../../src/server/services/settings.js';
import { addDays, todayIso } from '../../src/server/domain/dates.js';

let env;
afterEach(() => env?.cleanup());

function setup() {
  env = createTestEnv();
  const ctx = { clinicId: env.clinicId, user: { id: env.admin.id, displayName: 'Admin' }, ip: '127.0.0.1' };
  return { env, ctx };
}

let phoneSeq = 0;
const patient = (e, ctx, name = 'Scheduling Patient') => {
  phoneSeq += 1;
  return createPatient(e.db, ctx, { full_name: name, gender: 'female', phone: `018${String(10000000 + phoneSeq).slice(-8)}` });
};

describe('appointments', () => {
  test('books an appointment with type duration, serial and computed end time', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Booked Patient');
    const types = listAppointmentTypes(e.db, ctx);
    expect(types.length).toBe(5);
    const consultation = types.find((type) => type.durationMinutes === 30);

    const booked = createAppointment(e.db, ctx, {
      patient_id: p.id,
      practitioner_id: e.practitionerId,
      appt_date: todayIso(),
      start_time: '10:00',
      type_id: consultation?.id,
      reason: 'Toothache',
    });
    expect(booked.appointmentCode).toMatch(/^APT-/);
    expect(booked.endTime).toBe('10:30');
    expect(booked.durationMinutes).toBe(30);
    expect(booked.serialNo).toBe(1);

    const second = createAppointment(e.db, ctx, { patient_id: p.id, appt_date: todayIso(), start_time: '12:00' });
    expect(second.serialNo).toBe(2);

    const detail = getAppointment(e.db, ctx, booked.id);
    expect(detail.patientName).toBe('Booked Patient');
    expect(detail.typeLabel).toBe('Consultation');
    expect(detail.status).toBe('scheduled');
  });

  test('blocks double booking for the same practitioner but allows parallel slots otherwise', () => {
    const { env: e, ctx } = setup();
    const a = patient(e, ctx, 'Double A');
    const b = patient(e, ctx, 'Double B');
    createAppointment(e.db, ctx, { patient_id: a.id, practitioner_id: e.practitionerId, appt_date: todayIso(), start_time: '11:00', duration_minutes: 30 });
    expect(() =>
      createAppointment(e.db, ctx, { patient_id: b.id, practitioner_id: e.practitionerId, appt_date: todayIso(), start_time: '11:15', duration_minutes: 30 }),
    ).toThrow(ConflictError);

    const conflict = findConflict(e.db, ctx, {
      practitionerId: e.practitionerId,
      date: todayIso(),
      startTime: '11:15',
      endTime: '11:45',
    });
    expect(conflict).not.toBe(null);

    // Back-to-back is fine, and another practitioner is free at the same time.
    createAppointment(e.db, ctx, { patient_id: b.id, practitioner_id: e.practitionerId, appt_date: todayIso(), start_time: '11:30', duration_minutes: 30 });
    createAppointment(e.db, ctx, { patient_id: b.id, practitioner_id: null, appt_date: todayIso(), start_time: '11:15', duration_minutes: 30 });

    // The clinic can explicitly allow overlapping appointments.
    setSettings(e.db, e.clinicId, { 'appointments.allowDoubleBooking': true }, e.admin.id);
    expect(getSettings(e.db, e.clinicId)['appointments.allowDoubleBooking']).toBe(true);
    createAppointment(e.db, ctx, { patient_id: a.id, practitioner_id: e.practitionerId, appt_date: todayIso(), start_time: '11:15', duration_minutes: 30 });
    expect(listAppointments(e.db, ctx, { date: todayIso() }).total).toBe(4);
  });

  test('validates times, dates and unknown patients', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Invalid Appointment');
    expect(() => createAppointment(e.db, ctx, { patient_id: p.id, appt_date: todayIso(), start_time: '25:00' })).toThrow(ValidationError);
    expect(() => createAppointment(e.db, ctx, { patient_id: p.id, appt_date: '2026-02-30', start_time: '10:00' })).toThrow(ValidationError);
    expect(() => createAppointment(e.db, ctx, { patient_id: 999999, appt_date: todayIso(), start_time: '10:00' })).toThrow(NotFoundError);
    expect(() => createAppointment(e.db, ctx, { patient_id: p.id, appt_date: todayIso() })).toThrow(ValidationError);
  });

  test('rescheduling keeps an audit trail and links the replacement', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Reschedule Patient');
    const original = createAppointment(e.db, ctx, { patient_id: p.id, practitioner_id: e.practitionerId, appt_date: todayIso(), start_time: '09:00' });
    const moved = rescheduleAppointment(e.db, ctx, original.id, {
      appt_date: addDays(todayIso(), 2) ?? todayIso(),
      start_time: '15:00',
      reason: 'Patient request',
    });
    expect(moved.id).not.toBe(original.id);
    expect(moved.apptDate).toBe(addDays(todayIso(), 2) ?? todayIso());
    const old = getAppointment(e.db, ctx, original.id);
    expect(old.status).toBe('rescheduled');
    expect(moved.rescheduledFrom).toBe(original.id);
  });

  test('status changes drive the calendar and the day agenda', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Status Patient');
    const booked = createAppointment(e.db, ctx, { patient_id: p.id, practitioner_id: e.practitionerId, appt_date: todayIso(), start_time: '13:00' });
    setAppointmentStatus(e.db, ctx, booked.id, 'checked_in');
    expect(getAppointment(e.db, ctx, booked.id).status).toBe('checked_in');
    setAppointmentStatus(e.db, ctx, booked.id, 'completed');
    expect(getAppointment(e.db, ctx, booked.id).completedAt).toBeTruthy();

    const feed = calendarFeed(e.db, ctx, { from: todayIso(), to: addDays(todayIso(), 7) ?? todayIso() });
    expect(feed.total).toBe(1);
    expect(feed.days[todayIso()].length).toBe(1);
    const agenda = dayAgenda(e.db, ctx, todayIso());
    expect(agenda.appointments.length).toBe(1);
    expect(agenda.appointments[0].startTime).toBe('13:00');

    deleteAppointment(e.db, ctx, booked.id, 'Cancelled by patient');
    expect(() => getAppointment(e.db, ctx, booked.id)).toThrow(NotFoundError);
    expect(listAppointments(e.db, ctx, { date: todayIso() }).total).toBe(0);
    expect(dayAgenda(e.db, ctx, todayIso()).appointments.length).toBe(0);
  });

  test('appointment types are configurable', () => {
    const { env: e, ctx } = setup();
    const created = saveAppointmentType(e.db, ctx, null, { name_en: 'Orthodontic adjustment', name_bn: 'অর্থোডন্টিক', duration_minutes: 20, color: '#123456' });
    const list = listAppointmentTypes(e.db, ctx);
    expect(list.length).toBe(6);
    const saved = list.find((type) => type.id === created.id);
    expect(saved?.durationMinutes).toBe(20);
    expect(saved?.color).toBe('#123456');
    saveAppointmentType(e.db, ctx, created.id, { is_active: false });
    expect(listAppointmentTypes(e.db, ctx).length).toBe(5);
    expect(listAppointmentTypes(e.db, ctx, { includeInactive: true }).length).toBe(6);
    expect(appointmentTypeSchema.duration_minutes.max).toBe(480);
  });
});

describe('patient queue', () => {
  test('allocates daily serial numbers and prevents duplicate check-ins', () => {
    const { env: e, ctx } = setup();
    const a = patient(e, ctx, 'Queue A');
    const b = patient(e, ctx, 'Queue B');
    const first = checkIn(e.db, ctx, { patientId: a.id });
    const second = checkIn(e.db, ctx, { patientId: b.id });
    expect(first.serialNo).toBe(1);
    expect(second.serialNo).toBe(2);

    const repeat = checkIn(e.db, ctx, { patientId: a.id });
    expect(repeat.alreadyCheckedIn).toBe(true);
    expect(repeat.serialNo).toBe(1);

    // A new day restarts the serial sequence.
    const tomorrow = addDays(todayIso(), 1) ?? todayIso();
    const tomorrowEntry = checkIn(e.db, ctx, { patientId: a.id, date: tomorrow });
    expect(tomorrowEntry.serialNo).toBe(1);
  });

  test('queue transitions follow the appointment lifecycle', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Queue Lifecycle');
    const booked = createAppointment(e.db, ctx, { patient_id: p.id, practitioner_id: e.practitionerId, appt_date: todayIso(), start_time: '14:00' });
    const entry = checkIn(e.db, ctx, { appointmentId: booked.id });
    expect(getAppointment(e.db, ctx, booked.id).status).toBe('checked_in');

    callEntry(e.db, ctx, entry.id);
    expect(listQueue(e.db, ctx, {}).current.serialNo).toBe(entry.serialNo);
    startEntry(e.db, ctx, entry.id);
    expect(getAppointment(e.db, ctx, booked.id).status).toBe('in_treatment');
    completeEntry(e.db, ctx, entry.id, { note: 'Done' });
    expect(getAppointment(e.db, ctx, booked.id).status).toBe('completed');

    const queue = listQueue(e.db, ctx, {});
    expect(queue.stats.completed).toBe(1);
    expect(queue.stats.waiting).toBe(0);
    const ticket = queueTicketData(e.db, ctx, entry.id);
    expect(ticket.entry.serialNo).toBe(entry.serialNo);
    expect(ticket.ahead).toBe(0);
  });

  test('skipping, priority and manual ordering behave predictably', () => {
    const { env: e, ctx } = setup();
    const a = patient(e, ctx, 'Order A');
    const b = patient(e, ctx, 'Order B');
    const c = patient(e, ctx, 'Order C');
    const first = checkIn(e.db, ctx, { patientId: a.id });
    const second = checkIn(e.db, ctx, { patientId: b.id });
    const third = checkIn(e.db, ctx, { patientId: c.id });

    // Priority entries are served first regardless of their serial.
    setPriority(e.db, ctx, third.id, 5);
    expect(listQueue(e.db, ctx, {}).entries[0].id).toBe(third.id);
    setPriority(e.db, ctx, third.id, 0);

    skipEntry(e.db, ctx, second.id, 'Patient stepped out');
    expect(listQueue(e.db, ctx, {}).stats.skipped).toBe(1);

    // Moving up swaps serials with the entry ahead of it.
    const moved = moveEntry(e.db, ctx, third.id, 'up');
    expect(moved.moved).toBe(true);
    expect(moved.serialNo).toBe(first.serialNo);
    expect(listQueue(e.db, ctx, {}).entries[0].id).toBe(third.id);
    expect(moveEntry(e.db, ctx, third.id, 'up').moved).toBe(false);

    const summary = queueSummary(e.db, ctx, { from: todayIso(), to: todayIso() });
    expect(summary[0].total).toBe(3);
    expect(listQueue(e.db, ctx, { includeFinished: false }).entries.length).toBe(2);
    expect(first.serialNo).toBeLessThan(second.serialNo);
  });

  test('walk-ins without a patient are refused', () => {
    const { env: e, ctx } = setup();
    expect(() => checkIn(e.db, ctx, {})).toThrow(ValidationError);
    expect(() => checkIn(e.db, ctx, { patientId: 999999 })).toThrow(NotFoundError);
  });
});
