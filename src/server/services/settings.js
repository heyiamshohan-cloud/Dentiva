/**
 * Settings registry and accessors.
 *
 * Every tunable lives in one registry (key → default, type, validation, scope)
 * so the Settings UI is generated from the same source of truth the backend
 * validates against, and so an unknown key can never be written.
 */
import { all, get, run } from '../db/connection.js';
import { ValidationError } from '../../shared/errors.js';
import { nowIso } from '../db/connection.js';

/** @typedef {{ key: string, group: string, type: 'string'|'number'|'boolean'|'json'|'enum', default: any, values?: string[], min?: number, max?: number, labelKey: string, helpKey?: string, secret?: boolean }} SettingSpec */

/** @type {SettingSpec[]} */
export const SETTING_SPECS = [
  // Branding & locale -----------------------------------------------------
  { key: 'branding.accent', group: 'branding', type: 'enum', default: 'teal', values: ['teal', 'indigo', 'slate', 'emerald'], labelKey: 'settings.branding.accent' },
  { key: 'branding.showLogoInHeader', group: 'branding', type: 'boolean', default: true, labelKey: 'settings.branding.showLogoInHeader' },
  { key: 'branding.documentLogo', group: 'branding', type: 'boolean', default: true, labelKey: 'settings.branding.documentLogo' },
  { key: 'locale.language', group: 'language', type: 'enum', default: 'en', values: ['en', 'bn'], labelKey: 'settings.language.language' },
  { key: 'locale.dateFormat', group: 'language', type: 'enum', default: 'DD/MM/YYYY', values: ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD-MM-YYYY', 'DD.MM.YYYY'], labelKey: 'settings.language.dateFormat' },
  { key: 'locale.timeFormat', group: 'language', type: 'enum', default: '12h', values: ['12h', '24h'], labelKey: 'settings.language.timeFormat' },
  { key: 'locale.weekStartsOn', group: 'language', type: 'number', default: 0, min: 0, max: 6, labelKey: 'settings.language.weekStartsOn' },

  // Appearance ------------------------------------------------------------
  { key: 'appearance.density', group: 'appearance', type: 'enum', default: 'comfortable', values: ['comfortable', 'compact'], labelKey: 'settings.appearance.density' },
  { key: 'appearance.sidebarCollapsed', group: 'appearance', type: 'boolean', default: false, labelKey: 'settings.appearance.sidebarCollapsed' },
  { key: 'appearance.animations', group: 'appearance', type: 'boolean', default: true, labelKey: 'settings.appearance.animations' },

  // Patients --------------------------------------------------------------
  { key: 'patients.codePrefix', group: 'patients', type: 'string', default: 'DEN', labelKey: 'settings.patients.codePrefix' },
  { key: 'patients.codePadding', group: 'patients', type: 'number', default: 6, min: 3, max: 12, labelKey: 'settings.patients.codePadding' },
  { key: 'patients.codeStart', group: 'patients', type: 'number', default: 1, min: 1, labelKey: 'settings.patients.codeStart' },
  { key: 'patients.codeIncludeYear', group: 'patients', type: 'boolean', default: false, labelKey: 'settings.patients.codeIncludeYear' },
  { key: 'patients.codeResetPolicy', group: 'patients', type: 'enum', default: 'never', values: ['never', 'yearly'], labelKey: 'settings.patients.codeResetPolicy' },
  { key: 'patients.requirePhone', group: 'patients', type: 'boolean', default: true, labelKey: 'settings.patients.requirePhone' },
  { key: 'patients.useOccupation', group: 'patients', type: 'boolean', default: true, labelKey: 'settings.patients.useOccupation' },
  { key: 'patients.useBloodGroup', group: 'patients', type: 'boolean', default: true, labelKey: 'settings.patients.useBloodGroup' },
  { key: 'patients.useNationalId', group: 'patients', type: 'boolean', default: false, labelKey: 'settings.patients.useNationalId' },
  { key: 'patients.useReferrerSource', group: 'patients', type: 'boolean', default: true, labelKey: 'settings.patients.useReferrerSource' },
  { key: 'patients.defaultStatus', group: 'patients', type: 'enum', default: 'active', values: ['active', 'inactive'], labelKey: 'settings.patients.defaultStatus' },
  { key: 'patients.listColumns', group: 'patients', type: 'json', default: ['code', 'name', 'gender', 'age', 'phone', 'lastVisit', 'nextAppointment', 'outstanding', 'status'], labelKey: 'settings.patients.listColumns' },
  { key: 'patients.duplicateCheck', group: 'patients', type: 'boolean', default: true, labelKey: 'settings.patients.duplicateCheck' },

  // Appointments / queue --------------------------------------------------
  { key: 'appointments.defaultDuration', group: 'appointments', type: 'number', default: 30, min: 5, max: 480, labelKey: 'settings.appointments.defaultDuration' },
  { key: 'appointments.slotStep', group: 'appointments', type: 'number', default: 15, min: 5, max: 120, labelKey: 'settings.appointments.slotStep' },
  { key: 'appointments.allowDoubleBooking', group: 'appointments', type: 'boolean', default: false, labelKey: 'settings.appointments.allowDoubleBooking' },
  { key: 'appointments.reminderLeadMinutes', group: 'appointments', type: 'number', default: 60, min: 0, max: 10080, labelKey: 'settings.appointments.reminderLeadMinutes' },
  { key: 'appointments.workingDays', group: 'appointments', type: 'json', default: ['sun', 'mon', 'tue', 'wed', 'thu'], labelKey: 'settings.appointments.workingDays' },
  { key: 'appointments.openTime', group: 'appointments', type: 'string', default: '10:00', labelKey: 'settings.appointments.openTime' },
  { key: 'appointments.closeTime', group: 'appointments', type: 'string', default: '21:00', labelKey: 'settings.appointments.closeTime' },
  { key: 'queue.enabled', group: 'appointments', type: 'boolean', default: true, labelKey: 'settings.appointments.queueEnabled' },
  { key: 'queue.startNumber', group: 'appointments', type: 'number', default: 1, min: 1, max: 9999, labelKey: 'settings.appointments.queueStart' },

  // Billing & payments ----------------------------------------------------
  { key: 'billing.invoicePrefix', group: 'billing', type: 'string', default: 'INV', labelKey: 'settings.billing.invoicePrefix' },
  { key: 'billing.receiptPrefix', group: 'billing', type: 'string', default: 'RCP', labelKey: 'settings.billing.receiptPrefix' },
  { key: 'billing.padding', group: 'billing', type: 'number', default: 6, min: 3, max: 12, labelKey: 'settings.billing.padding' },
  { key: 'billing.includeYear', group: 'billing', type: 'boolean', default: true, labelKey: 'settings.billing.includeYear' },
  { key: 'billing.resetYearly', group: 'billing', type: 'boolean', default: true, labelKey: 'settings.billing.resetYearly' },
  { key: 'billing.taxEnabled', group: 'billing', type: 'boolean', default: false, labelKey: 'settings.billing.taxEnabled' },
  { key: 'billing.taxLabel', group: 'billing', type: 'string', default: 'VAT', labelKey: 'settings.billing.taxLabel' },
  { key: 'billing.taxRateBp', group: 'billing', type: 'number', default: 0, min: 0, max: 10000, labelKey: 'settings.billing.taxRate' },
  { key: 'billing.taxInclusive', group: 'billing', type: 'boolean', default: false, labelKey: 'settings.billing.taxInclusive' },
  { key: 'billing.roundToWhole', group: 'billing', type: 'boolean', default: false, labelKey: 'settings.billing.roundToWhole' },
  { key: 'billing.defaultDiscountType', group: 'billing', type: 'enum', default: 'amount', values: ['amount', 'percent'], labelKey: 'settings.billing.defaultDiscountType' },
  { key: 'billing.allowOverpayment', group: 'billing', type: 'boolean', default: false, labelKey: 'settings.billing.allowOverpayment' },
  { key: 'billing.invoiceFooter', group: 'billing', type: 'string', default: '', labelKey: 'settings.billing.invoiceFooter' },
  { key: 'billing.receiptFooter', group: 'billing', type: 'string', default: '', labelKey: 'settings.billing.receiptFooter' },
  { key: 'billing.terms', group: 'billing', type: 'string', default: '', labelKey: 'settings.billing.terms' },
  { key: 'billing.autoCreateIncome', group: 'billing', type: 'boolean', default: true, labelKey: 'settings.billing.autoCreateIncome' },

  // Documents & printing --------------------------------------------------
  { key: 'print.defaultPaper', group: 'printing', type: 'enum', default: 'A4', values: ['A4', 'A5', 'Letter', 'Legal', 'Receipt80', 'Receipt58'], labelKey: 'settings.printing.defaultPaper' },
  { key: 'print.receiptPaper', group: 'printing', type: 'enum', default: 'Receipt80', values: ['A4', 'A5', 'Letter', 'Legal', 'Receipt80', 'Receipt58'], labelKey: 'settings.printing.receiptPaper' },
  { key: 'print.orientation', group: 'printing', type: 'enum', default: 'portrait', values: ['portrait', 'landscape'], labelKey: 'settings.printing.orientation' },
  { key: 'print.marginMm', group: 'printing', type: 'number', default: 12, min: 0, max: 40, labelKey: 'settings.printing.margin' },
  { key: 'print.scale', group: 'printing', type: 'number', default: 100, min: 50, max: 150, labelKey: 'settings.printing.scale' },
  { key: 'print.showClinicLogo', group: 'printing', type: 'boolean', default: true, labelKey: 'settings.printing.showLogo' },
  { key: 'print.showSignatures', group: 'printing', type: 'boolean', default: true, labelKey: 'settings.printing.showSignatures' },
  { key: 'print.copyLabel', group: 'printing', type: 'string', default: 'Patient copy', labelKey: 'settings.printing.copyLabel' },
  { key: 'pdf.embedFonts', group: 'printing', type: 'boolean', default: true, labelKey: 'settings.printing.embedFonts' },
  { key: 'pdf.fileNamePattern', group: 'printing', type: 'string', default: '{type}-{number}', labelKey: 'settings.printing.fileNamePattern' },

  // Notifications ---------------------------------------------------------
  { key: 'notifications.enabled', group: 'notifications', type: 'boolean', default: true, labelKey: 'settings.notifications.enabled' },
  { key: 'notifications.quietHoursEnabled', group: 'notifications', type: 'boolean', default: false, labelKey: 'settings.notifications.quietHours' },
  { key: 'notifications.quietStart', group: 'notifications', type: 'string', default: '21:00', labelKey: 'settings.notifications.quietStart' },
  { key: 'notifications.quietEnd', group: 'notifications', type: 'string', default: '09:00', labelKey: 'settings.notifications.quietEnd' },
  { key: 'notifications.followupLookaheadDays', group: 'notifications', type: 'number', default: 3, min: 1, max: 60, labelKey: 'settings.notifications.followupLookahead' },
  { key: 'notifications.kinds', group: 'notifications', type: 'json', default: { appointment_upcoming: true, followup_due: true, outstanding_payment: true, low_stock: true, expiring_stock: true, backup_reminder: true, system: true }, labelKey: 'settings.notifications.kinds' },

  // Security --------------------------------------------------------------
  { key: 'security.idleTimeoutMinutes', group: 'security', type: 'number', default: 15, min: 1, max: 480, labelKey: 'settings.security.idleTimeout' },
  { key: 'security.sessionMaxHours', group: 'security', type: 'number', default: 12, min: 1, max: 168, labelKey: 'settings.security.sessionMax' },
  { key: 'security.maxFailedAttempts', group: 'security', type: 'number', default: 5, min: 3, max: 20, labelKey: 'settings.security.maxAttempts' },
  { key: 'security.lockoutMinutes', group: 'security', type: 'number', default: 15, min: 1, max: 1440, labelKey: 'settings.security.lockout' },
  { key: 'security.minPasswordLength', group: 'security', type: 'number', default: 10, min: 6, max: 64, labelKey: 'settings.security.minLength' },
  { key: 'security.requireStrongPassword', group: 'security', type: 'boolean', default: true, labelKey: 'settings.security.requireStrong' },
  { key: 'security.requirePinForRefunds', group: 'security', type: 'boolean', default: false, labelKey: 'settings.security.refundPin' },
  { key: 'security.auditRetentionDays', group: 'security', type: 'number', default: 1095, min: 30, max: 3650, labelKey: 'settings.security.auditRetention' },

  // Inventory -------------------------------------------------------------
  { key: 'inventory.lowStockAlerts', group: 'inventory', type: 'boolean', default: true, labelKey: 'settings.inventory.lowStockAlerts' },
  { key: 'inventory.expiryWarningDays', group: 'inventory', type: 'number', default: 60, min: 7, max: 365, labelKey: 'settings.inventory.expiryWarningDays' },
  { key: 'inventory.allowNegativeStock', group: 'inventory', type: 'boolean', default: false, labelKey: 'settings.inventory.allowNegativeStock' },

  // Staff / payroll -------------------------------------------------------
  { key: 'staff.codePrefix', group: 'staff', type: 'string', default: 'STF', labelKey: 'settings.staff.codePrefix' },
  {
    key: 'numbering.prefixes',
    group: 'numbering',
    type: 'json',
    default: { visit: 'VS', appointment: 'APT', plan: 'TP', prescription: 'RX', referral: 'REF' },
    labelKey: 'settings.numbering.prefixes',
  },
  { key: 'payroll.autoExpense', group: 'payroll', type: 'boolean', default: true, labelKey: 'settings.staff.payrollAutoExpense' },

  // Backup ----------------------------------------------------------------
  { key: 'backup.autoEnabled', group: 'backup', type: 'boolean', default: true, labelKey: 'settings.backup.auto' },
  { key: 'backup.frequency', group: 'backup', type: 'enum', default: 'daily', values: ['daily', 'weekly', 'monthly', 'manual'], labelKey: 'settings.backup.frequency' },
  { key: 'backup.time', group: 'backup', type: 'string', default: '20:30', labelKey: 'settings.backup.time' },
  { key: 'backup.retentionCount', group: 'backup', type: 'number', default: 14, min: 1, max: 365, labelKey: 'settings.backup.retention' },
  { key: 'backup.includeAttachments', group: 'backup', type: 'boolean', default: true, labelKey: 'settings.backup.includeAttachments' },
  { key: 'backup.verifyAfterCreate', group: 'backup', type: 'boolean', default: true, labelKey: 'settings.backup.verify' },
  { key: 'backup.location', group: 'backup', type: 'string', default: '', labelKey: 'settings.backup.location' },
  { key: 'backup.reminderEnabled', group: 'backup', type: 'boolean', default: true, labelKey: 'settings.backup.reminderEnabled' },
  { key: 'backup.reminderDays', group: 'backup', type: 'number', default: 7, min: 1, max: 90, labelKey: 'settings.backup.reminderDays' },
  { key: 'backup.lastRunAt', group: 'backup', type: 'string', default: '', labelKey: 'settings.backup.lastRun' },

  // Dashboard -------------------------------------------------------------
  {
    key: 'dashboard.widgets',
    group: 'dashboard',
    type: 'json',
    default: ['statTodayAppointments', 'statPatients', 'statQueue', 'statOutstanding', 'queueBoard', 'upcomingAppointments', 'followupsDue', 'quickActions', 'recentPatients', 'treatmentActivity', 'alerts'],
    labelKey: 'settings.dashboard.widgets',
  },
  { key: 'dashboard.range', group: 'dashboard', type: 'enum', default: 'today', values: ['today', 'last7', 'last30', 'last90', 'last180', 'last365', 'custom'], labelKey: 'settings.dashboard.range' },
  { key: 'dashboard.showCharts', group: 'dashboard', type: 'boolean', default: true, labelKey: 'settings.dashboard.charts' },

  // Data ------------------------------------------------------------------
  { key: 'data.attachmentRetentionDays', group: 'data', type: 'number', default: 0, min: 0, max: 3650, labelKey: 'settings.data.retention' },
  { key: 'data.confirmPermanentDelete', group: 'data', type: 'boolean', default: true, labelKey: 'settings.data.confirmDelete' },
];

const SPEC_BY_KEY = new Map(SETTING_SPECS.map((spec) => [spec.key, spec]));

export function settingSpec(key) {
  return SPEC_BY_KEY.get(key) ?? null;
}

function coerce(spec, raw) {
  if (raw === null || raw === undefined) return spec.default;
  try {
    switch (spec.type) {
      case 'number': {
        const value = Number(raw);
        if (!Number.isFinite(value)) return spec.default;
        if (spec.min !== undefined && value < spec.min) return spec.min;
        if (spec.max !== undefined && value > spec.max) return spec.max;
        return value;
      }
      case 'boolean':
        if (typeof raw === 'boolean') return raw;
        return raw === 'true' || raw === 1 || raw === '1';
      case 'enum': {
        const value = String(raw);
        return spec.values?.includes(value) ? value : spec.default;
      }
      case 'json':
        if (typeof raw === 'string') return JSON.parse(raw);
        return raw;
      default:
        return String(raw);
    }
  } catch {
    return spec.default;
  }
}

/** All settings for a clinic, defaults merged with stored overrides. */
export function getSettings(db, clinicId) {
  const stored = new Map(
    all(db, 'SELECT key, value FROM settings WHERE clinic_id = ?', [clinicId]).map((row) => [row.key, row.value]),
  );
  /** @type {Record<string, any>} */
  const result = {};
  for (const spec of SETTING_SPECS) {
    if (!stored.has(spec.key)) {
      result[spec.key] = spec.type === 'json' ? structuredClone(spec.default) : spec.default;
      continue;
    }
    result[spec.key] = coerce(spec, stored.get(spec.key));
  }
  return result;
}

export function getSetting(db, clinicId, key) {
  const spec = SPEC_BY_KEY.get(key);
  if (!spec) throw new ValidationError('settings.unknownKey', [{ field: key, key: 'settings.unknownKey' }]);
  const row = get(db, 'SELECT value FROM settings WHERE clinic_id = ? AND key = ?', [clinicId, key]);
  if (!row) return spec.type === 'json' ? structuredClone(spec.default) : spec.default;
  return coerce(spec, row.value);
}

/** Write several settings atomically; unknown keys are rejected. */
/**
 * @param {any} db
 * @param {number} clinicId
 * @param {Record<string, any>} patch
 * @param {number|null} [userId]
 */
export function setSettings(db, clinicId, patch, userId = null) {
  const unknown = Object.keys(patch).filter((key) => !SPEC_BY_KEY.has(key));
  if (unknown.length) {
    throw new ValidationError('settings.unknownKey', unknown.map((key) => ({ field: key, key: 'settings.unknownKey' })));
  }
  const errors = [];
  const prepared = [];
  for (const [key, rawValue] of Object.entries(patch)) {
    const spec = SPEC_BY_KEY.get(key);
    if (!spec) continue; // unknown keys already rejected above
    if (spec.type === 'number') {
      const value = Number(rawValue);
      if (!Number.isFinite(value)) errors.push({ field: key, key: 'validation.number' });
      else if (spec.min !== undefined && value < spec.min) errors.push({ field: key, key: 'validation.min', params: { min: spec.min } });
      else if (spec.max !== undefined && value > spec.max) errors.push({ field: key, key: 'validation.max', params: { max: spec.max } });
      else prepared.push([key, String(value)]);
      continue;
    }
    if (spec.type === 'enum' && !spec.values?.includes(String(rawValue))) {
      errors.push({ field: key, key: 'validation.option', params: { values: spec.values?.join(', ') } });
      continue;
    }
    if (spec.type === 'json') prepared.push([key, JSON.stringify(rawValue ?? spec.default)]);
    else prepared.push([key, String(rawValue)]);
  }
  if (errors.length) throw new ValidationError('validation.failed', errors);

  const statement = db.prepare(
    `INSERT INTO settings (clinic_id, key, value, value_type, scope, updated_by, updated_at)
     VALUES (?, ?, ?, ?, 'clinic', ?, ?)
     ON CONFLICT(clinic_id, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  );
  for (const [key, value] of prepared) {
    // `enum` values are stored as plain strings; the registry keeps the richer type.
    const rawType = SPEC_BY_KEY.get(key)?.type ?? 'string';
    const dbType = rawType === 'enum' ? 'string' : rawType;
    statement.run(clinicId, key, value, dbType, userId, nowIso());
  }
  return getSettings(db, clinicId);
}

/** Grouped metadata for the Settings screen. */
export function settingsCatalogue() {
  const groups = new Map();
  for (const spec of SETTING_SPECS) {
    if (!groups.has(spec.group)) groups.set(spec.group, []);
    groups.get(spec.group).push({
      key: spec.key,
      type: spec.type,
      values: spec.values ?? null,
      min: spec.min ?? null,
      max: spec.max ?? null,
      default: spec.default,
      labelKey: spec.labelKey,
      helpKey: spec.helpKey ?? null,
    });
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }));
}
