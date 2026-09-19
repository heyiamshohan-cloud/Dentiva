/**
 * Application state.
 *
 * Holds the signed-in user, the effective permission set, clinic identity and
 * settings. Views read from here and subscribe to changes; nothing else keeps
 * shared state, so a refresh is always a single `loadSession()` away.
 */
import { api } from './api.js';

/** @type {{ session: any, clinic: any, settings: Record<string, any>, app: any, locale: string, currencySymbol: string, currencyMinorUnits: number, permissions: Set<string> }} */
export const state = {
  session: null,
  clinic: null,
  settings: {},
  app: null,
  locale: 'en',
  currencySymbol: '৳',
  currencyMinorUnits: 2,
  permissions: new Set(),
};

const listeners = new Set();

/** @param {() => void} listener */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emit() {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error('[dentiva] listener failed', error);
    }
  }
}

export function isSignedIn() {
  return Boolean(state.session && state.session.id);
}

/**
 * Permission check. `*` is honoured explicitly in addition to the resolved set
 * so a future owner-style role keeps working.
 * @param {string} code
 */
export function can(code) {
  if (!code) return true;
  return state.permissions.has(code) || state.permissions.has('*');
}

/** @param {string[]} codes */
export function canAny(codes) {
  return codes.some((code) => can(code));
}

export async function loadSession() {
  const payload = await api.get('/api/session/me');
  state.session = payload?.user ?? null;
  state.clinic = payload?.clinic ?? null;
  state.settings = payload?.settings ?? {};
  state.app = payload?.app ?? null;
  state.permissions = new Set(payload?.permissions ?? []);
  state.locale = state.session?.locale ?? state.settings?.['locale.language'] ?? 'en';
  state.currencySymbol = state.clinic?.currencySymbol ?? '৳';
  state.currencyMinorUnits = Number(state.clinic?.currencyMinorUnits ?? 2);
  emit();
  return state.session;
}

/** Reload only the settings/clinic slice (after the settings screen saves). */
export async function reloadSettings() {
  const payload = await api.get('/api/preferences/settings');
  state.settings = payload?.values ?? payload ?? state.settings;
  emit();
  return state.settings;
}

export function clearSession() {
  state.session = null;
  state.clinic = null;
  state.settings = {};
  state.permissions = new Set();
  emit();
}
