/**
 * Migration 006 — finance (income/expense ledgers), staff & payroll and
 * inventory/suppliers with a full stock movement trail.
 */
export const id = 6;
export const name = 'finance_staff_inventory';

const TS = `TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export function up(db) {
  db.exec(`
    ---------------------------------------------------------------- staff
    CREATE TABLE staff (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id      INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      staff_code     TEXT    NOT NULL,
      full_name      TEXT    NOT NULL,
      role_title     TEXT    NOT NULL DEFAULT 'staff',
      designation    TEXT,
      specialty      TEXT,
      qualification  TEXT,
      registration_no TEXT,
      responsibilities TEXT,
      phone          TEXT,
      email          TEXT,
      address        TEXT,
      joining_date   TEXT,
      leaving_date   TEXT,
      salary_minor   INTEGER NOT NULL DEFAULT 0 CHECK (salary_minor >= 0),
      salary_type    TEXT    NOT NULL DEFAULT 'monthly' CHECK (salary_type IN ('monthly','daily','hourly','contract')),
      status         TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','suspended','left')),
      is_practitioner INTEGER NOT NULL DEFAULT 0 CHECK (is_practitioner IN (0,1)),
      photo_attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
      signature_attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
      color          TEXT    NOT NULL DEFAULT '#0f6f9a',
      user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      notes          TEXT,
      created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at     ${TS},
      updated_at     ${TS},
      deleted_at     TEXT
    );
    CREATE UNIQUE INDEX ux_staff_code ON staff(clinic_id, staff_code);
    CREATE INDEX ix_staff_status ON staff(clinic_id, status, deleted_at);
    CREATE INDEX ix_staff_practitioner ON staff(clinic_id, is_practitioner, status);

    CREATE TABLE payroll (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id      INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      staff_id       INTEGER NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
      period_start   TEXT    NOT NULL,
      period_end     TEXT    NOT NULL,
      gross_minor    INTEGER NOT NULL DEFAULT 0 CHECK (gross_minor >= 0),
      deduction_minor INTEGER NOT NULL DEFAULT 0 CHECK (deduction_minor >= 0),
      net_minor      INTEGER NOT NULL DEFAULT 0 CHECK (net_minor >= 0),
      paid_minor     INTEGER NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
      status         TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','partial','paid','cancelled')),
      paid_on        TEXT,
      method_code    TEXT,
      notes          TEXT,
      expense_id     INTEGER,
      created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at     ${TS},
      updated_at     ${TS}
    );
    CREATE INDEX ix_payroll_staff ON payroll(staff_id, period_start DESC);
    CREATE INDEX ix_payroll_period ON payroll(clinic_id, period_start DESC, status);
    CREATE UNIQUE INDEX ux_payroll_period ON payroll(clinic_id, staff_id, period_start, period_end);

    CREATE TABLE payroll_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      payroll_id  INTEGER NOT NULL REFERENCES payroll(id) ON DELETE CASCADE,
      kind        TEXT    NOT NULL CHECK (kind IN ('earning','deduction')),
      label       TEXT    NOT NULL,
      amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
      sort_order  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX ix_payroll_items ON payroll_items(payroll_id, sort_order);

    ---------------------------------------------------------------- suppliers
    CREATE TABLE suppliers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id     INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      name          TEXT    NOT NULL,
      contact_person TEXT,
      phone         TEXT,
      email         TEXT,
      address       TEXT,
      products      TEXT,
      payment_terms TEXT,
      notes         TEXT,
      is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
      created_at    ${TS},
      updated_at    ${TS},
      deleted_at    TEXT
    );
    CREATE INDEX ix_suppliers_name ON suppliers(clinic_id, name COLLATE NOCASE);

    ---------------------------------------------------------------- inventory
    CREATE TABLE inventory_categories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id  INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      name_en    TEXT    NOT NULL,
      name_bn    TEXT,
      is_system  INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
      is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at ${TS},
      updated_at ${TS},
      deleted_at TEXT
    );
    CREATE INDEX ix_inv_categories ON inventory_categories(clinic_id, is_active, sort_order);

    CREATE TABLE inventory_items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id       INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      sku             TEXT,
      name            TEXT    NOT NULL,
      category_id     INTEGER REFERENCES inventory_categories(id) ON DELETE SET NULL,
      unit            TEXT    NOT NULL DEFAULT 'pcs',
      quantity_milli  INTEGER NOT NULL DEFAULT 0,
      min_stock_milli INTEGER NOT NULL DEFAULT 0 CHECK (min_stock_milli >= 0),
      purchase_price_minor INTEGER NOT NULL DEFAULT 0 CHECK (purchase_price_minor >= 0),
      sale_price_minor INTEGER NOT NULL DEFAULT 0 CHECK (sale_price_minor >= 0),
      supplier_id     INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
      batch_no        TEXT,
      expiry_date     TEXT,
      storage_location TEXT,
      condition       TEXT NOT NULL DEFAULT 'good' CHECK (condition IN ('good','near_expiry','expired','damaged')),
      is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
      notes           TEXT,
      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      ${TS},
      updated_at      ${TS},
      deleted_at      TEXT
    );
    CREATE UNIQUE INDEX ux_inventory_sku ON inventory_items(clinic_id, sku) WHERE sku IS NOT NULL AND deleted_at IS NULL;
    CREATE INDEX ix_inventory_name ON inventory_items(clinic_id, name COLLATE NOCASE);
    CREATE INDEX ix_inventory_expiry ON inventory_items(clinic_id, expiry_date) WHERE is_active = 1;
    CREATE INDEX ix_inventory_low ON inventory_items(clinic_id, quantity_milli, min_stock_milli) WHERE is_active = 1;

    CREATE TABLE stock_movements (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id      INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      item_id        INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      movement_date  TEXT    NOT NULL,
      kind           TEXT    NOT NULL CHECK (kind IN ('in','out','adjustment','disposal','return')),
      quantity_milli INTEGER NOT NULL,
      balance_after_milli INTEGER NOT NULL DEFAULT 0,
      unit_cost_minor INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_minor >= 0),
      reason         TEXT,
      reference_no   TEXT,
      supplier_id    INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
      patient_id     INTEGER REFERENCES patients(id) ON DELETE SET NULL,
      treatment_id   INTEGER REFERENCES treatments(id) ON DELETE SET NULL,
      batch_no       TEXT,
      expiry_date    TEXT,
      notes          TEXT,
      created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at     ${TS}
    );
    CREATE INDEX ix_stock_item ON stock_movements(item_id, movement_date DESC);
    CREATE INDEX ix_stock_date ON stock_movements(clinic_id, movement_date DESC);
    CREATE INDEX ix_stock_kind ON stock_movements(clinic_id, kind, movement_date DESC);

    ---------------------------------------------------------------- finance
    CREATE TABLE income_categories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id  INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      name_en    TEXT    NOT NULL,
      name_bn    TEXT,
      is_system  INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
      is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at ${TS},
      updated_at ${TS},
      deleted_at TEXT
    );
    CREATE INDEX ix_income_categories ON income_categories(clinic_id, is_active, sort_order);

    CREATE TABLE expense_categories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id  INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      name_en    TEXT    NOT NULL,
      name_bn    TEXT,
      is_system  INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
      is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at ${TS},
      updated_at ${TS},
      deleted_at TEXT
    );
    CREATE INDEX ix_expense_categories ON expense_categories(clinic_id, is_active, sort_order);

    CREATE TABLE incomes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id    INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      income_date  TEXT    NOT NULL,
      category_id  INTEGER REFERENCES income_categories(id) ON DELETE SET NULL,
      source       TEXT    NOT NULL DEFAULT 'other'
                     CHECK (source IN ('treatment','consultation','other','collection')),
      patient_id   INTEGER REFERENCES patients(id) ON DELETE SET NULL,
      invoice_id   INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
      payment_id   INTEGER REFERENCES payments(id) ON DELETE CASCADE,
      amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
      method_code  TEXT    NOT NULL DEFAULT 'cash',
      reference_no TEXT,
      description  TEXT,
      notes        TEXT,
      is_reversed  INTEGER NOT NULL DEFAULT 0 CHECK (is_reversed IN (0,1)),
      created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   ${TS},
      updated_at   ${TS},
      deleted_at   TEXT
    );
    CREATE UNIQUE INDEX ux_incomes_payment ON incomes(payment_id) WHERE payment_id IS NOT NULL;
    CREATE INDEX ix_incomes_date ON incomes(clinic_id, income_date DESC);
    CREATE INDEX ix_incomes_category ON incomes(clinic_id, category_id, income_date DESC);
    CREATE INDEX ix_incomes_source ON incomes(clinic_id, source, income_date DESC);

    CREATE TABLE expenses (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id    INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      expense_date TEXT    NOT NULL,
      category_id  INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL,
      payee        TEXT,
      amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
      method_code  TEXT    NOT NULL DEFAULT 'cash',
      reference_no TEXT,
      supplier_id  INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
      staff_id     INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
      description  TEXT,
      notes        TEXT,
      is_recurring INTEGER NOT NULL DEFAULT 0 CHECK (is_recurring IN (0,1)),
      recurrence   TEXT,
      created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   ${TS},
      updated_at   ${TS},
      deleted_at   TEXT
    );
    CREATE INDEX ix_expenses_date ON expenses(clinic_id, expense_date DESC);
    CREATE INDEX ix_expenses_category ON expenses(clinic_id, category_id, expense_date DESC);
    CREATE INDEX ix_expenses_supplier ON expenses(supplier_id, expense_date DESC);

    ALTER TABLE attachments ADD COLUMN expense_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL;
    CREATE INDEX ix_attachments_expense ON attachments(expense_id);
  `);
}
