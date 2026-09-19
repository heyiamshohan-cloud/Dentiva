/**
 * Attachment management (§ 27, § 28).
 *
 * Attachments always keep their clinical context (patient, visit, treatment,
 * treatment plan, referral, prescription, invoice, payment or expense) — never a
 * loose file. Every row records size, mime type and a SHA-256 digest so integrity
 * can be re-verified at any time.
 */
import { all, get, run, withTransaction, nowIso } from '../db/connection.js';
import { resolvePaging } from '../db/query.js';
import { assertValid } from '../domain/validation.js';
import { NotFoundError, FileError } from '../../shared/errors.js';
import { ATTACHMENT_CATEGORIES } from '../../shared/constants.js';
import { recordAudit } from './audit.js';
import {
  attachmentsRoot,
  copyStoredFile,
  fileExists,
  hashFile,
  removeStoredFile,
  resolveStoredPath,
  safeDownloadName,
  storeFile,
  streamStoredFile,
  validateExtension,
} from './fileStore.js';

const attachmentLinks = {
  patient_id: 'patient_id',
  visit_id: 'visit_id',
  treatment_id: 'treatment_id',
  plan_id: 'plan_id',
  referral_id: 'referral_id',
  prescription_id: 'prescription_id',
  invoice_id: 'invoice_id',
  payment_id: 'payment_id',
  expense_id: 'expense_id',
};

/**
 * File operations are impossible without the data directory, and silently
 * skipping them would leave rows pointing at nothing — so fail loudly.
 */
function dataDirOf(ctx) {
  if (!ctx || !ctx.dataDir) throw new FileError('files.storeUnavailable');
  return ctx.dataDir;
}

export const attachmentSchema = {
  patient_id: { type: 'id', required: true },
  category: { type: 'enum', values: ATTACHMENT_CATEGORIES, default: 'other' },
  title: { type: 'string', maxLength: 160, nullable: true },
  description: { type: 'text', maxLength: 2000, nullable: true },
  captured_on: { type: 'date', nullable: true },
  visit_id: { type: 'id', nullable: true },
  treatment_id: { type: 'id', nullable: true },
  plan_id: { type: 'id', nullable: true },
  referral_id: { type: 'id', nullable: true },
  prescription_id: { type: 'id', nullable: true },
  invoice_id: { type: 'id', nullable: true },
  payment_id: { type: 'id', nullable: true },
  expense_id: { type: 'id', nullable: true },
};

export function shapeAttachment(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    patientId: row.patient_id ?? null,
    patientName: row.patient_name ?? null,
    patientCode: row.patient_code ?? null,
    visitId: row.visit_id ?? null,
    treatmentId: row.treatment_id ?? null,
    planId: row.plan_id ?? null,
    referralId: row.referral_id ?? null,
    prescriptionId: row.prescription_id ?? null,
    invoiceId: row.invoice_id ?? null,
    paymentId: row.payment_id ?? null,
    expenseId: row.expense_id ?? null,
    category: row.category,
    title: row.title,
    description: row.description,
    originalName: row.original_name,
    extension: row.extension,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    capturedOn: row.captured_on,
    isArchived: Boolean(row.is_archived),
    uploadedAt: row.created_at,
    uploadedBy: row.uploaded_by_name ?? null,
    isImage: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'tif'].includes(String(row.extension).toLowerCase()),
    isPdf: String(row.extension).toLowerCase() === 'pdf',
  };
}

/**
 * Store an uploaded file and create its attachment row.
 * @param {import('bun:sqlite').Database} db
 * @param {{ clinicId: number, user?: any, ip?: string|null, dataDir: string }} ctx
 */
