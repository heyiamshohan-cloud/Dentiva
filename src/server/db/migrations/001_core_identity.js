/**
 * Migration 001 — core identity, clinic and platform tables.
 *
 * Money → INTEGER minor units.  Timestamps → ISO-8601 UTC text.
 * Every tenant-scoped table carries clinic_id so multi-branch/multi-clinic
 * deployments are possible later without a schema rewrite (§ 83).
 */
export const id = 1;
export const name = 'core_identity';

const TS = `TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export function up(db) {
  db.exec(`
    ---------------------------------------------------------------- clinics
    CREATE TABLE clinics (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      code                TEXT    NOT NULL,
      name                TEXT    NOT NULL,
      legal_name          TEXT,
      logo_attachment_id  INTEGER,
      phone               TEXT,
      phone_alt           TEXT,
      email               TEXT,
      website             TEXT,
      address             TEXT,
      city                TEXT,
      country             TEXT,
      postal_code         TEXT,
      registration_no     TEXT,
      tax_no              TEXT,
      currency_code       TEXT    NOT NULL DEFAULT 'BDT',
      currency_symbol     TEXT    NOT NULL DEFAULT '৳',
      currency_minor_units INTEGER NOT NULL DEFAULT 2 CHECK (currency_minor_units BETWEEN 0 AND 4),
      locale              TEXT    NOT NULL DEFAULT 'en',
      date_format         TEXT    NOT NULL DEFAULT 'DD/MM/YYYY',
      time_format         TEXT    NOT NULL DEFAULT '12h',
      working_days        TEXT    NOT NULL DEFAULT '["sun","mon","tue","wed","thu"]',
      working_hours_start TEXT    NOT NULL DEFAULT '10:00',
      working_hours_end   TEXT    NOT NULL DEFAULT '21:00',
      appointment_minutes INTEGER NOT NULL DEFAULT 30 CHECK (appointment_minutes BETWEEN 5 AND 480),
      tax_enabled         INTEGER NOT NULL DEFAULT 0 CHECK (tax_enabled IN (0,1)),
      tax_label           TEXT    NOT NULL DEFAULT 'VAT',
      tax_rate_bp         INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
      is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
      is_default          INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
      notes               TEXT,
      created_at          ${TS},
      updated_at          ${TS},
      deleted_at          TEXT
    );
    CREATE UNIQUE INDEX ux_clinics_code ON clinics(code) WHERE deleted_at IS NULL;

    ------------------------------------------------------------- security
    CREATE TABLE roles (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id   INTEGER REFERENCES clinics(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      label_en    TEXT    NOT NULL,
      label_bn    TEXT    NOT NULL,
      description TEXT,
      is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
      is_locked   INTEGER NOT NULL DEFAULT 0 CHECK (is_locked IN (0,1)),
      created_at  ${TS},
      updated_at  ${TS},
      deleted_at  TEXT
    );
    CREATE UNIQUE INDEX ux_roles_name ON roles(COALESCE(clinic_id,0), name) WHERE deleted_at IS NULL;

    CREATE TABLE permissions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code        TEXT    NOT NULL UNIQUE,
      module      TEXT    NOT NULL,
      action      TEXT    NOT NULL,
      label_en    TEXT    NOT NULL,
      label_bn    TEXT    NOT NULL,
      description TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX ix_permissions_module ON permissions(module, sort_order);

    CREATE TABLE role_permissions (
      role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
      created_at    ${TS},
      PRIMARY KEY (role_id, permission_id)
    );

    CREATE TABLE users (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id           INTEGER NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
      role_id             INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
      staff_id            INTEGER,
      username            TEXT    NOT NULL,
      display_name        TEXT    NOT NULL,
      email               TEXT,
      phone               TEXT,
      password_hash       TEXT    NOT NULL,
      password_salt       TEXT    NOT NULL,
      password_algo       TEXT    NOT NULL DEFAULT 'scrypt',
      password_params     TEXT    NOT NULL DEFAULT '{}',
      password_changed_at TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
      pin_hash            TEXT,
      pin_salt            TEXT,
      status              TEXT    NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','disabled','locked')),
      failed_attempts     INTEGER NOT NULL DEFAULT 0,
      locked_until        TEXT,
      last_login_at       TEXT,
      last_activity_at    TEXT,
      theme               TEXT    NOT NULL DEFAULT 'light',
      locale              TEXT,
      notes               TEXT,
      created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at          ${TS},
      updated_at          ${TS},
      deleted_at          TEXT
    );
    CREATE UNIQUE INDEX ux_users_username ON users(lower(username)) WHERE deleted_at IS NULL;
    CREATE INDEX ix_users_clinic ON users(clinic_id, status);

    CREATE TABLE user_permissions (
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
      effect        TEXT    NOT NULL CHECK (effect IN ('allow','deny')),
      created_at    ${TS},
      PRIMARY KEY (user_id, permission_id)
    );

    CREATE TABLE sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash    TEXT    NOT NULL UNIQUE,
      csrf_token    TEXT    NOT NULL,
      device        TEXT,
      ip            TEXT,
      user_agent    TEXT,
      created_at    ${TS},
      last_seen_at  ${TS},
      expires_at    TEXT    NOT NULL,
      revoked_at    TEXT,
      revoked_reason TEXT
    );
    CREATE INDEX ix_sessions_user ON sessions(user_id, revoked_at);
    CREATE INDEX ix_sessions_expiry ON sessions(expires_at);

    CREATE TABLE login_attempts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      username     TEXT    NOT NULL,
      user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      success      INTEGER NOT NULL CHECK (success IN (0,1)),
      reason       TEXT,
      ip           TEXT,
      user_agent   TEXT,
      created_at   ${TS}
    );
    CREATE INDEX ix_login_attempts_user ON login_attempts(user_id, created_at);
    CREATE INDEX ix_login_attempts_name ON login_attempts(lower(username), created_at);

    --------------------------------------------------------------- platform
    CREATE TABLE settings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id   INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      key         TEXT    NOT NULL,
      value       TEXT    NOT NULL,
      value_type  TEXT    NOT NULL DEFAULT 'json' CHECK (value_type IN ('json','string','number','boolean')),
      scope       TEXT    NOT NULL DEFAULT 'clinic' CHECK (scope IN ('clinic','app')),
      updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at  ${TS},
      UNIQUE (clinic_id, key)
    );

    CREATE TABLE number_sequences (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id    INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      kind         TEXT    NOT NULL,
      period_key   TEXT    NOT NULL DEFAULT '',
      prefix       TEXT    NOT NULL DEFAULT '',
      suffix       TEXT    NOT NULL DEFAULT '',
      padding      INTEGER NOT NULL DEFAULT 6 CHECK (padding BETWEEN 1 AND 12),
      next_value   INTEGER NOT NULL DEFAULT 1 CHECK (next_value >= 1),
      start_value  INTEGER NOT NULL DEFAULT 1 CHECK (start_value >= 1),
      reset_policy TEXT    NOT NULL DEFAULT 'never' CHECK (reset_policy IN ('never','yearly','monthly')),
      include_year INTEGER NOT NULL DEFAULT 0 CHECK (include_year IN (0,1)),
      UNIQUE (clinic_id, kind, period_key)
    );

    CREATE TABLE audit_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id   INTEGER REFERENCES clinics(id) ON DELETE SET NULL,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      user_name   TEXT,
      action      TEXT    NOT NULL,
      module      TEXT    NOT NULL,
      entity      TEXT,
      entity_id   TEXT,
      summary     TEXT,
      severity    TEXT    NOT NULL DEFAULT 'info' CHECK (severity IN ('info','notice','warning','critical')),
      before_json TEXT,
      after_json  TEXT,
      ip          TEXT,
      created_at  ${TS}
    );
    CREATE INDEX ix_audit_created ON audit_logs(created_at DESC);
    CREATE INDEX ix_audit_entity ON audit_logs(entity, entity_id);
    CREATE INDEX ix_audit_user ON audit_logs(user_id, created_at DESC);
    CREATE INDEX ix_audit_module ON audit_logs(module, created_at DESC);

    CREATE TABLE notifications (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id    INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
      kind         TEXT    NOT NULL,
      severity     TEXT    NOT NULL DEFAULT 'info' CHECK (severity IN ('info','notice','warning','critical')),
      title_key    TEXT    NOT NULL,
      title_params TEXT    NOT NULL DEFAULT '{}',
      body_key     TEXT,
      body_params  TEXT    NOT NULL DEFAULT '{}',
      entity       TEXT,
      entity_id    TEXT,
      link         TEXT,
      due_at       TEXT,
      dedupe_key   TEXT,
      read_at      TEXT,
      dismissed_at TEXT,
      created_at   ${TS},
      updated_at   ${TS}
    );
    CREATE UNIQUE INDEX ux_notifications_dedupe ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX ix_notifications_open ON notifications(clinic_id, dismissed_at, read_at, created_at DESC);

    CREATE TABLE notification_preferences (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind          TEXT    NOT NULL,
      enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
      lead_minutes  INTEGER NOT NULL DEFAULT 30 CHECK (lead_minutes BETWEEN 0 AND 20160),
      quiet_start   TEXT,
      quiet_end     TEXT,
      updated_at    ${TS},
      UNIQUE (user_id, kind)
    );
  `);
}
