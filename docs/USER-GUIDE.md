# Dentiva — User Guide

**Dentiva 1.0.0 · build 100 · database schema v10**

This guide walks through everything the application does, in the order a clinic uses it.
Screens are listed in the sidebar under five groups: **Clinic**, **Clinical**, **Money**,
**Operations** and **System**.

If you have not installed yet, start with [INSTALL.md](INSTALL.md). The first launch asks for
your clinic details and creates your owner account — there is no sample data to clean up.

---

## 1. Signing in and the application window

* The application opens in its own window (Microsoft Edge or Chrome in app mode). There are no
  browser tabs, no address bar, and nothing outside your computer is contacted.
* Sign in with the username and password created in the wizard.
* Sessions last at most `security.sessionMaxHours` (12 hours by default). After
  `security.idleTimeoutMinutes` without activity (15 minutes by default) Dentiva locks
  itself and asks for the password again — useful when you leave the desk.
* `security.maxFailedAttempts` wrong passwords (5 by default) locks the account for
  `security.lockoutMinutes` (15 minutes). Every attempt, including the failures, is written to
  the audit log.
* Sign out from the account menu at the top right.

### Keyboard

| Keys | Action |
| --- | --- |
| `Ctrl` + `K`, or `/` | Command palette — type a patient, invoice, treatment or a patient code |
| `Ctrl` + `N` | New patient |
| `Esc` | Close the open dialog, menu or drawer |

Every screen is also reachable from the sidebar, which collapses with the ◧ button and
remembers your choice.

---

## 2. Language

Choose **English** or **বাংলা** in **Settings → Language**. The change is instant and applies to
screens, printed documents, dates, numbers and the Bengali digit set. The choice is stored per
user, so a bilingual clinic can run both.

Dates, times, currency and digit shaping follow the same screen:

* date format (DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, DD-MM-YYYY, DD.MM.YYYY),
* 12-hour or 24-hour clock,
* week start day,
* currency code and symbol chosen during setup.

---

## 3. Dashboard

The dashboard is the morning overview, not an accounting screen (finance has its own section):

* today's appointments and who is already in the queue,
* patient count and new registrations for today/this month,
* collected vs outstanding money,
* low-stock and expiring inventory warnings,
* treatments and visits recorded today,
* a short activity list from the audit log.

Every number is clickable and lands on the matching filtered list. The dashboard can be
rearranged in **Settings → Dashboard** by unticking widgets you do not use.

---

## 4. Patients

### Registering a patient

**Patients → New patient** (or `Ctrl` + `N`). Identity fields are configurable in
**Settings → Patients**: require a phone number, show occupation, blood group, national ID and
referral source, and choose which columns appear in the list.

* Patient codes are generated from `patients.codePrefix`, `patients.codePadding`,
  `patients.codeStart`, `patients.codeIncludeYear` and `patients.codeResetPolicy` (for example
  `DEN-000123`).
* When `patients.duplicateCheck` is on, Dentiva warns before saving a patient whose name,
  phone or date of birth resembles an existing record, and shows the candidates.
* Medical alerts (diabetes, hypertension, heart disease, asthma, bleeding disorder, pregnancy,
  smoking, anticoagulants, hepatitis, kidney disease, thyroid disorder, free-text alert flag)
  are recorded on the patient and surfaced as a coloured badge everywhere the patient appears.

### The patient list

Search by name, code, phone, e-mail or city; filter by status, gender and registration date
range; sort any column. The list is paginated server-side, so a register with tens of thousands
of patients pages as quickly as one with ten (see `bun run qa:large`).

### Patient 360°

Opening a patient shows one page with everything about them:

| Tab | Contents |
| --- | --- |
| Overview | contact details, medical and dental history, alerts, balance |
| Clinical | visits, treatments and the dental chart |
| Plans | treatment plans with progress and totals |
| Prescriptions | every prescription written for the patient |
| Referrals | referrals out and their documents |
| Files | attachments (photographs, x-rays, scans, reports) |
| Billing | invoices, payments, receipts and the running balance |
| Timeline | one chronological list of everything above |

