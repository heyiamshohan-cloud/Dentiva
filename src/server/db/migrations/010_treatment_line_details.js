/**
 * Migration 010 — treatment line details.
 *
 * A treatment records what was charged (`fee_minor`, `discount_minor`,
 * `tax_minor`, `total_minor`), but the two inputs needed to reproduce those
 * numbers were never stored: how many units were done (`quantity_milli`) and the
 * tax rate that was applied (`tax_rate_bp`). Without them, editing a treatment
 * that was recorded as "3 × 1 000" recomputed it as "1 × 1 000" and silently
 * changed the amount the patient owes.
 *
 * The migration only *adds* two columns with safe defaults, so every existing
 * row keeps its stored money exactly as it is (`quantity_milli` defaults to
 * 1000 = "1 unit", which is how those rows were calculated). Nothing is
 * rewritten or dropped.
 *
 * @param {import('bun:sqlite').Database} db
 */
export const id = 10;
export const name = 'treatment_line_details';

export function up(db) {
  const columns = new Set(db.query('PRAGMA table_info(treatments)').all().map((row) => row.name));
  if (!columns.has('quantity_milli')) {
    db.exec('ALTER TABLE treatments ADD COLUMN quantity_milli INTEGER NOT NULL DEFAULT 1000');
  }
  if (!columns.has('tax_rate_bp')) {
    db.exec('ALTER TABLE treatments ADD COLUMN tax_rate_bp INTEGER NOT NULL DEFAULT 0');
  }
}
