/**
 * Background scheduler.
 *
 * A clinic computer is switched off at night, so "run a backup at 20:30" cannot
 * rely on a timer alone: the scheduler also performs a catch-up run on the first
 * tick after start-up when a scheduled slot has passed unattended.
 *
 * Only one job exists — automatic backups — but the mechanism is deliberately
 * generic (`isDue` + `run`) so a future job does not need a second timer.
 *
 * Each clinic keeps its own schedule in the settings table:
 *
 *   backup.autoEnabled     master switch                     (default true)
 *   backup.frequency       daily | weekly | monthly | manual (default daily)
 *   backup.time            HH:MM in local time               (default 20:30)
 *   backup.retentionCount  how many archives to keep         (default 14)
 *   backup.includeAttachments  attach files to the archive    (default true)
 *   backup.verifyAfterCreate   re-open and hash-check it      (default true)
 *   backup.location        folder override, '' = data dir     (default '')
 *   backup.lastRunAt       ISO timestamp written after a run  (managed here)
 */
import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { all, get } from '../db/connection.js';
import { createBackup, defaultBackupDir, verifyBackup } from './backup.js';
import { getSettings, setSettings } from './settings.js';
import { notify } from './notifications.js';
import { recordAudit } from './audit.js';
import { addDays, nowIso, todayIso } from '../domain/dates.js';

/** How often the scheduler wakes up. */
export const TICK_MS = 5 * 60 * 1000;

/** Frequencies that mean "a human presses the button". */
const MANUAL = new Set(['manual', 'off', 'none', '']);

/**
 * The instant a schedule last became due, or `null` when it is not due at all.
 * Kept pure so the rules can be tested without waiting for a clock.
 *
 * @param {{ frequency?: string, time?: string|null }} schedule
 * @param {string|null} lastRunAt ISO timestamp of the previous run
 * @param {Date} [now]
 * @returns {{ due: boolean, reason?: string, periodKey?: string }}
 */
export function backupDue(schedule, lastRunAt, now = new Date()) {
  const frequency = String(schedule?.frequency ?? 'daily').toLowerCase();
  if (MANUAL.has(frequency)) return { due: false, reason: 'manual' };

  const [hourText, minuteText] = String(schedule?.time ?? '20:30').split(':');
  const hour = Math.min(23, Math.max(0, Number(hourText) || 0));
  const minute = Math.min(59, Math.max(0, Number(minuteText) || 0));
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (now < at) return { due: false, reason: 'before-time' };

  const previous = lastRunAt ? new Date(lastRunAt) : null;
  if (previous && Number.isNaN(previous.getTime())) return { due: true, reason: 'never-run', periodKey: periodKey(frequency, now) };
  if (!previous) return { due: true, reason: 'never-run', periodKey: periodKey(frequency, now) };

  if (frequency === 'weekly') {
    if (now.getTime() - previous.getTime() >= 7 * 86400000) return { due: true, reason: 'week-elapsed', periodKey: periodKey(frequency, now) };
    return { due: false, reason: 'recent' };
  }
  if (frequency === 'monthly') {
    const sameMonth = previous.getFullYear() === now.getFullYear() && previous.getMonth() === now.getMonth();
    if (!sameMonth) return { due: true, reason: 'month-elapsed', periodKey: periodKey(frequency, now) };
    return { due: false, reason: 'recent' };
  }
  const ranToday = previous.getFullYear() === now.getFullYear() && previous.getMonth() === now.getMonth() && previous.getDate() === now.getDate();
  return ranToday ? { due: false, reason: 'recent' } : { due: true, reason: 'day-elapsed', periodKey: periodKey(frequency, now) };
}

/** @param {string} frequency @param {Date} now */
function periodKey(frequency, now) {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (frequency === 'monthly') return day.slice(0, 7);
  if (frequency === 'weekly') return `week-of-${day}`;
  return day;
}

/**
 * Where a clinic's scheduled archives should be written.
 * @param {Record<string, any>} settings
 * @param {string} dataDir
 */
