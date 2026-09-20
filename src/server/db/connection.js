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
import { existsSync, mkdirSync, rmSync } from 'node:fs';

/**
 * Ways an operating system says "that file is busy right now".
 *
 * On Windows, in particular, a file that has just been written is re-opened
 * by the platform's anti-malware scanner, and a handle like that can block a
 * rename, a delete, or an exclusive lock for several seconds. None of that is
 * a fault in the data; it is a condition to wait out, and only to wait out.
 */
export const HELD_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

/** @param {number} ms */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isHeldError(error) {
  if (!error) return false;
  const code = /** @type {any} */ (error).code;
  if (typeof code === 'string' && HELD_CODES.has(code)) return true;
  const message = String(/** @type {any} */ (error).message ?? '');
  return /SQLITE_(BUSY|LOCKED)|database (is|was) (busy|locked)|EPERM|EACCES|EBUSY/i.test(message);
}

/**
 * Delete a file, retrying while the operating system still holds it.
 *
 * @param {string} path
 * @param {{ attempts?: number }} [options]
 * @returns {boolean} false only when the file will not go and must be left
 */
export function removeFileRetrying(path, { attempts = 24 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rmSync(path, { force: true });
      return true;
    } catch (error) {
      if (!isHeldError(error) || attempt >= attempts) return false;
      sleepSync(Math.min(50 * attempt, 400));
    }
  }
}

/** @type {Database | null} */
let instance = null;
/** @type {string | null} */
let instancePath = null;
/** Track every opened handle so concurrent tests can be closed reliably on Windows. */
const tracked = new Map();

// busy_timeout comes first on purpose. Switching a database into WAL mode
// needs a brief exclusive lock, and Windows holds a file for a moment after it
// is written while the platform scans it — so `journal_mode` is the pragma most
// likely to be refused, and it has to be able to wait. Setting the timeout
// after it, as this list used to, meant the one pragma that needs to wait was
// the only one that could not.
const PRAGMAS = [
  'PRAGMA busy_timeout = 8000',
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
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

  // The file is created the moment it is first written, and on Windows the
  // platform then opens it to scan it before we have done anything with it.
  // Both the open and the pragmas are retried while that is happening; a
  // database that cannot be opened in its own folder is an app that cannot
  // start, and waiting is the only answer.
  /** @type {Database | null} */
  let db = null;
  for (let attempt = 1; ; attempt += 1) {
    try {
      db = new Database(filePath, {
        create: !options.readonly,
        readwrite: !options.readonly,
      });
      break;
    } catch (error) {
      if (!isHeldError(error) || attempt >= 24) throw error;
      sleepSync(Math.min(50 * attempt, 400));
    }
  }
  try {
    for (const pragma of PRAGMAS) {
      if (options.readonly && pragma.startsWith('PRAGMA journal_mode')) continue;
      for (let attempt = 1; ; attempt += 1) {
        try {
          db.exec(pragma);
          break;
        } catch (error) {
          if (!isHeldError(error) || attempt >= 24) throw error;
          sleepSync(Math.min(50 * attempt, 400));
        }
      }
    }
  } catch (error) {
    // The file was opened but could not be brought to a known state; the
    // handle goes back to the operating system before the error does.
    try {
      db.close();
    } catch {
      /* the file is already going away with the error */
    }
    throw error;
  }
  if (!options.readonly) {
    instance = db;
    instancePath = filePath;
    tracked.set(filePath, db);
  }
  return db;
}

/** @returns {Database} */
export function getDb() {
  if (!instance) throw new Error('Database has not been opened yet');
  return instance;
}

/**
 * @param {any} [target] - a Database instance, a file path, or null to close all
 */
export function closeDatabase(target = null) {
  // Close a specific handle when the caller knows the path or the Database object
  if (target && typeof target === 'string') {
    const db = tracked.get(target);
    if (db) {
      try { /** @type {any} */ (db).exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
      try { /** @type {any} */ (db).close(); } catch { /* ignore */ }
      tracked.delete(target);
      if (instancePath === target) { instance = null; instancePath = null; }
    }
    return;
  }
  if (target && typeof target === 'object' && typeof target.close === 'function') {
    try { /** @type {any} */ (target).exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    try { /** @type {any} */ (target).close(); } catch { /* ignore */ }
    for (const [path, db] of tracked) if (db === target) { tracked.delete(path); if (instance === target) { instance = null; instancePath = null; } break; }
    if (instance === target) { instance = null; instancePath = null; }
    return;
  }
  // Close the singleton and any other tracked handles (covers concurrent tests on Windows)
  for (const [path, db] of [...tracked.entries()]) {
    try { /** @type {any} */ (db).exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    try { /** @type {any} */ (db).close(); } catch { /* ignore */ }
    tracked.delete(path);
  }
  if (instance) {
    try { /** @type {any} */ (instance).exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    try { /** @type {any} */ (instance).close(); } catch { /* ignore */ }
  }
  instance = null;
  instancePath = null;
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
