/**
 * DENTIVA — Windows build.
 *
 * Produces the shippable artifacts in `dist/`:
 *
 *   dist/windows/DENTIVA.exe                        portable application (single file)
 *   dist/DENTIVA-1.0.0-win-x64.zip                  application + installer + docs
 *   dist/SHA256SUMS.txt                             checksums for everything above
 *
 * Steps: quality gates → icon → embedded assets → compile for bun-windows-x64 →
 * stamp version information and the icon into the PE file → verify → package →
 * checksums → verify the packaged artifacts (`scripts/verify-artifacts.mjs`).
 *
 *   bun run build:win                full build with tests
 *   bun run build:win --skip-tests   faster build while iterating
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { APP_CREATOR_EMAIL, APP_CREATOR_WHATSAPP, APP_NAME, APP_PUBLISHER, APP_TAGLINE, APP_VERSION, BUILD_NUMBER, SCHEMA_VERSION } from '../src/shared/constants.js';
import { describeProduct } from './lib/product-metadata.mjs';
import { createZip } from '../src/server/domain/zip.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const WIN_DIR = join(DIST, 'windows');
const EXE = 'DENTIVA.exe';
const TARGET = 'bun-windows-x64';
const args = process.argv.slice(2);
const skipTests = args.includes('--skip-tests');
const keepAssets = args.includes('--keep-assets');
const noPackage = args.includes('--no-package');

const started = Date.now();
const log = (message) => console.log(message);
const step = (message) => console.log(`\n▸ ${message}`);

function run(command, commandArgs, { allowFailure = false } = {}) {
  const result = spawnSync(command, commandArgs, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed with exit code ${result.status}`);
  }
  return result.status ?? 1;
}

function bytes(value) {
  if (value > 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value > 1024) return `${(value / 1024).toFixed(1)} kB`;
  return `${value} B`;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/* ------------------------------------------------------------- quality gates */

step('Quality gates');
if (skipTests) {
  log('  skipped (--skip-tests)');
} else {
  log('  i18n catalogue …');
  run(process.execPath, ['scripts/check-i18n.mjs']);
  log('  type check …');
  run(process.execPath, ['x', 'tsc', '--noEmit']);
  log('  test suite …');
  run(process.execPath, ['test', 'tests/']);
}

step('Application icon');
run(process.execPath, ['scripts/make-icon.mjs']);

step('Embedding assets');
run(process.execPath, ['scripts/gen-assets.mjs']);

/* ------------------------------------------------------------------ compile */

step(`Compiling for ${TARGET}`);
rmSync(WIN_DIR, { recursive: true, force: true });
mkdirSync(WIN_DIR, { recursive: true });
const exePath = join(WIN_DIR, EXE);
// Windows shell integration (product name, publisher, version, executable icon,
// hidden console). Bun only accepts these switches when the build itself runs on
// Windows, so a cross-compiled image is produced without them and the shortcuts
// carry the icon instead — see docs/INSTALL.md.
const shellMetadata = process.platform === 'win32'
  ? [
    '--windows-hide-console',
    `--windows-icon=${join(ROOT, 'resources/icon.ico')}`,
    `--windows-title=${APP_NAME}`,
    `--windows-publisher=${APP_PUBLISHER}`,
    `--windows-version=${APP_VERSION}.${BUILD_NUMBER}`,
    `--windows-description=${APP_NAME} — ${APP_TAGLINE}`,
    `--windows-copyright=© ${new Date().getFullYear()} ${APP_PUBLISHER}`,
  ]
  : [];
run(process.execPath, [
  'build',
  '--compile',
  `--target=${TARGET}`,
  '--outfile',
  exePath,
  ...shellMetadata,
  'src/main/entry.js',
]);
if (!existsSync(exePath)) throw new Error('the compiler did not produce an executable');
log(`  ${EXE} — ${bytes(statSync(exePath).size)}`);

/* -------------------------------------------------- version info + PE icon */

step('Windows metadata (icon and version information)');
// Bun writes the resource section itself when the build runs on Windows; the
// stamper then rewrites it from the same sources, so a cross-compiled image and
// a native one carry byte-identical resources. Without it the file would keep
// `bun.exe`'s icon and show "Oven" as the publisher in Explorer.
const iconFile = join(ROOT, 'resources/icon.ico');
if (!existsSync(iconFile)) throw new Error('resources/icon.ico is missing — run `bun run icon` first');
run(process.execPath, ['scripts/stamp-exe.mjs', exePath]);
log(`  ${describeProduct()} · icon ${readFileSync(iconFile).readUInt16LE(4)} sizes`);

/* ------------------------------------------------------------------- verify */

step('Setting the Windows subsystem');
// A GUI-subsystem image never opens a console window — the same result Bun's
// `--windows-hide-console` produces on Windows. Cross-compiling does not support
// that switch, so the two-byte field in the optional header is written here and
// re-read to prove the image is still a valid PE32+ file.
if (shellMetadata.length) {
  log('  already set by the compiler (built on Windows)');
} else {
  const image = readFileSync(exePath);
  const header = image.readUInt32LE(0x3c);
  const subsystemAt = header + 24 + 68;
  const before = image.readUInt16LE(subsystemAt);
  if (before !== 2) {
    image.writeUInt16LE(2, subsystemAt);
    writeFileSync(exePath, image);
    log(`  subsystem ${before} (console) → 2 (Windows GUI)`);
  } else {
    log('  subsystem 2 (Windows GUI)');
  }
  // The CLI switches still print: the launcher re-attaches the parent console.
}

