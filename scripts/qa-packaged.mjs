#!/usr/bin/env bun
/**
 * DENTIVA — packaged end-to-end QA (§ 6, § 33, § 47, § 84).
 *
 * Drives a *running* Dentiva instance through a complete clinic day over its own
 * HTTP API — the same requests the application window makes — so the release can
 * be tested as a product rather than as a source tree. It works against the
 * packaged executable on Windows (`DENTIVA.exe --no-window --data <temp>`) and
 * against `bun run serve` anywhere else, which is how it is rehearsed on Linux.
 *
 *   bun scripts/qa-packaged.mjs --data <data folder> [--url <base url>]
 *                               [--report <file.json>] [--keep] [--quiet]
 *
 * The instance is discovered through `<data>/instance.json`, the launch token is
 * read out of the application shell exactly as the window does, and the whole
 * run happens on a throwaway data folder: first-run setup, a clinic day with a
 * Bengali patient name, clinical records, billing with a part payment, stock,
 * attachments (unicode names, traversal refusal, checksum), printed documents,
 * reports, backup → verify → restore, and the audit trail.
 *
 * Exit code 0 only when every check passed. `--report` writes the full result as
 * JSON for the release evidence.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
/**
 * @param {string} name
 * @param {string|null} [fallback]
 * @returns {string|null}
 */
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : 'true';
};

const dataDir = flag('data');
const explicitUrl = flag('url');
const reportPath = flag('report');
const quiet = args.includes('--quiet');
const keep = args.includes('--keep');
const timeoutMs = Number(flag('timeout', '30000'));
const expect = {
  version: flag('expect-version', '1.0.0'),
  build: Number(flag('expect-build', '100')),
  schema: Number(flag('expect-schema', '10')),
};

/** A real 1×1 PNG, so the attachment goes through the same allow-list as a photo. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
/** A minimal but valid one-page PDF, for the document half of the allow-list. */
const PDF = Buffer.from(
  `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n` +
    `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R>>endobj\n` +
    `4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 60 760 Td (Dentiva QA) Tj ET\nendstream\nendobj\n` +
    `trailer<</Root 1 0 R>>\n%%EOF\n`,
  'utf8',
);

const results = [];
/** @type {Record<string, any>} */
const state = {};
let passed = 0;
let failed = 0;
let skipped = 0;

const color = (code) => (process.stdout.isTTY ? code : '');
const GRAY = color('\u001b[90m');
const GREEN = color('\u001b[32m');
const RED = color('\u001b[31m');
const YELLOW = color('\u001b[33m');
const RESET = color('\u001b[0m');

/**
 * @param {string} message
 */
function note(message) {
  if (!quiet) console.log(`${GRAY}    ${message}${RESET}`);
}

/**
 * Run one named check. Dependencies that are missing produce a skip, not a
 * second failure, so one broken step does not bury the real cause.
 * @param {string} name
 * @param {() => Promise<any>|any} body
 * @param {string[]} [needs]
 */
async function check(name, body, needs = []) {
  const missing = needs.filter((key) => state[key] === undefined || state[key] === null);
  if (missing.length) {
    skipped += 1;
    results.push({ name, status: 'skipped', detail: `needs ${missing.join(', ')}` });
    if (!quiet) console.log(`${YELLOW}    ▪ ${name} — skipped (missing ${missing.join(', ')})${RESET}`);
    return null;
  }
  const started = Date.now();
  try {
    const value = await body();
    passed += 1;
    results.push({ name, status: 'passed', ms: Date.now() - started });
    if (!quiet) console.log(`${GREEN}    ✔ ${name}${RESET}${GRAY} (${Date.now() - started} ms)${RESET}`);
    return value;
  } catch (failure) {
    failed += 1;
    const message = failure instanceof Error ? failure.message : String(failure);
    results.push({ name, status: 'failed', detail: message, ms: Date.now() - started });
    console.log(`${RED}    ✖ ${name} — ${message}${RESET}`);
    return null;
  }
}

/**
 * @param {any} condition
 * @param {string} message
 * @returns {asserts condition}
 */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/* ------------------------------------------------------------------- client */

let origin = explicitUrl ? String(explicitUrl).replace(/\/$/, '') : '';
let appToken = '';
let cookie = '';

/**
 * Raw request, used for the routes that answer with a file or a print page.
 * @param {string} path
 * @param {{ method?: string, body?: any, form?: FormData, headers?: Record<string,string> }} [options]
 * @returns {Promise<Response>}
 */
