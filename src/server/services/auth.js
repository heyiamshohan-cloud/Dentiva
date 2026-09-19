/**
 * Authentication, sessions and account security (§ 51).
 *
 *  - passwords and PINs are scrypt hashed (never stored or logged in clear)
 *  - only the SHA-256 digest of a session token is stored
 *  - failed attempts are counted per user, with a temporary lockout
 *  - sessions expire on a hard lifetime *and* on idle timeout
 */
import { all, get, run, nowIso } from '../db/connection.js';
import { AuthError, ValidationError } from '../../shared/errors.js';
import {
  hashPassword,
  hashPin,
  hashToken,
  passwordProblems,
  randomToken,
  verifyPassword,
  verifyPin,
} from '../security/passwords.js';
import { effectivePermissions } from '../domain/permissions.js';
import { getSettings } from './settings.js';
import { recordAudit } from './audit.js';

const SESSION_COOKIE = 'dentiva_session';

export { SESSION_COOKIE };

function securityPolicy(db, clinicId) {
  const settings = getSettings(db, clinicId);
  return {
    idleTimeoutMinutes: settings['security.idleTimeoutMinutes'] ?? 15,
    sessionMaxHours: settings['security.sessionMaxHours'] ?? 12,
    maxFailedAttempts: settings['security.maxFailedAttempts'] ?? 5,
    lockoutMinutes: settings['security.lockoutMinutes'] ?? 15,
    minPasswordLength: settings['security.minPasswordLength'] ?? 10,
    requireStrongPassword: settings['security.requireStrongPassword'] ?? true,
  };
}

/**
 * @param {any} db
 * @param {{ username: string, userId?: number|null, success: boolean, reason?: string|null, ip?: string|null, userAgent?: string|null }} attempt
 */
function recordAttempt(db, { username, userId, success, reason, ip, userAgent }) {
  run(
    db,
    `INSERT INTO login_attempts (username, user_id, success, reason, ip, user_agent) VALUES (?,?,?,?,?,?)`,
    [String(username ?? '').slice(0, 80), userId ?? null, success ? 1 : 0, reason ?? null, ip ?? null, userAgent ?? null],
  );
}

function findByUsername(db, username) {
  return get(
    db,
    `SELECT u.*, r.name AS role_name, r.label_en AS role_label, c.currency_symbol, c.currency_minor_units, c.locale
       FROM users u
       JOIN roles r ON r.id = u.role_id
       JOIN clinics c ON c.id = u.clinic_id
      WHERE lower(u.username) = lower(?) AND u.deleted_at IS NULL`,
    [String(username ?? '').trim()],
  );
}

/** Public shape of a user, never containing credential material. */
export function publicUser(db, row) {
  const permissions = effectivePermissions(db, row.id);
  return {
    id: Number(row.id),
    clinicId: Number(row.clinic_id),
    clinicName: row.clinic_name ?? null,
    staffId: row.staff_id ?? null,
    username: row.username,
    displayName: row.display_name,
    email: row.email ?? null,
    phone: row.phone ?? null,
    roleId: Number(row.role_id),
    roleName: row.role_name ?? null,
    roleLabel: row.role_label ?? null,
    locale: row.locale ?? null,
    theme: 'light',
    mustChangePassword: Boolean(row.must_change_password),
    hasPin: Boolean(row.pin_hash),
    lastLoginAt: row.last_login_at ?? null,
    permissions: [...permissions],
    currencySymbol: row.currency_symbol ?? null,
    currencyMinorUnits: row.currency_minor_units ?? 2,
  };
}

/**
 * Exchange credentials for a session.
 * @param {import('bun:sqlite').Database} db
 */
/**
 * @param {any} db
 * @param {{ username: string, password: string, ip?: string|null, userAgent?: string|null }} credentials
 */
