/**
 * The Dentiva local server.
 *
 * One Bun process serves three things on the loopback interface:
 *   1. `/api/**`     — the JSON API (session cookie + per-launch app token),
 *   2. `/app/**`     — the application window (HTML/CSS/JS, dev or embedded),
 *   3. `/documents/**` — server-rendered print documents (invoices, receipts…).
 *
 * The app window is the only client; nothing is exposed to the network and no
 * request ever leaves the machine. The server can also be started headlessly
 * (`bun src/server/index.js`) for tests and for the QA scripts.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import { getDb, openDatabase, closeDatabase, withTransaction } from './db/connection.js';
import { migrate, latestMigrationId } from './db/migrations/index.js';
import { authenticate } from './services/auth.js';
import { isFirstRun, getClinic } from './services/clinic.js';
import { getSettings } from './services/settings.js';
import { createApiRouter, resolveRange } from './http/routes.js';
import { escapeHtml } from './http/documents.js';
import { json, html, parseCookies, intParam, queryObject, errorResponse, sessionCookie, clearCookie } from './http/http.js';
import { loadAsset, assetManifest, safeRelative } from './http/assets.js';
import * as documents from './http/documents.js';
import * as billing from './services/billing.js';
import * as payments from './services/payments.js';
import * as prescriptions from './services/prescriptions.js';
import * as plans from './services/treatmentPlans.js';
import * as visits from './services/visits.js';
import * as referrals from './services/referrals.js';
import * as patients from './services/patients.js';
import * as reports from './services/reports.js';
import * as queue from './services/queue.js';
import * as appointmentsService from './services/appointments.js';
import * as staffService from './services/staff.js';
import { requiredPermission, effectivePermissions } from './domain/permissions.js';
import { applyClinicDefaultsSync } from './db/seed.js';
import { startScheduler, stopScheduler } from './services/scheduler.js';
import { APP_NAME, APP_VERSION, BUILD_NUMBER, SCHEMA_VERSION, DATA_FILES } from '../shared/constants.js';
import { NotFoundError, PermissionError, AuthError } from '../shared/errors.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, '..', '..');

export const SESSION_COOKIE = 'dentiva_session';

/* --------------------------------------------------------------- app setup */

/**
 * Prepare the data directory and database.
 * @param {{ dataDir: string, appVersion?: string, quiet?: boolean, projectRoot?: string|null }} options
 */
export function initialiseData(options) {
  const dataDir = options.dataDir;
  for (const folder of [dataDir, join(dataDir, DATA_FILES.attachments), join(dataDir, DATA_FILES.backups), join(dataDir, DATA_FILES.logs), join(dataDir, DATA_FILES.exports)]) {
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
  }
  const dbPath = join(dataDir, DATA_FILES.database);
  const db = openDatabase(dbPath);
  const migration = migrate(db, { appVersion: options.appVersion ?? APP_VERSION, quiet: options.quiet });

  // The clinic provisioning template (categories, appointment types, payment
  // methods) ships as `resources/clinic-defaults.json`. Refreshing it here keeps
  // a database created by an older build in step with the shipped defaults; the
  // call is a no-op once the stored template matches.
  let defaults = null;
  try {
    defaults = applyClinicDefaultsSync(db, options);
  } catch (error) {
    if (!options.quiet) console.warn('[dentiva] clinic defaults could not be refreshed:', error instanceof Error ? error.message : error);
  }

  return { db, dbPath, dataDir, migration, defaults };
}

/**
 * Content Security Policy for the application window: everything is served by
 * this process, so nothing external is allowed and no inline script runs (§ 51).
 */
const SHELL_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; " +
  "form-action 'none'; frame-ancestors 'self'";

/**
 * The development browser preview (`bun run preview`) embeds the window in a page
 * from another origin, so the frame-ancestors directive is relaxed for that mode
 * only. The desktop application always uses {@link SHELL_CSP}.
 * @param {boolean} embed
 */
function shellCsp(embed) {
  return embed ? SHELL_CSP.replace("frame-ancestors 'self'", 'frame-ancestors *') : SHELL_CSP;
}

/* ---------------------------------------------------------------- handlers */

function ctxFromSession(db, session, dataDir) {
  return {
    clinicId: session.user?.clinicId ?? null,
    user: session.user ?? null,
    ip: session.ip ?? '127.0.0.1',
    dataDir,
    sessionToken: session.token,
  };
}