Actions on the record: **Edit**, **Add note** (internal notes with their own list), **Archive**
(soft-delete, restorable) and **Print statement** (patient ledger with opening balance, invoices,
payments and closing balance).

Archived patients stay in the database, keep their clinical and financial history, and can be
restored by an Owner. A permanent delete exists only for records created by mistake and requires
the exact confirmation text plus the `patients.delete` permission.

---

## 5. Appointments, calendar and queue

### Appointments

* Working days, opening/closing times, default appointment length, reminder lead time, the
  slot step and whether double booking is allowed all come from **Settings → Appointments**.
* Book with date, time, practitioner, appointment type and reason. Dentiva refuses a
  double-booked slot unless you allowed it in settings, and offers the free slots around it.
* Statuses: scheduled, confirmed, checked-in, in-progress, completed, cancelled, no-show.
  Cancelling keeps the record and asks for a reason.
* The list filters by date range, practitioner, status and type; day sheets and the
  **Calendar** screen show a week or month grid with drag-free rescheduling (open the
  appointment and change the time).

### Queue

**Queue** is the waiting room for today. Check a patient in (from the appointment or directly),
and Dentiva gives them a token number from `queue.startNumber`. Then the front desk moves them
through **Called → In chair → Completed**, or **Skipped/Cancelled**. The queue refreshes itself
every 30 seconds, and the Dashboard and notification bell use the same state.

---

## 6. Clinical records

### Visits

A visit is one consultation: date, time, practitioner, chief complaint, clinical notes,
diagnosis, advice, follow-up date and the treatments performed in that session. Visits are the
hinge between the chart, treatments, prescriptions and the invoice.

### Dental chart

A full adult (permanent) and child (primary) chart, FDI numbering, with per-tooth conditions
(caries, filled, crown, root canal treated, missing, impacted, implant, sealant and more),
surface selection (mesial, distal, buccal, lingual, occlusal), status and notes. Every entry is
timestamped and attributed to a user; changing or clearing an entry asks for the new state and
keeps the history, so the chart is a record rather than a drawing. The patient card can be
printed for the paper file, and a visit summary carries the treatment record of that session.

### Treatments

Record a procedure against a patient (and optionally a visit) with tooth/teeth, procedure name
from your price list, fee, quantity (with thousandths of a unit for materials) and tax rate.
Treatments can be marked planned → in progress → completed, and can be added to an invoice
directly from the treatment row.

### Treatment plans

A plan groups several staged procedures with a title, description, estimated sessions and a
validity date. Each item carries quantity, unit price, discount and tax; the plan shows line
totals, subtotal, discount, tax and grand total, plus accepted/completed progress. Plans print
as a patient-facing quotation with the clinic letterhead, and can be converted into treatments
as they are performed.

### Prescriptions

Prescriptions have their own number series and a printed layout with diagnosis, advice and
follow-up. Each item holds a drug name, strength, form, dose, frequency, duration and
instructions. Drug names are free text — nothing is validated against an online service, because
there is no internet requirement — and frequently used combinations can be saved as templates.

### Referrals

Record a referral to an outside doctor or hospital with reason, urgency, clinical summary and
the report that must come back. The referral letter prints on the clinic letterhead with the
patient's details, and returning reports can be attached to the referral.

### Attachments

Attach x-rays, intra-oral photographs, scanned consent forms or lab reports to a patient, visit
or treatment. Allowed file types are a fixed allow-list (images, PDF, common documents) up to
25 MB per file; the file name is sanitised and stored inside the data folder, never by an
absolute path from the browser. Each attachment is checksummed, listed with size and type, and
included in backups when `backup.includeAttachments` is on.

---

## 7. Billing and payments

### Invoices

