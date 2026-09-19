/**
 * Migration 007 — product configuration defaults.
 *
 * IMPORTANT: this migration intentionally seeds **configuration only**
 * (permission catalogue, system roles, odontogram conditions, category lists,
 * payment methods, appointment types). It never inserts business data — no
 * patients, staff, services, invoices or money of any kind (§ 6, § 76).
 * Clinic-specific rows (payment methods, categories, appointment types) are
 * created by the first-run wizard, because they belong to a clinic.
 */
export const id = 7;
export const name = 'configuration_catalogs';

const now = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

/** Permission catalogue — code, module, action, labelEn, labelBn. */
export const PERMISSIONS = [
  ['dashboard.view', 'dashboard', 'view', 'View dashboard', 'ড্যাশবোর্ড দেখুন'],
  ['notifications.view', 'notifications', 'view', 'View notifications', 'নোটিফিকেশন দেখুন'],

  ['patients.view', 'patients', 'view', 'View patients', 'রোগী দেখুন'],
  ['patients.create', 'patients', 'create', 'Register patients', 'রোগী নিবন্ধন করুন'],
  ['patients.edit', 'patients', 'edit', 'Edit patients', 'রোগীর তথ্য সম্পাদনা করুন'],
  ['patients.archive', 'patients', 'archive', 'Archive / restore patients', 'রোগী আর্কাইভ ও পুনরুদ্ধার'],
  ['patients.export', 'patients', 'export', 'Export patient data', 'রোগীর তথ্য এক্সপোর্ট'],

  ['clinical.view', 'clinical', 'view', 'View clinical records', 'ক্লিনিক্যাল রেকর্ড দেখুন'],
  ['clinical.create', 'clinical', 'create', 'Create visits', 'ভিজিট তৈরি করুন'],
  ['clinical.edit', 'clinical', 'edit', 'Edit clinical records', 'ক্লিনিক্যাল রেকর্ড সম্পাদনা'],
  ['clinical.delete', 'clinical', 'delete', 'Delete visits', 'ভিজিট মুছুন'],

  ['chart.view', 'chart', 'view', 'View dental chart', 'ডেন্টাল চার্ট দেখুন'],
  ['chart.edit', 'chart', 'edit', 'Update dental chart', 'ডেন্টাল চার্ট হালনাগাদ করুন'],

  ['plans.view', 'plans', 'view', 'View treatment plans', 'চিকিৎসা পরিকল্পনা দেখুন'],
  ['plans.create', 'plans', 'create', 'Create treatment plans', 'চিকিৎসা পরিকল্পনা তৈরি'],
  ['plans.edit', 'plans', 'edit', 'Edit treatment plans', 'চিকিৎসা পরিকল্পনা সম্পাদনা'],
  ['plans.delete', 'plans', 'delete', 'Delete treatment plans', 'চিকিৎসা পরিকল্পনা মুছুন'],

  ['treatments.view', 'treatments', 'view', 'View treatments', 'চিকিৎসা দেখুন'],
  ['treatments.create', 'treatments', 'create', 'Record treatments', 'চিকিৎসা লিপিবদ্ধ করুন'],
  ['treatments.edit', 'treatments', 'edit', 'Edit treatments', 'চিকিৎসা সম্পাদনা করুন'],
  ['treatments.delete', 'treatments', 'delete', 'Delete treatments', 'চিকিৎসা মুছুন'],

  ['prescriptions.view', 'prescriptions', 'view', 'View prescriptions', 'প্রেসক্রিপশন দেখুন'],
  ['prescriptions.create', 'prescriptions', 'create', 'Write prescriptions', 'প্রেসক্রিপশন লিখুন'],
  ['prescriptions.edit', 'prescriptions', 'edit', 'Edit prescriptions', 'প্রেসক্রিপশন সম্পাদনা'],
  ['prescriptions.delete', 'prescriptions', 'delete', 'Delete prescriptions', 'প্রেসক্রিপশন মুছুন'],

  ['referrals.view', 'referrals', 'view', 'View referrals', 'রেফারেল দেখুন'],
  ['referrals.create', 'referrals', 'create', 'Create referrals', 'রেফারেল তৈরি করুন'],
  ['referrals.edit', 'referrals', 'edit', 'Edit referrals & outcomes', 'রেফারেল ও ফলাফল সম্পাদনা'],
  ['referrals.delete', 'referrals', 'delete', 'Archive referrals', 'রেফারেল আর্কাইভ করুন'],

  ['attachments.view', 'attachments', 'view', 'View attachments', 'সংযুক্তি দেখুন'],
  ['attachments.add', 'attachments', 'add', 'Add attachments', 'সংযুক্তি যোগ করুন'],
  ['attachments.edit', 'attachments', 'edit', 'Rename / edit attachments', 'সংযুক্তি সম্পাদনা'],
  ['attachments.delete', 'attachments', 'delete', 'Delete attachments', 'সংযুক্তি মুছুন'],

  ['appointments.view', 'appointments', 'view', 'View appointments', 'অ্যাপয়েন্টমেন্ট দেখুন'],
  ['appointments.create', 'appointments', 'create', 'Book appointments', 'অ্যাপয়েন্টমেন্ট বুক করুন'],
  ['appointments.edit', 'appointments', 'edit', 'Reschedule appointments', 'অ্যাপয়েন্টমেন্ট পরিবর্তন'],
  ['appointments.cancel', 'appointments', 'cancel', 'Cancel appointments', 'অ্যাপয়েন্টমেন্ট বাতিল'],

  ['queue.view', 'queue', 'view', 'View patient queue', 'রোগীর সিরিয়াল দেখুন'],
  ['queue.manage', 'queue', 'manage', 'Manage patient queue', 'সিরিয়াল পরিচালনা করুন'],

  ['billing.view', 'billing', 'view', 'View invoices', 'ইনভয়েস দেখুন'],
  ['billing.create', 'billing', 'create', 'Create invoices', 'ইনভয়েস তৈরি করুন'],
  ['billing.edit', 'billing', 'edit', 'Edit invoices', 'ইনভয়েস সম্পাদনা'],
  ['billing.void', 'billing', 'void', 'Void invoices', 'ইনভয়েস বাতিল করুন'],

  ['payments.view', 'payments', 'view', 'View payments', 'পেমেন্ট দেখুন'],
  ['payments.create', 'payments', 'create', 'Record payments', 'পেমেন্ট গ্রহণ করুন'],
  ['payments.refund', 'payments', 'refund', 'Refund payments', 'পেমেন্ট ফেরত দিন'],
  ['payments.void', 'payments', 'void', 'Void receipts', 'রশিদ বাতিল করুন'],

  ['finance.view', 'finance', 'view', 'View finance', 'আর্থিক হিসাব দেখুন'],
  ['finance.manage', 'finance', 'manage', 'Manage income & expenses', 'আয়-ব্যয় পরিচালনা'],

  ['staff.view', 'staff', 'view', 'View staff', 'কর্মী দেখুন'],
  ['staff.manage', 'staff', 'manage', 'Manage staff', 'কর্মী পরিচালনা করুন'],
  ['payroll.view', 'payroll', 'view', 'View payroll', 'বেতন দেখুন'],
  ['payroll.manage', 'payroll', 'manage', 'Manage payroll', 'বেতন পরিচালনা করুন'],

  ['inventory.view', 'inventory', 'view', 'View inventory', 'ইনভেন্টরি দেখুন'],
  ['inventory.manage', 'inventory', 'manage', 'Manage inventory & stock', 'ইনভেন্টরি ও স্টক পরিচালনা'],
  ['suppliers.view', 'suppliers', 'view', 'View suppliers', 'সরবরাহকারী দেখুন'],
  ['suppliers.manage', 'suppliers', 'manage', 'Manage suppliers', 'সরবরাহকারী পরিচালনা'],

  ['reports.view', 'reports', 'view', 'View reports', 'রিপোর্ট দেখুন'],
  ['reports.export', 'reports', 'export', 'Export reports', 'রিপোর্ট এক্সপোর্ট করুন'],

  ['users.view', 'users', 'view', 'View users', 'ব্যবহারকারী দেখুন'],
  ['users.manage', 'users', 'manage', 'Manage users & roles', 'ব্যবহারকারী ও ভূমিকা পরিচালনা'],
  ['audit.view', 'audit', 'view', 'View audit log', 'অডিট লগ দেখুন'],

  ['settings.view', 'settings', 'view', 'View settings', 'সেটিংস দেখুন'],
  ['settings.manage', 'settings', 'manage', 'Change settings', 'সেটিংস পরিবর্তন করুন'],

  ['backup.create', 'backup', 'create', 'Create backups', 'ব্যাকআপ তৈরি করুন'],
  ['backup.restore', 'backup', 'restore', 'Restore backups', 'ব্যাকআপ পুনরুদ্ধার করুন'],

  ['data.export', 'data', 'export', 'Export data', 'ডেটা এক্সপোর্ট করুন'],
  ['data.import', 'data', 'import', 'Import data', 'ডেটা ইমপোর্ট করুন'],
];

