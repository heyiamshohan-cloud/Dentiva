/**
 * Input validation.
 *
 * Every write path validates its payload *before* touching the database
 * (§ 67). Errors are returned as `{ field, key, params }` so the UI can show
 * localized messages next to the offending input.
 */
import { ValidationError } from '../../shared/errors.js';
import { isValidIsoDate, isValidIsoTime } from './dates.js';

/**
 * @typedef {object} FieldSpec
 * @property {'string'|'text'|'int'|'number'|'money'|'bool'|'date'|'time'|'enum'|'email'|'phone'|'array'|'object'|'id'} type
 * @property {boolean} [required]
 * @property {boolean} [nullable]
 * @property {number} [min] @property {number} [max]
 * @property {number} [minLength] @property {number} [maxLength]
 * @property {RegExp} [pattern]
 * @property {string[]} [values]
 * @property {any} [default]
 * @property {(value: any, input: any) => boolean} [refine]
 * @property {string} [refineKey]
 * @property {Record<string, FieldSpec>} [fields]
 * @property {string} [label]
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+]?[\d\s().-]{6,24}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function fail(errors, field, key, params) {
  errors.push({ field, key, params: params ?? {} });
  return null;
}

/**
 * Resolve a dotted path (`a.b.c`) inside a plain object.
 */
function atPath(input, path) {
  if (!path) return input;
  return path.split('.').reduce((acc, key) => (acc === null || acc === undefined ? acc : acc[key]), input);
}

/**
 * Validate and normalise a payload.
 * Unknown keys are dropped so a client cannot inject columns.
 *
 * @param {Record<string, any>} input
 * @param {Record<string, FieldSpec|any>} schema
 * @param {{ partial?: boolean, labelPrefix?: string }} [options]
 * @returns {{ values: Record<string, any>, errors: {field: string, key: string, params?: any}[] }}
 */
