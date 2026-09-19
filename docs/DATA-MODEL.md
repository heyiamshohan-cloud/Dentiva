# Dentiva — data model

Dentiva 1.0.0 · build 100 · schema **v10** (10 migrations, all additive)

Dentiva stores everything in one SQLite database: **61 tables, 5 views, 117 indexes** and one FTS5
full-text index. This document is the map a support engineer or a developer needs; the schema
itself is defined by `src/server/db/migrations/001…010`.

---

## 1. Conventions

| Rule | Detail |
| --- | --- |
| Money | `INTEGER` in **minor units** (paisa/cents). `*_minor` columns. Never floating point |
| Quantity | `INTEGER` in **thousandths** (`quantity_milli`, 1000 = 1 unit) |
| Percentage | `INTEGER` in **basis points** (`tax_rate_bp`, `discount_value` for percent type) |
| Dates | `TEXT` ISO-8601 (`YYYY-MM-DD`), times `HH:MM`, timestamps full ISO with timezone |
| Clinic scope | Every business table carries `clinic_id`; every query is scoped by it |
| Soft delete | `deleted_at TEXT NULL` on records that must be recoverable (patients, clinical, invoices, stock) |
| Audit columns | `created_at`, `updated_at`, usually `created_by`, `updated_by` |
| Money totals | Stored on the parent row **and** recomputed server-side, so a stored total always equals the sum of its lines |

## 2. Groups

### Identity and configuration

| Table | Purpose |
| --- | --- |
| `clinics` | One row per clinic: name, address, phone, currency, locale, date/time formats, working days and hours, tax settings |
| `users` | Accounts: username, display name, role, scrypt password hash + salt + params, status, must-change flag, refund PIN hash |
| `roles`, `permissions`, `role_permissions`, `user_permissions` | RBAC: 72 permission codes, five built-in roles, per-user allow/deny overrides |
| `sessions` | Server-side sessions referenced by the `dentiva_session` cookie |
| `login_attempts` | Failed and successful sign-ins, used for lockout and forensics |
| `settings` | Key/value clinic settings (93 keys in 16 groups, validated against a catalogue) |
| `number_sequences` | Invoice, receipt, patient, visit, treatment, plan and prescription counters — never reused |
| `clinic_provisioning_templates` | The catalogue (categories, appointment types, payment methods) applied when a clinic is provisioned |
| `services`, `diagnoses`, `tooth_conditions`, `appointment_types`, `payment_methods`, `expense_categories`, `income_categories`, `inventory_categories` | Reference data with English and Bengali labels |
| `schema_migrations` | Applied migration id, name, checksum and timestamp |

### Patients

| Table | Purpose |
| --- | --- |
| `patients` | Identity: code, name, gender, DOB, phone(s), e-mail, address, city, national ID, occupation, blood group, referral source, status |
| `patient_contacts` | Additional contacts (guardian, spouse, employer) with relationship |
| `patient_medical` | Allergies, history, current medications, conditions, surgery, family history, notes and twelve boolean flag columns (diabetes, hypertension, heart disease, asthma, bleeding disorder, pregnancy, smoking, anticoagulant, hepatitis, kidney disease, thyroid disorder, alert) |
| `patient_dental` | Dental history, brushing habits, previous orthodontics, parafunction, notes |
| `patient_notes` | Internal notes with author and archive flag |
| `patient_custom_fields`, `patient_custom_values` | Clinic-defined extra fields and their values |
| `patient_credits` | Unallocated payments available to apply to future invoices |
| `attachments` | Files: original name, stored relative path, mime, size, SHA-256, owner entity, soft delete |

### Clinical

| Table | Purpose |
| --- | --- |
| `visits` | One consultation: date, time, practitioner, chief complaint, diagnosis, notes, advice, follow-up date |
| `visit_diagnoses` | Diagnosis lines per visit (references `diagnoses`) |
| `dental_chart_entries` | Per-tooth chart entries: tooth code (FDI), dentition, condition, surfaces, status, note, recorded by/at, cleared |
| `treatments` | Procedures with tooth code, fee, discount, tax, **quantity_milli** and **tax_rate_bp** (v10), totals, status, link to visit and invoice line |
| `treatment_plans`, `treatment_plan_items` | Staged plans with per-item quantity, unit price, discount, tax and stored line totals |
| `prescriptions`, `prescription_items`, `prescription_templates` | Prescriptions with items (drug, strength, form, dose, frequency, duration, instructions) and reusable templates |
| `referrals` | Referral out with provider, reason, urgency, summary, requested report, status |

### Scheduling

| Table | Purpose |
| --- | --- |
| `appointments` | Booked visit: code, patient, practitioner, type, date, start/end time, duration, reason, status, serial, reminder, cancellation reason |
| `queue_entries` | Today's waiting room: serial number, check-in/called/started/completed timestamps, priority, status |

### Money

