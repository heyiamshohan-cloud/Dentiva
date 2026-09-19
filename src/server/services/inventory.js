/**
 * Inventory and suppliers (§ 44, § 45).
 *
 * Stock is never edited directly: every change is a movement, and the item's
 * quantity is derived from the movement ledger so the numbers always reconcile
 * (§ 71). Negative stock is refused unless the clinic explicitly allows it, and
 * movements keep their cost so inventory valuation stays meaningful.
 */
import { all, get, run, withTransaction, nowIso } from '../db/connection.js';
import { resolvePaging } from '../db/query.js';
import { assertValid } from '../domain/validation.js';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors.js';
import { STOCK_CONDITIONS, STOCK_MOVEMENT_KINDS } from '../../shared/constants.js';
import { addDays, todayIso } from '../domain/dates.js';
import { recordAudit, diffForAudit } from './audit.js';
import { getSettings } from './settings.js';

/* ---------------------------------------------------------------- suppliers */

export const supplierSchema = {
  name: { type: 'string', required: true, minLength: 2, maxLength: 160 },
  contact_person: { type: 'string', maxLength: 120, nullable: true },
  phone: { type: 'string', maxLength: 32, nullable: true },
  email: { type: 'string', maxLength: 160, nullable: true },
  address: { type: 'text', maxLength: 400, nullable: true },
  products: { type: 'text', maxLength: 1000, nullable: true },
  payment_terms: { type: 'string', maxLength: 120, nullable: true },
  notes: { type: 'text', maxLength: 1000, nullable: true },
  is_active: { type: 'boolean', default: true },
};

/**
 * Public shape of the row.
 * @param {any} row
 * @returns {any}
 */
export function shapeSupplier(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    contactPerson: row.contact_person,
    phone: row.phone,
    email: row.email,
    address: row.address,
    products: row.products,
    paymentTerms: row.payment_terms,
    notes: row.notes,
    isActive: Boolean(row.is_active),
    itemCount: row.item_count === undefined ? undefined : Number(row.item_count),
    purchaseTotalMinor: row.purchase_total === undefined ? undefined : Number(row.purchase_total),
  };
}

export function listSuppliers(db, ctx, params = {}) {
  const where = ['s.clinic_id = ?', 's.deleted_at IS NULL'];
  const args = [ctx.clinicId];
  if (params.includeInactive !== true && params.includeInactive !== 'true') where.push('s.is_active = 1');
  if (params.search) {
    where.push("(s.name LIKE ? ESCAPE '\\' OR COALESCE(s.phone,'') LIKE ? ESCAPE '\\' OR COALESCE(s.contact_person,'') LIKE ? ESCAPE '\\')");
    const pattern = `%${String(params.search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(pattern, pattern, pattern);
  }
  const page = resolvePaging(params);
  const whereSql = where.join(' AND ');
  const total = Number(get(db, `SELECT COUNT(*) AS c FROM suppliers s WHERE ${whereSql}`, args)?.c ?? 0);
  const rows = all(
    db,
    `SELECT s.*,
            (SELECT COUNT(*) FROM inventory_items i WHERE i.supplier_id = s.id AND i.deleted_at IS NULL) AS item_count,
            (SELECT COALESCE(SUM(m.quantity_milli * m.unit_cost_minor) / 1000, 0) FROM stock_movements m WHERE m.supplier_id = s.id AND m.kind = 'in') AS purchase_total
       FROM suppliers s WHERE ${whereSql} ORDER BY s.name COLLATE NOCASE LIMIT ? OFFSET ?`,
    [...args, page.pageSize, page.offset],
  );
  return { rows: rows.map(shapeSupplier), total, page: page.page, pageSize: page.pageSize, pages: Math.max(1, Math.ceil(total / page.pageSize)) };
}

/**
 * Create (id = null) or update a supplier.
 * @param {any} db
 * @param {any} ctx
 * @param {number|null} supplierId
 * @param {any} input
 */
export function saveSupplier(db, ctx, supplierId, input) {
  if (supplierId) {
    const before = get(db, 'SELECT * FROM suppliers WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [supplierId, ctx.clinicId]);
    if (!before) throw new NotFoundError('supplier', supplierId);
    const values = assertValid(input, supplierSchema, { partial: true });
    const columns = Object.keys(values);
    if (columns.length) {
      run(db, `UPDATE suppliers SET ${columns.map((col) => `${col} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [
        ...columns.map((col) => (typeof values[col] === 'boolean' ? (values[col] ? 1 : 0) : values[col])),
        nowIso(),
        supplierId,
      ]);
    }
    const after = get(db, 'SELECT * FROM suppliers WHERE id = ?', [supplierId]);
    const diff = diffForAudit(before, after, [...columns]);
    recordAudit(db, {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: 'update_supplier',
      module: 'inventory',
      entity: 'supplier',
      entityId: supplierId,
      summary: `Supplier "${before.name}" updated (${diff.changed.join(', ')})`,
      severity: 'info',
      before: diff.before,
      after: diff.after,
    });
    return shapeSupplier(after);
  }
  const values = assertValid(input, supplierSchema);
  const result = run(
    db,
    `INSERT INTO suppliers (clinic_id, name, contact_person, phone, email, address, products, payment_terms, notes, is_active)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      ctx.clinicId,
      values.name,
      values.contact_person ?? null,
      values.phone ?? null,
      values.email ?? null,
      values.address ?? null,
      values.products ?? null,
      values.payment_terms ?? null,
      values.notes ?? null,
      values.is_active ? 1 : 0,
    ],
  );
  const id = Number(result.lastInsertRowid);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'create_supplier',
    module: 'inventory',
    entity: 'supplier',
    entityId: id,
    summary: `Supplier "${values.name}" added`,
    severity: 'info',
  });
  return { id, name: values.name };
}

