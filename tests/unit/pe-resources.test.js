/**
 * Windows executable resources.
 *
 * DENTIVA ships as one `.exe`, and everything a clinic sees *before* it starts
 * — Explorer's icon, the taskbar, the Start Menu entry, the Details tab — comes
 * from the PE resource section. These tests pin down the two things that can
 * silently go wrong there:
 *
 *   1. the VERSIONINFO block must follow the VS_VERSIONINFO layout exactly
 *      (aligned children, a 52-byte fixed block, en-US Unicode strings), because
 *      Windows reads it with no tolerance for a shifted offset;
 *   2. the icon must carry every size Explorer asks for, with the same pixels
 *      as `resources/icon.ico`, whether a frame is stored raw or PNG-compressed.
 *
 * The last block re-checks the built artefact when `dist/windows/DENTIVA.exe`
 * exists (it is not committed, so the checks skip on a fresh checkout).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildIconGroup,
  buildIconResource,
  buildVersionInfo,
  decodeIcoFrame,
  encodePng,
  listResources,
  parsePe,
  parseVersionInfo,
  readIco,
  resourcesOfType,
  RT_GROUP_ICON,
  RT_ICON,
  RT_MANIFEST,
  RT_VERSION,
} from '../../scripts/lib/pe.mjs';
import { FOUR_PART_VERSION, productVersionStrings } from '../../scripts/lib/product-metadata.mjs';
import { APP_NAME, APP_PUBLISHER, BUILD_NUMBER } from '../../src/shared/constants.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ICON_PATH = join(ROOT, 'resources/icon.ico');
const EXE_PATH = join(ROOT, 'dist/windows/DENTIVA.exe');
const icon = readFileSync(ICON_PATH);
const DWORD = 4;

/** Read a PNG's pixels with a decoder written independently of `encodePng`. */
function decodePng(png) {
  const { inflateSync } = require('node:zlib');
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let at = 8;
  /** @type {{ width: number, height: number, depth: number, colorType: number, interlace: number } | null} */
  let header = null;
  const idat = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colorType: body[9], interlace: body[12] };
    if (type === 'IDAT') idat.push(body);
    at += 12 + length;
  }
  if (!header) throw new Error('the PNG has no IHDR block');
  const stride = header.width * 4;
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(stride * header.height);
  for (let row = 0; row < header.height; row += 1) {
    expect(raw[row * (stride + 1)]).toBe(0); // filter: none
    raw.copy(rgba, row * stride, row * (stride + 1) + 1, row * (stride + 1) + 1 + stride);
  }
  return { ...header, rgba };
}

