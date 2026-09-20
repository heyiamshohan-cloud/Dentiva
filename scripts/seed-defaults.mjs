/**
 * DENTIVA — clinic defaults CLI.
 *
 * Refreshes the provisioning template from `resources/clinic-defaults.json` and
 * (optionally) fills the configuration of a clinic that was created before the
 * file existed. Existing rows are never overwritten or deleted.
 *
 *   bun run seed:defaults                     template only
 *   bun run seed:defaults --clinic 1          template + clinic configuration
 *   bun run seed:defaults --all-clinics       every clinic in the database
 *   bun run seed:defaults --data <folder>     use a specific data folder
 *   bun run seed:defaults --dry-run           report what would change
 */
import { fileURLToPath } from 'node:url';
import { dataDirFromArgs, openTarget } from './lib/db-target.mjs';
import { applyClinicDefaultsSync, listClinicIds, loadClinicDefaults, seedClinicConfiguration } from '../src/server/db/seed.js';
import { migrationStatus } from '../src/server/db/migrations/index.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1];
};

const dryRun = args.includes('--dry-run');
const clinicId = flag('clinic') ? Number(flag('clinic')) : null;
const allClinics = args.includes('--all-clinics');

const dataDir = dataDirFromArgs(args);
const { db, dbPath, close } = await openTarget(dataDir);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

try {
  const status = migrationStatus(db);
  console.log(`Database   ${dbPath}`);
  console.log(`Schema     v${status.currentVersion} (supported v${status.supportedVersion})`);

  const defaults = await loadClinicDefaults({ projectRoot });
  const counts = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, value.length]));
  console.log(`Defaults   ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(' ')}`);

  if (dryRun) {
    const stored = db.query("SELECT updated_at, length(payload) AS bytes FROM clinic_provisioning_templates WHERE key = 'defaults'").get();
    console.log(`Template   ${stored ? `present (updated ${stored.updated_at}, ${stored.bytes} bytes)` : 'missing'}`);
    console.log('Dry run — nothing was written.');
  } else {
    const result = applyClinicDefaultsSync(db, { projectRoot, force: Boolean(flag('force')) });
    console.log(`Template   ${result.applied ? `${result.reason} (${result.updatedAt})` : `unchanged (${result.reason})`}`);

    /** @type {{ id: number, name?: string|null, code?: string|null }[]} */
    const targets = allClinics ? listClinicIds(db) : clinicId ? [{ id: clinicId, name: null }] : [];
    if (!targets.length) {
      console.log('Clinics    none targeted (use --clinic <id> or --all-clinics to fill existing clinics)');
    }
    for (const clinic of targets) {
      const inserted = await seedClinicConfiguration(db, clinic.id, { projectRoot });
      const total = Object.values(inserted).reduce((sum, value) => sum + value, 0);
      console.log(`Clinic ${clinic.id}${clinic.name ? ` (${clinic.name})` : ''}  ${total} row(s) added · ${JSON.stringify(inserted)}`);
    }
  }
} finally {
  close();
}
