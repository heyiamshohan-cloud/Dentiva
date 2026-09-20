/**
 * Preview mode versus the packaged application.
 *
 * `bun run preview` relaxes four things so a browser outside this machine (an
 * editor preview pane, a phone on the same network) can open the window: the bind
 * address, the launch token, the frame-ancestors directive and the session
 * cookie. Those relaxations must never leak into the desktop application, so this
 * file asserts both sides:
 *
 *   • packaged defaults — loopback only, launch token required, cookie
 *     `SameSite=Strict`, shell `frame-ancestors 'self'`, and the preview-only
 *     session header ignored;
 *   • preview mode — shell embeddable, cookie `SameSite=None; Secure`, session
 *     header accepted, and a *valid* token still required (no autologin).
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/index.js';
import { removeScratchDir } from '../../scripts/lib/scratch.mjs';

const APP_TOKEN = 'packaged-token';

let packaged;
let preview;
let dirs = [];

beforeAll(async () => {
  const packagedDir = mkdtempSync(join(tmpdir(), 'dentiva-packaged-'));
  const previewDir = mkdtempSync(join(tmpdir(), 'dentiva-preview-'));
  dirs = [packagedDir, previewDir];

  packaged = await startServer({ dataDir: packagedDir, port: 0, dev: true, appToken: APP_TOKEN, quiet: true });
  preview = await startServer({ dataDir: previewDir, port: 0, host: '127.0.0.1', dev: true, embed: true, appToken: null, quiet: true });

  const setup = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clinic: { code: 'PRE', name: 'Preview Test Clinic', phone: '01710000001', currency_code: 'BDT', currency_symbol: '৳', locale: 'en' },
      dentist: { full_name: 'Dr. Preview' },
      admin: { username: 'previewowner', display_name: 'Preview Owner', password: 'Preview#2026A' },
    }),
  };
  // First-run setup creates the clinic and opens a session in each instance.
  await fetch(`${packaged.url}/api/auth/first-run`, { ...setup, headers: { ...setup.headers, 'x-dentiva-app': APP_TOKEN } });
  await fetch(`${preview.url}/api/auth/first-run`, setup);
}, 60000);

afterAll(async () => {
  try { packaged?.db?.close(); } catch {}
  try { preview?.db?.close(); } catch {}
  try {
    packaged?.stop();
  } catch {
    /* ignore */
  }
  try {
    preview?.stop();
  } catch {
    /* ignore */
  }
  try { packaged?.db?.close(); } catch {}
  try { preview?.db?.close(); } catch {}
  await new Promise((r) => setTimeout(r, 200));
  for (const dir of dirs) await removeScratchDir(dir, 'preview data directory');
});

describe('packaged application', () => {
  test('refuses API calls without the launch token', async () => {
    const response = await fetch(`${packaged.url}/api/auth/status`);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe('auth.appToken');
  });

  test('binds the loopback interface only', () => {
    expect(packaged.server.hostname).toBe('127.0.0.1');
    expect(packaged.url).toStartWith('http://127.0.0.1:');
  });

  test('serves a shell that cannot be framed and hands out a strict cookie', async () => {
    const shell = await fetch(`${packaged.url}/`, { headers: { 'x-dentiva-app': APP_TOKEN } });
    const csp = shell.headers.get('content-security-policy');
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain('frame-ancestors *');
    expect(await shell.text()).toContain('dentiva-app-token');

    const login = await fetch(`${packaged.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dentiva-app': APP_TOKEN },
      body: JSON.stringify({ username: 'previewowner', password: 'Preview#2026A' }),
    });
    const cookie = login.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('SameSite=None');

    // The preview-only header must be ignored here, even with a valid token:
    // `/api/session/me` is public by design (the shell asks who it is), so it
    // answers with a null user instead of a session.
    const token = (await login.json()).token;
    const viaHeader = await fetch(`${packaged.url}/api/session/me`, {
      headers: { 'x-dentiva-app': APP_TOKEN, 'x-dentiva-session': token },
    });
    expect(viaHeader.status).toBe(200);
    expect((await viaHeader.json()).user).toBeNull();

    // A protected route is the real test.
    const patients = await fetch(`${packaged.url}/api/patients`, {
      headers: { 'x-dentiva-app': APP_TOKEN, 'x-dentiva-session': token },
    });
    expect(patients.status).toBe(401);
  });
});

describe('development preview', () => {
  test('serves an embeddable shell with no launch token', async () => {
    const shell = await fetch(`${preview.url}/`);
    expect(shell.status).toBe(200);
    const csp = shell.headers.get('content-security-policy');
    expect(csp).toContain('frame-ancestors *');
    expect(await shell.text()).not.toContain('dentiva-app-token');
  });

  test('hands out a cross-site cookie and accepts the session header', async () => {
    const login = await fetch(`${preview.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'previewowner', password: 'Preview#2026A' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('SameSite=None');
    expect(cookie).toContain('Secure');

    const token = (await login.json()).token;
    const me = await fetch(`${preview.url}/api/session/me`, { headers: { 'x-dentiva-session': token } });
    expect(me.status).toBe(200);
    expect((await me.json()).user.username).toBe('previewowner');
  });

  test('still requires a valid session — the header is not a bypass', async () => {
    const missing = await fetch(`${preview.url}/api/patients`);
    expect(missing.status).toBe(401);
    const forged = await fetch(`${preview.url}/api/patients`, { headers: { 'x-dentiva-session': 'not-a-real-token' } });
    expect(forged.status).toBe(401);
  });
});