export function deleteSupplier(db, ctx, supplierId) {
  const supplier = get(db, 'SELECT * FROM suppliers WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [supplierId, ctx.clinicId]);
  if (!supplier) throw new NotFoundError('supplier', supplierId);
  const used = get(db, 'SELECT COUNT(*) AS c FROM inventory_items WHERE supplier_id = ? AND deleted_at IS NULL', [supplierId]);
  if (Number(used?.c ?? 0) > 0) {
    run(db, 'UPDATE suppliers SET is_active = 0, updated_at = ? WHERE id = ?', [nowIso(), supplierId]);
    return { archived: true, reason: 'in_use' };
  }
  run(db, 'UPDATE suppliers SET deleted_at = ?, is_active = 0, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), supplierId]);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'delete_supplier',
    module: 'inventory',
    entity: 'supplier',
    entityId: supplierId,
    summary: `Supplier "${supplier.name}" removed`,
    severity: 'warning',
  });
  return { deleted: true };
}

/* --------------------------------------------------------------- categories */

const categorySchema = {
  name_en: { type: 'string', required: true, maxLength: 120 },
  name_bn: { type: 'string', maxLength: 120, nullable: true },
  is_active: { type: 'boolean', default: true },
  sort_order: { type: 'int', default: 0 },
};

export function listInventoryCategories(db, ctx, { includeInactive = false } = {}) {
  return all(
    db,
    `SELECT c.*, (SELECT COUNT(*) FROM inventory_items i WHERE i.category_id = c.id AND i.deleted_at IS NULL) AS item_count
       FROM inventory_categories c
      WHERE c.clinic_id = ? AND c.deleted_at IS NULL ${includeInactive ? '' : 'AND c.is_active = 1'}
      ORDER BY c.sort_order, c.name_en`,
    [ctx.clinicId],
  ).map((row) => ({
    id: Number(row.id),
    nameEn: row.name_en,
    nameBn: row.name_bn,
    isSystem: Boolean(row.is_system),
    isActive: Boolean(row.is_active),
    itemCount: Number(row.item_count),
  }));
}

export function saveInventoryCategory(db, ctx, categoryId, input) {
  if (categoryId) {
    const before = get(db, 'SELECT * FROM inventory_categories WHERE id = ? AND clinic_id = ?', [categoryId, ctx.clinicId]);
    if (!before) throw new NotFoundError('inventory_category', categoryId);
    const values = assertValid(input, categorySchema, { partial: true });
    const columns = Object.keys(values);
    if (columns.length) {
      run(db, `UPDATE inventory_categories SET ${columns.map((col) => `${col} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [
        ...columns.map((col) => (typeof values[col] === 'boolean' ? (values[col] ? 1 : 0) : values[col])),
        nowIso(),
        categoryId,
      ]);
    }
    return { id: categoryId };
  }
  const values = assertValid(input, categorySchema);
  const result = run(
    db,
    'INSERT INTO inventory_categories (clinic_id, name_en, name_bn, is_active, sort_order) VALUES (?,?,?,?,?)',
    [ctx.clinicId, values.name_en, values.name_bn ?? null, values.is_active ? 1 : 0, values.sort_order],
  );
  return { id: Number(result.lastInsertRowid) };
}

