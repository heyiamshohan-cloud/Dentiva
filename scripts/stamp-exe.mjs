/**
 * DENTIVA — stamp the Windows icon and version information into the executable.
 *
 *   bun scripts/stamp-exe.mjs                       stamp dist/windows/DENTIVA.exe
 *   bun scripts/stamp-exe.mjs path/to/DENTIVA.exe   stamp another image
 *   bun scripts/stamp-exe.mjs --check               only report what is embedded
 *
 * Bun only accepts `--windows-icon`/`--windows-publisher`/`--windows-version`
 * when the build runs on Windows, so a cross-compiled image would otherwise
 * keep `bun.exe`'s own icon and show "Oven" as the publisher in Explorer's
 * Details tab. This script writes the Dentiva resources into the existing
 * `.rsrc` section instead: the icon at all seven sizes plus a VERSIONINFO block
 * built from `src/shared/constants.js`. It is deterministic and idempotent, so
 * it runs after every build — on Windows too, where it guarantees the same
 * resource layout as the cross-compiled artefact.
 *
 * Only bytes inside `.rsrc` change; the code, the headers and the appended Bun
 * payload are byte-identical to the compiler's output, which the script
 * verifies before it writes.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME, APP_PUBLISHER, APP_VERSION } from '../src/shared/constants.js';
import { FOUR_PART_VERSION, productVersionStrings } from './lib/product-metadata.mjs';
import {
  buildVersionInfo,
  listResources,
  parseVersionInfo,
  resourcesOfType,
  RT_GROUP_ICON,
  RT_ICON,
  RT_MANIFEST,
  RT_VERSION,
  stampExecutable,
} from './lib/pe.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const target = join(ROOT, 'dist/windows/DENTIVA.exe');
const exePath = args.find((argument) => !argument.startsWith('--')) ?? target;
const iconPath = join(ROOT, 'resources/icon.ico');
const fourPartVersion = FOUR_PART_VERSION;

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

if (!existsSync(exePath)) {
  console.error(`✖ ${relative(ROOT, exePath)} does not exist — run \`bun run build:win\` first.`);
  process.exit(1);
}

/**
 * Read back what the image says about itself.
 * @param {Buffer} buffer
 */
export function describeExecutable(buffer) {
  const version = resourcesOfType(buffer, RT_VERSION)
    .map((resource) => parseVersionInfo(buffer, resource.offset))
    .find((entry) => entry.strings?.ProductName) ?? null;
  const icons = resourcesOfType(buffer, RT_ICON);
  const group = resourcesOfType(buffer, RT_GROUP_ICON)[0] ?? null;
  return {
    version,
    iconCount: icons.length,
    iconBytes: icons.reduce((sum, icon) => sum + icon.size, 0),
    groupName: group?.name ?? null,
    groupSize: group?.size ?? 0,
    manifestPresent: resourcesOfType(buffer, RT_MANIFEST).length > 0,
  };
}

const before = readFileSync(exePath);

if (checkOnly) {
  const described = describeExecutable(before);
  console.log(`\n▸ ${relative(ROOT, exePath)} — ${mb(before.length)}`);
  console.log(`  icon resources: ${described.iconCount} (${mb(described.iconBytes)}) · group “${described.groupName ?? '—'}”`);
  console.log(`  manifest: ${described.manifestPresent ? 'present' : 'MISSING'}`);
  if (described.version) {
    console.log('  version information');
    for (const [key, value] of Object.entries(described.version.strings)) console.log(`    ${key} = ${value}`);
    console.log(`    fixed file version:    ${described.version.fixedFileVersion}`);
    console.log(`    fixed product version: ${described.version.fixedProductVersion}`);
    console.log(`    translations:          ${described.version.translations.join(', ')}`);
  } else {
    console.log('  version information: MISSING');
  }
  const productName = described.version?.strings?.ProductName;
  console.log(productName === APP_NAME ? '\n✔ the executable carries Dentiva’s identity.\n' : '\n✖ the executable carries foreign or missing identity.\n');
  process.exit(productName === APP_NAME ? 0 : 1);
}

if (!existsSync(iconPath)) {
  console.error(`✖ ${relative(ROOT, iconPath)} does not exist — run \`bun run icon\` first.`);
  process.exit(1);
}

const icon = readFileSync(iconPath);
const versionInfo = buildVersionInfo(productVersionStrings(), {
  fileVersion: fourPartVersion,
  productVersion: fourPartVersion,
});

console.log('\n▸ Windows resources');
const result = stampExecutable(before, { icon, versionInfo });
writeFileSync(exePath, result.buffer);

console.log(`  ${relative(ROOT, exePath)} — ${mb(result.buffer.length)}`);
console.log(`  icon: ${result.icon.images.length} sizes (${result.icon.images.map((image) => `${image.width}px ${image.encoded}`).join(', ')}) — ${mb(result.icon.bytes)}`);
console.log(`  version information: ${APP_NAME} ${fourPartVersion} · publisher ${APP_PUBLISHER}`);
console.log(`  resource tree: ${result.resourceSize} bytes in a ${result.region.size}-byte .rsrc section (${result.free} bytes free)`);
console.log(`  bytes rewritten: ${result.changedBytes} — all inside .rsrc`);

// Read the file back and prove the resources survived the round trip.
const stamped = readFileSync(exePath);
const described = describeExecutable(stamped);
const problems = [];
const expect = (label, condition) => {
  if (condition) console.log(`  ✔ ${label}`);
  else problems.push(label);
};
console.log('\n▸ Read-back');
expect(`${described.iconCount} icon sizes embedded`, described.iconCount === result.icon.images.length);
expect('icon group lists every size', described.groupSize === 6 + result.icon.images.length * 14);
expect('application manifest preserved', described.manifestPresent);
for (const [key, value] of Object.entries(versionInfo ? productVersionStrings() : {})) {
  expect(`${key} = ${value}`, described.version?.strings?.[key] === value);
}
expect(`fixed version ${fourPartVersion}`, described.version?.fixedFileVersion === fourPartVersion);
expect('no Bun/Oven identity left behind', described.version?.strings?.ProductName === APP_NAME && described.version?.strings?.CompanyName !== 'Oven');
for (const entry of listResources(stamped)) {
  if (entry.type === RT_ICON && entry.size === 0) problems.push('an icon resource is empty');
}

if (problems.length) {
  console.error(`\n✖ stamping failed verification (${problems.length} problem(s)):`);
  for (const problem of problems) console.error(`  • ${problem}`);
  process.exit(1);
}
console.log(`\n✔ ${relative(ROOT, exePath)} now carries the Dentiva icon and version information (${(statSync(exePath).size / 1024 / 1024).toFixed(1)} MB).\n`);