/** System roles and the permissions they receive by default. */
export const ROLES = [
  {
    name: 'owner',
    labelEn: 'Owner / Administrator',
    labelBn: 'মালিক / প্রশাসক',
    description: 'Full access to every module including settings, users and backup.',
    permissions: '*',
  },
  {
    name: 'dentist',
    labelEn: 'Dentist',
    labelBn: 'দন্ত চিকিৎসক',
    description: 'Clinical work: visits, dental chart, treatments, prescriptions and referrals.',
    permissions: [
      'dashboard.view',
      'patients.view', 'patients.create', 'patients.edit',
      'clinical.view', 'clinical.create', 'clinical.edit',
      'chart.view', 'chart.edit',
      'plans.view', 'plans.create', 'plans.edit',
      'treatments.view', 'treatments.create', 'treatments.edit',
      'prescriptions.view', 'prescriptions.create', 'prescriptions.edit',
      'referrals.view', 'referrals.create', 'referrals.edit',
      'attachments.view', 'attachments.add', 'attachments.edit',
      'appointments.view', 'appointments.create', 'appointments.edit', 'appointments.cancel',
      'queue.view', 'queue.manage',
      'billing.view', 'payments.view',
      'reports.view', 'reports.export',
      'inventory.view', 'staff.view',
      'notifications.view',
    ],
  },
  {
    name: 'receptionist',
    labelEn: 'Receptionist',
    labelBn: 'রিসেপশনিস্ট',
    description: 'Front desk: registration, appointments, queue and invoicing.',
    permissions: [
      'dashboard.view',
      'patients.view', 'patients.create', 'patients.edit',
      'clinical.view',
      'chart.view',
      'plans.view', 'treatments.view', 'prescriptions.view', 'referrals.view',
      'attachments.view', 'attachments.add',
      'appointments.view', 'appointments.create', 'appointments.edit', 'appointments.cancel',
      'queue.view', 'queue.manage',
      'billing.view', 'billing.create', 'billing.edit',
      'payments.view', 'payments.create',
      'notifications.view',
    ],
  },
  {
    name: 'accountant',
    labelEn: 'Accountant',
    labelBn: 'হিসাবরক্ষক',
    description: 'Billing, payments, finance and financial reporting.',
    permissions: [
      'dashboard.view',
      'patients.view',
      'clinical.view', 'treatments.view', 'prescriptions.view', 'referrals.view',
      'attachments.view',
      'appointments.view', 'queue.view',
      'billing.view', 'billing.create', 'billing.edit', 'billing.void',
      'payments.view', 'payments.create', 'payments.refund', 'payments.void',
      'finance.view', 'finance.manage',
      'payroll.view',
      'reports.view', 'reports.export',
      'inventory.view', 'suppliers.view',
      'data.export',
      'notifications.view',
    ],
  },
  {
    name: 'assistant',
    labelEn: 'Assistant / Staff',
    labelBn: 'সহকারী / কর্মী',
    description: 'Assists with patient flow, inventory and daily operations.',
    permissions: [
      'dashboard.view',
      'patients.view', 'patients.create', 'patients.edit',
      'clinical.view',
      'chart.view', 'chart.edit',
      'plans.view', 'treatments.view', 'prescriptions.view', 'referrals.view',
      'attachments.view', 'attachments.add', 'attachments.edit',
      'appointments.view', 'appointments.create',
      'queue.view', 'queue.manage',
      'billing.view', 'payments.view',
      'inventory.view', 'suppliers.view',
      'notifications.view',
    ],
  },
];

