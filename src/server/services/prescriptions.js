/**
 * Prescriptions and reusable prescription templates (§ 24).
 *
 * Templates capture the clinic's common regimens; writing a prescription from a
 * template copies the items so later template edits never rewrite history.
 */
import { all, get, run, withTransaction, nowIso } from '../db/connection.js';
import { resolvePaging } from '../db/query.js';
import { assertValid } from '../domain/validation.js';
import { NotFoundError } from '../../shared/errors.js';
import { todayIso } from '../domain/dates.js';
import { nextNumber } from './numbering.js';
import { recordAudit } from './audit.js';
import { indexPrescription, removeFromIndex } from './search.js';

const itemSchema = {
  medication: { type: 'string', required: true, maxLength: 160 },
  strength: { type: 'string', maxLength: 60, nullable: true },
  form: { type: 'string', maxLength: 40, nullable: true },
  dose: { type: 'string', maxLength: 60, nullable: true },
  frequency: { type: 'string', maxLength: 60, nullable: true },
  duration: { type: 'string', maxLength: 60, nullable: true },
  route: { type: 'string', maxLength: 40, nullable: true },
  timing: { type: 'string', maxLength: 60, nullable: true },
  quantity: { type: 'string', maxLength: 40, nullable: true },
  instructions: { type: 'text', maxLength: 500, nullable: true },
  notes: { type: 'text', maxLength: 500, nullable: true },
  sort_order: { type: 'int', default: 0 },
};

export const prescriptionSchema = {
  patient_id: { type: 'id', required: true },
  visit_id: { type: 'id', nullable: true },
  practitioner_id: { type: 'id', nullable: true },
  template_id: { type: 'id', nullable: true },
  rx_date: { type: 'date', required: true, default: () => todayIso() },
  diagnosis: { type: 'text', maxLength: 2000, nullable: true },
  advice: { type: 'text', maxLength: 2000, nullable: true },
  followup_date: { type: 'date', nullable: true },
  notes: { type: 'text', maxLength: 2000, nullable: true },
  items: { type: 'array', default: [] },
};

function shapeItem(row) {
  return {
    id: Number(row.id),
    medication: row.medication,
    strength: row.strength,
    form: row.form,
    dose: row.dose,
    frequency: row.frequency,
    duration: row.duration,
    route: row.route,
    timing: row.timing,
    quantity: row.quantity,
    instructions: row.instructions,
    notes: row.notes,
    sortOrder: Number(row.sort_order),
  };
}

export function getPrescription(db, ctx, prescriptionId) {
  const row = get(
    db,
    `SELECT rx.*, p.full_name AS patient_name, p.patient_code, p.gender, p.dob, p.phone, p.address,
            s.full_name AS practitioner_name, s.designation AS practitioner_designation,
            s.registration_no AS practitioner_registration
       FROM prescriptions rx
       JOIN patients p ON p.id = rx.patient_id
       LEFT JOIN staff s ON s.id = rx.practitioner_id
      WHERE rx.id = ? AND rx.clinic_id = ?`,
    [prescriptionId, ctx.clinicId],
  );
  if (!row) throw new NotFoundError('prescription', prescriptionId);
  const items = all(db, 'SELECT * FROM prescription_items WHERE prescription_id = ? ORDER BY sort_order, id', [prescriptionId]);
  return {
    id: Number(row.id),
    rxCode: row.rx_code,
    patientId: Number(row.patient_id),
    patientName: row.patient_name,
    patientCode: row.patient_code,
    patientGender: row.gender,
    patientDob: row.dob,
    patientPhone: row.phone,
    patientAddress: row.address,
    visitId: row.visit_id ?? null,
    practitionerId: row.practitioner_id ?? null,
    practitionerName: row.practitioner_name,
    practitionerDesignation: row.practitioner_designation,
    practitionerRegistration: row.practitioner_registration,
    templateId: row.template_id ?? null,
    rxDate: row.rx_date,
    diagnosis: row.diagnosis,
    advice: row.advice,
    followupDate: row.followup_date,
    notes: row.notes,
    printedCount: Number(row.printed_count),
    createdAt: row.created_at,
    items: items.map(shapeItem),
  };
}

