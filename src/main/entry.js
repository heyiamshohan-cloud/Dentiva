/**
 * DENTIVA — desktop launcher (the program the .exe starts).
 *
 *     dentiva.exe                     start the clinic desktop application
 *     dentiva.exe --portable           keep the data next to the executable
 *     dentiva.exe --data <folder>      use a specific data folder
 *     dentiva.exe --port 47800         fixed port (default: a free one)
 *     dentiva.exe --no-window          serve only (kiosk/second screen)
 *     dentiva.exe --stop               stop the running instance
 *     dentiva.exe --self-test          verify the installation and exit
 *
 * The launcher starts the loopback server, opens the application window in a
 * Chromium-family browser (Edge/Chrome app mode), writes a launcher log, and
 * refuses to start twice against the same database.
 */
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { APP_NAME, APP_TAGLINE, APP_VERSION, BUILD_NUMBER, SCHEMA_VERSION } from '../shared/constants.js';
import { startServer } from '../server/index.js';
import { ensureDataLayout, resolveDataDir } from './paths.js';
import { info, initLog, logPath, warn, error } from './log.js';
import { claimInstance, readInstance, releaseInstance } from './single-instance.js';
import { findBrowser, openWindow } from './window.js';
import { attachParentConsole, showErrorMessage } from './win32.js';

const HELP = `${APP_NAME} ${APP_VERSION} — ${APP_TAGLINE}

Usage: dentiva [options]

  --data <folder>     data folder (default: %LOCALAPPDATA%\\Dentiva)
  --portable          keep data in a "data" folder next to the executable
  --port <number>     fixed port (default: any free port on 127.0.0.1)
  --no-window         do not open the application window
  --open              always open the window, even if one is running
  --browser <path>    use a specific browser executable
  --size <w,h>        window size (default 1440,900)
  --dev               serve assets from disk (development)
  --stop              stop the running instance and exit
  --self-test         check the installation and exit
  --version           print the version
  --help              print this help
`;

/**
 * @param {string[]} argv
 * @returns {{ values: Record<string, any>, positionals: string[] }}
 */
function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      data: { type: 'string' },
      portable: { type: 'boolean' },
      port: { type: 'string' },
      'no-window': { type: 'boolean' },
      open: { type: 'boolean' },
      browser: { type: 'string' },
      size: { type: 'string' },
      dev: { type: 'boolean' },
      quiet: { type: 'boolean' },
      stop: { type: 'boolean' },
      'self-test': { type: 'boolean' },
      version: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: false,
  });
  return { values, positionals };
}

/** Stop a running instance recorded in the data directory. */
async function stopRunning(dataDir) {
  const { running, record } = readInstance(dataDir);
  if (!running || !record) {
    console.log(`${APP_NAME} is not running.`);
    return 0;
  }
  try {
    process.kill(Number(record.pid));
  } catch (failure) {
    console.error(`Could not stop process ${record.pid}: ${failure instanceof Error ? failure.message : failure}`);
    return 1;
  }
  releaseInstance(dataDir);
  console.log(`${APP_NAME} stopped (process ${record.pid}).`);
  return 0;
}

/**
 * Health check used by the installer and by `--self-test`: start the server,
 * ask the API for its version, then shut down.
 */
