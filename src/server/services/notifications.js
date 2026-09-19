/**
 * In-app notification centre (§ 51).
 *
 * Notifications are stored, not pushed: they are generated from real data
 * (appointments, follow-ups, dues, stock) on demand, de-duplicated by key, and
 * never leave the machine. Every user sees the clinic feed plus their own
 * per-user entries; reading or dismissing is per user.
 */
import { all, get, run, withTransaction, nowIso } from '../db/connection.js';
import { resolvePaging } from '../db/query.js';
import { NOTIFICATION_KINDS, AUDIT_SEVERITIES } from '../../shared/constants.js';
import { addDays, todayIso, nowIso as nowIsoDate } from '../domain/dates.js';
import { getSettings } from './settings.js';

const DEFAULT_KIND_SETTINGS = {
  appointment_upcoming: true,
  followup_due: true,
  outstanding_payment: true,
  low_stock: true,
  expiring_stock: true,
  backup_reminder: true,
  recall_due: true,
  system: true,
};

export function shapeNotification(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    kind: row.kind,
    severity: row.severity,
    titleKey: row.title_key,
    titleParams: safeParse(row.title_params, {}),
    bodyKey: row.body_key,
    bodyParams: safeParse(row.body_params, {}),
    entity: row.entity,
    entityId: row.entity_id ?? null,
    link: row.link,
    dueAt: row.due_at,
    isRead: Boolean(row.read_at),
    isDismissed: Boolean(row.dismissed_at),
    createdAt: row.created_at,
  };
}

function safeParse(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Insert a notification unless an identical (dedupe key) one already exists.
 * @returns {{ id: number|null, created: boolean, reason?: string|null }}
 */
export function notify(db, ctx, input) {
  const kind = NOTIFICATION_KINDS.includes(input.kind) ? input.kind : 'system';
  const severity = AUDIT_SEVERITIES.includes(input.severity) ? input.severity : 'info';
  const settings = getSettings(db, ctx.clinicId);
  const kindSettings = { ...DEFAULT_KIND_SETTINGS, ...safeParse(settings['notifications.kinds'], {}) };
  if (settings['notifications.enabled'] === false) return { id: null, created: false, reason: 'disabled' };
  if (kindSettings[kind] === false) return { id: null, created: false, reason: 'kind_disabled' };

  const userId = input.userId ?? null;
  // `ux_notifications_dedupe` is unique across the whole file, so the clinic is
  // part of every key (a second clinic must never swallow another's reminder).
  const dedupe = input.dedupeKey ? `c${ctx.clinicId}:${input.dedupeKey}` : null;
  if (dedupe) {
    const existing = get(
      db,
      `SELECT id FROM notifications
        WHERE clinic_id = ? AND kind = ? AND dedupe_key = ?
          AND dismissed_at IS NULL AND created_at >= ?`,
      [ctx.clinicId, kind, dedupe, addDays(todayIso(), -30)],
    );
    if (existing) return { id: Number(existing.id), created: false, reason: 'duplicate' };
  }

  const result = run(
    db,
    `INSERT INTO notifications
      (clinic_id, user_id, kind, severity, title_key, title_params, body_key, body_params, entity, entity_id, link, due_at, dedupe_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      ctx.clinicId,
      userId,
      kind,
      severity,
      input.titleKey ?? `notifications.${kind}.title`,
      JSON.stringify(input.titleParams ?? {}),
      input.bodyKey ?? null,
      JSON.stringify(input.bodyParams ?? {}),
      input.entity ?? null,
      input.entityId ?? null,
      input.link ?? null,
      input.dueAt ?? null,
      dedupe,
    ],
  );
  return { id: Number(result.lastInsertRowid), created: true };
}

/**
 * @param {any} db
 * @param {any} ctx
 * @param {Record<string, any>} [params]
 */
export function listNotifications(db, ctx, params = {}) {
  const where = ['clinic_id = ?', '(user_id IS NULL OR user_id = ?)'];
  const args = [ctx.clinicId, ctx.user?.id ?? 0];
  if (params.unreadOnly === true || params.unreadOnly === 'true') where.push('read_at IS NULL');
  if (params.includeDismissed !== true && params.includeDismissed !== 'true') where.push('dismissed_at IS NULL');
  if (params.kind && NOTIFICATION_KINDS.includes(params.kind)) {
    where.push('kind = ?');
    args.push(params.kind);
  }
  if (params.severity && AUDIT_SEVERITIES.includes(params.severity)) {
    where.push('severity = ?');
    args.push(params.severity);
  }
  const page = resolvePaging(params);
  const whereSql = where.join(' AND ');
  const total = Number(get(db, `SELECT COUNT(*) AS c FROM notifications WHERE ${whereSql}`, args)?.c ?? 0);
  const rows = all(
    db,
    `SELECT * FROM notifications WHERE ${whereSql} ORDER BY (read_at IS NULL) DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...args, page.pageSize, page.offset],
  );
  const counts = get(
    db,
    `SELECT
        SUM(CASE WHEN read_at IS NULL AND dismissed_at IS NULL THEN 1 ELSE 0 END) AS unread,
        SUM(CASE WHEN severity = 'warning' AND read_at IS NULL THEN 1 ELSE 0 END) AS warnings,
        SUM(CASE WHEN severity = 'critical' AND read_at IS NULL THEN 1 ELSE 0 END) AS critical
      FROM notifications WHERE clinic_id = ? AND (user_id IS NULL OR user_id = ?) AND dismissed_at IS NULL`,
    [ctx.clinicId, ctx.user?.id ?? 0],
  );
  return {
    rows: rows.map(shapeNotification),
    total,
    page: page.page,
    pageSize: page.pageSize,
    pages: Math.max(1, Math.ceil(total / page.pageSize)),
    unread: Number(counts?.unread ?? 0),
    warnings: Number(counts?.warnings ?? 0),
    critical: Number(counts?.critical ?? 0),
  };
}

