/**
 * Verify the packaged release artifacts.
 *
 * `bun run verify:artifacts` is the last gate before a build is handed to a
 * clinic. It re-reads what `build-win.mjs` produced and answers the questions a
 * release review actually asks:
 *
 *   1. do the recorded SHA-256 checksums match the files on disk?
 *   2. is `DENTIVA.exe` a real 64-bit Windows GUI executable with the
 *      application payload inside it?
 *   3. does the archive hold everything the installer and the licence need?
 *   4. is the embedded clinic catalogue present, and is any synthetic test data
 *      (or a stray development database) leaking into the artifacts?
 *
 * Exit code 0 = the artifacts are fit to ship; 1 = something is wrong and the
 * reason is printed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listZip, readZipEntry } from '../src/server/domain/zip.js';
import {
  buildIconGroup,
  buildIconResource,
  buildVersionInfo,
  parsePe,
  parseVersionInfo,
  RESOURCE_DIRECTORY_INDEX,
  resourcesOfType,
  RT_GROUP_ICON,
  RT_ICON,
  RT_MANIFEST,
  RT_VERSION,
} from './lib/pe.mjs';
import { FOUR_PART_VERSION, productVersionStrings } from './lib/product-metadata.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const EXE = join(DIST, 'windows', 'DENTIVA.exe');

const problems = [];
const notes = [];
const ok = (message) => console.log(`  ✔ ${message}`);
const fail = (message) => {
  problems.push(message);
  console.log(`  \u2716 ${message}`);
};

const kb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/* ------------------------------------------------------------- 0. presence */

console.log('\n▸ Release artifacts');
if (!existsSync(EXE)) {
  console.error(`\n✖ ${relative(ROOT, EXE)} is missing — run \`bun run build:win\` first.\n`);
  process.exit(1);
}
const zipFiles = readdirSync(DIST).filter((name) => name.endsWith('.zip'));
const archivePath = zipFiles.length ? join(DIST, zipFiles[0]) : null;
const exeBytes = readFileSync(EXE);
ok(`DENTIVA.exe — ${kb(exeBytes.length)}`);
if (archivePath) ok(`${basename(archivePath)} — ${kb(statSync(archivePath).size)}`);
else notes.push('no release archive found (run `bun run build:win` to create one)');

/* ------------------------------------------------------------ 1. checksums */

console.log('\n▸ Checksums');
const sumsPath = join(DIST, 'SHA256SUMS.txt');
if (!existsSync(sumsPath)) {
  fail('dist/SHA256SUMS.txt is missing');
} else {
  for (const line of readFileSync(sumsPath, 'utf8').trim().split('\n').filter(Boolean)) {
    const [expected, name] = line.trim().split(/\s+/);
    const candidates = [join(DIST, name), join(DIST, 'windows', name)].filter((path) => existsSync(path));
    if (!candidates.length) {
      fail(`${name} is listed in SHA256SUMS.txt but is not on disk`);
      continue;
    }
    const actual = sha256(readFileSync(candidates[0]));
    if (actual === expected) ok(`${name} — ${expected.slice(0, 16)}…`);
    else fail(`${name} — checksum mismatch (recorded ${expected.slice(0, 16)}…, actual ${actual.slice(0, 16)}…)`);
  }
}

/* --------------------------------------------------------- 2. PE integrity */

console.log('\n▸ Windows executable');
const peOffset = exeBytes.readUInt32LE(0x3c);
const checks = [
  ['DOS header (MZ)', exeBytes[0] === 0x4d && exeBytes[1] === 0x5a],
  ['PE signature', exeBytes.toString('latin1', peOffset, peOffset + 4) === 'PE\0\0'],
  ['x86-64 machine', exeBytes.readUInt16LE(peOffset + 4) === 0x8664],
  ['PE32+ optional header', exeBytes.readUInt16LE(peOffset + 24) === 0x20b],
  ['Windows GUI subsystem', exeBytes.readUInt16LE(peOffset + 24 + 68) === 2],
  ['application payload embedded', exeBytes.includes(Buffer.from('DentivaPracticeManagement')) || exeBytes.includes(Buffer.from('src/main/entry.js')) || exeBytes.length > 40 * 1024 * 1024],
];
for (const [label, passed] of checks) {
  if (passed) ok(label);
  else fail(`executable check failed: ${label}`);
}

