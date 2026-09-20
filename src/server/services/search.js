/**
 * Unified search index and global search (§ 46).
 *
 * One FTS5 table backs instant search across patients, visits, treatments,
 * prescriptions, referrals, appointments and invoices. Every write path refreshes
 * its own row (cheap) and Settings → Data can rebuild the whole index.
 */
import { all, get, run } from '../db/connection.js';
import { parseIdList, placeholders } from '../db/query.js';

export const SEARCH_ENTITIES = ['patient', 'visit', 'treatment', 'prescription', 'referral', 'appointment', 'invoice'];

/** Remove a row from the index. */
export function removeFromIndex(db, entity, entityId) {
  run(db, 'DELETE FROM search_index WHERE entity = ? AND entity_id = ?', [entity, String(entityId)]);
}

/**
 * Insert or refresh one index row.
 * @param {import('bun:sqlite').Database} db
 * @param {{ entity: string, entityId: number|string, patientId?: number|null, date?: string|null,
 *           title: string, subtitle?: string|null, keywords?: string|null, body?: string|null }} entry
 */
export function upsertIndex(db, entry) {
  removeFromIndex(db, entry.entity, entry.entityId);
  run(
    db,
    `INSERT INTO search_index (entity, entity_id, patient_id, record_date, title, subtitle, keywords, body)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      entry.entity,
      String(entry.entityId),
      entry.patientId === null || entry.patientId === undefined ? null : String(entry.patientId),
      entry.date ?? null,
      entry.title ?? '',
      entry.subtitle ?? '',
      entry.keywords ?? '',
      entry.body ?? '',
    ],
  );
}

/** Refresh the index entry for a patient. */
export function indexPatient(db, patientId) {
  const row = get(
    db,
    `SELECT p.id, p.patient_code, p.full_name, p.preferred_name, p.gender, p.dob, p.phone, p.phone_alt, p.email,
            p.address, p.city, p.occupation, p.notes, p.registered_on,
            m.allergies, m.conditions, m.medical_history
       FROM patients p
       LEFT JOIN patient_medical m ON m.patient_id = p.id
      WHERE p.id = ?`,
    [patientId],
  );
  if (!row) return;
  const keywords = [
    row.patient_code,
    row.phone,
    row.phone_alt,
    row.email,
    row.city,
    row.allergies,
    row.conditions,
  ]
    .filter(Boolean)
    .join(' ');
  upsertIndex(db, {
    entity: 'patient',
    entityId: row.id,
    patientId: row.id,
    date: row.registered_on,
    title: row.full_name,
    subtitle: row.patient_code,
    keywords,
    body: [row.preferred_name, row.occupation, row.medical_history, row.notes].filter(Boolean).join(' · '),
  });
}

export function indexVisit(db, visitId) {
  const row = get(
    db,
    `SELECT v.*, p.full_name AS patient_name, p.patient_code
       FROM visits v JOIN patients p ON p.id = v.patient_id WHERE v.id = ?`,
    [visitId],
  );
  if (!row) return;
  upsertIndex(db, {
    entity: 'visit',
    entityId: row.id,
    patientId: row.patient_id,
    date: row.visit_date,
    title: row.visit_code,
    subtitle: row.patient_name,
    keywords: [row.patient_code, row.diagnosis, row.chief_complaint].filter(Boolean).join(' '),
    body: [row.chief_complaint, row.reason, row.symptoms, row.examination, row.diagnosis, row.procedure_summary, row.clinical_notes]
      .filter(Boolean)
      .join(' · '),
  });
}

export function indexTreatment(db, treatmentId) {
  const row = get(
    db,
    `SELECT t.*, p.full_name AS patient_name, p.patient_code
       FROM treatments t JOIN patients p ON p.id = t.patient_id WHERE t.id = ?`,
    [treatmentId],
  );
  if (!row) return;
  upsertIndex(db, {
    entity: 'treatment',
    entityId: row.id,
    patientId: row.patient_id,
    date: row.treatment_date,
    title: row.name,
    subtitle: row.patient_name,
    keywords: [row.patient_code, row.tooth_codes, row.anesthesia].filter(Boolean).join(' '),
    body: [row.materials, row.notes].filter(Boolean).join(' · '),
  });
}

export function indexPrescription(db, prescriptionId) {
  const row = get(
    db,
    `SELECT rx.*, p.full_name AS patient_name, p.patient_code
       FROM prescriptions rx JOIN patients p ON p.id = rx.patient_id WHERE rx.id = ?`,
    [prescriptionId],
  );
  if (!row) return;
  const items = all(
    db,
    'SELECT medication, strength, dose, frequency, duration, instructions FROM prescription_items WHERE prescription_id = ? ORDER BY sort_order',
    [prescriptionId],
  );
  const medicationText = items
    .map((item) => [item.medication, item.strength, item.dose, item.frequency, item.duration, item.instructions].filter(Boolean).join(' '))
    .join(' · ');
  upsertIndex(db, {
    entity: 'prescription',
    entityId: row.id,
    patientId: row.patient_id,
    date: row.rx_date,
    title: `Prescription ${row.rx_code}`,
    subtitle: row.patient_name,
    keywords: [row.patient_code, row.diagnosis].filter(Boolean).join(' '),
    body: [row.diagnosis, medicationText, row.advice, row.notes].filter(Boolean).join(' · '),
  });
}

export function indexReferral(db, referralId) {
  const row = get(
    db,
    `SELECT r.*, p.full_name AS patient_name, p.patient_code
       FROM referrals r JOIN patients p ON p.id = r.patient_id WHERE r.id = ?`,
    [referralId],
  );
  if (!row) return;
  upsertIndex(db, {
    entity: 'referral',
    entityId: row.id,
    patientId: row.patient_id,
    date: row.referral_date,
    title: row.provider_name,
    subtitle: row.patient_name,
    keywords: [row.referral_code, row.patient_code, row.specialty, row.institution, row.provider_title].filter(Boolean).join(' '),
    body: [row.reason, row.clinical_context, row.instructions, row.outcome, row.outcome_notes, row.external_treatment_summary]
      .filter(Boolean)
      .join(' · '),
  });
}

export function indexAppointment(db, appointmentId) {
  const row = get(
    db,
    `SELECT a.*, p.full_name AS patient_name, p.patient_code
       FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = ?`,
    [appointmentId],
  );
  if (!row) return;
  upsertIndex(db, {
    entity: 'appointment',
    entityId: row.id,
    patientId: row.patient_id,
    date: row.appt_date,
    title: `${row.appointment_code} ${row.start_time}`,
    subtitle: row.patient_name,
    keywords: [row.patient_code, row.type_label, row.status].filter(Boolean).join(' '),
    body: [row.reason, row.notes].filter(Boolean).join(' · '),
  });
}

export function indexInvoice(db, invoiceId) {
  const row = get(
    db,
    `SELECT i.*, p.full_name AS patient_name, p.patient_code
       FROM invoices i JOIN patients p ON p.id = i.patient_id WHERE i.id = ?`,
    [invoiceId],
  );
  if (!row) return;
  const items = all(db, 'SELECT description FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order', [invoiceId]);
  upsertIndex(db, {
    entity: 'invoice',
    entityId: row.id,
    patientId: row.patient_id,
    date: row.invoice_date,
    title: `Invoice ${row.invoice_number}`,
    subtitle: row.patient_name,
    keywords: [row.patient_code, row.status].filter(Boolean).join(' '),
    body: [items.map((i) => i.description).join(' · '), row.notes].filter(Boolean).join(' · '),
  });
}

/** Dispatch table so callers can reindex by entity name. */
export const INDEXERS = {
  patient: indexPatient,
  visit: indexVisit,
  treatment: indexTreatment,
  prescription: indexPrescription,
  referral: indexReferral,
  appointment: indexAppointment,
  invoice: indexInvoice,
};

export function reindex(db, entity, id) {
  const indexer = INDEXERS[entity];
  if (!indexer) return false;
  indexer(db, id);
  return true;
}

/** Convert free text into a safe FTS5 MATCH expression (prefix search on the last term). */
export function buildMatchQuery(term) {
  const tokens = String(term ?? '')
    .replace(/["'*^:(){}[\]]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 1);
  if (!tokens.length) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' ');
}

/**
 * Global search across every indexed entity.
 * @param {import('bun:sqlite').Database} db
 */
export function globalSearch(db, clinicId, params = {}) {
  const match = buildMatchQuery(params.q);
  if (!match) return { query: params.q ?? '', groups: [], total: 0 };
  const limit = Math.min(100, Math.max(5, Number(params.limit ?? 40)));
  const where = ['search_index MATCH ?'];
  const args = [match];
  const entities = params.entities ? String(params.entities).split(',').filter((e) => SEARCH_ENTITIES.includes(e)) : null;
  if (entities?.length) {
    where.push(`entity IN (${placeholders(entities.length)})`);
    args.push(...entities);
  }
  if (params.patientId) {
    where.push('patient_id = ?');
    args.push(String(params.patientId));
  }
  if (params.from) {
    where.push('record_date >= ?');
    args.push(params.from);
  }
  if (params.to) {
    where.push('record_date <= ?');
    args.push(params.to);
  }
  const rows = all(
    db,
    `SELECT entity, entity_id, patient_id, record_date, title, subtitle,
            snippet(search_index, 6, '', '', ' … ', 12) AS excerpt,
            bm25(search_index, 0, 0, 0, 0, 6.0, 3.0, 4.0, 1.0) AS score
       FROM search_index
      WHERE ${where.join(' AND ')}
      ORDER BY score
      LIMIT ?`,
    [...args, limit],
  );

  const patientIds = [...new Set(rows.map((r) => Number(r.patient_id)).filter((id) => Number.isInteger(id) && id > 0))];
  const patientMeta = new Map();
  if (patientIds.length) {
    const details = all(
      db,
      `SELECT id, patient_code, full_name, gender, dob, phone, status, deleted_at
         FROM patients WHERE id IN (${placeholders(patientIds.length)})`,
      patientIds,
    );
    for (const detail of details) patientMeta.set(detail.id, detail);
  }

  const groups = new Map();
  for (const row of rows) {
    const patient = row.patient_id ? patientMeta.get(Number(row.patient_id)) : null;
    const entry = {
      entity: row.entity,
      entityId: Number(row.entity_id),
      patientId: patient?.id ?? null,
      patientCode: patient?.patient_code ?? null,
      patientName: patient?.full_name ?? row.subtitle ?? null,
      date: row.record_date,
      title: row.title,
      subtitle: patient?.patient_code ?? row.subtitle ?? null,
      excerpt: (row.excerpt ?? '').trim(),
      archived: Boolean(patient?.deleted_at),
      status: patient?.status ?? null,
    };
    if (!groups.has(row.entity)) groups.set(row.entity, []);
    groups.get(row.entity).push(entry);
  }

  return {
    query: params.q ?? '',
    total: rows.length,
    groups: [...groups.entries()].map(([entity, items]) => ({ entity, count: items.length, items })),
  };
}

/** Quick patient lookup used by every "select patient" control. */
export function quickPatientSearch(db, clinicId, term, limit = 12) {
  const search = String(term ?? '').trim();
  const params = [];
  let where = 'p.clinic_id = ? AND p.deleted_at IS NULL';
  params.push(clinicId);
  if (search) {
    where += " AND (p.full_name LIKE ? ESCAPE '\\' OR p.patient_code LIKE ? ESCAPE '\\' OR p.phone LIKE ? ESCAPE '\\' OR p.phone_alt LIKE ? ESCAPE '\\')";
    const pattern = `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(pattern, pattern, pattern, pattern);
  }
  return all(
    db,
    `SELECT p.id, p.patient_code, p.full_name, p.gender, p.dob, p.phone, p.status, p.last_visit_on
       FROM patients p
      WHERE ${where}
      ORDER BY p.full_name COLLATE NOCASE
      LIMIT ?`,
    [...params, Math.min(50, Math.max(1, limit))],
  );
}