export function unreadCount(db, ctx) {
  const row = get(
    db,
    `SELECT COUNT(*) AS c FROM notifications
      WHERE clinic_id = ? AND (user_id IS NULL OR user_id = ?) AND read_at IS NULL AND dismissed_at IS NULL`,
    [ctx.clinicId, ctx.user?.id ?? 0],
  );
  return Number(row?.c ?? 0);
}

function setNotificationState(db, ctx, notificationId, column) {
  const row = get(db, 'SELECT * FROM notifications WHERE id = ? AND clinic_id = ?', [notificationId, ctx.clinicId]);
  if (!row) return { updated: false };
  if (row.user_id !== null && row.user_id !== ctx.user?.id) return { updated: false };
  run(db, `UPDATE notifications SET ${column} = ?, updated_at = ? WHERE id = ?`, [nowIsoDate(), nowIso(), notificationId]);
  return { updated: true };
}

/**
 * @param {any} db
 * @param {any} ctx
 * @param {number} notificationId
 */
export function markRead(db, ctx, notificationId) {
  return setNotificationState(db, ctx, notificationId, 'read_at');
}

export function markUnread(db, ctx, notificationId) {
  const row = get(db, 'SELECT * FROM notifications WHERE id = ? AND clinic_id = ?', [notificationId, ctx.clinicId]);
  if (!row) return { updated: false };
  run(db, 'UPDATE notifications SET read_at = NULL, updated_at = ? WHERE id = ?', [nowIso(), notificationId]);
  return { updated: true };
}

export function dismiss(db, ctx, notificationId) {
  return setNotificationState(db, ctx, notificationId, 'dismissed_at');
}

export function markAllRead(db, ctx, { kind = null } = {}) {
  const params = [nowIsoDate(), nowIso(), ctx.clinicId, ctx.user?.id ?? 0];
  let filter = '';
  if (kind && NOTIFICATION_KINDS.includes(kind)) {
    filter = ' AND kind = ?';
    params.push(kind);
  }
  run(
    db,
    `UPDATE notifications SET read_at = ?, updated_at = ?
      WHERE clinic_id = ? AND (user_id IS NULL OR user_id = ?) AND read_at IS NULL${filter}`,
    params,
  );
  return { ok: true, unread: unreadCount(db, ctx) };
}

export function clearDismissed(db, ctx, { olderThanDays = 30 } = {}) {
  const result = run(
    db,
    'DELETE FROM notifications WHERE clinic_id = ? AND dismissed_at IS NOT NULL AND created_at < ?',
    [ctx.clinicId, addDays(todayIso(), -Math.max(1, olderThanDays))],
  );
  return { removed: Number(result.changes ?? 0) };
}

/* ------------------------------------------------------- notification sources */

/**
 * Rebuild the notification feed from live data. Safe to call on every dashboard
 * load: existing notifications are recreated only when their dedupe key is gone.
 */
