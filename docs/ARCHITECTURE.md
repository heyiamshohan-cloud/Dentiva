# Dentiva — architecture

Dentiva 1.0.0 · build 100 · schema v10

Dentiva is one executable that behaves like a small three-tier application on a single machine:
a launcher, a local HTTP server that owns the data and all the rules, and a browser-rendered user
interface. Nothing is distributed, nothing is shared between computers, and there is no build step
for the interface.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ DENTIVA.exe (compiled Bun program)                                          │
│                                                                            │
│  src/main/          launcher                                               │
│    entry.js           CLI switches, data folder, single instance, window    │
│    paths.js           %LOCALAPPDATA%\Dentiva (or --data / --portable)      │
│    window.js          Edge/Chrome --app= window, isolated profile          │
│    single-instance.js instance.json lock, --stop                            │
│    log.js             launcher-YYYY-MM-DD.log                               │
│    win32.js           bun:ffi — parent-console attach, native message box   │
│                                                                            │
│  src/server/        the system of record                                   │
│    index.js           HTTP entry, app token, sessions, print documents      │
│    http/routes.js      API route table + permission per route               │
│    http/documents.js   print documents (invoice, receipt, payslip, …)       │
│    services/*.js       domain logic: patients, clinical, billing, finance,  │
│                        payroll, inventory, reports, backup, scheduler, …    │
│    db/migrations/*.js  10 additive migrations, schema v10                   │
│    db/seed.js          clinic default catalogue (first-run provisioning)    │
│    domain/*.js         money, dates, validation, permissions, zip, csv      │
│    generated/assets.js embedded renderer, fonts and resources (build-time)  │
│                                                                            │
│  src/renderer/      the interface (plain ES modules, no framework)          │
│    index.html, styles/app.css                                               │
│    js/core/  dom, ui, format, api, router, nav, store, print                │
│    js/views/ session, dashboard, patients, clinical, scheduling, money,     │
│              ops, system, ui                                               │
│                                                                            │
│  src/shared/        i18n catalogues (en, bn), constants, error codes        │
└────────────────────────────────────────────────────────────────────────────┘
             ▲                                   ▲
             │ loopback HTTP (127.0.0.1, random  │
             │ port, x-dentiva-app token)        │
             └────────── Edge/Chrome window ─────┘
```

## Why this shape

* **No embedded browser engine.** Electron-style runtimes add a second copy of Chromium, a
  supply-chain surface and a 120 MB penalty. Dentiva serves its own UI over loopback and opens
  Windows' own Edge (present on every Windows 10/11 machine) in application mode. The window has
  no tabs or address bar and looks like a native app, but the runtime is already installed,
  patched and understood by IT departments.
* **One language for the whole codebase.** Bun runs the launcher, the server, the migrations and
  the tests; the renderer is plain ES modules that the browser runs without a bundler. Nothing has
  to be transpiled, so the thing that is tested is the thing that ships.
* **SQLite as the only store.** One file, transactions, foreign keys, FTS5 for search. It is the
  right size for a clinic: a 1,500-patient dataset with a full clinical and financial history is
  under 4 MB (see `bun run qa:large`).
* **Server-side truth.** Totals, numbering, permissions, validation, audit entries and printed
  documents are computed in `src/server`. The renderer formats and displays; it cannot decide that
  an invoice is paid.

## Request flow

1. The launcher picks a data directory, opens the database, runs migrations, provisions the clinic
   catalogue if the database is new, and starts the HTTP server on a free loopback port.
2. It writes `instance.json` (pid, port, token) so a second launch can focus the existing window
   instead of opening a second copy, then opens the window at `http://127.0.0.1:<port>/app`.
3. The window loads the shell; every API call carries the `x-dentiva-app` token and the session
   cookie.
4. The HTTP layer resolves the session, resolves the permission required by the route, validates
   the body against the schema, and calls the service.
5. The service performs the work inside a transaction, writes the audit entry, updates search
   indexes, and returns a shaped object (never a raw database row).
6. Errors travel back as a typed envelope — `{ error: { code, message, messageKey, params, status,
   details } }` — and the renderer shows the localized message, falling back to the raw one.

## Storage layout

```
<data folder>/
  dentiva.db                 SQLite database (plus -wal/-shm while running)
  attachments/               uploaded files, named by id, checksummed
  backups/                   automatic and manual archives
  exports/                   CSV/JSON exports
  logs/launcher-YYYY-MM-DD.log
  browser/                   the app window's isolated profile
  temp/                      scratch space for restores
  instance.json              single-instance lock
```

## Performance model

* Lists are paginated on the server (`page`, `pageSize`, `sort`, `dir`), and indexes cover the
  filters that the screens actually use (117 indexes for 61 tables, 5 views).
* Reports aggregate in SQL, not in JavaScript.
* Search runs through an FTS5 index over seven record types (patients, visits, treatments,
  prescriptions, referrals, appointments, invoices) with a trigram-free prefix query builder, so
  the palette answers while you type.
* Inventory, receivables and dashboard figures come from SQL views and one-query aggregates.
* Measured on this machine with 1,500 patients, 1,200 treatments, ~1,000 invoices: patient page
  ~2 ms, dashboard ~2 ms, revenue report ~4 ms, invoice/payment/inventory pages ~2 ms each
  (`bun run qa:large` asserts budgets and prints the five slowest interactions).

## Rendering and localization

* All visible text comes from `src/shared/i18n/en.js` and `bn.js`; `bun run lint:i18n` fails the
  build if a key is used but missing, present in one language only, or duplicated.
* Bengali uses the embedded Noto Sans Bengali family, so conjuncts shape correctly without any
  font installed on the machine. Digits follow the selected language; dates and money are
  formatted from the clinic's settings, never from the operating system's locale.
* The interface is light-mode only by design: the stylesheet has no dark variant and the window
  ignores the Windows dark-mode preference.

## Print documents

`src/server/http/documents.js` renders standalone HTML with its own print stylesheet, one function
per document kind: invoice, receipt, prescription, plan, visit summary, referral letter, statement,
patient card, appointment slip, queue ticket, payslip and any report. Paper size (A4, A5, Letter,
Legal, thermal 80 mm, thermal 58 mm), orientation, margins, scale and whether the logo and
signature lines appear all come from the clinic's printing settings. "Save as PDF" is the
operating system's own PDF printer, so no PDF library is bundled.

## Development preview versus the application

`bun run preview` starts the same server with three deliberate differences, all of them opt-in and
none of them reachable from the packaged application:

| | Application | Preview (`bun run preview`) |
| --- | --- | --- |
| Bind address | `127.0.0.1` | `0.0.0.0` (reachable from the network) |
| Launch token | required on every `/api/**` call | none |
| Shell CSP | `frame-ancestors 'self'` | `frame-ancestors *` |
| Session cookie | `SameSite=Strict`, HttpOnly | `SameSite=None; Secure` (a frame is another origin) + an in-memory `x-dentiva-session` fallback for browsers that block third-party cookies |
| Data | the clinic's folder | generated dataset in `.synthetic-data/` |

Because a preview pane cannot rely on a cross-origin cookie, the renderer keeps the session token
that the server returns in a sign-in response **in memory only** (never in storage) and sends it as
`x-dentiva-session`; the server ignores that header unless preview mode is on. The desktop launcher
(`src/main/entry.js`) does not expose `--host` or `--embed`, so a shipped build cannot be started
this way by accident.

## Background work

`src/server/services/scheduler.js` runs while the application is open. Its only job today is the
automatic backup: it wakes every five minutes, checks each clinic's `backup.*` settings, and runs a
backup that is due — including the one that was missed because the computer was switched off at
the scheduled time. Runs and failures are audited and announced once in the notification bell.

## Quality gates

| Gate | Command | What it protects |
| --- | --- | --- |
| Types | `bun x tsc --noEmit` | every module, script and test file (JSDoc-typed JavaScript) |
| Tests | `bun test tests/` | services, API, migrations, scheduler, large-data QA |
| Localization | `bun run lint:i18n` | no missing or orphaned string |
| Renderer | `bun run qa:renderer` | 41 routes rendered against a live server, zero console errors |
| Large data | `bun run qa:large` | paging, search, reports and inventory at 1,500 patients |
| End-to-end | `bun run qa:packaged` | the running application put through a full clinic workflow over its own API |
| Packaging | `bun scripts/build-win.mjs` | gates, asset embedding, icon + version stamping, PE verification, archive + SHA-256, artifact gate |
| Executable identity | `bun run verify:exe` | icon at every size, version information, manifest, no compiler identity |
| Artifacts | `bun run verify:artifacts` | checksums, PE headers, executable identity, archive contents, no synthetic data |

`resources/ci/release-windows.yml` runs all of them on a Windows runner and adds the checks that
only Windows can answer: `DENTIVA.exe --self-test`, the installer → shortcut → uninstall path, the
portable layout, the packaged QA run against the executable, Edge rendering the application for
real, and a Defender scan recorded as evidence.

## Repository conventions

* Services never return raw rows; every one has a `shape…` function.
* Services take `(db, ctx, …)`; `ctx` carries `clinicId`, `user`, `ip`, `dataDir`. There is no
  global database handle, so tests can run several databases in parallel.
* Money crosses the wire as integers in minor units; the renderer converts with
  `format.minorToInput` / `inputToMinor`. Quantities use thousandths (`qtyToMilli`).
* Writes return the shaped record; the renderer reloads the list rather than patching it in place,
  which keeps totals and notifications consistent.
* No `TODO`, stub or disabled button is left in the shipped UI: if a feature is not implemented it
  is not shown, and everything shown works (the renderer sweep fails on a console error, and the
  API test probes every mounted route).