/* -------------------------------------------------------------------- items */

export const inventoryItemSchema = {
  name: { type: 'string', required: true, minLength: 2, maxLength: 160 },
  sku: { type: 'string', maxLength: 60, nullable: true },
  category_id: { type: 'id', nullable: true },
  unit: { type: 'string', maxLength: 24, default: 'pcs' },
  min_stock_milli: { type: 'int', min: 0, default: 0 },
  purchase_price_minor: { type: 'int', min: 0, default: 0 },
  sale_price_minor: { type: 'int', min: 0, default: 0 },
  supplier_id: { type: 'id', nullable: true },
  batch_no: { type: 'string', maxLength: 60, nullable: true },
  expiry_date: { type: 'date', nullable: true },
  storage_location: { type: 'string', maxLength: 120, nullable: true },
  condition: { type: 'enum', values: STOCK_CONDITIONS, default: 'good' },
  is_active: { type: 'boolean', default: true },
  notes: { type: 'text', maxLength: 1000, nullable: true },
};

export function shapeInventoryItem(row) {
  if (!row) return null;
  const quantity = Number(row.quantity_milli);
  const minStock = Number(row.min_stock_milli);
  return {
    id: Number(row.id),
    name: row.name,
    sku: row.sku,
    categoryId: row.category_id ?? null,
    categoryName: row.category_name ?? null,
    categoryNameBn: row.category_name_bn ?? null,
    unit: row.unit,
    quantityMilli: quantity,
    quantity: Math.round((quantity / 1000) * 1000) / 1000,
    minStockMilli: minStock,
    purchasePriceMinor: Number(row.purchase_price_minor),
    salePriceMinor: Number(row.sale_price_minor),
    supplierId: row.supplier_id ?? null,
    supplierName: row.supplier_name ?? null,
    batchNo: row.batch_no,
    expiryDate: row.expiry_date,
    storageLocation: row.storage_location,
    condition: row.condition,
    isActive: Boolean(row.is_active),
    isLowStock: quantity <= minStock,
    isOutOfStock: quantity <= 0,
    stockValueMinor: Math.round((quantity * Number(row.purchase_price_minor)) / 1000),
    notes: row.notes,
    updatedAt: row.updated_at,
  };
}

const ITEM_SELECT = `
  SELECT i.*, c.name_en AS category_name, c.name_bn AS category_name_bn, s.name AS supplier_name
    FROM inventory_items i
    LEFT JOIN inventory_categories c ON c.id = i.category_id
    LEFT JOIN suppliers s ON s.id = i.supplier_id`;

