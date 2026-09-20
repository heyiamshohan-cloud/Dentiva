/**
 * Audit trail (§ 53).
 *
 * Records *who* changed *what* and *when*, with a sanitised before/after diff.
 * Credentials, session tokens and PIN hashes are stripped before anything is
 * written, and long clinical text is truncated so the log never becomes a
 * second copy of the medical record.
 */
import { all, get, run } from '../db/connection.js';

const REDACT_KEYS = /(password|passwd|pin|token|secret|hash|salt|authorization)/i;
const MAX_FIELD_LENGTH = 2000;

/** Remove secrets and clamp long strings. */
export function sanitiseForAudit(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_FIELD_LENGTH ? `${value.slice(0, MAX_FIELD_LENGTH)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitiseForAudit(item, depth + 1));
  if (typeof value === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (REDACT_KEYS.test(key)) {
        out[key] = '[redacted]';
        continue;
      }
      out[key] = sanitiseForAudit(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

function safeJson(value) {
  if (value === null || value === undefined) return null;
  try {
    const text = JSON.stringify(sanitiseForAudit(value));
    return text.length > 8000 ? `${text.slice(0, 8000)}…` : text;
  } catch {
    return null;
  }
}

/**
 * Write an audit entry.
 * @param {import('bun:sqlite').Database} db
 * @param {{
 *   clinicId?: number|null, userId?: number|null, userName?: string|null,
 *   action: string, module: string, entity?: string|null, entityId?: string|number|null,
 *   summary?: string|null, severity?: string,
 *   before?: any, after?: any, ip?: string|null
 * }} entry
 */
export function recordAudit(db, entry) {
  const result = run(
    db,
    `INSERT INTO audit_logs
      (clinic_id, user_id, user_name, action, module, entity, entity_id, summary, severity, before_json, after_json, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.clinicId ?? null,
      entry.userId ?? null,
      entry.userName ?? null,
      entry.action,
      entry.module,
      entry.entity ?? null,
      entry.entityId === null || entry.entityId === undefined ? null : String(entry.entityId),
      entry.summary ? String(entry.summary).slice(0, 500) : null,
      entry.severity ?? 'info',
      safeJson(entry.before),
      safeJson(entry.after),
      entry.ip ?? null,
    ],
  );
  return Number(result.lastInsertRowid);
}

/**
 * Build a compact diff for update operations.
 * @param {any} before
 * @param {any} after
 * @param {string[]|null} [fields]
 */
export function diffForAudit(before, after, fields = null) {
  if (!before || !after) return { before: before ?? null, after: after ?? null, changed: [] };
  const keys = fields ?? Object.keys(after);
  const changed = [];
  const beforeDiff = {};
  const afterDiff = {};
  for (const key of keys) {
    if (key === 'updated_at') continue;
    const a = before[key] ?? null;
    const b = after[key] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changed.push(key);
      beforeDiff[key] = a;
      afterDiff[key] = b;
    }
  }
  return { before: beforeDiff, after: afterDiff, changed };
}

/**
 * Paginated audit log query for the Audit screen.
 * @param {import('bun:sqlite').Database} db
 */
/** Public shape of an audit row (JSON payloads parsed, snake_case removed). */
export function shapeAuditLog(row) {
  if (!row) return null;
  const parse = (value) => {
    if (value === null || value === undefined || value === '') return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };
  return {
    id: Number(row.id),
    userId: row.user_id ?? null,
    userName: row.user_name ?? null,
    action: row.action,
    module: row.module,
    entity: row.entity ?? null,
    entityId: row.entity_id ?? null,
    summary: row.summary ?? null,
    severity: row.severity,
    before: parse(row.before_json),
    after: parse(row.after_json),
    ip: row.ip ?? null,
    createdAt: row.created_at,
  };
}

export function listAuditLogs(db, clinicId, filters = {}) {
  const where = ['(clinic_id = ? OR clinic_id IS NULL)'];
  const params = [clinicId];
  if (filters.module) {
    where.push('module = ?');
    params.push(filters.module);
  }
  if (filters.action) {
    where.push('action = ?');
    params.push(filters.action);
  }
  if (filters.severity) {
    where.push('severity = ?');
    params.push(filters.severity);
  }
  if (filters.userId) {
    where.push('user_id = ?');
    params.push(filters.userId);
  }
  if (filters.entity) {
    where.push('entity = ?');
    params.push(filters.entity);
  }
  if (filters.entityId) {
    where.push('entity_id = ?');
    params.push(String(filters.entityId));
  }
  if (filters.from) {
    where.push('created_at >= ?');
    params.push(`${filters.from}T00:00:00.000Z`);
  }
  if (filters.to) {
    where.push('created_at <= ?');
    params.push(`${filters.to}T23:59:59.999Z`);
  }
  if (filters.search) {
    where.push('(summary LIKE ? ESCAPE \'\\\' OR action LIKE ? ESCAPE \'\\\' OR user_name LIKE ? ESCAPE \'\\\')');
    const like = `%${String(filters.search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(like, like, like);
  }
  const whereSql = where.join(' AND ');
  const page = Math.max(1, Number(filters.page ?? 1));
  const pageSize = Math.min(200, Math.max(5, Number(filters.pageSize ?? 40)));
  const total = Number(get(db, `SELECT COUNT(*) AS c FROM audit_logs WHERE ${whereSql}`, params)?.c ?? 0);
  const rows = all(
    db,
    `SELECT * FROM audit_logs WHERE ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  ).map(shapeAuditLog);
  return { rows, total, page, pageSize };
}

/** Delete entries older than the configured retention window. */
export function pruneAuditLogs(db, clinicId, retentionDays) {
  if (!retentionDays || retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  const result = run(db, 'DELETE FROM audit_logs WHERE clinic_id = ? AND created_at < ?', [clinicId, cutoff]);
  return result.changes ?? 0;
}
