/**
 * Dental chart / odontogram (§ 22).
 *
 * Teeth are identified with the FDI two-digit notation
 * (adult 11–48, primary 51–85) and conditions come from a configurable
 * catalogue (`tooth_conditions`). Entries are additive and never destroyed:
 * clearing a condition keeps the row with `is_active = 0` so the tooth history
 * remains clinically and legally auditable.
 */
import { all, get, run, withTransaction, nowIso } from '../db/connection.js';
import { assertValid } from '../domain/validation.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import { DENTITIONS, TOOTH_STATUSES } from '../../shared/constants.js';
import { recordAudit } from './audit.js';

export const ADULT_TEETH = [
  '18', '17', '16', '15', '14', '13', '12', '11',
  '21', '22', '23', '24', '25', '26', '27', '28',
  '48', '47', '46', '45', '44', '43', '42', '41',
  '31', '32', '33', '34', '35', '36', '37', '38',
];

export const PRIMARY_TEETH = [
  '55', '54', '53', '52', '51',
  '61', '62', '63', '64', '65',
  '85', '84', '83', '82', '81',
  '71', '72', '73', '74', '75',
];

/** Upper-right, upper-left, lower-left, lower-right quadrant layout for the chart UI. */
export const CHART_LAYOUT = {
  adult: {
    upperRight: ['18', '17', '16', '15', '14', '13', '12', '11'],
    upperLeft: ['21', '22', '23', '24', '25', '26', '27', '28'],
    lowerLeft: ['38', '37', '36', '35', '34', '33', '32', '31'],
    lowerRight: ['48', '47', '46', '45', '44', '43', '42', '41'],
  },
  primary: {
    upperRight: ['55', '54', '53', '52', '51'],
    upperLeft: ['61', '62', '63', '64', '65'],
    lowerLeft: ['75', '74', '73', '72', '71'],
    lowerRight: ['85', '84', '83', '82', '81'],
  },
};

export const TOOTH_SURFACES = ['M', 'D', 'B', 'L', 'O', 'I', 'C'];

export function isValidToothCode(code, dentition = null) {
  const value = String(code ?? '');
  if (dentition === 'adult') return ADULT_TEETH.includes(value);
  if (dentition === 'primary') return PRIMARY_TEETH.includes(value);
  return ADULT_TEETH.includes(value) || PRIMARY_TEETH.includes(value);
}

export function dentitionOf(code) {
  return PRIMARY_TEETH.includes(String(code)) ? 'primary' : 'adult';
}

export function toothLabel(code) {
  const value = String(code ?? '');
  if (!isValidToothCode(value)) return value;
  const quadrant = Number(value[0]);
  const index = Number(value[1]);
  const names = ['central incisor', 'lateral incisor', 'canine', 'first premolar', 'second premolar', 'first molar', 'second molar', 'third molar'];
  const position = ['', 'Central incisor', 'Lateral incisor', 'Canine', 'First premolar', 'Second premolar', 'First molar', 'Second molar', 'Third molar'];
  const quadrantNames = { 1: 'upper right', 2: 'upper left', 3: 'lower left', 4: 'lower right', 5: 'upper right (primary)', 6: 'upper left (primary)', 7: 'lower left (primary)', 8: 'lower right (primary)' };
  return `${value} · ${position[index] ?? names[index - 1] ?? ''} (${quadrantNames[quadrant] ?? ''})`.replace(/\s+/g, ' ').trim();
}

/** Condition catalogue for the chart legend and the picker. */
export function toothConditions(db, { activeOnly = true } = {}) {
  return all(
    db,
    `SELECT code, label_en, label_bn, category, color, symbol, sort_order
       FROM tooth_conditions ${activeOnly ? 'WHERE is_active = 1' : ''}
      ORDER BY sort_order, code`,
  );
}

/**
 * Current chart state for a patient.
 * @returns {{ dentition: string, teeth: Record<string, any>, entries: any[], layout: any }}
 */
/**
 * @param {any} db
 * @param {any} ctx
 * @param {number} patientId
 * @param {string} [dentition]
 * @returns {any}
 */
