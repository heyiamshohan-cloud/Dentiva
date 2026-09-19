/**
 * The local API surface (spec § 3, § 41, § 74).
 *
 * Every handler is thin: it validates the shape of the request, calls a domain
 * service and returns a plain payload. Permissions are resolved centrally from
 * `domain/permissions.js`; nothing here hard-codes a role check.
 *
 * Handler context: `{ db, ctx, params, query, body, request, session, options }`
 * where `ctx = { clinicId, user, ip, dataDir }` is exactly what services expect.
 */
import { Router, queryObject, intParam, readJson, readMultipart } from './http.js';
import { safeDownloadName } from '../services/fileStore.js';
import { ValidationError, NotFoundError } from '../../shared/errors.js';
import { todayIso, addDays } from '../domain/dates.js';
import { getSettings, setSettings, SETTING_SPECS, settingsCatalogue } from '../services/settings.js';
import { listAuditLogs } from '../services/audit.js';
import { globalSearch, quickPatientSearch, indexStats, rebuildIndex } from '../services/search.js';
import { isFirstRun, getClinic, updateClinic, provisionClinic } from '../services/clinic.js';
import * as auth from '../services/auth.js';
import * as patients from '../services/patients.js';
import * as visits from '../services/visits.js';
import * as chart from '../services/dentalChart.js';
import * as treatments from '../services/treatments.js';
import * as plans from '../services/treatmentPlans.js';
import * as prescriptions from '../services/prescriptions.js';
import * as referrals from '../services/referrals.js';
import * as attachments from '../services/attachments.js';
import * as appointments from '../services/appointments.js';
import * as queue from '../services/queue.js';
import * as billing from '../services/billing.js';
import * as payments from '../services/payments.js';
import * as finance from '../services/finance.js';
import * as staff from '../services/staff.js';
import * as inventory from '../services/inventory.js';
import * as users from '../services/users.js';
import * as backup from '../services/backup.js';
import { scheduleSummary } from '../services/scheduler.js';
import * as reports from '../services/reports.js';
import * as notifications from '../services/notifications.js';
import { permissionCatalogue, effectivePermissions } from '../domain/permissions.js';
import { APP_NAME, APP_VERSION, BUILD_NUMBER, SCHEMA_VERSION, APP_PUBLISHER, APP_CREATOR_EMAIL, APP_CREATOR_WHATSAPP } from '../../shared/constants.js';

/** Positive integer id from a route param (throws a typed error otherwise). */
const asId = (value) => /** @type {number} */ (intParam({ id: value }));

/**
 * Date range helper shared by reports, finance and exports.
 * @param {{ preset?: string|null, from?: string|null, to?: string|null }} [query]
 * @returns {{ from: string, to: string }}
 */
export function resolveRange(query = {}) {
  if (query.from || query.to) {
    const from = query.from ?? query.to;
    const to = query.to ?? query.from;
    if (from && to) return { from, to };
  }
  const preset = String(query.preset ?? 'this_month');
  const today = todayIso();
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const yesterday = addDays(today, -1) ?? today;
      return { from: yesterday, to: yesterday };
    }
    case 'last7':
      return { from: addDays(today, -6) ?? today, to: today };
    case 'last30':
      return { from: addDays(today, -29) ?? today, to: today };
    case 'this_month':
      return { from: monthStart, to: today };
    case 'last_month': {
      const lastMonthDay = addDays(monthStart, -1) ?? today;
      return { from: `${lastMonthDay.slice(0, 7)}-01`, to: lastMonthDay };
    }
    case 'this_year':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case 'all_time':
      return { from: '1970-01-01', to: today };
    default:
      return { from: monthStart, to: today };
  }
}

/* --------------------------------------------------------- settings payload */

function groupedSettings(db, clinicId) {
  const values = getSettings(db, clinicId);
  const groups = new Map();
  for (const spec of SETTING_SPECS) {
    if (!groups.has(spec.group)) groups.set(spec.group, []);
    groups.get(spec.group).push({ ...spec, value: values[spec.key] });
  }
  return { values, groups: [...groups.entries()].map(([group, settings]) => ({ group, settings })) };
}

/* ------------------------------------------------------------------ routes */