/**
 * Parse the request body once, choosing the reader from the content type.
 * Multipart uploads are handed to the route as a `FormData` — reading them here
 * (instead of a second time inside the handler) is what keeps uploads working:
 * a request body can only be consumed once.
 * @param {Request} request
 * @returns {Promise<any>}
 */
function parseBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return Promise.resolve({});
  const type = String(request.headers.get('content-type') ?? '').toLowerCase();
  if (type.startsWith('multipart/form-data')) return request.formData();
  if (!type || type.includes('application/json')) return request.json().catch(() => ({}));
  if (type.includes('application/x-www-form-urlencoded')) return request.formData();
  return Promise.resolve({});
}

/**
 * Build the request handler.
 * @param {{ dataDir: string, appToken?: string|null, dev?: boolean, quiet?: boolean, embed?: boolean }} options
 */
export function createApp(options) {
  const { dataDir } = options;
  const apiRouter = createApiRouter();
  const projectRoot = options.dev ? PROJECT_ROOT : null;
  // Preview mode: the window is opened inside another page (an editor preview
  // pane), which changes two things — the session cookie has to be usable from a
  // cross-origin frame, and the shell must be embeddable. Neither applies to the
  // packaged application, and `null`/`false` keeps the strict defaults.
  const embed = options.embed === true;
  const cookieOptions = embed
    ? { maxAgeSeconds: 12 * 3600, secure: true, sameSite: /** @type {'None'} */ ('None') }
    : { maxAgeSeconds: 12 * 3600 };
  // Browsers that block third-party cookies (Safari, Firefox, Chrome with strict
  // tracking protection) never return the frame's cookie, so preview mode also
  // accepts the session token in a header that the window keeps in memory.
  const embedTokenHeader = 'x-dentiva-session';

  return async function handle(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      /* ------------------------------------------------------------ health */
      if (path === '/health') {
        return json({ ok: true, app: APP_NAME, version: APP_VERSION, build: BUILD_NUMBER, schema: SCHEMA_VERSION, migration: latestMigrationId() });
      }

      const db = getDb();

      /* --------------------------------------------------------------- api */
      if (path.startsWith('/api/')) {
        if (options.appToken && request.headers.get('x-dentiva-app') !== options.appToken) {
          // The window always sends the launch token; anything else on this
          // machine is refused even if it somehow holds a session cookie.
          return json({ error: { code: 'auth.appToken', message: 'Missing application token', status: 401 } }, { status: 401 });
        }

        const cookies = parseCookies(request);
        const token = cookies[SESSION_COOKIE] ?? (embed ? request.headers.get(embedTokenHeader) : null);
        const authenticated = token ? authenticate(db, token) : null;
        const clientIp = request.headers.get('x-forwarded-for') ?? '127.0.0.1';
        const session = { token, user: authenticated, ip: clientIp };

        const match = apiRouter.match(request.method.toUpperCase(), path);
        if (!match) return json({ error: { code: 'errors.notFound', message: `No route for ${request.method} ${path}`, status: 404 } }, { status: 404 });

        const { route, params } = match;
        const permission = route.permission ?? requiredPermission(path, request.method);

        if (path !== '/api/auth/login' && path !== '/api/auth/status' && path !== '/api/auth/first-run' && path !== '/api/session/me' && !session.user) {
          throw new AuthError('auth.sessionExpired', 401);
        }
        if (permission && session.user) {
          const granted = effectivePermissions(db, session.user.id);
          if (!granted.has('*') && !granted.has(permission)) throw new PermissionError(permission);
        }
        if (permission && !session.user) throw new AuthError('auth.sessionExpired', 401);

        const body = await parseBody(request);
        const query = queryObject(url);
        const result = await route.handler({
          db,
          ctx: ctxFromSession(db, session, dataDir),
          params,
          query,
          body,
          request,
          session,
          options,
        });

        const headers = {};
        // Both sign-in and first-run setup open a session; hand the cookie back
        // in the same response so the window can continue without a second call.
        if (result?.token) headers['set-cookie'] = sessionCookie(result.token, cookieOptions);
        if (path === '/api/auth/logout') headers['set-cookie'] = clearCookie(SESSION_COOKIE, cookieOptions);

        if (result === undefined || result === null) return json({ ok: true }, { headers });
        if (result.sessionCookie) {
          headers['set-cookie'] = sessionCookie(result.sessionCookie, cookieOptions);
        }
        // Most routes answer with plain data, which is wrapped here. A few hand
        // back a `Response` of their own — the attachment viewer streams a file
        // with its own content type, length and disposition — and those must be
        // passed through: JSON-encoding them would send `{}` instead of the file.
        if (result instanceof Response) {
          if (!Object.keys(headers).length) return result;
          const merged = new Headers(result.headers);
          for (const [key, value] of Object.entries(headers)) merged.set(key, value);
          return new Response(result.body, { status: result.status, statusText: result.statusText, headers: merged });
        }
        return json(result, { headers });
      }

      /* -------------------------------------------------------- documents */
      if (path.startsWith('/documents/')) {
        return await serveDocument(db, path, request, options);
      }

      /* ----------------------------------------------------------- window */
      if (path === '/' || path === '/index.html') {
        const asset = await loadAsset('index.html', { projectRoot });
        if (!asset) return html(startupFallback(), { status: 200 });
        // The window proves it is the Dentiva shell by sending the launch token
        // in `x-dentiva-app`. Handing it to the page (never to the URL) keeps it
        // out of history, bookmarks and referrers.
        const tokenTag = options.appToken
          ? `  <meta name="dentiva-app-token" content="${escapeHtml(options.appToken)}" />\n`
          : '';
        const markup = asset.body.toString('utf8').replace('</head>', `${tokenTag}</head>`);
        return html(markup, { headers: { 'content-security-policy': shellCsp(embed) } });
      }

      if (path.startsWith('/app/')) {
        const asset = await loadAsset(path.slice(5), { projectRoot });
        if (!asset) return new Response('Not found', { status: 404 });
        return new Response(asset.body, {
          headers: { 'content-type': asset.type, 'cache-control': options.dev ? 'no-store' : 'public, max-age=86400' },
        });
      }

      if (path.startsWith('/fonts/')) {
        const asset = await loadAsset(path.slice(1), { projectRoot });
        if (!asset) return new Response('Not found', { status: 404 });
        return new Response(asset.body, {
          headers: { 'content-type': asset.type, 'cache-control': 'public, max-age=604800' },
        });
      }

      // Shared modules (constants, errors, i18n) are imported by the renderer,
      // so the browser gets exactly the same catalogue the server prints with.
      if (path.startsWith('/shared/')) {
        const asset = await loadAsset(path.slice(1), { projectRoot, root: 'src' });
        if (!asset) return new Response('Not found', { status: 404 });
        return new Response(asset.body, {
          headers: { 'content-type': asset.type, 'cache-control': options.dev ? 'no-store' : 'public, max-age=86400' },
        });
      }

      if (path === '/favicon.ico' || path === '/icon.png') {
        const asset = await loadAsset('assets/icon.png', { projectRoot });
        if (asset) return new Response(asset.body, { headers: { 'content-type': asset.type, 'cache-control': 'public, max-age=86400' } });
        return new Response(null, { status: 204 });
      }

      /* Anything else: hand the shell back so client-side routes work. */
      const shell = await loadAsset('index.html', { projectRoot });
      if (shell && !path.startsWith('/api')) return html(shell.body.toString('utf8'));
      return new Response('Not found', { status: 404 });
    } catch (error) {
      return errorResponse(error, { log: path.startsWith('/api/') });
    }
  };
}

