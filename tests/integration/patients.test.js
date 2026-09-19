/**
 * Patient service integration tests (§ 88): registration, mandatory gender,
 * duplicate protection, configurable codes, search/filter/sort, statistics,
 * notes, archiving/restore and the permanent-delete guard.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { createTestEnv } from '../helpers/testEnv.js';
import {
  addNote,
  archivePatient,
  createPatient,
  deletePatientPermanently,
  findPotentialDuplicates,
  getPatientDetail,
  listPatients,
  patientStats,
  patientTimeline,
  restorePatient,
  saveMedicalRecord,
  updatePatient,
} from '../../src/server/services/patients.js';
import { getSettings, setSettings } from '../../src/server/services/settings.js';
import { globalSearch } from '../../src/server/services/search.js';
import { ValidationError, ConflictError } from '../../src/shared/errors.js';

let env;
const ctxFor = (environment) => ({ clinicId: environment.clinicId, user: { id: environment.admin.id, displayName: 'Admin' }, ip: '127.0.0.1' });

afterEach(() => env?.cleanup());
function setup() {
  env = createTestEnv();
  return env;
}

describe('patient registration', () => {
  test('creates a patient with a configurable code and gender stored as a structured field', () => {
    const e = setup();
    const created = createPatient(e.db, ctxFor(e), {
      full_name: '  Rahim   Uddin ',
      gender: 'male',
      dob: '1991-04-12',
      phone: '01712345678',
      address: '12 Green Road',
      city: 'Dhaka',
    });
    expect(created.patientCode).toBe('DEN-000001');
    const patient = getPatientDetail(e.db, ctxFor(e), created.id);
    expect(patient.fullName).toBe('Rahim Uddin');
    expect(patient.gender).toBe('male');
    expect(patient.age).toBeGreaterThan(30);
    expect(patient.status).toBe('active');
    expect(patient.patientCode).toBe('DEN-000001');
    expect(patient.outstandingMinor).toBe(0);
    expect(patient.totalVisits).toBe(0);
  });

  test('gender is mandatory and validated against the allowed set', () => {
    const e = setup();
    expect(() => createPatient(e.db, ctxFor(e), { full_name: 'No Gender', phone: '0170000000' })).toThrow(ValidationError);
    expect(() => createPatient(e.db, ctxFor(e), { full_name: 'Bad Gender', gender: 'unknown', phone: '0170000001' })).toThrow(
      ValidationError,
    );
  });

  test('patient codes stay unique and honour configured prefix/padding', () => {
    const e = setup();
    setSettings(e.db, e.clinicId, { 'patients.codePrefix': 'DNT', 'patients.codePadding': 4, 'patients.codeIncludeYear': true });
    const first = createPatient(e.db, ctxFor(e), { full_name: 'First Patient', gender: 'female', phone: '01711111111' });
    const second = createPatient(e.db, ctxFor(e), { full_name: 'Second Patient', gender: 'male', phone: '01711111112' });
    const year = new Date().getFullYear();
    expect(first.patientCode).toBe(`DNT-${year}-0001`);
    expect(second.patientCode).toBe(`DNT-${year}-0002`);
    expect(first.patientCode).not.toBe(second.patientCode);
  });

  test('duplicate patients are refused unless explicitly forced', () => {
    const e = setup();
    createPatient(e.db, ctxFor(e), { full_name: 'Karim Ali', gender: 'male', phone: '01812345678' });
    expect(() => createPatient(e.db, ctxFor(e), { full_name: 'Karim Ali', gender: 'male', phone: '01812345678' })).toThrow(
      ConflictError,
    );
    const forced = createPatient(e.db, ctxFor(e), {
      full_name: 'Karim Ali',
      gender: 'male',
      phone: '01812345678',
      forceDuplicate: true,
    });
    expect(forced.id).toBeGreaterThan(0);
    const duplicates = findPotentialDuplicates(e.db, ctxFor(e), { full_name: 'Karim Ali', phone: '01812345678' });
    expect(duplicates.length).toBe(2);
  });

  test('phone is required when the clinic enables that rule', () => {
    const e = setup();
    expect(getSettings(e.db, e.clinicId)['patients.requirePhone']).toBe(true);
    expect(() => createPatient(e.db, ctxFor(e), { full_name: 'No Phone', gender: 'other' })).toThrow(ValidationError);
    setSettings(e.db, e.clinicId, { 'patients.requirePhone': false });
    const created = createPatient(e.db, ctxFor(e), { full_name: 'No Phone', gender: 'other' });
    expect(created.id).toBeGreaterThan(0);
  });

  test('updates are audited and searchable', () => {
    const e = setup();
    const created = createPatient(e.db, ctxFor(e), { full_name: 'Searchable Person', gender: 'female', phone: '01900000000' });
    updatePatient(e.db, ctxFor(e), created.id, { phone: '01900000009', city: 'Chattogram' });
    const results = globalSearch(e.db, e.clinicId, { q: 'searchable' });
    expect(results.groups.length).toBe(1);
    expect(results.groups[0].entity).toBe('patient');
    expect(results.groups[0].items[0].patientCode).toBe('DEN-000001');

    const audit = e.db.query("SELECT * FROM audit_logs WHERE module = 'patients' ORDER BY id").all();
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(audit.some((row) => row.action === 'update' && row.after_json.includes('01900000009'))).toBe(true);
  });
});

describe('patient listing', () => {
  function seed(e, count = 12) {
    const ids = [];
    for (let i = 0; i < count; i += 1) {
      ids.push(
        createPatient(e.db, ctxFor(e), {
          full_name: `Patient ${String.fromCharCode(65 + i)}`,
          gender: i % 2 === 0 ? 'male' : 'female',
          phone: `0170000${String(i).padStart(4, '0')}`,
          city: i % 3 === 0 ? 'Dhaka' : 'Sylhet',
          dob: `19${80 + i}-01-01`,
        }).id,
      );
    }
    return ids;
  }

  test('paginates, searches, filters and sorts', () => {
    const e = setup();
    seed(e, 12);
    const firstPage = listPatients(e.db, ctxFor(e), { page: 1, pageSize: 5, sort: 'name', dir: 'asc' });
    expect(firstPage.rows.length).toBe(5);
    expect(firstPage.total).toBe(12);
    expect(firstPage.pages).toBe(3);
    expect(firstPage.rows[0].fullName).toBe('Patient A');

    const secondPage = listPatients(e.db, ctxFor(e), { page: 2, pageSize: 5, sort: 'name', dir: 'asc' });
    expect(secondPage.rows[0].fullName).not.toBe(firstPage.rows[0].fullName);

    const filtered = listPatients(e.db, ctxFor(e), { gender: 'female' });
    expect(filtered.rows.every((row) => row.gender === 'female')).toBe(true);

    const searched = listPatients(e.db, ctxFor(e), { search: 'Patient C' });
    expect(searched.rows.length).toBe(1);

    const byCity = listPatients(e.db, ctxFor(e), { city: 'Sylhet' });
    expect(byCity.rows.every((row) => row.city === 'Sylhet')).toBe(true);
  });

  test('unsupported sort keys fall back instead of injecting SQL', () => {
    const e = setup();
    seed(e, 3);
    const result = listPatients(e.db, ctxFor(e), { sort: 'name; DROP TABLE patients', dir: 'asc' });
    expect(result.rows.length).toBe(3);
    expect(e.db.query("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'patients'").get().c).toBe(1);
  });
});

describe('medical background, notes, timeline', () => {
  test('medical flags and allergies are stored and surfaced as alerts', () => {
    const e = setup();
    const created = createPatient(e.db, ctxFor(e), { full_name: 'Allergic Patient', gender: 'female', phone: '01611111111' });
    saveMedicalRecord(e.db, ctxFor(e), created.id, {
      allergies: 'Penicillin',
      has_diabetes: true,
      alert_flag: true,
      conditions: 'Type 2 diabetes',
    });
    const patient = getPatientDetail(e.db, ctxFor(e), created.id);
    expect(patient.medical?.allergies).toBe('Penicillin');
    expect(patient.medical?.flags.diabetes).toBe(true);
    expect(patient.alerts.allergy).toBe(true);

    const list = listPatients(e.db, ctxFor(e), { alertsOnly: true });
    expect(list.rows.length).toBe(1);
  });

  test('notes are created, and the timeline reports registration plus the note', async () => {
    const e = setup();
    const created = createPatient(e.db, ctxFor(e), { full_name: 'Timeline Patient', gender: 'male', phone: '01511111111' });
    addNote(e.db, ctxFor(e), created.id, { note: 'Prefers morning appointments', category: 'administrative' });
    const notes = e.db.query('SELECT * FROM patient_notes WHERE patient_id = ?').all(created.id);
    expect(notes.length).toBe(1);
    const timeline = patientTimeline(e.db, ctxFor(e), created.id, { limit: 20 });
    expect(timeline.some((event) => event.event_type === 'registration')).toBe(true);
    expect(timeline.some((event) => event.event_type === 'note')).toBe(true);
  });

  test('visit statistics are derived from visit rows only', () => {
    const e = setup();
    const created = createPatient(e.db, ctxFor(e), { full_name: 'Stats Patient', gender: 'female', phone: '01411111111' });
    const statsBefore = patientStats(e.db, ctxFor(e), created.id);
    expect(statsBefore.visits.total).toBe(0);
    e.db
      .query(
        `INSERT INTO visits (clinic_id, patient_id, visit_code, visit_date, status) VALUES (?,?,?,?,?)`,
      )
      .run(e.clinicId, created.id, 'VS-1', '2026-01-05', 'completed');
    e.db
      .query(`INSERT INTO visits (clinic_id, patient_id, visit_code, visit_date, status) VALUES (?,?,?,?,?)`)
      .run(e.clinicId, created.id, 'VS-2', '2026-02-05', 'cancelled');
    const stats = patientStats(e.db, ctxFor(e), created.id);
    expect(stats.visits.total).toBe(2);
    expect(stats.visits.completed).toBe(1);
    expect(stats.visits.cancelled).toBe(1);
    expect(stats.visits.firstVisitOn).toBe('2026-01-05');
    expect(stats.visits.lastVisitOn).toBe('2026-02-05');
  });
});

describe('archive, restore and permanent deletion', () => {
  test('archiving hides the patient from the list but keeps the record', () => {
    const e = setup();
    const created = createPatient(e.db, ctxFor(e), { full_name: 'Archive Me', gender: 'male', phone: '01311111111' });
    archivePatient(e.db, ctxFor(e), created.id, 'Left the country');
    const list = listPatients(e.db, ctxFor(e), {});
    expect(list.total).toBe(0);
    expect(e.db.query('SELECT deleted_at, status FROM patients WHERE id = ?').get(created.id).status).toBe('archived');
    restorePatient(e.db, ctxFor(e), created.id);
    expect(listPatients(e.db, ctxFor(e), {}).total).toBe(1);
  });

  test('permanent deletion requires the exact patient code and a clean ledger', () => {
    const e = setup();
    const created = createPatient(e.db, ctxFor(e), { full_name: 'Delete Me', gender: 'female', phone: '01211111111' });
    expect(() => deletePatientPermanently(e.db, ctxFor(e), created.id, { confirmation: 'WRONG' })).toThrow(ValidationError);

    const invoiceId = Number(
      e.db
        .query(
          `INSERT INTO invoices (clinic_id, patient_id, invoice_number, invoice_date, status, total_minor, due_minor)
           VALUES (?,?,?,?, 'issued', 10000, 10000)`,
        )
        .run(e.clinicId, created.id, 'INV-TEST-1', '2026-01-01').lastInsertRowid,
    );
    expect(() => deletePatientPermanently(e.db, ctxFor(e), created.id, { confirmation: 'DEN-000001' })).toThrow();
    e.db.query('DELETE FROM invoices WHERE id = ?').run(invoiceId);
    const result = deletePatientPermanently(e.db, ctxFor(e), created.id, { confirmation: 'DEN-000001' });
    expect(result.deleted).toBe(true);
    expect(e.db.query('SELECT COUNT(*) AS c FROM patients WHERE id = ?').get(created.id).c).toBe(0);
  });
});