/** Odontogram condition catalogue (clinical vocabulary, not patient data). */
const TOOTH_CONDITIONS = [
  ['healthy', 'Healthy', 'সুস্থ', 'status', '#22c55e', '✓', 10],
  ['caries', 'Caries', 'দন্তক্ষয়', 'finding', '#dc2626', 'C', 20],
  ['filling_composite', 'Composite filling', 'কম্পোজিট ফিলিং', 'restoration', '#2563eb', 'F', 30],
  ['filling_amalgam', 'Amalgam filling', 'অ্যামালগাম ফিলিং', 'restoration', '#64748b', 'A', 40],
  ['rct', 'Root canal treated', 'রুট ক্যানেল চিকিৎসা', 'restoration', '#7c3aed', 'R', 50],
  ['crown', 'Crown', 'ক্রাউন', 'restoration', '#c026d3', 'Cr', 60],
  ['bridge_abutment', 'Bridge abutment', 'ব্রিজ অ্যাবাটমেন্ট', 'restoration', '#0d9488', 'B', 70],
  ['bridge_pontic', 'Bridge pontic', 'ব্রিজ পন্টিক', 'restoration', '#0f766e', 'P', 80],
  ['veneer', 'Veneer', 'ভিনিয়ার', 'restoration', '#db2777', 'V', 90],
  ['implant', 'Implant', 'ইমপ্ল্যান্ট', 'restoration', '#0369a1', 'I', 100],
  ['missing', 'Missing', 'অনুপস্থিত', 'status', '#94a3b8', 'X', 110],
  ['extraction_planned', 'Extraction planned', 'উত্তোলনের পরিকল্পনা', 'planned', '#b91c1c', 'Ex', 120],
  ['impacted', 'Impacted', 'অন্তর্ভুক্ত দাঁত', 'finding', '#ea580c', 'Im', 130],
  ['fracture', 'Fracture', 'দাঁত ভাঙা', 'finding', '#be123c', 'Fr', 140],
  ['attrition', 'Attrition', 'ঘর্ষণজনিত ক্ষয়', 'finding', '#a16207', 'At', 150],
  ['erosion', 'Erosion', 'অ্যাসিড ক্ষয়', 'finding', '#ca8a04', 'Er', 160],
  ['discoloration', 'Discoloration', 'বর্ণ পরিবর্তন', 'finding', '#78716c', 'Dc', 170],
  ['calculus', 'Calculus / plaque', 'ক্যালকুলাস / প্লাক', 'finding', '#eab308', 'Ca', 180],
  ['gingivitis', 'Gingivitis', 'মাড়ির প্রদাহ', 'finding', '#f97316', 'G', 190],
  ['periodontitis', 'Periodontitis', 'পেরিওডন্টাইটিস', 'finding', '#c2410c', 'Pd', 200],
  ['mobility', 'Mobility', 'দাঁতের নড়াচড়া', 'finding', '#9333ea', 'Mo', 210],
  ['sensitivity', 'Sensitivity', 'সংবেদনশীলতা', 'finding', '#0891b2', 'Sn', 220],
  ['sealant', 'Sealant', 'সিল্যান্ট', 'restoration', '#14b8a6', 'Se', 230],
  ['denture', 'Denture', 'ডেনচার', 'restoration', '#6d28d9', 'Dn', 240],
  ['under_treatment', 'Under treatment', 'চিকিৎসাধীন', 'planned', '#2563eb', 'T', 250],
  ['extraction_done', 'Extraction done', 'উত্তোলন সম্পন্ন', 'status', '#57534e', 'Ex✓', 260],
  ['implant_planned', 'Implant planned', 'ইমপ্ল্যান্ট পরিকল্পনা', 'planned', '#1d4ed8', 'Ip', 270],
];