/* -------------------------------------------------------------- documents */

async function serveDocument(db, path, request, options) {
  const parts = path.split('/').filter(Boolean); // ['documents', kind, id]
  const kind = parts[1];
  const id = Number(parts[2]);
  const cookies = parseCookies(request);
  const user = cookies[SESSION_COOKIE] ? authenticate(db, cookies[SESSION_COOKIE]) : null;
  if (!user) {
    return html(`<!doctype html><meta charset="utf-8"><p style="font-family:system-ui;padding:24px">Please sign in to Dentiva to view this document.</p>`, { status: 401 });
  }
  const ctx = { clinicId: user.clinicId, user, ip: '127.0.0.1', dataDir: options.dataDir };
  const settings = getSettings(db, ctx.clinicId);
  const paperSettings = {
    paper: documents.paperFor(settings),
    receiptPaper: documents.paperFor(settings, 'print.receiptPaper'),
    orientation: settings['print.orientation'],
    marginMm: Number(settings['print.marginMm']),
    scale: Number(settings['print.scale']),
    showSignatures: Boolean(settings['print.showSignatures']),
    showLogo: Boolean(settings['print.showClinicLogo']),
    footer: settings['billing.invoiceFooter'],
    receiptFooter: settings['billing.receiptFooter'],
    terms: settings['billing.terms'],
    termLabel: settings['billing.taxEnabled'] ? settings['billing.taxLabel'] : null,
  };

  const granted = effectivePermissions(db, user.id);
  const require = (permission) => {
    if (!granted.has('*') && !granted.has(permission)) throw new PermissionError(permission);
  };

  switch (kind) {
    case 'invoice': {
      require('billing.view');
      const payload = billing.invoiceDocument(db, ctx, intParam({ id }));
      if (payload.invoice.status !== 'draft') billing.markInvoicePrinted(db, ctx, intParam({ id }));
      return html(documents.invoiceHtml(db, ctx, { ...payload, settings: { ...paperSettings, ...payload.settings } }));
    }
    case 'receipt': {
      require('payments.view');
      const payload = payments.receiptDocument(db, ctx, intParam({ id }));
      if (payload.payment && !payload.payment.voidedAt) payments.markReceiptPrinted(db, ctx, intParam({ id }));
      return html(documents.receiptHtml(db, ctx, { ...payload, settings: { ...paperSettings, receiptPaper: paperSettings.receiptPaper, footer: payload.settings.footer ?? paperSettings.receiptFooter } }));
    }
    case 'prescription': {
      require('prescriptions.view');
      const prescriptionId = intParam({ id }) ?? 0;
      const prescription = prescriptions.getPrescription(db, ctx, prescriptionId);
      prescriptions.markPrinted(db, ctx, prescriptionId);
      return html(documents.prescriptionHtml(db, ctx, { prescription, clinic: getClinic(db, ctx.clinicId), settings: paperSettings }));
    }
    case 'plan': {
      require('plans.view');
      const plan = plans.getPlan(db, ctx, intParam({ id }));
      return html(documents.planHtml(db, ctx, { plan, clinic: getClinic(db, ctx.clinicId), settings: paperSettings }));
    }
    case 'visit': {
      require('clinical.view');
      const visit = visits.getVisit(db, ctx, intParam({ id }));
      return html(documents.visitHtml(db, ctx, { visit, clinic: getClinic(db, ctx.clinicId), settings: paperSettings }));
    }
    case 'referral': {
      require('referrals.view');
      const referral = referrals.getReferral(db, ctx, intParam({ id }));
      const patient = referral.patientId ? patients.getPatientDetail(db, ctx, referral.patientId) : null;
      return html(documents.referralHtml(db, ctx, { referral, patient, clinic: getClinic(db, ctx.clinicId), settings: paperSettings }));
    }
    case 'statement': {
      require('payments.view');
      const patientId = intParam({ id }) ?? 0;
      const statement = reports.patientStatement(db, ctx, patientId, resolveRange(queryObject(new URL(request.url))));
      if (!statement) throw new NotFoundError('patient', id);
      return html(documents.statementHtml(db, ctx, { statement, clinic: getClinic(db, ctx.clinicId), settings: paperSettings }));
    }
    case 'appointment-slip': {
      require('appointments.view');
      const appointment = appointmentsService.getAppointment(db, ctx, Number(id));
      if (!appointment) throw new NotFoundError('appointment', id);
      return html(
        documents.appointmentSlipHtml(db, ctx, { appointment, clinic: getClinic(db, ctx.clinicId), settings: paperSettings }),
      );
    }
    case 'payslip': {
      require('payroll.view');
      const payroll = staffService.getPayroll(db, ctx, Number(id));
      if (!payroll) throw new NotFoundError('payroll', id);
      return html(documents.payslipHtml(db, ctx, { payroll, clinic: getClinic(db, ctx.clinicId), settings: paperSettings }));
    }
    case 'patient-card': {
      require('patients.view');
      const patient = patients.getPatientDetail(db, ctx, intParam({ id }));
      return html(documents.patientCardHtml(db, ctx, { patient, clinic: getClinic(db, ctx.clinicId), settings: paperSettings }));
    }
    case 'queue-ticket': {
      require('queue.view');
      const ticket = queue.queueTicketData(db, ctx, intParam({ id }));
      return html(documents.queueTicketHtml(db, ctx, { ...ticket, clinic: getClinic(db, ctx.clinicId), settings: paperSettings }));
    }
    case 'report': {
      require('reports.view');
      const query = queryObject(new URL(request.url));
      const report = reports.runReport(db, ctx, String(query.key ?? 'revenue'), resolveRange(query));
      return html(
        documents.reportHtml(db, ctx, {
          report,
          clinic: getClinic(db, ctx.clinicId),
          settings: paperSettings,
          titleKey: `reports.${report.key}.title`,
        }),
      );
    }
    default:
      return new Response('Unknown document', { status: 404 });
  }
}