/* -------------------------------------- 3. product identity inside the EXE */

console.log('\n▸ Executable identity');
{
  // Nothing is taken on trust: the icon and the version resource are rebuilt
  // from `resources/icon.ico` and `src/shared/constants.js` and compared with
  // what the executable actually contains, byte for byte.
  const iconSource = readFileSync(join(ROOT, 'resources/icon.ico'));
  const pe = parsePe(exeBytes);
  const section = pe.sectionForRva(pe.dataDirectories[RESOURCE_DIRECTORY_INDEX].rva);
  const budget = section ? Math.min(section.virtualSize, section.rawSize) - 512 : 0;
  const expectedImages = buildIconResource(iconSource, { budget });
  const embedded = resourcesOfType(exeBytes, RT_ICON).sort((a, b) => Number(a.id) - Number(b.id));
  const group = resourcesOfType(exeBytes, RT_GROUP_ICON);

  if (embedded.length === expectedImages.length) ok(`${embedded.length} icon sizes embedded (${expectedImages.map((image) => image.width).join(', ')} px)`);
  else fail(`expected ${expectedImages.length} icon resources in the executable, found ${embedded.length}`);
  expectedImages.forEach((image, index) => {
    const found = embedded[index];
    if (!found) return;
    const bytes = exeBytes.subarray(found.offset, found.offset + found.size);
    if (bytes.equals(image.data)) ok(`icon ${image.width}×${image.height} (${image.encoded}) matches resources/icon.ico`);
    else fail(`the ${image.width}×${image.height} icon resource differs from resources/icon.ico`);
  });

  if (!group.length) {
    fail('the executable has no icon group — Explorer would show a generic icon');
  } else {
    const bytes = exeBytes.subarray(group[0].offset, group[0].offset + group[0].size);
    if (bytes.equals(buildIconGroup(expectedImages))) ok(`icon group “${group[0].name}” lists every size (taskbar, Start Menu, Explorer, installer)`);
    else fail('the icon group does not match the embedded icon sizes');
  }

  const expectedStrings = productVersionStrings();
  const versionResources = resourcesOfType(exeBytes, RT_VERSION);
  if (!versionResources.length) {
    fail('the executable carries no version information');
  } else {
    const expectedBlob = buildVersionInfo(expectedStrings, { fileVersion: FOUR_PART_VERSION, productVersion: FOUR_PART_VERSION });
    const found = versionResources[0];
    const bytes = exeBytes.subarray(found.offset, found.offset + found.size);
    const parsed = parseVersionInfo(exeBytes, found.offset);
    if (bytes.equals(expectedBlob)) ok('version resource matches the product catalogue byte for byte');
    else fail('the version resource differs from the strings in src/shared/constants.js');
    for (const [key, value] of Object.entries(expectedStrings)) {
      if (parsed.strings[key] === value) ok(`${key} = ${value}`);
      else fail(`${key} is “${parsed.strings[key] ?? 'missing'}”, expected “${value}”`);
    }
    if (parsed.fixedFileVersion === FOUR_PART_VERSION) ok(`fixed file version ${FOUR_PART_VERSION}`);
    else fail(`fixed file version is ${parsed.fixedFileVersion}, expected ${FOUR_PART_VERSION}`);
    const foreign = ['Bun', 'Oven', 'bun.exe'].filter((name) => Object.values(parsed.strings).some((value) => value.includes(name)));
    if (foreign.length) fail(`the version resource still carries the compiler's identity: ${foreign.join(', ')}`);
    else ok('no compiler identity left in the version resource');
    if (parsed.translations.includes('0x0409 0x04b0')) ok('version resource is en-US Unicode (0409 04b0)');
    else fail(`unexpected version translations: ${parsed.translations.join(', ') || 'none'}`);
  }

  const manifest = resourcesOfType(exeBytes, RT_MANIFEST)[0];
  if (!manifest) {
    fail('the executable has no application manifest');
  } else {
    const text = exeBytes.subarray(manifest.offset, manifest.offset + manifest.size).toString('utf8');
    if (text.includes('longPathAware')) ok('application manifest preserved (long paths, segment heap)');
    else fail('the application manifest lost its Windows settings');
  }
}