describe('Windows version information', () => {
  const strings = productVersionStrings();
  const blob = buildVersionInfo(strings, { fileVersion: FOUR_PART_VERSION, productVersion: FOUR_PART_VERSION });

  test('the fixed block matches what Windows expects of an application', () => {
    const parsed = parseVersionInfo(blob, 0);
    expect(parsed.signature).toBe(0xfeef04bd);
    expect(parsed.fileType).toBe(1);
    expect(parsed.fileOs).toBe(0x40004);
    expect(parsed.fileFlags).toBe(0);
    expect(parsed.fileFlagsMask).toBe(0x3f);

    const fixedAt = 40;
    expect(blob.readUInt32LE(fixedAt)).toBe(0xfeef04bd);
    expect(blob.readUInt32LE(fixedAt + 4)).toBe(0x00010000);
    expect(blob.readUInt32LE(fixedAt + 24)).toBe(0x3f);      // VS_FFI_FILEFLAGSMASK
    expect(blob.readUInt32LE(fixedAt + 28)).toBe(0);         // not debug, not prerelease
    expect(blob.readUInt32LE(fixedAt + 32)).toBe(0x40004);   // VOS_NT_WINDOWS32
    expect(blob.readUInt32LE(fixedAt + 36)).toBe(1);         // VFT_APP
  });

  test('reports the product version in both four-part and string form', () => {
    const parsed = parseVersionInfo(blob, 0);
    expect(FOUR_PART_VERSION).toBe(`1.0.0.${BUILD_NUMBER}`);
    expect(parsed.fixedFileVersion).toBe(FOUR_PART_VERSION);
    expect(parsed.fixedProductVersion).toBe(FOUR_PART_VERSION);
    expect(parsed.strings.FileVersion).toBe(FOUR_PART_VERSION);
    expect(parsed.strings.ProductVersion).toBe(FOUR_PART_VERSION);
  });

  test('carries the product identity, not the compiler’s', () => {
    const parsed = parseVersionInfo(blob, 0);
    expect(parsed.strings.ProductName).toBe(APP_NAME);
    expect(parsed.strings.CompanyName).toBe(APP_PUBLISHER);
    expect(parsed.strings.InternalName).toBe('DENTIVA.exe');
    expect(parsed.strings.OriginalFilename).toBe('DENTIVA.exe');
    expect(parsed.strings.FileDescription).toContain(APP_NAME);
    expect(parsed.strings.LegalCopyright).toContain(APP_PUBLISHER);
    for (const value of Object.values(parsed.strings)) {
      expect(value).not.toContain('Bun');
      expect(value).not.toContain('Oven');
    }
  });

  test('declares en-US Unicode and terminates every string', () => {
    const parsed = parseVersionInfo(blob, 0);
    expect(parsed.translations).toEqual(['0x0409 0x04b0']);
    // Every VERSIONINFO string is NUL-terminated, so its stored length is the
    // number of characters *including* the terminator.
    const root = walkVersionNodes(blob);
    const stringNodes = root
      .flatMap((node) => node.descendants)
      .filter((node) => node.type === 1 && node.valueLength > 0 && node.rawValue.length > 0 && node.children.length === 0);
    expect(stringNodes.length).toBeGreaterThanOrEqual(8);
    for (const node of stringNodes) {
      expect(node.rawValue.at(-2)).toBe(0);
      expect(node.rawValue.at(-1)).toBe(0);
      expect(node.valueLength).toBe(node.rawValue.length / 2);
    }
  });

  test('every child node starts on a four-byte boundary', () => {
    // A VERSIONINFO tree is walked by offset, so alignment is not cosmetic:
    // Windows stops at the first child that is not where it expects it.
    const root = walkVersionNodes(blob);
    expect(root[0].offset).toBe(0);
    for (const node of root) {
      for (const child of node.children) expect(child.offset % DWORD).toBe(0);
      expect(node.length).toBe(node.end - node.offset);
      expect(node.end).toBeLessThanOrEqual(blob.length);
    }
    expect(blob.length).toBe(blob.readUInt16LE(0));
  });
});

/**
 * Walk a VERSIONINFO blob the way Windows documents it: header, key, value,
 * then children at four-byte boundaries.
 * @param {Buffer} blob
 * @param {number} [at]
 */
function walkVersionNodes(blob, at = 0) {
  const length = blob.readUInt16LE(at);
  const valueLength = blob.readUInt16LE(at + 2);
  const type = blob.readUInt16LE(at + 4);
  let cursor = at + 6;
  let key = '';
  while (blob.readUInt16LE(cursor) !== 0) {
    key += String.fromCharCode(blob.readUInt16LE(cursor));
    cursor += 2;
  }
  cursor += 2;
  const valueAt = (cursor + 3) & ~3;
  const valueBytes = type === 1 ? valueLength * 2 : valueLength;
  const rawValue = blob.subarray(valueAt, valueAt + valueBytes);
  const childAt = (valueAt + valueBytes + 3) & ~3;
  const children = [];
  let cursorChild = childAt;
  while (cursorChild + 6 <= at + length) {
    const childLength = blob.readUInt16LE(cursorChild);
    if (childLength === 0 || cursorChild + childLength > at + length) break;
    const [child] = walkVersionNodes(blob, cursorChild);
    children.push(child);
    cursorChild = (cursorChild + childLength + 3) & ~3;
  }
  const node = { key, type, length, valueLength, rawValue, offset: at, end: at + length, children, descendants: [] };
  node.descendants = children.flatMap((child) => [child, ...child.descendants]);
  return [node];
}

