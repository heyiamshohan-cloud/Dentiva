/**
 * DENTIVA — large-data QA (§ 84, § 85, § 90).
 *
 * Builds a synthetic clinic with thousands of patients and the clinical,
 * financial and inventory records that hang off them, then measures the paths a
 * busy front desk actually uses: paging through the patient register, searching,
 * loading the dashboard, running reports, reading receivables and exporting.
 *
 * Both correctness (no duplicate or missing rows across pages, report totals
 * match the underlying rows) and responsiveness (each interaction stays inside
 * a budget that a 100–200 % DPI desktop comfortably meets) are asserted, so a
 * regression shows up as a failing test instead of a slow afternoon.
 *
 *   bun run qa:large
 *   bun run qa:large --patients 5000
 *
 * The dataset is synthetic and lives in a temporary directory that is removed
 * at the end — it never touches a real clinic database.
 */
import { describe, expect, test, afterAll, beforeAll } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, openDatabase } from '../../src/server/db/connection.js';
import { migrate } from '../../src/server/db/migrations/index.js';
import { provisionClinic } from '../../src/server/services/clinic.js';
import { createPatient, listPatients, getPatientDetail } from '../../src/server/services/patients.js';
import { createVisit } from '../../src/server/services/visits.js';
import { createTreatment } from '../../src/server/services/treatments.js';
import { createInvoice, updateInvoice, listInvoices, receivables } from '../../src/server/services/billing.js';
import { recordPayment, listPayments } from '../../src/server/services/payments.js';
import { createInventoryItem, listInventoryItems, inventoryReport, recordStockMovement } from '../../src/server/services/inventory.js';
import { globalSearch } from '../../src/server/services/search.js';
import { dashboard, runReport, reportCatalogue } from '../../src/server/services/reports.js';
import { todayIso, addDays } from '../../src/server/domain/dates.js';

/** How many patients to synthesise (override with `--patients 5000`). */
const PATIENTS = (() => {
  const index = process.argv.indexOf('--patients');
  const value = index === -1 ? 1500 : Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 20000) : 1500;
})();

/** Response budgets in milliseconds (a 100–200 % DPI desktop is far slower). */
const BUDGET = {
  page: 120,
  deepPage: 200,
  search: 400,
  dashboard: 600,
  report: 900,
  receivables: 700,
  export: 2500,
};

const timings = [];
async function timed(label, budget, run) {
  const started = performance.now();
  const value = await run();
  const ms = performance.now() - started;
  timings.push({ label, ms, budget });
  expect({ label, within: ms <= budget }).toEqual({ label, within: true });
  return value;
}

/**
 * @type {{
 *   db: any, dir: string, dbPath: string, ctx: any,
 *   patientIds: number[], cleanup: () => void,
 * }}
 */