* Create an invoice for a patient with line items (description, quantity, unit price, discount,
  tax), or generate one from the visit's treatments. Numbers come from
  `billing.invoicePrefix`, `billing.padding`, `billing.includeYear` and `billing.resetYearly`
  and are never reused.
* Statuses: **draft** (editable, can be deleted) and **issued** (frozen, printed, payable).
  Issued invoices can only be voided with a reason, which keeps the document and its number.
* Totals are calculated once on the server with integer arithmetic — quantity in thousandths,
  money in minor units — so the printed total always equals the sum of the lines.
* The invoice document prints on A4/Letter by default and can be reprinted any number of times;
  the print event is recorded.

### Payments and receipts

* Record a payment against an invoice (partial payments allowed), or an unallocated payment that
  becomes patient credit and is applied to future invoices with **Apply credit**.
* Payment methods are configurable in **Settings → Billing**. A new clinic starts with cash,
  bank transfer, card, mobile financial service and “other”; rename them, add bKash/Nagad/cheque,
  or set whether a method requires a reference number. Each payment stores the method, reference
  number and note.
* Each payment produces a **receipt** with its own number series. Receipts print on the thermal
  80 mm or 58 mm roll by default (`print.receiptPaper`) or on paper — the same document, a
  different paper size.
* Refunds and voids are separate, permission-controlled operations; the original record is kept
  and the reversal is shown in the patient ledger and the audit log.
* Recording an overpayment asks for confirmation instead of silently creating a large credit.

### Receivables

Aged debt across the clinic in five buckets — not yet due, 1–30, 31–60, 61–90 and over 90 days —
per patient, with the invoice list behind each figure. The ageing list prints and exports to CSV
for a month-end review.

---

## 8. Finance (separate from the dashboard)

**Finance** is the practice's own bookkeeping:

* **Income** — non-treatment income (laboratory work sold, insurance settlements, rent of the
  chair, courses) with category, date, amount, method and note.
* **Expenses** — rent, salaries, materials, utilities, marketing, maintenance, tax and more,
  each with category, date, amount, vendor and payment method. Payroll can post its net pay as
  an expense automatically (`payroll.autoExpense`).
* **Summary** — income, expenses, net profit, collections and receivables for the selected
  period, with a month-by-month trend, categories ranked by amount and revenue by service.
* Income and expense categories ship with the clinic defaults and can be extended, renamed or
  deactivated. Delete is only offered for entries that are not referenced elsewhere; financial
  records are otherwise voided or archived, never silently removed.

---

## 9. Staff and payroll

* Staff records hold name, role, designation, contact details, joining date and status
  (active, inactive, suspended, left), and can be linked to a login user.
* Salary: monthly, daily, hourly or contract, with the base amount and allowances.
* **Payroll** runs a period per staff member: gross, deductions (advance, absence, tax, other),
  net, paid and due. Payments are recorded against the run, and the totals
  (net/paid) are shown for the period. A payroll run can post a matching expense entry.
* Practitioner performance (appointments, visits, treatments, revenue) is available in
  **Reports → Practitioners** and on the staff record.

---

## 10. Inventory and suppliers

* **Inventory** items carry SKU, name, category, unit, quantity, minimum stock, purchase and sale
  price, supplier, batch number, expiry date, storage location and condition.
* Quantities are stored with thousandths of a unit, so half a syringe or 0.5 ml is exact.
* **Stock movements** are the only way the quantity changes: `in`, `out`, `adjustment`, `disposal`
  and `return`. Each movement records the date, quantity, unit cost, reason, reference, batch,
  expiry and the user, and keeps a running balance. A movement that would drive stock below zero
  is refused unless negative stock is explicitly allowed in settings.
* The item list flags low stock (`quantity ≤ minimum`) and items expiring within 30 days; the
  **Inventory report** shows valuation at cost and at retail, grouped by category.
