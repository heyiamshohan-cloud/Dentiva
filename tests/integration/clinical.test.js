/**
 * Clinical integration tests (§ 88): visits, odontogram, treatments, plans,
 * prescriptions, referrals and attachments — the whole clinical chain for one
 * patient, including the cross-module side effects (plan progress, chart
 * entries, unbilled treatment feed, returned referral reports).
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createTestEnv } from '../helpers/testEnv.js';
import { createPatient } from '../../src/server/services/patients.js';
import { createVisit, deleteVisit, followupsDue, getVisit, listVisits, patientClinicalHistory, updateVisit } from '../../src/server/services/visits.js';
import {
  addChartEntry,
  chartHistory,
  chartSummary,
  clearChartEntry,
  getChart,
  toothConditions,
  updateChartEntry,
} from '../../src/server/services/dentalChart.js';
import {
  archiveService,
  createService,
  createTreatment,
  deleteTreatment,
  listServices,
  listTreatments,
  refreshPlanStatus,
  starterServiceCatalogue,
  unbilledTreatments,
  updateTreatment,
} from '../../src/server/services/treatments.js';
import { createPlan, deletePlan, getPlan, planItemsForInvoice, updatePlan, updatePlanItem } from '../../src/server/services/treatmentPlans.js';
import { createPrescription, getPrescription, listPrescriptions, markPrinted, saveTemplate } from '../../src/server/services/prescriptions.js';
import { createReferral, deleteReferral, getReferral, listReferrals, recordReferralOutcome, referralDirectory } from '../../src/server/services/referrals.js';
import {
  attachmentUsage,
  createAttachment,
  deleteAttachment,
  getAttachment,
  listAttachments,
  restoreAttachment,
  verifyAttachment,
  verifyAllAttachments,
} from '../../src/server/services/attachments.js';
import { resolveStoredPath } from '../../src/server/services/fileStore.js';
import { ConflictError, FileError, NotFoundError, ValidationError } from '../../src/shared/errors.js';
import { todayIso } from '../../src/server/domain/dates.js';

let env;
afterEach(() => env?.cleanup());

function setup() {
  env = createTestEnv();
  const ctx = { clinicId: env.clinicId, user: { id: env.admin.id, displayName: 'Admin' }, ip: '127.0.0.1' };
  return { env, ctx };
}

const patient = (e, ctx, name = 'Clinical Patient') =>
  createPatient(e.db, ctx, { full_name: name, gender: 'male', phone: `017${Math.floor(Math.random() * 90000000 + 10000000)}` });

describe('clinical visits', () => {
  test('records a visit with diagnoses and keeps the patient last-visit date in sync', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Visit Patient');
    const created = createVisit(e.db, ctx, {
      patient_id: p.id,
      visit_date: todayIso(),
      practitioner_id: e.practitionerId,
      chief_complaint: 'Pain in lower right molar',
      examination: 'Deep caries on 46',
      diagnosis: 'Irreversible pulpitis 46',
      procedures: 'Review',
      followup_date: todayIso(),
      diagnoses: [{ label: 'Pulpitis', tooth_codes: ['46'] }],
    });
    expect(created.visitCode).toMatch(/^VS-/);

    const detail = getVisit(e.db, ctx, created.id);
    expect(detail.patientId).toBe(p.id);
    expect(detail.diagnoses.length).toBe(1);
    expect(detail.diagnoses[0].label).toBe('Pulpitis');
    expect(detail.diagnoses[0].toothCodes).toEqual(['46']);

    const stored = e.db.query('SELECT last_visit_on FROM patients WHERE id = ?').get(p.id);
    expect(stored.last_visit_on).toBe(todayIso());

    const followups = followupsDue(e.db, ctx, { from: todayIso(), to: todayIso() });
    expect(followups.some((row) => row.id === created.id)).toBe(true);

    const history = patientClinicalHistory(e.db, ctx, p.id);
    expect(history.length).toBe(1);
    expect(history[0]?.visitCode).toBe(created.visitCode);
  });

  test('visit updates are audited and unsupported status values are rejected', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Visit Update');
    const created = createVisit(e.db, ctx, { patient_id: p.id, chief_complaint: 'Check-up' });
    updateVisit(e.db, ctx, created.id, { diagnosis: 'Healthy dentition', status: 'completed' });
    const detail = getVisit(e.db, ctx, created.id);
    expect(detail.diagnosis).toBe('Healthy dentition');
    expect(() => updateVisit(e.db, ctx, created.id, { status: 'bogus' })).toThrow(ValidationError);
    const audits = e.db.query("SELECT COUNT(*) AS c FROM audit_logs WHERE entity = 'visit' AND action = 'update'").get();
    expect(Number(audits.c)).toBeGreaterThanOrEqual(1);
  });

  test('deleting a visit is a soft delete that keeps the history row', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Visit Delete');
    const created = createVisit(e.db, ctx, { patient_id: p.id });
    deleteVisit(e.db, ctx, created.id, 'Duplicate entry');
    expect(() => getVisit(e.db, ctx, created.id)).toThrow(NotFoundError);
    const row = e.db.query('SELECT deleted_at FROM visits WHERE id = ?').get(created.id);
    expect(row.deleted_at).toBeTruthy();
    expect(listVisits(e.db, ctx, { patientId: p.id }).total).toBe(0);
  });
});

describe('dental chart', () => {
  test('records tooth conditions, refreshes duplicates and clears entries', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Chart Patient');
    const conditions = toothConditions(e.db);
    expect(conditions.length).toBe(27);

    const first = addChartEntry(e.db, ctx, { patient_id: p.id, tooth_code: '36', condition_code: 'caries', surfaces: ['O', 'M'] });
    expect(first.updated).toBe(false);

    // Same tooth + condition + surfaces is refreshed rather than duplicated.
    const second = addChartEntry(e.db, ctx, { patient_id: p.id, tooth_code: '36', condition_code: 'caries', surfaces: ['M', 'O'], notes: 'Confirmed' });
    expect(second.updated).toBe(true);
    expect(second.id).toBe(first.id);

    addChartEntry(e.db, ctx, { patient_id: p.id, tooth_code: '36', condition_code: 'filling_composite', surfaces: ['O'] });
    const chart = getChart(e.db, ctx, p.id);
    expect(chart.teeth['36'].conditions.length).toBe(2);
    expect(chart.teeth['11'].conditions.length).toBe(0);
    expect(chart.layout.upperRight.length).toBe(8);
    expect(chart.layout.lowerLeft.length).toBe(8);

    const summary = chartSummary(e.db, ctx, p.id);
    expect(summary.byCategory.finding).toBe(1);
    expect(summary.byCategory.restoration).toBe(1);
    expect(summary.teethAffected).toBe(1);
    expect(summary.charted).toBe(1);

    clearChartEntry(e.db, ctx, first.id, 'Recorded on wrong tooth');
    expect(getChart(e.db, ctx, p.id).teeth['36'].conditions.length).toBe(1);
    const history = chartHistory(e.db, ctx, p.id);
    expect(history.length).toBeGreaterThanOrEqual(1);
  });

  test('rejects invalid teeth, conditions and surfaces', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Chart Validation');
    expect(() => addChartEntry(e.db, ctx, { patient_id: p.id, tooth_code: '99', condition_code: 'caries' })).toThrow(ValidationError);
    expect(() => addChartEntry(e.db, ctx, { patient_id: p.id, tooth_code: '36', condition_code: 'not_a_condition' })).toThrow(ValidationError);
    expect(() => addChartEntry(e.db, ctx, { patient_id: p.id, tooth_code: '36', condition_code: 'caries', surfaces: ['Z'] })).toThrow(
      ValidationError,
    );
  });

  test('primary dentition uses its own tooth set', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Child Patient');
    addChartEntry(e.db, ctx, { patient_id: p.id, tooth_code: '55', dentition: 'primary', condition_code: 'caries', surfaces: ['O'] });
    const chart = getChart(e.db, ctx, p.id, 'primary');
    expect(chart.teeth['55'].conditions.length).toBe(1);
    // The adult chart does not contain primary findings.
    expect(getChart(e.db, ctx, p.id, 'adult').entries.length).toBe(0);
    expect(() => updateChartEntry(e.db, ctx, 999999, { notes: 'x' })).toThrow(NotFoundError);
  });
});

describe('treatments and services', () => {
  test('computes treatment money from the service price, discount and tax', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Treatment Patient');
    const service = createService(e.db, ctx, { name_en: 'Root Canal Treatment', name_bn: 'রুট ক্যানেল', default_price_minor: 500000, tax_rate_bp: 500 });
    const created = createTreatment(e.db, ctx, {
      patient_id: p.id,
      service_id: service.id,
      name: 'Root Canal Treatment',
      tooth_codes: ['46'],
      discount_minor: 50000,
      quantity_milli: 1000,
    });
    // 5000.00 − 500.00 = 4500.00 net, + 5% tax = 4725.00
    expect(created.totalMinor).toBe(472500);
    const row = e.db.query('SELECT fee_minor, discount_minor, tax_minor, total_minor FROM treatments WHERE id = ?').get(created.id);
    expect(row.fee_minor).toBe(500000);
    expect(row.tax_minor).toBe(22500);
  });

  test('money survives a non-money edit and is recalculated when the fee changes', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Treatment Money');
    const created = createTreatment(e.db, ctx, { patient_id: p.id, name: 'Filling', fee_minor: 200000, tax_rate_bp: 1000 });
    expect(e.db.query('SELECT total_minor FROM treatments WHERE id = ?').get(created.id).total_minor).toBe(220000);

    updateTreatment(e.db, ctx, created.id, { notes: 'Patient tolerated well' });
    expect(e.db.query('SELECT tax_minor, total_minor FROM treatments WHERE id = ?').get(created.id)).toEqual({ tax_minor: 20000, total_minor: 220000 });

    updateTreatment(e.db, ctx, created.id, { fee_minor: 300000 });
    expect(e.db.query('SELECT total_minor FROM treatments WHERE id = ?').get(created.id).total_minor).toBe(330000);
  });

  test('the recorded quantity and tax rate are stored, so edits cannot change the total', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Treatment Line');
    const created = createTreatment(e.db, ctx, {
      patient_id: p.id,
      name: 'Scaling and polishing',
      quantity_milli: 3000,
      fee_minor: 100000,
      tax_rate_bp: 500,
    });
    // 3 × 1000.00 = 3000.00, + 5% tax = 3150.00
    const stored = e.db.query('SELECT quantity_milli, tax_rate_bp, tax_minor, total_minor FROM treatments WHERE id = ?').get(created.id);
    expect(stored).toEqual({ quantity_milli: 3000, tax_rate_bp: 500, tax_minor: 15000, total_minor: 315000 });

    // An unrelated edit keeps the amount the patient owes.
    updateTreatment(e.db, ctx, created.id, { notes: 'Reviewed at recall' });
    const untouched = e.db.query('SELECT quantity_milli, tax_minor, total_minor FROM treatments WHERE id = ?').get(created.id);
    expect(untouched).toEqual({ quantity_milli: 3000, tax_minor: 15000, total_minor: 315000 });

    // Changing the quantity does recalculate, with the recorded rate.
    updateTreatment(e.db, ctx, created.id, { quantity_milli: 1000 });
    expect(e.db.query('SELECT quantity_milli, tax_minor, total_minor FROM treatments WHERE id = ?').get(created.id))
      .toEqual({ quantity_milli: 1000, tax_minor: 5000, total_minor: 105000 });
  });

  test('treatments feed the invoice builder, and billed ones cannot be deleted', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Unbilled Patient');
    const created = createTreatment(e.db, ctx, { patient_id: p.id, name: 'Extraction', fee_minor: 150000 });
    const unbilled = unbilledTreatments(e.db, ctx, p.id);
    expect(unbilled.length).toBe(1);
    expect(unbilled[0].totalMinor).toBe(150000);

    e.db.run('UPDATE treatments SET invoice_id = 1 WHERE id = ?', [created.id]);
    expect(() => deleteTreatment(e.db, ctx, created.id, 'mistake')).toThrow(ValidationError);
    e.db.run('UPDATE treatments SET invoice_id = NULL WHERE id = ?', [created.id]);
    e.db.run('UPDATE treatments SET deleted_at = ? WHERE id = ?', [new Date().toISOString(), created.id]);
    expect(unbilledTreatments(e.db, ctx, p.id).length).toBe(0);
  });

  test('treatments can record a chart finding in the same action', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Chart Sync');
    createTreatment(e.db, ctx, { patient_id: p.id, name: 'Composite Filling', tooth_codes: ['11', '12'], chart_condition_code: 'filling_composite' });
    const chart = getChart(e.db, ctx, p.id);
    expect(chart.teeth['11'].conditions[0].conditionCode).toBe('filling_composite');
    expect(chart.teeth['12'].conditions[0].conditionCode).toBe('filling_composite');
  });

  test('service catalogue ships starter entries with zero prices and can be archived', () => {
    const { env: e, ctx } = setup();
    expect(listServices(e.db, ctx).length).toBe(0);
    const starter = starterServiceCatalogue();
    expect(starter.length).toBe(17);
    expect(starter.every((service) => (service.default_price_minor ?? 0) === 0)).toBe(true);
    expect(starter.every((service) => service.name_bn && service.name_en)).toBe(true);

    const service = createService(e.db, ctx, { name_en: 'Denture Adjustment' });
    expect(listServices(e.db, ctx).length).toBe(1);
    archiveService(e.db, ctx, service.id);
    expect(listServices(e.db, ctx).length).toBe(0);
    expect(listServices(e.db, ctx, { includeInactive: true }).length).toBe(1);
    expect(listTreatments(e.db, ctx, { unbilled: true }).total).toBe(0);
  });
});

describe('treatment plans', () => {
  test('creates staged plans with totals and tracks completion', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Plan Patient');
    const plan = createPlan(e.db, ctx, {
      patient_id: p.id,
      title: 'Full mouth rehabilitation',
      status: 'accepted',
      items: [
        { name: 'Scaling', unit_price_minor: 100000, quantity_milli: 1000 },
        { name: 'Crown 36', unit_price_minor: 800000, quantity_milli: 1000, discount_minor: 50000 },
      ],
    });
    expect(plan.planCode).toMatch(/^TP-/);
    expect(plan.totalMinor).toBe(850000);
    expect(plan.itemCount).toBe(2);

    const detail = getPlan(e.db, ctx, plan.id);
    expect(detail.progress.total).toBe(2);
    expect(detail.progress.pending).toBe(2);

    // Every item stores the money the plan total was built from (a plan whose
    // rows say 0 while the header says 8500.00 cannot be invoiced or audited).
    const rows = e.db
      .query('SELECT name, quantity_milli, unit_price_minor, discount_minor, tax_minor, line_total_minor FROM treatment_plan_items WHERE plan_id = ? ORDER BY sort_order')
      .all(plan.id);
    expect(rows[0]).toEqual({ name: 'Scaling', quantity_milli: 1000, unit_price_minor: 100000, discount_minor: 0, tax_minor: 0, line_total_minor: 100000 });
    expect(rows[1]).toEqual({ name: 'Crown 36', quantity_milli: 1000, unit_price_minor: 800000, discount_minor: 50000, tax_minor: 0, line_total_minor: 750000 });
    expect(detail.items.reduce((sum, item) => sum + item.lineTotalMinor, 0)).toBe(plan.totalMinor);

    const treatments = planItemsForInvoice(e.db, ctx, plan.id);
    expect(treatments.length).toBe(2);
    expect(treatments[0].description).toContain('Scaling');
    expect(treatments[1].discountMinor).toBe(50000);
  });

  test('plan status follows item completion (partially completed → completed)', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Plan Progress');
    const plan = createPlan(e.db, ctx, {
      patient_id: p.id,
      title: 'Two stage plan',
      status: 'accepted',
      items: [
        { name: 'Stage one', unit_price_minor: 100000 },
        { name: 'Stage two', unit_price_minor: 200000 },
      ],
    });
    const items = getPlan(e.db, ctx, plan.id).items;
    createTreatment(e.db, ctx, { patient_id: p.id, plan_id: plan.id, plan_item_id: items[0].id, name: 'Stage one', fee_minor: 100000 });
    expect(getPlan(e.db, ctx, plan.id).status).toBe('partially_completed');

    createTreatment(e.db, ctx, { patient_id: p.id, plan_id: plan.id, plan_item_id: items[1].id, name: 'Stage two', fee_minor: 200000 });
    expect(getPlan(e.db, ctx, plan.id).status).toBe('completed');

    expect(refreshPlanStatus(e.db, null)).toBe(null);
  });

  test('draft plans keep their status and rejected items fall back', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Plan Draft');
    const plan = createPlan(e.db, ctx, { patient_id: p.id, title: 'Draft plan', items: [{ name: 'Consultation', unit_price_minor: 50000 }] });
    const item = getPlan(e.db, ctx, plan.id).items[0];
    updatePlanItem(e.db, ctx, item.id, { status: 'in_progress' });
    expect(getPlan(e.db, ctx, plan.id).status).toBe('draft');
    expect(getPlan(e.db, ctx, plan.id).progress.inProgress).toBe(1);
    updatePlan(e.db, ctx, plan.id, { title: 'Draft plan v2', status: 'accepted' });
    expect(getPlan(e.db, ctx, plan.id).title).toBe('Draft plan v2');
    deletePlan(e.db, ctx, plan.id, 'Patient declined');
    expect(getPlan(e.db, ctx, plan.id).status).toBe('cancelled');
  });
});

describe('prescriptions', () => {
  test('writes prescriptions with items and numbers them sequentially', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Rx Patient');
    const first = createPrescription(e.db, ctx, {
      patient_id: p.id,
      practitioner_id: e.practitionerId,
      diagnosis: 'Acute pulpitis',
      items: [
        { medication: 'Amoxicillin', strength: '500 mg', dose: '1 capsule', frequency: '1+0+1', duration: '5 days', instructions: 'After meals' },
        { medication: 'Ibuprofen', strength: '400 mg', frequency: '1+0+1', duration: '3 days' },
      ],
    });
    const second = createPrescription(e.db, ctx, { patient_id: p.id, items: [{ medication: 'Chlorhexidine mouthwash' }] });
    expect(first.rxCode).not.toBe(second.rxCode);
    expect(first.itemCount).toBe(2);

    const detail = getPrescription(e.db, ctx, first.id);
    expect(detail.items.length).toBe(2);
    expect(detail.items[0].medication).toBe('Amoxicillin');
    markPrinted(e.db, ctx, first.id);
    expect(getPrescription(e.db, ctx, first.id).printedCount).toBe(1);

    expect(listPrescriptions(e.db, ctx, { patientId: p.id }).total).toBe(2);
    expect(listPrescriptions(e.db, ctx, { search: 'Amoxicillin' }).total).toBe(1);
  });

  test('templates prefill a prescription and track usage', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Rx Template');
    const template = saveTemplate(e.db, ctx, null, {
      name: 'Post extraction',
      diagnosis: 'Post extraction care',
      items: [{ medication: 'Amoxicillin', strength: '500 mg', frequency: '1+0+1', duration: '5 days' }],
    });
    const created = createPrescription(e.db, ctx, { patient_id: p.id, template_id: template.id });
    expect(created.itemCount).toBe(1);
    const detail = getPrescription(e.db, ctx, created.id);
    expect(detail.items[0].medication).toBe('Amoxicillin');
    expect(Number(e.db.query('SELECT use_count FROM prescription_templates WHERE id = ?').get(template.id).use_count)).toBe(1);
  });
});

describe('referrals', () => {
  test('creates referrals, records the returned report and aggregates the directory', () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Referral Patient');
    const visit = createVisit(e.db, ctx, { patient_id: p.id, diagnosis: 'Impacted 38' });
    const referral = createReferral(e.db, ctx, {
      patient_id: p.id,
      visit_id: visit.id,
      provider_name: 'Dr. Oral Surgeon',
      specialty: 'Oral & Maxillofacial Surgery',
      institution: 'City Dental Hospital',
      provider_phone: '01812345678',
      reason: 'Surgical removal of impacted wisdom tooth',
      status: 'referred',
    });
    expect(referral.referralCode).toMatch(/^REF-/);

    const detail = getReferral(e.db, ctx, referral.id);
    expect(detail.status).toBe('referred');
    expect(detail.visitCode).toBe(visit.visitCode);

    const updated = recordReferralOutcome(e.db, ctx, referral.id, {
      outcome: 'Surgical extraction completed under local anaesthesia',
      external_treatment_summary: '38 removed, sutures placed',
      status: 'completed',
    });
    expect(updated.status).toBe('completed');
    expect(updated.completedAt).toBeTruthy();

    const directory = referralDirectory(e.db, ctx);
    expect(directory.providers.length).toBe(1);
    expect(directory.providers[0].name).toBe('Dr. Oral Surgeon');
    expect(directory.specialties[0].count).toBe(1);
    expect(listReferrals(e.db, ctx, { patientId: p.id }).total).toBe(1);
    deleteReferral(e.db, ctx, referral.id, 'Entered twice');
    expect(listReferrals(e.db, ctx, { patientId: p.id }).total).toBe(0);
  });

  test('rejects referral documents that belong to another patient', async () => {
    const { env: e, ctx } = setup();
    const a = patient(e, ctx, 'Referral A');
    const b = patient(e, ctx, 'Referral B');
    const visitB = createVisit(e.db, ctx, { patient_id: b.id });
    await expect(
      createAttachment(e.db, { ...ctx, dataDir: e.dir }, { patient_id: a.id, visit_id: visitB.id, category: 'report' }, pngFile()),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('attachments and file storage', () => {
  test('stores a file with its SHA-256 hash and verifies it later', async () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Attachment Patient');
    const bytes = pngBytes();
    const created = await createAttachment(e.db, { ...ctx, dataDir: e.dir }, { patient_id: p.id, category: 'radiograph', title: 'OPG' }, pngFile(bytes));
    const expected = createHash('sha256').update(bytes).digest('hex');
    expect(created.sha256).toBe(expected);
    expect(created.sizeBytes).toBe(bytes.length);
    expect(created.relPath).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]+\.png$/);

    const absolute = resolveStoredPath(e.dir, created.relPath);
    expect(existsSync(absolute)).toBe(true);
    expect(readFileSync(absolute).equals(bytes)).toBe(true);

    const verified = await verifyAttachment(e.db, { ...ctx, dataDir: e.dir }, created.id);
    expect(verified.ok).toBe(true);

    // A tampered file is reported, not silently accepted.
    e.db.query('UPDATE attachments SET sha256 = ? WHERE id = ?').run('0'.repeat(64), created.id);
    const tampered = await verifyAttachment(e.db, { ...ctx, dataDir: e.dir }, created.id);
    expect(tampered.ok).toBe(false);
    expect(tampered.reason).toBe('hash_mismatch');

    const usage = attachmentUsage(e.db, ctx);
    expect(usage.files).toBe(1);
    expect(usage.bytes).toBe(bytes.length);
  });

  test('refuses unknown file types, bad names and path traversal', async () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Attachment Rules');
    await expect(
      createAttachment(e.db, { ...ctx, dataDir: e.dir }, { patient_id: p.id, category: 'other' }, new File([pngBytes()], 'virus.exe', { type: 'application/x-msdownload' })),
    ).rejects.toThrow(FileError);
    await expect(
      createAttachment(e.db, { ...ctx, dataDir: e.dir }, { patient_id: p.id, category: 'other' }, new File([pngBytes()], 'noextension')),
    ).rejects.toThrow(FileError);
    expect(() => resolveStoredPath(e.dir, '../../etc/passwd')).toThrow(FileError);
    expect(() => resolveStoredPath(e.dir, '2026/01/../../../../etc/passwd')).toThrow(FileError);
  });

  test('soft delete hides the attachment, restore brings it back and permanent delete removes the file', async () => {
    const { env: e, ctx } = setup();
    const p = patient(e, ctx, 'Attachment Lifecycle');
    const created = await createAttachment(e.db, { ...ctx, dataDir: e.dir }, { patient_id: p.id, category: 'consent' }, pngFile());
    const absolute = resolveStoredPath(e.dir, created.relPath);

    deleteAttachment(e.db, { ...ctx, dataDir: e.dir }, created.id, { reason: 'Wrong document' });
    expect(listAttachments(e.db, ctx, { patientId: p.id }).total).toBe(0);
    expect(existsSync(absolute)).toBe(true);
    expect(() => getAttachment(e.db, ctx, created.id)).toThrow(NotFoundError);

    restoreAttachment(e.db, { ...ctx, dataDir: e.dir }, created.id);
    expect(listAttachments(e.db, ctx, { patientId: p.id }).total).toBe(1);

    deleteAttachment(e.db, { ...ctx, dataDir: e.dir }, created.id, { permanent: true, reason: 'Patient request' });
    expect(existsSync(absolute)).toBe(false);
    expect(Number(e.db.query('SELECT COUNT(*) AS c FROM attachments WHERE id = ?').get(created.id).c)).toBe(0);

    const sweep = await verifyAllAttachments(e.db, { ...ctx, dataDir: e.dir });
    expect(sweep.checked).toBe(0);
  });
});

function pngBytes() {
  return Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6300010000050001', 'hex');
}

function pngFile(bytes = pngBytes()) {
  return new File([bytes], 'xray.png', { type: 'image/png' });
}
