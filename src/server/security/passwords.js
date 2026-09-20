/**
 * Credential hashing.
 *
 *  - Passwords: scrypt (N=16384, r=8, p=1, 64-byte key) with a 16-byte random
 *    salt, verified in constant time. Nothing is ever stored in plain text and
 *    no credential is ever written to the log (§ 51, § 75).
 *  - Session tokens and CSRF tokens are 256-bit random values; only the SHA-256
 *    digest of a session token is persisted, so a database copy cannot be used
 *    to hijack a live session.
 *  - PINs use the same scrypt parameters and are stored separately from the
 *    password so a PIN can be revoked without touching the password.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

/** @param {string} password */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_PARAMS.maxmem,
  }).toString('hex');
  return {
    hash,
    salt,
    algo: 'scrypt',
    params: JSON.stringify({ N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, keylen: SCRYPT_PARAMS.keylen }),
  };
}

/**
 * @param {string} password
 * @param {{ hash?: string|null, salt?: string|null, params?: string|null, algo?: string|null,
 *   password_hash?: string|null, password_salt?: string|null, password_params?: string|null, password_algo?: string|null }} stored
 */
export function verifyPassword(password, stored) {
  // Accept both the compact { hash, salt, params } shape and a raw `users` row
  // ({ password_hash, password_salt, … }) so callers can pass either.
  const record = stored
    ? {
        hash: stored.hash ?? stored.password_hash ?? null,
        salt: stored.salt ?? stored.password_salt ?? null,
        algo: stored.algo ?? stored.password_algo ?? 'scrypt',
        params: stored.params ?? stored.password_params ?? null,
      }
    : null;
  if (!record?.hash || !record?.salt) return false;
  if ((record.algo ?? 'scrypt') !== 'scrypt') return false;
  let params = SCRYPT_PARAMS;
  try {
    const parsed = record.params ? JSON.parse(record.params) : null;
    if (parsed?.N && parsed?.r && parsed?.p) {
      params = {
        N: Number(parsed.N),
        r: Number(parsed.r),
        p: Number(parsed.p),
        keylen: Number(parsed.keylen ?? 64),
        maxmem: SCRYPT_PARAMS.maxmem,
      };
    }
  } catch {
    /* fall back to defaults */
  }
  const derived = scryptSync(password, record.salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem,
  });
  const expected = Buffer.from(record.hash, 'hex');
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(derived, expected);
}

export function hashPin(pin) {
  return hashPassword(`pin:${pin}`);
}

export function verifyPin(pin, stored) {
  return verifyPassword(`pin:${pin}`, stored);
}

/** 32 random bytes, URL-safe. */
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Password policy check.
 * @param {string} password
 * @param {{ minLength?: number, requireStrong?: boolean }} policy
 * @returns {string[]} list of i18n message keys describing every violation
 */
export function passwordProblems(password, policy = {}) {
  const minLength = policy.minLength ?? 10;
  const requireStrong = policy.requireStrong ?? true;
  const value = String(password ?? '');
  const problems = [];
  if (value.length < minLength) problems.push('security.password.tooShort');
  if (requireStrong) {
    if (!/[A-Za-z]/.test(value)) problems.push('security.password.needsLetter');
    if (!/\d/.test(value)) problems.push('security.password.needsDigit');
    if (value.length >= minLength && /^(.)\1+$/.test(value)) problems.push('security.password.tooSimple');
    const common = ['password', 'dentiva', 'admin', '123456', 'qwerty', 'welcome'];
    if (common.some((entry) => value.toLowerCase().includes(entry))) problems.push('security.password.tooCommon');
  }
  return problems;
}

/** Generate a readable temporary password (used for forced resets). */
export function suggestPassword(length = 12) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const symbols = '!@#$%^&*';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return `${out.slice(0, length - 2)}${symbols[bytes[0] % symbols.length]}${bytes[1] % 10}`;
}