export async function createAttachment(db, ctx, input, file) {
  if (!file || (!file.name && !file.originalName)) throw new FileError('files.missingFile');
  const values = assertValid(input, attachmentSchema);
  const originalName = file.name ?? file.originalName;
  const { extension, mime } = validateExtension(originalName, file.type ?? null);

  const patient = get(db, 'SELECT id, patient_code FROM patients WHERE id = ? AND clinic_id = ?', [values.patient_id, ctx.clinicId]);
  if (!patient) throw new NotFoundError('patient', values.patient_id);

  // Referential context is verified so a file can never be attached to a
  // record belonging to another patient or clinic.
  for (const [field, column] of Object.entries(attachmentLinks)) {
    if (field === 'patient_id') continue;
    const value = values[field];
    if (!value) continue;
    const table = {
      visit_id: 'visits',
      treatment_id: 'treatments',
      plan_id: 'treatment_plans',
      referral_id: 'referrals',
      prescription_id: 'prescriptions',
      invoice_id: 'invoices',
      payment_id: 'payments',
      expense_id: 'expenses',
    }[field];
    const row = get(db, `SELECT id, patient_id, clinic_id FROM ${table} WHERE id = ?`, [value]);
    if (!row || (row.clinic_id && row.clinic_id !== ctx.clinicId)) throw new NotFoundError(table, value);
    if (field !== 'expense_id' && row.patient_id && row.patient_id !== values.patient_id) throw new NotFoundError(table, value);
  }

  const stored = await storeFile(dataDirOf(ctx), {
    data: file,
    extension,
    capturedAt: values.captured_on ? new Date(`${values.captured_on}T12:00:00`) : new Date(),
  });

  try {
    const result = run(
      db,
      `INSERT INTO attachments
        (clinic_id, patient_id, visit_id, treatment_id, plan_id, referral_id, prescription_id, invoice_id, payment_id, expense_id,
         category, title, description, original_name, stored_name, rel_path, extension, mime_type, size_bytes, sha256, captured_on, uploaded_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ctx.clinicId,
        values.patient_id,
        values.visit_id ?? null,
        values.treatment_id ?? null,
        values.plan_id ?? null,
        values.referral_id ?? null,
        values.prescription_id ?? null,
        values.invoice_id ?? null,
        values.payment_id ?? null,
        values.expense_id ?? null,
        values.category,
        values.title ?? null,
        values.description ?? null,
        safeDownloadName(originalName, `attachment.${extension}`),
        stored.storedName,
        stored.relPath,
        extension,
        mime,
        stored.sizeBytes,
        stored.sha256,
        values.captured_on ?? null,
        ctx.user?.id ?? null,
      ],
    );
    const id = Number(result.lastInsertRowid);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'attach',
      module: 'attachments',
      entity: 'attachment',
      entityId: id,
      summary: `${values.category} attached for ${patient.patient_code} (${stored.sizeBytes} bytes)`,
      severity: 'info',
      after: { file: stored.storedName, sha256: stored.sha256, category: values.category },
      ip: ctx.ip,
    });
    return { id, sha256: stored.sha256, sizeBytes: stored.sizeBytes, relPath: stored.relPath };
  } catch (error) {
    // Never leave an orphaned file behind when the row cannot be written.
    removeStoredFile(dataDirOf(ctx), stored.relPath);
    throw error;
  }
}

export function listAttachments(db, ctx, params = {}) {
  const where = ['a.clinic_id = ?', 'a.deleted_at IS NULL'];
  const args = [ctx.clinicId];
  if (params.patientId) {
    where.push('a.patient_id = ?');
    args.push(Number(params.patientId));
  }
  if (params.referralId) {
    where.push('a.referral_id = ?');
    args.push(Number(params.referralId));
  }
  if (params.visitId) {
    where.push('a.visit_id = ?');
    args.push(Number(params.visitId));
  }
  if (params.treatmentId) {
    where.push('a.treatment_id = ?');
    args.push(Number(params.treatmentId));
  }
  if (params.planId) {
    where.push('a.plan_id = ?');
    args.push(Number(params.planId));
  }
  if (params.category && ATTACHMENT_CATEGORIES.includes(params.category)) {
    where.push('a.category = ?');
    args.push(params.category);
  }
  if (params.includeArchived !== true && params.includeArchived !== 'true') {
    where.push('a.is_archived = 0');
  }
  if (params.from) {
    where.push('COALESCE(a.captured_on, substr(a.created_at,1,10)) >= ?');
    args.push(params.from);
  }
  if (params.to) {
    where.push('COALESCE(a.captured_on, substr(a.created_at,1,10)) <= ?');
    args.push(params.to);
  }
  if (params.search) {
    where.push("(a.original_name LIKE ? ESCAPE '\\' OR COALESCE(a.title,'') LIKE ? ESCAPE '\\' OR COALESCE(a.description,'') LIKE ? ESCAPE '\\')");
    const pattern = `%${String(params.search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(pattern, pattern, pattern);
  }
  const page = resolvePaging(params);
  const whereSql = where.join(' AND ');
  const total = Number(get(db, `SELECT COUNT(*) AS c FROM attachments a WHERE ${whereSql}`, args)?.c ?? 0);
  const rows = all(
    db,
    `SELECT a.*, p.full_name AS patient_name, p.patient_code, u.display_name AS uploaded_by_name
       FROM attachments a
       LEFT JOIN patients p ON p.id = a.patient_id
       LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE ${whereSql}
      ORDER BY COALESCE(a.captured_on, substr(a.created_at,1,10)) DESC, a.id DESC
      LIMIT ? OFFSET ?`,
    [...args, page.pageSize, page.offset],
  );
  return {
    rows: rows.map(shapeAttachment),
    total,
    page: page.page,
    pageSize: page.pageSize,
    pages: Math.max(1, Math.ceil(total / page.pageSize)),
  };
}

export function getAttachment(db, ctx, attachmentId) {
  const row = get(
    db,
    `SELECT a.*, p.full_name AS patient_name, p.patient_code, u.display_name AS uploaded_by_name
       FROM attachments a
       LEFT JOIN patients p ON p.id = a.patient_id
       LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.id = ? AND a.clinic_id = ? AND a.deleted_at IS NULL`,
    [attachmentId, ctx.clinicId],
  );
  if (!row) throw new NotFoundError('attachment', attachmentId);
  return shapeAttachment(row);
}

/** Raw file row (internal use: streaming, verification, export). */
export function getAttachmentFileRow(db, ctx, attachmentId) {
  const row = get(db, 'SELECT * FROM attachments WHERE id = ? AND clinic_id = ?', [attachmentId, ctx.clinicId]);
  if (!row) throw new NotFoundError('attachment', attachmentId);
  return row;
}

export function openAttachmentStream(db, ctx, attachmentId) {
  const row = getAttachmentFileRow(db, ctx, attachmentId);
  const streamed = streamStoredFile(dataDirOf(ctx), row.rel_path);
  return { ...streamed, row };
}

export function updateAttachment(db, ctx, attachmentId, input) {
  const before = getAttachmentFileRow(db, ctx, attachmentId);
  const values = assertValid(
    input,
    {
      title: { type: 'string', maxLength: 160, nullable: true },
      description: { type: 'text', maxLength: 2000, nullable: true },
      category: { type: 'enum', values: ATTACHMENT_CATEGORIES },
      original_name: { type: 'string', maxLength: 200, nullable: true },
      captured_on: { type: 'date', nullable: true },
      is_archived: { type: 'boolean' },
    },
    { partial: true },
  );
  const columns = Object.keys(values);
  if (!columns.length) return shapeAttachment(before);
  run(
    db,
    `UPDATE attachments SET ${columns.map((col) => `${col} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    [
      ...columns.map((col) => {
        if (col === 'original_name') return safeDownloadName(values[col], before.stored_name);
        if (col === 'is_archived') return values[col] ? 1 : 0;
        return values[col];
      }),
      nowIso(),
      attachmentId,
    ],
  );
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'update_attachment',
    module: 'attachments',
    entity: 'attachment',
    entityId: attachmentId,
    summary: `Attachment updated (${columns.join(', ')})`,
    severity: 'info',
    before: Object.fromEntries(columns.map((col) => [col, before[col]])),
    after: values,
  });
  return getAttachment(db, ctx, attachmentId);
}

export function archiveAttachment(db, ctx, attachmentId, archived = true) {
  return updateAttachment(db, ctx, attachmentId, { is_archived: archived });
}

/** Re-verify the stored file against its recorded hash. */
export async function verifyAttachment(db, ctx, attachmentId) {
  const row = getAttachmentFileRow(db, ctx, attachmentId);
  const absolutePath = resolveStoredPath(dataDirOf(ctx), row.rel_path);
  if (!fileExists(absolutePath)) {
    return { id: attachmentId, ok: false, reason: 'missing', expected: row.sha256 };
  }
  const { sha256, sizeBytes } = await hashFile(absolutePath);
  const ok = sha256 === row.sha256 && sizeBytes === Number(row.size_bytes);
  return { id: attachmentId, ok, reason: ok ? null : 'hash_mismatch', expected: row.sha256, actual: sha256, sizeBytes };
}

/**
 * Delete an attachment. Soft delete (default) keeps the row for the audit trail
 * while hiding it from the UI; permanent deletion removes row + file.
 */
/**
 * Soft-delete (or permanently remove) an attachment.
 * @param {any} db
 * @param {any} ctx
 * @param {number} attachmentId
 * @param {{ permanent?: boolean, reason?: string|null }} [options]
 */
export function deleteAttachment(db, ctx, attachmentId, { permanent = false, reason = null } = {}) {
  const row = getAttachmentFileRow(db, ctx, attachmentId);
  if (permanent) {
    return withTransaction(db, () => {
      run(db, 'DELETE FROM attachments WHERE id = ?', [attachmentId]);
      removeStoredFile(dataDirOf(ctx), row.rel_path);
      recordAudit(db, {
        clinicId: ctx.clinicId,
        userId: ctx.user?.id ?? null,
        userName: ctx.user?.displayName ?? null,
        action: 'delete_attachment',
        module: 'attachments',
        entity: 'attachment',
        entityId: attachmentId,
        summary: `Attachment permanently deleted: ${row.original_name}${reason ? ` (${reason})` : ''}`,
        severity: 'warning',
        before: { original_name: row.original_name, sha256: row.sha256, category: row.category },
      });
      return { deleted: true, permanent: true };
    });
  }
  run(db, 'UPDATE attachments SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?', [
    nowIso(),
    ctx.user?.id ?? null,
    nowIso(),
    attachmentId,
  ]);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'delete_attachment',
    module: 'attachments',
    entity: 'attachment',
    entityId: attachmentId,
    summary: `Attachment removed: ${row.original_name}${reason ? ` (${reason})` : ''}`,
    severity: 'notice',
    before: { original_name: row.original_name, category: row.category },
  });
  return { deleted: true, permanent: false };
}

