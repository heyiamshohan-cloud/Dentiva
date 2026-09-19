/**
 * Role based access control.
 *
 * Permission catalogue lives in the database (seeded by migration 007) so
 * deployments can be audited; `PERMISSION_CODES` mirrors it and a test asserts
 * the two never drift.
 */
import { PermissionError } from '../../shared/errors.js';
import { all, get } from '../db/connection.js';

export const PERMISSION_CODES = [
  'dashboard.view',
  'notifications.view',
  'patients.view', 'patients.create', 'patients.edit', 'patients.archive', 'patients.export', 'patients.delete',
  'clinical.view', 'clinical.create', 'clinical.edit', 'clinical.delete',
  'chart.view', 'chart.edit',
  'plans.view', 'plans.create', 'plans.edit', 'plans.delete',
  'treatments.view', 'treatments.create', 'treatments.edit', 'treatments.delete', 'treatments.manage',
  'prescriptions.view', 'prescriptions.create', 'prescriptions.edit', 'prescriptions.delete',
  'referrals.view', 'referrals.create', 'referrals.edit', 'referrals.delete',
  'attachments.view', 'attachments.add', 'attachments.edit', 'attachments.delete',
  'appointments.view', 'appointments.create', 'appointments.edit', 'appointments.cancel', 'appointments.manage',
  'queue.view', 'queue.manage',
  'billing.view', 'billing.create', 'billing.edit', 'billing.void',
  'payments.view', 'payments.create', 'payments.refund', 'payments.void', 'payments.manage',
  'finance.view', 'finance.manage',
  'staff.view', 'staff.manage', 'payroll.view', 'payroll.manage',
  'inventory.view', 'inventory.manage', 'suppliers.view', 'suppliers.manage',
  'reports.view', 'reports.export',
  'users.view', 'users.manage', 'audit.view',
  'settings.view', 'settings.manage',
  'backup.create', 'backup.restore',
  'data.export', 'data.import',
];

/**
 * Resolve the effective permission set for a user:
 * role permissions + explicit user grants − explicit user denies.
 * @param {import('bun:sqlite').Database} db
 * @param {number} userId
 * @returns {Set<string>}
 */
export function effectivePermissions(db, userId) {
  const user = get(db, 'SELECT id, role_id, status FROM users WHERE id = ? AND deleted_at IS NULL', [userId]);
  if (!user || user.status !== 'active') return new Set();
  const codes = new Set(
    all(
      db,
      `SELECT p.code
         FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = ?`,
      [user.role_id],
    ).map((row) => row.code),
  );
  const overrides = all(
    db,
    `SELECT p.code, up.effect
       FROM user_permissions up
       JOIN permissions p ON p.id = up.permission_id
      WHERE up.user_id = ?`,
    [userId],
  );
  for (const row of overrides) {
    if (row.effect === 'allow') codes.add(row.code);
    else codes.delete(row.code);
  }
  return codes;
}

/**
 * @param {{ permissions?: Set<string>, id?: number } | null | undefined} user
 * @param {string} code
 */
export function can(user, code) {
  if (!user) return false;
  if (user.permissions instanceof Set) return user.permissions.has(code);
  return false;
}

/** @param {{ permissions?: Set<string> }} user */
export function assertCan(user, code) {
  if (!can(user, code)) throw new PermissionError(code);
  return true;
}

/** True when the user holds at least one of the codes. */
export function canAny(user, codes) {
  return codes.some((code) => can(user, code));
}

/**
 * Route → required permission map used by the HTTP layer.
 * The first matching prefix wins; `null` means "authenticated only".
 */
export const ROUTE_PERMISSIONS = [
  ['/api/auth/', null],
  ['/api/session/', null],
  ['/api/preferences/', null],
  ['/api/dashboard/', null],
  ['/api/search', null],
  ['/api/notifications/', null],
  ['/api/patients', 'patients.view'],
  ['/api/visits', 'clinical.view'],
  ['/api/chart', 'chart.view'],
  ['/api/plans', 'plans.view'],
  ['/api/treatments', 'treatments.view'],
  ['/api/prescriptions', 'prescriptions.view'],
  ['/api/referrals', 'referrals.view'],
  ['/api/attachments', 'attachments.view'],
  ['/api/appointments', 'appointments.view'],
  ['/api/queue', 'queue.view'],
  ['/api/invoices', 'billing.view'],
  ['/api/payments', 'payments.view'],
  ['/api/finance', 'finance.view'],
  ['/api/staff', 'staff.view'],
  ['/api/payroll', 'payroll.view'],
  ['/api/inventory', 'inventory.view'],
  ['/api/suppliers', 'suppliers.view'],
  ['/api/reports', 'reports.view'],
  ['/api/settings', 'settings.view'],
  ['/api/users', 'users.view'],
  ['/api/roles', 'users.view'],
  ['/api/audit', 'audit.view'],
  ['/api/backup', 'backup.create'],
  ['/api/about', null],
];