async function selfTest(dataDir, { quiet = false } = {}) {
  const started = await startServer({ dataDir, port: 0, dev: false, appToken: null, quiet: true });
  try {
    const response = await fetch(`${started.url}/health`);
    const payload = await response.json();
    const ok = response.ok && payload.ok === true;
    if (!quiet) {
      console.log(JSON.stringify({
        ok,
        app: payload.app,
        version: payload.version,
        build: payload.build,
        schema: payload.schema,
        migration: payload.migration,
        dataDir: started.dataDir,
        assets: started.assets,
        window: findBrowser() ? 'chromium app mode' : 'default browser',
      }, null, 2));
    }
    return ok ? 0 : 1;
  } finally {
    started.stop();
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const { values } = parse(rawArgs);

  // The executable is a GUI program: no console is allocated when it is started
  // from Explorer, and when it *is* started from a terminal the parent console
  // is re-attached so the command-line switches can print normally.
  const commandLine = rawArgs.some((argument) => ['--help', '--version', '--self-test', '--stop', '--no-window'].includes(argument));
  if (commandLine) await attachParentConsole();

  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(`${APP_NAME} ${APP_VERSION} (build ${BUILD_NUMBER}, schema v${SCHEMA_VERSION})`);
    return 0;
  }

  if (values.portable) process.env.DENTIVA_PORTABLE = '1';
  const dataDir = resolveDataDir({ argv: process.argv.slice(2), env: process.env });
  ensureDataLayout(dataDir);

  if (values.stop) return stopRunning(dataDir);
  if (values['self-test']) return selfTest(dataDir, { quiet: Boolean(values.quiet) });

  initLog({ dataDir, quiet: Boolean(values.quiet) });
  info(`${APP_NAME} ${APP_VERSION} build ${BUILD_NUMBER} starting`, `pid ${process.pid}`);

  const existing = readInstance(dataDir);
  if (existing.running && existing.record?.url && !values.open) {
    info('another instance is already running; focusing it', existing.record.url);
    console.log(`${APP_NAME} is already running — opening ${existing.record.url}`);
    openWindow(String(existing.record.url), {
      dataDir,
      size: values.size,
      executable: values.browser ?? null,
    });
    return 0;
  }

  const appToken = randomBytes(24).toString('base64url');
  const started = await startServer({
    dataDir,
    port: values.port ? Number(values.port) : 0,
    dev: Boolean(values.dev),
    appToken,
    quiet: Boolean(values.quiet),
  });

  claimInstance(dataDir, { port: Number(started.port ?? 0), url: started.url, version: APP_VERSION });
  info(`listening on ${started.url}`, `data ${started.dataDir} · schema v${SCHEMA_VERSION} · embedded assets ${started.assets.files}`);

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    info(`shutting down (${signal})`);
    try {
      releaseInstance(dataDir);
      started.stop();
    } catch (failure) {
      error('shutdown failed', failure);
    }
    process.exit(0);
  };

  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'])) {
    try {
      process.on(signal, () => shutdown(signal));
    } catch {
      /* not every signal exists on every platform */
    }
  }
  process.on('uncaughtException', (failure) => {
    error('uncaught exception', failure);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => error('unhandled rejection', reason));

  if (!values['no-window']) {
    const result = openWindow(started.url, {
      dataDir,
      size: values.size,
      executable: values.browser ?? null,
    });
    if (result.opened) info(`window opened with ${result.executable ?? 'the default browser'}`);
    else {
      warn('no browser could be opened automatically');
      console.log(`Open ${started.url} in a browser to use ${APP_NAME}.`);
    }
  }

  if (!values.quiet) {
    console.log(`${APP_NAME} ${APP_VERSION} is running.`);
    console.log(`  window   ${started.url}`);
    console.log(`  data     ${started.dataDir}`);
    console.log(`  log      ${logPath()}`);
    console.log('  press Ctrl+C to stop');
  }

  // Keep the process alive: the window is an external browser process.
  return new Promise(() => {});
}

main()
  .then((code) => {
    if (typeof code === 'number') process.exit(code);
  })
  .catch(async (failure) => {
    const detail = failure instanceof Error ? (failure.stack ?? failure.message) : String(failure);
    try {
      error('launch failed', failure);
    } catch {
      /* the log may not be initialised yet */
    }
    console.error(`${APP_NAME} could not start:\n${detail}`);
    // A GUI process fails silently otherwise: show the reason and where the log
    // is written so the clinic can act on it.
    const shown = await showErrorMessage(
      `${APP_NAME} could not start`,
      `${detail}\n\nLog: ${logPath() || '(not available)'}`,
    );
    if (!shown) console.error('Run dentiva.exe --self-test from a terminal for details.');
    process.exit(1);
  });

export { main, selfTest, stopRunning };
