/**
 * Migration 009 — permission catalogue completion.
 *
 * Routes guard four capabilities that were never added to the permission
 * catalogue (`treatments.manage`, `appointments.manage`, `payments.manage`,
 * `patients.delete`). The owner role is seeded by expanding the catalogue into
 * `role_permissions`, so a missing code was unreachable for every role — even
 * the owner received 403 on the affected routes.
 *
 * This migration only *adds* rows (never removes or rewrites), so existing
 * databases keep every grant they already had.
 */

export const id = 9;
export const name = 'permission_catalog_completion';

/** Codes that the HTTP layer already enforces but the catalogue lacked. */
export const ADDED_PERMISSIONS = [
  ['treatments.manage', 'treatments', 'manage', 'Manage service catalogue', 'সেবা তালিকা পরিচালনা'],
  ['appointments.manage', 'appointments', 'manage', 'Manage appointment types', 'অ্যাপয়েন্টমেন্ট ধরন পরিচালনা'],
  ['payments.manage', 'payments', 'manage', 'Manage payment methods', 'পেমেন্ট পদ্ধতি পরিচালনা'],
  ['patients.delete', 'patients', 'delete', 'Permanently delete patients', 'রোগী স্থায়ীভাবে মুছে ফেলুন'],
];

/** Grants so the new capabilities reach the roles that are meant to have them. */
export const GRANTS = {
  owner: '*',
  dentist: ['treatments.manage'],
  receptionist: ['appointments.manage'],
  accountant: ['payments.manage'],
  assistant: [],
};

/**
 * @param {import('bun:sqlite').Database} db
 */
export function up(db) {
  const maxOrder =
    Number(db.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM permissions').get()?.m ?? 0) + 10;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO permissions (code, module, action, label_en, label_bn, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  ADDED_PERMISSIONS.forEach((p, index) => insert.run(p[0], p[1], p[2], p[3], p[4], maxOrder + index * 10));

  const grantByCode = db.prepare(
    `INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
     SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = ? AND p.code = ?`,
  );
  const grantAll = db.prepare(
    `INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
     SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = ?`,
  );

  for (const [role, codes] of Object.entries(GRANTS)) {
    if (codes === '*') {
      grantAll.run(role);
      continue;
    }
    for (const code of codes) grantByCode.run(role, code);
  }
}
