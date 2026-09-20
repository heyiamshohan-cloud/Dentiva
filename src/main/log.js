/**
 * DENTIVA — launcher log.
 *
 * The window has its own console; on Windows a packaged application has none,
 * so every launch, crash and shutdown is appended to
 * `<data>\logs\launcher-YYYY-MM-DD.log`. The log never contains patient data or
 * credentials — only lifecycle lines and error stacks.
 */
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { ensureDataLayout, logFile } from './paths.js';

const MAX_BYTES = 2 * 1024 * 1024;

/** @type {{ dataDir: string, file: string, quiet: boolean } | null} */
let target = null;

/**
 * @param {{ dataDir: string, quiet?: boolean, name?: string }} options
 */
export function initLog(options) {
  ensureDataLayout(options.dataDir);
  target = {
    dataDir: options.dataDir,
    file: logFile(options.dataDir, options.name ?? 'launcher'),
    quiet: Boolean(options.quiet),
  };
  // Keep one previous file per day so a crash loop cannot fill the disk.
  try {
    if (existsSync(target.file) && statSync(target.file).size > MAX_BYTES) {
      renameSync(target.file, `${target.file}.1`);
    }
  } catch {
    /* logging must never break the launch */
  }
  return target.file;
}

/** @returns {string} */
export function logPath() {
  return target?.file ?? '';
}

/**
 * @param {'info'|'warn'|'error'} level
 * @param {string} message
 * @param {unknown} [extra]
 */
export function log(level, message, extra) {
  const stamp = new Date().toISOString();
  let line = `${stamp} [${level}] ${message}`;
  if (extra !== undefined && extra !== null) {
    line += ` :: ${extra instanceof Error ? (extra.stack ?? extra.message) : String(extra)}`;
  }
  if (!target?.quiet && level !== 'info') console.error(line);
  else if (!target?.quiet) console.log(line);
  if (!target) return;
  try {
    appendFileSync(target.file, `${line}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

export const info = (message, extra) => log('info', message, extra);
export const warn = (message, extra) => log('warn', message, extra);
export const error = (message, extra) => log('error', message, extra);

export default { initLog, logPath, log, info, warn, error };
