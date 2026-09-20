/**
 * Navigation model.
 *
 * Every entry declares the permission it needs so a restricted user never sees a
 * door they cannot open (the server still enforces the same rule).
 */
import { can } from './store.js';

export const NAV_GROUPS = [
  {
    label: 'nav.groupClinic',
    items: [
      { path: '/dashboard', label: 'nav.dashboard', icon: '◧' },
      { path: '/patients', label: 'nav.patients', icon: '☺' },
      { path: '/appointments', label: 'nav.appointments', icon: '❑', permission: 'appointments.view' },
      { path: '/calendar', label: 'nav.calendar', icon: '▤', permission: 'appointments.view' },
      { path: '/queue', label: 'nav.queue', icon: '≣', permission: 'queue.view' },
    ],
  },
  {
    label: 'nav.groupClinical',
    items: [
      { path: '/visits', label: 'nav.clinical', icon: '✚', permission: 'clinical.view' },
      { path: '/treatments', label: 'nav.treatments', icon: '⊞', permission: 'treatments.view' },
      { path: '/plans', label: 'nav.plans', icon: '⊟', permission: 'plans.view' },
      { path: '/prescriptions', label: 'nav.prescriptions', icon: '℞', permission: 'prescriptions.view' },
      { path: '/referrals', label: 'nav.referrals', icon: '➦', permission: 'referrals.view' },
      { path: '/attachments', label: 'nav.attachments', icon: '🗎', permission: 'attachments.view' },
    ],
  },
  {
    label: 'nav.groupMoney',
    items: [
      { path: '/billing', label: 'nav.billing', icon: '₪', permission: 'billing.view' },
      { path: '/payments', label: 'nav.payments', icon: '৳', permission: 'payments.view' },
      { path: '/receivables', label: 'nav.receivables', icon: '⏳', permission: 'billing.view' },
      { path: '/finance', label: 'nav.finance', icon: '∑', permission: 'finance.view' },
    ],
  },
  {
    label: 'nav.groupOperations',
    items: [
      { path: '/staff', label: 'nav.staff', icon: '⚕', permission: 'staff.view' },
      { path: '/payroll', label: 'nav.payroll', icon: '₹', permission: 'payroll.view' },
      { path: '/inventory', label: 'nav.inventory', icon: '⚙', permission: 'inventory.view' },
      { path: '/suppliers', label: 'nav.suppliers', icon: '⇄', permission: 'suppliers.view' },
      { path: '/reports', label: 'nav.reports', icon: '▦', permission: 'reports.view' },
    ],
  },
  {
    label: 'nav.groupSystem',
    items: [
      { path: '/settings', label: 'nav.settings', icon: '⚒', permission: 'settings.view' },
      { path: '/users', label: 'nav.users', icon: '⚿', permission: 'users.view' },
      { path: '/audit', label: 'nav.audit', icon: '☰', permission: 'audit.view' },
      { path: '/backup', label: 'nav.backup', icon: '⤓', permission: 'backup.create' },
      { path: '/about', label: 'nav.about', icon: 'ⓘ' },
    ],
  },
];

/** Flattened list of visible entries (used by the command palette and titles). */
export function visibleNav() {
  const out = [];
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (!item.permission || can(item.permission)) out.push({ ...item, group: group.label });
    }
  }
  return out;
}

export function titleFor(path) {
  const clean = path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path;
  const exact = visibleNav().find((item) => item.path === clean);
  if (exact) return exact.label;
  const root = visibleNav().find((item) => clean.startsWith(item.path));
  return root ? root.label : 'nav.dashboard';
}
