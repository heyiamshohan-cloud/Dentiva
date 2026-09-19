/**
 * Development browser preview.
 *
 * Serves the full application on `0.0.0.0` so a browser (or an editor preview
 * pane) outside this machine can open it, unlike the packaged application which
 * always binds 127.0.0.1 and requires the launch token.
 *
 *   bun run preview                      # http://<host>:4747, synthetic data
 *   bun run preview --port 8080 --keep   # choose the port, reuse the database
 *
 * What it changes compared with the real thing — and why this file is a
 * development tool, never part of a build:
 *
 *   • binds 0.0.0.0 instead of the loopback interface, so the page is reachable
 *     from the network;
 *   • no launch token, so any client that can reach the port may call the API;
 *   • the shell may be embedded in a frame and the session cookie is
 *     `SameSite=None; Secure`, because a preview pane is a different origin.
 *
 * The database it uses defaults to `.synthetic-data/preview`, is generated with
 * `scripts/seed-synthetic.mjs` when it is missing, and holds **only generated
 * data** — never point it at a real clinic folder, and delete the folder when you
 * are done (`bun run seed:synthetic --delete`).
 */
import { existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
/**
 * @param {string} name
 * @param {string|null} [fallback]
 * @returns {string|null}
 */
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};

const PORT = Number(flag('port', process.env.PORT ?? '4747'));
const HOST = String(flag('host', process.env.DENTIVA_HOST ?? '0.0.0.0'));
const PATIENTS = Number(flag('patients', '160'));
const dataDir = resolve(ROOT, String(flag('data', join('.synthetic-data', 'preview'))));

if (args.includes('--reset') && existsSync(dataDir)) {
  rmSync(dataDir, { recursive: true, force: true });
  console.log(`[preview] removed ${dataDir}`);
}

const fresh = !existsSync(join(dataDir, 'dentiva.db'));
if (fresh) {
  console.log(`[preview] generating a synthetic dataset in ${dataDir} (${PATIENTS} patients)…`);
  const seeded = spawnSync(process.execPath, [join(ROOT, 'scripts', 'seed-synthetic.mjs'), '--patients', String(PATIENTS), '--data', dataDir], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (seeded.status !== 0) {
    console.error('[preview] the dataset could not be generated; refusing to serve an empty database.');
    process.exit(1);
  }
}

const started = await startServer({ dataDir, port: PORT, host: HOST, dev: true, embed: true, appToken: null, quiet: true });

console.log(`
────────────────────────────────────────────────────────────────────────
  DENTIVA preview — development server, generated data only
────────────────────────────────────────────────────────────────────────
  URL        http://localhost:${started.port}    (bound to ${HOST})
  Data       ${dataDir}
  Sign in    synthetic / Synthetic#Test2026      (generated owner account)
  Note       reachable from the network and has no launch token — never
             point it at a real clinic folder.
  Stop       Ctrl+C
  Clean up   bun run seed:synthetic --delete --data "${dataDir}"
────────────────────────────────────────────────────────────────────────
`);

const shutdown = () => {
  try {
    started.stop();
  } catch {
    /* ignore */
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
