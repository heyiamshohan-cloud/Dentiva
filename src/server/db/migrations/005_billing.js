/**
 * Migration 005 — billing: invoices, invoice items, payment methods, payments,
 * refunds and the patient credit ledger.
 *
 * Invariants enforced by the application layer and verified by SQL checks:
 *   subtotal = Σ line_subtotal,  total = subtotal - discount + tax,
 *   due     = total - paid,      paid  = Σ payments(kind='payment') - refunds.
 */
export const id = 5;
export const name = 'billing';

const TS = `TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export function up(db) {
  db.exec(`
    CREATE TABLE payment_methods (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id    INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      code         TEXT    NOT NULL,
      name_en      TEXT    NOT NULL,
      name_bn      TEXT,
      requires_reference INTEGER NOT NULL DEFAULT 0 CHECK (requires_reference IN (0,1)),
      is_system    INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
      is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_at   ${TS},
      updated_at   ${TS},
      deleted_at   TEXT
    );
    CREATE UNIQUE INDEX ux_payment_methods_code ON payment_methods(clinic_id, code) WHERE deleted_at IS NULL;

    CREATE TABLE invoices (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id       INTEGER NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
      patient_id      INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
      visit_id        INTEGER REFERENCES visits(id) ON DELETE SET NULL,
      plan_id         INTEGER REFERENCES treatment_plans(id) ON DELETE SET NULL,
      invoice_number  TEXT    NOT NULL,
      invoice_date    TEXT    NOT NULL,
      due_date        TEXT,
      status          TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','void')),
      subtotal_minor  INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
      discount_minor  INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
      tax_minor       INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
      total_minor     INTEGER NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
      paid_minor      INTEGER NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
      due_minor       INTEGER NOT NULL DEFAULT 0,
      round_off_minor INTEGER NOT NULL DEFAULT 0,
      notes           TEXT,
      footer_text     TEXT,
      terms           TEXT,
      issued_at       TEXT,
      voided_at       TEXT,
      void_reason     TEXT,
      voided_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      printed_count   INTEGER NOT NULL DEFAULT 0,
      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      ${TS},
      updated_at      ${TS},
      deleted_at      TEXT
    );
    CREATE UNIQUE INDEX ux_invoices_number ON invoices(clinic_id, invoice_number);
    CREATE INDEX ix_invoices_patient ON invoices(patient_id, invoice_date DESC);
    CREATE INDEX ix_invoices_status ON invoices(clinic_id, status, invoice_date DESC);
    CREATE INDEX ix_invoices_due ON invoices(clinic_id, due_minor) WHERE status = 'issued';
    CREATE INDEX ix_invoices_date ON invoices(clinic_id, invoice_date DESC);

    CREATE TABLE invoice_items (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id        INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      service_id        INTEGER REFERENCES services(id) ON DELETE SET NULL,
      treatment_id      INTEGER REFERENCES treatments(id) ON DELETE SET NULL,
      description       TEXT    NOT NULL,
      tooth_codes       TEXT    NOT NULL DEFAULT '[]',
      quantity_milli    INTEGER NOT NULL DEFAULT 1000 CHECK (quantity_milli > 0),
      unit_price_minor  INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_minor >= 0),
      discount_type     TEXT    NOT NULL DEFAULT 'amount' CHECK (discount_type IN ('amount','percent')),
      discount_value    INTEGER NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
      discount_minor    INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
      tax_rate_bp       INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
      tax_minor         INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
      line_subtotal_minor INTEGER NOT NULL DEFAULT 0 CHECK (line_subtotal_minor >= 0),
      line_total_minor  INTEGER NOT NULL DEFAULT 0 CHECK (line_total_minor >= 0),
      sort_order        INTEGER NOT NULL DEFAULT 0,
      notes             TEXT,
      created_at        ${TS},
      updated_at        ${TS}
    );
    CREATE INDEX ix_invoice_items_invoice ON invoice_items(invoice_id, sort_order);
    CREATE INDEX ix_invoice_items_treatment ON invoice_items(treatment_id);

    CREATE TABLE payments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id       INTEGER NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
      patient_id      INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
      invoice_id      INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
      visit_id        INTEGER REFERENCES visits(id) ON DELETE SET NULL,
      receipt_number  TEXT    NOT NULL,
      payment_date    TEXT    NOT NULL,
      kind            TEXT    NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment','refund','credit_used')),
      amount_minor    INTEGER NOT NULL CHECK (amount_minor >= 0),
      method_id       INTEGER REFERENCES payment_methods(id) ON DELETE SET NULL,
      method_code     TEXT    NOT NULL DEFAULT 'cash',
      reference_no    TEXT,
      notes           TEXT,
      refund_of_id    INTEGER REFERENCES payments(id) ON DELETE SET NULL,
      refund_reason   TEXT,
      credit_applied_minor INTEGER NOT NULL DEFAULT 0 CHECK (credit_applied_minor >= 0),
      printed_count   INTEGER NOT NULL DEFAULT 0,
      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      ${TS},
      updated_at      ${TS},
      voided_at       TEXT,
      void_reason     TEXT,
      voided_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      deleted_at      TEXT
    );
    CREATE UNIQUE INDEX ux_payments_receipt ON payments(clinic_id, receipt_number);
    CREATE INDEX ix_payments_patient ON payments(patient_id, payment_date DESC);
    CREATE INDEX ix_payments_invoice ON payments(invoice_id);
    CREATE INDEX ix_payments_date ON payments(clinic_id, payment_date DESC);
    CREATE INDEX ix_payments_method ON payments(clinic_id, method_code, payment_date);
    CREATE INDEX ix_payments_kind ON payments(clinic_id, kind, payment_date);

    CREATE TABLE patient_credits (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id     INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      patient_id    INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      entry_date    TEXT    NOT NULL,
      kind          TEXT    NOT NULL CHECK (kind IN ('overpayment','used','refunded','adjustment','reversal')),
      amount_minor  INTEGER NOT NULL,
      balance_after_minor INTEGER NOT NULL DEFAULT 0,
      payment_id    INTEGER REFERENCES payments(id) ON DELETE SET NULL,
      invoice_id    INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
      note          TEXT,
      created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    ${TS}
    );
    CREATE INDEX ix_credits_patient ON patient_credits(patient_id, created_at DESC);

    -- Receipts / expenses may carry scanned proof documents.
    ALTER TABLE attachments ADD COLUMN payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL;
    ALTER TABLE attachments ADD COLUMN invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL;
    CREATE INDEX ix_attachments_payment ON attachments(payment_id);
    CREATE INDEX ix_attachments_invoice ON attachments(invoice_id);
  `);
}
