# Dentiva — changelog

All notable changes to Dentiva are recorded here. Version numbers follow semantic versioning
(`MAJOR.MINOR.PATCH`); the build number increases with every packaged build and the database
schema has its own version, reported on the About screen (`1.0.0 · build 100 · schema v10`).

---

## 1.0.0 — first commercial release (build 100, schema v10)

The first complete release: a clinic can install it, register patients, treat them, bill them,
pay staff, manage stock, run the practice's books, print everything on paper or PDF, and back the
whole thing up — with no internet connection, no subscription and no demo data.

### Application and platform

* Native Windows executable (`DENTIVA.exe`, x64) produced with `bun build --compile`, packaged with
  a per-user installer (`install.ps1` / `install.cmd`) that creates Start Menu and Desktop
  shortcuts and registers in *Apps & features*.
* Portable mode for a USB stick (`--portable`, or an existing `data` folder beside the exe).
* Single-instance locking, `--stop`, `--self-test`, `--version`, `--help`, `--data`, `--port`,
  `--no-window`, `--browser`, `--size`, `--dev`, `--quiet`.
* Application window in Microsoft Edge/Chrome app mode with its own profile folder; no console
  window (the PE subsystem is set to Windows GUI and the parent console is re-attached for
  command-line switches); a native message box reports a launch that failed before a window
  existed.
* Launcher log per day in `<data>\logs`, with the path shown in the error dialog.

### Data and migrations

* Schema v10: 61 tables, 5 views, 117 indexes, FTS5 search index, all created by ten additive,
  transactional migrations.
* Money as integer minor units, quantities as integer thousandths, percentages in basis points.
* Migration 010 added `treatments.quantity_milli` and `treatments.tax_rate_bp` so editing a
  treatment can no longer change a stored total.
* Clinic provisioning: a new database installs the clinic default catalogue (14 expense
  categories, 3 income categories, 5 appointment types, 7 inventory categories, 5 payment
  methods) from `resources/clinic-defaults.json`, embedded in the executable; the template is
  versioned, idempotent and re-appliable with `bun run seed:defaults`.

### Clinical

* Patients with configurable fields, duplicate checking, medical flags and alerts, custom fields,
  key-value contacts, notes, archive/restore and a Patient 360° view (overview, clinical, plans,
  prescriptions, referrals, files, billing, timeline).
* Visits, diagnoses, per-tooth dental chart (adult and primary, FDI numbering, conditions,
  surfaces, history), treatments, staged treatment plans, prescriptions with templates, referrals.
* Attachments with an extension/MIME allow-list, 25 MB limit, SHA-256 checksums, safe stored
  paths and inclusion in backups.

### Scheduling

* Appointments with conflict detection, configurable slot step, duration, working days/hours,
  types, statuses and reasons; day/week/month calendars.
* Queue with token numbers, check-in from the appointment or as a walk-in, called/in-chair/
  completed/skipped states and a printable ticket.

### Money

* Invoices (draft → issued → void with reason), line items with quantity, discount and tax,
  server-calculated totals, and never-reused numbers.
* Payments, partial payments, patient credit, refunds and voids, configurable payment methods,
  printable receipts; receivables ageing in five buckets.
* A Finance section of its own: income, expenses, categories, period summary, monthly trend,
  revenue by service, and profit — separate from the dashboard.

### Operations

* Staff records, five roles, payroll runs (gross, deductions, net, paid, due), payslips, and
  automatic posting of net pay as an expense.
* Inventory with stock movements as the only mutation path (in/out/adjustment/disposal/return),
  low-stock and expiry warnings, valuation at cost and retail; suppliers.

### Reports and documents

* Sixteen reports (patients, demographics, appointments, visits, treatments, procedures,
  prescriptions, referrals, revenue, collections, receivables, expenses, profit, practitioners,
  inventory, audit), each with totals, CSV export and printing.
* Twelve print documents: invoice, receipt, prescription, treatment plan, visit summary, referral
  letter, patient statement, patient card, appointment slip, queue ticket, payslip and any report —
  on A4, A5, Letter, Legal or thermal 80/58 mm, with "Save as PDF" always available.

### Security and reliability

* scrypt password hashing with per-user salt, password policy, lockout after repeated failures,
  session length and idle lock, optional refund PIN.
* 72 permissions, five built-in roles, per-user overrides; enforcement on every route and on every
  printed document.
* Append-only audit log with before/after diffs, filterable, exportable and printable; passwords
  and hashes are never logged.
* Random per-launch application token on every API call, HttpOnly session cookie, loopback-only
  binding, path-traversal protection, validated request bodies with typed errors.
* Automatic backups with schedule (daily/weekly/monthly/manual), retention, optional
  verification, a configurable folder, catch-up when the computer was off at the scheduled time,
  an overdue reminder, and a visible schedule card on the Backup screen.

### Localization and interface

* English (default) and Bengali, 1,691 strings in each catalogue, checked by `bun run lint:i18n`
  (no missing, unused or one-sided key).
* Bengali digits and dates, configurable date/time format and week start; bundles Inter and Noto
  Sans Bengali, so both languages render without any installed font.
* Light mode only, by design; responsive layout from 1280 × 720 to ultrawide and from 100 % to
  200 % DPI; comfortable and compact density.

### Verification in this build

| Gate | Result |
| --- | --- |
| `bun test tests/` | 129 pass, 0 fail (2,285 assertions, 11 files) |
| `bun x tsc --noEmit` | clean |
| `bun run lint:i18n` | 1,691 keys in en + bn, 933 referenced keys resolved |
| `bun run qa:renderer` | 41 routes, 0 failures, 0 console errors |
| `bun run qa:large` | 1,500 patients — every measured interaction inside budget |
| `bun scripts/build-win.mjs` | quality gates, PE verification, archive and SHA-256 written |

---

## Known limitations of 1.0.0

These are stated plainly because they matter to a clinic, and none of them is hidden behind a
disabled button or a placeholder screen:

1. **The executable is not code-signed.** Windows SmartScreen may warn on first launch
   ("Windows protected your PC" → *More info* → *Run anyway*). Code signing requires a paid
   certificate and is a distribution decision for the vendor.
2. **Built on a Linux machine for Windows.** The release executable is cross-compiled and its PE
   headers, subsystem, machine type and embedded payload are verified by the build script, but it
   could not be *executed* on Windows during this build. The product metadata and icon resource
   inside the `.exe` are therefore not stamped (a `--windows-*` Bun switch needs a Windows host);
   the installer puts the shipped `icon.ico` on the shortcuts instead. Re-running
   `bun run build:win` on Windows produces the same application with the icon and metadata
   embedded.
3. **Backups are not encrypted.** They are ordinary ZIP archives. Store them on an encrypted
   drive if the clinic requires encryption at rest.
4. **One computer, one clinic per database.** Dentiva is intentionally single-user-at-a-time and
   offline; there is no multi-machine sync. A second computer needs its own database (or a
   restore from backup), and simultaneous editing across machines is not supported.
5. **Prescription drug names are free text.** There is no bundled interaction database, because
   every commercial interaction dataset requires a paid subscription; clinical judgement and
   local formularies remain authoritative.
6. **Bangla localization is complete for the interface, not for clinical drug names.** Strings
   typed by the clinic (services, drug names, notes) appear exactly as typed.
7. **The visual QA harness runs in jsdom**, not in a real browser engine; Chromium could not be
   installed on this build machine. Layout, focus and print-preview behaviour were verified by
   inspection and by the print stylesheet, not by pixel comparison. `bun run qa:renderer` fails on
   any console error, which catches the majority of regressions.