export function scheduledBackupDir(settings, dataDir) {
  const configured = String(settings['backup.location'] ?? '').trim();
  if (!configured) return defaultBackupDir(dataDir);
  return isAbsolute(configured) ? configured : join(dataDir, configured);
}

/** Clinics that have produced at least one user (i.e. are set up). @param {any} db */
function activeClinics(db) {
  return all(db, 'SELECT id, name FROM clinics WHERE deleted_at IS NULL ORDER BY id').map((row) => ({
    id: Number(row.id),
    name: row.name,
  }));
}

/**
 * Run every backup that is due. Safe to call as often as you like; a clinic that
 * is not due costs one settings read.
 *
 * @param {any} db
 * @param {any} db
 * @param {{ dataDir: string, now?: Date, clinics?: {id:number,name?:string|null}[]|null }} options
 * @returns {{ clinicId: number, ran: boolean, reason: string, fileName?: string, bytes?: number, verified?: boolean, error?: string }[]}
 */
export function runDueBackups(db, options) {
  const { dataDir, now = new Date(), clinics = null } = options;
  /** @type {{ clinicId: number, ran: boolean, reason: string, fileName?: string, bytes?: number, verified?: boolean, error?: string }[]} */
  const results = [];
  for (const clinic of clinics ?? activeClinics(db)) {
    const settings = getSettings(db, clinic.id);
    if (settings['backup.autoEnabled'] === false) {
      results.push({ clinicId: clinic.id, ran: false, reason: 'disabled' });
      continue;
    }
    const due = backupDue(
      { frequency: settings['backup.frequency'], time: settings['backup.time'] },
      settings['backup.lastRunAt'] ?? null,
      now,
    );
    if (!due.due) {
      results.push({ clinicId: clinic.id, ran: false, reason: due.reason ?? 'not-due' });
      continue;
    }

    const ctx = { clinicId: clinic.id, user: null, dataDir };
    const backupDir = scheduledBackupDir(settings, dataDir);
    try {
      if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
      const created = createBackup(db, ctx, {
        backupDir,
        kind: 'auto',
        label: 'auto',
        includeAttachments: settings['backup.includeAttachments'] !== false,
      });
      let verified = false;
      if (settings['backup.verifyAfterCreate'] !== false) {
        verified = Boolean(verifyBackup(db, ctx, created.path)?.ok);
      }
      // Stamp the moment the schedule considered due (the injected clock in a
      // test, the wall clock in production) so a second tick in the same period
      // is a no-op.
      setSettings(db, clinic.id, { 'backup.lastRunAt': now.toISOString() }, null);
      recordAudit(db, {
        clinicId: clinic.id,
        userId: null,
        userName: 'Scheduled task',
        action: 'backup_schedule',
        module: 'backup',
        entity: 'backup',
        entityId: null,
        summary: `Automatic backup (${settings['backup.frequency'] ?? 'daily'}${verified ? ', verified' : ''}) — ${created.fileName}`,
        severity: 'notice',
        after: { path: created.path, bytes: created.bytes, verified },
      });
      notify(db, ctx, {
        kind: 'system',
        severity: verified ? 'info' : 'warning',
        titleKey: 'notifications.backup_created.title',
        titleParams: { file: created.fileName },
        bodyKey: verified ? 'notifications.backup_created.body' : 'notifications.backup_created.unverified',
        entity: 'backup',
        link: '/backup',
        dedupeKey: `backup-created:${due.periodKey ?? todayIso()}`,
      });
      results.push({ clinicId: clinic.id, ran: true, reason: due.reason ?? 'due', fileName: created.fileName, bytes: created.bytes, verified });
    } catch (error) {
      // A failed backup must never stop the clock: report it, keep the last-run
      // timestamp untouched so the next tick retries, and carry on.
      const message = error instanceof Error ? error.message : String(error);
      try {
        recordAudit(db, {
          clinicId: clinic.id,
          userId: null,
          userName: 'Scheduled task',
          action: 'backup_schedule_failed',
          module: 'backup',
          entity: 'backup',
          entityId: null,
          summary: `Automatic backup failed: ${message}`,
          severity: 'error',
        });
        notify(db, ctx, {
          kind: 'system',
          severity: 'critical',
          titleKey: 'notifications.backup_failed.title',
          titleParams: { message },
          bodyKey: 'notifications.backup_failed.body',
          entity: 'backup',
          link: '/backup',
          dedupeKey: `backup-failed:${todayIso()}`,
        });
      } catch {
        /* notification is best-effort */
      }
      results.push({ clinicId: clinic.id, ran: false, reason: 'error', error: message });
    }
  }
  return results;
}