export function validate(input, schema, options = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const values = {};
  const errors = [];

  const defaultValue = (spec) => {
    if (spec.default === undefined) return undefined;
    const value = typeof spec.default === 'function' ? spec.default() : spec.default;
    // Clone so JSON defaults are never shared between calls.
    return value && typeof value === 'object' ? structuredClone(value) : value;
  };

  for (const [field, spec] of Object.entries(schema)) {
    const raw = source[field];
    const missing = raw === undefined;
    const blank = isBlank(raw);
    const nullable = spec.nullable ?? false;

    if (missing) {
      // Partial (PATCH) payloads only touch the keys the caller actually sent.
      if (options.partial) continue;
      const fallback = defaultValue(spec);
      // A declared default satisfies `required` (e.g. today's date).
      if (fallback !== undefined) values[field] = fallback;
      else if (spec.required) fail(errors, field, 'validation.required');
      else if (nullable) values[field] = null;
      // Otherwise the column keeps its database default.
      continue;
    }

    if (blank) {
      if (spec.required) {
        fail(errors, field, 'validation.required');
        continue;
      }
      const fallback = defaultValue(spec);
      if (fallback !== undefined) values[field] = fallback;
      else if (nullable) values[field] = null;
      continue;
    }

    switch (spec.type) {
      case 'string':
      case 'text': {
        let value = String(raw);
        if (spec.type === 'string') value = value.trim().replace(/\s+/g, ' ');
        else value = String(raw).replace(/\r\n/g, '\n');
        if (spec.minLength && value.length < spec.minLength) {
          fail(errors, field, 'validation.tooShort', { min: spec.minLength });
          continue;
        }
        if (spec.maxLength && value.length > spec.maxLength) {
          fail(errors, field, 'validation.tooLong', { max: spec.maxLength });
          continue;
        }
        if (spec.pattern && !spec.pattern.test(value)) {
          fail(errors, field, 'validation.format');
          continue;
        }
        values[field] = value;
        break;
      }
      case 'int':
      case 'number':
      case 'money': {
        const num = typeof raw === 'string' ? Number(raw.replace(/\s/g, '')) : Number(raw);
        if (!Number.isFinite(num)) {
          fail(errors, field, 'validation.number');
          continue;
        }
        if (spec.type === 'int' || spec.type === 'money') {
          if (!Number.isInteger(num) && spec.type === 'money') {
            fail(errors, field, 'validation.number');
            continue;
          }
          if (!Number.isInteger(num)) {
            fail(errors, field, 'validation.number');
            continue;
          }
        }
        if (spec.min !== undefined && num < spec.min) {
          fail(errors, field, 'validation.min', { min: spec.min });
          continue;
        }
        if (spec.max !== undefined && num > spec.max) {
          fail(errors, field, 'validation.max', { max: spec.max });
          continue;
        }
        values[field] = num;
        break;
      }
      case 'bool': {
        if (typeof raw === 'boolean') values[field] = raw;
        else if (raw === 0 || raw === 1) values[field] = raw === 1;
        else if (raw === 'true' || raw === 'false') values[field] = raw === 'true';
        else if (raw === '1' || raw === '0') values[field] = raw === '1';
        else {
          fail(errors, field, 'validation.boolean');
          continue;
        }
        break;
      }
      case 'date': {
        const value = String(raw).slice(0, 10);
        if (!isValidIsoDate(value)) {
          fail(errors, field, 'validation.date');
          continue;
        }
        values[field] = value;
        break;
      }
      case 'time': {
        const value = TIME_RE.test(String(raw)) ? String(raw) : String(raw).slice(0, 5);
        if (!isValidIsoTime(value)) {
          fail(errors, field, 'validation.time');
          continue;
        }
        values[field] = value;
        break;
      }
      case 'enum': {
        const value = String(raw);
        if (spec.values && !spec.values.includes(value)) {
          fail(errors, field, 'validation.option', { values: (spec.values ?? []).join(', ') });
          continue;
        }
        values[field] = value;
        break;
      }
      case 'email': {
        const value = String(raw).trim();
        if (!EMAIL_RE.test(value)) {
          fail(errors, field, 'validation.email');
          continue;
        }
        values[field] = value;
        break;
      }
      case 'phone': {
        const value = String(raw).trim();
        if (!PHONE_RE.test(value)) {
          fail(errors, field, 'validation.phone');
          continue;
        }
        values[field] = value;
        break;
      }
      case 'id': {
        const num = Number(raw);
        if (!Number.isInteger(num) || num <= 0) {
          fail(errors, field, 'validation.id');
          continue;
        }
        values[field] = num;
        break;
      }
      case 'array': {
        let value = raw;
        if (typeof raw === 'string') {
          try {
            value = JSON.parse(raw);
          } catch {
            value = raw.split(',').map((v) => v.trim()).filter(Boolean);
          }
        }
        if (!Array.isArray(value)) {
          fail(errors, field, 'validation.array');
          continue;
        }
        values[field] = value;
        break;
      }
      case 'object': {
        let value = raw;
        if (typeof raw === 'string') {
          try {
            value = JSON.parse(raw);
          } catch {
            fail(errors, field, 'validation.object');
            continue;
          }
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          fail(errors, field, 'validation.object');
          continue;
        }
        values[field] = value;
        break;
      }
      default:
        values[field] = raw;
    }

    if (spec.refine && !spec.refine(values[field], source)) {
      fail(errors, field, spec.refineKey ?? 'validation.invalid');
      delete values[field];
    }
  }

  return { values, errors };
}

/** Validate or throw. */
export function assertValid(input, schema, options = {}) {
  const { values, errors } = validate(input, schema, options);
  if (errors.length) {
    throw new ValidationError('validation.failed', errors);
  }
  return values;
}

/**
 * Read a value out of a query string with a default, narrowing `undefined`.
 */
export function queryValue(query, key, fallback = null) {
  const value = atPath(query ?? {}, key);
  return value === undefined || value === '' ? fallback : value;
}

export const schemas = {
  id: { type: 'id', required: true },
  optionalId: { type: 'id' },
  isoDate: { type: 'date', required: true },
  optionalDate: { type: 'date', nullable: true },
  optionalTime: { type: 'time', nullable: true },
  page: { type: 'int', min: 1, default: 1 },
  pageSize: { type: 'int', min: 1, max: 500, default: 25 },
};
