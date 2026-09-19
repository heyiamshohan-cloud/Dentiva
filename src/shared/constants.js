/**
 * Dentiva — shared constants and enumerations.
 * Single source of truth for versions, enumerations and tunables used by both
 * the main process and the local API server.
 */

export const APP_NAME = 'Dentiva';
export const APP_TAGLINE = 'Dental Practice Management System';
export const APP_VERSION = '1.0.0';
export const BUILD_NUMBER = 100;
export const APP_PUBLISHER = 'Md. Shohan Khan';
export const APP_CREATOR_EMAIL = 'helloiamshohan@gmail.com';
export const APP_CREATOR_WHATSAPP = '01516591935';

/** Highest database schema version this build understands. */
export const SCHEMA_VERSION = 10;

/** Data file / directory names inside the user data directory. */
export const DATA_FILES = {
  database: 'dentiva.db',
  attachments: 'attachments',
  backups: 'backups',
  logs: 'logs',
  exports: 'exports',
  temp: 'temp',
  config: 'dentiva.json',
};

export const LOCALES = ['en', 'bn'];
export const DEFAULT_LOCALE = 'en';

export const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD-MM-YYYY', 'DD.MM.YYYY'];
export const TIME_FORMATS = ['12h', '24h'];

export const GENDERS = ['male', 'female', 'other', 'unspecified'];
export const PATIENT_STATUSES = ['active', 'inactive', 'archived'];

export const VISIT_STATUSES = ['open', 'in_progress', 'completed', 'cancelled'];

export const APPOINTMENT_STATUSES = [
  'scheduled',
  'checked_in',
  'waiting',
  'in_treatment',
  'completed',
  'cancelled',
  'no_show',
  'rescheduled',
];

export const APPOINTMENT_ACTIVE_STATUSES = ['scheduled', 'checked_in', 'waiting', 'in_treatment'];

export const QUEUE_STATUSES = ['waiting', 'called', 'in_treatment', 'completed', 'skipped', 'cancelled'];

export const TREATMENT_STATUSES = ['planned', 'in_progress', 'completed', 'cancelled'];

export const PLAN_STATUSES = [
  'draft',
  'proposed',
  'accepted',
  'in_progress',
  'partially_completed',
  'completed',
  'cancelled',
];

export const PLAN_ITEM_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'];

export const REFERRAL_STATUSES = [
  'draft',
  'referred',
  'awaiting_response',
  'report_received',
  'completed',
  'cancelled',
];

export const INVOICE_STATUSES = ['draft', 'issued', 'void'];

export const PAYMENT_KINDS = ['payment', 'refund', 'credit_used'];

export const PAYMENT_METHOD_CODES = ['cash', 'bank', 'card', 'mfs', 'other'];

export const DENTITIONS = ['adult', 'primary'];

export const TOOTH_STATUSES = ['existing', 'planned', 'completed'];

export const ATTACHMENT_CATEGORIES = [
  'radiograph',
  'photo',
  'report',
  'scan',
  'lab',
  'consent',
  'referral',
  'other',
];

/** Extensions Dentiva accepts for clinical attachments (allow-list, § 68). */
export const ATTACHMENT_EXTENSIONS = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'pdf',
  'dcm',
  'txt',
  'csv',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'odt',
  'ods',
];

export const ATTACHMENT_MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  pdf: 'application/pdf',
  dcm: 'application/dicom',
  txt: 'text/plain',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
};

/** 25 MB — protects the database and disk from accidental huge uploads. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const SALARY_TYPES = ['monthly', 'daily', 'hourly', 'contract'];

export const STAFF_STATUSES = ['active', 'inactive', 'suspended', 'left'];

export const STOCK_MOVEMENT_KINDS = ['in', 'out', 'adjustment', 'disposal', 'return'];

export const STOCK_CONDITIONS = ['good', 'near_expiry', 'expired', 'damaged'];

export const INCOME_SOURCES = ['treatment', 'consultation', 'other', 'collection'];

export const DATE_RANGE_PRESETS = [
  'today',
  'last7',
  'last30',
  'last90',
  'last180',
  'last365',
  'this_month',
  'this_year',
  'custom',
];

export const NOTIFICATION_KINDS = [
  'appointment_upcoming',
  'followup_due',
  'outstanding_payment',
  'low_stock',
  'expiring_stock',
  'backup_reminder',
  'system',
  'recall_due',
];

export const AUDIT_SEVERITIES = ['info', 'notice', 'warning', 'critical'];

/** Session / security defaults (overridable from Settings → Security). */
export const SECURITY_DEFAULTS = {
  idleTimeoutMinutes: 15,
  sessionMaxHours: 12,
  maxFailedAttempts: 5,
  lockoutMinutes: 15,
  minPasswordLength: 10,
  requireStrongPassword: true,
};

export const PAPER_SIZES = [
  { code: 'A4', label: 'A4 (210 × 297 mm)', widthMm: 210, heightMm: 297 },
  { code: 'A5', label: 'A5 (148 × 210 mm)', widthMm: 148, heightMm: 210 },
  { code: 'Letter', label: 'Letter (216 × 279 mm)', widthMm: 215.9, heightMm: 279.4 },
  { code: 'Legal', label: 'Legal (216 × 356 mm)', widthMm: 215.9, heightMm: 355.6 },
  { code: 'Receipt80', label: 'Thermal receipt 80 mm', widthMm: 80, heightMm: 297 },
  { code: 'Receipt58', label: 'Thermal receipt 58 mm', widthMm: 58, heightMm: 297 },
];

export const DOCUMENT_TYPES = [
  'invoice',
  'receipt',
  'treatment_estimate',
  'treatment_plan',
  'visit_summary',
  'appointment_slip',
  'prescription',
  'referral_letter',
  'patient_summary',
  'report',
];

export const CURRENCY_PRESETS = [
  { code: 'BDT', symbol: '৳', name: 'Bangladeshi Taka', minorUnits: 2 },
  { code: 'USD', symbol: '$', name: 'US Dollar', minorUnits: 2 },
  { code: 'EUR', symbol: '€', name: 'Euro', minorUnits: 2 },
  { code: 'GBP', symbol: '£', name: 'British Pound', minorUnits: 2 },
  { code: 'INR', symbol: '₹', name: 'Indian Rupee', minorUnits: 2 },
  { code: 'AED', symbol: 'د.إ', name: 'UAE Dirham', minorUnits: 2 },
  { code: 'SAR', symbol: '﷼', name: 'Saudi Riyal', minorUnits: 2 },
  { code: 'MYR', symbol: 'RM', name: 'Malaysian Ringgit', minorUnits: 2 },
  { code: 'PKR', symbol: '₨', name: 'Pakistani Rupee', minorUnits: 2 },
];

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown'];

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
