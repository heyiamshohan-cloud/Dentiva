/**
 * Shared helper for the command-line scripts.
 *
 * Opens the clinic database the same way the application does (data directory,
 * migrations, WAL) so a maintenance script can never work on a database the
 * application would refuse to open — and never on a different file than the one
 * the desktop app uses.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { closeDatabase, openDatabase } from '../../src/server/db/connection.js';
import { migrate } from '../../src/server/db/migrations/index.js';
import { APP_VERSION, DATA_FILES } from '../../src/shared/constants.js';
import { resolveDataDir } from '../../src/main/paths.js';

/** Read `--data <folder>` / `DENTIVA_DATA_DIR` with the launcher's rules. */
export function dataDirFromArgs(args = process.argv.slice(2)) {
  return resolveDataDir({ argv: args, env: process.env });
}

/**
 * Open the database in a data directory (creating it when asked to).
 * @param {string} dataDir
 * @param {{ create?: boolean, migrateTo?: number }} [options]
 */
export function openTarget(dataDir, options = {}) {
  const create = options.create ?? true;
  if (!existsSync(dataDir)) {
    if (!create) throw new Error(`Data directory not found: ${dataDir}`);
    mkdirSync(dataDir, { recursive: true });
  }
  const dbPath = join(dataDir, DATA_FILES.database);
  if (!existsSync(dbPath) && !create) throw new Error(`No Dentiva database in ${dataDir}`);
  const db = openDatabase(dbPath);
  migrate(db, { appVersion: APP_VERSION, targetVersion: options.migrateTo });
  return {
    db,
    dbPath,
    dataDir,
    close() {
      try {
        closeDatabase();
      } catch {
        /* already closed */
      }
    },
  };
}

export default { dataDirFromArgs, openTarget };
