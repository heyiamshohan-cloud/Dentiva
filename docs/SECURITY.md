# Dentiva — security and data protection

Applies to Dentiva 1.0.0 (build 100, schema v10).

Dentiva holds identifiable health information, so it is built as a single-machine system with a
deliberately small attack surface: nothing is exposed to the network, nothing leaves the
computer, and every sensitive action is permission-checked on the server and recorded.

---

## 1. Deployment model

```
Windows desktop → DENTIVA.exe → loopback HTTP server (127.0.0.1, random port)
                                        ↑
                            application window (Edge/Chrome in app mode)
```

* The HTTP server binds to **127.0.0.1 only**. It is never started on `0.0.0.0`; there is no
  configuration to make it public.
* Each launch generates a random **application token** (32 bytes, hex). Every `/api/**` request
  must carry it in the `x-dentiva-app` header, so another local program that discovers the port
  still cannot talk to the API. The token lives in the launcher and the window only.
* The window is a normal browser in app mode, so there is no embedded web engine to patch and
  no `nodeIntegration`-style escape hatch. The renderer is plain ES modules loaded from the same
  server; it never receives file-system or process APIs.
* No file is served from outside the application's own asset set: static paths are normalised and
  rejected if they escape the asset root (path-traversal test in `tests/api/api.test.js`).

## 2. Authentication

* Accounts live in the `users` table with a **scrypt** hash and a per-user salt; the algorithm and
  its parameters are stored next to the hash so they can be strengthened later. Plain-text or
  reversible storage is not implemented anywhere.
* Sessions are server-side rows referenced by a **HttpOnly, SameSite=Strict cookie**
  (`dentiva_session`) valid for at most `security.sessionMaxHours` (12 hours by default).
  `SameSite=Strict` plus the loopback-only server means no third-party page can drive the API.
* Idle lock: `security.idleTimeoutMinutes` (15 minutes by default) ends the session and the window
  returns to the sign-in screen. The window also keeps the session alive with a keep-alive call
  while the user is active.
* Brute-force protection: `security.maxFailedAttempts` wrong passwords (5 by default) locks the
  account for `security.lockoutMinutes` (15 minutes). Failures are counted per account, and the
  attempt is audited whether or not it succeeds.
* Password policy: minimum length `security.minPasswordLength` (10 by default), strength rules
  when `security.requireStrongPassword` is on, and the well-known weak passwords
  (`password`, `dentiva`, `admin`, `123456`, `qwerty`, `welcome`) are always refused.
* A password can be reset by an Owner, who cannot see the old one. The account is then marked
  *must change password*, so a reset also triggers a new choice at next sign-in.
* Optional refund PIN (`security.requirePinForRefunds`) gates refunds with a separate PIN hash.

### If the owner password is lost

There is no back door, by design. Recovery options, in order of preference:

1. Sign in as any other Owner-role account and reset the password.
2. Restore a backup that contains a known-good password.
3. Ask a dentist's IT support to reset the hash directly in `dentiva.db` with the SQLite CLI —
   this requires local file access to the data folder and is therefore out of scope of the
   application's own protections. Everything about it is visible in the audit log afterwards.

## 3. Authorisation

* **72 permissions** in nine modules, grouped into five built-in roles:

  | Role | Permissions | Typical use |
  | --- | --- | --- |
  | Owner | 72 | proprietor |
  | Dentist | 38 | clinical work |
  | Receptionist | 25 | desk work |
  | Accountant | 27 | money only |
  | Assistant | 23 | chairside help |

* Each user may additionally have **explicit allow/deny overrides** per permission; an explicit
  deny always wins.
* Enforcement happens in two places, and the server is the one that matters:
  * the HTTP layer resolves a required permission for every route from `ROUTE_PERMISSIONS`
    (first matching prefix wins) and refuses the request with `403` and a typed error body;
  * the renderer hides what a user cannot do, so a restricted user never sees a door they cannot
    open — but hiding is never the only protection.
* Print documents (`/documents/**`) re-check permissions for the document's module
  (`billing.view` for an invoice, `payroll.view` for a payslip, and so on) and refuse
  unauthenticated clients (covered by a test).
* Every permission code is mirrored between the code and the database, and a test fails if the two
  ever drift apart.

## 4. Audit logging

* `audit_logs` is append-only from the application's point of view: no screen offers to edit or
  delete an entry.
* Recorded: sign-in, sign-out, lockout, password change, patient create/update/archive/delete,
  clinical records, chart entries, treatments, plans, prescriptions, referrals, attachments,
  appointments, queue moves, invoice issue/void, payments, refunds, payroll, inventory movements,
  expenses and income, settings changes, user and role changes, backups, restores, imports and
  exports — each with user, timestamp, module, entity, summary, severity, IP and a before/after
  diff of the changed columns.
* **Passwords, password hashes, salts and PINs are never written to the log** (there is an
  explicit test for it). The diff helper receives only the columns that were changed, and the
  password columns are never among them.
* Retention is `security.auditRetentionDays` (1095 days by default); the audit screen exports and
  prints a range for external review.