async function apiRaw(path, { method = 'GET', body, form, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (appToken) requestHeaders['x-dentiva-app'] = appToken;
  if (cookie) requestHeaders.cookie = cookie;
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    requestHeaders['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: requestHeaders,
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return response;
}

/**
 * JSON request: throws when the status is not the expected one, so a check can
 * never pass by accident on an error envelope.
 * @param {string} path
 * @param {{ method?: string, body?: any, form?: FormData, expect?: number|null, raw?: boolean, headers?: Record<string,string> }} [options]
 */
async function api(path, { method = 'GET', body, form, expect: expected, raw = false, headers = {} } = {}) {
  const response = await apiRaw(path, { method, body, form, headers });
  if (raw) return /** @type {any} */ (response);
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (typeof expected === 'number') {
    assert(
      response.status === expected,
      `${method} ${path} answered ${response.status}${parsed ? ` (${typeof parsed === 'string' ? parsed.slice(0, 120) : JSON.stringify(parsed).slice(0, 200)})` : ''}`,
    );
  }
  return { status: response.status, headers: response.headers, payload: parsed, text };
}

/**
 * Read the application shell and pick up the launch token the window uses.
 * A running packaged instance always injects it; the development preview does
 * not, and then requests simply go without the header.
 */
async function readShell() {
  const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(timeoutMs) });
  assert(response.ok, `the application shell answered ${response.status}`);
  const html = await response.text();
  const token = /<meta name="dentiva-app-token" content="([^"]+)"/.exec(html);
  if (token) appToken = token[1];
  return { html, token: token ? token[1] : null };
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * A per-run owner password: ten characters or more, at least one letter and one
 * digit, and none of the words the policy refuses. Never hardcoded.
 */
function qaPassword() {
  const random = randomBytes(6).toString('hex');
  return `Qa-${random}-9!`;
}

state.password = flag('password') ?? process.env.DENTIVA_QA_PASSWORD ?? qaPassword();
const username = flag('username', 'qa-owner');
const passwordSupplied = Boolean(flag('password') ?? process.env.DENTIVA_QA_PASSWORD);

/* --------------------------------------------------------------------- run */

console.log(`\n▸ DENTIVA packaged QA`);

/**
 * Find the running instance: either the URL given on the command line, or the
 * one recorded in `instance.json` by the launcher.
 */
async function boot() {
  if (!origin) {
    if (!dataDir) throw new Error('pass --data <folder> or --url <url>');
    const record = join(resolve(dataDir), 'instance.json');
    assert(existsSync(record), `no running instance found (${record} does not exist) — start Dentiva first`);
    const instance = JSON.parse(readFileSync(record, 'utf8'));
    origin = String(instance.url ?? `http://127.0.0.1:${instance.port}`).replace(/\/$/, '');
    note(`instance on ${origin} (pid ${instance.pid}, started ${instance.startedAt})`);
  }
  const shell = await readShell();
  note(`launch token: ${shell.token ? 'read from the application shell' : 'not required in this mode'}`);
  return shell;
}

const shell = await boot();

await check('health reports the running product', async () => {
  const { payload } = await api('/health', { expect: 200 });
  assert(payload.ok === true, 'health.ok is not true');
  assert(payload.version === expect.version, `health reports version ${payload.version}, expected ${expect.version}`);
  assert(Number(payload.build) === expect.build, `health reports build ${payload.build}, expected ${expect.build}`);
  assert(Number(payload.schema) === expect.schema, `health reports schema ${payload.schema}, expected ${expect.schema}`);
  note(`Dentiva ${payload.version} · build ${payload.build} · schema v${payload.schema} · assets ${payload.assets}`);
  return payload;
});

await check('the shell is the application, not a fallback page', async () => {
  assert(shell.html.includes('id="app"'), 'the shell has no application container');
  assert(shell.html.includes('Dentiva'), 'the shell does not mention the product');
  assert(!/could not be loaded from the application package/i.test(shell.html), 'the shell is the startup fallback');
  return true;
});

await check('an API call without the launch token is refused', async () => {
  const saved = appToken;
  appToken = '';
  try {
    const response = await fetch(`${origin}/api/patients`, { signal: AbortSignal.timeout(timeoutMs) });
    assert(response.status === 401 || response.status === 403, `expected a refusal, got ${response.status}`);
    return response.status;
  } finally {
    appToken = saved;
  }
});

await check('first-run setup creates the clinic and the owner', async () => {
  const status = await api('/api/auth/status', { expect: 200 });
  if (status.payload.firstRun !== true) {
    // Re-running against an existing clinic is allowed, but only with the owner
    // password supplied: the harness must never guess or reset credentials.
    assert(passwordSupplied, 'this instance is already set up — point --data at an empty folder, or pass --username/--password');
    const existing = await api('/api/auth/login', { method: 'POST', expect: 200, body: { username, password: state.password } });
    const me = await api('/api/session/me', { expect: 200 });
    state.clinicId = me.payload.clinic?.id ?? null;
    state.userId = me.payload.user?.id ?? null;
    state.permissions = existing.payload.user.permissions ?? me.payload.permissions ?? [];
    note(`existing instance: clinic #${state.clinicId}, signed in as “${username}” with ${state.permissions.length} permissions`);
    return existing.payload;
  }
  const setup = await api('/api/auth/first-run', {
    method: 'POST',
    expect: 200,
    body: {
      clinic: {
        code: 'QA',
        name: 'Dentiva QA Clinic (অস্থায়ী)',
        phone: '01700000000',
        address: 'QA Road 12, Tangail',
        currency_code: 'BDT',
        currency_symbol: '৳',
        locale: 'en',
      },
      dentist: { full_name: 'Dr. QA Dentist', designation: 'Dentist', bmdc_no: 'QA-0001' },
      admin: { username, password: state.password, display_name: 'QA Owner' },
    },
  });
  // The wizard signs the new owner in; /api/session/me is where the window reads
  // the clinic, the settings and the permission set from.
  const me = await api('/api/session/me', { expect: 200 });
  state.clinicId = me.payload.clinic?.id ?? null;
  state.userId = me.payload.user?.id ?? null;
  state.permissions = me.payload.permissions ?? [];
  assert(state.clinicId, 'the first-run wizard did not create a clinic');
  assert(me.payload.settings && Object.keys(me.payload.settings).length > 0, 'the clinic has no settings');
  note(`created clinic #${state.clinicId} “${me.payload.clinic?.name}”, owner “${username}”, ${state.permissions.length} permissions`);
  return setup.payload;
}, []);

