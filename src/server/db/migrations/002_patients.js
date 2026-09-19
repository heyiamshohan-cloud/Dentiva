/**
 * Migration 002 — patient identity, contacts, medical and dental background.
 *
 * Patients are soft-deleted (archived) rather than removed: clinical and
 * financial history must stay referentially intact (§ 70).
 */
export const id = 2;
export const name = 'patients';

const TS = `TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export function up(db) {
  db.exec(`
    CREATE TABLE patients (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id             INTEGER NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
      patient_code          TEXT    NOT NULL,
      full_name             TEXT    NOT NULL,
      preferred_name        TEXT,
      gender                TEXT    NOT NULL CHECK (gender IN ('male','female','other','unspecified')),
      dob                   TEXT,
      age_estimated         INTEGER CHECK (age_estimated IS NULL OR (age_estimated >= 0 AND age_estimated <= 130)),
      phone                 TEXT,
      phone_alt             TEXT,
      email                 TEXT,
      address               TEXT,
      city                  TEXT,
      postal_code           TEXT,
      national_id           TEXT,
      occupation            TEXT,
      blood_group           TEXT,
      emergency_name        TEXT,
      emergency_relation    TEXT,
      emergency_phone       TEXT,
      referrer_source       TEXT,
      status                TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
      communication_prefs   TEXT    NOT NULL DEFAULT '{}',
      photo_attachment_id   INTEGER,
      notes                 TEXT,
      registered_on         TEXT,
      last_visit_on         TEXT,
      created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at            ${TS},
      updated_at            ${TS},
      deleted_at            TEXT,
      deleted_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
      delete_reason         TEXT
    );
    CREATE UNIQUE INDEX ux_patients_code ON patients(clinic_id, patient_code);
    CREATE INDEX ix_patients_name ON patients(clinic_id, full_name COLLATE NOCASE);
    CREATE INDEX ix_patients_phone ON patients(phone);
    CREATE INDEX ix_patients_status ON patients(clinic_id, status, deleted_at);
    CREATE INDEX ix_patients_created ON patients(clinic_id, created_at DESC);
    CREATE INDEX ix_patients_last_visit ON patients(clinic_id, last_visit_on DESC);

    CREATE TABLE patient_contacts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      kind       TEXT    NOT NULL DEFAULT 'other'
                   CHECK (kind IN ('primary','emergency','guardian','insurance','employer','other')),
      name       TEXT    NOT NULL,
      relation   TEXT,
      phone      TEXT,
      email      TEXT,
      address    TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
      notes      TEXT,
      created_at ${TS},
      updated_at ${TS}
    );
    CREATE INDEX ix_patient_contacts_patient ON patient_contacts(patient_id, kind);

    CREATE TABLE patient_medical (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id           INTEGER NOT NULL UNIQUE REFERENCES patients(id) ON DELETE CASCADE,
      allergies            TEXT,
      medical_history      TEXT,
      current_medications  TEXT,
      conditions           TEXT,
      previous_surgery     TEXT,
      family_history       TEXT,
      notes                TEXT,
      has_diabetes         INTEGER NOT NULL DEFAULT 0 CHECK (has_diabetes IN (0,1)),
      has_hypertension     INTEGER NOT NULL DEFAULT 0 CHECK (has_hypertension IN (0,1)),
      has_heart_disease    INTEGER NOT NULL DEFAULT 0 CHECK (has_heart_disease IN (0,1)),
      has_asthma           INTEGER NOT NULL DEFAULT 0 CHECK (has_asthma IN (0,1)),
      has_bleeding_disorder INTEGER NOT NULL DEFAULT 0 CHECK (has_bleeding_disorder IN (0,1)),
      is_pregnant          INTEGER NOT NULL DEFAULT 0 CHECK (is_pregnant IN (0,1)),
      is_smoker            INTEGER NOT NULL DEFAULT 0 CHECK (is_smoker IN (0,1)),
      takes_anticoagulant  INTEGER NOT NULL DEFAULT 0 CHECK (takes_anticoagulant IN (0,1)),
      has_hepatitis        INTEGER NOT NULL DEFAULT 0 CHECK (has_hepatitis IN (0,1)),
      has_kidney_disease   INTEGER NOT NULL DEFAULT 0 CHECK (has_kidney_disease IN (0,1)),
      has_thyroid_disorder INTEGER NOT NULL DEFAULT 0 CHECK (has_thyroid_disorder IN (0,1)),
      alert_flag           INTEGER NOT NULL DEFAULT 0 CHECK (alert_flag IN (0,1)),
      updated_at           ${TS}
    );

    CREATE TABLE patient_dental (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id            INTEGER NOT NULL UNIQUE REFERENCES patients(id) ON DELETE CASCADE,
      dental_history        TEXT,
      oral_hygiene          TEXT CHECK (oral_hygiene IS NULL OR oral_hygiene IN ('good','fair','poor')),
      brushing_frequency    TEXT,
      uses_floss            INTEGER NOT NULL DEFAULT 0 CHECK (uses_floss IN (0,1)),
      uses_mouthwash        INTEGER NOT NULL DEFAULT 0 CHECK (uses_mouthwash IN (0,1)),
      has_braces            INTEGER NOT NULL DEFAULT 0 CHECK (has_braces IN (0,1)),
      had_orthodontics      INTEGER NOT NULL DEFAULT 0 CHECK (had_orthodontics IN (0,1)),
      had_implant           INTEGER NOT NULL DEFAULT 0 CHECK (had_implant IN (0,1)),
      has_partial_denture   INTEGER NOT NULL DEFAULT 0 CHECK (has_partial_denture IN (0,1)),
      has_full_denture      INTEGER NOT NULL DEFAULT 0 CHECK (has_full_denture IN (0,1)),
      grinds_teeth          INTEGER NOT NULL DEFAULT 0 CHECK (grinds_teeth IN (0,1)),
      sensitive_teeth       INTEGER NOT NULL DEFAULT 0 CHECK (sensitive_teeth IN (0,1)),
      habits_tobacco        INTEGER NOT NULL DEFAULT 0 CHECK (habits_tobacco IN (0,1)),
      habits_betel          INTEGER NOT NULL DEFAULT 0 CHECK (habits_betel IN (0,1)),
      habits_alcohol        INTEGER NOT NULL DEFAULT 0 CHECK (habits_alcohol IN (0,1)),
      notes                 TEXT,
      updated_at            ${TS}
    );

    CREATE TABLE patient_notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      note       TEXT    NOT NULL,
      category   TEXT    NOT NULL DEFAULT 'general'
                   CHECK (category IN ('general','clinical','administrative','billing','followup')),
      is_pinned  INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0,1)),
      visit_id   INTEGER,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at ${TS},
      updated_at ${TS},
      deleted_at TEXT
    );
    CREATE INDEX ix_patient_notes_patient ON patient_notes(patient_id, created_at DESC);

    CREATE TABLE patient_custom_fields (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id  INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      field_key  TEXT    NOT NULL,
      label_en   TEXT    NOT NULL,
      label_bn   TEXT    NOT NULL,
      field_type TEXT    NOT NULL DEFAULT 'text' CHECK (field_type IN ('text','number','date','select','checkbox')),
      options    TEXT    NOT NULL DEFAULT '[]',
      section    TEXT    NOT NULL DEFAULT 'general',
      is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0,1)),
      is_required INTEGER NOT NULL DEFAULT 0 CHECK (is_required IN (0,1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE (clinic_id, field_key)
    );

    CREATE TABLE patient_custom_values (
      patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      field_id   INTEGER NOT NULL REFERENCES patient_custom_fields(id) ON DELETE CASCADE,
      value      TEXT,
      updated_at ${TS},
      PRIMARY KEY (patient_id, field_id)
    );
  `);
}