const EXPENSE_CATEGORIES = [
  ['Clinic rent', 'ক্লিনিক ভাড়া', 10, 0],
  ['Chamber rent', 'চেম্বার ভাড়া', 20, 0],
  ['Electricity', 'বিদ্যুৎ bill', 30, 0],
  ['Internet', 'ইন্টারনেট', 40, 0],
  ['Water', 'পানি', 50, 0],
  ['Staff salary', 'কর্মীর বেতন', 60, 1],
  ['Dental materials', 'ডেন্টাল ম্যাটেরিয়াল', 70, 0],
  ['Supplies', 'সরবরাহ সামগ্রী', 80, 0],
  ['Equipment', 'যন্ত্রপাতি', 90, 0],
  ['Maintenance', 'মেরামত ও রক্ষণাবেক্ষণ', 100, 0],
  ['Marketing', 'বিজ্ঞাপন ও প্রচার', 110, 0],
  ['Transportation', 'যাতায়াত', 120, 0],
  ['Laboratory', 'ল্যাবরেটরি', 130, 0],
  ['Miscellaneous', 'বিবিধ', 140, 0],
];

const INCOME_CATEGORIES = [
  ['Treatment income', 'চিকিৎসা থেকে আয়', 10, 1],
  ['Consultation fee', 'পরামর্শ ফি', 20, 1],
  ['Other income', 'অন্যান্য আয়', 30, 0],
];