export function login(db, { username, password, ip = null, userAgent = null }) {
  const user = findByUsername(db, username);
  const generic = new AuthError('auth.invalidCredentials');

  if (!user) {
    recordAttempt(db, { username, success: false, reason: 'unknown_user', ip, userAgent });
    throw generic;
  }

  const policy = securityPolicy(db, user.clinic_id);
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    recordAttempt(db, { username, userId: user.id, success: false, reason: 'locked', ip, userAgent });
    const secondsLeft = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000);
    throw new AuthError('auth.accountLocked', 423, { minutes: Math.max(1, Math.ceil(secondsLeft / 60)) });
  }
  if (user.status !== 'active') {
    recordAttempt(db, { username, userId: user.id, success: false, reason: 'disabled', ip, userAgent });
    throw new AuthError('auth.accountDisabled', 403);
  }

  const valid = verifyPassword(String(password ?? ''), user);
  if (!valid) {
    const attempts = Number(user.failed_attempts ?? 0) + 1;
    const shouldLock = attempts >= policy.maxFailedAttempts;
    run(
      db,
      'UPDATE users SET failed_attempts = ?, locked_until = ?, status = CASE WHEN ? THEN \'locked\' ELSE status END WHERE id = ?',
      [
        shouldLock ? 0 : attempts,
        shouldLock ? new Date(Date.now() + policy.lockoutMinutes * 60000).toISOString() : null,
        shouldLock ? 1 : 0,
        user.id,
      ],
    );
    recordAttempt(db, { username, userId: user.id, success: false, reason: 'bad_password', ip, userAgent });
    if (shouldLock) {
      recordAudit(db, {
        clinicId: user.clinic_id,
        userId: user.id,
        userName: user.display_name,
        action: 'lockout',
        module: 'security',
        entity: 'user',
        entityId: user.id,
        summary: `Account locked after ${policy.maxFailedAttempts} failed sign-in attempts`,
        severity: 'warning',
        ip,
      });
      throw new AuthError('auth.accountLocked', 423, { minutes: policy.lockoutMinutes });
    }
    const remaining = policy.maxFailedAttempts - attempts;
    throw new AuthError('auth.invalidCredentials', 401, { remaining });
  }

  // Success — reset counters and open a session.
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + policy.sessionMaxHours * 3600000).toISOString();
  run(
    db,
    `INSERT INTO sessions (user_id, token_hash, csrf_token, device, ip, user_agent, expires_at)
     VALUES (?,?,?,?,?,?,?)`,
    [user.id, hashToken(token), csrfToken, 'Windows desktop', ip, userAgent, expiresAt],
  );
  run(
    db,
    'UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, last_activity_at = ?, status = \'active\' WHERE id = ?',
    [nowIso(), nowIso(), user.id],
  );
  recordAttempt(db, { username, userId: user.id, success: true, ip, userAgent });
  recordAudit(db, {
    clinicId: user.clinic_id,
    userId: user.id,
    userName: user.display_name,
    action: 'login',
    module: 'security',
    entity: 'session',
    summary: `${user.display_name} signed in`,
    severity: 'info',
    ip,
  });

  return {
    token,
    csrfToken,
    expiresAt,
    user: publicUser(db, { ...user, last_login_at: nowIso() }),
  };
}

/**
 * Validate a session token and return the current user (or null).
 * Implements idle timeout and hard expiry.
 */
export function authenticate(db, token) {
  if (!token) return null;
  const session = get(db, 'SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL', [hashToken(token)]);
  if (!session) return null;
  const now = Date.now();
  if (new Date(session.expires_at).getTime() <= now) {
    run(db, 'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ?', [nowIso(), 'expired', session.id]);
    return null;
  }
  const user = get(
    db,
    `SELECT u.*, r.name AS role_name, r.label_en AS role_label, c.currency_symbol, c.currency_minor_units, c.locale, c.name AS clinic_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
       JOIN clinics c ON c.id = u.clinic_id
      WHERE u.id = ? AND u.deleted_at IS NULL`,
    [session.user_id],
  );
  if (!user || user.status !== 'active') return null;

  const policy = securityPolicy(db, user.clinic_id);
  const idleDeadline = new Date(session.last_seen_at).getTime() + policy.idleTimeoutMinutes * 60000;
  if (idleDeadline <= now) {
    run(db, 'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ?', [nowIso(), 'idle_timeout', session.id]);
    return null;
  }
  run(db, 'UPDATE sessions SET last_seen_at = ?, revoked_at = NULL WHERE id = ?', [nowIso(), session.id]);
  run(db, 'UPDATE users SET last_activity_at = ? WHERE id = ?', [nowIso(), user.id]);
  return { ...publicUser(db, user), sessionId: Number(session.id), csrfToken: session.csrf_token, sessionExpiresAt: session.expires_at };
}