export function listPrescriptions(db, ctx, params = {}) {
  const where = ['rx.clinic_id = ?', 'rx.deleted_at IS NULL'];
  const args = [ctx.clinicId];
  if (params.patientId) {
    where.push('rx.patient_id = ?');
    args.push(Number(params.patientId));
  }
  if (params.visitId) {
    where.push('rx.visit_id = ?');
    args.push(Number(params.visitId));
  }
  if (params.from) {
    where.push('rx.rx_date >= ?');
    args.push(params.from);
  }
  if (params.to) {
    where.push('rx.rx_date <= ?');
    args.push(params.to);
  }
  if (params.search) {
    where.push(
      `(rx.rx_code LIKE ? ESCAPE '\\' OR p.full_name LIKE ? ESCAPE '\\' OR p.patient_code LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM prescription_items pi WHERE pi.prescription_id = rx.id AND pi.medication LIKE ? ESCAPE '\\'))`,
    );
    const pattern = `%${String(params.search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(pattern, pattern, pattern, pattern);
  }
  const page = resolvePaging(params);
  const whereSql = where.join(' AND ');
  const total = Number(
    get(db, `SELECT COUNT(*) AS c FROM prescriptions rx JOIN patients p ON p.id = rx.patient_id WHERE ${whereSql}`, args)?.c ?? 0,
  );
  const rows = all(
    db,
    `SELECT rx.*, p.full_name AS patient_name, p.patient_code,
            (SELECT COUNT(*) FROM prescription_items pi WHERE pi.prescription_id = rx.id) AS item_count,
            (SELECT GROUP_CONCAT(pi.medication, ', ') FROM prescription_items pi WHERE pi.prescription_id = rx.id) AS medication_list
       FROM prescriptions rx JOIN patients p ON p.id = rx.patient_id
      WHERE ${whereSql}
      ORDER BY rx.rx_date DESC, rx.id DESC LIMIT ? OFFSET ?`,
    [...args, page.pageSize, page.offset],
  );
  return {
    rows: rows.map((row) => ({
      id: Number(row.id),
      rxCode: row.rx_code,
      patientId: Number(row.patient_id),
      patientName: row.patient_name,
      patientCode: row.patient_code,
      rxDate: row.rx_date,
      diagnosis: row.diagnosis,
      itemCount: Number(row.item_count),
      medications: row.medication_list,
      createdAt: row.created_at,
    })),
    total,
    page: page.page,
    pageSize: page.pageSize,
    pages: Math.max(1, Math.ceil(total / page.pageSize)),
  };
}

export function createPrescription(db, ctx, input) {
  const values = assertValid(input, prescriptionSchema);
  const patient = get(db, 'SELECT id, patient_code FROM patients WHERE id = ? AND clinic_id = ?', [values.patient_id, ctx.clinicId]);
  if (!patient) throw new NotFoundError('patient', values.patient_id);

  let items = Array.isArray(input.items) ? input.items : [];
  if (!items.length && values.template_id) {
    const template = get(db, 'SELECT items_json FROM prescription_templates WHERE id = ? AND clinic_id = ?', [
      values.template_id,
      ctx.clinicId,
    ]);
    if (template) items = JSON.parse(template.items_json ?? '[]');
  }
  const validatedItems = items.map((item) => assertValid(item, itemSchema, { partial: false }));

  return withTransaction(db, () => {
    const allocation = nextNumber(db, ctx.clinicId, 'prescription');
    const result = run(
      db,
      `INSERT INTO prescriptions
        (clinic_id, patient_id, visit_id, practitioner_id, template_id, rx_code, rx_date, diagnosis, advice, followup_date, notes, created_by, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ctx.clinicId,
        values.patient_id,
        values.visit_id ?? null,
        values.practitioner_id ?? null,
        values.template_id ?? null,
        allocation.code,
        values.rx_date,
        values.diagnosis ?? null,
        values.advice ?? null,
        values.followup_date ?? null,
        values.notes ?? null,
        ctx.user?.id ?? null,
        ctx.user?.id ?? null,
      ],
    );
    const prescriptionId = Number(result.lastInsertRowid);
    writeItems(db, prescriptionId, validatedItems);
    if (values.template_id) {
      run(db, 'UPDATE prescription_templates SET use_count = use_count + 1 WHERE id = ?', [values.template_id]);
    }
    indexPrescription(db, prescriptionId);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'create',
      module: 'prescriptions',
      entity: 'prescription',
      entityId: prescriptionId,
      summary: `Prescription ${allocation.code} written for ${patient.patient_code} (${validatedItems.length} item(s))`,
      severity: 'info',
      after: { rx_code: allocation.code, items: validatedItems.map((item) => item.medication) },
    });
    return { id: prescriptionId, rxCode: allocation.code, itemCount: validatedItems.length };
  });
}

