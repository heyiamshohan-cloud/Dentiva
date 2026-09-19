/**
 * Users, roles and permissions (§ 41, § 43).
 *
 * Accounts are never deleted while they own history: they are disabled. The
 * owner account is protected against lock-out (last active owner cannot be
 * disabled or demoted), and every change lands in the audit log.
 */
import { all, get, nowIso, run, withTransaction } from '../db/connection.js';
import { hashPassword, passwordProblems, suggestPassword } from '../security/passwords.js';
import { ValidationError, ConflictError, NotFoundError, PermissionError } from '../../shared/errors.js';
import { assertValid } from '../domain/validation.js';
import { getSettings } from './settings.js';
import { recordAudit } from './audit.js';
import { effectivePermissions, PERMISSION_CODES } from '../domain/permissions.js';

export const userSchema = {
  username: { type: 'string', required: true, minLength: 3, maxLength: 40, pattern: '^[a-z0-9][a-z0-9._-]*$' },
  display_name: { type: 'string', required: true, minLength: 2, maxLength: 120 },
  email: { type: 'email', nullable: true, maxLength: 160 },
  phone: { type: 'string', nullable: true, maxLength: 32 },
  role_id: { type: 'id', nullable: true },
  staff_id: { type: 'id', nullable: true },
  locale: { type: 'enum', values: ['en', 'bn'], nullable: true },
  status: { type: 'enum', values: ['active', 'disabled', 'locked'], nullable: true },
  notes: { type: 'text', nullable: true, maxLength: 1000 },
  password: { type: 'string', nullable: true, minLength: 8, maxLength: 200 },
  must_change_password: { type: 'boolean', nullable: true },
};

export const roleSchema = {
  name: { type: 'string', required: true, minLength: 2, maxLength: 40, pattern: '^[a-z][a-z0-9_]*$' },
  label_en: { type: 'string', required: true, minLength: 2, maxLength: 80 },
  label_bn: { type: 'string', required: true, minLength: 2, maxLength: 80 },
  description: { type: 'text', nullable: true, maxLength: 400 },
  permissions: { type: 'array', nullable: true },
};

export function shapeUser(db, row) {
  if (!row) return null;
  const clinic = db.query('SELECT currency_symbol, currency_minor_units, locale, name FROM clinics WHERE id = ?').get(row.clinic_id);
  return {
    id: Number(row.id),
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    phone: row.phone,
    roleId: row.role_id ?? null,
    roleName: row.role_name ?? null,
    roleLabel: row.role_label ?? null,
    staffId: row.staff_id ?? row.staffId ?? null,
    staffName: row.staff_name ?? null,
    locale: row.locale ?? clinic?.locale ?? 'en',
    status: row.status,
    mustChangePassword: Boolean(row.must_change_password),
    hasPin: Boolean(row.pin_hash),
    failedAttempts: Number(row.failed_attempts ?? 0),
    lockedUntil: row.locked_until ?? null,
    lastLoginAt: row.last_login_at ?? null,
    lastActivityAt: row.last_activity_at ?? null,
    notes: row.notes ?? null,
    createdAt: row.created_at,
    isSelf: row.is_self ?? undefined,
    permissions: Array.isArray(row.permissions) ? row.permissions : undefined,
    clinic: clinic ? { name: clinic.name, currencySymbol: clinic.currency_symbol, currencyMinorUnits: Number(clinic.currency_minor_units) } : null,
  };
}

const USER_SELECT = `
  SELECT u.*, r.name AS role_name, r.label_en AS role_label, s.full_name AS staff_name
    FROM users u
    LEFT JOIN roles r ON r.id = u.role_id
    LEFT JOIN staff s ON s.id = u.staff_id`;

export function listUsers(db, ctx, { includeInactive = false, search = null, roleId = null } = {}) {
  const where = ['u.clinic_id = ?', 'u.deleted_at IS NULL'];
  const args = [ctx.clinicId];
  if (!includeInactive) where.push("u.status <> 'disabled'");
  if (roleId) {
    where.push('u.role_id = ?');
    args.push(Number(roleId));
  }
  if (search) {
    where.push('(u.username LIKE ? OR u.display_name LIKE ? OR u.email LIKE ?)');
    const pattern = `%${search}%`;
    args.push(pattern, pattern, pattern);
  }
  const rows = all(db, `${USER_SELECT} WHERE ${where.join(' AND ')} ORDER BY u.display_name COLLATE NOCASE`, args);
  return { rows: rows.map((row) => shapeUser(db, row)), total: rows.length };
}