export function refreshNotifications(db, ctx) {
  const settings = getSettings(db, ctx.clinicId);
  const created = [];

  return withTransaction(db, () => {
    // 1. Appointments in the next `lead` minutes / today.
    const upcoming = all(
      db,
      `SELECT a.id, a.appointment_code, a.start_time, a.appt_date, p.full_name, p.patient_code
         FROM appointments a JOIN patients p ON p.id = a.patient_id
        WHERE a.clinic_id = ? AND a.deleted_at IS NULL AND a.status IN ('scheduled','checked_in')
          AND a.appt_date BETWEEN ? AND ?
        ORDER BY a.appt_date, a.start_time LIMIT 50`,
      [ctx.clinicId, todayIso(), addDays(todayIso(), 1)],
    );
    for (const appointment of upcoming) {
      const outcome = notify(db, ctx, {
        kind: 'appointment_upcoming',
        severity: 'info',
        titleKey: 'notifications.appointment_upcoming.title',
        titleParams: { patient: appointment.full_name, time: appointment.start_time },
        bodyKey: 'notifications.appointment_upcoming.body',
        bodyParams: { code: appointment.appointment_code, date: appointment.appt_date, time: appointment.start_time },
        entity: 'appointment',
        entityId: appointment.id,
        link: `/appointments/${appointment.id}`,
        dueAt: `${appointment.appt_date}T${appointment.start_time}`,
        dedupeKey: `appointment:${appointment.id}`,
      });
      if (outcome.created) created.push(outcome.id);
    }

    // 2. Follow-ups due within the configured look-ahead.
    const lookahead = Number(settings['notifications.followupLookaheadDays'] ?? 3);
    const followups = all(
      db,
      `SELECT v.id, v.visit_code, v.followup_date, p.full_name, p.patient_code, p.id AS patient_id
         FROM visits v JOIN patients p ON p.id = v.patient_id
        WHERE v.clinic_id = ? AND v.deleted_at IS NULL AND v.followup_date IS NOT NULL
          AND v.followup_date BETWEEN ? AND ?
        ORDER BY v.followup_date LIMIT 50`,
      [ctx.clinicId, todayIso(), addDays(todayIso(), Math.max(1, lookahead))],
    );
    for (const visit of followups) {
      const overdue = visit.followup_date < todayIso();
      const outcome = notify(db, ctx, {
        kind: 'followup_due',
        severity: overdue ? 'warning' : 'info',
        titleKey: overdue ? 'notifications.followup_due.overdue' : 'notifications.followup_due.title',
        titleParams: { patient: visit.full_name, date: visit.followup_date },
        bodyKey: 'notifications.followup_due.body',
        bodyParams: { visit: visit.visit_code },
        entity: 'visit',
        entityId: visit.id,
        link: `/patients/${visit.patient_id}`,
        dueAt: visit.followup_date,
        dedupeKey: `followup:${visit.id}`,
      });
      if (outcome.created) created.push(outcome.id);
    }

    // 3. Invoices past their due date.
    const overdue = all(
      db,
      `SELECT i.id, i.invoice_number, i.due_date, i.due_minor, p.full_name, p.id AS patient_id
         FROM invoices i JOIN patients p ON p.id = i.patient_id
        WHERE i.clinic_id = ? AND i.deleted_at IS NULL AND i.status = 'issued' AND i.due_minor > 0
          AND i.due_date IS NOT NULL AND i.due_date < ?
        ORDER BY i.due_date LIMIT 50`,
      [ctx.clinicId, todayIso()],
    );
    for (const invoice of overdue) {
      const outcome = notify(db, ctx, {
        kind: 'outstanding_payment',
        severity: 'warning',
        titleKey: 'notifications.outstanding_payment.title',
        titleParams: { patient: invoice.full_name, amount: Math.round(invoice.due_minor / 100) / 100 },
        bodyKey: 'notifications.outstanding_payment.body',
        bodyParams: { invoice: invoice.invoice_number, dueDate: invoice.due_date },
        entity: 'invoice',
        entityId: invoice.id,
        link: `/billing/${invoice.id}`,
        dueAt: invoice.due_date,
        dedupeKey: `invoice_overdue:${invoice.id}`,
      });
      if (outcome.created) created.push(outcome.id);
    }

    // 4. Low stock.
    const lowStock = all(
      db,
      `SELECT id, name, quantity_milli, min_stock_milli, unit FROM inventory_items
        WHERE clinic_id = ? AND deleted_at IS NULL AND is_active = 1 AND quantity_milli <= min_stock_milli
        ORDER BY name LIMIT 50`,
      [ctx.clinicId],
    );
    for (const item of lowStock) {
      const outcome = notify(db, ctx, {
        kind: 'low_stock',
        severity: item.quantity_milli <= 0 ? 'critical' : 'warning',
        titleKey: item.quantity_milli <= 0 ? 'notifications.low_stock.out' : 'notifications.low_stock.title',
        titleParams: { item: item.name },
        bodyKey: 'notifications.low_stock.body',
        bodyParams: { quantity: Math.round((item.quantity_milli / 1000) * 1000) / 1000, unit: item.unit },
        entity: 'inventory_item',
        entityId: item.id,
        link: `/inventory/${item.id}`,
        dedupeKey: `low_stock:${item.id}`,
      });
      if (outcome.created) created.push(outcome.id);
    }

    // 5. Batches expiring soon.
    const expiring = all(
      db,
      `SELECT id, name, expiry_date, batch_no FROM inventory_items
        WHERE clinic_id = ? AND deleted_at IS NULL AND is_active = 1 AND expiry_date IS NOT NULL
          AND expiry_date <= ? ORDER BY expiry_date LIMIT 50`,
      [ctx.clinicId, addDays(todayIso(), 30)],
    );
    for (const item of expiring) {
      const expired = item.expiry_date < todayIso();
      const outcome = notify(db, ctx, {
        kind: 'expiring_stock',
        severity: expired ? 'critical' : 'warning',
        titleKey: expired ? 'notifications.expiring_stock.expired' : 'notifications.expiring_stock.title',
        titleParams: { item: item.name, date: item.expiry_date },
        bodyKey: 'notifications.expiring_stock.body',
        bodyParams: { batch: item.batch_no ?? '' },
        entity: 'inventory_item',
        entityId: item.id,
        link: `/inventory/${item.id}`,
        dueAt: item.expiry_date,
        dedupeKey: `expiry:${item.id}:${item.expiry_date}`,
      });
      if (outcome.created) created.push(outcome.id);
    }

    // 6. Backup reminder (a real, non-annoying nudge: once per week at most).
    if (settings['backup.reminderEnabled'] !== false) {
      const last = get(db, 'SELECT created_at FROM audit_logs WHERE clinic_id = ? AND action = ? ORDER BY id DESC LIMIT 1', [
        ctx.clinicId,
        'backup_create',
      ]);
      const days = Number(settings['backup.reminderDays'] ?? 7);
      const reminderDue = addDays(nowIso(), -days);
      if (!last || !reminderDue || last.created_at < reminderDue) {
        const outcome = notify(db, ctx, {
          kind: 'backup_reminder',
          severity: 'warning',
          titleKey: 'notifications.backup_reminder.title',
          titleParams: { days },
          bodyKey: 'notifications.backup_reminder.body',
          entity: 'backup',
          link: '/settings/backup',
          dedupeKey: `backup:${todayIso()}`,
        });
        if (outcome.created) created.push(outcome.id);
      }
    }

    return { created: created.length, ids: created, unread: unreadCount(db, ctx) };
  });
}

