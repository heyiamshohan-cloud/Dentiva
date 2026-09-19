/**
 * Typed application errors.
 *
 * The API layer maps these to safe, localized responses; raw stack traces are
 * only ever written to the diagnostics log (never to the user, see § 74).
 */

export class AppError extends Error {
  /**
   * @param {string} message developer-facing message (logged, not shown)
   * @param {{ code?: string, status?: number, messageKey?: string, params?: Record<string, any>, details?: any }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? 'app_error';
    this.status = options.status ?? 400;
    this.messageKey = options.messageKey ?? 'errors.generic';
    this.params = options.params ?? {};
    this.details = options.details ?? null;
  }
  toJSON() {
    return {
      code: this.code,
      status: this.status,
      messageKey: this.messageKey,
      params: this.params,
      details: this.details,
    };
  }
}

export class ValidationError extends AppError {
  /**
   * @param {string} [messageKey]
   * @param {any} [details]
   * @param {Record<string, any>} [params]
   */
  constructor(messageKey = 'errors.validation', details = null, params = {}) {
    super(`Validation failed: ${messageKey}`, { code: 'validation_error', status: 422, messageKey, details, params });
  }
}

export class NotFoundError extends AppError {
  /**
   * @param {string} [entity]
   * @param {number|string|null} [id]
   */
  constructor(entity = 'record', id = null) {
    super(`${entity} ${id ?? ''} not found`, {
      code: 'not_found',
      status: 404,
      messageKey: 'errors.notFound',
      params: { entity },
    });
    this.entity = entity;
  }
}

export class ConflictError extends AppError {
  /**
   * @param {string} [messageKey]
   * @param {any} [details]
   * @param {Record<string, any>} [params]
   */
  constructor(messageKey = 'errors.conflict', details = null, params = {}) {
    super(`Conflict: ${messageKey}`, { code: 'conflict', status: 409, messageKey, details, params });
  }
}

export class AuthError extends AppError {
  /**
   * @param {string} [messageKey]
   * @param {number} [status]
   * @param {Record<string, any>} [params]
   */
  constructor(messageKey = 'errors.unauthenticated', status = 401, params = {}) {
    super(`Auth: ${messageKey}`, { code: 'auth_error', status, messageKey, params });
  }
}

export class PermissionError extends AppError {
  /**
   * @param {string} [permission]
   * @param {Record<string, any>} [params]
   */
  constructor(permission = '', params = {}) {
    super(`Missing permission ${permission}`, {
      code: 'permission_denied',
      status: 403,
      messageKey: 'errors.permissionDenied',
      params: { permission, ...params },
    });
  }
}

export class UnsupportedDatabaseError extends AppError {
  /**
   * @param {number} dbVersion
   * @param {number} supported
   */
  constructor(dbVersion, supported) {
    super(`Database schema version ${dbVersion} is newer than supported ${supported}`, {
      code: 'unsupported_database',
      status: 409,
      messageKey: 'errors.databaseTooNew',
      params: { dbVersion, supported },
    });
  }
}

export class IntegrityError extends AppError {
  /**
   * @param {string} [messageKey]
   * @param {any} [details]
   */
  constructor(messageKey = 'errors.integrity', details = null) {
    super(`Integrity: ${messageKey}`, { code: 'integrity_error', status: 409, messageKey, details });
  }
}

export class BackupError extends AppError {
  constructor(messageKey = 'errors.backup', details = null) {
    super(`Backup: ${messageKey}`, { code: 'backup_error', status: 500, messageKey, details });
  }
}

export class FileError extends AppError {
  /**
   * @param {string} [messageKey]
   * @param {any} [details]
   * @param {number} [status]
   */
  constructor(messageKey = 'errors.file', details = null, status = 400) {
    super(`File: ${messageKey}`, { code: 'file_error', status, messageKey, details });
  }
}

/** Translate any thrown value into a safe AppError. */
export function toAppError(err) {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed/i.test(message)) {
    return new IntegrityError('errors.duplicateRecord', { raw: message });
  }
  if (/FOREIGN KEY constraint failed/i.test(message)) {
    return new IntegrityError('errors.relatedRecordMissing', { raw: message });
  }
  const wrapped = new AppError(message, {
    code: 'internal_error',
    status: 500,
    messageKey: 'errors.internal',
  });
  wrapped.cause = err;
  return wrapped;
}