/** Write-method minimum permissions per module (used to refine the map). */
export const WRITE_PERMISSIONS = {
  '/api/patients': { POST: 'patients.create', PUT: 'patients.edit', DELETE: 'patients.archive' },
  '/api/visits': { POST: 'clinical.create', PUT: 'clinical.edit', DELETE: 'clinical.delete' },
  '/api/chart': { POST: 'chart.edit', PUT: 'chart.edit', DELETE: 'chart.edit' },
  '/api/plans': { POST: 'plans.create', PUT: 'plans.edit', DELETE: 'plans.delete' },
  '/api/treatments': { POST: 'treatments.create', PUT: 'treatments.edit', DELETE: 'treatments.delete' },
  '/api/prescriptions': { POST: 'prescriptions.create', PUT: 'prescriptions.edit', DELETE: 'prescriptions.delete' },
  '/api/referrals': { POST: 'referrals.create', PUT: 'referrals.edit', DELETE: 'referrals.delete' },
  '/api/attachments': { POST: 'attachments.add', PUT: 'attachments.edit', DELETE: 'attachments.delete' },
  '/api/appointments': { POST: 'appointments.create', PUT: 'appointments.edit', DELETE: 'appointments.cancel' },
  '/api/queue': { POST: 'queue.manage', PUT: 'queue.manage', DELETE: 'queue.manage' },
  '/api/invoices': { POST: 'billing.create', PUT: 'billing.edit', DELETE: 'billing.void' },
  '/api/payments': { POST: 'payments.create', PUT: 'payments.create', DELETE: 'payments.void' },
  '/api/finance': { POST: 'finance.manage', PUT: 'finance.manage', DELETE: 'finance.manage' },
  '/api/staff': { POST: 'staff.manage', PUT: 'staff.manage', DELETE: 'staff.manage' },
  '/api/payroll': { POST: 'payroll.manage', PUT: 'payroll.manage', DELETE: 'payroll.manage' },
  '/api/inventory': { POST: 'inventory.manage', PUT: 'inventory.manage', DELETE: 'inventory.manage' },
  '/api/suppliers': { POST: 'suppliers.manage', PUT: 'suppliers.manage', DELETE: 'suppliers.manage' },
  '/api/settings': { POST: 'settings.manage', PUT: 'settings.manage', DELETE: 'settings.manage' },
  '/api/users': { POST: 'users.manage', PUT: 'users.manage', DELETE: 'users.manage' },
  '/api/roles': { POST: 'users.manage', PUT: 'users.manage', DELETE: 'users.manage' },
  '/api/backup': { POST: 'backup.create', PUT: 'backup.restore', DELETE: 'backup.restore' },
};

/**
 * Resolve the permission required for a request path + method.
 * @param {string} pathname
 * @param {string} method
 * @returns {string|null}
 */
export function requiredPermission(pathname, method) {
  const upperMethod = method.toUpperCase();
  const isWrite = upperMethod !== 'GET' && upperMethod !== 'HEAD' && upperMethod !== 'OPTIONS';

  // Special actions that need a stronger permission than the module default.
  if (pathname.includes('/refund')) return 'payments.refund';
  if (pathname.includes('/void')) {
    if (pathname.startsWith('/api/invoices')) return 'billing.void';
    if (pathname.startsWith('/api/payments')) return 'payments.void';
  }
  if (pathname.startsWith('/api/reports/export') || pathname.includes('/export')) {
    if (pathname.startsWith('/api/reports')) return 'reports.export';
  }

  for (const [prefix, permission] of ROUTE_PERMISSIONS) {
    if (!prefix) continue;
    if (pathname === prefix || pathname.startsWith(prefix)) {
      if (isWrite) {
        const map = WRITE_PERMISSIONS[prefix];
        if (map && map[upperMethod]) return map[upperMethod];
      }
      return permission;
    }
  }
  return null;
}

/** Permission catalogue grouped for the roles editor UI. */
export function permissionCatalogue(db) {
  const rows = all(db, 'SELECT code, module, action, label_en, label_bn, sort_order FROM permissions ORDER BY sort_order');
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.module)) grouped.set(row.module, []);
    grouped.get(row.module).push(row);
  }
  return [...grouped.entries()].map(([module, permissions]) => ({ module, permissions }));
}

export function roleWithPermissions(db, roleId) {
  const role = get(db, 'SELECT * FROM roles WHERE id = ? AND deleted_at IS NULL', [roleId]);
  if (!role) return null;
  const permissions = all(
    db,
    'SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?',
    [roleId],
  ).map((r) => r.code);
  return { ...role, permissions };
}