* **Suppliers** hold name, contact person, phone, e-mail, address, tax number and notes, and
  appear on purchase movements and supplier reports.

---

## 11. Reports

Sixteen reports, each filterable by date range, printable and exportable to CSV:

| Category | Reports |
| --- | --- |
| Patients | Patients register · Demographics |
| Scheduling | Appointments |
| Clinical | Visits · Treatments · Procedures · Prescriptions · Referrals |
| Finance | Revenue · Collections · Receivables · Expenses · Profit |
| Staff | Practitioners |
| Inventory | Inventory (stock, valuation, low stock, expiry) |
| System | Audit log |

Reports show totals that reconcile with the underlying records (the test suite asserts revenue
equals the sum of issued invoices and that the ageing buckets add up to total outstanding).
Large reports render the first 500 rows and tell you so; the CSV export contains everything.
Printing a report uses the same paper settings as documents and can be saved as PDF.

---

## 12. Settings

Ninety-three settings in sixteen groups. The important ones:

| Group | Examples |
| --- | --- |
| Clinic | name, address, phone, e-mail, registration and tax numbers, logo text |
| Branding | accent colour (teal, indigo, slate, emerald), logo in header/documents |
| Language | language, date format, time format, week start |
| Appearance | comfortable/compact density, sidebar state, animations |
| Patients | code format, required fields, list columns, duplicate checking |
| Appointments | working days and hours, slot step, duration, double booking, queue |
| Billing | invoice/receipt prefixes and padding, tax label and default rate, rounding |
| Printing | default paper (A4/A5/Letter/Legal/thermal 80/58 mm), orientation, margins, scale, logo, signatures, copy label, PDF file-name pattern |
| Notifications | enable/disable, quiet hours, per-kind switches, follow-up look-ahead |
| Security | idle timeout, session length, failed attempts, lockout, password length/strength, refund PIN, audit retention |
| Backup | automatic backup on/off, frequency, time, retention count, folder, attachments, verification, overdue reminder |
| Finance / Inventory / Payroll / Staff | numbering, negative stock, auto expense, salary defaults |
| Data | export formats and import behaviour |

Changes are validated on the server: an unknown or out-of-range value is rejected with a
field-level message rather than being stored.

---

## 13. Users, roles and permissions

* **Users** lists accounts with role, status and last sign-in. Create, edit, deactivate, reset
  password (which forces a change on next sign-in) and review active sessions.
* **Roles** shows the five built-in roles and their permission sets, and lets an Owner create
  further roles or adjust these:

  | Role | Permissions | Typical use |
  | --- | --- | --- |
  | Owner | 72 | the dentist-proprietor; everything including users, settings, restore |
  | Dentist | 38 | clinical work, prescriptions, plans, referrals, own reports |
  | Receptionist | 25 | registration, scheduling, queue, invoices and payments |
  | Accountant | 27 | billing, payments, finance, payroll, exports |
  | Assistant | 23 | chairside help: patients, chart, queue |

* Beyond the role, each user can be granted or denied individual permissions (an explicit deny
  always wins). The sidebar hides what a user cannot do, and the server enforces the same rule
  on every request — hiding a screen is never the only protection.
* A password must meet the configured length and strength rules, and the well-known weak
  passwords (`password`, `dentiva`, `admin`, `123456`, `qwerty`, `welcome`) are refused.
  Passwords are hashed with scrypt and a per-user salt (the parameters are stored alongside the
  hash so they can be raised later) — never in plain text, and never written to a log.

---

## 14. Audit log

Every sign-in, patient change, clinical edit, invoice issue/void, payment, refund, settings
change, permission change, backup, restore, import and export is written to an append-only log
with the user, time, module, entity, summary and before/after values. The log can be filtered by
date, user, module, severity and free text, viewed as a table, exported and printed. Entries are
kept for `security.auditRetentionDays` (three years by default). Passwords and password hashes
are never written to the log.

---

## 15. Backup, restore, import and export

