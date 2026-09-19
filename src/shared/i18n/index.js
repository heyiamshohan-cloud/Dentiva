/**
 * Localization runtime (spec § 11, § 55).
 *
 * Both catalogues are plain objects; this module flattens nothing and adds no
 * dependency. `translate()` handles `{placeholder}` interpolation and falls back
 * to English, then to the key itself (so a missing string is visible in QA rather
 * than printing `undefined` to a patient).
 */
import { en } from './en.js';
import { bn } from './bn.js';

export const CATALOGUES = { en, bn };
export const LOCALES = /** @type {const} */ (['en', 'bn']);
export const LOCALE_LABELS = { en: 'English', bn: 'বাংলা' };

export function isLocale(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CATALOGUES, value);
}

export function normaliseLocale(value, fallback = 'en') {
  return isLocale(value) ? value : fallback;
}

/**
 * Interpolate `{name}` placeholders.
 * @param {string} template
 * @param {Record<string, any>} [params]
 */
export function interpolate(template, params = {}) {
  if (!params) return template;
  return String(template).replace(/\{(\w+)\}/g, (match, key) => {
    const value = params[key];
    if (value === undefined || value === null) return match;
    return String(value);
  });
}

/**
 * Translate a key.
 * @param {string} locale
 * @param {string} key
 * @param {Record<string, any>} [params]
 */
export function translate(locale, key, params) {
  const catalogue = CATALOGUES[locale] ?? CATALOGUES.en;
  const template = catalogue[key] ?? CATALOGUES.en[key];
  if (template === undefined) return key;
  return interpolate(template, params);
}

/** Bind a locale once (used by the renderer and the print documents). */
export function createTranslator(locale, fallback = 'en') {
  const active = normaliseLocale(locale, fallback);
  const translateBound = (key, params) => translate(active, key, params);
  translateBound.locale = active;
  return translateBound;
}

/** Every key of a locale, for the renderer's client-side copy of the catalogue. */
export function catalogueFor(locale) {
  const active = normaliseLocale(locale);
  return { locale: active, strings: CATALOGUES[active], fallback: active === 'en' ? null : CATALOGUES.en };
}

/** Concatenate `common.yes`/`common.no` style labels without leaking `undefined`. */
export function booleanLabel(locale, value) {
  return translate(locale, value ? 'misc.yes' : 'misc.no');
}

/** Currency-aware document number words are intentionally out of scope for v1. */
export function localeDirection() {
  return 'ltr';
}
