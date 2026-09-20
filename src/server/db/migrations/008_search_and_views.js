/**
 * Migration 008 — unified search index (FTS5), reporting views and the extra
 * indexes required by the list screens.
 *
 * The search index is maintained by the application (see services/search.js):
 * every write path refreshes its own rows, and a full rebuild is available from
 * Settings → Data. Keeping one index instead of many keeps global search fast
 * and consistent across patients, visits, treatments, prescriptions, referrals,
 * appointments and invoices (§ 46).
 */
export const id = 8;
export const name = 'search_and_views';

export function up(db) {
  db.exec(`
    CREATE VIRTUAL TABLE search_index USING fts5(
      entity UNINDEXED,
      entity_id UNINDEXED,
      patient_id UNINDEXED,
      record_date UNINDEXED,
      title,
      subtitle,
      keywords,
      body,
      tokenize = 'unicode61 remove_diacritics 2',
      prefix = '2 3 4'
    );

    CREATE INDEX ix_appointments_practitioner ON appointments(clinic_id, practitioner_id, appt_date);
    CREATE INDEX ix_visits_practitioner ON visits(clinic_id, practitioner_id, visit_date DESC);
    CREATE INDEX ix_treatments_practitioner ON treatments(clinic_id, practitioner_id, treatment_date DESC);
    CREATE INDEX ix_patients_gender ON patients(clinic_id, gender);
    CREATE INDEX ix_invoices_patient_date ON invoices(patient_id, invoice_date DESC);
    CREATE INDEX ix_payments_patient_date ON payments(patient_id, payment_date DESC);
    CREATE INDEX ix_referrals_followup ON referrals(clinic_id, followup_date) WHERE status <> 'completed';
    CREATE INDEX ix_items_expiry_active ON inventory_items(clinic_id, expiry_date) WHERE is_active = 1 AND deleted_at IS NULL;
  `);

  // ------------------------------------------------------------------ views
  db.exec(`
    CREATE VIEW v_patient_balances AS
    SELECT
      p.id                                   AS patient_id,
      COALESCE(SUM(CASE WHEN i.status = 'issued' THEN i.total_minor END), 0) AS invoiced_minor,
      COALESCE(SUM(CASE WHEN i.status = 'issued' THEN i.paid_minor  END), 0) AS paid_minor,
      COALESCE(SUM(CASE WHEN i.status = 'issued' THEN i.due_minor   END), 0) AS due_minor,
      COALESCE(SUM(CASE WHEN i.status = 'issued' THEN i.discount_minor END), 0) AS discount_minor
    FROM patients p
    LEFT JOIN invoices i ON i.patient_id = p.id AND i.deleted_at IS NULL
    GROUP BY p.id;

    CREATE VIEW v_patient_visit_stats AS
    SELECT
      p.id AS patient_id,
      COUNT(v.id)                                             AS total_visits,
      SUM(CASE WHEN v.status = 'completed'  THEN 1 ELSE 0 END) AS completed_visits,
      SUM(CASE WHEN v.status = 'cancelled'  THEN 1 ELSE 0 END) AS cancelled_visits,
      MIN(v.visit_date)                                        AS first_visit_on,
      MAX(v.visit_date)                                        AS last_visit_on
    FROM patients p
    LEFT JOIN visits v ON v.patient_id = p.id AND v.deleted_at IS NULL
    GROUP BY p.id;

    CREATE VIEW v_patient_appointment_stats AS
    SELECT
      p.id AS patient_id,
      COUNT(a.id)                                              AS total_appointments,
      SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END)   AS completed_appointments,
      SUM(CASE WHEN a.status = 'no_show'   THEN 1 ELSE 0 END)   AS no_shows,
      SUM(CASE WHEN a.status = 'cancelled' THEN 1 ELSE 0 END)   AS cancelled_appointments,
      MIN(CASE WHEN a.status = 'scheduled' AND a.appt_date >= date('now','localtime') THEN a.appt_date END) AS next_appointment_on
    FROM patients p
    LEFT JOIN appointments a ON a.patient_id = p.id AND a.deleted_at IS NULL
    GROUP BY p.id;

    CREATE VIEW v_inventory_status AS
    SELECT
      i.id AS item_id,
      i.clinic_id,
      i.name,
      i.sku,
      i.unit,
      i.quantity_milli,
      i.min_stock_milli,
      i.purchase_price_minor,
      i.expiry_date,
      i.condition,
      (i.quantity_milli * i.purchase_price_minor) / 1000 AS stock_value_minor,
      CASE WHEN i.quantity_milli <= i.min_stock_milli THEN 1 ELSE 0 END AS is_low_stock,
      CASE
        WHEN i.expiry_date IS NULL THEN 0
        WHEN i.expiry_date < date('now','localtime') THEN 1
        WHEN i.expiry_date <= date('now','localtime','+60 days') THEN 2
        ELSE 0
      END AS expiry_state
    FROM inventory_items i
    WHERE i.deleted_at IS NULL AND i.is_active = 1;

    CREATE VIEW v_daily_finance AS
    SELECT
      clinic_id,
      income_date AS entry_date,
      SUM(amount_minor) AS income_minor
    FROM incomes
    WHERE deleted_at IS NULL AND is_reversed = 0
    GROUP BY clinic_id, income_date;
  `);

  db.exec(`PRAGMA user_version = ${id};`);
}
