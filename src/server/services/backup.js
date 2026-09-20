/**
 * Backup, restore, data export and data import (§ 49, § 50).
 *
 *  - A backup is a single `.zip` holding a consistent snapshot of the SQLite
 *    database (`VACUUM INTO`, so no page is copied mid-transaction), every
 *    attachment file, and a manifest with versions and checksums.
 *  - A restore first snapshots the current data, then verifies the archive
 *    (checksums, SQLite integrity, schema version) before replacing anything.
 *  - Nothing leaves the machine: backups are written to a folder the operator
 *    chooses, and imports read a local CSV file.
 */
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { closeDatabase, currentDatabasePath, isHeldError, openDatabase, openProbeDatabase, removeFileRetrying, sleepSync } from '../db/connection.js';
import { latestMigrationId, migrate } from '../db/migrations/index.js';
import { assertValid } from '../domain/validation.js';
import { ConflictError, FileError, NotFoundError, UnsupportedDatabaseError, ValidationError } from '../../shared/errors.js';
import { APP_VERSION, SCHEMA_VERSION, BUILD_NUMBER } from '../../shared/constants.js';
import { todayIso } from '../domain/dates.js';
import { createZip, extractZip, listZip, readZipEntry } from '../domain/zip.js';
import { buildCsv, parseCsv, csvBoolean } from '../domain/csv.js';
import { resolveStoredPath, validateExtension } from './fileStore.js';
import { recordAudit } from './audit.js';
import { getSettings } from './settings.js';
import { createPatient } from './patients.js';

const MANIFEST_NAME = 'manifest.json';
const DATABASE_NAME = 'dentiva.db';
const ATTACHMENT_PREFIX = 'attachments/';

