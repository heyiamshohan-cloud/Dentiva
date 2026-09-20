/**
 * Automatic backups (scheduler).
 *
 * The clinic computer is switched off at night, so the rules have to answer two
 * questions correctly: "is a run due right now?" and "the machine was off at
 * 20:30 yesterday — should we run when it starts again?" Both are covered here,
 * plus a real end-to-end run that writes an archive, records it in the audit log
 * and sets `backup.lastRunAt`.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, closeDatabase } from '../../src/server/db/connection.js';
import { migrate } from '../../src/server/db/migrations/index.js';
import { provisionClinic } from '../../src/server/services/clinic.js';
import { setSettings, getSettings } from '../../src/server/services/settings.js';
import { backupDue, runDueBackups, nextScheduledAt, scheduledBackupDir } from '../../src/server/services/scheduler.js';
import { listBackups } from '../../src/server/services/backup.js';

const at = (text) => new Date(text);

describe('automatic backup — when is a run due', () => {
  const daily = { frequency: 'daily', time: '20:30' };

  test('never run before → due once the time has passed', () => {
    expect(backupDue(daily, null, at('2026-09-20T20:29:00')).due).toBe(false);
    expect(backupDue(daily, null, at('2026-09-20T20:30:00'))).toEqual({ due: true, reason: 'never-run', periodKey: '2026-09-20' });
  });

  test('already run today → not due again', () => {
    expect(backupDue(daily, '2026-09-20T20:31:00', at('2026-09-20T23:00:00')).due).toBe(false);
    expect(backupDue(daily, '2026-09-19T20:31:00', at('2026-09-20T19:00:00')).due).toBe(false);
    // …but the next evening it is due again (the offline catch-up case).
    expect(backupDue(daily, '2026-09-19T20:31:00', at('2026-09-20T20:30:00')).due).toBe(true);
  });

  test('manual frequency never runs by itself', () => {
    expect(backupDue({ frequency: 'manual', time: '20:30' }, null, at('2026-09-20T23:00:00')).due).toBe(false);
    expect(backupDue({ frequency: 'off', time: '20:30' }, null, at('2026-09-20T23:00:00')).due).toBe(false);
  });

  test('weekly runs after seven days, monthly after the month changes', () => {
    const weekly = { frequency: 'weekly', time: '20:30' };
    expect(backupDue(weekly, '2026-09-14T20:31:00', at('2026-09-20T21:00:00')).due).toBe(false); // 6 days
    expect(backupDue(weekly, '2026-09-13T20:31:00', at('2026-09-20T20:31:00')).due).toBe(true); // 7 days

    const monthly = { frequency: 'monthly', time: '20:30' };
    expect(backupDue(monthly, '2026-09-01T20:31:00', at('2026-09-28T21:00:00')).due).toBe(false);
    expect(backupDue(monthly, '2026-09-28T20:31:00', at('2026-10-01T20:31:00')).due).toBe(true);
  });

  test('a clock that jumps backwards does not cause a second run in the same day', () => {
    expect(backupDue(daily, '2026-09-20T20:31:00', at('2026-09-20T20:45:00')).due).toBe(false);
  });

  test('next scheduled time is the next slot in the future', () => {
    const next = nextScheduledAt({ 'backup.time': '20:30', 'backup.frequency': 'daily' }, at('2026-09-20T09:00:00'));
    expect(next?.getHours()).toBe(20);
    expect(nextScheduledAt({ 'backup.time': '20:30', 'backup.frequency': 'manual' }, at('2026-09-20T09:00:00'))).toBeNull();
  });

  test('the configured folder is used, and a relative one stays inside the data folder', () => {
    expect(scheduledBackupDir({ 'backup.location': '' }, '/data')).toBe(join('/data', 'backups'));
    expect(scheduledBackupDir({ 'backup.location': 'extra/backups' }, '/data')).toBe(join('/data', 'extra/backups'));
  });
});

describe('automatic backup — running it', () => {
  let db;
  let dir;
  let clinicId;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dentiva-sched-'));
    db = openDatabase(join(dir, 'dentiva.db'));
    migrate(db, { appVersion: 'test' });
    const provisioned = provisionClinic(db, {
      clinic: { code: 'SCHED', name: 'Schedule Test Clinic', phone: '01700000000', country: 'Bangladesh', currency_code: 'BDT', currency_symbol: '৳', locale: 'en' },
      dentist: { full_name: 'Dr. Test' },
      admin: { username: 'schedadmin', display_name: 'Schedule Admin', password: 'Sched#2026A' },
    });
    clinicId = provisioned.clinicId;
  });

  afterEach(async () => {
    try {
      closeDatabase();
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 80));
    let lastError = null;
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const code = error?.code;
        const transient = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY' || code === 'EACCES';
        if (!transient || attempt === 8) break;
        await new Promise((r) => setTimeout(r, 120 * attempt));
      }
    }
    if (lastError) throw new Error(`Failed to remove temporary directory '${dir}' after 8 attempts (${lastError.code}: ${lastError.message})`);
  });

  test('a due clinic gets a verified archive and a last-run stamp', () => {
    setSettings(db, clinicId, { 'backup.frequency': 'daily', 'backup.time': '20:30' });
    const results = runDueBackups(db, { dataDir: dir, now: at('2026-09-20T21:00:00') });

    expect(results.length).toBe(1);
    expect(results[0].ran).toBe(true);
    expect(results[0].fileName).toBeTruthy();
    expect(results[0].verified).toBe(true);
    const archived = join(dir, 'backups', String(results[0].fileName));
    expect(existsSync(archived)).toBe(true);
    expect(getSettings(db, clinicId)['backup.lastRunAt']).toContain('T');

    const audit = db.query("SELECT action, summary FROM audit_logs WHERE clinic_id = ? AND action = 'backup_schedule'").all(clinicId);
    expect(audit.length).toBe(1);
    expect(String(audit[0].summary)).toContain('Automatic backup');
    const notification = db.query("SELECT title_key FROM notifications WHERE clinic_id = ? AND kind = 'system'").all(clinicId);
    expect(notification.length).toBe(1);
    expect(notification[0].title_key).toBe('notifications.backup_created.title');
  }, 30000);

  test('the same clinic is not backed up twice in one day', () => {
    setSettings(db, clinicId, { 'backup.frequency': 'daily', 'backup.time': '20:30' });
    runDueBackups(db, { dataDir: dir, now: at('2026-09-20T21:00:00') });
    const second = runDueBackups(db, { dataDir: dir, now: at('2026-09-20T21:05:00') });
    expect(second[0]).toMatchObject({ ran: false, reason: 'recent' });
    expect(listBackups(db, { clinicId, dataDir: dir }).backups.length).toBe(1);
  }, 30000);

  test('the switch, the folder and the retention count are honoured', () => {
    setSettings(db, clinicId, {
      'backup.autoEnabled': false,
      'backup.location': 'shared-backups',
      'backup.retentionCount': 2,
      'backup.includeAttachments': false,
    });
    expect(runDueBackups(db, { dataDir: dir, now: at('2026-09-20T21:00:00') })[0]).toMatchObject({ ran: false, reason: 'disabled' });
    expect(existsSync(join(dir, 'shared-backups'))).toBe(false);

    setSettings(db, clinicId, { 'backup.autoEnabled': true });
    runDueBackups(db, { dataDir: dir, now: at('2026-09-20T21:00:00') });
    expect(existsSync(join(dir, 'shared-backups'))).toBe(true);
    expect(listBackups(db, { clinicId, dataDir: dir }, { backupDir: join(dir, 'shared-backups') }).backups.length).toBe(1);

    // Retention keeps the newest N archives as more are written.
    for (const day of ['2026-09-21', '2026-09-22']) {
      db.run("DELETE FROM settings WHERE clinic_id = ? AND key = 'backup.lastRunAt'", [clinicId]);
      runDueBackups(db, { dataDir: dir, now: at(`${day}T21:00:00`) });
    }
    const kept = readdirSync(join(dir, 'shared-backups')).filter((name) => name.endsWith('.zip'));
    expect(kept.length).toBe(2);
  }, 60000);
});