export function getUser(db, ctx, userId) {
  const row = get(db, `${USER_SELECT} WHERE u.id = ? AND u.clinic_id = ? AND u.deleted_at IS NULL`, [userId, ctx.clinicId]);
  if (!row) throw new NotFoundError('user', userId);
  return { ...shapeUser(db, row), permissions: [...effectivePermissions(db, row.id)] };
}

export function createUser(db, ctx, input) {
  const { values, errors } = assertValid(input, userSchema);
  if (errors.length) throw new ValidationError('validation.failed', errors);
  const password = values.password ?? suggestPassword(12);
  const policy = getSettings(db, ctx.clinicId);
  const problems = passwordProblems(password, {
    minLength: Number(policy['security.minPasswordLength'] ?? 10),
    requireStrong: policy['security.requireStrongPassword'] !== false,
  });
  if (problems.length) {
    throw new ValidationError('validation.failed', problems.map((problem) => ({ field: 'password', key: problem })));
  }
  const duplicate = get(db, 'SELECT id FROM users WHERE clinic_id = ? AND lower(username) = lower(?) AND deleted_at IS NULL', [
    ctx.clinicId,
    values.username,
  ]);
  if (duplicate) throw new ConflictError('users.usernameTaken', { username: values.username });

  const roleId = values.role_id ?? defaultRoleId(db, ctx.clinicId);
  const secret = hashPassword(password);
  const result = run(
    db,
    `INSERT INTO users (clinic_id, role_id, staff_id, username, display_name, email, phone, password_hash, password_salt,
                        password_algo, password_params, password_changed_at, must_change_password, locale, notes, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      ctx.clinicId,
      roleId,
      values.staff_id ?? null,
      values.username,
      values.display_name,
      values.email ?? null,
      values.phone ?? null,
      secret.hash,
      secret.salt,
      secret.algo,
      JSON.stringify(secret.params ?? {}),
      nowIso(),
      values.must_change_password === false ? 0 : 1,
      values.locale ?? null,
      values.notes ?? null,
      values.status ?? 'active',
      ctx.user?.id ?? null,
    ],
  );
  const userId = Number(result.lastInsertRowid);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'user_create',
    module: 'users',
    entity: 'user',
    entityId: userId,
    summary: `User "${values.display_name}" (${values.username}) created`,
    severity: 'notice',
    after: { username: values.username, roleId },
    ip: ctx.ip ?? null,
  });
  return { ...getUser(db, ctx, userId), generatedPassword: values.password ? null : password };
}

export function updateUser(db, ctx, userId, input) {
  const target = requireUser(db, ctx, userId);
  const { values, errors } = assertValid(input, userSchema, { partial: true });
  if (errors.length) throw new ValidationError('validation.failed', errors);

  const changes = { ...values };
  delete changes.password;
  delete changes.username;
  delete changes.must_change_password;
  if (changes.role_id !== undefined) {
    const role = get(db, 'SELECT * FROM roles WHERE id = ? AND deleted_at IS NULL', [changes.role_id]);
    if (!role || (role.clinic_id && Number(role.clinic_id) !== Number(ctx.clinicId))) throw new ValidationError('validation.failed', [{ field: 'role_id', key: 'validation.option' }]);
    if (target.status === 'active' && role.name !== 'owner' && Number(target.id) === Number(ctx.user?.id) && isOwnerUser(db, target.id)) {
      throw new ConflictError('users.cannotChangeOwnRole');
    }
  }
  if (changes.status === 'disabled' && Number(target.id) === Number(ctx.user?.id)) throw new ConflictError('users.cannotDisableSelf');
  if (changes.status === 'disabled' || (changes.role_id !== undefined && changes.role_id !== target.role_id)) {
    assertOwnerRemains(db, ctx, target);
  }

  const columns = ['role_id', 'staff_id', 'display_name', 'email', 'phone', 'locale', 'status', 'notes'];
  const sets = [];
  const params = [];
  for (const column of columns) {
    if (changes[column] === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(changes[column]);
  }
  if (values.must_change_password !== undefined) {
    sets.push('must_change_password = ?');
    params.push(values.must_change_password ? 1 : 0);
  }
  if (!sets.length) return getUser(db, ctx, userId);
  sets.push('updated_at = ?');
  params.push(nowIso(), userId);

  run(db, `UPDATE users SET ${sets.join(', ')} WHERE id = ? AND clinic_id = ?`, [...params, ctx.clinicId]);
  if (values.status === 'active') run(db, 'UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?', [userId]);

  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'user_update',
    module: 'users',
    entity: 'user',
    entityId: userId,
    summary: `User "${target.display_name}" updated`,
    severity: 'notice',
    after: changes,
    ip: ctx.ip ?? null,
  });
  return getUser(db, ctx, userId);
}

export function disableUser(db, ctx, userId, reason = null) {
  const target = requireUser(db, ctx, userId);
  if (Number(target.id) === Number(ctx.user?.id)) throw new ConflictError('users.cannotDisableSelf');
  assertOwnerRemains(db, ctx, target);
  run(db, "UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?", [nowIso(), userId]);
  run(db, 'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), 'disabled', userId]);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'user_disable',
    module: 'users',
    entity: 'user',
    entityId: userId,
    summary: `User "${target.display_name}" disabled${reason ? `: ${reason}` : ''}`,
    severity: 'warning',
    ip: ctx.ip ?? null,
  });
  return { disabled: true };
}

export function listRoles(db, ctx, { includeSystem = true } = {}) {
  const where = ['(clinic_id = ? OR clinic_id IS NULL)', 'deleted_at IS NULL'];
  const args = [ctx.clinicId];
  if (!includeSystem) where.push('is_system = 0');
  const rows = all(db, `SELECT * FROM roles WHERE ${where.join(' AND ')} ORDER BY is_system DESC, label_en`, args);
  return {
    rows: rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      labelEn: row.label_en,
      labelBn: row.label_bn,
      description: row.description,
      isSystem: Boolean(row.is_system),
      isLocked: Boolean(row.is_locked),
      userCount: Number(get(db, 'SELECT COUNT(*) AS c FROM users WHERE role_id = ? AND deleted_at IS NULL', [row.id])?.c ?? 0),
      permissionCount: Number(get(db, 'SELECT COUNT(*) AS c FROM role_permissions WHERE role_id = ?', [row.id])?.c ?? 0),
    })),
    total: rows.length,
  };
}

export function getRole(db, ctx, roleId) {
  const role = get(db, 'SELECT * FROM roles WHERE id = ? AND (clinic_id = ? OR clinic_id IS NULL) AND deleted_at IS NULL', [roleId, ctx.clinicId]);
  if (!role) throw new NotFoundError('role', roleId);
  const permissions = all(
    db,
    `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ? ORDER BY p.sort_order`,
    [roleId],
  ).map((row) => row.code);
  return {
    id: Number(role.id),
    name: role.name,
    labelEn: role.label_en,
    labelBn: role.label_bn,
    description: role.description,
    isSystem: Boolean(role.is_system),
    isLocked: Boolean(role.is_locked),
    permissions,
  };
}

export function saveRole(db, ctx, roleId, input) {
  const { values, errors } = assertValid(input, roleSchema, { partial: roleId ? { partial: true } : {} });
  if (errors.length) throw new ValidationError('validation.failed', errors);
  return withTransaction(db, () => {
    let id = roleId ? Number(roleId) : null;
    if (id) {
      const existing = get(db, 'SELECT * FROM roles WHERE id = ? AND deleted_at IS NULL', [id]);
      if (!existing) throw new NotFoundError('role', id);
      if (existing.is_locked === 1) throw new ConflictError('roles.systemLocked');
      if (existing.clinic_id === null) throw new ConflictError('roles.systemLocked');
      const sets = [];
      const params = [];
      for (const column of ['name', 'label_en', 'label_bn', 'description']) {
        if (values[column] === undefined) continue;
        sets.push(`${column} = ?`);
        params.push(values[column]);
      }
      if (sets.length) {
        sets.push('updated_at = ?');
        run(db, `UPDATE roles SET ${sets.join(', ')} WHERE id = ?`, [...params, nowIso(), id]);
      }
    } else {
      const duplicate = get(db, 'SELECT id FROM roles WHERE clinic_id = ? AND name = ? AND deleted_at IS NULL', [ctx.clinicId, values.name]);
      if (duplicate) throw new ConflictError('roles.nameTaken', { name: values.name });
      const result = run(
        db,
        'INSERT INTO roles (clinic_id, name, label_en, label_bn, description, is_system, is_locked) VALUES (?,?,?,?,?,0,0)',
        [ctx.clinicId, values.name, values.label_en, values.label_bn, values.description ?? null],
      );
      id = Number(result.lastInsertRowid);
    }

    if (Array.isArray(values.permissions)) {
      const codes = values.permissions.filter((code) => PERMISSION_CODES.includes(code));
      run(db, 'DELETE FROM role_permissions WHERE role_id = ?', [id]);
      for (const code of codes) {
        run(db, 'INSERT OR IGNORE INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE code = ?', [id, code]);
      }
    }

    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: roleId ? 'role_update' : 'role_create',
      module: 'users',
      entity: 'role',
      entityId: id,
      summary: `Role "${values.label_en ?? ''}" ${roleId ? 'updated' : 'created'}`,
      severity: 'notice',
      after: { permissions: values.permissions ?? null },
      ip: ctx.ip ?? null,
    });
    return getRole(db, ctx, id);
  });
}

export function deleteRole(db, ctx, roleId) {
  const role = get(db, 'SELECT * FROM roles WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [roleId, ctx.clinicId]);
  if (!role) throw new NotFoundError('role', roleId);
  if (role.is_system === 1 || role.is_locked === 1) throw new ConflictError('roles.systemLocked');
  const users = Number(get(db, 'SELECT COUNT(*) AS c FROM users WHERE role_id = ? AND deleted_at IS NULL', [roleId])?.c ?? 0);
  if (users > 0) throw new ConflictError('roles.inUse', { count: users });
  run(db, 'UPDATE roles SET deleted_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), roleId]);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'role_delete',
    module: 'users',
    entity: 'role',
    entityId: roleId,
    summary: `Role "${role.label_en}" removed`,
    severity: 'warning',
    ip: ctx.ip ?? null,
  });
  return { deleted: true };
}

/** Per-user allow/deny overrides on top of the role. */
export function setUserPermissions(db, ctx, userId, overrides = []) {
  const target = requireUser(db, ctx, userId);
  return withTransaction(db, () => {
    run(db, 'DELETE FROM user_permissions WHERE user_id = ?', [userId]);
    for (const override of overrides) {
      if (!PERMISSION_CODES.includes(override.code)) continue;
      if (override.effect !== 'allow' && override.effect !== 'deny') continue;
      run(
        db,
        'INSERT OR IGNORE INTO user_permissions (user_id, permission_id, effect) SELECT ?, id, ? FROM permissions WHERE code = ?',
        [userId, override.effect, override.code],
      );
    }
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'user_permissions',
      module: 'users',
      entity: 'user',
      entityId: userId,
      summary: `Permission overrides updated for "${target.display_name}"`,
      severity: 'critical',
      after: { overrides },
      ip: ctx.ip ?? null,
    });
    return { ...getUser(db, ctx, userId), permissions: [...effectivePermissions(db, userId)] };
  });
}

/**
 * @param {any} db
 * @param {any} ctx
 * @param {number|null} [userId]
 */
export function listUserSessions(db, ctx, userId = null) {
  return all(
    db,
    `SELECT s.id, s.user_id, s.device, s.ip, s.user_agent, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at, s.revoked_reason,
            u.display_name, u.username
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE u.clinic_id = ? ${userId ? 'AND s.user_id = ?' : ''}
      ORDER BY s.last_seen_at DESC LIMIT 200`,
    userId ? [ctx.clinicId, userId] : [ctx.clinicId],
  ).map((row) => ({
    id: Number(row.id),
    userId: Number(row.user_id),
    user: row.display_name,
    username: row.username,
    device: row.device,
    ip: row.ip,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    active: !row.revoked_at,
  }));
}

/* ------------------------------------------------------------------ helpers */

function requireUser(db, ctx, userId) {
  const user = get(db, 'SELECT * FROM users WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [userId, ctx.clinicId]);
  if (!user) throw new NotFoundError('user', userId);
  return user;
}

function defaultRoleId(db, clinicId) {
  const role = get(db, "SELECT id FROM roles WHERE (clinic_id = ? OR clinic_id IS NULL) AND name = 'assistant' AND deleted_at IS NULL ORDER BY is_system DESC", [
    clinicId,
  ]);
  return role ? Number(role.id) : null;
}

function isOwnerUser(db, userId) {
  const row = get(db, 'SELECT r.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?', [userId]);
  return row?.name === 'owner';
}

/** The last active owner may never be disabled or demoted (§ RBAC safety). */
function assertOwnerRemains(db, ctx, target) {
  if (!isOwnerUser(db, target.id)) return;
  const owners = Number(
    get(
      db,
      `SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.clinic_id = ? AND u.deleted_at IS NULL AND u.status = 'active' AND r.name = 'owner' AND u.id <> ?`,
      [ctx.clinicId, target.id],
    )?.c ?? 0,
  );
  if (owners === 0) throw new ConflictError('users.lastOwner');
}

/** Assert that the signed-in user holds a permission (used by scripts/tests). */
export function requirePermission(db, user, code) {
  if (!user?.id) throw new PermissionError(code);
  const allowed = effectivePermissions(db, user.id);
  if (!allowed.has('*') && !allowed.has(code)) throw new PermissionError(code);
  return true;
}