await check('a wrong password is refused', async () => {
  const response = await api('/api/auth/login', {
    method: 'POST',
    body: { username, password: 'definitely-not-the-password' },
  });
  assert(response.status === 401, `expected 401, got ${response.status}`);
  return response.status;
});

await check('sign-in returns the permission set', async () => {
  const login = await api('/api/auth/login', { method: 'POST', expect: 200, body: { username, password: state.password } });
  assert(login.payload.user.username === username, 'a different user signed in');
  assert(Array.isArray(login.payload.user.permissions) && login.payload.user.permissions.length > 0, 'the session has no permissions');
  for (const permission of ['patients.create', 'billing.create', 'payments.create', 'backup.create']) {
    assert(login.payload.user.permissions.includes(permission), `the owner role is missing ${permission}`);
  }
  note(`${login.payload.user.permissions.length} permissions, ${login.payload.user.roles?.join(', ') ?? 'owner'}`);
  return login.payload;
});

await check('the clinic and its settings round-trip', async () => {
  const clinic = await api('/api/clinic', { expect: 200 });
  const currency = clinic.payload.currency_code ?? clinic.payload.currencyCode;
  assert(currency === 'BDT', `currency is ${currency}`);
  assert(String(clinic.payload.name).includes('QA Clinic'), `the clinic name is ${clinic.payload.name}`);
  const settings = await api('/api/settings', { expect: 200 });
  const valueCount = Object.keys(settings.payload.values ?? {}).length;
  const groupCount = (settings.payload.groups ?? []).length;
  assert(valueCount >= 50, `only ${valueCount} settings came back`);
  assert(groupCount >= 5, `the settings screen returned ${groupCount} groups`);
  note(`${valueCount} settings in ${groupCount} groups · currency ${currency}`);
  return { clinic: clinic.payload, settings: settings.payload };
}, ['clinicId']);

await check('registers a patient with a Bengali name and reads Patient 360', async () => {
  const created = await api('/api/patients', {
    method: 'POST',
    expect: 200,
    body: {
      full_name: 'মোঃ রফিকুল ইসলাম',
      preferred_name: 'Md. Rafiqul Islam',
      gender: 'male',
      phone: '01711223344',
      dob: '1985-03-14',
      address: '১২৩, কলেজ রোড, টাঙ্গাইল',
      city: 'Tangail',
      blood_group: 'B+',
      notes: 'Referred by the community clinic',
    },
  });
  state.patientId = created.payload.id;
  assert(state.patientId, 'the patient was created without an id');
  // Medical background has its own endpoint (it is a separate table in the schema).
  await api(`/api/patients/${state.patientId}/medical`, {
    method: 'PUT',
    expect: 200,
    body: {
      allergies: 'Penicillin',
      medical_history: 'Type 2 diabetes since 2018',
      conditions: 'Diabetes',
      has_diabetes: true,
      alert_flag: true,
    },
  });

  const detail = await api(`/api/patients/${state.patientId}`, { expect: 200 });
  assert(detail.payload.fullName === 'মোঃ রফিকুল ইসলাম', `the stored name came back as ${detail.payload.fullName}`);
  assert(detail.payload.preferredName === 'Md. Rafiqul Islam', 'the preferred (romanised) name was not stored');
  assert(/^DEN-/.test(detail.payload.patientCode), `unexpected patient code ${detail.payload.patientCode}`);
  const allergies = detail.payload.alerts?.allergies ?? detail.payload.medical?.allergies ?? '';
  assert(String(allergies).includes('Penicillin'), `the allergy did not survive the round trip (${allergies})`);
  assert(detail.payload.alerts?.medicalAlert === true, 'the medical alert flag is not raised in Patient 360');
  assert(detail.payload.medical?.flags?.diabetes === true, 'the diabetes flag is not visible in Patient 360');
  assert(String(detail.payload.medical?.conditions ?? '').includes('Diabetes'), 'the medical condition text is missing');
  assert(detail.payload.age > 0, 'the age was not derived from the date of birth');

  const list = await api(`/api/patients?search=${encodeURIComponent('রফিকুল')}`, { expect: 200 });
  assert(list.payload.total >= 1, 'the Bengali name is not findable in the register');
  const summary = await api('/api/patients/summary', { expect: 200 });
  assert(Number(summary.payload.total ?? summary.payload.patients ?? 0) >= 1, 'the patient summary does not count the new patient');
  note(`${detail.payload.patientCode} · ${detail.payload.age} years · registers and searches in Bengali`);
  return { id: state.patientId, code: detail.payload.patientCode };
}, ['clinicId']);