/** @type {ReturnType<typeof setInterval>|null} */
let timer = null;
/** @type {(() => void)|null} */
let cancelFirstTick = null;

/**
 * Start the background tick.
 * @param {{ db: any, dataDir: string, quiet?: boolean, intervalMs?: number }} options
 */
export function startScheduler({ db, dataDir, quiet = false, intervalMs = TICK_MS }) {
  if (timer) return { started: false, reason: 'already-running' };
  const tick = () => {
    try {
      const results = runDueBackups(db, { dataDir });
      if (!quiet) {
        for (const result of results) {
          if (result.ran) console.log(`[dentiva] automatic backup for clinic ${result.clinicId}: ${result.fileName}${result.verified ? ' (verified)' : ''}`);
          else if (result.error) console.warn(`[dentiva] automatic backup failed for clinic ${result.clinicId}: ${result.error}`);
        }
      }
    } catch (error) {
      if (!quiet) console.warn(`[dentiva] scheduler tick failed: ${error instanceof Error ? error.message : error}`);
    }
  };
  // First tick shortly after start-up (catch-up), then every `intervalMs`.
  const first = setTimeout(tick, 10_000);
  if (typeof first.unref === 'function') first.unref();
  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  cancelFirstTick = () => clearTimeout(first);
  return { started: true, intervalMs };
}

/** Stop the background tick (tests and shutdown). */
export function stopScheduler() {
  if (timer) clearInterval(timer);
  if (cancelFirstTick) cancelFirstTick();
  timer = null;
  cancelFirstTick = null;
  return { stopped: true };
}

/** Exposed for tests: the last seven days of due-checks, used by the README. */
export function nextScheduledAt(settings, now = new Date()) {
  const [hourText, minuteText] = String(settings?.['backup.time'] ?? '20:30').split(':');
  const hour = Math.min(23, Math.max(0, Number(hourText) || 0));
  const minute = Math.min(59, Math.max(0, Number(minuteText) || 0));
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
  const frequency = String(settings?.['backup.frequency'] ?? 'daily').toLowerCase();
  if (MANUAL.has(frequency)) return null;
  if (frequency === 'weekly') candidate.setDate(candidate.getDate() + 6);
  if (frequency === 'monthly') candidate.setMonth(candidate.getMonth() + 1);
  return candidate;
}

/** Convenience for the backup screen: when the next automatic run happens. */
export function scheduleSummary(db, clinicId) {
  const settings = getSettings(db, clinicId);
  const next = nextScheduledAt(settings, new Date());
  const last = get(db, 'SELECT value FROM settings WHERE clinic_id = ? AND key = ?', [clinicId, 'backup.lastRunAt']);
  return {
    enabled: settings['backup.autoEnabled'] !== false,
    frequency: settings['backup.frequency'] ?? 'daily',
    time: settings['backup.time'] ?? '20:30',
    nextRunAt: next ? next.toISOString() : null,
    lastRunAt: last?.value ?? settings['backup.lastRunAt'] ?? null,
    retentionCount: Number(settings['backup.retentionCount'] ?? 14),
    reminderDueDays: Number(settings['backup.reminderDays'] ?? 7),
  };
}

export default { backupDue, runDueBackups, startScheduler, stopScheduler, scheduleSummary, nextScheduledAt, TICK_MS, scheduledBackupDir };
