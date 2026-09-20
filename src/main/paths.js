/**
 * DENTIVA — filesystem layout of the installed application.
 *
 * Everything the application writes lives in one data directory so that a
 * backup, a restore and a support request all refer to the same folder:
 *
 *   %LOCALAPPDATA%\Dentiva\        (default, per user)
 *     dentiva.db                   SQLite database (plus -wal / -shm)
 *     dentiva.json                 window preferences (locale, last route)
 *     attachments/  backups/  exports/  logs/  temp/
 *
 * Portable mode: when a `data` directory sits next to the executable (a USB
 * stick install), that directory is used instead and nothing is written to the
 * user profile. `--data <path>` and `DENTIVA_DATA_DIR` override both.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DATA_FILES } from '../shared/constants.js';

export const PORTABLE_MARKER = 'data';

/** @param {unknown} value @returns {string|null} */
function clean(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text : null;
}

/**
 * Directory holding the running executable (or the project root when running
 * from source). Used only to detect a portable installation.
 */
export function executableDir() {
  const entry = process.execPath ?? '';
  // `bun run src/main/entry.js` reports the Bun binary; treat that as "source".
  if (!entry || /[\\/](bun|bun\.exe|node|node\.exe)$/i.test(entry)) return null;
  return dirname(entry);
}

/** @param {{ argv?: string[], env?: Record<string, string|undefined> }} [context] */
export function resolveDataDir(context = {}) {
  const argv = context.argv ?? process.argv.slice(2);
  const env = context.env ?? process.env;

  const flagIndex = argv.indexOf('--data');
  const fromFlag = flagIndex === -1 ? null : clean(argv[flagIndex + 1]);
  if (fromFlag) return resolve(isAbsolute(fromFlag) ? fromFlag : join(process.cwd(), fromFlag));

  const fromEnv = clean(env.DENTIVA_DATA_DIR);
  if (fromEnv) return resolve(isAbsolute(fromEnv) ? fromEnv : join(process.cwd(), fromEnv));

  const portableExplicit = clean(env.DENTIVA_PORTABLE);
  const exeDir = executableDir();
  if (exeDir && (portableExplicit === '1' || existsSync(join(exeDir, PORTABLE_MARKER)))) {
    return join(exeDir, PORTABLE_MARKER);
  }

  const base = clean(env.LOCALAPPDATA) ?? clean(env.APPDATA) ?? join(homedir(), 'AppData', 'Local');
  return join(base, 'Dentiva');
}

/**
 * Create the data directory tree. Safe to call on every launch: existing data
 * is never touched, only missing folders are added.
 * @param {string} dataDir
 */
export function ensureDataLayout(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  for (const key of ['attachments', 'backups', 'exports', 'logs', 'temp']) {
    mkdirSync(join(dataDir, DATA_FILES[key]), { recursive: true });
  }
  return dataDir;
}

/** @param {string} dataDir */
export function logFile(dataDir, name = 'launcher') {
  const day = new Date().toISOString().slice(0, 10);
  return join(dataDir, DATA_FILES.logs, `${name}-${day}.log`);
}

export const paths = { executableDir, resolveDataDir, ensureDataLayout, logFile };
export default paths;
