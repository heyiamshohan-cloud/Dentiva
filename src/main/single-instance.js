/**
 * DENTIVA — single instance guard.
 *
 * Two copies of Dentiva must never write the same SQLite file. The first
 * instance writes `instance.json` (pid, url, started at) into the data
 * directory; a second launch notices it, opens the running window and exits.
 * A file left behind by a crashed process is detected through the pid and
 * replaced.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'instance.json';

/** @param {string} dataDir */
function file(dataDir) {
  return join(dataDir, FILE);
}

/** @param {number} pid */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return /** @type {any} */ (error)?.code === 'EPERM';
  }
}

/**
 * @param {string} dataDir
 * @returns {{ running: boolean, record: any|null }}
 */
export function readInstance(dataDir) {
  try {
    const record = JSON.parse(readFileSync(file(dataDir), 'utf8'));
    if (record && processAlive(Number(record.pid))) return { running: true, record };
    return { running: false, record: record ?? null };
  } catch {
    return { running: false, record: null };
  }
}

/**
 * @param {string} dataDir
 * @param {{ port: number, url: string, version: string }} details
 */
export function claimInstance(dataDir, details) {
  const record = {
    pid: process.pid,
    port: details.port,
    url: details.url,
    version: details.version,
    startedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(file(dataDir), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } catch {
    /* a read-only data directory still allows the window to work */
  }
  return record;
}

/** Remove the record when this process was the owner. @param {string} dataDir */
export function releaseInstance(dataDir) {
  try {
    const current = JSON.parse(readFileSync(file(dataDir), 'utf8'));
    if (Number(current?.pid) === process.pid) rmSync(file(dataDir), { force: true });
  } catch {
    /* nothing to clean up */
  }
}

export default { processAlive, readInstance, claimInstance, releaseInstance };