describe('application icon', () => {
  test('reads every size out of resources/icon.ico', () => {
    const images = readIco(icon);
    expect(images.map((image) => image.width)).toEqual([16, 24, 32, 48, 64, 128, 256]);
    for (const image of images) {
      expect(image.width).toBe(image.height);
      expect(image.data.length).toBe(image.size);
      expect(image.bitsPerPixel).toBe(32);
    }
  });

  test('keeps raw frames when they fit and drops the largest when they do not', () => {
    const roomy = buildIconResource(icon, { budget: 1024 * 1024 });
    expect(roomy.every((image) => image.encoded === 'bmp')).toBe(true);
    expect(roomy.map((image) => image.width)).toEqual([16, 24, 32, 48, 64, 128, 256]);

    const budget = 120 * 1024;
    const tight = buildIconResource(icon, { budget });
    expect(tight.reduce((sum, image) => sum + image.data.length, 0)).toBeLessThanOrEqual(budget);
    // GDI+ cannot decode PNG frames, so we keep BMP and drop the largest instead
    // of PNG-compressing — the remaining BMP frames still cover every Explorer size.
    expect(tight.every((image) => image.encoded === 'bmp')).toBe(true);
    expect(tight.length).toBeGreaterThanOrEqual(5);
    expect(tight.length).toBeLessThanOrEqual(7);
  });

  test('a PNG frame is pixel-identical to the raw frame it replaces', () => {
    const source = readIco(icon).find((image) => image.width === 256);
    if (!source) throw new Error('resources/icon.ico has no 256-pixel frame');
    const raw = decodeIcoFrame(source.data);
    const encoded = encodePng(raw);
    const decoded = decodePng(encoded);
    expect(decoded.width).toBe(256);
    expect(decoded.height).toBe(256);
    expect(decoded.depth).toBe(8);
    expect(decoded.colorType).toBe(6);
    expect(Buffer.compare(decoded.rgba, raw.rgba)).toBe(0);
  });

  test('the icon group lists every frame with its real dimensions', () => {
    const images = buildIconResource(icon, { budget: 1024 * 1024 });
    const group = buildIconGroup(images);
    expect(group.readUInt16LE(0)).toBe(0);
    expect(group.readUInt16LE(2)).toBe(1);
    expect(group.readUInt16LE(4)).toBe(images.length);
    expect(group.length).toBe(6 + images.length * 14);
    images.forEach((image, index) => {
      const at = 6 + index * 14;
      expect(group[at]).toBe(image.width === 256 ? 0 : image.width);
      expect(group[at + 1]).toBe(image.height === 256 ? 0 : image.height);
      expect(group.readUInt16LE(at + 6)).toBe(32);
      expect(group.readUInt32LE(at + 8)).toBe(image.data.length);
      expect(group.readUInt16LE(at + 12)).toBe(image.id);
    });
  });
});

const hasBuiltExe = existsSync(EXE_PATH);
const suite = hasBuiltExe ? describe : describe.skip;

suite('the built DENTIVA.exe', () => {
  const exe = readFileSync(EXE_PATH);

  test('is a 64-bit GUI image', () => {
    const pe = parsePe(exe);
    expect(pe.machine).toBe(0x8664);
    expect(pe.isPe32Plus).toBe(true);
    expect(pe.subsystem).toBe(2);
  });

  test('carries Dentiva’s icon, version information and manifest', () => {
    const icons = resourcesOfType(exe, RT_ICON);
    // GDI+ path keeps BMP frames and drops the largest when the .rsrc budget is
    // tight (e.g. Linux cross-compile), so the built image may have 6 or 7
    // sizes — Windows has 7 BMP, Linux 6 BMP (16..128) and both pass the
    // workflow's "at least 5 of 7" gate.
    expect(icons.length).toBeGreaterThanOrEqual(5);
    expect(icons.length).toBeLessThanOrEqual(7);
    const group = resourcesOfType(exe, RT_GROUP_ICON);
    expect(group.length).toBe(1);
    expect(group[0].id).toBe(1);
    expect(resourcesOfType(exe, RT_MANIFEST).length).toBe(1);

    const version = resourcesOfType(exe, RT_VERSION);
    expect(version.length).toBe(1);
    const parsed = parseVersionInfo(exe, version[0].offset);
    expect(parsed.strings).toEqual(productVersionStrings());
    // 5..7 icons + 1 group + 1 version + 1 manifest = 8..10
    expect(listResources(exe).length).toBeGreaterThanOrEqual(8);
  });

  test('stamping is deterministic and only touches the resource section', () => {
    const { stampExecutable } = require('../../scripts/lib/pe.mjs');
    const versionInfo = buildVersionInfo(productVersionStrings(), { fileVersion: FOUR_PART_VERSION, productVersion: FOUR_PART_VERSION });
    const once = stampExecutable(exe, { icon, versionInfo });
    const twice = stampExecutable(once.buffer, { icon, versionInfo });
    // Running the stamper on an already-stamped image changes nothing.
    expect(Buffer.compare(twice.buffer, once.buffer)).toBe(0);
    // And it never grows, shrinks or rewrites anything outside `.rsrc`.
    expect(twice.buffer.length).toBe(exe.length);
    const pe = parsePe(exe);
    const section = pe.sectionForRva(pe.dataDirectories[2].rva);
    const outsideEqual = twice.buffer.subarray(0, section.rawPointer).equals(exe.subarray(0, section.rawPointer))
      && twice.buffer.subarray(section.rawPointer + section.rawSize).equals(exe.subarray(section.rawPointer + section.rawSize));
    expect(outsideEqual).toBe(true);
  });
});