/** @type {import('./http.js').Route[]} */
export const routes = [
  /* ---------------------------------------------------------------- session */
  {
    method: 'POST',
    path: '/api/auth/login',
    permission: null,
    description: 'Sign in',
    handler: ({ db, request, body, session }) => {
      const result = auth.login(db, {
        username: String(body.username ?? '').trim(),
        password: String(body.password ?? ''),
        ip: session.ip,
        userAgent: request.headers.get('user-agent'),
      });
      return { ...result, clinic: getClinic(db, result.user.clinicId) };
    },
  },
  {
    method: 'POST',
    path: '/api/auth/logout',
    permission: null,
    handler: ({ db, session }) => {
      if (session.token) auth.logout(db, session.token, 'user');
      return { ok: true };
    },
  },
  {
    method: 'GET',
    path: '/api/auth/status',
    permission: null,
    description: 'First-run state and current session, before sign-in',
    handler: ({ db, session, options }) => ({
      firstRun: isFirstRun(db),
      authenticated: Boolean(session.user),
      user: session.user ?? null,
      // Public so the first-run wizard can tell the operator where the
      // database will live before the clinic exists.
      dataDir: options?.dataDir ?? null,
      app: { name: APP_NAME, version: APP_VERSION, build: BUILD_NUMBER, schema: SCHEMA_VERSION },
    }),
  },
  {
    method: 'POST',
    path: '/api/auth/first-run',
    permission: null,
    description: 'Create the clinic and owner account on first launch',
    handler: ({ db, body }) => {
      if (!isFirstRun(db)) throw new ValidationError('clinic.alreadyProvisioned');
      const provisioned = provisionClinic(db, body);
      const login = auth.login(db, {
        username: body.admin?.username,
        password: body.admin?.password,
        ip: null,
      });
      return { ...provisioned, ...login };
    },
  },
  {
    method: 'GET',
    path: '/api/session/me',
    permission: null,
    handler: ({ db, session }) => ({
      user: session.user,
      permissions: session.user ? [...effectivePermissions(db, session.user.id)] : [],
      clinic: session.user ? clinicPayload(db, session.user.clinicId) : null,
      settings: session.user ? getSettings(db, session.user.clinicId) : null,
      app: { name: APP_NAME, version: APP_VERSION, build: BUILD_NUMBER, schema: SCHEMA_VERSION },
    }),
  },
  {
    method: 'POST',
    path: '/api/session/keepalive',
    permission: null,
    handler: ({ db, session }) => ({ user: auth.authenticate(db, session.token) }),
  },
  {
    method: 'POST',
    path: '/api/auth/change-password',
    permission: null,
    handler: ({ db, session, body }) => {
      auth.changePassword(db, session.user.id, {
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
      });
      return { changed: true };
    },
  },
  {
    method: 'POST',
    path: '/api/auth/pin',
    permission: null,
    handler: ({ db, session, body }) => auth.setPin(db, session.user.id, String(body.pin ?? ''), { currentPassword: body.currentPassword }),
  },
  {
    method: 'DELETE',
    path: '/api/auth/pin',
    permission: null,
    handler: ({ db, session }) => auth.removePin(db, session.user.id),
  },
  { method: 'GET', path: '/api/session/list', permission: null, handler: ({ db, ctx }) => ({ rows: auth.listSessions(db, ctx.clinicId) }) },
  {
    method: 'DELETE',
    path: '/api/session/:id',
    permission: null,
    handler: ({ db, params, ctx }) => auth.revokeSession(db, asId(params.id), ctx.user ?? null),
  },

  /* ------------------------------------------------------------ preferences */
  {
    method: 'GET',
    path: '/api/preferences/settings',
    permission: null,
    handler: ({ db, ctx, query }) => (ctx.user ? groupedSettings(db, ctx.clinicId) : { values: {}, groups: [] }),
  },
  {
    method: 'PUT',
    path: '/api/preferences/settings',
    permission: 'settings.manage',
    handler: ({ db, ctx, body }) => {
      setSettings(db, ctx.clinicId, body.settings ?? body, ctx.user.id);
      return groupedSettings(db, ctx.clinicId);
    },
  },
  {
    method: 'PUT',
    path: '/api/preferences/profile',
    permission: null,
    handler: ({ db, ctx, body }) => {
      const allowed = {};
      if (body.locale === 'en' || body.locale === 'bn') allowed.locale = body.locale;
      if (body.display_name) allowed.display_name = String(body.display_name).slice(0, 120);
      if (typeof body.email === 'string') allowed.email = body.email.slice(0, 160);
      if (typeof body.phone === 'string') allowed.phone = body.phone.slice(0, 32);
      if (Object.keys(allowed).length) {
        const sets = Object.keys(allowed).map((column) => `${column} = ?`);
        db.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...Object.values(allowed), new Date().toISOString(), ctx.user.id);
      }
      return { user: auth.authenticate(db, ctx.sessionToken ?? '') ?? { ...ctx.user, ...allowed } };
    },
  },

  /* ------------------------------------------------------------------- core */
  { method: 'GET', path: '/api/clinic', permission: null, handler: ({ db, ctx }) => clinicPayload(db, ctx.clinicId) },
  {
    method: 'PUT',
    path: '/api/clinic',
    permission: 'settings.manage',
    handler: ({ db, ctx, body }) => updateClinic(db, ctx.clinicId, body, ctx.user.id),
  },
  {
    method: 'GET',
    path: '/api/about',
    permission: null,
    handler: ({ db, options }) => ({
      name: APP_NAME,
      version: APP_VERSION,
      build: BUILD_NUMBER,
      schemaVersion: SCHEMA_VERSION,
      publisher: APP_PUBLISHER,
      contact: { email: APP_CREATOR_EMAIL, whatsapp: APP_CREATOR_WHATSAPP },
      runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
      dataDir: options.dataDir,
      database: options.mode ?? 'file',
      licensed: 'Commercial license — see LICENSE',
      permissions: permissionCatalogue(db).length,
    }),
  },
  {
    method: 'GET',
    path: '/api/dashboard/summary',
    permission: null,
    handler: ({ db, ctx, query }) => reports.dashboard(db, ctx, { date: query.date ?? todayIso() }),
  },
  {
    method: 'GET',
    path: '/api/dashboard/alerts',
    permission: null,
    handler: ({ db, ctx }) => {
      const payload = reports.dashboard(db, ctx, { date: todayIso() });
      return { alerts: payload.alerts, queue: payload.queue, appointments: payload.appointments };
    },
  },

  /* ----------------------------------------------------------------- search */
  { method: 'GET', path: '/api/search', permission: null, handler: ({ db, ctx, query }) => globalSearch(db, ctx.clinicId, query) },
  {
    method: 'GET',
    path: '/api/search/quick',
    permission: null,
    handler: ({ db, ctx, query }) => ({ results: quickPatientSearch(db, ctx.clinicId, String(query.q ?? query.term ?? ''), Number(query.limit ?? 10)) }),
  },
  { method: 'GET', path: '/api/search/stats', permission: null, handler: ({ db }) => indexStats(db) },
  {
    method: 'POST',
    path: '/api/search/rebuild',
    permission: 'settings.manage',
    handler: ({ db, ctx }) => rebuildIndex(db, ctx.clinicId),
  },

  /* --------------------------------------------------------------- patients */
  { method: 'GET', path: '/api/patients', permission: 'patients.view', handler: ({ db, ctx, query }) => patients.listPatients(db, ctx, query) },
  { method: 'GET', path: '/api/patients/summary', permission: 'patients.view', handler: ({ db, ctx }) => patients.patientListSummary(db, ctx) },
  {
    method: 'GET',
    path: '/api/patients/duplicates',
    permission: 'patients.view',
    handler: ({ db, ctx, query }) => patients.findPotentialDuplicates(db, ctx, query),
  },
  { method: 'POST', path: '/api/patients', permission: 'patients.create', handler: ({ db, ctx, body }) => patients.createPatient(db, ctx, body) },
  { method: 'GET', path: '/api/patients/:id', permission: 'patients.view', handler: ({ db, ctx, params }) => patients.getPatientDetail(db, ctx, asId(params.id)) },
  {
    method: 'PUT',
    path: '/api/patients/:id',
    permission: 'patients.edit',
    handler: ({ db, ctx, params, body }) => patients.updatePatient(db, ctx, asId(params.id), body),
  },
  {
    method: 'DELETE',
    path: '/api/patients/:id',
    permission: 'patients.archive',
    handler: ({ db, ctx, params, body }) => patients.archivePatient(db, ctx, asId(params.id), body?.reason ?? null),
  },
  { method: 'POST', path: '/api/patients/:id/restore', permission: 'patients.archive', handler: ({ db, ctx, params }) => patients.restorePatient(db, ctx, asId(params.id)) },
  {
    method: 'DELETE',
    path: '/api/patients/:id/permanent',
    permission: 'patients.delete',
    handler: ({ db, ctx, params, body }) => patients.deletePatientPermanently(db, ctx, asId(params.id), { confirmation: body?.confirmation }),
  },
  { method: 'GET', path: '/api/patients/:id/stats', permission: 'patients.view', handler: ({ db, ctx, params }) => patients.patientStats(db, ctx, asId(params.id)) },
  {
    method: 'GET',
    path: '/api/patients/:id/timeline',
    permission: 'patients.view',
    handler: ({ db, ctx, params, query }) => ({ rows: patients.patientTimeline(db, ctx, asId(params.id), query) }),
  },
  {
    method: 'PUT',
    path: '/api/patients/:id/medical',
    permission: 'patients.edit',
    handler: ({ db, ctx, params, body }) => patients.saveMedicalRecord(db, ctx, asId(params.id), body),
  },
  {
    method: 'PUT',
    path: '/api/patients/:id/dental',
    permission: 'patients.edit',
    handler: ({ db, ctx, params, body }) => patients.saveDentalRecord(db, ctx, asId(params.id), body),
  },
  {
    method: 'PUT',
    path: '/api/patients/:id/contacts',
    permission: 'patients.edit',
    handler: ({ db, ctx, params, body }) => patients.replaceContacts(db, ctx, asId(params.id), body.contacts ?? body),
  },
  {
    method: 'GET',
    path: '/api/patients/:id/notes',
    permission: 'patients.view',
    handler: ({ db, ctx, params, query }) => ({ rows: patients.listNotes(db, ctx, asId(params.id), query) }),
  },
  { method: 'POST', path: '/api/patients/:id/notes', permission: 'patients.edit', handler: ({ db, ctx, params, body }) => patients.addNote(db, ctx, asId(params.id), body) },
  {
    method: 'PUT',
    path: '/api/patients/:id/notes/:noteId',
    permission: 'patients.edit',
    handler: ({ db, ctx, params, body }) => patients.updateNote(db, ctx, asId(params.noteId), body),
  },
  {
    method: 'DELETE',
    path: '/api/patients/:id/notes/:noteId',
    permission: 'patients.edit',
    handler: ({ db, ctx, params }) => patients.deleteNote(db, ctx, asId(params.noteId)),
  },
  {
    method: 'GET',
    path: '/api/patients/:id/statement',
    permission: 'payments.view',
    handler: ({ db, ctx, params, query }) => reports.patientStatement(db, ctx, asId(params.id), resolveRange(query)),
  },

  /* --------------------------------------------------------------- clinical */
  { method: 'GET', path: '/api/visits', permission: 'clinical.view', handler: ({ db, ctx, query }) => visits.listVisits(db, ctx, query) },
  {
    method: 'GET',
    path: '/api/visits/followups',
    permission: 'clinical.view',
    handler: ({ db, ctx, query }) => ({ rows: visits.followupsDue(db, ctx, query) }),
  },
  { method: 'POST', path: '/api/visits', permission: 'clinical.create', handler: ({ db, ctx, body }) => visits.createVisit(db, ctx, body) },
  { method: 'GET', path: '/api/visits/:id', permission: 'clinical.view', handler: ({ db, ctx, params }) => visits.getVisit(db, ctx, asId(params.id)) },
  { method: 'PUT', path: '/api/visits/:id', permission: 'clinical.edit', handler: ({ db, ctx, params, body }) => visits.updateVisit(db, ctx, asId(params.id), body) },
  {
    method: 'DELETE',
    path: '/api/visits/:id',
    permission: 'clinical.delete',
    handler: ({ db, ctx, params, body }) => visits.deleteVisit(db, ctx, asId(params.id), body?.reason ?? null),
  },
  {
    method: 'GET',
    path: '/api/visits/patient/:patientId',
    permission: 'clinical.view',
    handler: ({ db, ctx, params, query }) => ({ rows: visits.patientClinicalHistory(db, ctx, asId(params.patientId), query) }),
  },

  /* ------------------------------------------------------------------ chart */
  { method: 'GET', path: '/api/chart/conditions', permission: 'chart.view', handler: ({ db }) => ({ rows: chart.toothConditions(db) }) },
  {
    method: 'GET',
    path: '/api/chart/:patientId',
    permission: 'chart.view',
    handler: ({ db, ctx, params, query }) => chart.getChart(db, ctx, asId(params.patientId), query.dentition ?? 'adult'),
  },
  {
    method: 'GET',
    path: '/api/chart/:patientId/summary',
    permission: 'chart.view',
    handler: ({ db, ctx, params }) => chart.chartSummary(db, ctx, asId(params.patientId)),
  },
  {
    method: 'GET',
    path: '/api/chart/:patientId/history',
    permission: 'chart.view',
    handler: ({ db, ctx, params, query }) => ({ rows: chart.chartHistory(db, ctx, asId(params.patientId), query) }),
  },
  { method: 'POST', path: '/api/chart/entries', permission: 'chart.edit', handler: ({ db, ctx, body }) => chart.addChartEntry(db, ctx, body) },
  {
    method: 'PUT',
    path: '/api/chart/entries/:id',
    permission: 'chart.edit',
    handler: ({ db, ctx, params, body }) => chart.updateChartEntry(db, ctx, asId(params.id), body),
  },
  {
    method: 'DELETE',
    path: '/api/chart/entries/:id',
    permission: 'chart.edit',
    handler: ({ db, ctx, params, body }) => chart.clearChartEntry(db, ctx, asId(params.id), body?.reason ?? null),
  },

  /* ------------------------------------------------------------------ plans */
  { method: 'GET', path: '/api/plans', permission: 'plans.view', handler: ({ db, ctx, query }) => plans.listPlans(db, ctx, query) },
  { method: 'POST', path: '/api/plans', permission: 'plans.create', handler: ({ db, ctx, body }) => plans.createPlan(db, ctx, body) },
  { method: 'GET', path: '/api/plans/:id', permission: 'plans.view', handler: ({ db, ctx, params }) => plans.getPlan(db, ctx, asId(params.id)) },
  { method: 'PUT', path: '/api/plans/:id', permission: 'plans.edit', handler: ({ db, ctx, params, body }) => plans.updatePlan(db, ctx, asId(params.id), body) },
  {
    method: 'DELETE',
    path: '/api/plans/:id',
    permission: 'plans.delete',
    handler: ({ db, ctx, params, body }) => plans.deletePlan(db, ctx, asId(params.id), body?.reason ?? null),
  },
  { method: 'PUT', path: '/api/plans/items/:id', permission: 'plans.edit', handler: ({ db, ctx, params, body }) => plans.updatePlanItem(db, ctx, asId(params.id), body) },
  {
    method: 'POST',
    path: '/api/plans/:id/invoice-preview',
    permission: 'plans.view',
    handler: ({ db, ctx, params, body }) => {
      const items = plans.planItemsForInvoice(db, ctx, asId(params.id));
      return { items, ...(body?.status ? { status: body.status } : {}) };
    },
  },

  /* ------------------------------------------------------------- treatments */
  { method: 'GET', path: '/api/treatments', permission: 'treatments.view', handler: ({ db, ctx, query }) => treatments.listTreatments(db, ctx, query) },
  { method: 'POST', path: '/api/treatments', permission: 'treatments.create', handler: ({ db, ctx, body }) => treatments.createTreatment(db, ctx, body) },
  {
    method: 'GET',
    path: '/api/treatments/unbilled',
    permission: 'treatments.view',
    handler: ({ db, ctx, query }) => ({ rows: treatments.unbilledTreatments(db, ctx, query.patientId ? Number(query.patientId) : undefined) }),
  },
  {
    method: 'PUT',
    path: '/api/treatments/:id',
    permission: 'treatments.edit',
    handler: ({ db, ctx, params, body }) => treatments.updateTreatment(db, ctx, asId(params.id), body),
  },
  {
    method: 'DELETE',
    path: '/api/treatments/:id',
    permission: 'treatments.delete',
    handler: ({ db, ctx, params, body }) => treatments.deleteTreatment(db, ctx, asId(params.id), body?.reason ?? null),
  },
  { method: 'GET', path: '/api/treatments/services', permission: 'treatments.view', handler: ({ db, ctx, query }) => ({ rows: treatments.listServices(db, ctx, query) }) },
  { method: 'POST', path: '/api/treatments/services', permission: 'treatments.manage', handler: ({ db, ctx, body }) => treatments.createService(db, ctx, body) },
  {
    method: 'PUT',
    path: '/api/treatments/services/:id',
    permission: 'treatments.manage',
    handler: ({ db, ctx, params, body }) => treatments.updateService(db, ctx, asId(params.id), body),
  },
  {
    method: 'DELETE',
    path: '/api/treatments/services/:id',
    permission: 'treatments.manage',
    handler: ({ db, ctx, params }) => treatments.archiveService(db, ctx, asId(params.id)),
  },

  /* ----------------------------------------------------------- prescriptions */
  { method: 'GET', path: '/api/prescriptions', permission: 'prescriptions.view', handler: ({ db, ctx, query }) => prescriptions.listPrescriptions(db, ctx, query) },
  { method: 'POST', path: '/api/prescriptions', permission: 'prescriptions.create', handler: ({ db, ctx, body }) => prescriptions.createPrescription(db, ctx, body) },
  {
    method: 'GET',
    path: '/api/prescriptions/templates/list',
    permission: 'prescriptions.view',
    handler: ({ db, ctx, query }) => ({ rows: prescriptions.listTemplates(db, ctx, query) }),
  },
  { method: 'POST', path: '/api/prescriptions/templates', permission: 'prescriptions.create', handler: ({ db, ctx, body }) => prescriptions.saveTemplate(db, ctx, null, body) },
  {
    method: 'PUT',
    path: '/api/prescriptions/templates/:id',
    permission: 'prescriptions.edit',
    handler: ({ db, ctx, params, body }) => prescriptions.saveTemplate(db, ctx, asId(params.id), body),
  },
  {
    method: 'DELETE',
    path: '/api/prescriptions/templates/:id',
    permission: 'prescriptions.delete',
    handler: ({ db, ctx, params }) => prescriptions.deleteTemplate(db, ctx, asId(params.id)),
  },
  { method: 'GET', path: '/api/prescriptions/:id', permission: 'prescriptions.view', handler: ({ db, ctx, params }) => prescriptions.getPrescription(db, ctx, asId(params.id)) },
  {
    method: 'PUT',
    path: '/api/prescriptions/:id',
    permission: 'prescriptions.edit',
    handler: ({ db, ctx, params, body }) => prescriptions.updatePrescription(db, ctx, asId(params.id), body),
  },
  {
    method: 'DELETE',
    path: '/api/prescriptions/:id',
    permission: 'prescriptions.delete',
    handler: ({ db, ctx, params, body }) => prescriptions.deletePrescription(db, ctx, asId(params.id), body?.reason ?? null),
  },
  {
    method: 'POST',
    path: '/api/prescriptions/:id/print',
    permission: 'prescriptions.view',
    handler: ({ db, ctx, params }) => prescriptions.markPrinted(db, ctx, asId(params.id)),
  },

  /* --------------------------------------------------------------- referrals */
  { method: 'GET', path: '/api/referrals', permission: 'referrals.view', handler: ({ db, ctx, query }) => referrals.listReferrals(db, ctx, query) },
  { method: 'POST', path: '/api/referrals', permission: 'referrals.create', handler: ({ db, ctx, body }) => referrals.createReferral(db, ctx, body) },
  { method: 'GET', path: '/api/referrals/directory', permission: 'referrals.view', handler: ({ db, ctx }) => referrals.referralDirectory(db, ctx) },
  { method: 'GET', path: '/api/referrals/:id', permission: 'referrals.view', handler: ({ db, ctx, params }) => referrals.getReferral(db, ctx, asId(params.id)) },
  { method: 'PUT', path: '/api/referrals/:id', permission: 'referrals.edit', handler: ({ db, ctx, params, body }) => referrals.updateReferral(db, ctx, asId(params.id), body) },
  {
    method: 'DELETE',
    path: '/api/referrals/:id',
    permission: 'referrals.delete',
    handler: ({ db, ctx, params, body }) => referrals.deleteReferral(db, ctx, asId(params.id), body?.reason ?? null),
  },
  {
    method: 'POST',
    path: '/api/referrals/:id/outcome',
    permission: 'referrals.edit',
    handler: ({ db, ctx, params, body }) => referrals.recordReferralOutcome(db, ctx, asId(params.id), body),
  },

  /* ------------------------------------------------------------- attachments */
  { method: 'GET', path: '/api/attachments', permission: 'attachments.view', handler: ({ db, ctx, query }) => attachments.listAttachments(db, ctx, query) },
  { method: 'GET', path: '/api/attachments/usage', permission: 'attachments.view', handler: ({ db, ctx }) => attachments.attachmentUsage(db, ctx) },
  {
    method: 'POST',
    path: '/api/attachments',
    permission: 'attachments.add',
    description: 'Multipart upload',
    handler: async ({ db, ctx, body, request }) => {
      const form = body instanceof FormData ? body : await readMultipart(request);
      const file = form.get('file');
      if (!(file instanceof File)) throw new ValidationError('files.missingFile', [{ field: 'file', key: 'files.missingFile' }]);
      const metadata = {};
      for (const key of ['patient_id', 'visit_id', 'treatment_id', 'plan_id', 'referral_id', 'prescription_id', 'category', 'title', 'description', 'captured_on']) {
        const value = form.get(key);
        if (value === null || value === '') continue;
        metadata[key] = ['patient_id', 'visit_id', 'treatment_id', 'plan_id', 'referral_id', 'prescription_id'].includes(key) ? Number(value) : String(value);
      }
      return attachments.createAttachment(db, ctx, metadata, file);
    },
  },
  { method: 'GET', path: '/api/attachments/:id', permission: 'attachments.view', handler: ({ db, ctx, params }) => attachments.getAttachment(db, ctx, asId(params.id)) },
  {
    // Raw bytes so the window (and the print engine) can show X-rays and photos.
    method: 'GET',
    path: '/api/attachments/:id/content',
    permission: 'attachments.view',
    handler: async ({ db, ctx, params, query }) => {
      const { stream, row } = attachments.openAttachmentStream(db, ctx, asId(params.id));
      const name = safeDownloadName(row.original_name ?? row.rel_path);
      const headers = {
        'content-type': row.mime_type ?? 'application/octet-stream',
        'content-length': String(row.size_bytes ?? 0),
        'cache-control': 'private, max-age=300',
        'content-disposition': `${query.download === 'true' || query.download === '1' ? 'attachment' : 'inline'}; filename="${name}"`,
        'x-content-type-options': 'nosniff',
      };
      return new Response(/** @type {any} */ (stream), { status: 200, headers });
    },
  },
  {
    method: 'PUT',
    path: '/api/attachments/:id',
    permission: 'attachments.edit',
    handler: ({ db, ctx, params, body }) => attachments.updateAttachment(db, ctx, asId(params.id), body),
  },
  {
    method: 'DELETE',
    path: '/api/attachments/:id',
    permission: 'attachments.delete',
    handler: ({ db, ctx, params, query }) =>
      attachments.deleteAttachment(db, ctx, asId(params.id), {
        permanent: query.permanent === true || query.permanent === 'true',
        reason: query.reason ?? null,
      }),
  },
  {
    method: 'POST',
    path: '/api/attachments/:id/restore',
    permission: 'attachments.edit',
    handler: ({ db, ctx, params }) => attachments.restoreAttachment(db, ctx, asId(params.id)),
  },
  {
    method: 'POST',
    path: '/api/attachments/:id/verify',
    permission: 'attachments.view',
    handler: async ({ db, ctx, params }) => attachments.verifyAttachment(db, ctx, asId(params.id)),
  },

  /* ------------------------------------------------------------ appointments */
  { method: 'GET', path: '/api/appointments', permission: 'appointments.view', handler: ({ db, ctx, query }) => appointments.listAppointments(db, ctx, query) },
  { method: 'POST', path: '/api/appointments', permission: 'appointments.create', handler: ({ db, ctx, body }) => appointments.createAppointment(db, ctx, body) },
  {
    method: 'GET',
    path: '/api/appointments/calendar',
    permission: 'appointments.view',
    handler: ({ db, ctx, query }) =>
      appointments.calendarFeed(db, ctx, {
        from: query.from ?? todayIso(),
        to: query.to ?? addDays(query.from ?? todayIso(), 30),
        practitionerId: query.practitionerId ? Number(query.practitionerId) : null,
        statuses: query.statuses ? String(query.statuses).split(',') : null,
      }),
  },
  {
    method: 'GET',
    path: '/api/appointments/agenda',
    permission: 'appointments.view',
    handler: ({ db, ctx, query }) => appointments.dayAgenda(db, ctx, query.date ?? todayIso(), { practitionerId: query.practitionerId ? Number(query.practitionerId) : null }),
  },
  {
    method: 'GET',
    path: '/api/appointments/conflict',
    permission: 'appointments.view',
    handler: ({ db, ctx, query }) =>
      appointments.findConflict(db, ctx, {
        practitionerId: query.practitionerId ? Number(query.practitionerId) : null,
        date: query.date,
        startTime: query.startTime ?? query.start_time,
        endTime: query.endTime ?? query.end_time,
        excludeId: query.excludeId ? Number(query.excludeId) : null,
      }),
  },
  { method: 'GET', path: '/api/appointments/types/list', permission: 'appointments.view', handler: ({ db, ctx, query }) => ({ rows: appointments.listAppointmentTypes(db, ctx, query) }) },
  { method: 'POST', path: '/api/appointments/types', permission: 'appointments.manage', handler: ({ db, ctx, body }) => appointments.saveAppointmentType(db, ctx, null, body) },
  {
    method: 'PUT',
    path: '/api/appointments/types/:id',
    permission: 'appointments.manage',
    handler: ({ db, ctx, params, body }) => appointments.saveAppointmentType(db, ctx, asId(params.id), body),
  },
  {
    method: 'DELETE',
    path: '/api/appointments/types/:id',
    permission: 'appointments.manage',
    handler: ({ db, ctx, params }) => appointments.deleteAppointmentType(db, ctx, asId(params.id)),
  },
  { method: 'GET', path: '/api/appointments/:id', permission: 'appointments.view', handler: ({ db, ctx, params }) => appointments.getAppointment(db, ctx, asId(params.id)) },
  {
    method: 'PUT',
    path: '/api/appointments/:id',
    permission: 'appointments.edit',
    handler: ({ db, ctx, params, body }) => appointments.updateAppointment(db, ctx, asId(params.id), body),
  },
  {
    method: 'DELETE',
    path: '/api/appointments/:id',
    permission: 'appointments.cancel',
    handler: ({ db, ctx, params, body }) => appointments.deleteAppointment(db, ctx, asId(params.id), body?.reason ?? null),
  },
  {
    method: 'POST',
    path: '/api/appointments/:id/status',
    permission: 'appointments.edit',
    handler: ({ db, ctx, params, body }) => appointments.setAppointmentStatus(db, ctx, asId(params.id), body.status, { reason: body.reason ?? null, visitId: body.visitId ?? null }),
  },
  {
    method: 'POST',
    path: '/api/appointments/:id/reschedule',
    permission: 'appointments.edit',
    handler: ({ db, ctx, params, body }) => appointments.rescheduleAppointment(db, ctx, asId(params.id), body),
  },

  /* ------------------------------------------------------------------ queue */
  { method: 'GET', path: '/api/queue', permission: 'queue.view', handler: ({ db, ctx, query }) => queue.listQueue(db, ctx, query) },
  { method: 'GET', path: '/api/queue/summary', permission: 'queue.view', handler: ({ db, ctx, query }) => ({ rows: queue.queueSummary(db, ctx, query) }) },
  { method: 'POST', path: '/api/queue/check-in', permission: 'queue.manage', handler: ({ db, ctx, body }) => queue.checkIn(db, ctx, body) },
  { method: 'GET', path: '/api/queue/:id/ticket', permission: 'queue.view', handler: ({ db, ctx, params }) => queue.queueTicketData(db, ctx, asId(params.id)) },
  { method: 'POST', path: '/api/queue/:id/call', permission: 'queue.manage', handler: ({ db, ctx, params }) => queue.callEntry(db, ctx, asId(params.id)) },
  { method: 'POST', path: '/api/queue/:id/start', permission: 'queue.manage', handler: ({ db, ctx, params }) => queue.startEntry(db, ctx, asId(params.id)) },
  {
    method: 'POST',
    path: '/api/queue/:id/complete',
    permission: 'queue.manage',
    handler: ({ db, ctx, params, body }) => queue.completeEntry(db, ctx, asId(params.id), { note: body?.note ?? null }),
  },
  {
    method: 'POST',
    path: '/api/queue/:id/skip',
    permission: 'queue.manage',
    handler: ({ db, ctx, params, body }) => queue.skipEntry(db, ctx, asId(params.id), body?.note ?? null),
  },
  {
    method: 'POST',
    path: '/api/queue/:id/cancel',
    permission: 'queue.manage',
    handler: ({ db, ctx, params, body }) => queue.cancelEntry(db, ctx, asId(params.id), body?.note ?? null),
  },
  {
    method: 'POST',
    path: '/api/queue/:id/priority',
    permission: 'queue.manage',
    handler: ({ db, ctx, params, body }) => queue.setPriority(db, ctx, asId(params.id), Number(body?.priority ?? 0)),
  },
  {
    method: 'POST',
    path: '/api/queue/:id/move',
    permission: 'queue.manage',
    handler: ({ db, ctx, params, body }) => queue.moveEntry(db, ctx, asId(params.id), body?.direction),
  },

  /* ---------------------------------------------------------------- billing */
  { method: 'GET', path: '/api/invoices', permission: 'billing.view', handler: ({ db, ctx, query }) => billing.listInvoices(db, ctx, query) },
  { method: 'POST', path: '/api/invoices', permission: 'billing.create', handler: ({ db, ctx, body }) => billing.createInvoice(db, ctx, body) },
  {
    method: 'GET',
    path: '/api/invoices/receivables',
    permission: 'billing.view',
    handler: ({ db, ctx, query }) => billing.receivables(db, ctx, { asOf: query.asOf ?? todayIso() }),
  },
  { method: 'GET', path: '/api/invoices/outstanding', permission: 'billing.view', handler: ({ db, ctx, query }) => billing.outstandingSummary(db, ctx, query) },
  { method: 'GET', path: '/api/invoices/:id', permission: 'billing.view', handler: ({ db, ctx, params }) => billing.getInvoice(db, ctx, asId(params.id)) },
  {
    method: 'PUT',
    path: '/api/invoices/:id',
    permission: 'billing.edit',
    handler: ({ db, ctx, params, body }) => billing.updateInvoice(db, ctx, asId(params.id), body),
  },
  {
    method: 'POST',
    path: '/api/invoices/:id/issue',
    permission: 'billing.edit',
    handler: ({ db, ctx, params }) => billing.updateInvoice(db, ctx, asId(params.id), { status: 'issued' }),
  },
  {
    method: 'POST',
    path: '/api/invoices/:id/void',
    permission: 'billing.void',
    handler: ({ db, ctx, params, body }) => billing.voidInvoice(db, ctx, asId(params.id), body?.reason ?? ''),
  },
  {
    method: 'POST',
    path: '/api/invoices/:id/print',
    permission: 'billing.view',
    handler: ({ db, ctx, params }) => billing.markInvoicePrinted(db, ctx, asId(params.id)),
  },
  {
    method: 'DELETE',
    path: '/api/invoices/:id',
    permission: 'billing.void',
    handler: ({ db, ctx, params }) => billing.deleteDraftInvoice(db, ctx, asId(params.id)),
  },

  /* --------------------------------------------------------------- payments */
  { method: 'GET', path: '/api/payments', permission: 'payments.view', handler: ({ db, ctx, query }) => payments.listPayments(db, ctx, query) },
  { method: 'POST', path: '/api/payments', permission: 'payments.create', handler: ({ db, ctx, body }) => payments.recordPayment(db, ctx, body) },
  {
    method: 'GET',
    path: '/api/payments/collections',
    permission: 'payments.view',
    handler: ({ db, ctx, query }) => payments.collectionSummary(db, ctx, resolveRange(query)),
  },
  { method: 'GET', path: '/api/payments/methods/list', permission: 'payments.view', handler: ({ db, ctx, query }) => ({ rows: payments.listPaymentMethods(db, ctx, query) }) },
  { method: 'POST', path: '/api/payments/methods', permission: 'payments.manage', handler: ({ db, ctx, body }) => payments.savePaymentMethod(db, ctx, null, body) },
  {
    method: 'PUT',
    path: '/api/payments/methods/:id',
    permission: 'payments.manage',
    handler: ({ db, ctx, params, body }) => payments.savePaymentMethod(db, ctx, asId(params.id), body),
  },
  {
    method: 'DELETE',
    path: '/api/payments/methods/:id',
    permission: 'payments.manage',
    handler: ({ db, ctx, params }) => payments.deletePaymentMethod(db, ctx, asId(params.id)),
  },
  { method: 'POST', path: '/api/payments/refund', permission: 'payments.refund', handler: ({ db, ctx, body }) => payments.refundPayment(db, ctx, body) },
  { method: 'POST', path: '/api/payments/apply-credit', permission: 'payments.create', handler: ({ db, ctx, body }) => payments.applyCredit(db, ctx, body) },
  { method: 'GET', path: '/api/payments/:id', permission: 'payments.view', handler: ({ db, ctx, params }) => payments.getPayment(db, ctx, asId(params.id)) },
  {
    method: 'POST',
    path: '/api/payments/:id/print',
    permission: 'payments.view',
    handler: ({ db, ctx, params }) => payments.markReceiptPrinted(db, ctx, asId(params.id)),
  },
  {
    method: 'POST',
    path: '/api/payments/:id/void',
    permission: 'payments.void',
    handler: ({ db, ctx, params, body }) => payments.voidPayment(db, ctx, asId(params.id), body?.reason ?? ''),
  },

  /* ---------------------------------------------------------------- finance */
  { method: 'GET', path: '/api/finance/summary', permission: 'finance.view', handler: ({ db, ctx, query }) => finance.financeSummary(db, ctx, resolveRange(query)) },
  {
    method: 'GET',
    path: '/api/finance/income-categories',
    permission: 'finance.view',
    handler: ({ db, ctx, query }) => ({ rows: finance.listIncomeCategories(db, ctx, query) }),
  },
  {
    method: 'POST',
    path: '/api/finance/income-categories',
    permission: 'finance.manage',
    handler: ({ db, ctx, body }) => finance.saveCategory(db, ctx, 'income', null, body),
  },
  {
    method: 'PUT',
    path: '/api/finance/income-categories/:id',
    permission: 'finance.manage',
    handler: ({ db, ctx, params, body }) => finance.saveCategory(db, ctx, 'income', asId(params.id), body),
  },
  {
    method: 'DELETE',
    path: '/api/finance/income-categories/:id',
    permission: 'finance.manage',
    handler: ({ db, ctx, params }) => finance.deleteCategory(db, ctx, 'income', asId(params.id)),
  },
  {
    method: 'GET',
    path: '/api/finance/expense-categories',
    permission: 'finance.view',
    handler: ({ db, ctx, query }) => ({ rows: finance.listExpenseCategories(db, ctx, query) }),
  },
  {
    method: 'POST',
    path: '/api/finance/expense-categories',
    permission: 'finance.manage',
    handler: ({ db, ctx, body }) => finance.saveCategory(db, ctx, 'expense', null, body),
  },
  {
    method: 'PUT',
    path: '/api/finance/expense-categories/:id',
    permission: 'finance.manage',
    handler: ({ db, ctx, params, body }) => finance.saveCategory(db, ctx, 'expense', asId(params.id), body),
  },
  {
    method: 'DELETE',
    path: '/api/finance/expense-categories/:id',
    permission: 'finance.manage',
    handler: ({ db, ctx, params }) => finance.deleteCategory(db, ctx, 'expense', asId(params.id)),
  },
  { method: 'GET', path: '/api/finance/incomes', permission: 'finance.view', handler: ({ db, ctx, query }) => finance.listIncomes(db, ctx, query) },
  { method: 'POST', path: '/api/finance/incomes', permission: 'finance.manage', handler: ({ db, ctx, body }) => finance.createIncome(db, ctx, body) },
  {
    method: 'PUT',
    path: '/api/finance/incomes/:id',
    permission: 'finance.manage',
    handler: ({ db, ctx, params, body }) => finance.updateIncome(db, ctx, asId(params.id), body),
  },
  {
    method: 'DELETE',
    path: '/api/finance/incomes/:id',
    permission: 'finance.manage',
    handler: ({ db, ctx, params, body }) => finance.deleteIncome(db, ctx, asId(params.id), body?.reason ?? null),
  },
  { method: 'GET', path: '/api/finance/expenses', permission: 'finance.view', handler: ({ db, ctx, query }) => finance.listExpenses(db, ctx, query) },
  { method: 'POST', path: '/api/finance/expenses', permission: 'finance.manage', handler: ({ db, ctx, body }) => finance.createExpense(db, ctx, body) },
  {
    method: 'PUT',
    path: '/api/finance/expenses/:id',
    permission: 'finance.manage',
    handler: ({ db, ctx, params, body }) => finance.updateExpense(db, ctx, asId(params.id), body),
  },
  {
    method: 'DELETE',
    path: '/api/finance/expenses/:id',
    permission: 'finance.manage',
    handler: ({ db, ctx, params, body }) => finance.deleteExpense(db, ctx, asId(params.id), body?.reason ?? null),
  },
  {
    method: 'GET',
    path: '/api/finance/trends',
    permission: 'finance.view',
    handler: ({ db, ctx, query }) => {
      const range = resolveRange(query);
      return {
        summary: finance.financeSummary(db, ctx, range),
        daily: finance.dailySeries(db, ctx, range),
        monthly: finance.monthlyTrend(db, ctx, { months: Number(query.months ?? 12) }),
        incomeByCategory: finance.incomeByCategory(db, ctx, range),
        expensesByCategory: finance.expensesByCategory(db, ctx, range),
        revenueByService: finance.revenueByService(db, ctx, { ...range, limit: 20 }),
      };
    },
  },

  /* ------------------------------------------------------------------ staff */
  { method: 'GET', path: '/api/staff', permission: 'staff.view', handler: ({ db, ctx, query }) => staff.listStaff(db, ctx, query) },
  { method: 'POST', path: '/api/staff', permission: 'staff.manage', handler: ({ db, ctx, body }) => staff.createStaff(db, ctx, body) },
  { method: 'GET', path: '/api/staff/workload', permission: 'staff.view', handler: ({ db, ctx, query }) => ({ rows: staff.practitionerWorkload(db, ctx, query) }) },
  { method: 'GET', path: '/api/staff/:id', permission: 'staff.view', handler: ({ db, ctx, params }) => staff.getStaff(db, ctx, asId(params.id)) },
  { method: 'PUT', path: '/api/staff/:id', permission: 'staff.manage', handler: ({ db, ctx, params, body }) => staff.updateStaff(db, ctx, asId(params.id), body) },
  {
    method: 'DELETE',
    path: '/api/staff/:id',
    permission: 'staff.manage',
    handler: ({ db, ctx, params, body }) => staff.archiveStaff(db, ctx, asId(params.id), body?.reason ?? null),
  },

  /* ---------------------------------------------------------------- payroll */
  { method: 'GET', path: '/api/payroll', permission: 'payroll.view', handler: ({ db, ctx, query }) => staff.listPayroll(db, ctx, query) },
  { method: 'POST', path: '/api/payroll', permission: 'payroll.manage', handler: ({ db, ctx, body }) => staff.createPayroll(db, ctx, body) },
  { method: 'POST', path: '/api/payroll/draft-run', permission: 'payroll.manage', handler: ({ db, ctx, body }) => staff.draftPayrollRun(db, ctx, body ?? {}) },
  {
    method: 'POST',
    path: '/api/payroll/:id/pay',
    permission: 'payroll.manage',
    handler: ({ db, ctx, params, body }) => staff.payPayroll(db, ctx, asId(params.id), body ?? {}),
  },
  {
    method: 'DELETE',
    path: '/api/payroll/:id',
    permission: 'payroll.manage',
    handler: ({ db, ctx, params, body }) => staff.deletePayroll(db, ctx, asId(params.id), body?.reason ?? null),
  },

  /* -------------------------------------------------------------- inventory */
  { method: 'GET', path: '/api/inventory', permission: 'inventory.view', handler: ({ db, ctx, query }) => inventory.listInventoryItems(db, ctx, query) },
  { method: 'POST', path: '/api/inventory', permission: 'inventory.manage', handler: ({ db, ctx, body }) => inventory.createInventoryItem(db, ctx, body) },
  {
    method: 'GET',
    path: '/api/inventory/report',
    permission: 'inventory.view',
    handler: ({ db, ctx, query }) => inventory.inventoryReport(db, ctx, query),
  },
  { method: 'GET', path: '/api/inventory/categories', permission: 'inventory.view', handler: ({ db, ctx, query }) => ({ rows: inventory.listInventoryCategories(db, ctx, query) }) },
  {
    method: 'POST',
    path: '/api/inventory/categories',
    permission: 'inventory.manage',
    handler: ({ db, ctx, body }) => inventory.saveInventoryCategory(db, ctx, null, body),
  },
  {
    method: 'PUT',
    path: '/api/inventory/categories/:id',
    permission: 'inventory.manage',
    handler: ({ db, ctx, params, body }) => inventory.saveInventoryCategory(db, ctx, asId(params.id), body),
  },
  { method: 'GET', path: '/api/inventory/movements', permission: 'inventory.view', handler: ({ db, ctx, query }) => inventory.listStockMovements(db, ctx, query) },
  {
    method: 'POST',
    path: '/api/inventory/movements',
    permission: 'inventory.manage',
    handler: ({ db, ctx, body }) => inventory.recordStockMovement(db, ctx, body),
  },
  { method: 'POST', path: '/api/inventory/consume', permission: 'inventory.manage', handler: ({ db, ctx, body }) => inventory.consumeForTreatment(db, ctx, body) },
  { method: 'GET', path: '/api/inventory/:id', permission: 'inventory.view', handler: ({ db, ctx, params }) => inventory.getInventoryItem(db, ctx, asId(params.id)) },
  {
    method: 'PUT',
    path: '/api/inventory/:id',
    permission: 'inventory.manage',
    handler: ({ db, ctx, params, body }) => inventory.updateInventoryItem(db, ctx, asId(params.id), body),
  },
  {
    method: 'DELETE',
    path: '/api/inventory/:id',
    permission: 'inventory.manage',
    handler: ({ db, ctx, params, body }) => inventory.archiveInventoryItem(db, ctx, asId(params.id), body?.reason ?? null),
  },

  /* -------------------------------------------------------------- suppliers */
  { method: 'GET', path: '/api/suppliers', permission: 'suppliers.view', handler: ({ db, ctx, query }) => inventory.listSuppliers(db, ctx, query) },
  { method: 'POST', path: '/api/suppliers', permission: 'suppliers.manage', handler: ({ db, ctx, body }) => inventory.saveSupplier(db, ctx, null, body) },
  {
    method: 'PUT',
    path: '/api/suppliers/:id',
    permission: 'suppliers.manage',
    handler: ({ db, ctx, params, body }) => inventory.saveSupplier(db, ctx, asId(params.id), body),
  },
  {
    method: 'DELETE',
    path: '/api/suppliers/:id',
    permission: 'suppliers.manage',
    handler: ({ db, ctx, params }) => inventory.deleteSupplier(db, ctx, asId(params.id)),
  },

  /* ---------------------------------------------------------------- reports */
  { method: 'GET', path: '/api/reports', permission: 'reports.view', handler: () => ({ rows: reports.reportCatalogue() }) },
  {
    method: 'GET',
    path: '/api/reports/run',
    permission: 'reports.view',
    handler: ({ db, ctx, query }) => {
      const key = String(query.key ?? 'revenue');
      return reports.runReport(db, ctx, key, resolveRange(query));
    },
  },
  {
    method: 'GET',
    path: '/api/reports/export',
    permission: 'reports.export',
    handler: ({ db, ctx, query }) => {
      const key = String(query.key ?? 'revenue');
      const report = reports.reportCsv(db, ctx, key, resolveRange(query));
      return {
        key: report.key,
        fileName: `dentiva-${key}-${report.range.from}_${report.range.to}.csv`,
        mimeType: 'text/csv;charset=utf-8',
        content: Buffer.from(report.csv, 'utf8').toString('base64'),
        rows: report.rows.length,
      };
    },
  },

  /* ---------------------------------------------------------- notifications */
  { method: 'GET', path: '/api/notifications', permission: null, handler: ({ db, ctx, query }) => notifications.listNotifications(db, ctx, query) },
  { method: 'GET', path: '/api/notifications/count', permission: null, handler: ({ db, ctx }) => ({ unread: notifications.unreadCount(db, ctx) }) },
  { method: 'POST', path: '/api/notifications/refresh', permission: null, handler: ({ db, ctx }) => notifications.refreshNotifications(db, ctx) },
  { method: 'POST', path: '/api/notifications/read-all', permission: null, handler: ({ db, ctx, body }) => notifications.markAllRead(db, ctx, body ?? {}) },
  { method: 'POST', path: '/api/notifications/:id/read', permission: null, handler: ({ db, ctx, params }) => notifications.markRead(db, ctx, asId(params.id)) },
  { method: 'POST', path: '/api/notifications/:id/unread', permission: null, handler: ({ db, ctx, params }) => notifications.markUnread(db, ctx, asId(params.id)) },
  { method: 'POST', path: '/api/notifications/:id/dismiss', permission: null, handler: ({ db, ctx, params }) => notifications.dismiss(db, ctx, asId(params.id)) },
  {
    method: 'GET',
    path: '/api/notifications/preferences',
    permission: null,
    handler: ({ db, ctx }) => ({ rows: notifications.getPreferences(db, ctx) }),
  },
  {
    method: 'PUT',
    path: '/api/notifications/preferences/:kind',
    permission: null,
    handler: ({ db, ctx, params, body }) => notifications.setPreference(db, ctx, params.kind, body ?? {}),
  },

  /* --------------------------------------------------------------- settings */
  { method: 'GET', path: '/api/settings', permission: 'settings.view', handler: ({ db, ctx }) => ({ catalogue: settingsCatalogue(), ...groupedSettings(db, ctx.clinicId) }) },
  {
    method: 'PUT',
    path: '/api/settings',
    permission: 'settings.manage',
    handler: ({ db, ctx, body }) => {
      setSettings(db, ctx.clinicId, body.settings ?? body, ctx.user?.id ?? null);
      return groupedSettings(db, ctx.clinicId);
    },
  },
  {
    method: 'POST',
    path: '/api/settings/reset',
    permission: 'settings.manage',
    handler: ({ db, ctx, body }) => {
      const patch = {};
      for (const spec of SETTING_SPECS) {
        if (body?.group && spec.group !== body.group) continue;
        patch[spec.key] = spec.default;
      }
      setSettings(db, ctx.clinicId, patch, ctx.user?.id ?? null);
      return groupedSettings(db, ctx.clinicId);
    },
  },

  /* ------------------------------------------------------- users and roles */
  { method: 'GET', path: '/api/users', permission: 'users.view', handler: ({ db, ctx, query }) => users.listUsers(db, ctx, query) },
  { method: 'POST', path: '/api/users', permission: 'users.manage', handler: ({ db, ctx, body }) => users.createUser(db, ctx, body) },
  { method: 'GET', path: '/api/users/:id', permission: 'users.view', handler: ({ db, ctx, params }) => users.getUser(db, ctx, asId(params.id)) },
  { method: 'PUT', path: '/api/users/:id', permission: 'users.manage', handler: ({ db, ctx, params, body }) => users.updateUser(db, ctx, asId(params.id), body) },
  {
    method: 'DELETE',
    path: '/api/users/:id',
    permission: 'users.manage',
    handler: ({ db, ctx, params, body }) => users.disableUser(db, ctx, asId(params.id), body?.reason ?? null),
  },
  {
    method: 'POST',
    path: '/api/users/:id/password',
    permission: 'users.manage',
    handler: ({ db, ctx, params, body }) => auth.resetPassword(db, ctx.user.id, asId(params.id), { password: body.password, mustChange: body.mustChange !== false }),
  },
  {
    method: 'PUT',
    path: '/api/users/:id/permissions',
    permission: 'users.manage',
    handler: ({ db, ctx, params, body }) => users.setUserPermissions(db, ctx, asId(params.id), body.overrides ?? body),
  },
  { method: 'GET', path: '/api/roles', permission: 'users.view', handler: ({ db, ctx }) => users.listRoles(db, ctx, {}) },
  { method: 'GET', path: '/api/roles/catalogue', permission: 'users.view', handler: ({ db }) => ({ groups: permissionCatalogue(db) }) },
  { method: 'GET', path: '/api/roles/:id', permission: 'users.view', handler: ({ db, ctx, params }) => users.getRole(db, ctx, asId(params.id)) },
  { method: 'POST', path: '/api/roles', permission: 'users.manage', handler: ({ db, ctx, body }) => users.saveRole(db, ctx, null, body) },
  { method: 'PUT', path: '/api/roles/:id', permission: 'users.manage', handler: ({ db, ctx, params, body }) => users.saveRole(db, ctx, asId(params.id), body) },
  { method: 'DELETE', path: '/api/roles/:id', permission: 'users.manage', handler: ({ db, ctx, params }) => users.deleteRole(db, ctx, asId(params.id)) },

  /* ------------------------------------------------------------- audit log */
  {
    method: 'GET',
    path: '/api/audit',
    permission: 'audit.view',
    handler: ({ db, ctx, query }) => listAuditLogs(db, ctx.clinicId, { ...query, page: query.page, pageSize: query.pageSize }),
  },
  {
    method: 'GET',
    path: '/api/audit/sessions',
    permission: 'audit.view',
    handler: ({ db, ctx, query }) => ({ rows: users.listUserSessions(db, ctx, query.userId ? Number(query.userId) : undefined) }),
  },

  /* ----------------------------------------------------------------- backup */
  { method: 'GET', path: '/api/backup/list', permission: 'backup.create', handler: ({ db, ctx, query }) => backup.listBackups(db, ctx, query) },
  { method: 'GET', path: '/api/backup/schedule', permission: 'backup.create', handler: ({ db, ctx }) => scheduleSummary(db, ctx.clinicId) },
  { method: 'POST', path: '/api/backup/create', permission: 'backup.create', handler: ({ db, ctx, body }) => backup.createBackup(db, ctx, body ?? {}) },
  { method: 'POST', path: '/api/backup/verify', permission: 'backup.create', handler: ({ db, ctx, body }) => backup.verifyBackup(db, ctx, body.path) },
  {
    method: 'POST',
    path: '/api/backup/restore',
    permission: 'backup.restore',
    handler: ({ db, ctx, body }) => backup.restoreBackup(db, ctx, { archivePath: body.path, dataDir: ctx.dataDir, restoreAttachments: body.restoreAttachments !== false }),
  },
  { method: 'POST', path: '/api/backup/export', permission: 'backup.create', handler: ({ db, ctx, body }) => backup.exportData(db, ctx, body ?? {}) },
  {
    method: 'POST',
    path: '/api/backup/import/patients',
    permission: 'backup.restore',
    handler: ({ db, ctx, body }) => backup.importPatients(db, ctx, String(body.csv ?? ''), { dryRun: Boolean(body.dryRun) }),
  },
  {
    method: 'POST',
    path: '/api/backup/import/patients/csv',
    permission: 'backup.restore',
    handler: async ({ db, ctx, body, request }) => {
      const form = body instanceof FormData ? body : await readMultipart(request);
      const file = form.get('file');
      if (!(file instanceof File)) throw new ValidationError('files.missingFile', [{ field: 'file', key: 'files.missingFile' }]);
      return backup.importPatients(db, ctx, await file.text(), { dryRun: String(form.get('dryRun') ?? '') === 'true' });
    },
  },

  /* -------------------------------------------------------------- documents */
  {
    method: 'GET',
    path: '/api/documents/invoice/:id',
    permission: 'billing.view',
    handler: ({ db, ctx, params }) => billing.invoiceDocument(db, ctx, asId(params.id)),
  },
  {
    method: 'GET',
    path: '/api/documents/receipt/:id',
    permission: 'payments.view',
    handler: ({ db, ctx, params }) => payments.receiptDocument(db, ctx, asId(params.id)),
  },
  {
    method: 'GET',
    path: '/api/documents/plan/:id',
    permission: 'plans.view',
    handler: ({ db, ctx, params }) => plans.getPlan(db, ctx, asId(params.id)),
  },
  {
    method: 'GET',
    path: '/api/documents/prescription/:id',
    permission: 'prescriptions.view',
    handler: ({ db, ctx, params }) => prescriptions.getPrescription(db, ctx, asId(params.id)),
  },
  {
    method: 'GET',
    path: '/api/documents/visit/:id',
    permission: 'clinical.view',
    handler: ({ db, ctx, params }) => visits.getVisit(db, ctx, asId(params.id)),
  },
  {
    method: 'GET',
    path: '/api/documents/referral/:id',
    permission: 'referrals.view',
    handler: ({ db, ctx, params }) => referrals.getReferral(db, ctx, asId(params.id)),
  },
  {
    method: 'GET',
    path: '/api/documents/statement/:patientId',
    permission: 'payments.view',
    handler: ({ db, ctx, params, query }) => reports.patientStatement(db, ctx, asId(params.patientId), resolveRange(query)),
  },
];

export function createApiRouter() {
  return new Router(routes);
}

export function clinicPayload(db, clinicId) {
  const row = getClinic(db, clinicId);
  if (!row) throw new NotFoundError('clinic', clinicId);
  return row;
}

export { queryObject };