function startupFallback() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${APP_NAME}</title>
<style>body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f9f9;color:#16202b}
.card{max-width:520px;padding:28px;background:#fff;border:1px solid #dbe6e6;border-radius:14px;box-shadow:0 18px 40px rgba(15,68,62,.08)}
h1{margin:0 0 6px;font-size:20px}p{margin:6px 0;color:#48606a;line-height:1.5}code{background:#f1f6f6;padding:2px 6px;border-radius:6px}</style></head>
<body><div class="card">
<h1>${APP_NAME}</h1>
<p>The application window could not be loaded from the application package.</p>
<p>Start Dentiva from the <code>Dentiva.exe</code> application, or run <code>bun run dev</code> while developing.</p>
<p style="color:#889">Version ${APP_VERSION} · build ${BUILD_NUMBER} · schema ${SCHEMA_VERSION}</p>
</div></body></html>`;
}

/* ------------------------------------------------------------- lifecycle */

/**
 * Start the loopback server.
 * @param {{ dataDir: string, port?: number, host?: string, dev?: boolean, appToken?: string|null, quiet?: boolean, embed?: boolean }} options
 */
export async function startServer(options) {
  const prepared = initialiseData(options);
  // Automatic backups (backup.* settings) run while the application is open and
  // catch up on the first tick when the computer was off at the scheduled time.
  startScheduler({ db: prepared.db, dataDir: prepared.dataDir, quiet: Boolean(options.quiet) });
  const app = createApp(options);
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.host ?? '127.0.0.1',
    fetch: app,
    development: Boolean(options.dev),
    error: (error) => errorResponse(error),
  });
  const address = server.hostname === '0.0.0.0' || server.hostname === '::' ? '127.0.0.1' : server.hostname;
  return {
    server,
    db: prepared.db,
    dataDir: prepared.dataDir,
    dbPath: prepared.dbPath,
    migration: prepared.migration,
    port: server.port,
    url: `http://${address}:${server.port}`,
    assets: await assetManifest(),
    stop() {
      stopScheduler();
      server.stop(true);
      closeDatabase();
    },
  };
}