/* -------------------------------------------------------------- preferences */

export function getPreferences(db, ctx) {
  const rows = all(db, 'SELECT * FROM notification_preferences WHERE user_id = ?', [ctx.user?.id ?? 0]);
  const map = new Map(rows.map((row) => [row.kind, row]));
  return NOTIFICATION_KINDS.map((kind) => {
    const row = map.get(kind);
    return {
      kind,
      enabled: row ? Boolean(row.enabled) : true,
      leadMinutes: row ? Number(row.lead_minutes) : 30,
      quietStart: row?.quiet_start ?? null,
      quietEnd: row?.quiet_end ?? null,
    };
  });
}

export function setPreference(db, ctx, kind, { enabled = true, leadMinutes = 30, quietStart = null, quietEnd = null } = {}) {
  if (!NOTIFICATION_KINDS.includes(kind)) return { updated: false };
  const userId = ctx.user?.id ?? 0;
  run(
    db,
    `INSERT INTO notification_preferences (user_id, kind, enabled, lead_minutes, quiet_start, quiet_end, updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(user_id, kind) DO UPDATE SET enabled = excluded.enabled, lead_minutes = excluded.lead_minutes,
        quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, updated_at = excluded.updated_at`,
    [userId, kind, enabled ? 1 : 0, Math.max(0, Number(leadMinutes) || 0), quietStart, quietEnd, nowIso()],
  );
  return { updated: true };
}
