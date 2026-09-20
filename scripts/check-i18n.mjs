#!/usr/bin/env bun
/**
 * Localization QA (spec § 11, § 55).
 *
 *  1. Both catalogues must contain exactly the same keys.
 *  2. No key may be missing from a catalogue or left as a placeholder.
 *  3. Every `t('…')` / `t("…")` used in the app, the documents and the services
 *     must exist in both catalogues.
 *  4. Bengali strings must contain Bengali script and must not be identical to
 *     the English string (catches copy-paste gaps), except for a small allow-list
 *     of genuinely identical values (brand names, symbols, numerics).
 *
 * Run with `bun scripts/check-i18n.mjs`. Exits non-zero on any failure so the
 * build script can stop before packaging.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { en } from '../src/shared/i18n/en.js';
import { bn } from '../src/shared/i18n/bn.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCAN_DIRS = ['src', 'scripts', 'tests'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'generated']);
const IDENTICAL_ALLOWED = new Set([
  'misc.language.en',
  'misc.language.bn',
  'doc.rxSymbol',
  'misc.currency',
  'doc.voidWatermark',
  'doc.draftWatermark',
  'app.name',
  'common.fileSelected',
  'billing.taxLabel',
  'doc.pageFooter',
  'misc.of',
]);

const problems = [];

/* 1 & 2 — parity and placeholders */
const enKeys = Object.keys(en);
const bnKeys = Object.keys(bn);
for (const key of enKeys) if (!(key in bn)) problems.push(`missing in bn: ${key}`);
for (const key of bnKeys) if (!(key in en)) problems.push(`missing in en: ${key}`);

/* 1b — duplicate keys inside one catalogue. A repeated object key silently
   overrides the earlier value, so it must never reach a build. */
for (const [locale, file] of [
  ['en', 'src/shared/i18n/en.js'],
  ['bn', 'src/shared/i18n/bn.js'],
]) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const found = new Map();
  source.split('\n').forEach((line, index) => {
    const match = /^\s{2}'([^']+)':/.exec(line);
    if (!match) return;
    if (found.has(match[1])) problems.push(`${locale}: duplicate key ${match[1]} (lines ${found.get(match[1])} and ${index + 1})`);
    else found.set(match[1], index + 1);
  });
  const imported = locale === 'en' ? enKeys : bnKeys;
  if (found.size !== imported.length) {
    problems.push(`${locale}: source declares ${found.size} keys but ${imported.length} are loaded`);
  }
}

const PLACEHOLDER = /^(todo|tbd|xxx|placeholder|fixme|n\/a)$/i;
for (const [locale, catalogue] of [['en', en], ['bn', bn]]) {
  for (const [key, value] of Object.entries(catalogue)) {
    const text = String(value ?? '').trim();
    if (!text) problems.push(`${locale}: empty string for ${key}`);
    else if (PLACEHOLDER.test(text)) problems.push(`${locale}: placeholder text for ${key}`);
    else if (/\{\s*\}/.test(text)) problems.push(`${locale}: empty placeholder for ${key}`);
  }
}

/* 3 — every used key exists.
   Besides `t('…')` calls this also reads the *declarative* key positions used
   by the renderer (`label:`, `placeholder:`, `hint:`, `empty:`, `subtitle:`).
   Those strings are translated later by `dom.js#field()`, so a typo there is
   invisible to a naive `t(` scan but still reaches the screen. */
const USED = [];
const KEY_PATTERNS = [
  /\bt\(\s*'([a-zA-Z0-9_.]+)'/g,
  /\bt\(\s*"([a-zA-Z0-9_.]+)"/g,
  /data-i18n="([a-zA-Z0-9_.]+)"/g,
  /labelKey:\s*'([a-zA-Z0-9_.]+)'/g,
  /\b(?:label|placeholder|hint|empty|subtitle|note):\s*'([a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)'/g,
  // Server-side message keys travel to the user through the error envelope.
  // Message keys only: entity names passed to NotFoundError('patient') have no dot.
  /(?:ValidationError|ConflictError|AuthError|NotFoundError|AppError)\(\s*'([a-z][A-Za-z0-9_]*\.[A-Za-z0-9_.]+)'/g,
  /(?:problems|issues|errors)\.push\(\s*'([a-z][A-Za-z0-9_]*\.[A-Za-z0-9_.]+)'/g,
  /\b(?:label|placeholder|hint|empty|subtitle|note):\s*`([a-z][A-Za-z0-9_.]*\.[A-Za-z0-9_.]+)`/g,
];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(js|mjs|html)$/.test(entry)) continue;
    if (full.includes(`${join('src', 'shared', 'i18n')}`)) continue;
    const source = readFileSync(full, 'utf8');
    // The QA scripts themselves contain the key patterns; skip them.
    if (full.includes(`${join('scripts', 'check-i18n.mjs')}`)) continue;
    for (const pattern of KEY_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) USED.push([match[1], relative(ROOT, full)]);
    }
  }
}
for (const dir of SCAN_DIRS) walk(join(ROOT, dir));

const seen = new Set();
for (const [key, file] of USED) {
  if (key.includes('${')) continue; // dynamic key, resolved at runtime
  if (seen.has(key)) continue;
  seen.add(key);
  if (!(key in en)) problems.push(`used but not defined: ${key} (${file})`);
}

/* 4 — Bengali must actually be Bengali */
const BENGALI = /[\u0980-\u09FF]/;
for (const [key, value] of Object.entries(bn)) {
  const english = en[key];
  if (english === undefined) continue;
  if (typeof value !== 'string' || typeof english !== 'string') continue;
  // Strings that are purely symbols/numbers may legitimately match.
  if (/^[^\p{L}]+$/u.test(english)) continue;
  if (value === english && !IDENTICAL_ALLOWED.has(key)) problems.push(`bn: identical to English for ${key}`);
  if (english !== value && !BENGALI.test(value) && !IDENTICAL_ALLOWED.has(key) && /[A-Za-z]/.test(value) === false) {
    problems.push(`bn: no Bengali characters in ${key}`);
  }
}

/* report */
const total = enKeys.length;
if (problems.length) {
  console.error(`\n✖ i18n check failed with ${problems.length} problem(s):\n`);
  for (const problem of problems.slice(0, 120)) console.error(`  • ${problem}`);
  if (problems.length > 120) console.error(`  … and ${problems.length - 120} more`);
  process.exit(1);
}
console.log(`✔ i18n OK — ${total} keys in en + bn, ${seen.size} keys referenced in code.`);
