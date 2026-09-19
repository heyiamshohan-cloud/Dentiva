/**
 * HTTP API integration tests (§ 3, § 41, § 74).
 *
 * Boots the real local server on a loopback port with its own data directory,
 * then drives it the way the application window does: first-run setup, sign-in
 * cookie, app-token gate, permissions, documents and error handling.
 *
 * Every mounted route is also probed once to prove the router, the argument
 * parsing and the permission map agree — a 500 anywhere fails the suite.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/index.js';
import { createApiRouter } from '../../src/server/http/routes.js';
import { createUserWithRole } from '../helpers/testEnv.js';

let app;
let dataDir;
let cookie = '';
let secondCookie = '';
const APP_TOKEN = 'test-app-token';

const base = () => app.url;
const authed = (extra = {}) => ({ 'x-dentiva-app': APP_TOKEN, cookie, ...extra });
const jsonHeaders = (extra = {}) => ({ 'x-dentiva-app': APP_TOKEN, cookie, 'content-type': 'application/json', ...extra });

/**
 * @param {string} path
 * @param {{ method?: string, body?: any, headers?: Record<string, string> }} [options]
 */
async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${base()}${path}`, {
    method,
    headers: jsonHeaders(headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, payload, response };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'dentiva-api-'));
  app = await startServer({ dataDir, port: 0, dev: true, appToken: APP_TOKEN, quiet: true });

  const setup = await fetch(`${base()}/api/auth/first-run`, {
    method: 'POST',
    headers: { 'x-dentiva-app': APP_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({
      clinic: { code: 'MAIN', name: 'API Test Dental', phone: '01710000000', currency_code: 'BDT', currency_symbol: '৳', locale: 'en' },
      dentist: { full_name: 'Dr. API', designation: 'Dentist' },
      admin: { username: 'owner', password: 'Gr33nLeaf!42', display_name: 'Owner' },
    }),
  });
  cookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';

  // A second, limited account for permission tests.
  const clinicId = app.db.query('SELECT id FROM clinics').get().id;
  const assistant = createUserWithRole(app.db, clinicId, 'assistant', 'assistant');
  const authService = await import('../../src/server/services/auth.js');
  const session = authService.login(app.db, { username: 'assistant', password: 'Gr33nLeaf!42' });
  void assistant;
  secondCookie = `dentiva_session=${session.token}`;
});

afterAll(() => {
  app?.stop();
  if (dataDir && existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
});

describe('session and security', () => {
  test('serves health, status and the application shell', async () => {
    const health = await (await fetch(`${base()}/health`)).json();
    expect(health.ok).toBe(true);
    expect(health.version).toBe('1.0.0');

    const status = await api('/api/auth/status');
    expect(status.payload.firstRun).toBe(false);
    expect(status.payload.authenticated).toBe(true); // cookie present

    const shell = await fetch(`${base()}/`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('Dentiva');
  });

  test('refuses API calls without the launch token', async () => {
    const response = await fetch(`${base()}/api/patients`, { headers: { cookie } });
    expect(response.status).toBe(401);
  });

  test('refuses API calls without a session', async () => {
    const response = await fetch(`${base()}/api/patients`, { headers: { 'x-dentiva-app': APP_TOKEN } });
    expect(response.status).toBe(401);
  });

  test('blocks path traversal on static files', async () => {
    const traversal = await fetch(`${base()}/app/%2e%2e%2f%2e%2e%2fpackage.json`);
    expect(traversal.status).toBe(404);
    const escaped = await fetch(`${base()}/fonts/..%2f..%2fpackage.json`);
    expect(escaped.status).toBe(404);
    // An unresolved path falls back to the shell, never to a file outside the app.
    const leaked = await fetch(`${base()}/..%2f..%2fetc%2fpasswd`);
    expect(await leaked.text()).not.toContain('root:x:0:0');
  });

  test('sign-in rejects a wrong password and accepts the right one', async () => {
    const bad = await fetch(`${base()}/api/auth/login`, {
      method: 'POST',
      headers: { 'x-dentiva-app': APP_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'not-the-password' }),
    });
    expect(bad.status).toBe(401);

    const good = await fetch(`${base()}/api/auth/login`, {
      method: 'POST',
      headers: { 'x-dentiva-app': APP_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'Gr33nLeaf!42' }),
    });
    expect(good.status).toBe(200);
    const payload = await good.json();
    expect(payload.user.username).toBe('owner');
    expect(Array.isArray(payload.user.permissions)).toBe(true);
    expect(payload.user.permissions).toContain('patients.view');
  });

  test('enforces permissions for limited roles', async () => {
    const response = await fetch(`${base()}/api/settings`, { headers: { 'x-dentiva-app': APP_TOKEN, cookie: secondCookie } });
    expect(response.status).toBe(403);
    const me = await fetch(`${base()}/api/session/me`, { headers: { 'x-dentiva-app': APP_TOKEN, cookie: secondCookie } }).then((r) => r.json());
    expect(me.permissions).not.toContain('settings.manage');
    expect(me.permissions.length).toBeGreaterThan(0);
  });

  test('validates request bodies and returns typed errors', async () => {
    const bad = await api('/api/patients', { method: 'POST', body: { full_name: '', gender: 'x' } });
    expect(bad.status).toBe(422);
    expect(bad.payload.error.code).toBe('validation_error');

    const missing = await api('/api/patients/999999');
    expect(missing.status).toBe(404);

    const broken = await fetch(`${base()}/api/patients`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{not json',
    });
    expect(broken.status).toBe(422);
  });
});

describe('core workflow over HTTP', () => {
  test('registers a patient and reads the 360° view', async () => {
    const created = await api('/api/patients', {
      method: 'POST',
      body: { full_name: 'API Patient', gender: 'female', phone: '01712223344', dob: '1990-05-04', city: 'Dhaka' },
    });
    expect(created.status).toBe(200);
    const patientId = created.payload.id;

    const detail = await api(`/api/patients/${patientId}`);
    expect(detail.payload.fullName).toBe('API Patient');
    expect(detail.payload.patientCode).toMatch(/^DEN-/);

    const list = await api('/api/patients?search=API');
    expect(list.payload.total).toBe(1);

    const updated = await api(`/api/patients/${patientId}`, { method: 'PUT', body: { phone: '01719998877' } });
    expect(updated.payload.phone).toBe('01719998877');

    const timeline = await api(`/api/patients/${patientId}/timeline`);
    expect(Array.isArray(timeline.payload.rows)).toBe(true);
  });

  test('runs the appointment → queue → visit flow', async () => {
    const patient = (await api('/api/patients', { method: 'POST', body: { full_name: 'Flow Patient', gender: 'male', phone: '01715550000' } })).payload;
    const today = new Date().toISOString().slice(0, 10);

    const appointment = await api('/api/appointments', {
      method: 'POST',
      body: { patient_id: patient.id, appt_date: today, start_time: '10:00', duration_minutes: 30, reason: 'Check-up' },
    });
    expect(appointment.status).toBe(200);
    expect(appointment.payload.appointmentCode).toMatch(/^APT-/);

    const agenda = await api(`/api/appointments/agenda?date=${today}`);
    expect(agenda.payload.appointments.length).toBe(1);

    const checkedIn = await api('/api/queue/check-in', { method: 'POST', body: { appointmentId: appointment.payload.id } });
    expect(checkedIn.payload.serialNo).toBeGreaterThanOrEqual(1);

    const queueList = await api('/api/queue');
    expect(queueList.payload.entries.length).toBe(1);

    await api(`/api/queue/${checkedIn.payload.id}/call`, { method: 'POST' });
    await api(`/api/queue/${checkedIn.payload.id}/start`, { method: 'POST' });
    const completed = await api(`/api/queue/${checkedIn.payload.id}/complete`, { method: 'POST', body: {} });
    expect(completed.status).toBe(200);

    const visit = await api('/api/visits', {
      method: 'POST',
      body: { patient_id: patient.id, chief_complaint: 'Pain', diagnosis: 'Caries', followup_date: today },
    });
    expect(visit.payload.visitCode).toMatch(/^VS-/);

    const chart = await api('/api/chart/conditions');
    expect(chart.payload.rows.length).toBeGreaterThan(10);
    const conditions = chart.payload.rows;
    const caries = conditions.find((row) => row.code === 'caries');
    expect(caries).toBeTruthy();
    const entry = await api('/api/chart/entries', {
      method: 'POST',
      body: { patient_id: patient.id, tooth_code: '16', condition_code: caries.code, surfaces: ['O', 'M'] },
    });
    expect(entry.status).toBe(200);
    const chartView = await api(`/api/chart/${patient.id}`);
    expect(Object.keys(chartView.payload.teeth).length).toBeGreaterThan(20);
    expect(chartView.payload.teeth['16'].conditions[0].conditionCode).toBe('caries');

    const followups = await api('/api/visits/followups');
    expect(followups.payload.rows.length).toBe(1);
  });

  test('writes a prescription, a plan and a referral', async () => {
    const patient = (await api('/api/patients', { method: 'POST', body: { full_name: 'Clinical Patient', gender: 'female', phone: '01713334455' } })).payload;

    const prescription = await api('/api/prescriptions', {
      method: 'POST',
      body: {
        patient_id: patient.id,
        diagnosis: 'Acute pulpitis',
        advice: 'Soft diet',
        items: [{ medication: 'Amoxicillin', strength: '500 mg', dose: '1 capsule', frequency: '1 + 0 + 1', duration: '5 days', instructions: 'After meal' }],
      },
    });
    expect(prescription.payload.rxCode).toMatch(/^RX-/);
    expect(prescription.payload.itemCount).toBe(1);
    const rxList = await api('/api/prescriptions?pageSize=5');
    expect(rxList.payload.rows.length).toBe(1);
    const rxDetail = await api(`/api/prescriptions/${prescription.payload.id}`);
    expect(rxDetail.payload.items.length).toBe(1);
    expect(rxDetail.payload.items[0].medication).toBe('Amoxicillin');

    const template = await api('/api/prescriptions/templates', { method: 'POST', body: { name: 'Post-extraction', items: [{ medication: 'Paracetamol' }] } });
    expect(template.status).toBe(200);

    const plan = await api('/api/plans', {
      method: 'POST',
      body: {
        patient_id: patient.id,
        title: 'Functional rehabilitation',
        items: [
          { name: 'Scaling', quantity_milli: 1000, unit_price_minor: 150000 },
          { name: 'Composite filling', tooth_codes: ['16'], quantity_milli: 1000, unit_price_minor: 250000, stage: 'stage2' },
        ],
      },
    });
    expect(plan.payload.planCode).toMatch(/^TP-/);
    expect(plan.payload.totalMinor).toBe(400000);

    const referral = await api('/api/referrals', {
      method: 'POST',
      body: { patient_id: patient.id, provider_name: 'Dr. Ortho', specialty: 'Orthodontics', reason: 'Crowding', urgency: 'routine' },
    });
    expect(referral.payload.referralCode).toMatch(/^REF-/);
    const directory = await api('/api/referrals/directory');
    expect(directory.payload.specialties ?? directory.payload.length ?? 0).toBeTruthy();

    const outcome = await api(`/api/referrals/${referral.payload.id}/outcome`, { method: 'POST', body: { status: 'completed', outcome: 'Braces started' } });
    expect(outcome.status).toBe(200);
  });

  test('bills treatment, takes payment and reconciles finance', async () => {
    const patient = (await api('/api/patients', { method: 'POST', body: { full_name: 'Billing Patient', gender: 'male', phone: '01714445566' } })).payload;
    const treatment = await api('/api/treatments', {
      method: 'POST',
      body: { patient_id: patient.id, name: 'Root canal', tooth_codes: ['36'], fee_minor: 600000, status: 'completed' },
    });
    expect(treatment.payload.totalMinor).toBe(600000);

    const unbilled = await api(`/api/treatments/unbilled?patientId=${patient.id}`);
    expect(unbilled.payload.rows.length).toBe(1);

    const invoice = await api('/api/invoices', {
      method: 'POST',
      body: {
        patient_id: patient.id,
        status: 'issued',
        items: [{ description: 'Root canal', treatment_id: treatment.payload.id, quantity_milli: 1000, unit_price_minor: 600000 }],
      },
    });
    expect(invoice.payload.invoiceNumber).toMatch(/^INV-/);
    expect(invoice.payload.totalMinor).toBe(600000);
    const invoiceDetail = await api(`/api/invoices/${invoice.payload.id}`);
    expect(invoiceDetail.payload.dueMinor).toBe(600000);
    expect(invoiceDetail.payload.patientId).toBe(patient.id);

    const payment = await api('/api/payments', {
      method: 'POST',
      body: { patient_id: patient.id, invoice_id: invoice.payload.id, amount_minor: 600000, method_code: 'cash' },
    });
    expect(payment.payload.receipts.length).toBe(1);
    const receiptId = payment.payload.receipts[0].id;
    expect(payment.payload.receipts[0].receiptNumber).toMatch(/^RCP-/);
    expect(payment.payload.invoice.dueMinor).toBe(0);

    const invoiceAfter = await api(`/api/invoices/${invoice.payload.id}`);
    expect(invoiceAfter.payload.paymentStatus).toBe('paid');

    const collections = await api('/api/payments/collections?preset=this_month');
    expect(collections.payload.totalCollectedMinor).toBe(600000);

    const finance = await api('/api/finance/summary?preset=this_month');
    expect(finance.payload.collectedMinor).toBe(600000);
    expect(finance.payload.invoicedMinor).toBe(600000);

    const expense = await api('/api/finance/expenses', { method: 'POST', body: { expense_date: new Date().toISOString().slice(0, 10), amount_minor: 120000, payee: 'Lab', description: 'Crown work' } });
    expect(expense.status).toBe(200);
    const summary2 = await api('/api/finance/summary?preset=this_month');
    expect(summary2.payload.expensesMinor).toBe(120000);
    expect(summary2.payload.netCashMinor).toBe(480000);

    const refund = await api('/api/payments/refund', { method: 'POST', body: { payment_id: receiptId, amount_minor: 100000, reason: 'Treatment changed' } });
    expect(refund.status).toBe(200);
    const collections2 = await api('/api/payments/collections?preset=this_month');
    expect(collections2.payload.totalCollectedMinor).toBe(600000);
    expect(collections2.payload.totalRefundedMinor).toBe(100000);
    expect(collections2.payload.totalNetMinor).toBe(500000);
  });

  test('tracks stock, staff and payroll', async () => {
    const categories = await api('/api/inventory/categories');
    const categoryId = categories.payload.rows[0].id;
    const item = await api('/api/inventory', {
      method: 'POST',
      body: { name: 'Composite A2', sku: 'API-COMP-A2', category_id: categoryId, unit: 'syringe', min_stock_milli: 4000, purchase_price_minor: 120000, sale_price_minor: 200000 },
    });
    expect(item.status).toBe(200);

    await api('/api/inventory/movements', { method: 'POST', body: { item_id: item.payload.id, kind: 'in', quantity_milli: 10000, unit_cost_minor: 125000 } });
    await api('/api/inventory/movements', { method: 'POST', body: { item_id: item.payload.id, kind: 'out', quantity_milli: 3000, reason: 'Procedure' } });
    const after = await api(`/api/inventory/${item.payload.id}`);
    expect(after.payload.quantityMilli).toBe(7000);

    const report = await api('/api/inventory/report');
    expect(report.payload.valuation.items).toBeGreaterThanOrEqual(1);

    const member = await api('/api/staff', { method: 'POST', body: { full_name: 'API Assistant', designation: 'Assistant', salary_minor: 1500000 } });
    expect(member.payload.staffCode).toMatch(/^STF-/);

    const payroll = await api('/api/payroll/draft-run', { method: 'POST', body: {} });
    expect(payroll.payload.created.length).toBeGreaterThanOrEqual(1);
    const payrollId = payroll.payload.created[0].payrollId;
    const paid = await api(`/api/payroll/${payrollId}/pay`, { method: 'POST', body: { amount_minor: 1500000 } });
    expect(paid.payload.status).toBe('paid');
  });

  test('searches, reports, notifies and audits', async () => {
    const search = await api('/api/search?q=API');
    expect(Array.isArray(search.payload.patients ?? search.payload.results ?? [])).toBe(true);

    const quick = await api('/api/search/quick?q=API&limit=5');
    expect(quick.payload.results.length).toBeGreaterThan(0);

    const catalogue = await api('/api/reports');
    expect(catalogue.payload.rows.length).toBeGreaterThanOrEqual(15);

    const revenue = await api('/api/reports/run?key=revenue&preset=this_month');
    expect(revenue.payload.totals).toBeTruthy();

    const csv = await api('/api/reports/export?key=collections&preset=this_month');
    expect(csv.payload.fileName).toContain('collections');
    expect(csv.payload.content.length).toBeGreaterThan(10);

    const notifications = await api('/api/notifications/refresh', { method: 'POST' });
    expect(notifications.status).toBe(200);
    const unread = await api('/api/notifications/count');
    expect(unread.payload.unread).toBeGreaterThanOrEqual(0);

    const audit = await api('/api/audit?module=security&action=login&pageSize=10');
    expect(audit.payload.rows.length).toBeGreaterThan(0);
    const actions = audit.payload.rows.map((row) => row.action);
    expect(actions).toContain('login');
    expect(audit.payload.rows[0].userName).toBe('Owner');
    expect(audit.payload.rows[0].createdAt).toBeTruthy();
    for (const row of audit.payload.rows) {
      expect(JSON.stringify(row)).not.toContain('Gr33nLeaf');
    }
  });

  test('backup, verify, export and patient import', async () => {
    const created = await api('/api/backup/create', { method: 'POST', body: {} });
    expect(created.payload.bytes).toBeGreaterThan(1000);
    expect(existsSync(created.payload.path)).toBe(true);

    const listed = await api('/api/backup/list');
    expect(listed.payload.backups.length).toBe(1);

    const verified = await api('/api/backup/verify', { method: 'POST', body: { path: created.payload.path } });
    expect(verified.payload.ok).toBe(true);

    const exported = await api('/api/backup/export', { method: 'POST', body: {} });
    expect(exported.payload.counts.patients).toBeGreaterThan(0);

    const csv = 'full_name,gender,phone\nAPI Import,male,01911111111\n, female,01911111112\n';
    const preview = await api('/api/backup/import/patients', { method: 'POST', body: { csv, dryRun: true } });
    expect(preview.payload.created).toBe(1);
    expect(preview.payload.failed).toBe(1);
    const imported = await api('/api/backup/import/patients', { method: 'POST', body: { csv } });
    expect(imported.payload.created).toBe(1);
  });

  test('settings round-trip and role catalogue', async () => {
    const settings = await api('/api/settings');
    expect(settings.payload.groups.length).toBeGreaterThan(5);

    const saved = await api('/api/settings', { method: 'PUT', body: { settings: { 'billing.taxEnabled': true, 'billing.taxRateBp': 500 } } });
    expect(saved.payload.values['billing.taxEnabled']).toBe(true);

    const invalid = await api('/api/settings', { method: 'PUT', body: { settings: { 'not.a.setting': 1 } } });
    expect(invalid.status).toBe(422);

    const roles = await api('/api/roles');
    expect(roles.payload.rows.length).toBe(5);
    const catalogue = await api('/api/roles/catalogue');
    expect(catalogue.payload.groups.length).toBeGreaterThan(5);

    const users = await api('/api/users');
    expect(users.payload.rows.length).toBe(2);
  });

  test('renders print documents for every clinical record', async () => {
    const patient = (await api('/api/patients', { method: 'POST', body: { full_name: 'Document Patient', gender: 'male', phone: '01716667788' } })).payload;
    const invoice = await api('/api/invoices', {
      method: 'POST',
      body: { patient_id: patient.id, status: 'issued', items: [{ description: 'Consultation', quantity_milli: 1000, unit_price_minor: 80000 }] },
    });
    const payment = await api('/api/payments', { method: 'POST', body: { patient_id: patient.id, invoice_id: invoice.payload.id, amount_minor: 80000, method_code: 'cash' } });
    const prescription = await api('/api/prescriptions', { method: 'POST', body: { patient_id: patient.id, items: [{ medication: 'Ibuprofen', dose: '1 tablet', frequency: '1 + 0 + 1', duration: '3 days' }] } });
    const plan = await api('/api/plans', { method: 'POST', body: { patient_id: patient.id, title: 'Plan', items: [{ name: 'Filling', quantity_milli: 1000, unit_price_minor: 250000 }] } });
    const visit = await api('/api/visits', { method: 'POST', body: { patient_id: patient.id, diagnosis: 'Healthy' } });
    const referral = await api('/api/referrals', { method: 'POST', body: { patient_id: patient.id, provider_name: 'Dr. Ref', reason: 'Review' } });

    // The two documents a front desk prints but that no clinical record depends
    // on: an appointment slip and a payslip.
    const appointment = await api('/api/appointments', {
      method: 'POST',
      body: { patient_id: patient.id, appt_date: new Date().toISOString().slice(0, 10), start_time: '10:30', duration_minutes: 30, reason: 'Check-up' },
    });
    const queueEntry = await api('/api/queue/check-in', { method: 'POST', body: { patientId: patient.id } });
    const staffMember = await api('/api/staff', {
      method: 'POST',
      body: { full_name: 'Payroll Staff', role_title: 'assistant', salary_type: 'monthly', salary_minor: 2500000, joining_date: '2026-01-01' },
    });
    const payroll = await api('/api/payroll', {
      method: 'POST',
      body: { staff_id: staffMember.payload.id, period_start: '2026-08-01', period_end: '2026-08-31', gross_minor: 2500000, deduction_minor: 100000 },
    });

    const patientDocuments = [
      `/documents/invoice/${invoice.payload.id}`,
      `/documents/receipt/${payment.payload.receipts[0].id}`,
      `/documents/prescription/${prescription.payload.id}`,
      `/documents/plan/${plan.payload.id}`,
      `/documents/visit/${visit.payload.id}`,
      `/documents/referral/${referral.payload.id}`,
      `/documents/statement/${patient.id}`,
      `/documents/patient-card/${patient.id}`,
      `/documents/queue-ticket/${queueEntry.payload.id}`,
      `/documents/appointment-slip/${appointment.payload.id}`,
      `/documents/payslip/${payroll.payload.id}`,
    ];

    for (const path of patientDocuments) {
      const response = await fetch(`${base()}${path}`, { headers: { cookie } });
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
      const html = await response.text();
      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(html).toContain('</html>');
      // Every document names either the patient or the staff member it belongs to,
      // and none of them may fall through to the “unknown document” page.
      expect(html.includes('Document Patient') || html.includes('Payroll Staff')).toBe(true);
      expect(html).not.toContain('Unknown document');
    }

    // A report document is clinic-level: it must carry totals and the date range.
    const report = await fetch(`${base()}/documents/report?key=revenue&preset=this_month`, { headers: { cookie } });
    expect(report.status).toBe(200);
    const reportHtml = await report.text();
    expect(reportHtml).toContain('Revenue');
    expect(reportHtml).toContain('API Test Dental');

    // Documents are never served to an unauthenticated client.
    const anonymous = await fetch(`${base()}/documents/invoice/${invoice.payload.id}`);
    expect(anonymous.status).toBe(401);
  });

  test('key read endpoints answer with data', async () => {
    const probes = [
      '/api/session/me',
      '/api/clinic',
      '/api/dashboard/summary',
      '/api/dashboard/alerts',
      '/api/search?q=API',
      '/api/search/quick?q=API&limit=5',
      '/api/patients?pageSize=5',
      '/api/patients/summary',
      '/api/patients/1',
      '/api/patients/1/stats',
      '/api/patients/1/timeline',
      '/api/patients/1/notes',
      '/api/patients/1/statement',
      '/api/visits?pageSize=5',
      '/api/visits/followups',
      '/api/chart/conditions',
      '/api/chart/1',
      '/api/chart/1/summary',
      '/api/plans?pageSize=5',
      '/api/treatments?pageSize=5',
      '/api/treatments/unbilled',
      '/api/treatments/services',
      '/api/prescriptions?pageSize=5',
      '/api/referrals?pageSize=5',
      '/api/attachments?pageSize=5',
      '/api/appointments?pageSize=5',
      '/api/appointments/types/list',
      '/api/queue',
      '/api/queue/summary',
      '/api/invoices?pageSize=5',
      '/api/invoices/receivables',
      '/api/payments?pageSize=5',
      '/api/payments/collections',
      '/api/payments/methods/list',
      '/api/finance/summary',
      '/api/finance/trends',
      '/api/finance/income-categories',
      '/api/finance/expense-categories',
      '/api/finance/incomes',
      '/api/finance/expenses',
      '/api/staff?pageSize=5',
      '/api/payroll?pageSize=5',
      '/api/inventory?pageSize=5',
      '/api/inventory/report',
      '/api/inventory/categories',
      '/api/suppliers',
      '/api/reports',
      '/api/notifications?pageSize=5',
      '/api/notifications/count',
      '/api/notifications/preferences',
      '/api/settings',
      '/api/users',
      '/api/roles',
      '/api/roles/catalogue',
      '/api/audit?pageSize=5',
      '/api/backup/list',
    ];
    const failures = [];
    for (const path of probes) {
      const response = await fetch(`${base()}${path}`, { headers: authed() });
      if (response.status !== 200) failures.push(`${path} → ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
    expect(failures).toEqual([]);
  });

  test('the owner is never blocked by a missing permission code', async () => {
    // A route guarded with a code that is not in the permission catalogue is
    // unreachable for every role, including the owner (whose grant is the
    // expanded catalogue). Probing every mounted route as the owner proves the
    // route metadata and the catalogue agree.
    const routes = createApiRouter().describe();
    expect(routes.length).toBeGreaterThan(200);
    const failures = [];
    for (const route of routes) {
      if (route.path.startsWith('/api/documents')) continue;
      const path = route.path.replace(/:[A-Za-z]+/g, '1');
      const method = route.method;
      const response = await fetch(`${base()}${path}`, {
        method,
        headers: jsonHeaders(),
        body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({}),
      });
      if (response.status === 403) {
        failures.push(`${method} ${path} → 403 ${(await response.text()).slice(0, 160)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('no mounted route produces a server error', async () => {
    const router = createApiRouter();
    const routes = router.describe().filter((route) => route.method === 'GET');
    expect(routes.length).toBeGreaterThan(60);
    const failures = [];
    for (const route of routes) {
      const path = route.path.replace(/:[A-Za-z]+/g, '1');
      const response = await fetch(`${base()}${path}`, { headers: authed() });
      if (response.status >= 500) failures.push(`${path} → ${response.status} ${(await response.text()).slice(0, 300)}`);
    }
    expect(failures).toEqual([]);
  });
});