export function logout(db, token, reason = 'user') {
  if (!token) return false;
  const result = run(
    db,
    'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE token_hash = ? AND revoked_at IS NULL',
    [nowIso(), reason, hashToken(token)],
  );
  return (result.changes ?? 0) > 0;
}

export function listSessions(db, clinicId, userId = null) {
  const params = [clinicId];
  let sql = `SELECT s.id, s.user_id, u.username, u.display_name, s.device, s.ip, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at, s.revoked_reason
               FROM sessions s JOIN users u ON u.id = s.user_id
              WHERE u.clinic_id = ?`;
  if (userId) {
    sql += ' AND s.user_id = ?';
    params.push(userId);
  }
  sql += ' ORDER BY s.created_at DESC LIMIT 200';
  return all(db, sql, params);
}

/**
 * @param {any} db
 * @param {number} sessionId
 * @param {{ id?: number, clinicId?: number, displayName?: string }|null} [actor]
 */
export function revokeSession(db, sessionId, actor = null) {
  const session = get(db, 'SELECT * FROM sessions WHERE id = ?', [sessionId]);
  if (!session) throw new AuthError('errors.notFound', 404);
  run(db, 'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ?', [
    nowIso(),
    actor ? 'revoked_by_admin' : 'user',
    sessionId,
  ]);
  recordAudit(db, {
    clinicId: actor?.clinicId ?? null,
    userId: actor?.id ?? null,
    userName: actor?.displayName ?? null,
    action: 'revoke_session',
    module: 'security',
    entity: 'session',
    entityId: sessionId,
    summary: 'Session revoked',
    severity: 'notice',
  });
  return true;
}

/** Change own password (or set it when a reset forced a change). */
export function changePassword(db, userId, { currentPassword, newPassword, skipCurrentCheck = false }) {
  const user = get(db, 'SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', [userId]);
  if (!user) throw new AuthError('errors.notFound', 404);
  if (!skipCurrentCheck) {
    if (!currentPassword || !verifyPassword(String(currentPassword), user)) {
      throw new AuthError('auth.currentPasswordWrong', 401);
    }
  }
  const policy = securityPolicy(db, user.clinic_id);
  const problems = passwordProblems(newPassword, {
    minLength: policy.minPasswordLength,
    requireStrong: policy.requireStrongPassword,
  });
  if (problems.length) {
    throw new ValidationError('validation.failed', problems.map((key) => ({ field: 'newPassword', key })));
  }
  if (verifyPassword(String(newPassword), user)) {
    throw new AuthError('auth.passwordUnchanged', 422);
  }
  const hashed = hashPassword(String(newPassword));
  run(
    db,
    `UPDATE users
        SET password_hash = ?, password_salt = ?, password_algo = ?, password_params = ?,
            password_changed_at = ?, must_change_password = 0, failed_attempts = 0, locked_until = NULL,
            status = CASE WHEN status = 'locked' THEN 'active' ELSE status END, updated_at = ?
      WHERE id = ?`,
    [hashed.hash, hashed.salt, hashed.algo, hashed.params, nowIso(), nowIso(), userId],
  );
  // Every other session is invalidated as soon as the password changes.
  run(db, 'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL', [
    nowIso(),
    'password_changed',
    userId,
  ]);
  recordAudit(db, {
    clinicId: user.clinic_id,
    userId: user.id,
    userName: user.display_name,
    action: 'change_password',
    module: 'security',
    entity: 'user',
    entityId: user.id,
    summary: 'Password changed',
    severity: 'notice',
  });
  return true;
}

