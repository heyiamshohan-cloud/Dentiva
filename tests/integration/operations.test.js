/**
 * Operations integration tests (§ 42–§ 51): staff and payroll, inventory
 * movements, the notification feed, reports/dashboard and backup/restore.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { SCHEMA_VERSION } from '../../src/shared/constants.js';
import { createTestEnv } from '../helpers/testEnv.js';
import { createPatient } from '../../src/server/services/patients.js';
import { createAttachment } from '../../src/server/services/attachments.js';
import { createVisit } from '../../src/server/services/visits.js';
import { createAppointment } from '../../src/server/services/appointments.js';
import { createTreatment } from '../../src/server/services/treatments.js';
import { createInvoice } from '../../src/server/services/billing.js';
import { recordPayment } from '../../src/server/services/payments.js';
import {
  archiveStaff,
  createPayroll,
  createStaff,
  deletePayroll,
  draftPayrollRun,
  getStaff,
  listPayroll,
  listStaff,
  payPayroll,
  practitionerWorkload,
  updateStaff,
} from '../../src/server/services/staff.js';
import {
  archiveInventoryItem,
  consumeForTreatment,
  createInventoryItem,
  deleteSupplier,
  getInventoryItem,
  inventoryReport,
  listInventoryCategories,
  listInventoryItems,
  listStockMovements,
  listSuppliers,
  recordStockMovement,
  saveSupplier,
  saveInventoryCategory,
  updateInventoryItem,
} from '../../src/server/services/inventory.js';
import { deleteExpense, listExpenses } from '../../src/server/services/finance.js';
import { dismiss, listNotifications, markAllRead, markRead, refreshNotifications, setPreference, unreadCount } from '../../src/server/services/notifications.js';
import { dashboard, patientStatement, reportCatalogue, reportCsv, runReport } from '../../src/server/services/reports.js';
import { createBackup, exportData, importPatients, listBackups, quarantineJournals, restoreBackup, verifyBackup } from '../../src/server/services/backup.js';
import { createZip, extractZip } from '../../src/server/domain/zip.js';
import { buildCsv, parseCsv } from '../../src/server/domain/csv.js';
import { closeDatabase, getDb } from '../../src/server/db/connection.js';
import { ConflictError, NotFoundError, ValidationError } from '../../src/shared/errors.js';
import { todayIso } from '../../src/server/domain/dates.js';

let env;
afterEach(() => env?.cleanup());

function setup() {
  env = createTestEnv();
  const ctx = { clinicId: env.clinicId, user: { id: env.admin.id, displayName: 'Admin' }, ip: '127.0.0.1', dataDir: env.dir };
  return { env, ctx };
}

let seq = 0;
function patient(e, ctx, name = 'Ops Patient') {
  seq += 1;
  return createPatient(e.db, ctx, { full_name: name, gender: 'male', phone: `016${String(30000000 + seq).slice(-8)}` });
}

describe('staff and payroll', () => {
  test('creates staff with sequential codes and separates practitioners', () => {
    const { env: e, ctx } = setup();
    const doctor = createStaff(e.db, ctx, { full_name: 'Dr. Rahat', is_practitioner: true, designation: 'Dental Surgeon', salary_minor: 4000000 });
    const assistant = createStaff(e.db, ctx, { full_name: 'Nurse Lima', role_title: 'assistant', salary_minor: 1500000 });
    expect(doctor.staffCode).toMatch(/^STF-/);
    expect(doctor.staffCode).not.toBe(assistant.staffCode);

    // The first-run wizard already created the clinic's practitioner.
    expect(listStaff(e.db, ctx, {}).total).toBe(3);
    expect(listStaff(e.db, ctx, { practitionersOnly: true }).total).toBe(2);
    updateStaff(e.db, ctx, assistant.id, { designation: 'Dental Assistant', phone: '01700000000' });
    expect(getStaff(e.db, ctx, assistant.id).designation).toBe('Dental Assistant');
    expect(getStaff(e.db, ctx, doctor.id).isPractitioner).toBe(true);
  });

  test('payroll drafts, partial payments and the salary expense stay in sync', () => {
    const { env: e, ctx } = setup();
    const doctor = createStaff(e.db, ctx, { full_name: 'Dr. Payroll', is_practitioner: true, salary_minor: 3000000 });
    const run = draftPayrollRun(e.db, ctx, { period_start: '2026-08-01', period_end: '2026-08-31' });
    expect(run.created.length).toBe(1);
    const payrollId = run.created[0].payrollId;
    expect(run.created[0].netMinor).toBe(3000000);

    const partial = payPayroll(e.db, ctx, payrollId, { amount_minor: 1000000, method_code: 'cash' });
    expect(partial.status).toBe('partial');
    expect(partial.expenseId).toBeTruthy();
    const expenses = listExpenses(e.db, ctx, { from: todayIso(), to: todayIso() });
    expect(expenses.rows.length).toBe(1);
    expect(expenses.rows[0].amountMinor).toBe(1000000);
    expect(expenses.rows[0].staffId).toBe(doctor.id);

    payPayroll(e.db, ctx, payrollId, { amount_minor: 2000000 });
    const final = listPayroll(e.db, ctx, { staffId: doctor.id }).rows[0];
    expect(final?.status).toBe('paid');
    expect(final?.dueMinor).toBe(0);
    expect(listExpenses(e.db, ctx, {}).rows[0].amountMinor).toBe(3000000);

    expect(() => payPayroll(e.db, ctx, payrollId, {})).toThrow(ConflictError);
    expect(() => deletePayroll(e.db, ctx, payrollId, 'nope')).toThrow(ConflictError);
    const secondRun = draftPayrollRun(e.db, ctx, { period_start: '2026-08-01', period_end: '2026-08-31' });
    expect(secondRun.created.length).toBe(0);
    expect(secondRun.skipped.length).toBe(1);
  });

  test('unpaid payroll can be removed and staff with dues cannot be archived', () => {
    const { env: e, ctx } = setup();
    const member = createStaff(e.db, ctx, { full_name: 'Unpaid Staff', salary_minor: 1000000 });
    const payroll = createPayroll(e.db, ctx, { staff_id: member.id, period_start: '2026-07-01', period_end: '2026-07-31' });
    expect(() => archiveStaff(e.db, ctx, member.id)).toThrow(ConflictError);
    deletePayroll(e.db, ctx, payroll.id, 'Drafted by mistake');
    archiveStaff(e.db, ctx, member.id, 'Left the clinic');
    expect(listStaff(e.db, ctx, {}).total).toBe(1); // only the provisioned practitioner remains
    expect(listStaff(e.db, ctx, { includeInactive: true }).total).toBe(1);
    expect(practitionerWorkload(e.db, ctx, {}).some((row) => row.id === member.id)).toBe(false);
  });
});

describe('inventory', () => {
  test('stock is derived from movements and prices update on purchase', () => {
    const { env: e, ctx } = setup();
    const supplier = saveSupplier(e.db, ctx, null, { name: 'Dental Supply Co.', phone: '01911111111' });
    const categories = listInventoryCategories(e.db, ctx);
    expect(categories.length).toBe(7);

    const item = createInventoryItem(e.db, ctx, {
      name: 'Composite resin A2',
      sku: 'CR-A2',
      category_id: categories[0].id,
      unit: 'syringe',
      min_stock_milli: 5000,
      purchase_price_minor: 120000,
      sale_price_minor: 200000,
      supplier_id: supplier.id,
    });
    expect(() => createInventoryItem(e.db, ctx, { name: 'Duplicate', sku: 'CR-A2' })).toThrow(ConflictError);

    recordStockMovement(e.db, ctx, { item_id: item.id, kind: 'in', quantity_milli: 10000, unit_cost_minor: 135000, reference_no: 'BILL-1' });
    const afterIn = getInventoryItem(e.db, ctx, item.id);
    expect(afterIn.quantityMilli).toBe(10000);
    expect(afterIn.purchasePriceMinor).toBe(135000);
    expect(afterIn.stockValueMinor).toBe(1350000);

    recordStockMovement(e.db, ctx, { item_id: item.id, kind: 'out', quantity_milli: 4000, reason: 'Procedure' });
    expect(getInventoryItem(e.db, ctx, item.id).quantityMilli).toBe(6000);
    expect(() => recordStockMovement(e.db, ctx, { item_id: item.id, kind: 'out', quantity_milli: 999999 })).toThrow(ConflictError);
    recordStockMovement(e.db, ctx, { item_id: item.id, kind: 'adjustment', quantity_milli: 5500, reason: 'Stock count' });
    expect(getInventoryItem(e.db, ctx, item.id).quantityMilli).toBe(5500);
    recordStockMovement(e.db, ctx, { item_id: item.id, kind: 'disposal', quantity_milli: 500, reason: 'Expired' });
    expect(getInventoryItem(e.db, ctx, item.id).quantityMilli).toBe(5000);
    expect(listStockMovements(e.db, ctx, { itemId: item.id }).total).toBe(4); // the refused issue is not recorded

    updateInventoryItem(e.db, ctx, item.id, { storage_location: 'Cabinet 2' });
    expect(getInventoryItem(e.db, ctx, item.id).storageLocation).toBe('Cabinet 2');
  });

  test('low stock, expiry alerts and treatment consumption are reported', () => {
    const { env: e, ctx } = setup();
    const item = createInventoryItem(e.db, ctx, { name: 'Gloves (box)', unit: 'box', min_stock_milli: 3000, purchase_price_minor: 45000 });
    recordStockMovement(e.db, ctx, { item_id: item.id, kind: 'in', quantity_milli: 2000, unit_cost_minor: 45000 });
    const report = inventoryReport(e.db, ctx, { expiringWithinDays: 30 });
    expect(report.lowStock.length).toBe(1);
    expect(report.lowStock[0]?.isLowStock).toBe(true);

    const p = patient(e, ctx, 'Consumption Patient');
    const treatment = createTreatment(e.db, ctx, { patient_id: p.id, name: 'Scaling', fee_minor: 100000 });
    consumeForTreatment(e.db, ctx, { item_id: item.id, treatment_id: treatment.id, quantity_milli: 500 });
    expect(getInventoryItem(e.db, ctx, item.id).quantityMilli).toBe(1500);
    const movement = listStockMovements(e.db, ctx, { kind: 'out' }).rows[0];
    expect(movement.treatmentId).toBe(treatment.id);
    expect(movement.patientId).toBe(p.id);

    // Expiring batch
    createInventoryItem(e.db, ctx, { name: 'Anaesthetic cartridge', expiry_date: todayIso(), batch_no: 'LOT-9' });
    expect(inventoryReport(e.db, ctx, {}).expiring.length).toBe(1);

    archiveInventoryItem(e.db, ctx, item.id, 'Discontinued');
    expect(listInventoryItems(e.db, ctx, {}).total).toBe(1);
    expect(listInventoryItems(e.db, ctx, { includeInactive: true }).total).toBe(2);
  });

  test('suppliers and categories stay manageable', () => {
    const { env: e, ctx } = setup();
    const supplier = saveSupplier(e.db, ctx, null, { name: 'Lab Partner', products: 'Crowns' });
    expect(listSuppliers(e.db, ctx, {}).total).toBe(1);
    saveSupplier(e.db, ctx, supplier.id, { phone: '01766666666', payment_terms: '30 days' });
    expect(listSuppliers(e.db, ctx, {}).rows[0].paymentTerms).toBe('30 days');
    deleteSupplier(e.db, ctx, supplier.id);
    expect(listSuppliers(e.db, ctx, {}).total).toBe(0);

    const category = saveInventoryCategory(e.db, ctx, null, { name_en: 'Ortho', name_bn: 'অর্থো', sort_order: 5 });
    expect(listInventoryCategories(e.db, ctx).some((entry) => entry.id === category.id)).toBe(true);
    saveInventoryCategory(e.db, ctx, category.id, { is_active: false });
    expect(listInventoryCategories(e.db, ctx).some((entry) => entry.id === category.id)).toBe(false);
  });
});

describe('notifications', () => {
  test('derives alerts from live data, de-duplicates and can be read', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Notify Patient');
    createAppointment(e.db, ctx, { patient_id: p.id, appt_date: todayIso(), start_time: '09:30' });
    createVisit(e.db, ctx, { patient_id: p.id, followup_date: todayIso(), diagnosis: 'Review' });
    const invoice = createInvoice(e.db, ctx, { patient_id: p.id, status: 'issued', items: [{ description: 'Consultation', unit_price_minor: 50000 }] });
    recordPayment(e.db, ctx, { patient_id: p.id, invoice_id: invoice.id, amount_minor: 10000 });

    const first = refreshNotifications(e.db, ctx);
    expect(first.created).toBeGreaterThanOrEqual(2);
    const second = refreshNotifications(e.db, ctx);
    expect(second.created).toBe(0); // de-duplicated

    const list = listNotifications(e.db, ctx, {});
    expect(list.total).toBe(first.created);
    expect(list.unread).toBe(list.total);
    markRead(e.db, ctx, Number(list.rows[0]?.id));
    expect(unreadCount(e.db, ctx)).toBe(list.total - 1);
    dismiss(e.db, ctx, list.rows[1]?.id);
    expect(listNotifications(e.db, ctx, {}).total).toBe(list.total - 1);
    markAllRead(e.db, ctx);
    expect(unreadCount(e.db, ctx)).toBe(0);

    const prefs = setPreference(e.db, ctx, 'low_stock', { enabled: false });
    expect(prefs.updated).toBe(true);
  });

  test('low stock and expiring items raise real alerts', () => {
    const { env: e, ctx } = setup();
    const item = createInventoryItem(e.db, ctx, { name: 'Saline', min_stock_milli: 1000 });
    const expiring = createInventoryItem(e.db, ctx, { name: 'Filling material', expiry_date: todayIso() });
    expect(item.id).not.toBe(expiring.id);
    const result = refreshNotifications(e.db, ctx);
    expect(result.created).toBeGreaterThanOrEqual(2);
    const kinds = listNotifications(e.db, ctx, {}).rows.map((row) => row?.kind);
    expect(kinds).toContain('low_stock');
    expect(kinds).toContain('expiring_stock');
  });
});

describe('reports and dashboard', () => {
  test('dashboard summarises the day from real records', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Dashboard Patient');
    createVisit(e.db, ctx, { patient_id: p.id, diagnosis: 'Check-up' });
    const invoice = createInvoice(e.db, ctx, { patient_id: p.id, status: 'issued', items: [{ description: 'Consultation', unit_price_minor: 80000 }] });
    recordPayment(e.db, ctx, { patient_id: p.id, invoice_id: invoice.id, amount_minor: 80000 });

    const data = dashboard(e.db, ctx, { date: todayIso() });
    expect(data.patients.total).toBe(1);
    expect(data.patients.newToday).toBe(1);
    expect(data.clinical.visitsToday).toBe(1);
    expect(data.money.collectedTodayMinor).toBe(80000);
    expect(data.clinic?.name).toBe('Test Dental Care');
    expect(data.trend14Days.length).toBeGreaterThanOrEqual(1);
    expect(reportCatalogue().length).toBeGreaterThanOrEqual(15);
  });

  test('reports run over a range and export to CSV with decimal money', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Report Patient');
    createTreatment(e.db, ctx, { patient_id: p.id, name: 'Extraction', fee_minor: 250000 });

    const treatments = runReport(e.db, ctx, 'treatments', { from: todayIso(), to: todayIso() });
    expect(treatments.rows.length).toBe(1);
    expect(treatments.totals.total_minor).toBe(250000);

    const csv = reportCsv(e.db, ctx, 'treatments', { from: todayIso(), to: todayIso() });
    expect(csv.csv.split('\r\n')[0]).toContain('total_minor');
    expect(csv.csv).toMatch(/2,?500\.00/);

    const statement = patientStatement(e.db, ctx, p.id, { from: '2000-01-01', to: todayIso() });
    expect(statement?.summary.outstandingMinor).toBe(0);
    expect(runReport(e.db, ctx, 'unknown_report', {}).unknown).toBe(true);
  });
});

describe('backup, restore and data exchange', () => {
  test('round-trips a ZIP archive', () => {
    const archive = createZip([
      { name: 'manifest.json', data: JSON.stringify({ ok: true }) },
      { name: 'attachments/2026/09/file.png', data: Buffer.from('89504e47', 'hex') },
    ]);
    const files = extractZip(archive);
    expect(files.get('manifest.json').toString()).toBe('{"ok":true}');
    expect(files.get('attachments/2026/09/file.png').length).toBe(4);
  });

  test('backup → change → verify → restore brings the data back', async () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Backup Patient');
    const attachment = await createAttachment(e.db, ctx, { patient_id: p.id, category: 'radiograph' }, new File([Buffer.from('89504e470d0a1a0a', 'hex')], 'x.png', { type: 'image/png' }));

    const backup = createBackup(e.db, ctx, {});
    expect(backup.attachments).toBe(1);
    expect(backup.missingAttachments).toBe(0);
    expect(existsSync(backup.path)).toBe(true);
    expect(listBackups(e.db, ctx).backups.length).toBe(1);

    const verification = verifyBackup(e.db, ctx, backup.path);
    expect(verification.ok).toBe(true);
    expect(verification.schemaVersion).toBe(SCHEMA_VERSION);
    expect(verification.counts?.patients).toBe(1);

    // Data added after the backup must disappear again.
    patient(e, ctx, 'After Backup');
    createTreatment(e.db, ctx, { patient_id: p.id, name: 'Temporary', fee_minor: 1000 });
    expect(e.db.query('SELECT COUNT(*) AS c FROM patients').get().c).toBe(2);

    const result = restoreBackup(e.db, ctx, { archivePath: backup.path, dataDir: e.dir });
    expect(result.restored).toBe(true);
    expect(result.attachmentsRestored).toBe(1);
    const db = getDb();
    expect(db.query('SELECT COUNT(*) AS c FROM patients').get().c).toBe(1);
    expect(db.query('SELECT COUNT(*) AS c FROM treatments').get().c).toBe(0);
    expect(Object.values(db.query('PRAGMA integrity_check').get())[0]).toBe('ok');
    expect(existsSync(`${e.dir}/attachments/${attachment.relPath}`)).toBe(true);
    // A pre-restore safety copy is always written.
    expect(readdirSync(`${e.dir}/backups`).some((file) => file.includes('pre-restore'))).toBe(true);
  });

  test('a foreign journal at the live name can never meet the restored database', () => {
    const { env: e } = setup();
    const dbPath = `${e.dir}/dentiva.db`;
    const previousPath = `${dbPath}.previous`;

    // The exact state Windows reaches when the platform holds the file: the
    // previous database's write-ahead log, shared memory and rollback journal
    // are still sitting at the live name after the swap. If any of them is
    // allowed to stay, SQLite replays the old snapshot's pages into the new
    // database on open. Quarantining must move every one of them aside.
    writeFileSync(dbPath, Buffer.from('x'));
    writeFileSync(`${dbPath}-wal`, Buffer.from('old-wal'));
    writeFileSync(`${dbPath}-shm`, Buffer.from('old-shm'));
    writeFileSync(`${dbPath}-journal`, Buffer.from('old-journal'));

    const survivors = quarantineJournals(dbPath, previousPath);

    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (existsSync(`${dbPath}${suffix}`)) {
        // The operating system still holds it. That is allowed, but only if
        // it was reported as a survivor — the restore must abort on it
        // rather than open the new database beside it.
        expect(survivors).toContain(`dentiva.db${suffix}`);
      } else {
        // Gone from the live name: it travelled with the previous database,
        // and it was not reported as left behind.
        expect(existsSync(`${previousPath}${suffix}`)).toBe(true);
        expect(survivors).not.toContain(`dentiva.db${suffix}`);
      }
    }
  });

  test('corrupt archives are refused and the live database is untouched', () => {
    const { env: e, ctx } = setup();
    patient(e, ctx, 'Corrupt Guard');
    const backup = createBackup(e.db, ctx, {});
    const corrupted = `${e.dir}/backups/broken.zip`;
    // Truncating an archive must always be detected.
    const raw = readFileSync(backup.path);
    writeFileSync(corrupted, raw.subarray(0, Math.max(64, Math.floor(raw.length / 3))));
    expect(() => verifyBackup(e.db, ctx, corrupted)).toThrow(ValidationError);
    expect(() => restoreBackup(e.db, ctx, { archivePath: corrupted, dataDir: e.dir })).toThrow(ValidationError);
    expect(e.db.query('SELECT COUNT(*) AS c FROM patients').get().c).toBe(1);
  });

  test('CSV export/import of patients validates every row', () => {
    const { env: e, ctx } = setup();
    const csv = buildCsv(
      [{ key: 'full_name' }, { key: 'gender' }, { key: 'phone' }],
      [
        { full_name: 'Imported One', gender: 'male', phone: '01711110000' },
        { full_name: '', gender: 'male', phone: '01711110001' },
        { full_name: 'Bad Gender', gender: 'unknown', phone: '01711110002' },
      ],
    );
    const parsed = parseCsv(csv);
    expect(parsed.rows.length).toBe(3);

    const dryRun = importPatients(e.db, ctx, csv, { dryRun: true });
    expect(dryRun.created).toBe(1);
    expect(dryRun.failed).toBe(2);
    expect(e.db.query('SELECT COUNT(*) AS c FROM patients').get().c).toBe(0);

    const imported = importPatients(e.db, ctx, csv);
    expect(imported.created).toBe(1);
    expect(imported.failed).toBe(2);
    expect(e.db.query('SELECT COUNT(*) AS c FROM patients').get().c).toBe(1);
    const row = e.db.query('SELECT full_name, patient_code FROM patients').get();
    expect(row.full_name).toBe('Imported One');
    expect(row.patient_code).toBe('DEN-000001');
  });

  test('full data export contains a CSV per module', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Export Patient');
    const invoice = createInvoice(e.db, ctx, { patient_id: p.id, status: 'issued', items: [{ description: 'Consultation', unit_price_minor: 60000 }] });
    recordPayment(e.db, ctx, { patient_id: p.id, invoice_id: invoice.id, amount_minor: 60000 });
    const expense = 1;
    void expense;

    const exported = exportData(e.db, ctx, {});
    expect(exported.counts.patients).toBe(1);
    expect(exported.counts.invoices).toBe(1);
    expect(exported.counts.payments).toBe(1);
    expect(existsSync(exported.path)).toBe(true);
    const files = extractZip(readFileSync(exported.path));
    expect(files.has('data/patients.csv')).toBe(true);
    expect(files.get('data/patients.csv').toString()).toContain('Export Patient');
  });
});