export function getChart(db, ctx, patientId, dentition = 'adult') {
  const patient = get(db, 'SELECT id, patient_code, full_name FROM patients WHERE id = ? AND clinic_id = ?', [
    patientId,
    ctx.clinicId,
  ]);
  if (!patient) throw new NotFoundError('patient', patientId);
  if (!DENTITIONS.includes(dentition)) throw new ValidationError('validation.failed', [{ field: 'dentition', key: 'validation.option' }]);

  const entries = all(
    db,
    `SELECT de.*, tc.label_en, tc.label_bn, tc.color, tc.symbol, tc.category,
            s.full_name AS practitioner_name, v.visit_code
       FROM dental_chart_entries de
       JOIN tooth_conditions tc ON tc.code = de.condition_code
       LEFT JOIN users u ON u.id = de.recorded_by
       LEFT JOIN staff s ON s.user_id = u.id
       LEFT JOIN visits v ON v.id = de.visit_id
      WHERE de.patient_id = ? AND de.dentition = ? AND de.is_active = 1
      ORDER BY de.tooth_code, de.recorded_at DESC`,
    [patientId, dentition],
  );

  /** @type {Record<string, any>} */
  const teeth = {};
  for (const code of dentition === 'adult' ? ADULT_TEETH : PRIMARY_TEETH) {
    teeth[code] = { code, conditions: [], notes: null, lastUpdated: null };
  }
  for (const entry of entries) {
    if (!teeth[entry.tooth_code]) {
      teeth[entry.tooth_code] = { code: entry.tooth_code, conditions: [], notes: null, lastUpdated: null };
    }
    teeth[entry.tooth_code].conditions.push({
      id: Number(entry.id),
      conditionCode: entry.condition_code,
      labelEn: entry.label_en,
      labelBn: entry.label_bn,
      color: entry.color,
      symbol: entry.symbol,
      category: entry.category,
      surfaces: safeArray(entry.surfaces),
      status: entry.status,
      notes: entry.notes,
      visitId: entry.visit_id,
      visitCode: entry.visit_code,
      recordedAt: entry.recorded_at,
      practitionerName: entry.practitioner_name,
    });
    if (entry.notes) teeth[entry.tooth_code].notes = entry.notes;
    if (!teeth[entry.tooth_code].lastUpdated || entry.recorded_at > teeth[entry.tooth_code].lastUpdated) {
      teeth[entry.tooth_code].lastUpdated = entry.recorded_at;
    }
  }

  // A tooth is "missing"/"extracted" when the most recent status entry says so.
  for (const tooth of Object.values(teeth)) {
    const statusEntries = tooth.conditions.filter((c) => c.category === 'status');
    tooth.status = statusEntries[0]?.conditionCode ?? 'present';
    tooth.primaryCondition = tooth.conditions[0] ?? null;
    tooth.summaryColor = tooth.primaryCondition?.color ?? null;
  }

  return {
    patient: { id: patient.id, code: patient.patient_code, name: patient.full_name },
    dentition,
    layout: CHART_LAYOUT[dentition],
    teeth,
    entries: entries.map((entry) => ({
      id: Number(entry.id),
      toothCode: entry.tooth_code,
      conditionCode: entry.condition_code,
      labelEn: entry.label_en,
      labelBn: entry.label_bn,
      color: entry.color,
      surfaces: safeArray(entry.surfaces),
      status: entry.status,
      notes: entry.notes,
      recordedAt: entry.recorded_at,
      visitCode: entry.visit_code,
    })),
  };
}

function safeArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const chartEntrySchema = {
  patient_id: { type: 'id', required: true },
  tooth_code: { type: 'string', required: true, maxLength: 4 },
  dentition: { type: 'enum', values: DENTITIONS, default: 'adult' },
  condition_code: { type: 'string', required: true, maxLength: 40 },
  surfaces: { type: 'array', default: [] },
  status: { type: 'enum', values: TOOTH_STATUSES, default: 'existing' },
  visit_id: { type: 'id', nullable: true },
  notes: { type: 'text', maxLength: 500, nullable: true },
  linked_prescription_id: { type: 'id', nullable: true },
};