export function listInventoryItems(db, ctx, params = {}) {
  const where = ['i.clinic_id = ?', 'i.deleted_at IS NULL'];
  const args = [ctx.clinicId];
  if (params.includeInactive !== true && params.includeInactive !== 'true') where.push('i.is_active = 1');
  if (params.categoryId) {
    where.push('i.category_id = ?');
    args.push(Number(params.categoryId));
  }
  if (params.supplierId) {
    where.push('i.supplier_id = ?');
    args.push(Number(params.supplierId));
  }
  if (params.condition && STOCK_CONDITIONS.includes(params.condition)) {
    where.push('i.condition = ?');
    args.push(params.condition);
  }
  if (params.lowStock === true || params.lowStock === 'true') where.push('i.quantity_milli <= i.min_stock_milli');
  if (params.outOfStock === true || params.outOfStock === 'true') where.push('i.quantity_milli <= 0');
  if (params.expiringWithinDays) {
    where.push("i.expiry_date IS NOT NULL AND i.expiry_date <= ?");
    args.push(addDays(todayIso(), Number(params.expiringWithinDays)));
  }
  if (params.search) {
    where.push("(i.name LIKE ? ESCAPE '\\' OR COALESCE(i.sku,'') LIKE ? ESCAPE '\\' OR COALESCE(i.batch_no,'') LIKE ? ESCAPE '\\')");
    const pattern = `%${String(params.search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(pattern, pattern, pattern);
  }
  const page = resolvePaging(params);
  const whereSql = where.join(' AND ');
  const total = Number(get(db, `SELECT COUNT(*) AS c FROM inventory_items i WHERE ${whereSql}`, args)?.c ?? 0);
  const rows = all(db, `${ITEM_SELECT} WHERE ${whereSql} ORDER BY i.name COLLATE NOCASE LIMIT ? OFFSET ?`, [
    ...args,
    page.pageSize,
    page.offset,
  ]);
  const totals = get(
    db,
    `SELECT
        COALESCE(SUM(i.quantity_milli * i.purchase_price_minor) / 1000, 0) AS value,
        SUM(CASE WHEN i.quantity_milli <= i.min_stock_milli THEN 1 ELSE 0 END) AS low
      FROM inventory_items i WHERE ${whereSql}`,
    args,
  );
  return {
    rows: rows.map(shapeInventoryItem),
    total,
    page: page.page,
    pageSize: page.pageSize,
    pages: Math.max(1, Math.ceil(total / page.pageSize)),
    stockValueMinor: Number(totals?.value ?? 0),
    lowStockCount: Number(totals?.low ?? 0),
  };
}

export function getInventoryItem(db, ctx, itemId) {
  const row = get(db, `${ITEM_SELECT} WHERE i.id = ? AND i.clinic_id = ? AND i.deleted_at IS NULL`, [itemId, ctx.clinicId]);
  if (!row) throw new NotFoundError('inventory_item', itemId);
  const movements = all(
    db,
    `SELECT m.*, u.display_name AS created_by_name, p.full_name AS patient_name
       FROM stock_movements m
       LEFT JOIN users u ON u.id = m.created_by
       LEFT JOIN patients p ON p.id = m.patient_id
      WHERE m.item_id = ? ORDER BY m.movement_date DESC, m.id DESC LIMIT 200`,
    [itemId],
  );
  return {
    ...shapeInventoryItem(row),
    movements: movements.map((movement) => ({
      id: Number(movement.id),
      date: movement.movement_date,
      kind: movement.kind,
      quantityMilli: Number(movement.quantity_milli),
      balanceAfterMilli: Number(movement.balance_after_milli),
      unitCostMinor: Number(movement.unit_cost_minor),
      reason: movement.reason,
      referenceNo: movement.reference_no,
      patientName: movement.patient_name,
      batchNo: movement.batch_no,
      expiryDate: movement.expiry_date,
      createdBy: movement.created_by_name,
      createdAt: movement.created_at,
    })),
  };
}

export function createInventoryItem(db, ctx, input) {
  const values = assertValid(input, inventoryItemSchema);
  if (values.sku) {
    const existing = get(db, 'SELECT id FROM inventory_items WHERE clinic_id = ? AND sku = ? AND deleted_at IS NULL', [
      ctx.clinicId,
      values.sku,
    ]);
    if (existing) throw new ConflictError('inventory.duplicateSku', { sku: values.sku });
  }
  const result = run(
    db,
    `INSERT INTO inventory_items
      (clinic_id, sku, name, category_id, unit, quantity_milli, min_stock_milli, purchase_price_minor, sale_price_minor,
       supplier_id, batch_no, expiry_date, storage_location, condition, is_active, notes, created_by, updated_by)
     VALUES (?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      ctx.clinicId,
      values.sku ?? null,
      values.name,
      values.category_id ?? null,
      values.unit,
      values.min_stock_milli,
      values.purchase_price_minor,
      values.sale_price_minor,
      values.supplier_id ?? null,
      values.batch_no ?? null,
      values.expiry_date ?? null,
      values.storage_location ?? null,
      values.condition,
      values.is_active ? 1 : 0,
      values.notes ?? null,
      ctx.user?.id ?? null,
      ctx.user?.id ?? null,
    ],
  );
  const id = Number(result.lastInsertRowid);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'create_item',
    module: 'inventory',
    entity: 'inventory_item',
    entityId: id,
    summary: `Inventory item "${values.name}" created`,
    severity: 'info',
    after: { unit: values.unit, min_stock_milli: values.min_stock_milli },
  });
  return { id };
}

