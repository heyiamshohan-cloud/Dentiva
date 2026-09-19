/**
 * Migration 004 — appointments, configurable appointment types and the daily
 * patient queue (serial numbers are unique per clinic per day).
 */
export const id = 4;
export const name = 'scheduling';

const TS = `TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export function up(db) {
  db.exec(`
    CREATE TABLE appointment_types (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id   INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      name_en     TEXT    NOT NULL,
      name_bn     TEXT,
      color       TEXT    NOT NULL DEFAULT '#0f6f9a',
      duration_minutes INTEGER NOT NULL DEFAULT 30 CHECK (duration_minutes BETWEEN 5 AND 480),
      is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  ${TS},
      updated_at  ${TS},
      deleted_at  TEXT
    );
    CREATE INDEX ix_appt_types ON appointment_types(clinic_id, is_active, sort_order);

    CREATE TABLE appointments (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id         INTEGER NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
      patient_id        INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
      practitioner_id   INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      appointment_code  TEXT    NOT NULL,
      type_id           INTEGER REFERENCES appointment_types(id) ON DELETE SET NULL,
      type_label        TEXT,
      appt_date         TEXT    NOT NULL,
      start_time        TEXT    NOT NULL,
      end_time          TEXT    NOT NULL,
      duration_minutes  INTEGER NOT NULL DEFAULT 30 CHECK (duration_minutes BETWEEN 5 AND 480),
      reason            TEXT,
      notes             TEXT,
      status            TEXT    NOT NULL DEFAULT 'scheduled'
                          CHECK (status IN ('scheduled','checked_in','waiting','in_treatment','completed','cancelled','no_show','rescheduled')),
      serial_no         INTEGER,
      reminder_at       TEXT,
      reminder_sent     INTEGER NOT NULL DEFAULT 0 CHECK (reminder_sent IN (0,1)),
      checked_in_at     TEXT,
      started_at        TEXT,
      completed_at      TEXT,
      cancelled_at      TEXT,
      cancel_reason     TEXT,
      visit_id          INTEGER REFERENCES visits(id) ON DELETE SET NULL,
      rescheduled_from  INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
      created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at        ${TS},
      updated_at        ${TS},
      deleted_at        TEXT
    );
    CREATE UNIQUE INDEX ux_appointments_code ON appointments(clinic_id, appointment_code);
    CREATE INDEX ix_appointments_day ON appointments(clinic_id, appt_date, start_time);
    CREATE INDEX ix_appointments_patient ON appointments(patient_id, appt_date DESC);
    CREATE INDEX ix_appointments_status ON appointments(clinic_id, appt_date, status);
    CREATE INDEX ix_appointments_upcoming ON appointments(clinic_id, appt_date, status) WHERE deleted_at IS NULL;
    CREATE INDEX ix_appointments_reminder ON appointments(clinic_id, reminder_at) WHERE reminder_sent = 0;

    CREATE TABLE queue_entries (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id      INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      queue_date     TEXT    NOT NULL,
      appointment_id INTEGER REFERENCES appointments(id) ON DELETE CASCADE,
      patient_id     INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
      serial_no      INTEGER NOT NULL CHECK (serial_no > 0),
      status         TEXT    NOT NULL DEFAULT 'waiting'
                       CHECK (status IN ('waiting','called','in_treatment','completed','skipped','cancelled')),
      priority       INTEGER NOT NULL DEFAULT 0,
      checked_in_at  TEXT,
      called_at      TEXT,
      started_at     TEXT,
      completed_at   TEXT,
      note           TEXT,
      created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at     ${TS},
      updated_at     ${TS}
    );
    CREATE UNIQUE INDEX ux_queue_serial ON queue_entries(clinic_id, queue_date, serial_no);
    CREATE INDEX ix_queue_day ON queue_entries(clinic_id, queue_date, status, serial_no);
    CREATE INDEX ix_queue_patient ON queue_entries(patient_id, queue_date DESC);
  `);
}
