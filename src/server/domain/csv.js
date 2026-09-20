/**
 * CSV read/write (RFC 4180 subset) used by the report exports and the data
 * import tools (§ 48, § 49).
 *
 * Written by hand on purpose: no dependency, exact control over quoting, and the
 * same module is used for writing and for parsing so round-trips are lossless.
 */

/** Quote a single field when it needs it. */
export function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * @param {{ key: string, label?: string }[]} columns
 * @param {Record<string, any>[]} rows
 * @param {{ headers?: string[], delimiter?: string, bom?: boolean, newline?: string }} [options]
 */
export function buildCsv(columns, rows, options = {}) {
  const delimiter = options.delimiter ?? ',';
  const newline = options.newline ?? '\r\n';
  const headers = options.headers ?? columns.map((column) => column.label ?? column.key);
  const lines = [headers.map(escapeCsv).join(delimiter)];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsv(row[column.key])).join(delimiter));
  }
  const body = lines.join(newline);
  // A BOM keeps Bengali text readable when the file is opened in Excel.
  return `${options.bom === false ? '' : '\uFEFF'}${body}${newline}`;
}

/**
 * Parse CSV text into an array of row objects keyed by the header row.
 * Handles quoted fields, embedded newlines, CRLF, and a leading BOM.
 * @param {string} text
 * @param {{ delimiter?: string, maxRows?: number }} [options]
 */
export function parseCsv(text, options = {}) {
  const delimiter = options.delimiter ?? ',';
  const maxRows = options.maxRows ?? 50000;
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (rows.length >= maxRows) break;
    } else if (char === '\r') {
      // handled by the following \n
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return { headers: [], rows: [] };

  const headers = (rows.shift() ?? []).map((header) => String(header).trim());
  const objects = rows
    .filter((line) => line.some((value) => String(value).trim() !== ''))
    .map((line) => {
      const record = {};
      headers.forEach((header, index) => {
        record[header] = line[index] === undefined ? '' : String(line[index]);
      });
      return record;
    });
  return { headers, rows: objects };
}

/** Numeric field for import files: blank becomes null, bad input becomes NaN. */
export function csvNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const normalised = String(value).replace(/[,\s৳]/g, '');
  const number = Number(normalised);
  return Number.isFinite(number) ? number : Number.NaN;
}

export function csvBoolean(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'হ্যাঁ'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'না', ''].includes(text)) return false;
  return null;
}