export function updateInventoryItem(db, ctx, itemId, input) {
  const before = get(db, 'SELECT * FROM inventory_items WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [itemId, ctx.clinicId]);
  if (!before) throw new NotFoundError('inventory_item', itemId);
  const values = assertValid(input, inventoryItemSchema, { partial: true });
  if (values.sku) {
    const duplicate = get(db, 'SELECT id FROM inventory_items WHERE clinic_id = ? AND sku = ? AND id <> ? AND deleted_at IS NULL', [
      ctx.clinicId,
      values.sku,
      itemId,
    ]);
    if (duplicate) throw new ConflictError('inventory.duplicateSku', { sku: values.sku });
  }
  const columns = Object.keys(values);
  if (!columns.length) return shapeInventoryItem(before);
  run(db, `UPDATE inventory_items SET ${columns.map((col) => `${col} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`, [
    ...columns.map((col) => (typeof values[col] === 'boolean' ? (values[col] ? 1 : 0) : values[col])),
    ctx.user?.id ?? null,
    nowIso(),
    itemId,
  ]);
  const after = get(db, 'SELECT * FROM inventory_items WHERE id = ?', [itemId]);
  const diff = diffForAudit(before, after, [...columns]);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'update_item',
    module: 'inventory',
    entity: 'inventory_item',
    entityId: itemId,
    summary: `Inventory item "${before.name}" updated (${diff.changed.join(', ')})`,
    severity: 'info',
    before: diff.before,
    after: diff.after,
  });
  return shapeInventoryItem(after);
}

/**
 * @param {any} db
 * @param {any} ctx
 * @param {number} itemId
 * @param {string|null} [reason]
 */
export function archiveInventoryItem(db, ctx, itemId, reason = null) {
  const item = get(db, 'SELECT * FROM inventory_items WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [itemId, ctx.clinicId]);
  if (!item) throw new NotFoundError('inventory_item', itemId);
  // Archiving hides the item from every picker but keeps its history readable:
  // only `is_active` changes, `deleted_at` stays NULL so `includeInactive` can
  // still surface it (and past stock movements keep their parent row).
  run(db, 'UPDATE inventory_items SET is_active = 0, updated_by = ?, updated_at = ? WHERE id = ?', [
    ctx.user?.id ?? null,
    nowIso(),
    itemId,
  ]);
  recordAudit(db, {
    clinicId: ctx.clinicId,
    userId: ctx.user?.id ?? null,
    userName: ctx.user?.displayName ?? null,
    action: 'archive_item',
    module: 'inventory',
    entity: 'inventory_item',
    entityId: itemId,
    summary: `Inventory item "${item.name}" archived${reason ? `: ${reason}` : ''}`,
    severity: 'notice',
    before: { quantity_milli: item.quantity_milli },
  });
  return { archived: true };
}

/* --------------------------------------------------------------- movements */

export const stockMovementSchema = {
  item_id: { type: 'id', required: true },
  movement_date: { type: 'date', required: true, default: () => todayIso() },
  kind: { type: 'enum', values: STOCK_MOVEMENT_KINDS, required: true },
  quantity_milli: { type: 'int', min: 0, required: true },
  unit_cost_minor: { type: 'int', min: 0, default: 0 },
  reason: { type: 'string', maxLength: 200, nullable: true },
  reference_no: { type: 'string', maxLength: 80, nullable: true },
  supplier_id: { type: 'id', nullable: true },
  patient_id: { type: 'id', nullable: true },
  treatment_id: { type: 'id', nullable: true },
  batch_no: { type: 'string', maxLength: 60, nullable: true },
  expiry_date: { type: 'date', nullable: true },
  notes: { type: 'text', maxLength: 1000, nullable: true },
};

/**
 * Record a stock movement.
 *  - `in`, `return` increase stock,
 *  - `out`, `disposal` decrease it,
 *  - `adjustment` treats `quantity_milli` as the *target* balance and stores the
 *    difference (which may be negative).
 */
export function recordStockMovement(db, ctx, input) {
  const values = assertValid(input, stockMovementSchema);
  const settings = getSettings(db, ctx.clinicId);
  const item = get(db, 'SELECT * FROM inventory_items WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [values.item_id, ctx.clinicId]);
  if (!item) throw new NotFoundError('inventory_item', values.item_id);

  const current = Number(item.quantity_milli);
  const requested = Number(values.quantity_milli);
  let delta;
  if (values.kind === 'in' || values.kind === 'return') delta = requested;
  else if (values.kind === 'out' || values.kind === 'disposal') delta = -requested;
  else delta = requested - current;

  if (delta === 0) throw new ValidationError('validation.failed', [{ field: 'quantity_milli', key: 'inventory.noChange' }]);
  const next = current + delta;
  if (next < 0 && !settings['inventory.allowNegativeStock']) {
    throw new ConflictError('inventory.insufficientStock', { availableMilli: current, requestedMilli: requested });
  }

  return withTransaction(db, () => {
    const result = run(
      db,
      `INSERT INTO stock_movements
        (clinic_id, item_id, movement_date, kind, quantity_milli, balance_after_milli, unit_cost_minor, reason, reference_no,
         supplier_id, patient_id, treatment_id, batch_no, expiry_date, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ctx.clinicId,
        values.item_id,
        values.movement_date,
        values.kind,
        delta,
        next,
        values.unit_cost_minor,
        values.reason ?? null,
        values.reference_no ?? null,
        values.supplier_id ?? null,
        values.patient_id ?? null,
        values.treatment_id ?? null,
        values.batch_no ?? null,
        values.expiry_date ?? null,
        values.notes ?? null,
        ctx.user?.id ?? null,
      ],
    );
    const itemUpdates = ['quantity_milli = ?', 'updated_at = ?'];
    const itemParams = [next, nowIso()];
    if (values.kind === 'in' && values.unit_cost_minor > 0) {
      itemUpdates.push('purchase_price_minor = ?');
      itemParams.push(values.unit_cost_minor);
    }
    if (values.batch_no) {
      itemUpdates.push('batch_no = ?');
      itemParams.push(values.batch_no);
    }
    if (values.expiry_date) {
      itemUpdates.push('expiry_date = ?');
      itemParams.push(values.expiry_date);
    }
    if (values.supplier_id) {
      itemUpdates.push('supplier_id = ?');
      itemParams.push(values.supplier_id);
    }
    run(db, `UPDATE inventory_items SET ${itemUpdates.join(', ')} WHERE id = ?`, [...itemParams, values.item_id]);

    const movementId = Number(result.lastInsertRowid);
    const audit = {
      clinicId: ctx.clinicId,
      userId: ctx.user?.id ?? null,
      userName: ctx.user?.displayName ?? null,
      action: `stock_${values.kind}`,
      module: 'inventory',
      entity: 'stock_movement',
      entityId: movementId,
      summary: `${item.name}: ${delta > 0 ? '+' : ''}${delta} milli (balance ${next})${values.reason ? ` — ${values.reason}` : ''}`,
      severity: values.kind === 'disposal' ? 'warning' : 'info',
      before: { quantity_milli: current },
      after: { quantity_milli: next },
    };
    recordAudit(db, audit);
    return { id: movementId, balanceMilli: next, deltaMilli: delta };
  });
}