/** Administrator-driven reset (§ 51): forces a change at next sign-in. */
export function resetPassword(db, actorUserId, targetUserId, { password, mustChange = true }) {
  const target = get(db, 'SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', [targetUserId]);
  if (!target) throw new AuthError('errors.notFound', 404);
  const policy = securityPolicy(db, target.clinic_id);
  const problems = passwordProblems(password, { ...policy, minLength: Math.min(policy.minPasswordLength, 8) });
  if (problems.length) {
    throw new ValidationError('validation.failed', problems.map((key) => ({ field: 'password', key })));
  }
  const hashed = hashPassword(String(password));
  run(
    db,
    `UPDATE users SET password_hash = ?, password_salt = ?, password_algo = ?, password_params = ?,
        password_changed_at = ?, must_change_password = ?, failed_attempts = 0, locked_until = NULL,
        status = CASE WHEN status = 'locked' THEN 'active' ELSE status END, updated_at = ?
      WHERE id = ?`,
    [hashed.hash, hashed.salt, hashed.algo, hashed.params, nowIso(), mustChange ? 1 : 0, nowIso(), targetUserId],
  );
  run(db, 'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL', [
    nowIso(),
    'password_reset',
    targetUserId,
  ]);
  const actor = actorUserId ? get(db, 'SELECT id, display_name, clinic_id FROM users WHERE id = ?', [actorUserId]) : null;
  recordAudit(db, {
    clinicId: target.clinic_id,
    userId: actor?.id ?? null,
    userName: actor?.display_name ?? null,
    action: 'reset_password',
    module: 'security',
    entity: 'user',
    entityId: targetUserId,
    summary: `Password reset for ${target.username}`,
    severity: 'warning',
  });
  return true;
}

/**
 * @param {any} db
 * @param {number} userId
 * @param {string} pin
 * @param {{ currentPassword?: string }} [options]
 */
export function setPin(db, userId, pin, { currentPassword } = {}) {
  const user = get(db, 'SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw new AuthError('errors.notFound', 404);
  if (currentPassword !== undefined && !verifyPassword(String(currentPassword), user)) {
    throw new AuthError('auth.currentPasswordWrong', 401);
  }
  if (!/^\d{4,8}$/.test(String(pin ?? ''))) throw new ValidationError('validation.failed', [{ field: 'pin', key: 'auth.pinFormat' }]);
  const hashed = hashPin(String(pin));
  run(db, 'UPDATE users SET pin_hash = ?, pin_salt = ?, updated_at = ? WHERE id = ?', [hashed.hash, hashed.salt, nowIso(), userId]);
  recordAudit(db, {
    clinicId: user.clinic_id,
    userId: user.id,
    userName: user.display_name,
    action: 'set_pin',
    module: 'security',
    entity: 'user',
    entityId: user.id,
    summary: 'Transaction PIN updated',
    severity: 'notice',
  });
  return true;
}

export function removePin(db, userId) {
  run(db, 'UPDATE users SET pin_hash = NULL, pin_salt = NULL, updated_at = ? WHERE id = ?', [nowIso(), userId]);
  return true;
}

/** Verify a PIN for a sensitive action (refunds, voids). */
export function verifyUserPin(db, userId, pin) {
  const user = get(db, 'SELECT pin_hash, pin_salt, password_algo, password_params FROM users WHERE id = ?', [userId]);
  if (!user?.pin_hash) return { ok: false, reason: 'no_pin' };
  const ok = verifyPin(String(pin ?? ''), { hash: user.pin_hash, salt: user.pin_salt, algo: user.password_algo, params: user.password_params });
  return { ok, reason: ok ? null : 'invalid_pin' };
}

/** Housekeeping: drop expired sessions and stale attempts. */
export function pruneSessions(db, days = 30) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  run(db, 'DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)', [cutoff, cutoff]);
  run(db, 'DELETE FROM login_attempts WHERE created_at < ?', [cutoff]);
  return true;
}