step('Verifying the executable');
const exeBytes = readFileSync(exePath);
const MACHINE_X64 = 0x8664;
const isMz = exeBytes.length > 0x40 && exeBytes[0] === 0x4d && exeBytes[1] === 0x5a;
const peOffset = isMz ? exeBytes.readUInt32LE(0x3c) : 0;
const signature = isMz && peOffset + 4 < exeBytes.length ? exeBytes.toString('ascii', peOffset, peOffset + 4) : '';
const isPe = signature === 'PE\0\0';
if (!isPe) throw new Error('the built file is not a Windows PE executable');
const machine = exeBytes.readUInt16LE(peOffset + 4);
const sections = exeBytes.readUInt16LE(peOffset + 6);
const optionalMagic = exeBytes.readUInt16LE(peOffset + 24);
const subsystem = exeBytes.readUInt16LE(peOffset + 24 + 68);
const embedded = exeBytes.includes(Buffer.from(APP_NAME, 'utf8'));
log(`  DOS header: ${isMz ? 'MZ' : 'missing'} · PE signature: ${signature.replace(/\0/g, '.')}`);
log(`  machine: 0x${machine.toString(16)} (${machine === MACHINE_X64 ? 'x86-64' : 'unexpected'}) · sections: ${sections}`);
log(`  optional header: ${optionalMagic === 0x20b ? 'PE32+' : `0x${optionalMagic.toString(16)}`} · subsystem: ${subsystem} (${subsystem === 2 ? 'Windows GUI' : subsystem === 3 ? 'console' : 'other'})`);
log(`  embedded application payload: ${embedded ? 'found' : 'MISSING'}`);
if (machine !== MACHINE_X64) throw new Error(`expected an x86-64 image, found machine 0x${machine.toString(16)}`);
if (!embedded) throw new Error('the compiled payload does not contain the application');

if (process.platform === 'win32') {
  const version = run(process.execPath, [exePath, '--version'], { allowFailure: true }) === 0;
  log(`  exec smoke test: ${version ? 'ok' : 'failed'}`);
} else {
  log('  exec smoke test: skipped (Windows binary cannot be started on this platform)');
}

/* ---------------------------------------------------------------- packaging */

const artifacts = [exePath];

if (!noPackage) {
  step('Packaging the release archive');
  const zipName = `${APP_NAME.toUpperCase()}-${APP_VERSION}-win-x64.zip`;
  const zipPath = join(DIST, zipName);

  const include = [
    [join(WIN_DIR, EXE), EXE],
    [join(ROOT, 'resources/installer/install.ps1'), 'install.ps1'],
    [join(ROOT, 'resources/installer/install.cmd'), 'install.cmd'],
    [join(ROOT, 'resources/installer/uninstall.ps1'), 'uninstall.ps1'],
    [join(ROOT, 'README.md'), 'README.md'],
    [join(ROOT, 'LICENSE'), 'LICENSE'],
    [join(ROOT, 'THIRD-PARTY-NOTICES.txt'), 'THIRD-PARTY-NOTICES.txt'],
    [join(ROOT, 'resources/icon.png'), 'icon.png'],
    [join(ROOT, 'resources/icon.ico'), 'icon.ico'],
  ];
  for (const file of [
    'docs/USER-GUIDE.md',
    'docs/INSTALL.md',
    'docs/DEPENDENCIES.md',
    'docs/SECURITY.md',
    'docs/ARCHITECTURE.md',
    'docs/DATA-MODEL.md',
    'docs/CHANGELOG.md',
  ]) {
    include.push([join(ROOT, file), file]);
  }

  const entries = [];
  for (const [source, name] of include) {
    if (!existsSync(source)) continue;
    const data = readFileSync(source);
    // Everything is deflated (the executable compresses to roughly half its
    // size) so the download stays small; only tiny files are stored raw.
    entries.push({ name, data, mtime: statSync(source).mtime, store: data.length < 96 });
  }
  writeFileSync(zipPath, createZip(entries));
  artifacts.push(zipPath);
  log(`  ${zipName} — ${bytes(statSync(zipPath).size)} (${entries.length} files)`);
}

/* ---------------------------------------------------------------- checksums */

const manifest = artifacts
  .filter((path) => existsSync(path))
  .map((path) => `${sha256(path)}  ${basename(path)}`)
  .join('\n');
writeFileSync(join(DIST, 'SHA256SUMS.txt'), `${manifest}\n`);
artifacts.push(join(DIST, 'SHA256SUMS.txt'));

/* ------------------------------------------------------- artifact gate */

step('Verifying the packaged artifacts');
run(process.execPath, ['scripts/verify-artifacts.mjs']);

/* ------------------------------------------------------------------ cleanup */

if (!keepAssets) {
  // Keep the repository (and a plain `bun run start`) reading real files.
  run(process.execPath, ['scripts/gen-assets.mjs', '--stub']);
}

const seconds = ((Date.now() - started) / 1000).toFixed(0);
log('\nBuild finished');
for (const path of artifacts) log(`  ${relative(ROOT, path)} — ${bytes(statSync(path).size)}`);
log(`  ${seconds}s · ${APP_NAME} ${APP_VERSION} build ${BUILD_NUMBER} · schema v${SCHEMA_VERSION}`);
log('\nSHA256');
log(manifest.split('\n').map((line) => `  ${line}`).join('\n'));