function writeItems(db, prescriptionId, items) {
  items.forEach((item, index) => {
    run(
      db,
      `INSERT INTO prescription_items
        (prescription_id, medication, strength, form, dose, frequency, duration, route, timing, quantity, instructions, notes, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        prescriptionId,
        item.medication,
        item.strength ?? null,
        item.form ?? null,
        item.dose ?? null,
        item.frequency ?? null,
        item.duration ?? null,
        item.route ?? null,
        item.timing ?? null,
        item.quantity ?? null,
        item.instructions ?? null,
        item.notes ?? null,
        item.sort_order ?? index * 10,
      ],
    );
  });
}

export function updatePrescription(db, ctx, prescriptionId, input) {
  const before = get(db, 'SELECT * FROM prescriptions WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [
    prescriptionId,
    ctx.clinicId,
  ]);
  if (!before) throw new NotFoundError('prescription', prescriptionId);
  const values = assertValid(input, prescriptionSchema, { partial: true });
  return withTransaction(db, () => {
    const columns = Object.keys(values).filter((col) => col !== 'items');
    if (columns.length) {
      run(
        db,
        `UPDATE prescriptions SET ${columns.map((col) => `${col} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`,
        [...columns.map((col) => values[col]), ctx.user?.id ?? null, nowIso(), prescriptionId],
      );
    }
    if (input.items !== undefined) {
      const validatedItems = (Array.isArray(input.items) ? input.items : []).map((item) => assertValid(item, itemSchema));
      run(db, 'DELETE FROM prescription_items WHERE prescription_id = ?', [prescriptionId]);
      writeItems(db, prescriptionId, validatedItems);
    }
    indexPrescription(db, prescriptionId);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'update',
      module: 'prescriptions',
      entity: 'prescription',
      entityId: prescriptionId,
      summary: `Prescription ${before.rx_code} updated`,
      severity: 'notice',
    });
    return getPrescription(db, ctx, prescriptionId);
  });
}

/**
 * @param {any} db
 * @param {any} ctx
 * @param {number} prescriptionId
 * @param {string|null} [reason]
 */
export function deletePrescription(db, ctx, prescriptionId, reason = null) {
  const prescription = get(db, 'SELECT * FROM prescriptions WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [
    prescriptionId,
    ctx.clinicId,
  ]);
  if (!prescription) throw new NotFoundError('prescription', prescriptionId);
  run(db, 'UPDATE prescriptions SET deleted_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), prescriptionId]);
  removeFromIndex(db, 'prescription', prescriptionId);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'delete',
    module: 'prescriptions',
    entity: 'prescription',
    entityId: prescriptionId,
    summary: `Prescription ${prescription.rx_code} deleted${reason ? `: ${reason}` : ''}`,
    severity: 'warning',
  });
  return { deleted: true };
}

export function markPrinted(db, ctx, prescriptionId) {
  run(db, 'UPDATE prescriptions SET printed_count = printed_count + 1 WHERE id = ? AND clinic_id = ?', [
    prescriptionId,
    ctx.clinicId,
  ]);
  return { ok: true };
}

/* ---------------------------------------------------------------- templates */