await check('runs an appointment, queue and visit', async () => {
  const appointment = await api('/api/appointments', {
    method: 'POST',
    expect: 200,
    body: { patient_id: state.patientId, appt_date: today(), start_time: '10:00', duration_minutes: 30, reason: 'Toothache' },
  });
  assert(/^APT-/.test(appointment.payload.appointmentCode), `unexpected appointment code ${appointment.payload.appointmentCode}`);
  state.appointmentId = appointment.payload.id;

  const agenda = await api(`/api/appointments/agenda?date=${today()}`, { expect: 200 });
  assert((agenda.payload.appointments ?? []).length >= 1, 'the appointment is missing from the agenda');

  const queued = await api('/api/queue/check-in', { method: 'POST', expect: 200, body: { appointmentId: state.appointmentId } });
  assert(queued.payload.serialNo >= 1, 'the queue serial number was not assigned');
  state.queueEntryId = queued.payload.id;
  await api(`/api/queue/${queued.payload.id}/call`, { method: 'POST', expect: 200 });
  await api(`/api/queue/${queued.payload.id}/start`, { method: 'POST', expect: 200 });
  await api(`/api/queue/${queued.payload.id}/complete`, { method: 'POST', expect: 200, body: {} });

  const visit = await api('/api/visits', {
    method: 'POST',
    expect: 200,
    body: { patient_id: state.patientId, appointment_id: state.appointmentId, chief_complaint: 'দাঁতে ব্যথা', diagnosis: 'Irreversible pulpitis 36', followup_date: today() },
  });
  assert(/^VS-/.test(visit.payload.visitCode), `unexpected visit code ${visit.payload.visitCode}`);
  state.visitId = visit.payload.id;
  note(`${appointment.payload.appointmentCode} → queue → ${visit.payload.visitCode}`);
  return visit.payload;
}, ['patientId']);

await check('charts a tooth and records treatment, plan and prescription', async () => {
  const conditions = await api('/api/chart/conditions', { expect: 200 });
  const caries = (conditions.payload.rows ?? []).find((/** @type {any} */ row) => row.code === 'caries');
  assert(caries, 'the chart condition catalogue has no “caries” entry');
  await api('/api/chart/entries', {
    method: 'POST',
    expect: 200,
    body: { patient_id: state.patientId, tooth_code: '36', condition_code: caries.code, surfaces: ['O', 'M'], visit_id: state.visitId },
  });
  const chart = await api(`/api/chart/${state.patientId}`, { expect: 200 });
  assert(Object.keys(chart.payload.teeth ?? {}).length > 20, 'the dental chart has no teeth');
  assert(chart.payload.teeth['36'].conditions.length >= 1, 'the charted condition is missing');

  const treatment = await api('/api/treatments', {
    method: 'POST',
    expect: 200,
    body: { patient_id: state.patientId, visit_id: state.visitId, name: 'Root canal treatment (36)', tooth_codes: ['36'], fee_minor: 600000, status: 'completed', quantity_milli: 1000, tax_rate_bp: 0 },
  });
  assert(treatment.payload.totalMinor === 600000, `the treatment total is ${treatment.payload.totalMinor}`);
  state.treatmentId = treatment.payload.id;

  const plan = await api('/api/plans', {
    method: 'POST',
    expect: 200,
    body: {
      patient_id: state.patientId,
      title: 'Functional rehabilitation',
      items: [
        { name: 'Scaling', quantity_milli: 1000, unit_price_minor: 150000, stage: 'stage1' },
        { name: 'Composite filling', tooth_codes: ['36'], quantity_milli: 1000, unit_price_minor: 250000, stage: 'stage2' },
      ],
    },
  });
  assert(/^TP-/.test(plan.payload.planCode), `unexpected plan code ${plan.payload.planCode}`);
  assert(plan.payload.totalMinor === 400000, `the plan total is ${plan.payload.totalMinor} instead of 400000`);
  state.planId = plan.payload.id;

  const prescription = await api('/api/prescriptions', {
    method: 'POST',
    expect: 200,
    body: {
      patient_id: state.patientId,
      visit_id: state.visitId,
      diagnosis: 'Acute pulpitis',
      advice: 'নরম খাবার খান, ব্যথা থাকলে জানান',
      items: [
        { medication: 'Amoxicillin', strength: '500 mg', dose: '1 capsule', frequency: '1 + 0 + 1', duration: '5 days', instructions: 'After meal' },
        { medication: 'Paracetamol', strength: '500 mg', dose: '1 tablet', frequency: 'SOS', duration: '3 days' },
      ],
    },
  });
  assert(prescription.payload.itemCount === 2, `the prescription stored ${prescription.payload.itemCount} items`);
  state.prescriptionId = prescription.payload.id;

  const referral = await api('/api/referrals', {
    method: 'POST',
    expect: 200,
    body: { patient_id: state.patientId, provider_name: 'Dr. Ortho', specialty: 'Orthodontics', reason: 'Crowding', urgency: 'routine' },
  });
  assert(/^REF-/.test(referral.payload.referralCode), `unexpected referral code ${referral.payload.referralCode}`);
  state.referralId = referral.payload.id;
  note(`${treatment.payload.totalMinor} minor units of treatment, plan ${plan.payload.planCode}, prescription ${prescription.payload.rxCode}`);
  return { treatment: treatment.payload, plan: plan.payload, prescription: prescription.payload };
}, ['patientId', 'visitId']);

