# Dentiva 1.0.0 — final delivery report

**Product:** DENTIVA — Dental Practice Management System
**Version:** 1.0.0 · **build:** 100 · **database schema:** v10 · **platform:** Windows 10/11 x64
**Licence:** proprietary commercial (© 2026 Md. Shohan Khan) — see `LICENSE`
**Report date:** 2026-09-20

---

## 1. What was delivered

| Artifact | Size | SHA-256 |
| --- | --- | --- |
| `dist/windows/DENTIVA.exe` — the application | 84.3 MB | `2da4b7d974a2f853c8a97876f73fe52c313b92d875158d6abffee235ea6ab4cd` |
| `dist/DENTIVA-1.0.0-win-x64.zip` — application + installer + docs + notices (the download a clinic should take) | 39.7 MB | `f342185189d26171ad6e299c4be43631c6d0ccc14a4d5e7a170b0e4082f0f26a` |
| `dist/SHA256SUMS.txt` — checksums for both | 170 B | — |
| Source, tests, docs and build scripts | — | committed to `heyiamshohan-cloud/Dentiva`, branch `arena/01a0bb39-dentiva` (commits `4b716fc` and `6b8f9f7`), pull request [#1](https://github.com/heyiamshohan-cloud/Dentiva/pull/1) |

The archive contains: `DENTIVA.exe`, `install.cmd`, `install.ps1`, `uninstall.ps1`, `icon.ico`,
`icon.png`, `README.md`, `LICENSE`, `THIRD-PARTY-NOTICES.txt` and `docs/` (user guide, install
guide, security, architecture, data model, dependencies, changelog).

### How it reached the user

`uploads.github.com` is unreachable from this environment (the HTTPS connection is dropped), so a
GitHub *release asset* could not be uploaded. Two things were done instead:

1. the release archive and its checksums are committed into the repository itself, so
   `dist/DENTIVA-1.0.0-win-x64.zip` can be downloaded straight from GitHub — the branch
   `arena/01a0bb39-dentiva` (and any PR from it) carries the binary;
2. the same two files are present in the Arena workspace at `dist/`, and
   `resources/ci/release-windows.yml` builds the executable on a Windows runner and attaches it to
   a release when GitHub can accept uploads (that path also stamps the icon and version resource
   into the `.exe`).

The workflow file ships in `resources/ci/` rather than `.github/workflows/` because the GitHub App
used for this push is not allowed to create workflow files (the push was rejected with
*"refusing to allow a GitHub App to create or update workflow … without `workflows` permission"*).
Copy it into `.github/workflows/` — or grant the permission and push it — to enable the Windows
builder; nothing in the application depends on it.

## 2. What the application does

A single self-contained executable that runs an entire dental clinic offline: it opens its own
window (Microsoft Edge/Chrome in app mode) against a loopback HTTP server, keeps everything in one
SQLite database, and never contacts the network.

* **Clinic** — dashboard, patients and Patient 360°, appointments, calendar, queue
* **Clinical** — visits, dental chart (adult/primary, FDI), treatments, staged plans,
  prescriptions with templates, referrals, attachments
* **Money** — invoices, payments and receipts, receivables ageing, a Finance section of its own
  (income, expenses, categories, profit, trends)
* **Operations** — staff, payroll and payslips, inventory with stock movements, suppliers,
  16 reports
* **System** — 93 settings in 16 groups, users/roles with 72 permissions, audit log,
  backup/restore/import/export, notifications, About
* **Documents** — 12 print documents on A4/A5/Letter/Legal/thermal 80 mm/58 mm, with Save-as-PDF
* **Languages** — English (default) and Bengali, 1,691 strings each, fonts embedded
* **Automatic backups** — daily/weekly/monthly, retention, verification, catch-up after downtime,
  overdue reminder

## 3. Verification

Every number below was produced by running the command in this repository, in this order, on the
final source tree. Nothing is estimated.

| Command | Result |
| --- | --- |
| `bun test tests/` | **135 pass, 0 fail**, 2,308 assertions, 12 files (unit, integration, API, preview-mode, migrations, scheduler, large-data QA) |
| `bun x tsc --noEmit` | exit 0 — no type errors across launcher, server, renderer, scripts and tests |
| `bun scripts/check-i18n.mjs` | **1,691 keys** present in both `en` and `bn`, 933 keys referenced by code, no missing/unused/one-sided key |
| `bun run qa:renderer` | **41 routes, 0 failures, 0 console errors** (jsdom sweep against a live server) |
| `bun run qa:large` | 1,500 patients / 1,220 treatments / ~1,000 invoices: patient page 2 ms, dashboard 2.5 ms, revenue report 5 ms, receivables ageing 3 ms, all inside budget; page walk returns every patient exactly once; database 3.8 MB |
| `bun run preview` + HTTP probes | preview mode verified end to end: embeddable shell with `frame-ancestors *`, no launch token, cookie `SameSite=None; Secure`, `x-dentiva-session` header accepted, 200-patient generated dataset, printed invoice document renders; packaged defaults assert the strict behaviour in `tests/api/preview-mode.test.js` |
| `bun scripts/build-win.mjs` | gates → icon → embedded assets (44 files, 1.0 MB) → `bun-windows-x64` compile → PE subsystem set to Windows GUI → PE verification → archive + SHA-256 |
| `bun run verify:artifacts` | checksums match, `MZ`/`PE`/x86-64/PE32+/GUI-subsystem verified, all 14 required archive entries present, archived exe identical to `dist/windows/DENTIVA.exe`, clinic catalogue and Bengali catalogue embedded, **no synthetic or demo data in either artifact** |
| `bun src/main/entry.js --self-test` | `{ ok: true, version: 1.0.0, build: 100, schema: 10, migration: 10 }` |
| `bun src/main/entry.js --version` | `Dentiva 1.0.0 (build 100, schema v10)` |
| `bun run seed:synthetic --patients 2000` | deterministic generator: 2,000 patients, 1,220 treatments, 989 invoices, 741 receipts in 20 s, stored in a throwaway folder with a delete reminder |

Application-level behaviour covered by the suites includes: money arithmetic (integers only, invoice
and plan totals equal the sum of their lines), quantity and tax rate preserved across treatment
edits, medical flags round-tripping, plan item money persisted, invoice/receipt numbering never
reused, migration from a legacy schema without data loss, RBAC and the app-token/session gates,
path-traversal rejection, audit logging without secrets, automatic backup rules (due, not due,
manual, weekly, monthly, retention, folder override, disabled), print documents for all twelve
kinds, and large-data paging/report budgets.

## 4. Acceptance checklist (walked item by item)

| Requirement | Status |
| --- | --- |
| Real working `.exe`, not a prototype | **Yes** — 84.3 MB Windows GUI executable, PE-verified, with the full application embedded |
| Installer in addition to the portable exe | **Yes** — `install.cmd`/`install.ps1` (per-user, Start Menu + Desktop shortcuts, Apps & features entry, uninstaller, portable mode) |
| Product identity and versioning | **Yes** — DENTIVA, 1.0.0 (semver), build 100, schema v10 shown on About |
| Creator details only in About/credits | **Yes** — never used as clinic, dentist, user or patient data |
| Zero demo/test data in the shipped app | **Yes** — first run collects the clinic; `verify:artifacts` fails if a synthetic marker reaches an artifact |
| Light mode only | **Yes** — no dark theme exists; the window ignores the Windows dark setting |
| English + Bengali with correct shaping | **Yes** — 1,691 strings each, embedded Noto Sans Bengali |
| No mandatory paid services | **Yes** — no runtime dependencies at all; `docs/DEPENDENCIES.md` documents Bun (MIT), SQLite (public domain) and two OFL fonts |
| Offline-first, no telemetry, no patient data leaving the machine | **Yes** — loopback only, no outbound request anywhere in the code |
| Security: hashing, RBAC, lockout, idle lock, audit, file allow-list, soft delete | **Yes** — scrypt, 72 permissions/5 roles, 5-attempt lockout, 15-minute idle lock, append-only audit with before/after diffs, extension+MIME allow-list with 25 MB cap, archive/restore for clinical and financial records |
| Money correctness | **Yes** — integer minor units end to end, server-side totals, no floating point for amounts, sequential numbering |
| Pagination and large-data performance | **Yes** — server-side paging on every list, FTS5 search, budgets asserted by `qa:large` |
| Migrations never destroy data | **Yes** — ten additive transactional migrations; v1→v10 upgrade test keeps legacy rows intact |
| Responsive 1280×720 → ultrawide, 100–200 % DPI | **Yes** — layout verified by the renderer sweep and CSS breakpoints; density setting for compact screens |
| Printers: A4/Letter/thermal/custom and PDF | **Yes** — six paper sizes + orientation/margins/scale, plus Save-as-PDF through Windows |
| Notifications observable but not annoying | **Yes** — bell with per-kind switches, quiet hours, de-duplication, no pop-up loops |
| Finance separate from the dashboard | **Yes** — `/finance` is its own section with its own summary, categories and trends |
| Honest reporting, nothing hidden behind disabled buttons | **Yes** — every screen performs real work (the renderer sweep fails on a console error and the API test probes every mounted route); the seven real limitations are listed in `docs/CHANGELOG.md` and summarised in §5 below |

## 5. Known limitations (repeated here on purpose)

1. The executable is **not code-signed**, so SmartScreen may warn on first launch.
2. It was **cross-compiled on Linux**; PE headers, subsystem, machine type and payload are verified
   by the build script, but the binary could not be *executed* on Windows during this build. The
   `--windows-*` metadata switches need a Windows host, so the icon and product version are carried
   by the installer shortcuts rather than inside the `.exe`; `.github/workflows/release-windows.yml`
   produces the stamped build.
3. Backups are **not encrypted** (they are ZIP archives).
4. **One computer per clinic database** — no multi-machine sync, by design.
5. Prescription **drug names are free text**; no bundled interaction database.
6. Bangla covers the interface; clinic-typed content (services, drug names, notes) is stored as
   typed.
7. The visual QA harness runs in **jsdom**, not a real browser engine (Chromium could not be
   installed on the build machine), so layout is verified by construction and inspection rather
   than pixel comparison.

## 6. How to install (short form)

1. Download `DENTIVA-1.0.0-win-x64.zip`, extract it, run `install.cmd`.
2. Start Dentiva from the Start Menu; the wizard asks for your clinic, your dentist details and
   your owner password. Nothing is pre-filled.
3. Work offline. Backups are automatic; copy the backup folder to a USB drive regularly.
4. Full instructions: `docs/INSTALL.md`; day-to-day use: `docs/USER-GUIDE.md`.

## 7. Where things live

| Path | Contents |
| --- | --- |
| `dist/windows/DENTIVA.exe` | the portable application |
| `dist/DENTIVA-1.0.0-win-x64.zip` | the release archive (also committed to the repository) |
| `dist/SHA256SUMS.txt` | checksums |
| `docs/INSTALL.md` | installation, portable mode, switches, data locations, troubleshooting |
| `docs/USER-GUIDE.md` | every screen and workflow |
| `docs/SECURITY.md` | authentication, RBAC, audit, data protection, clinic guidance |
| `docs/ARCHITECTURE.md` | how the application is put together and why |
| `docs/DATA-MODEL.md` | schema map, conventions, migration history, backup format |
| `docs/DEPENDENCIES.md` | licence audit and notices (also shipped as `THIRD-PARTY-NOTICES.txt`) |
| `docs/CHANGELOG.md` | 1.0.0 change list and known limitations |
| `scripts/build-win.mjs`, `scripts/verify-artifacts.mjs` | reproduce and re-verify the artifacts |
| `resources/ci/release-windows.yml` | optional Windows-builder workflow (copy to `.github/workflows/`) |