/** Record a condition on a tooth. */
export function addChartEntry(db, ctx, input) {
  const values = assertValid(input, chartEntrySchema);
  if (!isValidToothCode(values.tooth_code, values.dentition)) {
    throw new ValidationError('validation.failed', [{ field: 'tooth_code', key: 'chart.invalidTooth' }]);
  }
  const condition = get(db, 'SELECT code, label_en FROM tooth_conditions WHERE code = ? AND is_active = 1', [values.condition_code]);
  if (!condition) throw new ValidationError('validation.failed', [{ field: 'condition_code', key: 'chart.invalidCondition' }]);
  const invalidSurfaces = (values.surfaces ?? []).filter((surface) => !TOOTH_SURFACES.includes(String(surface)));
  if (invalidSurfaces.length) {
    throw new ValidationError('validation.failed', [{ field: 'surfaces', key: 'chart.invalidSurface', params: { values: TOOTH_SURFACES.join(', ') } }]);
  }
  const patient = get(db, 'SELECT id, patient_code FROM patients WHERE id = ? AND clinic_id = ?', [values.patient_id, ctx.clinicId]);
  if (!patient) throw new NotFoundError('patient', values.patient_id);

  return withTransaction(db, () => {
    // A repeated identical active finding replaces the previous row for the same
    // tooth + condition + surfaces so the chart does not accumulate duplicates.
    const existing = all(
      db,
      `SELECT id, surfaces FROM dental_chart_entries
        WHERE patient_id = ? AND tooth_code = ? AND condition_code = ? AND is_active = 1`,
      [values.patient_id, values.tooth_code, values.condition_code],
    ).find((row) => JSON.stringify(safeArray(row.surfaces).sort()) === JSON.stringify([...(values.surfaces ?? [])].sort()));
    if (existing) {
      run(
        db,
        `UPDATE dental_chart_entries SET status = ?, notes = ?, visit_id = COALESCE(?, visit_id), recorded_at = ?, recorded_by = ? WHERE id = ?`,
        [values.status, values.notes ?? null, values.visit_id ?? null, nowIso(), ctx.user?.id ?? null, existing.id],
      );
      recordAudit(db, {
        clinicId: ctx.clinicId,
        userId: ctx.user?.id ?? null,
        userName: ctx.user?.displayName ?? null,
        action: 'update_chart',
        module: 'chart',
        entity: 'dental_chart_entry',
        entityId: existing.id,
        summary: `Tooth ${values.tooth_code} ${condition.code} refreshed for ${patient.patient_code}`,
        severity: 'info',
      });
      return { id: Number(existing.id), updated: true };
    }

    const result = run(
      db,
      `INSERT INTO dental_chart_entries
        (clinic_id, patient_id, tooth_code, dentition, condition_code, surfaces, status, visit_id, notes, recorded_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        ctx.clinicId,
        values.patient_id,
        values.tooth_code,
        values.dentition,
        values.condition_code,
        JSON.stringify(values.surfaces ?? []),
        values.status,
        values.visit_id ?? null,
        values.notes ?? null,
        ctx.user?.id ?? null,
      ],
    );
    const id = Number(result.lastInsertRowid);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'update_chart',
      module: 'chart',
      entity: 'dental_chart_entry',
      entityId: id,
      summary: `Tooth ${values.tooth_code} marked ${condition.code} for ${patient.patient_code}`,
      severity: 'info',
      after: { tooth: values.tooth_code, condition: values.condition_code, surfaces: values.surfaces, status: values.status },
    });
    return { id, updated: false };
  });
}

export function updateChartEntry(db, ctx, entryId, input) {
  const entry = get(db, 'SELECT * FROM dental_chart_entries WHERE id = ? AND clinic_id = ?', [entryId, ctx.clinicId]);
  if (!entry) throw new NotFoundError('chart_entry', entryId);
  const values = assertValid(input, {
    surfaces: { type: 'array' },
    status: { type: 'enum', values: TOOTH_STATUSES },
    notes: { type: 'text', maxLength: 500, nullable: true },
    condition_code: { type: 'string', maxLength: 40 },
    visit_id: { type: 'id', nullable: true },
  }, { partial: true });
  if (values.condition_code) {
    const condition = get(db, 'SELECT code FROM tooth_conditions WHERE code = ?', [values.condition_code]);
    if (!condition) throw new ValidationError('validation.failed', [{ field: 'condition_code', key: 'chart.invalidCondition' }]);
  }
  const columns = Object.keys(values);
  if (!columns.length) return entry;
  run(
    db,
    `UPDATE dental_chart_entries SET ${columns.map((col) => `${col} = ?`).join(', ')} WHERE id = ?`,
    [...columns.map((col) => (col === 'surfaces' ? JSON.stringify(values[col] ?? []) : values[col])), entryId],
  );
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'update_chart',
    module: 'chart',
    entity: 'dental_chart_entry',
    entityId: entryId,
    summary: `Chart entry updated (tooth ${entry.tooth_code})`,
    severity: 'info',
    before: { status: entry.status, surfaces: entry.surfaces },
    after: values,
  });
  return get(db, 'SELECT * FROM dental_chart_entries WHERE id = ?', [entryId]);
}

/** Clear (resolve) a condition without losing the historical record. */
/**
 * Clear (resolve) a chart entry.
 * @param {any} db
 * @param {any} ctx
 * @param {number} entryId
 * @param {string|null} [reason]
 */
export function clearChartEntry(db, ctx, entryId, reason = null) {
  const entry = get(db, 'SELECT * FROM dental_chart_entries WHERE id = ? AND clinic_id = ?', [entryId, ctx.clinicId]);
  if (!entry) throw new NotFoundError('chart_entry', entryId);
  run(
    db,
    'UPDATE dental_chart_entries SET is_active = 0, cleared_at = ?, cleared_by = ? WHERE id = ?',
    [nowIso(), ctx.user?.id ?? null, entryId],
  );
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'clear_chart',
    module: 'chart',
    entity: 'dental_chart_entry',
    entityId: entryId,
    summary: `Tooth ${entry.tooth_code} condition cleared${reason ? `: ${reason}` : ''}`,
    severity: 'notice',
    before: { condition_code: entry.condition_code, surfaces: entry.surfaces },
  });
  return { cleared: true };
}

/** Chart history for the "Clinical history" tab: every recorded change. */
/**
 * @param {any} db
 * @param {any} ctx
 * @param {number} patientId
 * @param {{ limit?: number }} [options]
 */
export function chartHistory(db, ctx, patientId, { limit = 100 } = {}) {
  return all(
    db,
    `SELECT de.id, de.tooth_code, de.condition_code, de.surfaces, de.status, de.notes,
            de.recorded_at, de.cleared_at, de.is_active,
            tc.label_en, tc.color,
            v.visit_code, v.visit_date,
            u.display_name AS recorded_by_name
       FROM dental_chart_entries de
       JOIN tooth_conditions tc ON tc.code = de.condition_code
       LEFT JOIN visits v ON v.id = de.visit_id
       LEFT JOIN users u ON u.id = de.recorded_by
      WHERE de.patient_id = ? AND de.clinic_id = ?
      ORDER BY de.recorded_at DESC
      LIMIT ?`,
    [patientId, ctx.clinicId, Math.min(500, Math.max(1, limit))],
  );
}

/** Aggregate chart statistics used on the chart toolbar and reports. */
export function chartSummary(db, ctx, patientId) {
  const rows = all(
    db,
    `SELECT tc.category, tc.code, COUNT(*) AS c
       FROM dental_chart_entries de
       JOIN tooth_conditions tc ON tc.code = de.condition_code
      WHERE de.patient_id = ? AND de.is_active = 1
      GROUP BY tc.category, tc.code`,
    [patientId],
  );
  const byCategory = {};
  const byCondition = {};
  for (const row of rows) {
    byCategory[row.category] = (byCategory[row.category] ?? 0) + Number(row.c);
    byCondition[row.code] = Number(row.c);
  }
  const missing = Number(byCondition.missing ?? 0) + Number(byCondition.extraction_done ?? 0);
  return {
    byCategory,
    byCondition,
    teethAffected: new Set(
      all(db, 'SELECT DISTINCT tooth_code FROM dental_chart_entries WHERE patient_id = ? AND is_active = 1', [patientId]).map(
        (row) => row.tooth_code,
      ),
    ).size,
    missingTeeth: missing,
    charted: new Set(
      all(db, 'SELECT DISTINCT tooth_code FROM dental_chart_entries WHERE patient_id = ?', [patientId]).map((row) => row.tooth_code),
    ).size,
  };
}
