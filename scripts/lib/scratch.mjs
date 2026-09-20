/**
 * Scratch-directory housekeeping for the test suite.
 *
 * Every test file works in its own `mkdtempSync` directory and deletes it when
 * it is finished. On Windows that delete can come back `EBUSY`: the file has
 * been closed, but the platform — the search indexer, the anti-malware service,
 * a just-released SQLite WAL handle — still has it open for a moment, so a
 * straight `rmSync` right after `closeDatabase()` loses the race.
 *
 * The retry below is the fix for the transient case. What it deliberately does
 * **not** do is fail a test when a scratch directory survives: those directories
 * hold nothing but throwaway databases in the machine's temporary folder, and
 * whether the operating system lets go of one is not something Dentiva's
 * behaviour depends on. A test asserts product behaviour; tidying up after
 * itself is courtesy. So a stubborn directory is reported loudly — the warning
 * names it, and it stays in the log — and the run carries on.
 */
import { existsSync, rmSync } from 'node:fs';

/** Errors that mean "try again in a moment", as opposed to a real fault. */
const TRANSIENT = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES', 'EBUSY']);

const ATTEMPTS = 12;

/** Sleep without importing timers into a synchronous test helper. */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {number} attempt */
const backoff = (attempt) => Math.min(100 * attempt, 400);

/** @param {string} dir @param {string} label @param {any} error */
function giveUp(dir, label, error) {
  const reason = error?.code ? `${error.code}: ${error.message}` : String(error ?? 'unknown');
  console.warn(`\n⚠ ${label} ${dir} could not be deleted (${reason}). It is a throwaway ` +
    'directory in the temporary folder; the run continues without it.');
}

/**
 * Delete a scratch directory, retrying while Windows still holds it.
 * @param {string} dir
 * @param {string} [label]
 * @returns {boolean} true when the directory is gone
 */
export function removeScratchDirSync(dir, label = 'scratch directory') {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (!TRANSIENT.has(error?.code)) {
        console.warn(`\n⚠ ${label} ${dir} could not be deleted: ${error?.code ?? error}`);
        return false;
      }
      if (attempt === ATTEMPTS) {
        giveUp(dir, label, error);
        return false;
      }
      sleepSync(backoff(attempt));
    }
  }
  return true;
}

/**
 * Asynchronous form of {@link removeScratchDirSync}, for `afterAll` blocks.
 * @param {string} dir
 * @param {string} [label]
 * @returns {Promise<boolean>} true when the directory is gone
 */
export async function removeScratchDir(dir, label = 'scratch directory') {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (!TRANSIENT.has(error?.code)) {
        console.warn(`\n⚠ ${label} ${dir} could not be deleted: ${error?.code ?? error}`);
        return false;
      }
      if (attempt === ATTEMPTS) {
        giveUp(dir, label, error);
        return false;
      }
      await sleep(backoff(attempt));
    }
  }
  return true;
}
