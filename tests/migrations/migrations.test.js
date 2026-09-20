/**
 * Migration engine tests (§ 12, § 90):
 *  fresh database, idempotent re-run, rollback on failure, history recording,
 *  unsupported-future-database detection and referential integrity of the
 *  resulting schema.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { openDatabase, closeDatabase, all, get, run } from '../../src/server/db/connection.js';
import {
  MIGRATIONS,
  assertDatabaseSupported,
  getSchemaVersion,
  latestMigrationId,
  migrate,
  migrationStatus,
} from '../../src/server/db/migrations/index.js';
import { SCHEMA_VERSION } from '../../src/shared/constants.js';
import { UnsupportedDatabaseError } from '../../src/shared/errors.js';
import { removeScratchDir } from '../../scripts/lib/scratch.mjs';

const dirs = [];
function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'dentiva-mig-'));
  dirs.push(dir);
  return join(dir, 'dentiva.db');
}
afterEach(async () => {
  try { closeDatabase(); } catch {}
  await new Promise((r) => setTimeout(r, 80));
  while (dirs.length) await removeScratchDir(dirs.pop(), 'migration data directory');
});

describe('migration engine', () => {
  test('a fresh database reaches the current schema version', () => {
    const db = openDatabase(tempDbPath());
    const result = migrate(db, { appVersion: '1.0.0' });
    expect(result.from).toBe(0);
    expect(result.to).toBe(SCHEMA_VERSION);
    expect(result.applied).toEqual(MIGRATIONS.map((m) => m.id));
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    const status = migrationStatus(db);
    expect(status.pending).toEqual([]);
    expect(status.history.length).toBe(MIGRATIONS.length);
    expect(status.history.every((row) => row.checksum.length === 8)).toBe(true);
  });

  test('re-running migrations is a no-op', () => {
    const db = openDatabase(tempDbPath());
    migrate(db, {});
    const second = migrate(db, {});
    expect(second.applied).toEqual([]);
    expect(second.from).toBe(SCHEMA_VERSION);
    expect(second.to).toBe(SCHEMA_VERSION);
  });

  test('all expected tables, views and the FTS index exist', () => {
    const db = openDatabase(tempDbPath());
    migrate(db, {});
    const tables = new Set(all(db, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
    for (const required of [
      'clinics', 'users', 'roles', 'permissions', 'role_permissions', 'user_permissions',
      'sessions', 'login_attempts', 'settings', 'number_sequences', 'audit_logs',
      'notifications', 'notification_preferences',
      'patients', 'patient_contacts', 'patient_medical', 'patient_dental', 'patient_notes',
      'patient_custom_fields', 'patient_custom_values',
      'services', 'diagnoses', 'tooth_conditions', 'visits', 'visit_diagnoses',
      'dental_chart_entries', 'treatments', 'treatment_plans', 'treatment_plan_items',
      'prescriptions', 'prescription_items', 'prescription_templates', 'referrals',
      'attachments', 'appointments', 'appointment_types', 'queue_entries',
      'invoices', 'invoice_items', 'payments', 'payment_methods', 'patient_credits',
      'staff', 'payroll', 'payroll_items', 'suppliers', 'inventory_categories',
      'inventory_items', 'stock_movements', 'income_categories', 'expense_categories',
      'incomes', 'expenses', 'search_index',
    ]) {
      expect(tables.has(required)).toBe(true);
    }
    const views = new Set(all(db, "SELECT name FROM sqlite_master WHERE type='view'").map((r) => r.name));
    for (const view of ['v_patient_balances', 'v_patient_visit_stats', 'v_patient_appointment_stats', 'v_inventory_status']) {
      expect(views.has(view)).toBe(true);
    }
  });

  test('a failing migration rolls back completely and keeps the previous version', () => {
    const path = tempDbPath();
    const db = openDatabase(path);
    migrate(db, {});
    const versionBefore = getSchemaVersion(db);

    // Simulate a broken future migration by asking for a target that does not exist.
    const broken = {
      id: versionBefore + 9,
      name: 'broken',
      up(handle) {
        handle.exec('CREATE TABLE temp_ok (id INTEGER PRIMARY KEY)');
        handle.exec('THIS IS NOT VALID SQL');
      },
    };
    const tx = db.transaction(() => {
      broken.up(db);
      db.prepare('INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES (?,?,?,?)').run(
        broken.id,
        broken.name,
        'deadbeef',
        new Date().toISOString(),
      );
    });
    expect(() => tx.immediate()).toThrow();

    expect(getSchemaVersion(db)).toBe(versionBefore);
    const tempTable = get(db, "SELECT name FROM sqlite_master WHERE name='temp_ok'");
    expect(tempTable).toBeNull();
  });

  test('a database from a newer application version is refused', () => {
    const db = openDatabase(tempDbPath());
    migrate(db, {});
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations_stub (id INTEGER)');
    db.prepare('INSERT INTO schema_migrations (id, name, checksum, applied_at, duration_ms, app_version) VALUES (?,?,?,?,0,?)').run(
      SCHEMA_VERSION + 5,
      'future_feature',
      'ffffffff',
      new Date().toISOString(),
      '2.0.0',
    );
    expect(() => assertDatabaseSupported(db)).toThrow(UnsupportedDatabaseError);
    expect(() => migrate(db, {})).toThrow(UnsupportedDatabaseError);
  });

  test('the migrated schema enforces referential integrity', () => {
    const db = openDatabase(tempDbPath());
    migrate(db, {});
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);

    const clinicId = Number(run(db, "INSERT INTO clinics (code, name) VALUES ('C1','Clinic One')").lastInsertRowid);
    const roleId = Number(get(db, 'SELECT id FROM roles WHERE name = ?', ['owner']).id);
    const userId = Number(
      run(db, 'INSERT INTO users (clinic_id, role_id, username, display_name, password_hash, password_salt) VALUES (?,?,?,?,?,?)', [
        clinicId, roleId, 'admin', 'Admin', 'h', 's',
      ]).lastInsertRowid,
    );
    const patientId = Number(
      run(db, 'INSERT INTO patients (clinic_id, patient_code, full_name, gender) VALUES (?,?,?,?)', [
        clinicId, 'DEN-000001', 'Patient One', 'female',
      ]).lastInsertRowid,
    );

    // Deleting a clinic that still owns a patient must be refused (RESTRICT).
    expect(() => run(db, 'DELETE FROM clinics WHERE id = ?', [clinicId])).toThrow();

    // Unknown tooth condition must be rejected (FK to tooth_conditions).
    expect(() =>
      run(db, 'INSERT INTO dental_chart_entries (clinic_id, patient_id, tooth_code, condition_code) VALUES (?,?,?,?)', [
        clinicId, patientId, '11', 'not_a_condition',
      ]),
    ).toThrow();

    // Gender is mandatory and constrained.
    expect(() =>
      run(db, 'INSERT INTO patients (clinic_id, patient_code, full_name, gender) VALUES (?,?,?,?)', [
        clinicId, 'DEN-000002', 'Bad Gender', 'unknown-value',
      ]),
    ).toThrow();

    // Duplicate patient codes are impossible.
    expect(() =>
      run(db, 'INSERT INTO patients (clinic_id, patient_code, full_name, gender) VALUES (?,?,?,?)', [
        clinicId, 'DEN-000001', 'Duplicate', 'male',
      ]),
    ).toThrow();

    // Money columns reject negative totals.
    expect(() =>
      run(db, 'INSERT INTO invoices (clinic_id, patient_id, invoice_number, invoice_date, total_minor) VALUES (?,?,?,?,?)', [
        clinicId, patientId, 'INV-1', '2026-01-01', -5,
      ]),
    ).toThrow();

    expect(userId).toBeGreaterThan(0);
  });

  test('search index supports prefix and multi-column matching', () => {
    const db = openDatabase(tempDbPath());
    migrate(db, {});
    run(
      db,
      'INSERT INTO search_index (entity, entity_id, patient_id, record_date, title, subtitle, keywords, body) VALUES (?,?,?,?,?,?,?,?)',
      ['patient', 1, 1, '2026-09-19', 'Md. Rahim Uddin', 'DEN-000001', 'den-000001 01712345678', 'root canal treatment completed'],
    );
    run(
      db,
      'INSERT INTO search_index (entity, entity_id, patient_id, record_date, title, subtitle, keywords, body) VALUES (?,?,?,?,?,?,?,?)',
      ['prescription', 5, 1, '2026-09-20', 'Prescription RX-2026-000005', 'Md. Rahim Uddin', 'rx-2026-000005', 'amoxicillin 500mg'],
    );
    // 'rahi*' appears in the patient title and in the prescription's subtitle.
    expect(all(db, "SELECT entity FROM search_index WHERE search_index MATCH 'rahi*'").length).toBe(2);
    expect(all(db, "SELECT entity FROM search_index WHERE search_index MATCH 'title:rahi*'").length).toBe(1);
    expect(all(db, "SELECT entity FROM search_index WHERE search_index MATCH 'amoxic*'").length).toBe(1);
    expect(all(db, "SELECT entity FROM search_index WHERE search_index MATCH '0171*'").length).toBe(1);
    expect(all(db, "SELECT entity FROM search_index WHERE search_index MATCH 'untreated*'").length).toBe(0);
  });
});

describe('schema constants', () => {
  test('declared schema version matches the migration list', () => {
    expect(latestMigrationId()).toBe(SCHEMA_VERSION);
    expect(Math.max(...MIGRATIONS.map((m) => m.id))).toBe(SCHEMA_VERSION);
  });

  test('migration ids are unique and ascending', () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });
});
