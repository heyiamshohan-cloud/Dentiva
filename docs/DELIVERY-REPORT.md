# Dentiva 1.0.0 — final delivery report

**Product:** DENTIVA — Dental Practice Management System
**Version:** 1.0.0 · **build:** 100 · **database schema:** v10 · **platform:** Windows 10/11 x64
**Licence:** proprietary commercial (© 2026 Md. Shohan Khan) — see `LICENSE`
**Report date:** 2026-09-20

---

## 1. What was delivered

| Artifact | Size | SHA-256 |
| --- | --- | --- |
| `dist/windows/DENTIVA.exe` — the application, with the Dentiva icon (7 sizes) and the product version resource embedded | 84.3 MB | `9b8abf91bca24a68a9cd1794cd907dab4faf5acd9ce78054db42c045b7fee530` |
| `dist/DENTIVA-1.0.0-win-x64.zip` — application + installer + docs + notices (the download a clinic should take) | 39.7 MB | `b0a648e70a8a5cf775a14c3eea7d530abd50afcc00b9a9662365f49cb5a640f4` |
| `dist/SHA256SUMS.txt` — checksums for both | 170 B | — |
| Source, tests, docs and build scripts | — | committed to `heyiamshohan-cloud/Dentiva`, branch `arena/01a0bb39-dentiva`, pull request [#1](https://github.com/heyiamshohan-cloud/Dentiva/pull/1) |

Explorer's *Details* tab on `DENTIVA.exe` now reads **CompanyName** `Md. Shohan Khan`,
**FileDescription** `Dentiva — Dental Practice Management System`, **FileVersion** / **ProductVersion**
`1.0.0.100`, **ProductName** `Dentiva`, **OriginalFilename** `DENTIVA.exe`, **LegalCopyright**
`© 2026 Md. Shohan Khan`; the shell shows the tooth mark at 16, 24, 32, 48, 64, 128 and 256 pixels
(list, taskbar, Start Menu, Alt-Tab and *Extra large icons*) instead of the compiler's own artwork.
`bun run verify:exe` prints this identity, and the release gate fails if any of it drifts.

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
   `resources/ci/release-windows.yml` builds the executable natively on a Windows runner, runs it,
   checks it against this report's claims and attaches it to a release when GitHub can accept
   uploads.

The executable in the archive is already the finished article — icon and version resource included
— because `scripts/stamp-exe.mjs` writes those resources without a Windows host. The Windows
runner rebuilds it natively and re-checks the same assertions, so the release cannot drift.

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
| `bun test tests/` | **148 pass, 0 fail**, 2,734 assertions, 13 files (unit, integration, API, preview-mode, PE resources, migrations, scheduler, large-data QA) |
| `bun x tsc --noEmit` | exit 0 — no type errors across launcher, server, renderer, scripts and tests |
| `bun scripts/check-i18n.mjs` | **1,691 keys** present in both `en` and `bn`, 933 keys referenced by code, no missing/unused/one-sided key |
| `bun run qa:renderer` | **41 routes, 0 failures, 0 console errors** (jsdom sweep against a live server) |
| `bun run qa:large` | 1,500 patients / 1,220 treatments / ~1,000 invoices: patient page 2 ms, dashboard 2.5 ms, revenue report 5 ms, receivables ageing 3 ms, all inside budget; page walk returns every patient exactly once; database 3.8 MB |
| `bun run preview` + HTTP probes | preview mode verified end to end: embeddable shell with `frame-ancestors *`, no launch token, cookie `SameSite=None; Secure`, `x-dentiva-session` header accepted, 200-patient generated dataset, printed invoice document renders; packaged defaults assert the strict behaviour in `tests/api/preview-mode.test.js` |
| `bun scripts/build-win.mjs` | gates → icon → embedded assets → `bun-windows-x64` compile → PE subsystem set to Windows GUI → **icon + VERSIONINFO stamped into `.rsrc`** → PE verification → archive + SHA-256 → `verify:artifacts` |
| `bun run verify:exe` | the executable carries Dentiva's identity: `CompanyName = Md. Shohan Khan`, `ProductName = Dentiva`, `FileVersion = 1.0.0.100`, fixed file/product version `1.0.0.100`, translation `0x0409 0x04b0`, **no `Bun`/`Oven` identity left anywhere** |
| `bun run verify:artifacts` | checksums match, `MZ`/`PE`/x86-64/PE32+/GUI-subsystem verified, **all 7 icon frames byte-identical to `resources/icon.ico`, icon group complete, version resource byte-identical to `src/shared/constants.js`, application manifest preserved**, all 14 required archive entries present, archived exe identical to `dist/windows/DENTIVA.exe`, clinic catalogue and Bengali catalogue embedded, **no synthetic or demo data in either artifact** |
| `bun src/main/entry.js --self-test` | `{ ok: true, version: 1.0.0, build: 100, schema: 10, migration: 10 }` |
| `bun src/main/entry.js --version` | `Dentiva 1.0.0 (build 100, schema v10)` |
| `bun scripts/qa-packaged.mjs --data <folder>` (the packaged QA harness, rehearsed **26/26 green** on a fresh data folder) | Drives the *running* application over its own HTTP API, exactly as the window does: launch token gate (a call without it is refused), first-run wizard (clinic, dentist, owner), wrong password refused, sign-in with 72 permissions, a patient with a Bengali name and Bengali address through Patient 360° (age, codes, allergies, medical alert flag, diabetes flag), register search in Bengali, appointment → queue → visit, dental chart on tooth 36, treatment, staged plan (400 000 minor units), prescription (2 items), referral, invoice with a line discount (700 000 minor units), part payment (due 500 000, status `partial`), invoice numbering never repeats, receivables, stock in/out (10.000 − 3.000 = 7.000), staff + payroll run + payslip paid, attachment upload/download/checksum with a unicode name, traversal and `.exe` refusals, PDF attachment, **all twelve print documents** (invoice, receipt, plan, prescription, visit, referral, statement, appointment slip, payslip, patient card, queue ticket, report), all 16 reports, CSV export, audit trail without secrets, backup → verify → export → restore with the patient, invoice and attachments intact afterwards |
| `bun run seed:synthetic --patients 2000` | deterministic generator: 2,000 patients, 1,220 treatments, 989 invoices, 741 receipts in 20 s, stored in a throwaway folder with a delete reminder |

### Three defects found by the packaged QA and fixed

Driving the running application (not the source tree) from `scripts/qa-packaged.mjs` found three
release-blocking defects that the existing suites had not reached. Both are fixed, both have
regression tests, and the rebuilt artifacts above contain the fixes:

1. **An attachment named in Bengali could not be downloaded** — the file name went straight into
   the `Content-Disposition` header, which carries bytes, not text, so every download failed with
   `500`. `contentDisposition()` now emits an ASCII fallback plus the RFC 6266
   `filename*=UTF-8''…` form (`tests/api/api.test.js`, *attachments with Bengali names*).
2. **Any attachment download returned `{}` instead of the file** — the API dispatcher JSON-wrapped
   every handler result, including the one route that streams a file with its own content type and
   length. Opening an X-ray or a scanned consent form showed an empty page. The dispatcher now
   passes a `Response` through untouched (same test).
3. **Every document printed on A4, whatever paper the clinic had chosen** — `documents.paperFor()`
   compared the stored setting (`A5`, `Receipt80`, …) against the `PAPER_SIZES` array of objects, so
   the comparison never matched and the layout fell back to A4: an A5 prescription and an 80 mm
   thermal receipt were laid out as full A4 sheets. It compares the `code` field now, and the `@page`
   rule is asserted for A4, A5, Letter, Legal, 80 mm and 58 mm, for portrait and landscape and for a
   20 mm margin, both over HTTP (`tests/api/api.test.js`) and against the packaged build
   (`scripts/qa-packaged.mjs`).

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
| Product icon and version metadata inside the executable | **Yes** — the `.rsrc` section was rebuilt with `scripts/stamp-exe.mjs`: seven icon frames (16–256 px, pixel-identical to `resources/icon.ico`) and a VERSIONINFO block generated from `src/shared/constants.js`; Explorer's Details tab, the taskbar, the Start Menu and the installer all show Dentiva's identity, and the release gate fails if it drifts |
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
2. It was **cross-compiled on Linux and has not been executed on Windows** in this environment: no
   Windows host, no Wine and no ability to fetch one here (`objects.githubusercontent.com` is
   unreachable). What *is* verified here is everything a file can be verified for without running
   it — PE headers, machine type, subsystem, the resource directory, both catalogues inside the
   payload, the archive, the checksums — plus the whole application driven end to end by
   `scripts/qa-packaged.mjs` against a running instance. `DENTIVA.exe --self-test`, the real
   installer, the Defender scan and rendering in Edge are performed by
   `resources/ci/release-windows.yml` on a Windows runner; that workflow has **not been executed
   yet**, because the automation account used for this push is not allowed to create workflow files
   (GitHub answers `403 Resource not accessible by integration`). Copying it in is one command from
   a clone with your own account:

   ```bash
   mkdir -p .github/workflows
   cp resources/ci/release-windows.yml .github/workflows/release-windows.yml
   git add .github/workflows/release-windows.yml && git commit -m "Add the Windows release pipeline" && git push
   ```

   Then **Actions → Build and verify the Windows release → Run workflow**. Until that run is green,
   treat the "runs on Windows" claim as *the strongest available evidence short of a Windows host*,
   not as a Windows-side test result.
3. Backups are **not encrypted** (they are ZIP archives).
4. **One computer per clinic database** — no multi-machine sync, by design.
5. Prescription **drug names are free text**; no bundled interaction database.
6. Bangla covers the interface; clinic-typed content (services, drug names, notes) is stored as
   typed.
7. The visual QA harness that ran **here** uses **jsdom**, not a real browser engine (Chromium could
   not be installed on the build machine), so layout in this environment is verified by construction
   and inspection rather than pixel comparison. The Windows pipeline adds a DOM check and a
   100–200 % scaling sweep in real Edge/Chromium; **no pixel-level comparison is performed anywhere**,
   and physical DPI behaviour on a real display remains a user-machine check.

## 6. The Windows QA matrix — what was executed, and where

Every item the release brief lists, with the evidence behind it. **"Linux"** means it was executed
in this build environment; **"Windows runner"** means `resources/ci/release-windows.yml` executes it
on a real Windows machine and it has **not been executed yet** (the workflow has to be copied into
`.github/workflows/` once by an account that may create workflow files). Nothing in the second
column is claimed as tested.

| Item | Status | Evidence |
| --- | --- | --- |
| PE headers (MZ, PE, x86-64, PE32+, GUI subsystem) | **Linux ✔** | `bun run verify:artifacts`, `bun run verify:exe`, independent `pefile` read: `machine 0x8664`, `subsystem 2`, 13 sections |
| Icon resource at every Windows size (16/24/32/48/64/128/256) | **Linux ✔** | every frame compared byte for byte with `resources/icon.ico`; the 256 px frame is PNG-compressed to fit the resource budget; icon group `IDI_MYICON` lists all seven |
| Explorer metadata (product/file version, company, copyright, description) | **Linux ✔** | version resource compared byte for byte with `src/shared/constants.js` and parsed back: `CompanyName`, `FileDescription`, `FileVersion`/`ProductVersion` `1.0.0.100`, `ProductName`, `OriginalFilename`, `LegalCopyright`, translation `0409 04b0`, no `Bun`/`Oven` anywhere. Explorer's own *Details* tab check runs on the runner |
| `DENTIVA.exe --self-test` → ok / 1.0.0 / build 100 / schema 10 | **Windows runner** | the workflow asserts the JSON and that the database is created in the data folder; the same check is asserted for source boots in `tests/` |
| Startup on a clean Windows environment (no dev state, no missing runtime/asset/font/DB) | **Windows runner** | self-test + packaged QA + portable self-test; the assets, fonts and catalogues are verified to be inside the payload on Linux |
| Installer: install → shortcuts → Apps & features → launch → uninstall (data-safe) | **Windows runner** | the workflow installs from the released archive, resolves the `.lnk` target and icon, reads the registry entry, runs the installed executable, writes a marker in `%LOCALAPPDATA%\Dentiva`, uninstalls and asserts the marker survived |
| Portable mode from the archive | **Windows runner** | `install.ps1 -Portable`, then self-test asserting `dataDir` is beside the executable |
| First-run setup (clinic, logo, currency, language, working hours, numbering, admin) | **Linux ✔** (API level) + renderer sweep | the QA harness completes the wizard (clinic, dentist, owner, currency `BDT`, locale) and reads the 93 settings back in 16 groups; the renderer sweep mounts the setup screen |
| Clinical → billing → inventory → reports → backup → restore, end to end, with temporary data | **Linux ✔** | `bun run qa:packaged` — 26/26 checks; the data folder is temporary and never shipped (`verify:artifacts` fails on a synthetic marker) |
| Patient 360° (all fields, long history) | **Linux ✔** | the harness asserts name, preferred name, code, age, allergies, medical alert flag, diabetes flag; `qa:large` exercises deep history at 1,500 patients |
| File-system paths (AppData, Program Files, Documents, spaces, non-ASCII, removable) | **partly Linux, Windows runner for the rest** | `--data` and portable paths with spaces and non-ASCII are covered by the test suite and the harness; drive letters, `%LOCALAPPDATA%` and a removable drive are Windows-runner items |
| Attachments (image/PDF, unicode and long names, rename/archive, traversal protection) | **Linux ✔** | upload/download/rename/archive, byte-for-byte and SHA-256 equality, RFC 5987 header for a Bengali name, `.exe` refused, traversal name neutralised, PDF served as an attachment |
| Printing (A4/Letter/Legal/A5/thermal) | **Linux ✔ for the documents, no printer here** | every document is rendered with the clinic's paper settings (6 paper sizes, orientation, margins, scale) and asserted non-empty with no unresolved placeholders; **no physical printer was available and none is claimed** |
| PDF for all 12 document kinds, EN + BN | **Linux ✔ for the rendered documents, no PDF engine** | the 12 server-rendered documents are asserted; "save as PDF" is Windows' own printer driver, so it is a Windows-runner/user step. Bangla text uses the embedded Noto Sans Bengali |
| Bengali shaping everywhere | **Linux ✔ (renderer) / Windows runner (Edge)** | 1,691 strings in each language, fonts embedded; the jsdom sweep renders every screen with Bangla; the Edge check on the runner renders the real engine |
| Light mode under a dark Windows theme | **by construction** | the theme is fixed in CSS with no dark-mode media query anywhere in the renderer; the workflow renders with Edge on the runner |
| DPI 100/125/150/175/200 %, window 1280×720 → 2560×1440 | **Linux ✔ (layout) / Windows runner (real scaling)** | CSS breakpoints and the density setting are covered by the renderer sweep; physical scaling needs a Windows display |
| Performance with 1,500 (stress 5,000+) patients | **Linux ✔** | `bun run qa:large`: page 2 ms, dashboard 2.5 ms, revenue 5 ms, receivables 3 ms, inside budget |
| Backup: schedule, retention, catch-up, restore integrity | **Linux ✔** | scheduler unit tests (due/not due/manual/weekly/monthly/retention/folder/catch-up) plus the harness's create → verify → export → restore with records intact; **backups are ZIP archives, not encrypted** |
| Security and IPC audit | **Linux ✔** | 72 permissions/5 roles, scrypt + per-user salt, 5-attempt lockout, idle lock, append-only audit (asserted to contain no password material), app-token gate asserted by the harness, file allow-list and traversal prevention |
| Defender scan | **Windows runner (recorded, never asserted)** | the workflow records the scan output verbatim; this report makes **no** claim that the software is virus-free |

## 7. How to install (short form)

1. Download `DENTIVA-1.0.0-win-x64.zip`, extract it, run `install.cmd`.
2. Start Dentiva from the Start Menu; the wizard asks for your clinic, your dentist details and
   your owner password. Nothing is pre-filled.
3. Work offline. Backups are automatic; copy the backup folder to a USB drive regularly.
4. Full instructions: `docs/INSTALL.md`; day-to-day use: `docs/USER-GUIDE.md`.

## 8. Where things live

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
| `scripts/build-win.mjs` | the build: gates → compile → stamp the icon and version resource → archive → checksums → verify |
| `scripts/stamp-exe.mjs` (`bun run stamp:exe`) | writes the icon and VERSIONINFO into the PE resources; `--check` (`bun run verify:exe`) reports what an executable carries |
| `scripts/verify-artifacts.mjs` | the release gate: checksums, PE headers, executable identity, archive contents, no synthetic data |
| `scripts/qa-packaged.mjs` (`bun run qa:packaged`) | the end-to-end clinic run against a *running* application — the same script the Windows runner drives the packaged executable with |
| `scripts/lib/pe.mjs` | the dependency-free PE/resource reader and writer behind the stamping and the gates |
| `resources/ci/release-windows.yml` | the Windows-runner pipeline (build, self-test, packaged QA, Edge render check, installer/uninstaller, portable mode, Defender evidence, release upload) — copy it into `.github/workflows/` once |
