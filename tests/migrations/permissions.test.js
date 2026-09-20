/**
 * RBAC catalogue integrity (§ 41, § 74).
 *
 * Guards the failure mode found while wiring the renderer: a route guarded with
 * a permission code that is not in the catalogue is unreachable for *every*
 * role — including the owner, whose grant is the expanded catalogue. These
 * tests compare the three places permission codes live (route metadata, the
 * mirroring `PERMISSION_CODES` array and the seeded database rows) and prove the
 * built-in roles can actually exercise the capabilities they advertise.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { closeDatabase, all } from '../../src/server/db/connection.js';
import * as m009 from '../../src/server/db/migrations/009_permission_catalog.js';
import { createApiRouter } from '../../src/server/http/routes.js';
import { PERMISSION_CODES } from '../../src/server/domain/permissions.js';
import { createTestEnv } from '../helpers/testEnv.js';

let env;
afterEach(() => {
  env?.cleanup();
  env = null;
  closeDatabase();
});

/** Route permission codes declared in the HTTP layer. */
function routePermissionCodes() {
  const codes = new Set();
  for (const route of createApiRouter().describe()) {
    if (route.permission) codes.add(route.permission);
  }
  return [...codes].sort();
}

describe('permission catalogue', () => {
  test('every route permission exists in the database catalogue', () => {
    env = createTestEnv();
    const known = new Set(all(env.db, 'SELECT code FROM permissions').map((row) => row.code));
    const missing = routePermissionCodes().filter((code) => !known.has(code));
    expect(missing).toEqual([]);
  });

  test('the PERMISSION_CODES mirror matches the seeded catalogue', () => {
    env = createTestEnv();
    const seeded = all(env.db, 'SELECT code FROM permissions ORDER BY code').map((row) => row.code);
    expect([...PERMISSION_CODES].sort()).toEqual(seeded);
  });

  test('the owner role holds every catalogued permission', () => {
    env = createTestEnv();
    const rows = all(
      env.db,
      `SELECT p.code FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.name = 'owner'`,
    ).map((row) => row.code);
    const catalogue = all(env.db, 'SELECT code FROM permissions').map((row) => row.code);
    expect(rows.sort()).toEqual(catalogue.sort());
  });

  test('the capabilities added by migration 009 reach the right roles', () => {
    env = createTestEnv();
    const grantedTo = (role, code) =>
      all(
        env.db,
        `SELECT 1 AS ok FROM role_permissions rp
           JOIN roles r ON r.id = rp.role_id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE r.name = ? AND p.code = ?`,
        [role, code],
      ).length === 1;

    expect(grantedTo('owner', 'treatments.manage')).toBe(true);
    expect(grantedTo('owner', 'appointments.manage')).toBe(true);
    expect(grantedTo('owner', 'payments.manage')).toBe(true);
    expect(grantedTo('owner', 'patients.delete')).toBe(true);
    expect(grantedTo('dentist', 'treatments.manage')).toBe(true);
    expect(grantedTo('receptionist', 'appointments.manage')).toBe(true);
    expect(grantedTo('accountant', 'payments.manage')).toBe(true);
    // Permanent deletion stays with the owner only.
    expect(grantedTo('dentist', 'patients.delete')).toBe(false);
    expect(grantedTo('receptionist', 'patients.delete')).toBe(false);
  });

  test('migration 009 is additive: re-running it changes nothing', () => {
    env = createTestEnv();
    const before = all(env.db, 'SELECT code, sort_order FROM permissions ORDER BY code');
    const grantsBefore = all(env.db, 'SELECT role_id, permission_id FROM role_permissions ORDER BY 1, 2');
    m009.up(env.db);
    const after = all(env.db, 'SELECT code, sort_order FROM permissions ORDER BY code');
    const grantsAfter = all(env.db, 'SELECT role_id, permission_id FROM role_permissions ORDER BY 1, 2');
    expect(after).toEqual(before);
    expect(grantsAfter.map((r) => `${r.role_id}:${r.permission_id}`)).toEqual(
      grantsBefore.map((r) => `${r.role_id}:${r.permission_id}`),
    );
  });

  test('a database migrated before 009 gains the new codes', () => {
    // Simulates an existing installation: drop the 009 rows, re-run the
    // migration and confirm the codes and the owner grant come back.
    env = createTestEnv();
    env.db.exec("DELETE FROM permissions WHERE code IN ('treatments.manage','appointments.manage','payments.manage','patients.delete')");
    m009.up(env.db);
    expect(all(env.db, "SELECT code FROM permissions WHERE code = 'treatments.manage'").length).toBe(1);
    expect(
      all(
        env.db,
        `SELECT 1 AS ok FROM role_permissions rp
           JOIN roles r ON r.id = rp.role_id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE r.name = 'owner' AND p.code = 'payments.manage'`,
      ).length,
    ).toBe(1);
  });
});

describe('migration list', () => {
  test('a fresh database applies migration 009', () => {
    const env9 = createTestEnv();
    const applied = all(env9.db, 'SELECT id FROM schema_migrations ORDER BY id').map((row) => row.id);
    expect(applied).toContain(9);
    env9.cleanup();
  });

  test('migration 009 declares its id and name', () => {
    expect(m009.id).toBe(9);
    expect(typeof m009.name).toBe('string');
    expect(typeof m009.up).toBe('function');
  });
});
