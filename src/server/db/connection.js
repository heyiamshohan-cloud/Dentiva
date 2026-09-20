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
export function removeFileRetrying(path, { attempts = 30 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rmSync(path, { force: true });
      return true;
    } catch (error) {
      if (!isHeldError(error) || attempt >= attempts) return false;
      sleepSync(Math.min(50 * attempt, 500));
    }
  }
}

/** @type {Database | null} */
let instance = null;
/** @type {string | null} */
let instancePath = null;
/** Track every opened handle so concurrent tests can be closed reliably on Windows. */
const tracked = new Map();

// Two phases. The journal switch needs a brief exclusive lock, and the
// operating system holds a file for a while after it is written (the
// anti-malware scanner re-opens it), so that one pragma is tried with a
// *short* busy timeout and real backoff: stacking the full 8 s wait inside
// every retry attempt is how a two-second hold became a three-minute open.
// Once the database is in its journal mode, normal operations get the full
// 8 s busy timeout they were always given.
const OPEN_PRAGMA = 'PRAGMA busy_timeout = 1000';
const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA busy_timeout = 8000',
  'PRAGMA foreign_keys = ON',
  'PRAGMA synchronous = FULL',
  'PRAGMA temp_store = MEMORY',
  'PRAGMA cache_size = -32000',
  'PRAGMA wal_autocheckpoint = 512',
  'PRAGMA trusted_schema = OFF',
  'PRAGMA recursive_triggers = OFF',
];

/**
 * Run a pragma, retrying while the operating system holds the file.
 *
 * @param {Database} db
 * @param {string} pragma
 * @param {{ attempts?: number, cap?: number }} [options]
 */
function execPragma(db, pragma, { attempts = 12, cap = 300 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      db.exec(pragma);
      return;
    } catch (error) {
      if (!isHeldError(error) || attempt >= attempts) throw error;
      sleepSync(Math.min(50 * attempt, cap));
    }
  }
}

/**
 * The shared heart of every open: create the handle and bring it to a known
 * state, retrying while the operating system holds the file. Used by
 * `openDatabase` for the app's database and by the backup verifier for its
 * throwaway probe.
 *
 * @param {string} filePath
 * @param {{ readonly?: boolean }} [options]
 * @returns {Database}
 */
function openWithRetry(filePath, options = {}) {
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
      if (!isHeldError(error) || attempt >= 12) throw error;
      sleepSync(Math.min(50 * attempt, 300));
    }
  }
  try {
    if (!options.readonly) {
      execPragma(db, OPEN_PRAGMA, { attempts: 6, cap: 200 });
      execPragma(db, 'PRAGMA journal_mode = WAL');
    }
    for (const pragma of PRAGMAS) {
      if (options.readonly && pragma === 'PRAGMA journal_mode = WAL') continue;
      execPragma(db, pragma, { attempts: 6, cap: 200 });
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
  return db;
}

/**
 * Open a throwaway database and leave it untracked: the backup verifier's
 * probe, and any other one-shot read that must not become the app's
 * connection. Retried exactly like the real open, because the file it reads
 * was just written and the platform may be holding it.
 *
 * @param {string} filePath
 * @returns {Database}
 */
export function openProbeDatabase(filePath) {
  return openWithRetry(filePath, {});
}

/**
 * Open (or reuse) the database connection.
 * @param {string} filePath
 * @param {{ readonly?: boolean }} [options]
 * @returns {Database}
 */
export function openDatabase(filePath, options = {}) {
  if (instance && instancePath === filePath && !options.readonly) return instance;
  mkdirSync(dirname(filePath), { recursive: true });
  const db = openWithRetry(filePath, options);
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
 * Close one handle, and clear its journal if the journal is proven empty.
 *
 * The journal must not survive the close: an old journal at the live name
 * is exactly what a restore's swap must never meet, and on Windows the
 * operating system re-opens freshly written files, so a surviving journal
 * is a file that can be held for seconds at the worst possible moment.
 * This build of bun demonstrably leaves -wal and -shm behind after the
 * last close of a database that combined schema work with data writes, so
 * closing switches the journal mode back to DELETE first — which makes
 * SQLite checkpoint and unlink the journal through the VFS while the
 * connection is still in control — and only deletes what that (or, when
 * the switch is blocked, a TRUNCATE checkpoint) proved to be empty. The
 * next open switches the database back to WAL, so the on-disk mode in
 * between is invisible to the application.
 */
/**
 * Prove a connection's journal empty, and make SQLite unlink it.
 *
 * The mode switch back to DELETE checkpoints the WAL and unlinks -wal and
 * -shm through the VFS while the connection is still in control, which is
 * what matters on runtimes whose close does not release the files itself.
 * When the switch is blocked, a truncate checkpoint still proves the
 * journal empty. A `false` return means both were blocked, so the journal
 * may still carry frames and must not be deleted.
 */
function proveJournalEmpty(db) {
  try {
    const row = /** @type {any} */ (db).query('PRAGMA journal_mode = DELETE').get();
    if (String(row?.journal_mode ?? '').toLowerCase() === 'delete') return true;
  } catch {
    /* blocked or refused: fall through to the checkpoint path */
  }
  try {
    /** @type {any} */ (db).exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return true;
  } catch {
    return false;
  }
}

function closeDatabaseHandle(databasePath, db) {
  const journalProvenEmpty = proveJournalEmpty(db);

  try {
    /** @type {any} */ (db).close();
  } catch {
    /* the handle is closed either way; tracked bookkeeping below still runs */
  }

  // A file at a journal name after a proven-empty final write is safe to
  // delete. Retrying, because the platform may still hold a file that was
  // just written and truncated. A file that refuses to go is reported by
  // `restoreBackup`'s quarantine, which turns it into a clean abort — never
  // into a database opened beside its journal.
  if (journalProvenEmpty) {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const journalPath = `${databasePath}${suffix}`;
      if (existsSync(journalPath)) {
        removeFileRetrying(journalPath);
      }
    }
  }
}

/**
 * @param {any} [target] - a Database instance, a file path, or null to close all
 */
export function closeDatabase(target = null) {
  // Close a specific handle when the caller knows the path or the Database object
  if (target && typeof target === 'string') {
    const db = tracked.get(target);
    if (db) {
      closeDatabaseHandle(target, db);
      tracked.delete(target);
      if (instancePath === target) { instance = null; instancePath = null; }
    }
    return;
  }
  if (target && typeof target === 'object' && typeof target.close === 'function') {
    const path = [...tracked.entries()].find(([, db]) => db === target)?.[0] ?? null;
    if (path) {
      closeDatabaseHandle(path, target);
    } else {
      // Untracked handle: the mode switch still unlinks its journal through
      // the VFS, so the file does not survive the close either.
      proveJournalEmpty(target);
      try { /** @type {any} */ (target).close(); } catch { }
    }
    for (const [path, db] of tracked) if (db === target) { tracked.delete(path); if (instance === target) { instance = null; instancePath = null; } break; }
    if (instance === target) { instance = null; instancePath = null; }
    return;
  }
  // Close the singleton and any other tracked handles (covers concurrent tests on Windows)
  for (const [path, db] of [...tracked.entries()]) {
    closeDatabaseHandle(path, db);
    tracked.delete(path);
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
