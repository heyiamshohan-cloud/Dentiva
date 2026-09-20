/**
 * Migration 003 — clinical core: services, visits, odontogram, treatments,
 * treatment plans, prescriptions, referrals and the attachment store.
 */
export const id = 3;
export const name = 'clinical';

const TS = `TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export function up(db) {
  db.exec(`
    ---------------------------------------------------------------- catalogue
    CREATE TABLE services (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id     INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      code          TEXT,
      name_en       TEXT    NOT NULL,
      name_bn       TEXT,
      category      TEXT    NOT NULL DEFAULT 'general',
      description   TEXT,
      default_price_minor INTEGER NOT NULL DEFAULT 0 CHECK (default_price_minor >= 0),
      tax_rate_bp   INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
      unit          TEXT    NOT NULL DEFAULT 'session',
      is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
      sort_order    INTEGER NOT NULL DEFAULT 0,
      created_at    ${TS},
      updated_at    ${TS},
      deleted_at    TEXT
    );
    CREATE INDEX ix_services_clinic ON services(clinic_id, is_active, sort_order);
    CREATE UNIQUE INDEX ux_services_code ON services(clinic_id, code) WHERE code IS NOT NULL AND deleted_at IS NULL;

    CREATE TABLE diagnoses (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id  INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      code       TEXT,
      label_en   TEXT    NOT NULL,
      label_bn   TEXT,
      category   TEXT    NOT NULL DEFAULT 'general',
      is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
      use_count  INTEGER NOT NULL DEFAULT 0,
      created_at ${TS},
      deleted_at TEXT
    );
    CREATE INDEX ix_diagnoses_lookup ON diagnoses(clinic_id, is_active, label_en);

    CREATE TABLE tooth_conditions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT    NOT NULL UNIQUE,
      label_en   TEXT    NOT NULL,
      label_bn   TEXT    NOT NULL,
      category   TEXT    NOT NULL DEFAULT 'finding',
      color      TEXT    NOT NULL DEFAULT '#94a3b8',
      symbol     TEXT,
      is_system  INTEGER NOT NULL DEFAULT 1 CHECK (is_system IN (0,1)),
      is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    ---------------------------------------------------------------- visits
    CREATE TABLE visits (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id      INTEGER NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
      patient_id     INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
      visit_code     TEXT    NOT NULL,
      visit_date     TEXT    NOT NULL,
      visit_time     TEXT,
      practitioner_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      appointment_id INTEGER,
      chief_complaint TEXT,
      reason         TEXT,
      symptoms       TEXT,
      examination    TEXT,
      diagnosis      TEXT,
      procedure_summary TEXT,
      materials      TEXT,
      medication     TEXT,
      instructions   TEXT,
      followup_date  TEXT,
      clinical_notes TEXT,
      status         TEXT    NOT NULL DEFAULT 'completed' CHECK (status IN ('open','in_progress','completed','cancelled')),
      created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at     ${TS},
      updated_at     ${TS},
      deleted_at     TEXT
    );
    CREATE UNIQUE INDEX ux_visits_code ON visits(clinic_id, visit_code);
    CREATE INDEX ix_visits_patient ON visits(patient_id, visit_date DESC);
    CREATE INDEX ix_visits_date ON visits(clinic_id, visit_date DESC);
    CREATE INDEX ix_visits_followup ON visits(clinic_id, followup_date);

    CREATE TABLE visit_diagnoses (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_id    INTEGER NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
      diagnosis_id INTEGER REFERENCES diagnoses(id) ON DELETE SET NULL,
      label       TEXT    NOT NULL,
      tooth_codes TEXT    NOT NULL DEFAULT '[]',
      notes       TEXT,
      created_at  ${TS}
    );
    CREATE INDEX ix_visit_diagnoses_visit ON visit_diagnoses(visit_id);

    ---------------------------------------------------------------- odontogram
    CREATE TABLE dental_chart_entries (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id      INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      patient_id     INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      tooth_code     TEXT    NOT NULL,
      dentition      TEXT    NOT NULL DEFAULT 'adult' CHECK (dentition IN ('adult','primary')),
      condition_code TEXT    NOT NULL REFERENCES tooth_conditions(code) ON UPDATE CASCADE,
      surfaces       TEXT    NOT NULL DEFAULT '[]',
      status         TEXT    NOT NULL DEFAULT 'existing' CHECK (status IN ('existing','planned','completed')),
      visit_id       INTEGER REFERENCES visits(id) ON DELETE SET NULL,
      treatment_id   INTEGER,
      notes          TEXT,
      is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
      recorded_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      recorded_at    ${TS},
      cleared_at     TEXT,
      cleared_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX ix_chart_patient ON dental_chart_entries(patient_id, is_active, dentition);
    CREATE INDEX ix_chart_tooth ON dental_chart_entries(patient_id, tooth_code, is_active);

    ---------------------------------------------------------------- treatments
    CREATE TABLE treatment_plans (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id       INTEGER NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
      patient_id      INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
      plan_code       TEXT    NOT NULL,
      title           TEXT    NOT NULL,
      diagnosis       TEXT,
      practitioner_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      proposed_date   TEXT,
      status          TEXT    NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','proposed','accepted','in_progress','partially_completed','completed','cancelled')),
      subtotal_minor  INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
      discount_minor  INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
      tax_minor       INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
      total_minor     INTEGER NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
      discount_type   TEXT    NOT NULL DEFAULT 'amount' CHECK (discount_type IN ('amount','percent')),
      discount_value  INTEGER NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
      notes           TEXT,
      accepted_at     TEXT,
      completed_at    TEXT,
      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      ${TS},
      updated_at      ${TS},
      deleted_at      TEXT
    );
    CREATE UNIQUE INDEX ux_plans_code ON treatment_plans(clinic_id, plan_code);
    CREATE INDEX ix_plans_patient ON treatment_plans(patient_id, created_at DESC);
    CREATE INDEX ix_plans_status ON treatment_plans(clinic_id, status);

    CREATE TABLE treatment_plan_items (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id           INTEGER NOT NULL REFERENCES treatment_plans(id) ON DELETE CASCADE,
      service_id        INTEGER REFERENCES services(id) ON DELETE SET NULL,
      name              TEXT    NOT NULL,
      tooth_codes       TEXT    NOT NULL DEFAULT '[]',
      stage             TEXT,
      quantity_milli    INTEGER NOT NULL DEFAULT 1000 CHECK (quantity_milli >= 0),
      unit_price_minor  INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_minor >= 0),
      discount_minor    INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
      tax_rate_bp       INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
      tax_minor         INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
      line_total_minor  INTEGER NOT NULL DEFAULT 0 CHECK (line_total_minor >= 0),
      status            TEXT    NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','in_progress','completed','cancelled')),
      completed_at      TEXT,
      treatment_id      INTEGER,
      notes             TEXT,
      sort_order        INTEGER NOT NULL DEFAULT 0,
      created_at        ${TS},
      updated_at        ${TS}
    );
    CREATE INDEX ix_plan_items_plan ON treatment_plan_items(plan_id, sort_order);

    CREATE TABLE treatments (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id        INTEGER NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
      patient_id       INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
      visit_id         INTEGER REFERENCES visits(id) ON DELETE SET NULL,
      plan_id          INTEGER REFERENCES treatment_plans(id) ON DELETE SET NULL,
      plan_item_id     INTEGER REFERENCES treatment_plan_items(id) ON DELETE SET NULL,
      service_id       INTEGER REFERENCES services(id) ON DELETE SET NULL,
      name             TEXT    NOT NULL,
      tooth_codes      TEXT    NOT NULL DEFAULT '[]',
      treatment_date   TEXT    NOT NULL,
      practitioner_id  INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      anesthesia       TEXT,
      materials        TEXT,
      notes            TEXT,
      status           TEXT    NOT NULL DEFAULT 'completed'
                         CHECK (status IN ('planned','in_progress','completed','cancelled')),
      fee_minor        INTEGER NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
      discount_minor   INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
      tax_minor        INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
      total_minor      INTEGER NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
      invoice_id       INTEGER,
      created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at       ${TS},
      updated_at       ${TS},
      deleted_at       TEXT
    );
    CREATE INDEX ix_treatments_patient ON treatments(patient_id, treatment_date DESC);
    CREATE INDEX ix_treatments_visit ON treatments(visit_id);
    CREATE INDEX ix_treatments_plan ON treatments(plan_id);
    CREATE INDEX ix_treatments_date ON treatments(clinic_id, treatment_date DESC);
    CREATE INDEX ix_treatments_unbilled ON treatments(clinic_id, invoice_id, status);

    ---------------------------------------------------------------- prescriptions
    CREATE TABLE prescription_templates (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id  INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      name       TEXT    NOT NULL,
      diagnosis  TEXT,
      notes      TEXT,
      items_json TEXT    NOT NULL DEFAULT '[]',
      is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
      use_count  INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at ${TS},
      updated_at ${TS},
      deleted_at TEXT
    );
    CREATE INDEX ix_rx_templates_clinic ON prescription_templates(clinic_id, is_active, name);

    CREATE TABLE prescriptions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id         INTEGER NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
      patient_id        INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
      visit_id          INTEGER REFERENCES visits(id) ON DELETE SET NULL,
      practitioner_id   INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      template_id       INTEGER REFERENCES prescription_templates(id) ON DELETE SET NULL,
      rx_code           TEXT    NOT NULL,
      rx_date           TEXT    NOT NULL,
      diagnosis         TEXT,
      advice            TEXT,
      followup_date     TEXT,
      notes             TEXT,
      printed_count     INTEGER NOT NULL DEFAULT 0,
      created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at        ${TS},
      updated_at        ${TS},
      deleted_at        TEXT
    );
    CREATE UNIQUE INDEX ux_rx_code ON prescriptions(clinic_id, rx_code);
    CREATE INDEX ix_rx_patient ON prescriptions(patient_id, rx_date DESC);

    CREATE TABLE prescription_items (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      prescription_id INTEGER NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
      medication   TEXT    NOT NULL,
      strength     TEXT,
      form         TEXT,
      dose         TEXT,
      frequency    TEXT,
      duration     TEXT,
      route        TEXT,
      timing       TEXT,
      quantity     TEXT,
      instructions TEXT,
      notes        TEXT,
      sort_order   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX ix_rx_items_rx ON prescription_items(prescription_id, sort_order);

    ---------------------------------------------------------------- referrals
    CREATE TABLE referrals (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id             INTEGER NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
      patient_id            INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
      visit_id              INTEGER REFERENCES visits(id) ON DELETE SET NULL,
      plan_id               INTEGER REFERENCES treatment_plans(id) ON DELETE SET NULL,
      referral_code         TEXT    NOT NULL,
      referral_date         TEXT    NOT NULL,
      practitioner_id       INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      provider_name         TEXT    NOT NULL,
      provider_title        TEXT,
      specialty             TEXT,
      institution           TEXT,
      provider_phone        TEXT,
      provider_email        TEXT,
      provider_address      TEXT,
      reason                TEXT    NOT NULL,
      clinical_context      TEXT,
      instructions          TEXT,
      status                TEXT    NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft','referred','awaiting_response','report_received','completed','cancelled')),
      sent_on               TEXT,
      followup_date         TEXT,
      outcome               TEXT,
      outcome_notes         TEXT,
      external_treatment_summary TEXT,
      returned_report_attachment_id INTEGER,
      notes                 TEXT,
      completed_at          TEXT,
      created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at            ${TS},
      updated_at            ${TS},
      deleted_at            TEXT
    );
    CREATE UNIQUE INDEX ux_referrals_code ON referrals(clinic_id, referral_code);
    CREATE INDEX ix_referrals_patient ON referrals(patient_id, referral_date DESC);
    CREATE INDEX ix_referrals_status ON referrals(clinic_id, status);
    CREATE INDEX ix_referrals_provider ON referrals(clinic_id, provider_name COLLATE NOCASE);
    CREATE INDEX ix_referrals_specialty ON referrals(clinic_id, specialty COLLATE NOCASE);

    ---------------------------------------------------------------- attachments
    CREATE TABLE attachments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id     INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      patient_id    INTEGER REFERENCES patients(id) ON DELETE CASCADE,
      visit_id      INTEGER REFERENCES visits(id) ON DELETE SET NULL,
      treatment_id  INTEGER REFERENCES treatments(id) ON DELETE SET NULL,
      plan_id       INTEGER REFERENCES treatment_plans(id) ON DELETE SET NULL,
      referral_id   INTEGER REFERENCES referrals(id) ON DELETE CASCADE,
      prescription_id INTEGER REFERENCES prescriptions(id) ON DELETE SET NULL,
      category      TEXT    NOT NULL DEFAULT 'other'
                      CHECK (category IN ('radiograph','photo','report','scan','lab','consent','referral','other')),
      title         TEXT,
      description   TEXT,
      original_name TEXT    NOT NULL,
      stored_name   TEXT    NOT NULL,
      rel_path      TEXT    NOT NULL,
      extension     TEXT    NOT NULL,
      mime_type     TEXT    NOT NULL DEFAULT 'application/octet-stream',
      size_bytes    INTEGER NOT NULL CHECK (size_bytes >= 0),
      sha256        TEXT    NOT NULL,
      captured_on   TEXT,
      is_archived   INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
      uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    ${TS},
      updated_at    ${TS},
      deleted_at    TEXT,
      deleted_by    INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX ix_attachments_patient ON attachments(patient_id, created_at DESC);
    CREATE INDEX ix_attachments_referral ON attachments(referral_id);
    CREATE INDEX ix_attachments_visit ON attachments(visit_id);
    CREATE INDEX ix_attachments_hash ON attachments(sha256);
    CREATE UNIQUE INDEX ux_attachments_stored ON attachments(clinic_id, stored_name) WHERE deleted_at IS NULL;
  `);
}
