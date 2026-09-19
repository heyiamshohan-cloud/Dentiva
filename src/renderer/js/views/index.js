/**
 * Route table.
 *
 * One place where every screen is registered, so the navigation model and the
 * router can never drift apart.
 */
import { route } from '../core/router.js';
import { dashboardScreen } from './dashboard.js';
import { patientsScreen, patientProfileScreen } from './patients.js';
import { appointmentsScreen, appointmentDetailScreen, calendarScreen, queueScreen } from './scheduling.js';
import { visitsScreen, visitDetailScreen, chartScreen, treatmentsScreen, plansScreen, planDetailScreen, prescriptionsScreen, newPrescriptionScreen, prescriptionDetailScreen, referralsScreen, referralDetailScreen, attachmentsScreen } from './clinical.js';
import { invoicesScreen, invoiceDetailScreen, paymentsScreen, paymentDetailScreen, receivablesScreen, financeScreen } from './money.js';
import { staffScreen, staffDetailScreen, payrollScreen, inventoryScreen, suppliersScreen } from './ops.js';
import { reportsScreen, reportRunScreen, settingsScreen, usersScreen, auditScreen, backupScreen, aboutScreen, notificationsScreen } from './system.js';

/** @param {{ t: () => any }} context */
export function registerRoutes({ t }) {
  route('/', () => dashboardScreen({ t: t() }));
  route('/dashboard', () => dashboardScreen({ t: t() }));

  route('/patients', ({ query }) => patientsScreen({ t: t(), query }));
  route('/patients/:id', ({ params, query }) => patientProfileScreen({ t: t(), id: Number(params.id), query }));

  route('/appointments', ({ query }) => appointmentsScreen({ t: t(), query }));
  route('/appointments/:id', ({ params }) => appointmentDetailScreen({ t: t(), id: Number(params.id) }));
  route('/calendar', ({ query }) => calendarScreen({ t: t(), query }));
  route('/queue', () => queueScreen({ t: t() }));

  route('/visits', ({ query }) => visitsScreen({ t: t(), query }));
  route('/visits/:id', ({ params }) => visitDetailScreen({ t: t(), id: Number(params.id) }));
  route('/chart/:id', ({ params, query }) => chartScreen({ t: t(), patientId: Number(params.id), query }));
  route('/treatments', ({ query }) => treatmentsScreen({ t: t(), query }));
  route('/plans', ({ query }) => plansScreen({ t: t(), query }));
  route('/plans/:id', ({ params }) => planDetailScreen({ t: t(), id: Number(params.id) }));
  route('/prescriptions', ({ query }) => prescriptionsScreen({ t: t(), query }));
  route('/prescriptions/new', ({ query }) => newPrescriptionScreen({ t: t(), query }));
  route('/prescriptions/:id', ({ params }) => prescriptionDetailScreen({ t: t(), id: Number(params.id) }));
  route('/referrals', ({ query }) => referralsScreen({ t: t(), query }));
  route('/referrals/:id', ({ params }) => referralDetailScreen({ t: t(), id: Number(params.id) }));
  route('/attachments', ({ query }) => attachmentsScreen({ t: t(), query }));

  route('/billing', ({ query }) => invoicesScreen({ t: t(), query }));
  route('/billing/:id', ({ params }) => invoiceDetailScreen({ t: t(), id: Number(params.id) }));
  route('/payments', ({ query }) => paymentsScreen({ t: t(), query }));
  route('/payments/:id', ({ params }) => paymentDetailScreen({ t: t(), id: Number(params.id) }));
  route('/receivables', () => receivablesScreen({ t: t() }));
  route('/finance', ({ query }) => financeScreen({ t: t(), query }));

  route('/staff', ({ query }) => staffScreen({ t: t(), query }));
  route('/staff/:id', ({ params }) => staffDetailScreen({ t: t(), id: Number(params.id) }));
  route('/payroll', ({ query }) => payrollScreen({ t: t(), query }));
  route('/inventory', ({ query }) => inventoryScreen({ t: t(), query }));
  route('/suppliers', ({ query }) => suppliersScreen({ t: t(), query }));

  route('/reports', ({ query }) => reportsScreen({ t: t(), query }));
  route('/reports/:key', ({ params, query }) => reportRunScreen({ t: t(), key: params.key, query }));
  route('/settings', ({ query }) => settingsScreen({ t: t(), query }));
  route('/users', ({ query }) => usersScreen({ t: t(), query }));
  route('/audit', ({ query }) => auditScreen({ t: t(), query }));
  route('/backup', () => backupScreen({ t: t() }));
  route('/notifications', () => notificationsScreen({ t: t() }));
  route('/about', () => aboutScreen({ t: t() }));
}