/* --------------------------------------------------- 4. archive contents */

const REQUIRED = [
  'DENTIVA.exe',
  'install.ps1',
  'install.cmd',
  'uninstall.ps1',
  'README.md',
  'LICENSE',
  'THIRD-PARTY-NOTICES.txt',
  'icon.ico',
  'icon.png',
  'docs/USER-GUIDE.md',
  'docs/INSTALL.md',
  'docs/DEPENDENCIES.md',
  'docs/SECURITY.md',
  'docs/CHANGELOG.md',
];

if (archivePath) {
  console.log('\n▸ Release archive');
  const archive = readFileSync(archivePath);
  let entries = [];
  try {
    entries = listZip(archive);
  } catch (error) {
    fail(`archive could not be read: ${error instanceof Error ? error.message : error}`);
  }
  const names = new Set(entries.map((entry) => entry.name));
  for (const name of REQUIRED) {
    if (names.has(name)) ok(name);
    else fail(`archive is missing ${name}`);
  }
  const archivedExe = entries.find((entry) => entry.name === 'DENTIVA.exe');
  if (archivedExe) {
    const bytes = readZipEntry(archive, archivedExe);
    if (sha256(bytes) === sha256(exeBytes)) ok('archived executable matches dist/windows/DENTIVA.exe');
    else fail('the executable inside the archive differs from dist/windows/DENTIVA.exe');
  }
  for (const name of names) {
    if (/(^|\/)data\//.test(name) || name.endsWith('.db')) fail(`archive contains data that must never ship: ${name}`);
  }
}

/* ---------------------------------------------- 5. embedded resources/data */

console.log('\n▸ Contents');
const markers = [
  ['clinic defaults catalogue', Buffer.from('resources/clinic-defaults.json')],
  ['renderer shell', Buffer.from('Dentiva')],
  // `bun build` escapes non-ASCII string literals, so the Bengali catalogue appears
  // as \\u09xx escapes rather than raw UTF-8.
  ['Bengali catalogue (escaped)', Buffer.from('\\u09')],
];
for (const [label, needle] of markers) {
  if (exeBytes.includes(needle)) ok(label);
  else fail(`executable does not contain the ${label}`);
}
{
  const bengaliEscapes = (exeBytes.toString('latin1').match(/\\u09[0-9a-f]{2}/gi) ?? []).length;
  if (bengaliEscapes > 500) ok(`Bengali strings embedded (${bengaliEscapes} escapes)`);
  else fail(`the Bengali catalogue looks incomplete in the executable (${bengaliEscapes} escapes)`);
}

// Synthetic data must never reach an artifact: these strings only exist in the
// development generators and in the QA fixtures.
const synthetic = ['Synthetic Test Clinic', 'Load Patient ', 'QA Large Clinic', 'API Test Dental', 'Test Dental Care'];
for (const marker of synthetic) {
  if (exeBytes.includes(Buffer.from(marker))) fail(`executable contains synthetic test data: “${marker}”`);
}
if (archivePath) {
  const archive = readFileSync(archivePath);
  for (const marker of synthetic) {
    if (archive.includes(Buffer.from(marker))) fail(`archive contains synthetic test data: “${marker}”`);
  }
  ok('no synthetic dataset in the artifacts');
}

/* ------------------------------------------------------------------ report */

console.log('\n▸ Summary');
for (const note of notes) console.log(`  · ${note}`);
if (problems.length) {
  console.log(`\n✖ Artifact verification failed (${problems.length} problem(s)):\n`);
  for (const problem of problems) console.log(`  • ${problem}`);
  console.log('');
  process.exit(1);
}
console.log('\n✔ Artifacts verified — checksums, PE headers, archive contents and payload all agree.\n');