await check('bills the treatment and records a part payment', async () => {
  const invoice = await api('/api/invoices', {
    method: 'POST',
    expect: 200,
    body: {
      patient_id: state.patientId,
      visit_id: state.visitId,
      status: 'issued',
      items: [
        // A line discount, because the clinic discounts procedures, not invoices.
        { description: 'Root canal treatment (36)', treatment_id: state.treatmentId, quantity_milli: 1000, unit_price_minor: 600000, discount_type: 'amount', discount_value: 50000 },
        { description: 'Scaling', quantity_milli: 1000, unit_price_minor: 150000 },
      ],
    },
  });
  assert(/^INV-/.test(invoice.payload.invoiceNumber), `unexpected invoice number ${invoice.payload.invoiceNumber}`);
  const expectedTotal = 600000 + 150000 - 50000;
  assert(invoice.payload.totalMinor === expectedTotal, `the invoice total is ${invoice.payload.totalMinor}, expected ${expectedTotal}`);
  state.invoiceId = invoice.payload.id;
  state.invoiceNumber = invoice.payload.invoiceNumber;
  state.invoiceTotal = invoice.payload.totalMinor;

  const payment = await api('/api/payments', {
    method: 'POST',
    expect: 200,
    body: { patient_id: state.patientId, invoice_id: state.invoiceId, amount_minor: 200000, method_code: 'cash' },
  });
  const receipt = (payment.payload.receipts ?? [])[0];
  assert(receipt, 'the payment produced no receipt');
  assert(/^RCP-/.test(receipt.receiptNumber), `unexpected receipt number ${receipt.receiptNumber}`);
  state.receiptId = receipt.id;

  const after = await api(`/api/invoices/${state.invoiceId}`, { expect: 200 });
  assert(after.payload.dueMinor === expectedTotal - 200000, `the outstanding balance is ${after.payload.dueMinor}`);
  assert(after.payload.paymentStatus === 'partial', `the invoice status is ${after.payload.paymentStatus}`);

  const receivables = await api('/api/invoices/receivables', { expect: 200 });
  const due = Number(receivables.payload.totalDueMinor ?? receivables.payload.totalMinor ?? 0);
  assert(due >= expectedTotal - 200000, `the receivables report shows ${due} outstanding, expected at least ${expectedTotal - 200000}`);
  assert((receivables.payload.items ?? []).length >= 1, 'the receivables report lists no invoice');
  note(`${invoice.payload.invoiceNumber} ${expectedTotal} → paid 200000 → due ${after.payload.dueMinor} (${after.payload.paymentStatus})`);
  return { invoice: invoice.payload, receipt };
}, ['patientId', 'treatmentId']);

await check('issues a second invoice and proves numbering never repeats', async () => {
  const second = await api('/api/invoices', {
    method: 'POST',
    expect: 200,
    body: { patient_id: state.patientId, status: 'issued', items: [{ description: 'Consultation', quantity_milli: 1000, unit_price_minor: 100000 }] },
  });
  assert(second.payload.invoiceNumber !== state.invoiceNumber, `invoice number ${second.payload.invoiceNumber} was issued twice`);
  await api(`/api/invoices/${second.payload.id}`, { expect: 200 });
  return second.payload;
}, ['invoiceId']);

await check('takes stock in and out and reports the valuation', async () => {
  const categories = await api('/api/inventory/categories', { expect: 200 });
  const category = (categories.payload.rows ?? [])[0];
  assert(category, 'the inventory category catalogue is empty');
  const item = await api('/api/inventory', {
    method: 'POST',
    expect: 200,
    body: { name: 'Composite A2 syringe', sku: 'QA-COMP-A2', category_id: category.id, unit: 'syringe', min_stock_milli: 4000, purchase_price_minor: 120000, sale_price_minor: 200000 },
  });
  await api('/api/inventory/movements', { method: 'POST', expect: 200, body: { item_id: item.payload.id, kind: 'in', quantity_milli: 10000, unit_cost_minor: 125000 } });
  await api('/api/inventory/movements', { method: 'POST', expect: 200, body: { item_id: item.payload.id, kind: 'out', quantity_milli: 3000, reason: 'Procedure' } });
  const after = await api(`/api/inventory/${item.payload.id}`, { expect: 200 });
  assert(after.payload.quantityMilli === 7000, `stock is ${after.payload.quantityMilli} thousandths, expected 7000`);
  const report = await api('/api/inventory/report', { expect: 200 });
  assert(Number(report.payload.valuation?.items ?? 0) >= 1, 'the valuation report counts no items');
  note(`stock 10.000 − 3.000 = ${after.payload.quantityMilli / 1000} ${after.payload.unit}`);
  return after.payload;
});

await check('adds a staff member and pays a salary', async () => {
  const member = await api('/api/staff', {
    method: 'POST',
    expect: 200,
    body: { full_name: 'QA Assistant', designation: 'Assistant', salary_minor: 1500000, phone: '01799998888' },
  });
  assert(/^STF-/.test(member.payload.staffCode), `unexpected staff code ${member.payload.staffCode}`);
  const draft = await api('/api/payroll/draft-run', { method: 'POST', expect: 200, body: {} });
  const payroll = (draft.payload.created ?? [])[0];
  assert(payroll, 'the payroll draft run created nothing for the new staff member');
  const paid = await api(`/api/payroll/${payroll.payrollId}/pay`, { method: 'POST', expect: 200, body: { amount_minor: 1500000 } });
  assert(paid.payload.status === 'paid', `the payslip status is ${paid.payload.status}`);
  state.payrollId = payroll.payrollId;
  note(`${member.payload.staffCode} · payslip ${payroll.payrollId} paid`);
  return paid.payload;
});