## 5. Data at rest and in transit

* All data lives in one SQLite file plus an attachments folder inside the data directory
  (`%LOCALAPPDATA%\Dentiva` by default). There is no server, so nothing is in transit: the
  browser talks to 127.0.0.1 over the loopback interface in the same machine.
* Attachments are stored with a generated file name inside the data root; the original name is
  kept as metadata only. A stored path is resolved and then verified to stay inside the data root,
  so a crafted record cannot read `..\..\Windows\System32`.
* Uploaded files are restricted to an allow-list of extensions and MIME types
  (jpg/jpeg/png/webp/gif/bmp/tif/tiff/pdf/dcm/txt/csv/doc/docx/xls/xlsx/odt/ods) and to 25 MB
  per file. Anything else is refused with a typed error.
* Financial and clinical records are **soft-deleted**: archiving keeps the record, its history and
  its documents, and it can be restored by an Owner. Permanent deletion of a patient requires the
  `patients.delete` permission plus an exact typed confirmation; invoices are voided, never
  deleted once issued.
* Backups are ordinary ZIP archives (database snapshot + manifest with SHA-256 checksums +
  attachments). They are **not encrypted**: store them on an encrypted drive or in an encrypted
  container if the clinic requires encryption at rest, and treat the backup folder with the same
  care as the database itself.

## 6. Integrity

* Money is stored as **integer minor units** (paisa/cents) and quantities as **integer
  thousandths**. No floating-point arithmetic is used for any amount; a shared decimal helper
  parses, rounds, discounts, taxes and allocates totals, and the invoice/plan line totals are
  calculated server-side so a stored total always equals the sum of its lines (asserted by tests).
* Invoice and receipt numbers come from a per-clinic counter table and are never reused, even
  after a void. Concurrent numbering is protected by a transaction.
* Every migration runs inside a transaction, is additive, and records itself in
  `schema_migrations`; a migration never deletes or rewrites patient, clinical or financial rows.
* `PRAGMA foreign_keys` is on, so a missing parent row cannot be created. Timestamps are ISO-8601
  text (sortable, timezone-aware), never locale-formatted strings.

## 7. What leaves the machine

Nothing, unless a person asks for it:

| Action | What happens |
| --- | --- |
| Normal use | No network access at all. The only TCP socket is the loopback server for the window |
| Printing | The Windows print spooler, via the browser print dialog |
| Save as PDF | The Windows "Microsoft Print to PDF" driver, via the same dialog |
| Backup / export | A file in the data folder or a location the user chooses (a USB drive, for example) |
| Import patients | A CSV the user picks; the file is read locally |

There is no telemetry, no crash reporting, no licence check, no update check and no
advertising identifier. The About screen lists the exact version you are running, and the
documented way to check for a newer build is to look at the vendor's release page — Dentiva
itself never phones home.

## 8. Operational guidance for clinics

1. Give every staff member their own account; never share a login. The audit log is only
   meaningful if accounts are personal.
2. Keep the receptionist role for the front desk: it can register patients, book appointments,
   raise invoices and take payments without seeing payroll or clinical notes.
3. Turn on automatic backups (they are on by default) and copy the backup folder to a USB drive
   or another computer weekly. A backup on the same disk does not protect against that disk
   failing.
4. Keep Windows updated and the machine's disk encrypted (BitLocker) if the clinic is in a shared
   space; Dentiva cannot protect data from someone who takes the disk.
5. Review the audit log's *security* severities monthly, and check the notification bell for
   failing automatic backups.
6. Before handing the computer to new staff, sign out; the idle lock will also do it, but a
   deliberate sign-out is cleaner.

## 9. Security verification in this build

| Check | How it is verified |
| --- | --- |
| App-token gate | `tests/api/api.test.js` — API refuses calls without the token |
| Session gate | same file — API refuses calls without a session cookie |
| Path traversal | same file — crafted static paths are rejected |
| Permission enforcement | same file — a limited role is refused protected routes |
| Documents require auth | same file — `/documents/invoice/:id` returns 401 anonymously |
| No route returns 500 for valid input | same file — every mounted route is probed |
| No password in the audit log | same file / clinical tests — secret columns are never logged |
| Money arithmetic | unit tests for the decimal helpers and integration tests for invoice totals |
| Migrations are safe | migration tests apply v1→v10 to a legacy database and assert data survives |
| Large data | `bun run qa:large` — 1,500 patients with paging, search and report budgets |
| Renderer integrity | `bun run qa:renderer` — 41 routes rendered with zero console errors |

Known limitations are listed honestly in [CHANGELOG.md](CHANGELOG.md). In particular, backups are
not encrypted, the executable is not code-signed, and the Windows-specific paths (native message
box, parent-console attach, the shortcut and Explorer icon) are verified by inspection, by the
resource-level checks in `bun run verify:exe` / `bun run verify:artifacts`, and by
`resources/ci/release-windows.yml` when it runs on a Windows machine — not by running on Windows
hardware from this Linux builder.