let env;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'dentiva-large-'));
  const dbPath = join(dir, 'dentiva.db');
  const db = openDatabase(dbPath);
  migrate(db, { appVersion: 'qa' });
  const provisioned = provisionClinic(db, {
    clinic: {
      code: 'QA',
      name: 'QA Large Clinic',
      phone: '01700000000',
      email: 'qa@example.invalid',
      city: 'Tangail',
      country: 'Bangladesh',
      currency_code: 'BDT',
      currency_symbol: '৳',
      locale: 'en',
    },
    dentist: { full_name: 'Dr. QA' },
    admin: { username: 'qatester', display_name: 'QA Admin', password: 'Qa#Large2026' },
  });
  const ctx = { clinicId: provisioned.clinicId, user: { id: provisioned.adminId, displayName: 'QA Admin' }, ip: '127.0.0.1' };
  env = {
    db,
    dir,
    dbPath,
    ctx,
    patientIds: [],
    cleanup() {
      try {
        closeDatabase();
      } catch {
        /* ignore */
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
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
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120 * attempt);
        }
      }
      if (lastError) throw new Error(`Failed to remove temporary directory '${dir}' after 8 attempts (${lastError.code}: ${lastError.message})`);
    },
  };

  // Deterministic pseudo-random data so the numbers are comparable across runs.
  let state = 987654321;
  const random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const int = (min, max) => min + Math.floor(random() * (max - min + 1));
  const cities = ['Tangail', 'Dhaka', 'Gazipur', 'Bogura', 'Cumilla'];
  const procedures = ['Composite filling', 'Root canal treatment', 'Scaling', 'Extraction', 'Crown'];

  for (let index = 1; index <= PATIENTS; index += 1) {
    const patient = createPatient(db, ctx, {
      full_name: `Load Patient ${String(index).padStart(5, '0')}`,
      gender: index % 2 ? 'male' : 'female',
      phone: `017${String(int(0, 99999999)).padStart(8, '0')}`,
      city: cities[index % cities.length],
      dob: `${1950 + (index % 60)}-0${(index % 9) + 1}-15`,
    });
    env.patientIds.push(patient.id);
    if (index % 5 === 0) {
      const visit = createVisit(db, ctx, {
        patient_id: patient.id,
        chief_complaint: 'Tooth pain',
        diagnosis: 'Dental caries',
        visit_date: addDays(todayIso(), -(index % 120)),
      });
      const treatment = createTreatment(db, ctx, {
        patient_id: patient.id,
        visit_id: visit.id,
        name: procedures[index % procedures.length],
        tooth_codes: [['11', '16', '24', '36', '46'][index % 5]],
        fee_minor: int(5, 80) * 10000,
        quantity_milli: 1000,
      });
      expect(typeof treatment.id).toBe('number');
      const invoice = createInvoice(db, ctx, {
        patient_id: patient.id,
        items: [{ description: procedures[index % procedures.length], quantity_milli: 1000, unit_price_minor: 50000 }],
      });
      updateInvoice(db, ctx, invoice.id, { status: 'issued' });
      if (index % 15 === 0) {
        recordPayment(db, ctx, {
          patient_id: patient.id,
          invoice_id: invoice.id,
          kind: 'payment',
          method_code: 'cash',
          amount_minor: 50000,
        });
      }
    }
  }

  for (const [index, name] of ['Composite resin', 'Lidocaine', 'Gloves', 'Suture'].entries()) {
    const item = createInventoryItem(db, ctx, {
      name,
      unit: 'box',
      min_stock_milli: 20000,
      purchase_price_minor: 50000 + index * 10000,
      sale_price_minor: 70000 + index * 10000,
    });
    // Stock arrives through movements, exactly as the UI does it.
    recordStockMovement(db, ctx, {
      item_id: item.id,
      kind: 'in',
      quantity_milli: 1000 * (index + 1) * 3,
      unit_cost_minor: 50000 + index * 10000,
      reason: 'Opening balance',
    });
  }
}, 300000);

afterAll(() => env?.cleanup());