export const templateSchema = {
  name: { type: 'string', required: true, maxLength: 160 },
  diagnosis: { type: 'text', maxLength: 1000, nullable: true },
  notes: { type: 'text', maxLength: 1000, nullable: true },
  items_json: { type: 'array', default: [] },
  is_active: { type: 'boolean', default: true },
};

export function listTemplates(db, ctx, { includeInactive = false, search = null } = {}) {
  const where = ['clinic_id = ?', 'deleted_at IS NULL'];
  const args = [ctx.clinicId];
  if (!includeInactive) where.push('is_active = 1');
  if (search) {
    where.push("name LIKE ? ESCAPE '\\'");
    args.push(`%${String(search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }
  return all(db, `SELECT * FROM prescription_templates WHERE ${where.join(' AND ')} ORDER BY use_count DESC, name`, args).map(
    (row) => ({
      id: Number(row.id),
      name: row.name,
      diagnosis: row.diagnosis,
      notes: row.notes,
      items: JSON.parse(row.items_json ?? '[]'),
      isActive: Boolean(row.is_active),
      useCount: Number(row.use_count),
    }),
  );
}

export function saveTemplate(db, ctx, templateId, input) {
  const values = assertValid(input, templateId ? { ...templateSchema, name: { ...templateSchema.name, required: false } } : templateSchema, {
    partial: Boolean(templateId),
  });
  const items = (input.items ?? input.items_json ?? []).map((item) => assertValid(item, itemSchema, { partial: true }));
  if (templateId) {
    const before = get(db, 'SELECT * FROM prescription_templates WHERE id = ? AND clinic_id = ?', [templateId, ctx.clinicId]);
    if (!before) throw new NotFoundError('prescription_template', templateId);
    const columns = [];
    const params = [];
    if (values.name) {
      columns.push('name = ?');
      params.push(values.name);
    }
    if (values.diagnosis !== undefined) {
      columns.push('diagnosis = ?');
      params.push(values.diagnosis);
    }
    if (values.notes !== undefined) {
      columns.push('notes = ?');
      params.push(values.notes);
    }
    if (values.is_active !== undefined) {
      columns.push('is_active = ?');
      params.push(values.is_active ? 1 : 0);
    }
    if (input.items !== undefined || input.items_json !== undefined) {
      columns.push('items_json = ?');
      params.push(JSON.stringify(items));
    }
    if (columns.length) {
      run(db, `UPDATE prescription_templates SET ${columns.join(', ')}, updated_at = ? WHERE id = ?`, [...params, nowIso(), templateId]);
    }
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'update_template',
      module: 'prescriptions',
      entity: 'prescription_template',
      entityId: templateId,
      summary: `Prescription template "${values.name ?? before.name}" updated`,
      severity: 'info',
    });
    return { id: templateId };
  }
  const result = run(
    db,
    `INSERT INTO prescription_templates (clinic_id, name, diagnosis, notes, items_json, is_active, created_by)
     VALUES (?,?,?,?,?,?,?)`,
    [
      ctx.clinicId,
      values.name,
      values.diagnosis ?? null,
      values.notes ?? null,
      JSON.stringify(items),
      values.is_active ? 1 : 0,
      ctx.user?.id ?? null,
    ],
  );
  const id = Number(result.lastInsertRowid);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'create_template',
    module: 'prescriptions',
    entity: 'prescription_template',
    entityId: id,
    summary: `Prescription template "${values.name}" created`,
    severity: 'info',
  });
  return { id };
}

export function deleteTemplate(db, ctx, templateId) {
  const template = get(db, 'SELECT * FROM prescription_templates WHERE id = ? AND clinic_id = ?', [templateId, ctx.clinicId]);
  if (!template) throw new NotFoundError('prescription_template', templateId);
  run(db, 'UPDATE prescription_templates SET deleted_at = ?, is_active = 0, updated_at = ? WHERE id = ?', [
    nowIso(),
    nowIso(),
    templateId,
  ]);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'delete_template',
    module: 'prescriptions',
    entity: 'prescription_template',
    entityId: templateId,
    summary: `Prescription template "${template.name}" deleted`,
    severity: 'notice',
  });
  return { deleted: true };
}
