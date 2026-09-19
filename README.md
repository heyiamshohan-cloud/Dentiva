# Dentiva — Dental Practice Management System

**Version 1.0.0 · build 100 · database schema v10**

Dentiva is an offline-first practice management system for a dental clinic, delivered as a
single self-contained Windows executable. It runs on one computer with no server, no cloud
account, no subscription and no internet connection: patient records, the dental chart,
scheduling, prescriptions, referrals, billing, payroll, inventory, reports, printing and
backups all work on the local machine, and nothing is ever sent anywhere.

* **Two languages** — English (default) and বাংলা, switchable at any time, with the fonts
  bundled inside the executable.
* **Light mode only** — the interface stays light no matter what Windows is set to.
* **Real data only** — the shipped application contains no demo patients, no sample clinic
  and no example invoices. The first launch asks for your clinic and your own administrator
  account.

---

## What's in the box

| Deliverable | Path |
| --- | --- |
| Portable application | `dist/windows/DENTIVA.exe` |
| Release archive (application + installer + docs) | `dist/DENTIVA-1.0.0-win-x64.zip` |
| Checksums | `dist/SHA256SUMS.txt` |

See **[docs/INSTALL.md](docs/INSTALL.md)** for installing, portable/USB use, command-line
switches and uninstalling, and **[docs/USER-GUIDE.md](docs/USER-GUIDE.md)** for how each
module is used day to day.

---

## Modules

| Group | Screens |
| --- | --- |
| Clinic | Dashboard · Patients (+ Patient 360°) · Appointments · Calendar · Queue |
| Clinical | Visits · Dental chart · Treatments · Treatment plans · Prescriptions · Referrals · Attachments |
| Money | Billing (invoices) · Payments & receipts · Receivables · Finance (income, expenses, profit) |
| Operations | Staff · Payroll · Inventory & stock movements · Suppliers · Reports |
| System | Settings · Users & roles · Audit log · Backup / restore / import / export · About |

72 permissions across 5 built-in roles (Owner, Dentist, Receptionist, Accountant, Assistant),
a per-user override list, an append-only audit log, soft-delete/archiving for clinical and
financial records, 16 built-in reports with CSV and print/PDF output, 12 print documents
(A4/A5/Letter/Legal/thermal), and automatic backups with retention, verification and catch-up.

---

## Running from source

Requirements: **Bun 1.4+** (the only tool needed; there are no runtime npm dependencies).

```bash
bun install                    # dev dependencies only (fonts, types, test tooling)
bun run start                  # launcher + browser window against a dev database
bun run serve                  # just the HTTP API on http://127.0.0.1:7777
```

Data lives in `%LOCALAPPDATA%\Dentiva` on Windows and `./data` on other platforms unless
`--data <dir>` or `DENTIVA_DATA_DIR` says otherwise.

### Browser preview (development only)

```bash
bun run preview                 # http://localhost:4747 with a generated dataset
bun run preview --port 8080     # pick another port
bun run preview --reset         # throw the preview database away and start over
```

The preview exists so the application can be opened from a browser outside this machine (an
editor preview pane, a phone on the same network): it binds `0.0.0.0`, drops the launch token and
allows framing, and its session cookie is `SameSite=None; Secure` so it survives inside a frame.
It always runs on a **generated** dataset in `.synthetic-data/` and refuses to start if the
dataset cannot be produced. Never point it at a real clinic folder — the packaged application
keeps all the strict defaults (loopback only, launch token, `SameSite=Strict`, `frame-ancestors
'self'`), and the release gate fails if generated data ever reaches an artifact.

### Quality gates

```bash
bun test tests/            # 135 tests: unit, integration, API, preview-mode, migrations,
                           # scheduler and large-data QA
bun x tsc --noEmit         # type check (scripts, server, renderer and tests are all JS + JSDoc)
bun run lint:i18n          # every visible string exists in en + bn and is actually referenced
bun run qa:renderer        # jsdom sweep: 41 routes rendered against the live API, 0 console errors
bun run qa:large           # synthetic 1,500-patient dataset with paging/report budgets
bun run verify:artifacts   # release gate: checksums, PE headers, archive contents, no demo data
```

### Building the Windows executable

```bash
bun run build:win          # gates → icon → embedded assets → compile → PE checks → zip + SHA256
bun run build:win:fast     # same, skipping the test gates
```

The build cross-compiles for `bun-windows-x64`, patches the PE subsystem from console to
**Windows GUI** (so no console window appears) and verifies the DOS/PE headers, machine type
and embedded payload before writing the archive and checksums.

---

## Repository layout

```
src/main/            launcher: data dir, single instance, window, logging, CLI switches
src/server/          HTTP API, services (domain logic), SQLite layer, migrations, documents
src/shared/          i18n catalogues (en, bn), constants, error codes shared with the renderer
src/renderer/        the application UI (vanilla ES modules, no framework, no build step)
resources/           clinic defaults, icon, installer scripts
scripts/             build, asset embedding, icon, i18n checker, seeding and QA harnesses
tests/               unit, integration, API, migration and large-data tests
docs/                install, user guide, security, data model, architecture, dependencies
```

## Verification status

Everything in the release archive was produced by the commands above in this repository:

* `bun test tests/` — 135 pass, 0 fail (2,308 assertions)
* `bun x tsc --noEmit` — clean
* `bun run lint:i18n` — 1,691 strings in each language, 933 referenced keys resolved
* `bun run qa:renderer` — 41 routes, 0 failures, 0 console errors
* `bun run verify:artifacts` — checksums, PE headers, archive contents and payload agree; no
  synthetic data in either artifact
* `bun run qa:large` — 1,500 patients: paging, search, dashboard, four reports and the inventory
  report inside their budgets; the page walk returns every patient exactly once

Behaviour that could not be verified on this machine (a Linux builder, not Windows) is listed
honestly in [docs/CHANGELOG.md](docs/CHANGELOG.md) under *Known limitations*.

---

## Licence

Proprietary commercial software — © 2026 Md. Shohan Khan. See [LICENSE](LICENSE).
Third-party components and their licences: [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md).