export function listStockMovements(db, ctx, params = {}) {
  const where = ['m.clinic_id = ?'];
  const args = [ctx.clinicId];
  if (params.itemId) {
    where.push('m.item_id = ?');
    args.push(Number(params.itemId));
  }
  if (params.kind && STOCK_MOVEMENT_KINDS.includes(params.kind)) {
    where.push('m.kind = ?');
    args.push(params.kind);
  }
  if (params.from) {
    where.push('m.movement_date >= ?');
    args.push(params.from);
  }
  if (params.to) {
    where.push('m.movement_date <= ?');
    args.push(params.to);
  }
  const page = resolvePaging(params);
  const whereSql = where.join(' AND ');
  const total = Number(get(db, `SELECT COUNT(*) AS c FROM stock_movements m WHERE ${whereSql}`, args)?.c ?? 0);
  const rows = all(
    db,
    `SELECT m.*, i.name AS item_name, i.unit, u.display_name AS created_by_name, p.full_name AS patient_name
       FROM stock_movements m
       JOIN inventory_items i ON i.id = m.item_id
       LEFT JOIN users u ON u.id = m.created_by
       LEFT JOIN patients p ON p.id = m.patient_id
      WHERE ${whereSql} ORDER BY m.movement_date DESC, m.id DESC LIMIT ? OFFSET ?`,
    [...args, page.pageSize, page.offset],
  );
  return {
    rows: rows.map((row) => ({
      id: Number(row.id),
      itemId: Number(row.item_id),
      itemName: row.item_name,
      unit: row.unit,
      date: row.movement_date,
      kind: row.kind,
      quantityMilli: Number(row.quantity_milli),
      balanceAfterMilli: Number(row.balance_after_milli),
      unitCostMinor: Number(row.unit_cost_minor),
      reason: row.reason,
      referenceNo: row.reference_no,
      treatmentId: row.treatment_id ?? null,
      patientId: row.patient_id ?? null,
      patientName: row.patient_name,
      createdBy: row.created_by_name,
      createdAt: row.created_at,
    })),
    total,
    page: page.page,
    pageSize: page.pageSize,
    pages: Math.max(1, Math.ceil(total / page.pageSize)),
  };
}