/**
 * Rebuild the entire search index (Settings → Data, and after a restore).
 * Runs in batches so a large database does not block for long.
 */
export function rebuildIndex(db, clinicId, options = {}) {
  const log = options.log ?? (() => {});
  const counts = {};
  db.exec("DELETE FROM search_index WHERE entity IN ('patient','visit','treatment','prescription','referral','appointment','invoice')");

  const batch = 500;
  const job = (entity, selectSql) => {
    let offset = 0;
    let total = 0;
    for (;;) {
      const ids = all(db, `${selectSql} LIMIT ? OFFSET ?`, [clinicId, batch, offset]).map((row) => row.id);
      if (!ids.length) break;
      for (const id of ids) reindex(db, entity, id);
      total += ids.length;
      offset += batch;
      log(`indexed ${total} ${entity} records`);
    }
    counts[entity] = total;
  };

  job('patient', 'SELECT id FROM patients WHERE clinic_id = ? AND deleted_at IS NULL ORDER BY id');
  job('visit', 'SELECT id FROM visits WHERE clinic_id = ? AND deleted_at IS NULL ORDER BY id');
  job('treatment', 'SELECT id FROM treatments WHERE clinic_id = ? AND deleted_at IS NULL ORDER BY id');
  job('prescription', 'SELECT id FROM prescriptions WHERE clinic_id = ? AND deleted_at IS NULL ORDER BY id');
  job('referral', 'SELECT id FROM referrals WHERE clinic_id = ? AND deleted_at IS NULL ORDER BY id');
  job('appointment', 'SELECT id FROM appointments WHERE clinic_id = ? AND deleted_at IS NULL ORDER BY id');
  job('invoice', 'SELECT id FROM invoices WHERE clinic_id = ? AND deleted_at IS NULL ORDER BY id');
  return counts;
}

export function indexStats(db) {
  const rows = all(db, 'SELECT entity, COUNT(*) AS c FROM search_index GROUP BY entity ORDER BY entity');
  const total = rows.reduce((sum, row) => sum + Number(row.c), 0);
  return { total, byEntity: rows.map((row) => ({ entity: row.entity, count: Number(row.c) })) };
}

/** Reindex helper used by the tests and by bulk import. */
export function reindexAllForPatient(db, patientId) {
  reindex(db, 'patient', patientId);
  const entities = [
    ['visit', 'SELECT id FROM visits WHERE patient_id = ?'],
    ['treatment', 'SELECT id FROM treatments WHERE patient_id = ?'],
    ['prescription', 'SELECT id FROM prescriptions WHERE patient_id = ?'],
    ['referral', 'SELECT id FROM referrals WHERE patient_id = ?'],
    ['appointment', 'SELECT id FROM appointments WHERE patient_id = ?'],
    ['invoice', 'SELECT id FROM invoices WHERE patient_id = ?'],
  ];
  for (const [entity, sql] of entities) {
    for (const row of all(db, sql, [patientId])) reindex(db, entity, row.id);
  }
}

export { parseIdList };