| Action | What it does |
| --- | --- |
| **Back up now** | Writes a ZIP containing a consistent database snapshot, the manifest (counts, schema version, checksums) and — if enabled — every attachment |
| **Verify** | Re-opens an archive and checks each file against its checksum |
| **Restore** | Replaces the current database from an archive, after writing a safety copy of what is there now; asks for typed confirmation |
| **Export data (CSV)** | Writes readable CSV files for patients, visits, treatments, invoices, payments and expenses |
| **Import patients (CSV)** | Bulk-registers patients from a CSV file, with a dry run that reports exactly what would be created and what would be skipped |

### Automatic backups

With `backup.autoEnabled` on (the default), Dentiva writes a backup while the application is
open:

* `backup.frequency` — every day, every week, every month, or only manually,
* `backup.time` — the time of day (20:30 by default),
* `backup.location` — a folder of your choice; leave it empty for `data\backups`,
* `backup.retentionCount` — how many archives to keep (14 by default, oldest removed first),
* `backup.verifyAfterCreate` — re-open and verify each archive,
* `backup.reminderDays` — raise a reminder if no backup has been taken for this many days.

A scheduled run that was missed because the computer was switched off happens on the next
start-up, so a clinic that shuts down at night still gets its daily backup. Each run, and each
failure, is recorded in the audit log and announced once in the notification bell — never as a
pop-up loop.

The Backup screen shows the schedule in force: frequency, next run, last run and how many
archives are kept.

**A backup only protects you if it is somewhere else.** Copy `%LOCALAPPDATA%\Dentiva\backups`
(or your configured folder) to a USB drive or a second computer regularly.

---

## 16. Printing and PDF

Documents are ordinary print pages, so the browser's own print engine handles paper size,
margins and *Save as PDF* — no extra software and nothing to buy.

| Document | Default paper | Where to print from |
| --- | --- | --- |
| Invoice | A4 / Letter | invoice row → Print |
| Receipt | thermal 80 mm (58 mm optional) | payment row → Print |
| Treatment plan | A4 / Letter | plan → Print |
| Prescription | A4 / Letter (A5 fits) | prescription → Print |
| Visit summary | A4 / Letter | visit → Print |
| Referral letter | A4 / Letter | referral → Print |
| Patient statement | A4 / Letter | patient → Print statement |
| Patient card | A5 | patient → Print card |
| Appointment slip | thermal 80 mm | appointment → Print |
| Queue ticket | thermal 80 mm | queue → Print ticket |
| Salary slip | A5 | payroll row → Payslip |
| Any report | A4 / Letter | report toolbar → Print |

Paper size, orientation, margins, scale, whether the logo and signatures appear, and the copy
label ("Patient copy", "Clinic copy") all come from **Settings → Printing**. Thermal receipts
switch to a compact layout automatically. **Save as PDF** in the print dialog produces a PDF
named after the document with the pattern in `pdf.fileNamePattern`.

---

## 17. Notifications

The bell at the top right collects notifications instead of interrupting you:

| Kind | Raised when |
| --- | --- |
| Appointments | an appointment is due within the lead time |
| Follow-ups | a follow-up date is near or overdue |
| Outstanding payments | an invoice is due or overdue |
| Low stock | an item is at or below its minimum |
| Expiring stock | a batch expires within 30 days, or has expired |
| Backup | a scheduled backup was written, or a backup is overdue |
| System | anything the application needs to tell you (a failed automatic backup, for instance) |

Each kind can be switched off individually, quiet hours can be set (nothing appears outside your
working hours), and identical notifications are de-duplicated, so a low-stock item reminds you
once rather than on every screen. Mark as read, dismiss, or clear everything older than a month.

---

## 18. About and credits

**About** shows the product name, version, build number, database schema version, licence
summary, your data folder and the third-party notices. The creator's contact details appear
here and in the licence file only — they are never used as clinic, dentist, user or patient data.