const APPOINTMENT_TYPES = [
  ['Consultation', 'পরামর্শ', 30, '#0f6f9a', 10],
  ['Follow-up', 'ফলো-আপ', 15, '#0d9488', 20],
  ['Treatment / procedure', 'চিকিৎসা / প্রক্রিয়া', 45, '#7c3aed', 30],
  ['Scaling / hygiene', 'স্কেলিং / পরিচ্ছন্নতা', 30, '#0891b2', 40],
  ['Emergency', 'জরুরি', 30, '#dc2626', 50],
];

const INVENTORY_CATEGORIES = [
  ['Consumables', 'ভোগ্য সামগ্রী', 10],
  ['Instruments', 'যন্ত্রপাতি', 20],
  ['Materials', 'ম্যাটেরিয়াল', 30],
  ['Medicines', 'ঔষধ', 40],
  ['Personal protective equipment', 'ব্যক্তিগত সুরক্ষা সরঞ্জাম', 50],
  ['Laboratory', 'ল্যাবরেটরি', 60],
  ['Other', 'অন্যান্য', 70],
];

export function up(db) {
  // ---------------------------------------------------------------- permissions
  const insertPermission = db.prepare(
    'INSERT INTO permissions (code, module, action, label_en, label_bn, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
  );
  PERMISSIONS.forEach((p, index) => insertPermission.run(p[0], p[1], p[2], p[3], p[4], index * 10));

  // ---------------------------------------------------------------- roles
  const insertRole = db.prepare(
    'INSERT INTO roles (clinic_id, name, label_en, label_bn, description, is_system, is_locked) VALUES (NULL, ?, ?, ?, ?, 1, ?)',
  );
  const insertRolePermission = db.prepare(
    'INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE code = ?',
  );
  const findPermission = db.prepare('SELECT id FROM permissions WHERE code = ?');
  const allPermissionIds = db.query('SELECT id FROM permissions').all();
  const insertRolePermissionById = db.prepare(
    'INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
  );

  for (const role of ROLES) {
    const result = insertRole.run(
      role.name,
      role.labelEn,
      role.labelBn,
      role.description,
      role.name === 'owner' ? 1 : 0,
    );
    const roleId = Number(result.lastInsertRowid);
    if (role.permissions === '*') {
      for (const row of allPermissionIds) insertRolePermissionById.run(roleId, row.id);
    } else {
      for (const code of role.permissions) {
        if (!findPermission.get(code)) throw new Error(`Unknown permission code in role seed: ${code}`);
        insertRolePermission.run(roleId, code);
      }
    }
  }

  // ---------------------------------------------------------------- odontogram
  const insertCondition = db.prepare(
    'INSERT INTO tooth_conditions (code, label_en, label_bn, category, color, symbol, is_system, sort_order) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
  );
  for (const c of TOOTH_CONDITIONS) insertCondition.run(c[0], c[1], c[2], c[3], c[4], c[5], c[6]);

  // ------------------------------------------- clinic-scoped seed template
  // Templates are stored in `resources/clinic-defaults.json` and applied when the
  // first-run wizard creates the clinic, so no clinic-scoped rows are invented here.
  db.exec(`
    CREATE TABLE clinic_provisioning_templates (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      key        TEXT NOT NULL UNIQUE,
      payload    TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (${now})
    );
  `);
  const insertTemplate = db.prepare('INSERT INTO clinic_provisioning_templates (key, payload) VALUES (?, ?)');
  insertTemplate.run(
    'defaults',
    JSON.stringify({
      expenseCategories: EXPENSE_CATEGORIES.map(([en, bn, order, isSystem], index) => ({
        name_en: en,
        name_bn: bn,
        sort_order: order,
        is_system: isSystem,
        code: `expense_${index + 1}`,
      })),
      incomeCategories: INCOME_CATEGORIES.map(([en, bn, order, isSystem], index) => ({
        name_en: en,
        name_bn: bn,
        sort_order: order,
        is_system: isSystem,
        code: `income_${index + 1}`,
      })),
      appointmentTypes: APPOINTMENT_TYPES.map(([en, bn, minutes, color, order]) => ({
        name_en: en,
        name_bn: bn,
        duration_minutes: minutes,
        color,
        sort_order: order,
      })),
      inventoryCategories: INVENTORY_CATEGORIES.map(([en, bn, order]) => ({
        name_en: en,
        name_bn: bn,
        sort_order: order,
      })),
      paymentMethods: [
        { code: 'cash', name_en: 'Cash', name_bn: 'নগদ', requires_reference: 0, is_system: 1, sort_order: 10 },
        { code: 'bank', name_en: 'Bank transfer', name_bn: 'ব্যাংক ট্রান্সফার', requires_reference: 1, is_system: 1, sort_order: 20 },
        { code: 'card', name_en: 'Card', name_bn: 'কার্ড', requires_reference: 1, is_system: 1, sort_order: 30 },
        { code: 'mfs', name_en: 'Mobile financial service', name_bn: 'মোবাইল ফিন্যান্সিয়াল সার্ভিস', requires_reference: 1, is_system: 1, sort_order: 40 },
        { code: 'other', name_en: 'Other', name_bn: 'অন্যান্য', requires_reference: 0, is_system: 1, sort_order: 50 },
      ],
      diagnoses: [],
      services: [],
    }),
  );
}