/** Consumption of an item against a treatment (clinical → inventory link). */
export function consumeForTreatment(db, ctx, { item_id, treatment_id, quantity_milli, reason = null }) {
  const treatment = get(db, 'SELECT id, patient_id, visit_id FROM treatments WHERE id = ? AND clinic_id = ? AND deleted_at IS NULL', [
    treatment_id,
    ctx.clinicId,
  ]);
  if (!treatment) throw new NotFoundError('treatment', treatment_id);
  return recordStockMovement(db, ctx, {
    item_id,
    kind: 'out',
    quantity_milli,
    patient_id: treatment.patient_id,
    treatment_id,
    reason: reason ?? 'Used during treatment',
  });
}

/* ---------------------------------------------------------------- reporting */

export function inventoryReport(db, ctx, { expiringWithinDays = 30, lowStockLimit = 50 } = {}) {
  const lowStock = all(
    db,
    `${ITEM_SELECT} WHERE i.clinic_id = ? AND i.deleted_at IS NULL AND i.is_active = 1 AND i.quantity_milli <= i.min_stock_milli
      ORDER BY (i.quantity_milli - i.min_stock_milli) ASC LIMIT ?`,
    [ctx.clinicId, Math.min(200, Math.max(1, lowStockLimit))],
  ).map(shapeInventoryItem);
  const expiring = all(
    db,
    `${ITEM_SELECT} WHERE i.clinic_id = ? AND i.deleted_at IS NULL AND i.is_active = 1 AND i.expiry_date IS NOT NULL
        AND i.expiry_date <= ? ORDER BY i.expiry_date LIMIT 200`,
    [ctx.clinicId, addDays(todayIso(), Math.min(365, Math.max(1, expiringWithinDays)))],
  ).map((row) => ({ ...shapeInventoryItem(row), daysToExpiry: Math.round((new Date(row.expiry_date).getTime() - new Date(todayIso()).getTime()) / 86400000) }));
  const valuation = get(
    db,
    `SELECT COALESCE(SUM(i.quantity_milli * i.purchase_price_minor) / 1000, 0) AS cost,
            COALESCE(SUM(i.quantity_milli * i.sale_price_minor) / 1000, 0) AS retail,
            COUNT(*) AS items
       FROM inventory_items i WHERE i.clinic_id = ? AND i.deleted_at IS NULL AND i.is_active = 1`,
    [ctx.clinicId],
  );
  const byCategory = all(
    db,
    `SELECT COALESCE(c.name_en, 'Uncategorised') AS name, COUNT(i.id) AS items,
            COALESCE(SUM(i.quantity_milli * i.purchase_price_minor) / 1000, 0) AS value
       FROM inventory_items i LEFT JOIN inventory_categories c ON c.id = i.category_id
      WHERE i.clinic_id = ? AND i.deleted_at IS NULL AND i.is_active = 1
      GROUP BY c.id ORDER BY value DESC`,
    [ctx.clinicId],
  );
  return {
    lowStock,
    expiring,
    valuation: {
      items: Number(valuation?.items ?? 0),
      costMinor: Number(valuation?.cost ?? 0),
      retailMinor: Number(valuation?.retail ?? 0),
    },
    byCategory: byCategory.map((row) => ({ name: row.name, items: Number(row.items), valueMinor: Number(row.value) })),
  };
}