export function restoreAttachment(db, ctx, attachmentId) {
  const row = getAttachmentFileRow(db, ctx, attachmentId);
  run(db, 'UPDATE attachments SET deleted_at = NULL, deleted_by = NULL, updated_at = ? WHERE id = ?', [nowIso(), attachmentId]);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'restore_attachment',
    module: 'attachments',
    entity: 'attachment',
    entityId: attachmentId,
    summary: `Attachment restored: ${row.original_name}`,
    severity: 'notice',
  });
  return getAttachment(db, ctx, attachmentId);
}

/** Export a copy of the stored file to a user selected folder. */
export function exportAttachment(db, ctx, attachmentId, destinationDir) {
  const row = getAttachmentFileRow(db, ctx, attachmentId);
  const targetName = safeDownloadName(row.original_name, `attachment.${row.extension}`);
  const target = `${destinationDir}/${row.id}-${targetName}`;
  copyStoredFile(dataDirOf(ctx), row.rel_path, target);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'export_attachment',
    module: 'attachments',
    entity: 'attachment',
    entityId: attachmentId,
    summary: `Attachment exported to ${destinationDir}`,
    severity: 'info',
  });
  return { path: target };
}

/** Storage utilisation shown in Settings → Data. */
export function attachmentUsage(db, ctx) {
  const row = get(
    db,
    `SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes
       FROM attachments WHERE clinic_id = ? AND deleted_at IS NULL`,
    [ctx.clinicId],
  );
  const byCategory = all(
    db,
    `SELECT category, COUNT(*) AS files, COALESCE(SUM(size_bytes),0) AS bytes
       FROM attachments WHERE clinic_id = ? AND deleted_at IS NULL GROUP BY category ORDER BY bytes DESC`,
    [ctx.clinicId],
  );
  return {
    root: ctx.dataDir ? attachmentsRoot(ctx.dataDir) : null,
    files: Number(row?.files ?? 0),
    bytes: Number(row?.bytes ?? 0),
    byCategory: byCategory.map((item) => ({ category: item.category, files: Number(item.files), bytes: Number(item.bytes) })),
  };
}

/** Bulk integrity check (Settings → Data → Verify attachments). */
export async function verifyAllAttachments(db, ctx, { limit = 500 } = {}) {
  const rows = all(
    db,
    'SELECT id, rel_path, sha256, size_bytes FROM attachments WHERE clinic_id = ? AND deleted_at IS NULL ORDER BY id LIMIT ?',
    [ctx.clinicId, limit],
  );
  const problems = [];
  let checked = 0;
  for (const row of rows) {
    const absolutePath = resolveStoredPath(dataDirOf(ctx), row.rel_path);
    if (!fileExists(absolutePath)) {
      problems.push({ id: row.id, reason: 'missing' });
      continue;
    }
    const { sha256, sizeBytes } = await hashFile(absolutePath);
    if (sha256 !== row.sha256 || sizeBytes !== Number(row.size_bytes)) {
      problems.push({ id: row.id, reason: 'hash_mismatch' });
    }
    checked += 1;
  }
  return { checked, total: rows.length, problems };
}
