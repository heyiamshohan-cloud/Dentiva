/**
 * Migration 010 — treatment line details (§ 12, § 76).
 *
 * The migration is additive: an existing database keeps every stored amount and
 * gains the two columns the treatment editor needs to recalculate correctly.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestEnv } from '../helpers/testEnv.js';
import { closeDatabase, openDatabase } from '../../src/server/db/connection.js';
import { migrate, getAppliedMigrations, getSchemaVersion } from '../../src/server/db/migrations/index.js';
import { SCHEMA_VERSION } from '../../src/shared/constants.js';
import * as m010 from '../../src/server/db/migrations/010_treatment_line_details.js';

let env;
let raw;
afterEach(() => {
  env?.cleanup();
  raw?.cleanup();
  env = null;
  raw = null;
});

/** An empty database file that this test migrates by hand. */
function rawEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'dentiva-m010-'));
  const db = openDatabase(join(dir, 'dentiva.db'));
  raw = {
    db,
    dir,
    cleanup() {
      try {
        closeDatabase();
      } catch {
        /* ignore */
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
      let lastError = null;
      for (let attempt = 1; attempt <= 8; attempt++) {
        try {
          if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const code = error?.code;
          const transient = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY' || code === 'EACCES';
          if (!transient || attempt === 8) break;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120 * attempt);
        }
      }
      if (lastError) throw new Error(`Failed to remove temporary directory '${dir}' after 8 attempts (${lastError.code}: ${lastError.message})`);
    },
  };
  return raw;
}

describe('migration 010', () => {
  test('declares its identity', () => {
    expect(m010.id).toBe(10);
    expect(m010.name).toBe('treatment_line_details');
  });

  test('a fresh database reaches the current schema with both columns', () => {
    env = createTestEnv();
    const columns = env.db.query('PRAGMA table_info(treatments)').all().map((row) => row.name);
    expect(columns).toContain('quantity_milli');
    expect(columns).toContain('tax_rate_bp');
    expect(getSchemaVersion(env.db)).toBe(SCHEMA_VERSION);
  });

  test('upgrading a version 9 database keeps every stored amount', () => {
    // The database sits at the version a clinic upgrading to 1.0.0 has:
    // migrations 001–009 applied, no quantity/rate columns on treatments.
    const e = rawEnv();
    migrate(e.db, { targetVersion: 9 });
    expect(getSchemaVersion(e.db)).toBe(9);
    const columns = e.db.query('PRAGMA table_info(treatments)').all().map((row) => row.name);
    expect(columns).not.toContain('quantity_milli');

    e.db.exec(`
      INSERT INTO clinics (code, name, is_default) VALUES ('MAIN', 'Legacy Clinic', 1);
      INSERT INTO patients (clinic_id, patient_code, full_name, gender, phone)
        VALUES (1, 'DEN-000001', 'Legacy Patient', 'male', '01711111111');
      INSERT INTO treatments (clinic_id, patient_id, name, treatment_date, status, fee_minor, discount_minor, tax_minor, total_minor)
        VALUES (1, 1, 'Legacy filling', '2026-01-05', 'completed', 250000, 10000, 12000, 252000);
    `);
    const before = e.db.query('SELECT * FROM treatments WHERE id = 1').get();

    const result = migrate(e.db, { appVersion: 'test' });
    expect(result.applied).toContain(10);

    const after = e.db.query('SELECT * FROM treatments WHERE id = 1').get();
    expect(after.fee_minor).toBe(before.fee_minor);
    expect(after.discount_minor).toBe(before.discount_minor);
    expect(after.tax_minor).toBe(before.tax_minor);
    expect(after.total_minor).toBe(before.total_minor);
    // Legacy rows were priced as a single unit at the stored rate.
    expect(after.quantity_milli).toBe(1000);
    expect(after.tax_rate_bp).toBe(0);
    expect(getSchemaVersion(e.db)).toBe(SCHEMA_VERSION);
  });

  test('re-running the migration changes nothing', () => {
    env = createTestEnv();
    const before = env.db.query('PRAGMA table_info(treatments)').all();
    m010.up(env.db);
    m010.up(env.db);
    expect(env.db.query('PRAGMA table_info(treatments)').all()).toEqual(before);
    expect(getAppliedMigrations(env.db).filter((row) => row.id === 10).length).toBe(1);
  });
});