const BACKUP_TABLE_COUNTS = [
  'clinics',
  'users',
  'patients',
  'visits',
  'treatments',
  'prescriptions',
  'referrals',
  'appointments',
  'invoices',
  'payments',
  'expenses',
  'attachments',
];

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function defaultBackupDir(dataDir) {
  return join(dataDir, 'backups');
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function timestampLabel(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function tableCounts(db) {
  const counts = {};
  for (const table of BACKUP_TABLE_COUNTS) {
    const row = db.query(`SELECT COUNT(*) AS c FROM ${table}`).get();
    counts[table] = Number(row?.c ?? 0);
  }
  return counts;
}

/**
 * Create a backup archive.
 * @param {import('bun:sqlite').Database} db
 * @param {{ clinicId: number, user?: any, dataDir: string }} ctx
 */
/**
 * @param {any} db
 * @param {any} ctx
 * @param {{ backupDir?: string|null, kind?: string, label?: string|null, includeAttachments?: boolean }} [options]
 */
export function createBackup(db, ctx, { backupDir = null, kind = 'manual', label = null, includeAttachments = true } = {}) {
  if (!ctx.dataDir) throw new FileError('files.storeUnavailable');
  const targetDir = ensureDir(backupDir ?? defaultBackupDir(ctx.dataDir));
  const snapshotPath = join(targetDir, `.snapshot-${process.pid}-${Date.now()}.db`);

  // A consistent snapshot without holding a long write lock.
  db.run(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
  const databaseBytes = readFileSync(snapshotPath);
  const databaseHash = sha256(databaseBytes);

  const attachments = db
    .query('SELECT id, rel_path, sha256, size_bytes, original_name FROM attachments WHERE clinic_id = ?')
    .all(ctx.clinicId);

  const entries = [{ name: DATABASE_NAME, data: databaseBytes }];
  let attachmentFiles = 0;
  let attachmentBytes = 0;
  const missing = [];
  for (const attachment of attachments) {
    if (!includeAttachments) break;
    try {
      const absolutePath = resolveStoredPath(ctx.dataDir, attachment.rel_path);
      if (!existsSync(absolutePath)) {
        missing.push({ id: attachment.id, relPath: attachment.rel_path });
        continue;
      }
      const data = readFileSync(absolutePath);
      entries.push({ name: `${ATTACHMENT_PREFIX}${attachment.rel_path}`, data, store: false });
      attachmentFiles += 1;
      attachmentBytes += data.length;
    } catch {
      missing.push({ id: attachment.id, relPath: attachment.rel_path });
    }
  }

  const manifest = {
    format: 'dentiva-backup',
    formatVersion: 1,
    appVersion: APP_VERSION,
    buildChannel: process.env.DENTIVA_CHANNEL ?? 'production',
    buildNumber: BUILD_NUMBER,
    schemaVersion: SCHEMA_VERSION,
    latestMigrationId: latestMigrationId(),
    createdAt: new Date().toISOString(),
    kind,
    label,
    clinicId: ctx.clinicId,
    createdBy: ctx.user?.displayName ?? null,
    database: { name: DATABASE_NAME, bytes: databaseBytes.length, sha256: databaseHash },
    attachments: { count: attachmentFiles, bytes: attachmentBytes, missing },
    counts: tableCounts(db),
    patientCount: Number(db.query('SELECT COUNT(*) AS c FROM patients WHERE clinic_id = ?').get(ctx.clinicId)?.c ?? 0),
  };
  entries.push({ name: MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });

  const archive = createZip(entries);
  const baseName = label ? `dentiva-${label}-${timestampLabel()}` : `dentiva-backup-${timestampLabel()}`;
  // Two archives in the same second must never overwrite each other: a backup
  // that silently disappears is worse than an ugly file name.
  let fileName = `${baseName}.zip`;
  let archivePath = join(targetDir, fileName);
  for (let attempt = 2; existsSync(archivePath) && attempt < 100; attempt += 1) {
    fileName = `${baseName}-${attempt}.zip`;
    archivePath = join(targetDir, fileName);
  }
  writeFileSync(archivePath, archive);
  rmSync(snapshotPath, { force: true });

  const stats = statSync(archivePath);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'backup_create',
    module: 'backup',
    entity: 'backup',
    entityId: null,
    summary: `Backup created (${(stats.size / 1048576).toFixed(2)} MB, ${attachmentFiles} attachment(s))`,
    severity: 'notice',
    after: { path: archivePath, bytes: stats.size, counts: manifest.counts, kind },
  });

  // Retention: keep the newest N automatic/manual backups.
  const keep = Number(getSettings(db, ctx.clinicId)['backup.retentionCount'] ?? 14);
  pruneBackups(targetDir, keep, archivePath);

  return {
    path: archivePath,
    fileName,
    bytes: stats.size,
    sha256: sha256(archive),
    attachments: attachmentFiles,
    missingAttachments: missing.length,
    counts: manifest.counts,
    createdAt: manifest.createdAt,
  };
}

function pruneBackups(backupDir, keep, currentPath) {
  try {
    const files = readdirSync(backupDir)
      .filter((name) => name.startsWith('dentiva-') && name.endsWith('.zip'))
      .map((name) => ({ name, path: join(backupDir, name), mtime: statSync(join(backupDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const file of files.slice(Math.max(1, keep))) {
      if (file.path === currentPath) continue;
      rmSync(file.path, { force: true });
    }
  } catch {
    /* retention is best-effort */
  }
}

/**
 * List the backups found in a folder, including their manifest summary.
 * @param {any} db
 * @param {{ clinicId: number, dataDir?: string|null }} ctx
 * @param {{ backupDir?: string|null }} [options]
 */
export function listBackups(db, ctx, { backupDir = null } = {}) {
  if (!ctx.dataDir) throw new FileError('files.storeUnavailable');
  const dir = backupDir ?? defaultBackupDir(ctx.dataDir);
  if (!existsSync(dir)) return { dir, backups: [] };
  const backups = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.zip')).sort()) {
    const path = join(dir, name);
    const stats = statSync(path);
    let manifest = null;
    let error = null;
    try {
      const archive = readFileSync(path);
      const entry = listZip(archive).find((item) => item.name === MANIFEST_NAME);
      if (entry) manifest = JSON.parse(readZipEntry(archive, entry).toString('utf8'));
    } catch (exception) {
      error = exception instanceof Error ? exception.message : String(exception);
    }
    backups.push({
      fileName: name,
      path,
      bytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      manifest,
      error,
      isRestorable: Boolean(manifest && !error),
    });
  }
  backups.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
  return { dir, backups };
}

/** Verify an archive without restoring it. */
/**
 * @param {any} db
 * @param {any} ctx
 * @param {string} archivePath
 */
/**
 * Remove a temporary database file together with whatever journal it left
 * behind. Opening a snapshot switches it to WAL mode, and a close does not
 * always unlink the journal (same platform behaviour as the live database);
 * these files are disposable, so every one of them goes — with retries,
 * because the platform may still be scanning them.
 */
function removeDatabaseWithJournals(path) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const target = `${path}${suffix}`;
    if (existsSync(target)) removeFileRetrying(target);
  }
}

/**
 * @param {any} db
 * @param {any} ctx
 * @param {string} archivePath
 * @returns {any}
 */
export function verifyBackup(db, ctx, archivePath) {
  if (!existsSync(archivePath)) throw new NotFoundError('backup', archivePath);
  const archive = readFileSync(archivePath);
  let entries;
  let manifest;
  try {
    entries = listZip(archive);
    const manifestEntry = entries.find((entry) => entry.name === MANIFEST_NAME);
    if (!manifestEntry) throw new Error('manifest missing');
    manifest = JSON.parse(readZipEntry(archive, manifestEntry).toString('utf8'));
  } catch (error) {
    throw new ValidationError('backup.invalidArchive', [
      { field: 'archive', key: 'backup.unreadable', params: { message: error instanceof Error ? error.message : String(error) } },
    ]);
  }
  const problems = [];
  let files = 0;

  for (const entry of entries) {
    if (entry.name === MANIFEST_NAME) continue;
    try {
      readZipEntry(archive, entry);
      files += 1;
    } catch (error) {
      problems.push({ name: entry.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const databaseEntry = entries.find((entry) => entry.name === DATABASE_NAME);
  let databaseOk = false;
  let schemaVersion = null;
  let counts = null;
  if (databaseEntry) {
    const databaseBytes = readZipEntry(archive, databaseEntry);
    databaseOk = !manifest.database?.sha256 || sha256(databaseBytes) === manifest.database.sha256;
    if (!databaseOk) problems.push({ name: DATABASE_NAME, reason: 'hash_mismatch' });
    const tempPath = join(ctx.dataDir ?? '.', `.verify-${process.pid}-${Date.now()}.db`);
    try {
      writeFileSync(tempPath, databaseBytes);
      const probe = openProbeDatabase(tempPath);
      const integrity = probe.query('PRAGMA integrity_check').get();
      const ok = Object.values(integrity ?? {})[0] === 'ok';
      if (!ok) problems.push({ name: DATABASE_NAME, reason: 'integrity_check_failed' });
      schemaVersion = Number(probe.query('SELECT COALESCE(MAX(id), 0) AS v FROM schema_migrations').get()?.v ?? 0);
      counts = {};
      for (const table of BACKUP_TABLE_COUNTS) {
        counts[table] = Number(probe.query(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c ?? 0);
      }
      try { probe.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
      probe.close();
    } catch (error) {
      problems.push({ name: DATABASE_NAME, reason: error instanceof Error ? error.message : String(error) });
    } finally {
      removeDatabaseWithJournals(tempPath);
    }
  } else {
    problems.push({ name: DATABASE_NAME, reason: 'missing' });
  }

  return {
    path: archivePath,
    bytes: archive.length,
    manifest,
    schemaVersion,
    counts,
    files,
    problems,
    ok: problems.length === 0 && databaseOk,
    compatible: schemaVersion === null ? false : schemaVersion >= SCHEMA_VERSION,
  };
}

/**
 * Describe a file well enough to say *why* an operation on it was refused.
 * @param {string} path
 */
function describeFile(path) {
  try {
    const stats = statSync(path);
    let share = 'in use';
    try {
      const handle = openSync(path, 'r+');
      closeSync(handle);
      share = 'writable';
    } catch (error) {
      share = `not writable (${error.code ?? error.message})`;
    }
    return `${basename(path)} ${stats.size}B, ${share}`;
  } catch (error) {
    return `${basename(path)} ${error.code ?? 'unreadable'}`;
  }
}

/**
 * The write-ahead log, shared memory and rollback journal of a database, if
 * any of them still exists.
 * @param {string} databasePath
 */
function journalFiles(databasePath) {
  const found = [];
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const path = `${databasePath}${suffix}`;
    if (existsSync(path)) found.push({ suffix, path });
  }
  return found;
}

/**
 * A replaced database must not inherit the previous database's journal.
 *
 * SQLite removes its write-ahead log when the last connection closes, but
 * Windows can refuse that removal while the platform still holds the file,
 * and a `-wal` left behind belongs to a database that is no longer there.
 * Opening the new file beside it asks SQLite to replay the old snapshot's
 * pages into the new one — which is not recovery, it is corruption, and it
 * shows up later as a database that reports "disk image is malformed".
 *
 * So a journal never meets a database it does not belong to: the old
 * database's journals are moved aside together with it, whatever survives
 * at the live name is removed with a proper budget, and if it still will
 * not go the restore fails and rolls back rather than risk it.
 *
 * @param {string} databasePath
 * @param {string} previousPath
 * @returns {string[]} the journal suffixes still held at the live name
 */
export function quarantineJournals(databasePath, previousPath) {
  const survivors = [];

  for (const { suffix, path } of journalFiles(databasePath)) {
    // A move only counts if the live name ends up clear: the copy fallback
    // of `replaceFile` can copy the journal aside and still fail to delete
    // the original, and a journal left at the live name is precisely the
    // hazard. So: try the move, then verify, then fall back to removal.
    let clear = false;

    try {
      replaceFile(path, `${previousPath}${suffix}`, { attempts: 3 });
      clear = !existsSync(path);
    } catch {
      clear = false;
    }

    while (!clear) {
      let removed = false;
      for (let attempt = 1; attempt <= 16; attempt += 1) {
        try {
          rmSync(path, { force: true });
          removed = true;
          break;
        } catch (error) {
          if (!isHeldError(error)) break;
          if (attempt === 16) break;
          sleepSync(Math.min(50 * attempt, 400));
        }
      }
      if (!removed) break;
      clear = !existsSync(path);
    }

    if (!clear) survivors.push(basename(path));
  }

  return survivors;
}


/**
 * Rename `from` over `to`, retrying while Windows still holds the file.
 *
 * SQLite has been closed by the time this runs, but Windows keeps a handle on a
 * file for a moment after the last one is released — anything that has just
 * been written is opened again by the platform's anti-malware scanner, and a
 * handle opened without delete sharing blocks a move for as long as it is held.
 * That is a condition, not a fault: a restore is an exclusive, seconds-long
 * operation, so waiting for the platform to let go is the right answer.
 *
 * If it never does, the bytes still have to reach the database file. When the
 * destination can be written, the copy is put through it instead — same file,
 * same contents, only the atomic swap is lost, and the pre-restore backup
 * covers that window. If even that fails, the real error is thrown with what
 * both paths were doing at the time.
 *
 * @param {string} from
 * @param {string} to
 * @param {{ attempts?: number }} [options]
 */
function replaceFile(from, to, { attempts = 16 } = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!isHeldError(error)) throw error;
      // 50 ms, 100 ms … up to 300 ms: long enough to outlast a scanner, short
      // enough that a genuinely stuck file still fails in a few seconds.
      sleepSync(Math.min(50 * attempt, 300));
    }
  }

  const detail = `source: ${describeFile(from)}; destination: ${describeFile(to)}`;

  try {
    copyFileSync(from, to);
    try {
      rmSync(from, { force: true });
    } catch {
      /* the staged copy is disposable; the database is in place */
    }
    console.warn(
      `[dentiva] the restored database was written through the existing file rather than ` +
        `renamed over it — Windows refused the rename (${lastError?.code}). ${detail}`,
    );
    return;
  } catch (error) {
    throw new Error(
      `could not put the restored database in place: ` +
        `rename failed with ${lastError?.code ?? lastError?.message} after ${attempts} attempts, ` +
        `copy failed with ${error.code ?? error.message} — ${detail}`,
    );
  }
}

/**
 * Restore a backup. The current database is snapshotted first so a failed or
 * regretted restore can be undone from the folder.
 */
export function restoreBackup(db, ctx, { archivePath, backupDir = null, dataDir = null, restoreAttachments = true }) {
  if (!existsSync(archivePath)) throw new NotFoundError('backup', archivePath);
  const targetDataDir = dataDir ?? ctx.dataDir;
  if (!targetDataDir) throw new FileError('files.storeUnavailable');
  const report = verifyBackup(db, { ...ctx, dataDir: targetDataDir }, archivePath);
  if (!report.ok) {
    throw new ValidationError('backup.corruptArchive', [{ field: 'archive', key: 'backup.verificationFailed', params: { problems: report.problems.length } }]);
  }
  const sourceSchema = report.schemaVersion ?? 0;
  if (sourceSchema > SCHEMA_VERSION) {
    throw new UnsupportedDatabaseError(sourceSchema, SCHEMA_VERSION);
  }

  const safety = createBackup(db, { ...ctx, dataDir: targetDataDir }, { backupDir: backupDir ?? defaultBackupDir(targetDataDir), kind: 'pre-restore', label: 'pre-restore' });
  const archive = readFileSync(archivePath);
  const files = extractZip(archive);
  const databaseBytes = files.get(DATABASE_NAME);
  if (!databaseBytes) throw new ValidationError('backup.invalidArchive', [{ field: 'archive', key: 'backup.missingDatabase' }]);

  const databasePath = currentDatabasePath();
  if (!databasePath) throw new FileError('backup.unreadable');
  const stagingPath = `${databasePath}.restoring`;
  writeFileSync(stagingPath, databaseBytes);

  // The old file is moved aside, the staged snapshot becomes the live database,
  // then migrations bring it up to the current schema.
  const previousPath = `${databasePath}.previous`;
  const hadDatabase = existsSync(databasePath);
  closeDatabase();
  if (hadDatabase) {
    try {
      replaceFile(databasePath, previousPath);
    } catch {
      /* keep going: the staged copy is still written below */
    }
  }
  // The old database's journals travel with it: they belong to the old
  // snapshot, and they must never meet the new one.
  const survivors = hadDatabase ? quarantineJournals(databasePath, previousPath) : [];
  replaceFile(stagingPath, databasePath);

  let migration = null;
  let restoredDb = null;
  try {
    if (survivors.length) {
      throw new Error(
        `restore aborted before first open: ${survivors.join(', ')} is still held ` +
          `by the operating system and must not meet the restored database`,
      );
    }
    restoredDb = openDatabase(databasePath);
    migration = migrate(restoredDb, { appVersion: APP_VERSION });
  } catch (error) {
    // Roll back to the pre-restore file so the app is never left unopenable.
    // If its own journals survived at the live name, they belong to this very
    // file, and opening it beside them is SQLite's normal crash-recovery path.
    closeDatabase();
    if (hadDatabase && existsSync(previousPath)) {
      removeFileRetrying(databasePath);
      replaceFile(previousPath, databasePath);
      for (const { suffix } of journalFiles(`${previousPath}`)) {
        try {
          replaceFile(`${previousPath}${suffix}`, `${databasePath}${suffix}`);
        } catch {
          /* best effort: the database itself is back */
        }
      }
      openDatabase(databasePath);
    }
    throw error;
  }
  if (!removeFileRetrying(previousPath)) {
    console.warn(
      `[dentiva] the pre-restore copy ${basename(previousPath)} could not be removed and ` +
        `has been left in the data folder`,
    );
  }
  for (const { suffix } of journalFiles(previousPath)) {
    if (!removeFileRetrying(`${previousPath}${suffix}`)) {
      console.warn(`[dentiva] ${basename(previousPath)}${suffix} could not be removed and has been left in the data folder`);
    }
  }

  let attachmentCount = 0;
  if (restoreAttachments) {
    for (const [name, data] of files) {
      if (!name.startsWith(ATTACHMENT_PREFIX)) continue;
      const relPath = name.slice(ATTACHMENT_PREFIX.length);
      const extension = validateExtension(relPath).extension;
      const absolutePath = resolveStoredPath(targetDataDir, relPath);
      ensureDir(join(absolutePath, '..'));
      writeFileSync(absolutePath, data);
      attachmentCount += 1;
      void extension;
    }
  }

  const counts = tableCounts(restoredDb);
  recordAudit(restoredDb, {
    clinicId: ctx.clinicId ?? null,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'backup_restore',
    module: 'backup',
    entity: 'backup',
    summary: `Backup restored from ${basename(archivePath)} (${attachmentCount} attachment file(s))`,
    severity: 'critical',
    after: { archive: archivePath, counts, safetyBackup: safety.path },
  });

  return {
    restored: true,
    archivePath,
    safetyBackup: safety.path,
    attachmentsRestored: attachmentCount,
    counts,
    migration,
    requiresRestart: true,
  };
}

/** Full data export (CSV files + manifest) as a ZIP the clinic can archive. */
/**
 * @param {any} db
 * @param {any} ctx
 * @param {{ backupDir?: string|null, includeAttachments?: boolean }} [options]
 */
export function exportData(db, ctx, { backupDir = null, includeAttachments = false } = {}) {
  if (!ctx.dataDir) throw new FileError('files.storeUnavailable');
  const targetDir = ensureDir(backupDir ?? defaultBackupDir(ctx.dataDir));
  const clinic = db.query('SELECT * FROM clinics WHERE id = ?').get(ctx.clinicId);
  const files = [];

  const tables = {
    patients: `SELECT patient_code, full_name, gender, dob, phone, phone_alt, email, address, city, postal_code, blood_group,
                      occupation, emergency_name, emergency_phone, registered_on, status
                 FROM patients WHERE clinic_id = ? AND deleted_at IS NULL`,
    visits: `SELECT visit_code, visit_date, visit_time, patient_id, chief_complaint, examination, diagnosis, instructions, followup_date
               FROM visits WHERE clinic_id = ? AND deleted_at IS NULL`,
    treatments: `SELECT id, patient_id, treatment_date, name, tooth_codes, status, fee_minor, discount_minor, tax_minor, total_minor, invoice_id
                   FROM treatments WHERE clinic_id = ? AND deleted_at IS NULL`,
    invoices: `SELECT invoice_number, invoice_date, due_date, status, patient_id, subtotal_minor, discount_minor, tax_minor, total_minor, paid_minor, due_minor
                 FROM invoices WHERE clinic_id = ? AND deleted_at IS NULL`,
    invoice_items: `SELECT i.invoice_number, it.description, it.quantity_milli, it.unit_price_minor, it.discount_minor, it.tax_minor, it.line_total_minor
                      FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id WHERE i.clinic_id = ?`,
    payments: `SELECT receipt_number, payment_date, kind, amount_minor, method_code, reference_no, patient_id, invoice_id, voided_at
                 FROM payments WHERE clinic_id = ? AND deleted_at IS NULL`,
    expenses: `SELECT expense_date, payee, amount_minor, method_code, description FROM expenses WHERE clinic_id = ? AND deleted_at IS NULL`,
    incomes: `SELECT income_date, source, amount_minor, method_code, description FROM incomes WHERE clinic_id = ? AND deleted_at IS NULL`,
    appointments: `SELECT appointment_code, appt_date, start_time, end_time, status, patient_id, type_label FROM appointments WHERE clinic_id = ? AND deleted_at IS NULL`,
    inventory: `SELECT sku, name, unit, quantity_milli, min_stock_milli, purchase_price_minor, sale_price_minor, expiry_date, condition FROM inventory_items WHERE clinic_id = ? AND deleted_at IS NULL`,
    stock_movements: `SELECT m.movement_date, i.name, m.kind, m.quantity_milli, m.balance_after_milli, m.reason FROM stock_movements m JOIN inventory_items i ON i.id = m.item_id WHERE m.clinic_id = ?`,
    staff: `SELECT staff_code, full_name, role_title, designation, phone, joining_date, salary_minor, salary_type, status FROM staff WHERE clinic_id = ? AND deleted_at IS NULL`,
    prescriptions: `SELECT rx_code, rx_date, patient_id, diagnosis, advice FROM prescriptions WHERE clinic_id = ? AND deleted_at IS NULL`,
    referrals: `SELECT referral_code, referral_date, patient_id, provider_name, specialty, status FROM referrals WHERE clinic_id = ? AND deleted_at IS NULL`,
  };

  const counts = {};
  for (const [name, sql] of Object.entries(tables)) {
    const rows = db.query(sql).all(ctx.clinicId);
    const columns = rows.length ? Object.keys(rows[0]).map((key) => ({ key })) : [{ key: 'empty' }];
    files.push({ name: `data/${name}.csv`, data: buildCsv(columns, rows) });
    counts[name] = rows.length;
  }

  if (includeAttachments) {
    const attachments = db.query('SELECT rel_path FROM attachments WHERE clinic_id = ?').all(ctx.clinicId);
    for (const attachment of attachments) {
      try {
        const absolutePath = resolveStoredPath(ctx.dataDir, attachment.rel_path);
        if (existsSync(absolutePath)) files.push({ name: `${ATTACHMENT_PREFIX}${attachment.rel_path}`, data: readFileSync(absolutePath) });
      } catch {
        /* skip unreadable files */
      }
    }
  }

  const manifest = {
    format: 'dentiva-data-export',
    formatVersion: 1,
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    clinic: clinic ? { code: clinic.code, name: clinic.name, currency: clinic.currency_code } : null,
    counts,
    includesAttachments: includeAttachments,
  };
  files.push({ name: MANIFEST_NAME, data: JSON.stringify(manifest, null, 2) });

  const archive = createZip(files);
  const fileName = `dentiva-data-${timestampLabel()}.zip`;
  const archivePath = join(targetDir, fileName);
  writeFileSync(archivePath, archive);

  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'data_export',
    module: 'backup',
    entity: 'export',
    summary: `Data export created (${Object.values(counts).reduce((sum, value) => sum + value, 0)} rows)`,
    severity: 'notice',
    after: { path: archivePath, counts, includesAttachments: includeAttachments },
  });

  return { path: archivePath, fileName, bytes: archive.length, counts, includesAttachments: includeAttachments };
}

/* ------------------------------------------------------------ CSV importing */

const patientImportSchema = {
  full_name: { type: 'string', required: true, minLength: 2, maxLength: 160 },
  gender: { type: 'enum', values: ['male', 'female', 'other'], required: true },
  phone: { type: 'string', maxLength: 32, nullable: true },
  phone_alt: { type: 'string', maxLength: 32, nullable: true },
  email: { type: 'string', maxLength: 160, nullable: true },
  dob: { type: 'date', nullable: true },
  address: { type: 'text', maxLength: 400, nullable: true },
  city: { type: 'string', maxLength: 80, nullable: true },
  blood_group: { type: 'string', maxLength: 8, nullable: true },
  occupation: { type: 'string', maxLength: 120, nullable: true },
  national_id: { type: 'string', maxLength: 40, nullable: true },
  emergency_name: { type: 'string', maxLength: 160, nullable: true },
  emergency_phone: { type: 'string', maxLength: 32, nullable: true },
  notes: { type: 'text', maxLength: 2000, nullable: true },
};

/**
 * Import patients from a CSV file with per-row validation.
 * @param {any} db
 * @param {any} ctx
 * @param {string} csvText
 * @param {{ dryRun?: boolean, defaultGender?: string|null }} [options]
 */
export function importPatients(db, ctx, csvText, { dryRun = false, defaultGender = null } = {}) {
  const parsed = parseCsv(csvText);
  if (!parsed.rows.length) throw new ValidationError('import.emptyFile', [{ field: 'file', key: 'import.noRows' }]);

  const results = [];
  let created = 0;
  let failed = 0;
  let skipped = 0;

  for (const [index, row] of parsed.rows.entries()) {
    const rowNumber = index + 2; // header + 1-based
    const normalised = {
      full_name: row.full_name || row.name || row['patient_name'] || '',
      gender: (row.gender || defaultGender || '').toLowerCase(),
      phone: row.phone || row.mobile || null,
      phone_alt: row.phone_alt || null,
      email: row.email || null,
      dob: row.dob || row.date_of_birth || null,
      address: row.address || null,
      city: row.city || null,
      blood_group: row.blood_group || null,
      occupation: row.occupation || null,
      national_id: row.national_id || row.nid || null,
      emergency_name: row.emergency_name || null,
      emergency_phone: row.emergency_phone || null,
      notes: row.notes || null,
    };
    if (!normalised.full_name.trim()) {
      results.push({ row: rowNumber, status: 'failed', errors: [{ field: 'full_name', key: 'validation.required' }] });
      failed += 1;
      continue;
    }
    if (!['male', 'female', 'other'].includes(normalised.gender)) {
      results.push({ row: rowNumber, status: 'failed', errors: [{ field: 'gender', key: 'validation.option' }] });
      failed += 1;
      continue;
    }
    try {
      assertValid(normalised, patientImportSchema);
      if (dryRun) {
        results.push({ row: rowNumber, status: 'ready', name: normalised.full_name });
        created += 1;
        continue;
      }
      const patient = createPatient(db, ctx, normalised);
      results.push({ row: rowNumber, status: 'created', patientId: patient.id, patientCode: patient.patientCode, name: normalised.full_name });
      created += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ row: rowNumber, status: 'failed', errors: [{ field: 'row', key: 'import.rowFailed', params: { message } }] });
      failed += 1;
    }
  }

  if (!dryRun) {
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'import_patients',
      module: 'backup',
      entity: 'import',
      summary: `Patient import: ${created} created, ${failed} failed of ${parsed.rows.length} row(s)`,
      severity: failed ? 'warning' : 'notice',
      after: { created, failed, total: parsed.rows.length },
    });
  }

  return { dryRun, total: parsed.rows.length, created, failed, skipped, results: results.slice(0, 500) };
}

/** Import stock movement / expense style CSV is intentionally not included.
 *  Data import stays limited to patients, which is the only entity where an
 *  operator can be expected to hold a clean list; everything else is exported
 *  for the accountant rather than re-imported. */
export const IMPORT_SUPPORTED = ['patients'];

export { csvBoolean, todayIso, copyFileSync };
