/**
 * SQLite connection management.
 *
 * Design notes
 * ------------
 *  - One writer connection per process, WAL journal for crash safety.
 *  - Foreign keys enforced; statements always parameterised (no string SQL).
 *  - Money is stored as INTEGER minor units, quantities as INTEGER milli-units,
 *    so no floating point value ever reaches the database (see docs/DATABASE.md).
 *  - The connection is created lazily and reused; `withTransaction` wraps
 *    work in an IMMEDIATE transaction so concurrent readers stay consistent.
 */
import { Database } from 'bun:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

/** @type {Database | null} */
let instance = null;
/** @type {string | null} */
let instancePath = null;

const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 8000',
  'PRAGMA synchronous = FULL',
  'PRAGMA temp_store = MEMORY',
  'PRAGMA cache_size = -32000',
  'PRAGMA wal_autocheckpoint = 512',
  'PRAGMA trusted_schema = OFF',
  'PRAGMA recursive_triggers = OFF',
];

/**
 * Open (or reuse) the database connection.
 * @param {string} filePath
 * @param {{ readonly?: boolean }} [options]
 * @returns {Database}
 */
export function openDatabase(filePath, options = {}) {
  if (instance && instancePath === filePath && !options.readonly) return instance;
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath, {
    create: !options.readonly,
    readwrite: !options.readonly,
  });
  for (const pragma of PRAGMAS) {
    if (options.readonly && pragma.startsWith('PRAGMA journal_mode')) continue;
    db.exec(pragma);
  }
  if (!options.readonly) {
    instance = db;
    instancePath = filePath;
  }
  return db;
}

/** @returns {Database} */
export function getDb() {
  if (!instance) throw new Error('Database has not been opened yet');
  return instance;
}

export function closeDatabase() {
  if (instance) {
    try {
      instance.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* checkpoint is best effort */
    }
    instance.close();
    instance = null;
    instancePath = null;
  }
}

export function currentDatabasePath() {
  return instancePath;
}

/**
 * Run work inside an IMMEDIATE transaction. Nested calls reuse the outer
 * transaction (SQLite has no true nesting), which keeps service composition simple.
 * @template T
 * @param {Database} db
 * @param {() => T} fn
 * @returns {T}
 */
export function withTransaction(db, fn) {
  const tx = db.transaction(fn);
  return tx.immediate();
}

/** Convenience helpers -------------------------------------------------- */

/** @param {Database} db @param {string} sql @param {any[]} [params] */
export function run(db, sql, params = []) {
  return db.prepare(sql).run(...params);
}

/**
 * One row (or `null`). Rows are structurally dynamic — callers read the columns
 * they selected — so the shape is deliberately open.
 * @param {Database} db
 * @param {string} sql
 * @param {any[]} [params]
 * @returns {any}
 */
export function get(db, sql, params = []) {
  return db.prepare(sql).get(...params) ?? null;
}

/**
 * @param {Database} db
 * @param {string} sql
 * @param {any[]} [params]
 * @returns {any[]}
 */
export function all(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

/** @param {Database} db @param {string} sql @param {any[]} [params] */
export function scalar(db, sql, params = []) {
  const row = get(db, sql, params);
  if (!row) return null;
  const keys = Object.keys(row);
  return keys.length ? row[keys[0]] : null;
}

/**
 * Escape a user supplied value for use inside SQL LIKE with an ESCAPE clause.
 * @param {string} value
 */
export function likePattern(value) {
  return `%${String(value ?? '').replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function todayIso(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
