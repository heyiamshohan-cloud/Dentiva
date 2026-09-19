/**
 * Migration engine.
 *
 *  - Every migration runs inside its own IMMEDIATE transaction; a failure rolls
 *    the whole migration back and leaves the previous schema intact (§ 12/76).
 *  - `schema_migrations` records history (id, name, checksum, applied_at) and
 *    `PRAGMA user_version` mirrors the current schema version for fast checks.
 *  - Opening a database written by a *newer* Dentiva build is refused instead
 *    of being silently downgraded.
 */
import { SCHEMA_VERSION } from '../../../shared/constants.js';
import { UnsupportedDatabaseError } from '../../../shared/errors.js';
import * as m001 from './001_core_identity.js';
import * as m002 from './002_patients.js';
import * as m003 from './003_clinical.js';
import * as m004 from './004_scheduling.js';
import * as m005 from './005_billing.js';
import * as m006 from './006_finance_staff_inventory.js';
import * as m007 from './007_configuration_catalogs.js';
import * as m008 from './008_search_and_views.js';
import * as m009 from './009_permission_catalog.js';
import * as m010 from './010_treatment_line_details.js';

/** Ordered, immutable list of migrations. Never reorder or edit an applied one. */
export const MIGRATIONS = [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010];

export function latestMigrationId() {
  return MIGRATIONS.reduce((max, m) => Math.max(max, m.id), 0);
}

/** @param {import('bun:sqlite').Database} db */
export function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id           INTEGER PRIMARY KEY,
      name         TEXT NOT NULL,
      checksum     TEXT NOT NULL,
      applied_at   TEXT NOT NULL,
      duration_ms  INTEGER NOT NULL DEFAULT 0,
      app_version  TEXT NOT NULL DEFAULT ''
    );
  `);
}

/** @param {import('bun:sqlite').Database} db */
export function getAppliedMigrations(db) {
  ensureMigrationTable(db);
  return db
    .query('SELECT id, name, checksum, applied_at, duration_ms, app_version FROM schema_migrations ORDER BY id')
    .all();
}

/** @param {import('bun:sqlite').Database} db */
export function getSchemaVersion(db) {
  const row = db.query('SELECT COALESCE(MAX(id), 0) AS v FROM schema_migrations').get();
  return Number(row?.v ?? 0);
}

/**
 * Refuse to operate on a database created by a newer application version.
 * @param {import('bun:sqlite').Database} db
 */
export function assertDatabaseSupported(db) {
  ensureMigrationTable(db);
  const version = getSchemaVersion(db);
  if (version > SCHEMA_VERSION) throw new UnsupportedDatabaseError(version, SCHEMA_VERSION);
  return version;
}

/** Cheap content checksum so drifted migration files can be detected. */
function checksumOf(migration) {
  const source = `${migration.id}:${migration.name}:${migration.up.toString()}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Apply all pending migrations.
 * @param {import('bun:sqlite').Database} db
 * @param {{ appVersion?: string, log?: (msg: string) => void, targetVersion?: number, quiet?: boolean }} [options]
 * @returns {{ applied: number[], from: number, to: number, checksumWarnings: string[] }}
 */
export function migrate(db, options = {}) {
  const log = options.log ?? (() => {});
  const target = Math.min(options.targetVersion ?? SCHEMA_VERSION, SCHEMA_VERSION);
  ensureMigrationTable(db);
  const from = getSchemaVersion(db);
  if (from > SCHEMA_VERSION) throw new UnsupportedDatabaseError(from, SCHEMA_VERSION);

  const appliedRows = new Map(getAppliedMigrations(db).map((r) => [Number(r.id), r]));
  const applied = [];
  const checksumWarnings = [];

  for (const migration of MIGRATIONS) {
    if (migration.id <= from) {
      const row = appliedRows.get(migration.id);
      if (row && row.checksum !== checksumOf(migration)) {
        checksumWarnings.push(`Migration ${migration.id} (${migration.name}) checksum drifted`);
      }
      continue;
    }
    if (migration.id > target) break;

    const started = Date.now();
    const tx = db.transaction(() => {
      migration.up(db);
      db.prepare(
        'INSERT INTO schema_migrations (id, name, checksum, applied_at, duration_ms, app_version) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        migration.id,
        migration.name,
        checksumOf(migration),
        new Date().toISOString(),
        Date.now() - started,
        options.appVersion ?? '',
      );
    });
    try {
      tx.immediate();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Migration ${migration.id}_${migration.name} failed and was rolled back: ${message}`, {
        cause: err,
      });
    }
    db.exec(`PRAGMA user_version = ${migration.id}`);
    applied.push(migration.id);
    log(`migration ${String(migration.id).padStart(3, '0')}_${migration.name} applied in ${Date.now() - started}ms`);
  }

  const to = getSchemaVersion(db);
  return { applied, from, to, checksumWarnings };
}

/** Migration status report used by Settings → Data and by the migration tests. */
export function migrationStatus(db) {
  const applied = getAppliedMigrations(db);
  const appliedIds = new Set(applied.map((r) => Number(r.id)));
  return {
    currentVersion: getSchemaVersion(db),
    supportedVersion: SCHEMA_VERSION,
    latestMigrationId: latestMigrationId(),
    pending: MIGRATIONS.filter((m) => !appliedIds.has(m.id)).map((m) => ({ id: m.id, name: m.name })),
    history: applied,
  };
}