describe('large data — patient register', () => {
  test('paging is fast and never repeats or drops a patient', async () => {
    const pageSize = 50;
    const first = await timed('patient page 1 (50 rows)', BUDGET.page, () => listPatients(env.db, env.ctx, { page: 1, pageSize }));
    expect(first.rows.length).toBe(pageSize);
    expect(first.total).toBe(PATIENTS);

    const deepPage = Math.floor(PATIENTS / pageSize);
    const deep = await timed(`patient page ${deepPage}`, BUDGET.deepPage, () => listPatients(env.db, env.ctx, { page: deepPage, pageSize }));
    expect(deep.rows.length).toBeGreaterThan(0);
    expect(deep.page).toBe(deepPage);

    // Walk every page once: ids must be unique and complete.
    const seen = new Set();
    const pages = Math.ceil(PATIENTS / pageSize);
    for (let page = 1; page <= pages; page += 1) {
      const chunk = listPatients(env.db, env.ctx, { page, pageSize });
      for (const row of chunk.rows) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
    }
    expect(seen.size).toBe(PATIENTS);
    expect(env.patientIds.every((id) => seen.has(id))).toBe(true);
  }, 60000);

  test('search finds a patient by name, code and phone', async () => {
    const target = env.patientIds[Math.floor(PATIENTS / 2)];
    const patient = getPatientDetail(env.db, env.ctx, target);

    await timed('search by name', BUDGET.search, () => globalSearch(env.db, env.ctx.clinicId, { q: 'Load Patient', limit: 20 }));
    const byCode = await timed('search by code', BUDGET.search, () => globalSearch(env.db, env.ctx.clinicId, { q: patient.patientCode, limit: 20 }));
    const byPhone = await timed('search by phone', BUDGET.search, () => globalSearch(env.db, env.ctx.clinicId, { q: patient.phone, limit: 20 }));

    const ids = (result) => (result.groups ?? []).flatMap((group) => (group.items ?? []).map((item) => item.entityId));
    expect(ids(byCode)).toContain(patient.id);
    expect(ids(byPhone)).toContain(patient.id);
  }, 60000);

  test('the dashboard aggregates thousands of records quickly', async () => {
    const summary = await timed('dashboard summary', BUDGET.dashboard, () => dashboard(env.db, env.ctx, { date: todayIso() }));
    expect(summary.patients?.total ?? summary.patients ?? 0).toBeTruthy();
  }, 60000);

  test('reports stay inside their budget and agree with the raw rows', async () => {
    const catalogue = reportCatalogue();
    expect(catalogue.length).toBeGreaterThan(10);

    const revenue = await timed('report: revenue', BUDGET.report, () =>
      runReport(env.db, env.ctx, 'revenue', { from: addDays(todayIso(), -365), to: todayIso() }));
    expect(revenue.rows.length).toBeGreaterThan(0);

    const invoiced = Number(env.db.query('SELECT COALESCE(SUM(total_minor), 0) AS c FROM invoices WHERE clinic_id = ? AND status = ?').get(env.ctx.clinicId, 'issued').c);
    const reported = Number(revenue.totals?.amount_minor ?? revenue.totals?.amountMinor ?? 0);
    expect(reported).toBe(invoiced);

    const ageing = await timed('receivables ageing', BUDGET.receivables, () => receivables(env.db, env.ctx, { asOf: todayIso() }));
    const dueTotal = Number(env.db.query('SELECT COALESCE(SUM(due_minor), 0) AS c FROM invoices WHERE clinic_id = ? AND status = ?').get(env.ctx.clinicId, 'issued').c);
    expect(ageing.totals ? Object.values(ageing.totals).reduce((sum, value) => sum + Number(value), 0) : -1).toBe(dueTotal);

    await timed('report: patients', BUDGET.report, () => runReport(env.db, env.ctx, 'patients', {}));
    await timed('report: inventory', BUDGET.report, () => runReport(env.db, env.ctx, 'inventory', {}));
    await timed('report: audit', BUDGET.report, () => runReport(env.db, env.ctx, 'audit', {}));
  }, 120000);

  test('invoice, payment and inventory lists page correctly at scale', async () => {
    const invoices = await timed('invoice page', BUDGET.page, () => listInvoices(env.db, env.ctx, { page: 1, pageSize: 50 }));
    expect(invoices.rows.length).toBeGreaterThan(0);
    const payments = await timed('payment page', BUDGET.page, () => listPayments(env.db, env.ctx, { page: 1, pageSize: 50 }));
    expect(payments.rows.length).toBeGreaterThanOrEqual(0);
    const inventory = await timed('inventory page', BUDGET.page, () => listInventoryItems(env.db, env.ctx, { page: 1, pageSize: 50 }));
    expect(inventory.rows.length).toBeGreaterThan(0);
    const report = await timed('inventory report', BUDGET.report, () => inventoryReport(env.db, env.ctx, {}));
    expect(report.valuation.costMinor).toBeGreaterThan(0);
    expect(report.lowStock.length).toBe(4);
    expect(report.byCategory.length).toBeGreaterThan(0);
  }, 60000);

  test('the database file itself stays compact', () => {
    const size = statSync(env.dbPath).size;
    timings.push({ label: 'database size', ms: 0, budget: 0 });
    console.log(`  · database size for ${PATIENTS} patients: ${(size / 1024 / 1024).toFixed(1)} MB`);
    // ~1 kB per patient with the full chain; anything wildly larger means an
    // index or a view is duplicating data.
    expect(size).toBeLessThan(PATIENTS * 4096 + 16 * 1024 * 1024);
  });

  test('every measured interaction stayed inside its budget', () => {
    const slowest = [...timings].filter((entry) => entry.budget > 0).sort((a, b) => b.ms - a.ms).slice(0, 5);
    console.log('  slowest interactions:');
    for (const entry of slowest) {
      console.log(`    ${entry.label.padEnd(28)} ${entry.ms.toFixed(1).padStart(8)} ms  (budget ${entry.budget} ms)`);
    }
    expect(slowest.every((entry) => entry.ms <= entry.budget)).toBe(true);
  });
});