| Table | Purpose |
| --- | --- |
| `invoices`, `invoice_items` | Draft and issued invoices with lines (description, quantity, unit price, discount, tax) and stored subtotal/discount/tax/total/paid/due |
| `payments` | Payments with kind (payment/refund), method, reference, amount, allocation to invoice, void/refund links |
| `expenses`, `incomes` | Practice bookkeeping with category, date, amount, vendor/payer, method, note |

### Staff

| Table | Purpose |
| --- | --- |
| `staff` | Staff records: code, name, role title, designation, specialty, registration, contact, joining/leaving date, salary and type, practitioner flag, colour, linked user |
| `payroll`, `payroll_items` | One row per staff member per period (gross, deductions, net, paid, due, status) with itemised earnings/deductions |

### Inventory

| Table | Purpose |
| --- | --- |
| `suppliers` | Name, contact person, phone, e-mail, address, tax number, note |
| `inventory_items` | SKU, name, category, unit, quantity, minimum stock, purchase/sale price, supplier, batch, expiry, storage location, condition |
| `stock_movements` | The only way quantity changes: kind (in/out/adjustment/disposal/return), quantity, balance after, unit cost, reason, reference, batch, expiry, links to patient/treatment |

### System

| Table | Purpose |
| --- | --- |
| `audit_logs` | Append-only trail: user, action, module, entity, summary, severity, before/after JSON, IP, timestamp |
| `notifications` | Notification bell entries: kind, severity, title/body keys + params, entity link, due date, read/dismissed, dedupe key |
| `notification_preferences` | Per-user, per-kind switches and quiet hours |
| `search_index` (FTS5) | Full-text index over patients, visits, treatments, prescriptions, referrals, appointments and invoices |

### Views

| View | Used for |
| --- | --- |
| `v_patient_balances` | Balance and credit per patient |
| `v_patient_visit_stats` | Visit count, first/last visit per patient |
| `v_patient_appointment_stats` | Appointment counts and next appointment per patient |
| `v_inventory_status` | Stock value, low-stock and expiry flags per item |
| `v_daily_finance` | Daily invoiced/collected/expense figures for the finance screens |

## 3. Relationships in one picture

```
clinics ─┬─ users ─── roles ─── role_permissions ─── permissions
         │     └── user_permissions, sessions, login_attempts, notification_preferences
         ├─ staff ─── payroll ─── payroll_items
         ├─ suppliers ─── inventory_items ─── stock_movements
         ├─ appointments ─── queue_entries
         └─ patients ─┬─ patient_contacts / patient_medical / patient_dental / patient_notes
                      │  patient_custom_values / patient_credits / attachments
                      ├─ visits ─┬─ visit_diagnoses
                      │          └─ treatments ─── dental_chart_entries (via tooth + visit)
                      ├─ treatment_plans ─── treatment_plan_items
                      ├─ prescriptions ─── prescription_items
                      ├─ referrals
                      └─ invoices ─── invoice_items
                                 └─ payments
```

## 4. Migration history

| # | Name | What it added |
| --- | --- | --- |
| 001 | core identity | clinics, users, roles, permissions, sessions, settings, sequences |
| 002 | patients | patients and their medical, dental, contact, note, custom-field and attachment tables |
| 003 | clinical | visits, diagnoses, dental chart, treatments, plans, prescriptions, referrals |
| 004 | scheduling | appointments, appointment types, queue entries |
| 005 | billing | invoices, items, payments, methods, credits, expenses, incomes |
| 006 | finance, staff, inventory | staff, payroll, suppliers, inventory, stock movements |
| 007 | configuration catalogues | reference data, provisioning templates, built-in catalogue rows |
| 008 | search and views | FTS5 index and the reporting views |
| 009 | permission catalogue | the 72 permission codes and their role assignments |
| 010 | treatment line details | `treatments.quantity_milli` and `treatments.tax_rate_bp` |

Every migration runs inside a transaction, is idempotent (column existence is checked before an
`ALTER`), records itself in `schema_migrations`, and never deletes or rewrites an existing row.
Upgrading a clinic that is several versions behind applies the missing migrations in order on the
next start-up; `tests/migrations` proves a v1-era database reaches v10 with its patient, clinical
and financial rows intact.

## 5. Backups

A backup is a ZIP containing:

```
dentiva.db             consistent snapshot taken with VACUUM INTO
manifest.json          format version, app version, build, schema version, latest migration,
                       clinic id, created by, counts per table, database SHA-256,
                       attachment count/bytes, missing attachments
attachments/<rel>/…    every attachment file, unless the clinic switched them off
```

**Restore** verifies the manifest and the database checksum, writes a safety copy of the current
database, then replaces the file. A backup made by a newer schema version is refused rather than
half-applied.

## 6. Size and performance expectations

* Roughly 2.5 kB of database per patient with a full history (1,500 patients ≈ 3.8 MB).
* Patient page (50 rows) ≈ 2 ms; dashboard ≈ 2 ms; a one-year revenue report ≈ 4 ms on this
  machine; `bun run qa:large` fails the build if any measured interaction exceeds its budget.
* `VACUUM` runs as part of `VACUUM INTO` for every backup, and SQLite's WAL keeps writes fast
  without blocking readers.
