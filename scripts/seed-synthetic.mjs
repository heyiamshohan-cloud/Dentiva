/**
 * DENTIVA — synthetic development data.
 *
 * Generates a large, realistic *synthetic* dataset (patients with visits,
 * appointments, treatments, plans, prescriptions, invoices, payments, stock and
 * staff) so pagination, search, reports and printing can be tested at scale.
 *
 * The data is fake, clearly named (`Synthetic Patient 00042`), and lives in its
 * own data directory — never in the clinic's real one. Nothing here is included
 * in a release build: the packaging script refuses to run while a synthetic
 * directory exists next to the project.
 *
 *   bun run seed:synthetic                       2 000 patients in ./.synthetic-data
 *   bun run seed:synthetic --patients 20000
 *   bun run seed:synthetic --data C:\temp\dentiva-synth
 *   bun run seed:synthetic --delete              remove the synthetic data folder
 *
 * The generator is deterministic: the same `--seed` always produces the same
 * database, which makes performance regressions comparable.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openTarget } from './lib/db-target.mjs';
import { provisionClinic } from '../src/server/services/clinic.js';
import { createPatient } from '../src/server/services/patients.js';
import { createVisit } from '../src/server/services/visits.js';
import { createAppointment } from '../src/server/services/appointments.js';
import { createTreatment } from '../src/server/services/treatments.js';
import { createPlan } from '../src/server/services/treatmentPlans.js';
import { createPrescription } from '../src/server/services/prescriptions.js';
import { createInvoice, updateInvoice } from '../src/server/services/billing.js';
import { recordPayment } from '../src/server/services/payments.js';
import { createStaff } from '../src/server/services/staff.js';
import { createInventoryItem, recordStockMovement } from '../src/server/services/inventory.js';
import { addChartEntry } from '../src/server/services/dentalChart.js';
import { addDays, todayIso } from '../src/server/domain/dates.js';
import { formatAmount } from '../src/server/domain/money.js';

const args = process.argv.slice(2);
/**
 * Read `--name value` from the command line.
 * @param {string} name
 * @param {string|null} [fallback]
 * @returns {string|null}
 */
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const patients = Math.max(1, Number(flag('patients', '2000')));
const seedNumber = Number(flag('seed', '20260101'));
const dataDir = flag('data') ?? join(process.cwd(), '.synthetic-data');

if (args.includes('--delete')) {
  if (existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true });
    console.log(`Removed synthetic data at ${dataDir}`);
  } else {
    console.log(`Nothing to remove at ${dataDir}`);
  }
  process.exit(0);
}

/* ------------------------------------------------------------- deterministic */

