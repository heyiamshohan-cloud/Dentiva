/**
 * DENTIVA — renderer smoke QA.
 *
 * Boots the real server on a throwaway data directory, loads the real shell
 * document, then drives the application the way a person does:
 *
 *   1. the first-run wizard (clinic → practitioner → owner → confirm),
 *   2. the sign-in screen,
 *   3. every route in the navigation, with one record of each kind seeded
 *      through the public API so the detail screens render real data.
 *
 * It fails on: a route that throws, an error card, or any console error /
 * unhandled rejection in the window. Run it after touching the renderer:
 *
 *     bun run qa:renderer
 *
 * Chromium cannot be used inside every CI sandbox, so this harness runs the
 * shell in jsdom against the real HTTP API — no mocks, no stubbed services.
 */
import { plugin } from 'bun';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { removeScratchDir } from './lib/scratch.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// The shell imports the shared i18n catalogue over the `/shared/**` URL the
// server serves; in Node the same path resolves through this plugin.
plugin({
  name: 'dentiva-shared',
  setup(build) {
    build.onResolve({ filter: /^\/shared\// }, (args) => ({ path: join(ROOT, 'src', args.path) }));
  },
});

const { startServer } = await import(join(ROOT, 'src/server/index.js'));

const TOKEN = 'qa-renderer-token';
const PASSWORD = 'Tangail#Clinic29';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let dataDir = null;
let server = null;
let base = null;
const doms = [];
let current = null;
const jar = new Map();
const problems = [];
const trace = [];
let failures = 0;

const NativeFormData = globalThis.FormData;
const NativeFile = globalThis.File;
const realFetch = globalThis.fetch;

const fail = (message) => {
  failures += 1;
  console.log(`  ✖ ${message}`);
};

/* ------------------------------------------------------------------- fetch */

function getBase() {
  if (!base) throw new Error('Server not started — base URL unavailable');
  return base;
}

/**
 * @param {any} input
 * @param {any} [init]
 * @returns {Promise<Response>}
 */
async function request(input, init = {}) {
  const url = typeof input === 'string' && input.startsWith('/') ? getBase() + input : String(input);
  const headers = new Headers(init.headers ?? {});
  if (!headers.has('x-dentiva-app')) headers.set('x-dentiva-app', TOKEN);
  if (jar.size) headers.set('cookie', [...jar].map(([key, value]) => `${key}=${value}`).join('; '));
  const response = await realFetch(url, { ...init, headers });
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(';')[0];
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  if (String(url).includes('/api/')) {
    const line = `${init.method ?? 'GET'} ${String(url).replace(getBase(), '')} ${response.status}`;
    if (process.env.QA_TRACE) console.log(`    → ${line}`);
    trace.push(line);
  }
  return response;
}

/**
 * JSON helper used by the seeder; throws with the server's message.
 * @param {string} path
 * @param {{ method?: string, body?: any }} [options]
 */
async function api(path, { method = 'POST', body } = {}) {
  const response = await request(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

/* --------------------------------------------------------------------- dom */

async function openShell(tag) {
  const html = await (await request('/')).text();
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => {
    // jsdom cannot navigate; the wizard's "restart the window" is expected.
    if (/Not implemented: navigation/.test(error.message)) return;
    problems.push(`[${tag}][jsdomError] ${error.message}`);
  });
  virtualConsole.on('error', (...args) => {
    problems.push(`[${tag}][console.error] ${args.map((item) => (item?.stack ?? String(item)).split('\n')[0]).join(' ')}`);
  });
  virtualConsole.on('warn', (...args) => problems.push(`[${tag}][console.warn] ${args.join(' ')}`));
  const dom = new JSDOM(html, { url: `${getBase()}/`, pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  for (const name of [
    'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
    'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Node', 'Element', 'Event', 'CustomEvent',
    'MouseEvent', 'KeyboardEvent', 'Image', 'getComputedStyle', 'requestAnimationFrame',
    'cancelAnimationFrame', 'DOMParser', 'XMLHttpRequest',
  ]) {
    if (name === 'window') globalThis.window = window;
    else if (name === 'location') globalThis.location = window.location;
    else if (name === 'navigator') globalThis.navigator = window.navigator;
    else if (window[name] !== undefined) globalThis[name] = window[name];
  }
  /** @type {any} */ (globalThis).fetch = request;
  /** @type {any} */ (window).fetch = request;
  window.matchMedia = window.matchMedia || ((media) => ({
    matches: false, media, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }));
  window.open = () => ({ focus() {}, print() {}, close() {}, document: { write() {} }, location: { assign() {} } });
  window.print = () => {};
  current = dom;
  doms.push(dom);
  return dom;
}

const inputs = (dom) => [...dom.window.document.querySelectorAll('#view input, #view select, #view textarea')];
const viewText = (dom) => dom.window.document.querySelector('#view')?.textContent?.trim() ?? '';

function fill(dom, index, value) {
  const node = inputs(dom)[index];
  if (!node) throw new Error(`no field at index ${index}`);
  node.value = value;
  node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  node.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

function click(dom, selector) {
  const node = dom.window.document.querySelector(selector);
  if (!node) throw new Error(`no element for ${selector}`);
  node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

async function waitFor(label, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value = false;
    try { value = await predicate(); } catch { value = false; }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(40);
  }
}

/** The router mounts twice (loading → content); wait until the view settles. */
async function settle(dom, timeout = 8000) {
  const read = () => dom.window.document.querySelector('#view')?.innerHTML ?? '';
  const deadline = Date.now() + timeout;
  let previous = read();
  let stable = 0;
  while (Date.now() < deadline) {
    await sleep(80);
    const html = read();
    if (html && html === previous) {
      stable += 80;
      if (stable >= 240) return;
    } else {
      stable = 0;
      previous = html;
    }
  }
}

/* ---------------------------------------------------------------- execution */

try {
  dataDir = mkdtempSync(join(tmpdir(), 'dentiva-renderer-'));
  server = await startServer({ dataDir, port: 0, dev: true, appToken: TOKEN, quiet: true });
  base = `http://127.0.0.1:${server.port}`;

  /* ------------------------------------------------------------------ phase 1 */

  console.log('— first-run wizard');
  {
    jar.clear();
    const dom = await openShell('first-run');
    await import(`${ROOT}/src/renderer/js/main.js?window=first-run`);
    await waitFor('the wizard to render', () => inputs(dom).length >= 2);
    const answers = [['DNT', 'Shohan Dental Care'], ['Dr. Test Practitioner', 'Consultant', 'BDS-1234'],
      ['owner', 'Clinic Owner', PASSWORD, PASSWORD]];
    for (const values of answers) {
      values.forEach((value, index) => fill(dom, index, value));
      const buttons = [...dom.window.document.querySelectorAll('#view .row-actions button')];
      buttons[buttons.length - 1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(150);
      const alert = dom.window.document.querySelector('#view .alert:not(.hidden)');
      if (alert && alert.textContent.trim()) throw new Error(`wizard rejected a step: ${alert.textContent}`);
    }
    const confirm = [...dom.window.document.querySelectorAll('#view .row-actions button')];
    confirm[confirm.length - 1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await waitFor('the clinic to be provisioned', async () => {
      const status = await (await request('/api/auth/status')).json();
      return status.firstRun === false;
    }, 8000);
    console.log('  ✔ clinic, practitioner and owner account created through the wizard');
    try { dom.window.close(); } catch {}
  }

  /* ------------------------------------------------------------------ phase 2 */

  console.log('— sign in and walk the application');
  jar.clear();
  const dom = await openShell('app');
  await import(`${ROOT}/src/renderer/js/main.js?window=app`);
  await waitFor('the sign-in screen', () => inputs(dom).length >= 2);
  fill(dom, 0, 'owner');
  fill(dom, 1, PASSWORD);
  click(dom, '#view form button[type=submit]');
  await waitFor('the application shell', () => dom.window.document.getElementById('app')?.hidden === false);
  console.log(`  ✔ signed in as ${dom.window.document.getElementById('accountName').textContent}`);

  /* -------------------------------------------------------------- seed data */

  console.log('— seed one record of each kind');
  const seed = {};
  try {
    seed.patient = (await api('/api/patients', { body: { full_name: 'Ayesha Rahman', gender: 'female', phone: '01700000000', dob: '1994-03-11', address: 'Tangail' } })).id;
  } catch (error) { fail(`seed patient — ${error.message}`); }
  const patientId = seed.patient;

  /** @type {[string, string, any][]} */
  const seedPlan = [
    ['visit', '/api/visits', { patient_id: patientId, chief_complaint: 'Tooth pain', diagnosis: 'Irreversible pulpitis' }],
    ['appointment', '/api/appointments', { patient_id: patientId, appt_date: new Date().toISOString().slice(0, 10), start_time: '10:30', duration_minutes: 30, reason: 'Check-up' }],
    ['treatment', '/api/treatments', { patient_id: patientId, name: 'Root canal treatment', tooth_number: 36, status: 'completed', price_minor: 450000 }],
    ['plan', '/api/plans', { patient_id: patientId, title: 'Restorative plan', items: [{ name: 'Composite filling', tooth_number: 36, quantity_milli: 1000, unit_price_minor: 120000 }] }],
    ['prescription', '/api/prescriptions', { patient_id: patientId, diagnosis: 'Acute pulpitis', items: [{ medication: 'Amoxicillin 500mg', dose: '1 capsule', frequency: '3 times daily', duration: '5 days' }] }],
    ['referral', '/api/referrals', { patient_id: patientId, provider_name: 'General Hospital', reason: 'Cone beam CT', direction: 'out' }],
    ['invoice', '/api/invoices', { patient_id: patientId, items: [{ description: 'Consultation', quantity_milli: 1000, unit_price_minor: 50000 }] }],
    ['staff', '/api/staff', { full_name: 'Nasrin Akter', role_title: 'receptionist', phone: '01800000000', salary_minor: 1800000, salary_type: 'monthly' }],
    ['supplier', '/api/suppliers', { name: 'Dhaka Dental Supplies', phone: '01900000000', products: 'Consumables' }],
    ['inventory', '/api/inventory', { name: 'Composite resin A2', unit: 'syringe', quantity_milli: 12000, min_stock_milli: 2000, purchase_price_minor: 85000, sale_price_minor: 120000, expiry_date: '2027-01-31' }],
  ];
  for (const [label, path, body] of seedPlan) {
    try {
      const created = await api(path, { body });
      seed[label] = created?.id ?? created?.row?.id ?? null;
    } catch (error) {
      fail(`seed ${label} — ${error.message}`);
    }
  }

  if (seed.invoice) {
    try { await api(`/api/invoices/${seed.invoice}/issue`, { body: {} }); } catch (error) { fail(`issue invoice — ${error.message}`); }
    try {
      const payment = await api('/api/payments', { body: { patient_id: patientId, kind: 'payment', method_code: 'cash', amount_minor: 50000, invoice_id: seed.invoice } });
      seed.payment = payment?.receipts?.[0]?.id ?? payment?.id ?? null;
    } catch (error) { fail(`seed payment — ${error.message}`); }
  }
  try { seed.queue = (await api('/api/queue/check-in', { body: { patientId } }))?.id ?? null; } catch (error) { fail(`seed queue — ${error.message}`); }
  try {
    const form = new NativeFormData();
    form.set('patient_id', String(patientId));
    form.set('category', 'radiograph');
    form.set('title', 'OPG');
    form.set('file', new NativeFile([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'opg.png', { type: 'image/png' }));
    const response = await request('/api/attachments', { method: 'POST', body: form });
    if (!response.ok) throw new Error(`POST /api/attachments → ${response.status} ${(await response.text()).slice(0, 200)}`);
    seed.attachment = (await response.json())?.id ?? null;
  } catch (error) { fail(`seed attachment — ${error.message}`); }
  console.log(`  ✔ seeded ${Object.keys(seed).length} records`);

  /* ---------------------------------------------------------------- routes */

  const { navigate } = await import(`${ROOT}/src/renderer/js/core/router.js`);
  const routes = [
    '/', '/dashboard', '/patients', `/patients/${patientId}`, '/appointments', `/appointments/${seed.appointment}`,
    '/calendar', '/queue', '/visits', `/visits/${seed.visit}`, `/chart/${patientId}`, '/treatments', '/plans',
    `/plans/${seed.plan}`, '/prescriptions', '/prescriptions/new', `/prescriptions/${seed.prescription}`,
    '/referrals', `/referrals/${seed.referral}`, '/attachments', '/billing', `/billing/${seed.invoice}`,
    '/payments', `/payments/${seed.payment}`, '/receivables', '/finance', '/staff', `/staff/${seed.staff}`,
    '/payroll', '/inventory', '/suppliers', '/reports', '/reports/patients', '/reports/revenue', '/reports/inventory',
    '/settings', '/users', '/audit', '/backup', '/notifications', '/about',
  ];

  console.log('— routes');
  for (const path of routes) {
    trace.length = 0;
    problems.length = 0;
    try {
      navigate(path);
      dom.window.document.querySelector('#view').innerHTML = '';
      await settle(dom);
    } catch (error) {
      fail(`${path} — ${error.message}`);
      continue;
    }
    const alert = dom.window.document.querySelector('#view .alert');
    if (alert) {
      fail(`${path} — ${(alert.textContent ?? '').trim().slice(0, 200)} [${trace.join(' | ')}]`);
      continue;
    }
    if (problems.length) {
      fail(`${path} — ${problems[0].slice(0, 300)}`);
    }
  }
  console.log(`  ${routes.length} routes checked · ${failures} failure(s)`);
} catch (error) {
  // Unexpected harness error — count as failure but still run cleanup via finally
  failures += 1;
  console.error(`\n✖ Renderer harness error: ${error.stack ?? error.message}`);
} finally {
  // ---- lifecycle / cleanup: close windows, stop server, remove temp dir ----
  // Properly terminate renderer/browser resources before deleting the profile/data dir
  for (const d of doms) {
    try { d.window.close(); } catch {}
  }
  try { if (current && !doms.includes(current)) current.window.close(); } catch {}
  // Give jsdom a tick to release any pending microtasks/handles (helps Windows)
  await sleep(80);
  // Stop the server and close the database (releases WAL/SHM locks)
  if (server) {
    try { await server.stop(); } catch (e) { console.warn(`warning: server.stop failed: ${e.message}`); }
    // Brief pause to let the OS release file handles on Windows
    await sleep(120);
  }
  // Restore fetch globals if we overwrote them (best effort)
  try { if (realFetch) globalThis.fetch = realFetch; } catch {}
  // Remove the temporary data directory. Windows can keep a handle open for a
  // moment after the database is closed, so this retries; a directory that
  // survives is a scratch folder in %TEMP%, not a defect in the application, so
  // it is reported and left behind rather than failing an otherwise green run.
  if (dataDir) await removeScratchDir(dataDir, 'renderer data directory');
}

/* ----------------------------------------------------------------- report */

if (failures === 0) {
  console.log('\n✔ Renderer smoke: GREEN — every screen renders against the live API with no console errors.');
  process.exit(0);
}
console.error(`\n✖ Renderer smoke: RED — ${failures} problem(s).`);
process.exit(1);
