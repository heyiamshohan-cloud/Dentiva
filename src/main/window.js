/**
 * DENTIVA — application window.
 *
 * Dentiva serves its interface from a loopback HTTP server, so the window is a
 * Chromium-family browser started in application mode (`--app=…`): no tabs, no
 * address bar, its own taskbar entry and its own profile folder under the data
 * directory. Edge ships with Windows 10/11 and Chrome is common; when neither
 * is found the default browser opens instead, and the printing documents keep
 * working because they are ordinary pages.
 *
 * No remote content is ever loaded: the URL is always 127.0.0.1.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Candidate browser executables, most preferred first. */
export function browserCandidates(env = process.env) {
  const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = env.LOCALAPPDATA ?? '';
  const candidates = [
    join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    localAppData ? join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  return candidates.filter(Boolean);
}

/** @param {Record<string, string|undefined>} [env] */
export function findBrowser(env) {
  for (const candidate of browserCandidates(env)) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Open the application window.
 * @param {string} url
 * @param {{ dataDir: string, size?: string, executable?: string|null, env?: Record<string, string|undefined> }} options
 * @returns {{ opened: boolean, executable: string|null, detached: boolean }}
 */
export function openWindow(url, options) {
  const size = options.size ?? '1440,900';
  const executable = options.executable ?? findBrowser(options.env);
  const profileDir = join(options.dataDir, 'browser');

  const args = [
    `--app=${url}`,
    `--window-size=${size}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
  ];

  try {
    if (executable) {
      const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return { opened: true, executable, detached: true };
    }
    if (process.platform === 'win32') {
      // `start` hands the URL to whatever the user has set as default browser.
      const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return { opened: true, executable: null, detached: true };
    }
    if (process.platform === 'darwin') {
      const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
      child.unref();
      return { opened: true, executable: null, detached: true };
    }
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return { opened: true, executable: null, detached: true };
  } catch {
    return { opened: false, executable: null, detached: false };
  }
}

export default { browserCandidates, findBrowser, openWindow };