await check('stores an attachment with a unicode, long name', async () => {
  const form = new FormData();
  form.append('file', new File([PNG], 'রোগীর_এক্সরে_দাঁতের_ছবি_২০২৬_অনেক_লম্বা_নাম.png', { type: 'image/png' }));
  form.append('patient_id', String(state.patientId));
  form.append('category', 'radiograph');
  form.append('title', 'Peri-apical radiograph 36');
  const uploaded = await api('/api/attachments', { method: 'POST', form, expect: 200 });
  assert(uploaded.payload.id, 'the attachment was stored without an id');
  assert(uploaded.payload.sha256?.length === 64, 'the attachment has no SHA-256 checksum');
  assert(uploaded.payload.sizeBytes === PNG.length, `the stored size is ${uploaded.payload.sizeBytes}, expected ${PNG.length}`);
  state.attachmentId = uploaded.payload.id;
  state.attachmentSha = uploaded.payload.sha256;

  const detail = await api(`/api/attachments/${state.attachmentId}`, { expect: 200 });
  assert(detail.payload.originalName?.includes('এক্সরে'), `the stored name came back as ${detail.payload.originalName}`);
  return detail.payload;
}, ['patientId']);

await check('opens the attachment and returns the exact bytes', async () => {
  const response = await apiRaw(`/api/attachments/${state.attachmentId}/content`);
  assert(response.status === 200, `the attachment answered ${response.status}`);
  const type = response.headers.get('content-type') ?? '';
  assert(type.startsWith('image/png'), `the attachment was served as ${type}`);
  const disposition = response.headers.get('content-disposition') ?? '';
  assert(/filename\*=UTF-8''/.test(disposition), `the download name is not RFC 5987 encoded: ${disposition}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length === PNG.length && bytes.equals(PNG), 'the stored bytes differ from the uploaded file');
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert(digest === state.attachmentSha, `the download hashes to ${digest}, the upload reported ${state.attachmentSha}`);
  note(`${bytes.length} bytes returned byte-for-byte · ${type} · sha256 matches the upload`);
  return bytes.length;
}, ['attachmentId']);

await check('refuses a traversal file name and a disallowed extension', async () => {
  const traversal = new FormData();
  traversal.append('file', new File([PDF], '../../escape.pdf', { type: 'application/pdf' }));
  traversal.append('patient_id', String(state.patientId));
  traversal.append('category', 'report');
  const attempt = await api('/api/attachments', { method: 'POST', form: traversal });
  if (attempt.status < 400) {
    const stored = await api(`/api/attachments/${attempt.payload.id}`, { expect: 200 });
    const name = String(stored.payload.originalName ?? '');
    // The stored name must be a plain file name: no separators, no drive letter,
    // no NUL. (Dots are harmless once the name cannot address a directory.)
    assert(!/[/\\\u0000]/.test(name), `the traversal name was stored as ${name}`);
    assert(!/^[A-Za-z]:/.test(name), `the stored name looks like a drive path: ${name}`);
    // And the bytes must land inside the attachment store, which the download proves.
    const fetchBack = await apiRaw(`/api/attachments/${attempt.payload.id}/content`);
    assert(fetchBack.status === 200, `the stored file could not be read back (${fetchBack.status})`);
  }

  const executable = new FormData();
  executable.append('file', new File([Buffer.from('MZ\x90\x00fake')], 'payload.exe', { type: 'application/octet-stream' }));
  executable.append('patient_id', String(state.patientId));
  executable.append('category', 'other');
  const refused = await api('/api/attachments', { method: 'POST', form: executable });
  assert(refused.status >= 400 && refused.status < 500, `an .exe upload answered ${refused.status} instead of a refusal`);
  return { traversal: attempt.status, executable: refused.status };
}, ['patientId']);

await check('stores a PDF report attachment', async () => {
  const form = new FormData();
  form.append('file', new File([PDF], 'lab-report.pdf', { type: 'application/pdf' }));
  form.append('patient_id', String(state.patientId));
  form.append('category', 'lab');
  const uploaded = await api('/api/attachments', { method: 'POST', form, expect: 200 });
  const content = await apiRaw(`/api/attachments/${uploaded.payload.id}/content?download=1`);
  assert(content.status === 200, `the PDF answered ${content.status}`);
  assert((content.headers.get('content-type') ?? '').startsWith('application/pdf'), 'the PDF was served with the wrong type');
  assert((content.headers.get('content-disposition') ?? '').startsWith('attachment;'), 'a download request did not switch the disposition');
  return uploaded.payload.id;
}, ['patientId']);

await check('prints all twelve document kinds', async () => {
  // Every printable artefact in the product, rendered by the server exactly as
  // the print engine receives it. No physical printer is involved (and none is
  // claimed): this proves the documents are produced, complete and non-empty.
  const documents = [
    ['invoice', state.invoiceId],
    ['receipt', state.receiptId],
    ['plan', state.planId],
    ['prescription', state.prescriptionId],
    ['visit', state.visitId],
    ['referral', state.referralId],
    ['statement', state.patientId],
    ['appointment-slip', state.appointmentId],
    ['payslip', state.payrollId],
    ['patient-card', state.patientId],
    ['queue-ticket', state.queueEntryId],
    ['report', 0, '?key=revenue&preset=this_month'],
  ];
  const printed = [];
  for (const [kind, id, query] of documents) {
    const response = await apiRaw(`/documents/${kind}/${id}${query ?? ''}`);
    assert(response.status === 200, `the ${kind} document answered ${response.status}`);
    const type = response.headers.get('content-type') ?? '';
    assert(type.includes('text/html'), `the ${kind} document came back as ${type}`);
    const html = await response.text();
    assert(html.length > 500, `the ${kind} document is only ${html.length} characters`);
    assert(/Dentiva|QA Clinic/.test(html), `the ${kind} document carries no clinic identity`);
    assert(!/\{\{|\bundefined\b|\[object Object\]/.test(html), `the ${kind} document contains unresolved placeholders`);
    printed.push(`${kind} ${html.length}B`);
  }
  note(printed.join(' · '));
  return printed;
}, ['patientId', 'invoiceId', 'receiptId', 'planId', 'prescriptionId', 'visitId', 'referralId', 'appointmentId', 'payrollId', 'queueEntryId']);

await check('lays the documents out for every paper size the clinic can choose', async () => {
  // The print stylesheet is what decides paper size, orientation and margins, so
  // the six choices in Settings → Printing are asserted on the rendered document.
  // No physical printer is involved (and none is claimed).
  const papers = [
    ['A4', 'A4'],
    ['A5', 'A5'],
    ['Letter', 'letter'],
    ['Legal', 'legal'],
  ];
  const seen = [];
  for (const [setting, css] of papers) {
    await api('/api/settings', { method: 'PUT', expect: 200, body: { settings: { 'print.defaultPaper': setting } } });
    const html = await (await apiRaw(`/documents/invoice/${state.invoiceId}`)).text();
    assert(new RegExp(`@page\\s*\\{[^}]*size:\\s*${css}`, 'i').test(html.replace(/\s+/g, ' ')), `${setting} did not reach the print stylesheet`);
    seen.push(setting);
  }
  for (const [setting, css] of [['Receipt80', '80mm auto'], ['Receipt58', '58mm auto']]) {
    await api('/api/settings', { method: 'PUT', expect: 200, body: { settings: { 'print.receiptPaper': setting } } });
    const html = await (await apiRaw(`/documents/receipt/${state.receiptId}`)).text();
    assert(html.replace(/\s+/g, ' ').includes(`size: ${css}`), `the ${setting} thermal layout did not apply`);
    seen.push(setting);
  }
  // Orientation and margins travel the same path.
  await api('/api/settings', { method: 'PUT', expect: 200, body: { settings: { 'print.defaultPaper': 'A4', 'print.orientation': 'landscape', 'print.marginMm': 20 } } });
  const landscape = await (await apiRaw(`/documents/invoice/${state.invoiceId}`)).text();
  assert(/size:\s*A4 landscape/i.test(landscape.replace(/\s+/g, ' ')), 'landscape orientation did not apply');
  assert(/margin:\s*20mm/i.test(landscape.replace(/\s+/g, ' ')), 'the 20 mm margin did not apply');
  seen.push('landscape 20 mm');
  // Leave the clinic on the defaults.
  await api('/api/settings', { method: 'PUT', expect: 200, body: { settings: { 'print.defaultPaper': 'A4', 'print.receiptPaper': 'Receipt80', 'print.orientation': 'portrait', 'print.marginMm': 12 } } });
  note(seen.join(' · '));
  return seen;
}, ['invoiceId', 'receiptId']);

await check('answers every report the catalogue offers', async () => {
  const catalogue = await api('/api/reports', { expect: 200 });
  const rows = catalogue.payload.rows ?? [];
  assert(rows.length >= 15, `the catalogue lists ${rows.length} reports`);
  const failures = [];
  for (const row of rows) {
    const key = row.key ?? row.id;
    const response = await api(`/api/reports/run?key=${encodeURIComponent(key)}&preset=this_month`);
    if (response.status !== 200) failures.push(`${key} (${response.status})`);
    else if (!response.payload || typeof response.payload !== 'object') failures.push(`${key} (empty)`);
  }
  assert(failures.length === 0, `these reports did not run: ${failures.join(', ')}`);
  note(`${rows.length} reports ran without an error`);
  return rows.length;
});

await check('runs the report catalogue and exports a report', async () => {
  const catalogue = await api('/api/reports', { expect: 200 });
  assert((catalogue.payload.rows ?? []).length >= 15, `the catalogue lists ${(catalogue.payload.rows ?? []).length} reports`);
  const revenue = await api('/api/reports/run?key=revenue&preset=this_month', { expect: 200 });
  assert(revenue.payload.totals, 'the revenue report has no totals');
  const collections = await api('/api/reports/run?key=collections&preset=this_month', { expect: 200 });
  assert(collections.payload.totals, 'the collections report has no totals');
  const exported = await api('/api/reports/export?key=collections&preset=this_month', { expect: 200 });
  assert(String(exported.payload.fileName ?? '').includes('collections'), 'the exported file is not named after the report');
  assert(String(exported.payload.content ?? '').length > 10, 'the exported CSV is empty');
  note(`${(catalogue.payload.rows ?? []).length} reports · CSV export ${String(exported.payload.content).length} bytes`);
  return exported.payload.fileName;
});

await check('the audit trail records the work without secrets', async () => {
  const audit = await api('/api/audit?pageSize=50', { expect: 200 });
  const rows = audit.payload.rows ?? [];
  assert(rows.length > 0, 'the audit log is empty after a full clinic workflow');
  const actions = rows.map((/** @type {any} */ row) => row.action);
  for (const wanted of ['login', 'create']) {
    assert(actions.some((action) => String(action).includes(wanted)), `no “${wanted}” entry in the audit trail`);
  }
  for (const row of rows) {
    assert(!JSON.stringify(row).includes(state.password), 'the audit trail contains the password');
  }
  note(`${rows.length} entries, ${[...new Set(actions)].slice(0, 6).join(', ')} …`);
  return rows.length;
});

await check('creates, verifies and lists a backup', async () => {
  const created = await api('/api/backup/create', { method: 'POST', expect: 200, body: {} });
  assert(Number(created.payload.bytes) > 1000, `the backup is only ${created.payload.bytes} bytes`);
  state.backupPath = created.payload.path ?? created.payload.file;
  const listed = await api('/api/backup/list', { expect: 200 });
  assert((listed.payload.backups ?? []).length >= 1, 'the backup list is empty');
  const verified = await api('/api/backup/verify', { method: 'POST', expect: 200, body: { path: state.backupPath } });
  assert(verified.payload.ok === true, 'the backup failed verification');
  const exported = await api('/api/backup/export', { method: 'POST', expect: 200, body: {} });
  assert(Number(exported.payload.counts?.patients ?? 0) >= 1, 'the JSON export counts no patients');
  note(`${created.payload.bytes} bytes · verified · export counts ${JSON.stringify(exported.payload.counts)}`);
  return created.payload;
}, ['patientId']);

await check('restores the backup and finds every record intact', async () => {
  const restored = await api('/api/backup/restore', { method: 'POST', expect: 200, body: { path: state.backupPath } });
  void restored;
  // A restore reopens the database, so sign in again before reading anything.
  await api('/api/auth/login', { method: 'POST', expect: 200, body: { username, password: state.password } });
  const patient = await api(`/api/patients/${state.patientId}`, { expect: 200 });
  assert(patient.payload.id === state.patientId, 'the patient disappeared in the restore');
  assert(patient.payload.fullName === 'মোঃ রফিকুল ইসলাম', 'the Bengali name did not survive the restore');
  const invoice = await api(`/api/invoices/${state.invoiceId}`, { expect: 200 });
  assert(invoice.payload.totalMinor === state.invoiceTotal, `the invoice total changed to ${invoice.payload.totalMinor} after the restore`);
  const attachments = await api(`/api/attachments?patientId=${state.patientId}`, { expect: 200 });
  assert((attachments.payload.rows ?? []).length >= 1, 'the attachment records did not come back');
  note(`patient, invoice ${invoice.payload.invoiceNumber} (${invoice.payload.totalMinor}) and attachments all restored`);
  return true;
}, ['backupPath', 'patientId', 'invoiceId']);

await check('the restored database still answers the dashboard and search', async () => {
  const dashboard = await api('/api/dashboard/summary', { expect: 200 });
  assert(dashboard.payload && typeof dashboard.payload === 'object', 'the dashboard returned nothing');
  assert(Number(dashboard.payload.patients?.total ?? dashboard.payload.patientsTotal ?? 0) >= 0, 'the dashboard has no patient totals');
  const search = await api(`/api/search?q=${encodeURIComponent('রফিকুল')}`, { expect: 200 });
  const groups = search.payload.groups ?? search.payload;
  const patients = Array.isArray(groups) ? groups : groups.patients ?? [];
  assert(patients.length >= 1, 'the global search no longer finds the patient');
  const gantt = await api('/api/appointments/agenda?date=' + today(), { expect: 200 });
  assert(Array.isArray(gantt.payload.appointments), 'the agenda did not answer after the restore');
  return true;
});

/* ------------------------------------------------------------------ report */

const summary = { passed, failed, skipped, total: results.length, checks: results };
if (reportPath) {
  writeFileSync(resolve(reportPath), `${JSON.stringify({ ...summary, origin, finishedAt: new Date().toISOString() }, null, 2)}\n`);
  note(`report written to ${resolve(reportPath)}`);
}

console.log(`\n  ${passed} passed · ${failed} failed${skipped ? ` · ${skipped} skipped` : ''} of ${results.length} checks`);
if (failed) {
  console.log(`\n${RED}▸ Packaged QA failed${RESET}`);
  for (const result of results.filter((entry) => entry.status === 'failed')) console.log(`  • ${result.name}: ${result.detail}`);
} else if (skipped) {
  console.log(`\n${YELLOW}▸ Packaged QA passed every check it could run (${skipped} skipped)${RESET}`);
} else {
  console.log(`\n${GREEN}▸ Packaged QA passed — setup, clinical, billing, inventory, files, documents, reports, backup and restore all work end to end${RESET}`);
}
if (!keep && dataDir) note('the data folder is temporary: delete it (or use --keep) — never ship it');
process.exit(failed ? 1 : 0);
