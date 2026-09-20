/**
 * Test environment helper.
 *
 * Creates an isolated temporary data directory per test file, opens a real
 * SQLite database, runs the migrations and (optionally) provisions a clinic so
 * integration tests exercise the same code paths as production.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, openDatabase, run, get } from '../../src/server/db/connection.js';
import { migrate } from '../../src/server/db/migrations/index.js';
import { provisionClinic } from '../../src/server/services/clinic.js';
import { hashPassword } from '../../src/server/security/passwords.js';

let counter = 0;

/**
 * @param {{ provision?: boolean, quiet?: boolean }} [options]
 */
export function createTestEnv(options = {}) {
  counter += 1;
  const dir = mkdtempSync(join(tmpdir(), `dentiva-test-${counter}-`));
  const dbPath = join(dir, 'dentiva.db');
  const db = openDatabase(dbPath);
  migrate(db, { appVersion: 'test' });

  /** @type {any} */
  const env = {
    dir,
    dbPath,
    db,
    clinicId: null,
    admin: null,
    cleanup() {
      try {
        closeDatabase();
      } catch {
        /* ignore */
      }
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    },
  };

  if (options.provision !== false) {
    const provisioned = provisionClinic(db, {
      clinic: {
        code: 'MAIN',
        name: 'Test Dental Care',
        phone: '01711111111',
        email: 'clinic@example.test',
        address: '1 Test Road',
        city: 'Dhaka',
        country: 'Bangladesh',
        currency_code: 'BDT',
        currency_symbol: '৳',
        locale: 'en',
      },
      dentist: {
        full_name: 'Dr. Test Practitioner',
        designation: 'Consultant Dental Surgeon',
        phone: '01711111112',
        registration_no: 'BMDC-TEST-1',
      },
      admin: {
        username: 'admin',
        display_name: 'System Administrator',
        password: 'Gr33nLeaf!42',
      },
      silent: options.quiet !== false,
    });
    env.clinicId = provisioned.clinicId;
    env.admin = { id: provisioned.adminId, displayName: 'System Administrator', username: 'admin' };
    env.practitionerId = provisioned.practitionerId;
  }

  return env;
}

/**
 * Create a second user with a role for permission tests. The password is real
 * (scrypt) so the account can sign in exactly like a provisioned one.
 */
export function createUserWithRole(db, clinicId, roleName, username, options = {}) {
  const role = get(db, 'SELECT id FROM roles WHERE name = ?', [roleName]);
  if (!role) throw new Error(`Unknown role: ${roleName}`);
  const hashed = hashPassword(options.password ?? DEFAULT_TEST_PASSWORD);
  const result = run(
    db,
    `INSERT INTO users (clinic_id, role_id, username, display_name, password_hash, password_salt, password_algo, password_params, password_changed_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    [clinicId, role.id, username, options.displayName ?? username, hashed.hash, hashed.salt, hashed.algo, hashed.params, new Date().toISOString()],
  );
  return { id: Number(result.lastInsertRowid), roleId: role.id, username };
}

export const DEFAULT_TEST_PASSWORD = 'Gr33nLeaf!42';

let seq = 0;
export function uniqueSuffix() {
  seq += 1;
  return `${Date.now().toString(36)}${seq}`;
}
