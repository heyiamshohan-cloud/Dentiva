/**
 * The single source of truth for the strings Windows shows in Explorer's
 * Details tab and in the executable's property sheet. Every consumer — the
 * build, the resource stamper, the release verifier and the tests — reads them
 * from here, so the EXE, the About dialogue, the installer and the docs can
 * never drift apart.
 */
import {
  APP_NAME,
  APP_PUBLISHER,
  APP_TAGLINE,
  APP_VERSION,
  BUILD_NUMBER,
} from '../../src/shared/constants.js';

/** `1.0.0.100` — the four-part form Windows expects in a version resource. */
export const FOUR_PART_VERSION = `${APP_VERSION}.${BUILD_NUMBER}`;

/** The year shown in the copyright notice. */
export const COPYRIGHT_YEAR = new Date().getFullYear();

/** @returns {Record<string, string>} VERSIONINFO string table (en-US, Unicode). */
export function productVersionStrings() {
  return {
    CompanyName: APP_PUBLISHER,
    FileDescription: `${APP_NAME} — ${APP_TAGLINE}`,
    FileVersion: FOUR_PART_VERSION,
    InternalName: 'DENTIVA.exe',
    LegalCopyright: `© ${COPYRIGHT_YEAR} ${APP_PUBLISHER}`,
    OriginalFilename: 'DENTIVA.exe',
    ProductName: APP_NAME,
    ProductVersion: FOUR_PART_VERSION,
  };
}

/** The same identity, as plain text, for logs and reports. */
export function describeProduct() {
  return `${APP_NAME} ${APP_VERSION} build ${BUILD_NUMBER} — ${APP_PUBLISHER}`;
}