/** Mulberry32 — small, fast, repeatable. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = rng(seedNumber);
const pick = (list) => list[Math.floor(random() * list.length)];
const chance = (probability) => random() < probability;
const int = (min, max) => min + Math.floor(random() * (max - min + 1));

const FIRST_MALE = ['Abdul', 'Karim', 'Rahim', 'Jamal', 'Sabbir', 'Nayeem', 'Tanvir', 'Farhan', 'Imran', 'Shakib'];
const FIRST_FEMALE = ['Ayesha', 'Nasrin', 'Rumana', 'Sharmin', 'Tanha', 'Mou', 'Sadia', 'Farzana', 'Nusrat', 'Rima'];
const LAST = ['Hossain', 'Rahman', 'Akter', 'Islam', 'Chowdhury', 'Sarker', 'Mia', 'Begum', 'Khatun', 'Ahmed'];
const CITIES = ['Tangail', 'Dhaka', 'Gazipur', 'Mymensingh', 'Narayanganj', 'Bogura', 'Cumilla', 'Rajshahi'];
const COMPLAINTS = ['Tooth pain', 'Bleeding gums', 'Sensitivity to cold', 'Broken filling', 'Swelling on the cheek', 'Routine check-up'];
const DIAGNOSES = ['Irreversible pulpitis', 'Chronic gingivitis', 'Dental caries', 'Pericoronitis', 'Failed restoration', 'Healthy dentition'];
const PROCEDURES = ['Composite filling', 'Root canal treatment', 'Scaling and polishing', 'Extraction', 'Zirconia crown', 'Pulpectomy'];
const MEDICINES = ['Amoxicillin 500mg', 'Ibuprofen 400mg', 'Metronidazole 400mg', 'Paracetamol 500mg', 'Chlorhexidine mouthwash'];
const TEETH = ['11', '12', '13', '14', '15', '16', '17', '18', '21', '22', '23', '24', '25', '26', '27', '28',
  '31', '32', '33', '34', '35', '36', '37', '38', '41', '42', '43', '44', '45', '46', '47', '48'];

const started = Date.now();
const { db, dbPath, close } = openTarget(dataDir);

try {
  console.log(`Synthetic data directory : ${dataDir}`);
  console.log(`Patients to generate     : ${patients}`);
  console.log(`Random seed              : ${seedNumber}`);

  /* ------------------------------------------------------------- the clinic */
  let clinicId = Number(db.query('SELECT id FROM clinics ORDER BY id LIMIT 1').get()?.id ?? 0);
  if (!clinicId) {
    const provisioned = provisionClinic(db, {
      clinic: {
        code: 'SYNTH',
        name: 'Synthetic Test Clinic',
        phone: '01700000000',
        email: 'test@example.invalid',
        address: 'Synthetic Road 1',
        city: 'Tangail',
        country: 'Bangladesh',
        currency_code: 'BDT',
        currency_symbol: '৳',
        locale: 'en',
      },
      dentist: { full_name: 'Dr. Synthetic Practitioner', designation: 'Consultant' },
      admin: { username: 'synthetic', display_name: 'Synthetic Admin', password: 'Synthetic#Test2026' },
    });
    clinicId = provisioned.clinicId;
    console.log('Created clinic           : Synthetic Test Clinic (this database is throwaway)');
  }
  const ctx = {
    clinicId,
    user: { id: Number(db.query('SELECT id FROM users ORDER BY id LIMIT 1').get().id), displayName: 'Synthetic Admin' },
    ip: '127.0.0.1',
    dataDir,
  };

  /* -------------------------------------------------------------------- staff */
  const staffIds = [];
  for (const [index, person] of [
    { full_name: 'Dr. Synthetic Practitioner', role_title: 'dentist', is_practitioner: 1, salary_minor: 4500000 },
    { full_name: 'Synth Assistant One', role_title: 'assistant', is_practitioner: 0, salary_minor: 1800000 },
    { full_name: 'Synth Receptionist', role_title: 'receptionist', is_practitioner: 0, salary_minor: 1600000 },
  ].entries()) {
    try {
      const created = createStaff(db, ctx, {
        full_name: person.full_name,
        role_title: person.role_title,
        is_practitioner: Boolean(person.is_practitioner),
        salary_type: 'monthly',
        salary_minor: person.salary_minor,
        phone: `0180000000${index}`,
        joining_date: '2024-01-15',
      });
      staffIds.push({ id: created.id, practitioner: Boolean(person.is_practitioner) });
    } catch {
      /* already seeded */
    }
  }
  const practitionerId = staffIds.find((row) => row.practitioner)?.id ?? null;

  /* ---------------------------------------------------------------- inventory */
  const inventoryIds = [];
  for (const [index, item] of [
    { name: 'Composite resin A2', unit: 'syringe', purchase: 85000, sale: 120000 },
    { name: 'Lidocaine 2% cartridge', unit: 'box', purchase: 145000, sale: 190000 },
    { name: 'Disposable gloves (M)', unit: 'box', purchase: 45000, sale: 60000 },
    { name: 'Impression material', unit: 'pack', purchase: 210000, sale: 280000 },
    { name: 'Suture 3-0', unit: 'pack', purchase: 32000, sale: 45000 },
  ].entries()) {
    try {
      const created = createInventoryItem(db, ctx, {
        name: item.name,
        unit: item.unit,
        min_stock_milli: 2000,
        purchase_price_minor: item.purchase,
        sale_price_minor: item.sale,
        expiry_date: `2027-0${(index % 9) + 1}-15`,
      });
      recordStockMovement(db, ctx, {
        item_id: created.id,
        kind: 'in',
        quantity_milli: int(2000, 40000),
        unit_cost_minor: item.purchase,
        reason: 'Opening balance',
      });
      inventoryIds.push(created.id);
    } catch {
      /* already seeded */
    }
  }
  if (inventoryIds.length) {
    try {
      recordStockMovement(db, ctx, { item_id: inventoryIds[0], kind: 'out', quantity_milli: 2000, reason: 'Treatment use' });
    } catch {
      /* ignore */
    }
  }

  /* ----------------------------------------------------------------- patients */
  const patientIds = [];
  const progressStep = Math.max(1, Math.floor(patients / 10));
  for (let index = 1; index <= patients; index += 1) {
    const gender = chance(0.5) ? 'male' : 'female';
    const first = gender === 'male' ? pick(FIRST_MALE) : pick(FIRST_FEMALE);
    const last = pick(LAST);
    const created = createPatient(db, ctx, {
      full_name: `Synthetic Patient ${String(index).padStart(5, '0')} ${first} ${last}`,
      gender,
      phone: `01${int(3, 9)}${String(int(0, 99999999)).padStart(8, '0')}`,
      dob: `${int(1955, 2018)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`,
      address: `Synthetic House ${index}`,
      city: pick(CITIES),
      blood_group: pick(['A+', 'B+', 'O+', 'AB+', 'A-', 'O-']),
    });
    patientIds.push(created.id);
    if (index % progressStep === 0) process.stdout.write(`  patients ${index}/${patients}\r`);
  }
  process.stdout.write(`  patients ${patients}/${patients}\n`);

  /* -------------------------------------------------- clinical + billing chain */
  let visits = 0;
  let appointments = 0;
  let treatments = 0;
  let plans = 0;
  let prescriptions = 0;
  let invoices = 0;
  let payments = 0;

  for (const [index, patientId] of patientIds.entries()) {
    try {
      const visit = createVisit(db, ctx, {
        patient_id: patientId,
        practitioner_id: practitionerId,
        chief_complaint: pick(COMPLAINTS),
        diagnosis: pick(DIAGNOSES),
        status: 'completed',
      });
      visits += 1;

      addChartEntry(db, ctx, {
        patient_id: patientId,
        tooth_code: pick(TEETH),
        condition_code: pick(['caries', 'filling_composite', 'missing', 'crown', 'rct', 'calculus', 'gingivitis']),
        note: 'Synthetic finding',
      });

      if (chance(0.6)) {
        // Slots are spread across the day by patient index so a run does not
        // trip the double-booking guard for the single synthetic practitioner.
        const slot = index % 40;
        const day = addDays(todayIso(), -(index % 90));
        try {
          createAppointment(db, ctx, {
            patient_id: patientId,
            practitioner_id: practitionerId,
            appt_date: day,
            start_time: `${String(9 + Math.floor(slot / 4)).padStart(2, '0')}:${String((slot % 4) * 15).padStart(2, '0')}`,
            duration_minutes: 15,
            reason: pick(COMPLAINTS),
          });
          appointments += 1;
        } catch {
          /* the slot is taken — the chain continues */
        }
      }

      const procedureName = pick(PROCEDURES);
      const treatment = createTreatment(db, ctx, {
        patient_id: patientId,
        visit_id: visit.id,
        practitioner_id: practitionerId,
        name: procedureName,
        tooth_codes: [pick(TEETH)],
        quantity_milli: 1000,
        fee_minor: int(5, 60) * 10000,
        status: 'completed',
        treatment_date: todayIso(),
      });
      treatments += 1;

      if (chance(0.2)) {
        createPlan(db, ctx, {
          patient_id: patientId,
          title: 'Synthetic staged plan',
          status: 'proposed',
          items: [
            { name: pick(PROCEDURES), tooth_codes: [pick(TEETH)], quantity_milli: 1000, unit_price_minor: int(10, 40) * 10000 },
            { name: pick(PROCEDURES), tooth_codes: [pick(TEETH)], quantity_milli: 1000, unit_price_minor: int(10, 40) * 10000 },
          ],
        });
        plans += 1;
      }

      if (chance(0.35)) {
        createPrescription(db, ctx, {
          patient_id: patientId,
          diagnosis: pick(DIAGNOSES),
          items: [
            { medication: pick(MEDICINES), dose: '1 tablet', frequency: '3 times daily', duration: `${int(3, 7)} days` },
            ...(chance(0.5) ? [{ medication: pick(MEDICINES), dose: '1 tablet', frequency: '2 times daily', duration: '5 days' }] : []),
          ],
        });
        prescriptions += 1;
      }

      if (chance(0.8)) {
        const invoice = createInvoice(db, ctx, {
          patient_id: patientId,
          items: [
            { description: procedureName, quantity_milli: 1000, unit_price_minor: treatment.totalMinor || 50000 },
          ],
        });
        updateInvoice(db, ctx, invoice.id, { status: 'issued' });
        invoices += 1;
        const total = Number(db.query('SELECT total_minor FROM invoices WHERE id = ?').get(invoice.id)?.total_minor ?? 0);
        const paying = chance(0.75);
        if (paying) {
          recordPayment(db, ctx, {
            patient_id: patientId,
            invoice_id: invoice.id,
            kind: 'payment',
            method_code: pick(['cash', 'card', 'mfs', 'bank']),
            amount_minor: chance(0.6) ? total : Math.max(10000, Math.floor(total / 2)),
            reference: chance(0.4) ? `SYN-${int(100000, 999999)}` : null,
          });
          payments += 1;
        }
      }
    } catch (error) {
      // A single odd row must not stop a 20 000 patient run.
      if (index < 3) {
        const detail = /** @type {any} */ (error)?.details;
        console.warn(`  row ${index} skipped: ${error instanceof Error ? error.message : error}${detail ? ` :: ${JSON.stringify(detail)}` : ''}`);
      }
    }
  }

  /* ------------------------------------------------------------------ summary */
  const totals = {
    patients: Number(db.query('SELECT COUNT(*) AS c FROM patients').get().c),
    visits: Number(db.query('SELECT COUNT(*) AS c FROM visits').get().c),
    appointments: Number(db.query('SELECT COUNT(*) AS c FROM appointments').get().c),
    treatments: Number(db.query('SELECT COUNT(*) AS c FROM treatments').get().c),
    plans: Number(db.query('SELECT COUNT(*) AS c FROM treatment_plans').get().c),
    prescriptions: Number(db.query('SELECT COUNT(*) AS c FROM prescriptions').get().c),
    invoices: Number(db.query('SELECT COUNT(*) AS c FROM invoices').get().c),
    payments: Number(db.query('SELECT COUNT(*) AS c FROM payments').get().c),
    chartEntries: Number(db.query('SELECT COUNT(*) AS c FROM dental_chart_entries').get().c),
    inventory: Number(db.query('SELECT COUNT(*) AS c FROM inventory_items').get().c),
    invoiceValueMinor: Number(db.query('SELECT COALESCE(SUM(total_minor), 0) AS c FROM invoices').get().c),
  };

  console.log('Created in this run      :', JSON.stringify({ visits, appointments, treatments, plans, prescriptions, invoices, payments }));
  console.log('Database totals          :', JSON.stringify(totals, null, 1).replace(/\n/g, '\n  '));
  console.log(`Invoiced value           : ${formatAmount(totals.invoiceValueMinor, { symbol: '৳' })}`);
  console.log(`Database file            : ${dbPath}`);
  console.log(`Elapsed                  : ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log('');
  console.log('This database contains FAKE data and must never be shipped:');
  console.log(`  bun run seed:synthetic --delete --data "${dataDir}"`);
} finally {
  close();
}