/* Direct execution: `bun src/server/index.js` (used by tests and QA scripts). */
if (import.meta.main) {
  const args = process.argv.slice(2);
  /**
   * @param {string} name
   * @param {string|null} [fallback]
   * @returns {string|null}
   */
  const flag = (name, fallback = null) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? fallback : args[index + 1];
  };
  const dataDir = String(flag('data', process.env.DENTIVA_DATA_DIR ?? join(PROJECT_ROOT, '.data-dev')));
  const port = Number(flag('port', process.env.PORT ?? '0') ?? 0);
  const host = String(flag('host', process.env.DENTIVA_HOST ?? '127.0.0.1'));
  const embed = args.includes('--embed');
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.warn(
      `[dentiva] WARNING: listening on ${host}. This is a development server — it is reachable from the ` +
        'network and must never be used with real clinic data. The packaged application always binds 127.0.0.1.',
    );
  }
  const started = await startServer({
    dataDir,
    port,
    host,
    dev: args.includes('--dev'),
    embed,
    appToken: flag('token', null) ?? null,
    quiet: false,
  });
  console.log(`[dentiva] ${APP_NAME} ${APP_VERSION} (build ${BUILD_NUMBER}) listening on ${started.url}`);
  console.log(`[dentiva] data: ${started.dataDir} · schema v${SCHEMA_VERSION} · assets ${started.assets.files} file(s)`);
  if (isFirstRun(started.db)) {
    const clinic = getClinic(started.db);
    console.log(`[dentiva] first run — open ${started.url} to set up the clinic (clinic record: ${clinic ? 'yes' : 'no'})`);
  }
}

export { withTransaction, safeRelative, assetManifest };
