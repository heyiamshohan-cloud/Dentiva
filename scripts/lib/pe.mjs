/**
 * Minimal, dependency-free Windows PE / Win32 resource toolkit.
 *
 * Dentiva ships as a single `DENTIVA.exe` compiled by Bun. Bun accepts the
 * `--windows-icon`, `--windows-publisher`, `--windows-version` … switches only
 * when the build itself runs on Windows, so a cross-compiled image (the build
 * this repository produces on Linux CI, and the one committed to the branch)
 * would otherwise carry `bun.exe`'s own icon and the publisher "Oven" in
 * Explorer's Details tab — not fit for a release.
 *
 * This module closes that gap without native tooling: it reads the PE optional
 * header and the `.rsrc` section, rebuilds the resource directory with the
 * Dentiva icon (all sizes) and a proper VERSIONINFO block, and writes the new
 * tree back **inside the existing `.rsrc` section**. Every other byte of the
 * executable — headers, code, data and the appended Bun payload — is copied
 * through untouched, and `stampExecutable` asserts that invariant before it
 * returns.
 *
 * Used by `scripts/stamp-exe.mjs`, `scripts/build-win.mjs`,
 * `scripts/verify-artifacts.mjs` and the unit tests.
 */
import { deflateSync } from 'node:zlib';

/* --------------------------------------------------------------- primitives */

const DWORD_ALIGN = (value) => (value + 3) & ~3;

/** Windows' `IMAGE_DIRECTORY_ENTRY_RESOURCE` index in the data directory. */
export const RESOURCE_DIRECTORY_INDEX = 2;
/** Resource type ids used by an application icon and its metadata. */
export const RT_ICON = 3;
export const RT_GROUP_ICON = 14;
export const RT_VERSION = 16;
export const RT_MANIFEST = 24;

/* -------------------------------------------------------------- PE readers */

/**
 * Parse the headers of a PE image.
 * @param {Buffer} buffer
 */
export function parsePe(buffer) {
  if (buffer.length < 0x40 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
    throw new Error('not a Windows executable: the DOS header (MZ) is missing');
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 0x78 > buffer.length || buffer.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('not a Windows executable: the PE signature is missing');
  }
  const machine = buffer.readUInt16LE(peOffset + 4);
  const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const optionalSize = buffer.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  const magic = buffer.readUInt16LE(optionalOffset);
  const isPe32Plus = magic === 0x20b;
  const dataDirectoryOffset = optionalOffset + (isPe32Plus ? 112 : 96);
  const dataDirectories = [];
  for (let index = 0; index < 16; index += 1) {
    const at = dataDirectoryOffset + index * 8;
    dataDirectories.push({ rva: buffer.readUInt32LE(at), size: buffer.readUInt32LE(at + 4) });
  }
  const sectionTableOffset = optionalOffset + optionalSize;
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const at = sectionTableOffset + index * 40;
    sections.push({
      name: buffer.toString('latin1', at, at + 8).replace(/\0+$/, ''),
      virtualSize: buffer.readUInt32LE(at + 8),
      virtualAddress: buffer.readUInt32LE(at + 12),
      rawSize: buffer.readUInt32LE(at + 16),
      rawPointer: buffer.readUInt32LE(at + 20),
      characteristics: buffer.readUInt32LE(at + 36),
    });
  }
  const checksumAt = optionalOffset + 64;
  return {
    peOffset,
    optionalOffset,
    machine,
    isPe32Plus,
    subsystem: buffer.readUInt16LE(optionalOffset + 68),
    checksum: buffer.readUInt32LE(checksumAt),
    checksumOffset: checksumAt,
    dataDirectories,
    sections,
    /** @param {number} rva */
    sectionForRva(rva) {
      for (const section of sections) {
        const span = Math.max(section.virtualSize, section.rawSize);
        if (rva >= section.virtualAddress && rva < section.virtualAddress + span) return section;
      }
      return null;
    },
    /** @param {number} rva */
    rvaToOffset(rva) {
      const section = this.sectionForRva(rva);
      if (!section) return null;
      const offset = section.rawPointer + (rva - section.virtualAddress);
      return offset < buffer.length ? offset : null;
    },
  };
}

/* ------------------------------------------------------ resource tree read */

/** Decode a resource directory entry name (UTF-16LE, length-prefixed). */
function readResourceName(buffer, base, relativeOffset) {
  const at = base + relativeOffset;
  const length = buffer.readUInt16LE(at);
  return buffer.toString('utf16le', at + 2, at + 2 + length * 2);
}

/**
 * Walk the Win32 resource directory and return every leaf.
 * @param {Buffer} buffer
 * @returns {{ type: number|null, typeName: string|null, id: number|null, name: string|null, language: number, rva: number, size: number, codePage: number, offset: number }[]}
 */
export function listResources(buffer) {
  const pe = parsePe(buffer);
  const directory = pe.dataDirectories[RESOURCE_DIRECTORY_INDEX];
  if (!directory.rva) return [];
  const base = pe.rvaToOffset(directory.rva);
  if (base === null) throw new Error('the resource directory RVA does not resolve to a file offset');
  const resources = [];

  const walk = (directoryRelative, level, path) => {
    const at = base + directoryRelative;
    const named = buffer.readUInt16LE(at + 12);
    const identified = buffer.readUInt16LE(at + 14);
    let entryOffset = at + 16;
    for (let index = 0; index < named + identified; index += 1) {
      const nameField = buffer.readUInt32LE(entryOffset);
      const dataField = buffer.readUInt32LE(entryOffset + 4);
      entryOffset += 8;
      const named_ = (nameField & 0x80000000) !== 0;
      const nameValue = named_ ? readResourceName(buffer, base, nameField & 0x7fffffff) : null;
      const idValue = named_ ? null : nameField;
      const next = [...path, named_ ? nameValue : idValue];
      if ((dataField & 0x80000000) !== 0) {
        walk(dataField & 0x7fffffff, level + 1, next);
      } else {
        const dataAt = base + dataField;
        const rva = buffer.readUInt32LE(dataAt);
        const size = buffer.readUInt32LE(dataAt + 4);
        const offset = pe.rvaToOffset(rva);
        resources.push({
          type: level >= 2 && typeof path[0] === 'number' ? path[0] : null,
          typeName: level >= 2 && typeof path[0] === 'string' ? path[0] : null,
          id: level >= 2 && typeof path[1] === 'number' ? path[1] : null,
          name: level >= 2 && typeof path[1] === 'string' ? path[1] : null,
          language: level >= 2 && typeof next[2] === 'number' ? next[2] : 0,
          rva,
          size,
          codePage: buffer.readUInt32LE(dataAt + 8),
          offset: offset ?? -1,
        });
      }
    }
  };
  walk(0, 0, []);
  return resources;
}

/**
 * Read the string table of a VERSIONINFO resource.
 * @param {Buffer} buffer
 * @param {number} offset
 */
export function parseVersionInfo(buffer, offset) {
  const readNode = (at) => {
    const length = buffer.readUInt16LE(at);
    const valueLength = buffer.readUInt16LE(at + 2);
    const type = buffer.readUInt16LE(at + 4);
    let cursor = at + 6;
    let key = '';
    while (cursor + 1 < at + length) {
      const unit = buffer.readUInt16LE(cursor);
      cursor += 2;
      if (unit === 0) break;
      key += String.fromCharCode(unit);
    }
    const valueAt = DWORD_ALIGN(cursor);
    const children = [];
    let childAt = DWORD_ALIGN(valueAt + (type === 1 ? valueLength * 2 : valueLength));
    while (childAt + 6 <= at + length) {
      const childLength = buffer.readUInt16LE(childAt);
      if (childLength === 0 || childAt + childLength > at + length) break;
      children.push(readNode(childAt));
      childAt = DWORD_ALIGN(childAt + childLength);
    }
    const value = type === 1
      ? buffer.toString('utf16le', valueAt, valueAt + Math.max(0, valueLength * 2 - 2))
      : buffer.subarray(valueAt, valueAt + valueLength);
    return { key, type, valueLength, length, value, children };
  };

  const root = readNode(offset);
  const fixedAt = DWORD_ALIGN(offset + 6 + 'VS_VERSION_INFO'.length * 2 + 2);
  const version = (ms, ls) => `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
  const fileVersionMs = buffer.readUInt32LE(fixedAt + 8);
  const fileVersionLs = buffer.readUInt32LE(fixedAt + 12);
  const productVersionMs = buffer.readUInt32LE(fixedAt + 16);
  const productVersionLs = buffer.readUInt32LE(fixedAt + 20);

  const strings = {};
  const translations = [];
  for (const section of root.children) {
    if (section.key === 'StringFileInfo') {
      for (const table of section.children) {
        for (const entry of table.children) strings[entry.key] = entry.value;
      }
    }
    if (section.key === 'VarFileInfo') {
      for (const entry of section.children) {
        if (entry.value instanceof Buffer) {
          for (let at = 0; at + 4 <= entry.value.length; at += 4) {
            const value = entry.value.readUInt32LE(at);
            translations.push(`0x${(value & 0xffff).toString(16).padStart(4, '0')} 0x${((value >>> 16) & 0xffff).toString(16).padStart(4, '0')}`);
          }
        }
      }
    }
  }
  return {
    signature: buffer.readUInt32LE(fixedAt),
    fixedFileVersion: version(fileVersionMs, fileVersionLs),
    fixedProductVersion: version(productVersionMs, productVersionLs),
    // VS_FIXEDFILEINFO order: signature, strucVersion, fileVersion MS/LS,
    // productVersion MS/LS, fileFlagsMask, fileFlags, fileOS, fileType,
    // fileSubtype, fileDate MS/LS.
    fileFlagsMask: buffer.readUInt32LE(fixedAt + 24),
    fileFlags: buffer.readUInt32LE(fixedAt + 28),
    fileOs: buffer.readUInt32LE(fixedAt + 32),
    fileType: buffer.readUInt32LE(fixedAt + 36),
    fileSubtype: buffer.readUInt32LE(fixedAt + 40),
    strings,
    translations,
  };
}

/** All resources of one type, keyed by id or name. */
export function resourcesOfType(buffer, type) {
  return listResources(buffer).filter((resource) => resource.type === type);
}

/* --------------------------------------------------------- icon decoding */

/**
 * Read every image out of a `.ico` file.
 * @param {Buffer} ico
 */
export function readIco(ico) {
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
    throw new Error('the icon file is not a Windows icon (type 1)');
  }
  const count = ico.readUInt16LE(4);
  const images = [];
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16;
    const width = ico[at] === 0 ? 256 : ico[at];
    const height = ico[at + 1] === 0 ? 256 : ico[at + 1];
    const colors = ico[at + 2];
    const planes = ico.readUInt16LE(at + 4);
    const bitsPerPixel = ico.readUInt16LE(at + 6);
    const size = ico.readUInt32LE(at + 8);
    const offset = ico.readUInt32LE(at + 12);
    if (offset + size > ico.length) throw new Error(`icon image ${index} runs past the end of the file`);
    images.push({
      index,
      width,
      height,
      colors,
      planes,
      bitsPerPixel,
      size,
      offset,
      data: ico.subarray(offset, offset + size),
      isPng: ico.subarray(offset, offset + 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    });
  }
  return images;
}

/** CRC-32 lookup table (built once). @type {Int32Array|null} */
let crcTable = null;

/** PNG chunk with its CRC. */
function pngChunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), payload]);
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[index] = value;
    }
  }
  let crc = -1;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE((crc ^ -1) >>> 0);
  return Buffer.concat([length, body, crcBuffer]);
}

/**
 * Encode top-down RGBA pixels as a PNG image.
 * @param {{ width: number, height: number, rgba: Buffer }} image
 */
export function encodePng({ width, height, rgba }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;    // bit depth
  header[9] = 6;    // colour type: truecolour with alpha
  header[10] = 0;   // deflate
  header[11] = 0;   // adaptive filtering
  header[12] = 0;   // no interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, row * (stride + 1) + 1, row * stride, row * stride + stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Decode a 32-bit bottom-up BMP icon frame into top-down RGBA. Icons store an
 * AND mask after the colour data; when every alpha byte is zero (older icon
 * editors) transparency is taken from that mask instead.
 * @param {Buffer} data
 */
export function decodeIcoFrame(data) {
  const headerSize = data.readUInt32LE(0);
  if (headerSize < 40) throw new Error(`unsupported icon frame header (${headerSize} bytes)`);
  const width = data.readInt32LE(4);
  const doubled = data.readInt32LE(8);
  const height = Math.abs(doubled) / 2;
  const bitsPerPixel = data.readUInt16LE(14);
  const compression = data.readUInt32LE(16);
  if (compression !== 0) throw new Error(`unsupported icon frame compression (${compression})`);
  if (bitsPerPixel !== 32 && bitsPerPixel !== 24) {
    throw new Error(`unsupported icon frame colour depth (${bitsPerPixel} bpp)`);
  }
  const pixelOffset = headerSize;
  const bytesPerRow = bitsPerPixel === 32 ? width * 4 : Math.ceil((width * 3) / 4) * 4;
  const rgba = Buffer.alloc(width * height * 4);
  let opaque = false;
  for (let row = 0; row < height; row += 1) {
    const sourceRow = (doubled > 0 ? height - 1 - row : row) * bytesPerRow;
    for (let column = 0; column < width; column += 1) {
      const source = pixelOffset + sourceRow + column * (bitsPerPixel === 32 ? 4 : 3);
      const target = (row * width + column) * 4;
      rgba[target] = data[source + 2];
      rgba[target + 1] = data[source + 1];
      rgba[target + 2] = data[source];
      const alpha = bitsPerPixel === 32 ? data[source + 3] : 255;
      if (alpha > 0) opaque = true;
      rgba[target + 3] = alpha;
    }
  }
  if (bitsPerPixel === 32 && !opaque) {
    const maskOffset = pixelOffset + height * bytesPerRow;
    const maskRowBytes = Math.ceil(width / 32) * 4;
    for (let row = 0; row < height; row += 1) {
      const maskRow = (doubled > 0 ? height - 1 - row : row) * maskRowBytes;
      for (let column = 0; column < width; column += 1) {
        const bit = (data[maskOffset + maskRow + (column >> 3)] >> (7 - (column & 7))) & 1;
        rgba[(row * width + column) * 4 + 3] = bit ? 0 : 255;
      }
    }
  }
  return { width, height, rgba };
}

/**
 * Prepare the icon images that go into the resource section.
 *
 * Windows accepts PNG-compressed frames (Vista and later) and every shipped
 * 256-pixel icon uses one: re-encoding the largest frames as PNG keeps the
 * whole icon well inside the `.rsrc` section that a cross-compiled image
 * already has, so no section has to grow or move.
 *
 * @param {Buffer} ico
 * @param {{ pngFrom?: number, budget?: number }} [options]
 */
export function buildIconResource(ico, { budget = Infinity } = {}) {
  const source = readIco(ico);
  if (!source.length) throw new Error('the icon file contains no images');
  /** @type {{ id: number, width: number, height: number, bitsPerPixel: number, original: Buffer, data: Buffer, encoded: 'bmp'|'png' }[]} */
  const images = source
    .map((image) => /** @type {any} */ ({
      id: 0,
      width: image.width,
      height: image.height,
      bitsPerPixel: image.bitsPerPixel,
      /** The frame exactly as the .ico stores it (BMP, or PNG if already compressed). */
      original: image.data,
      data: image.data,
      encoded: image.isPng ? 'png' : 'bmp',
    }))
    .sort((a, b) => a.width - b.width || a.height - b.height);

  const total = () => images.reduce((sum, image) => sum + image.data.length, 0);
  // Raw frames are the conservative choice, so PNG is used only for the frames
  // that would otherwise overflow the resource section — largest first.
  while (total() > budget) {
    const candidate = [...images].reverse().find((image) => image.encoded === 'bmp');
    if (!candidate) break;
    candidate.data = encodePng(decodeIcoFrame(candidate.original));
    candidate.bitsPerPixel = 32;
    candidate.encoded = 'png';
  }
  // Still too big: drop the largest frames until the rest fit.
  while (total() > budget && images.length > 1) images.pop();
  if (total() > budget) throw new Error(`the icon (${total()} bytes) does not fit the available ${budget} bytes`);
  images.forEach((image, index) => { image.id = index + 1; });
  return images;
}

/** GRPICONDIR + GRPICONDIRENTRY records for a set of icon images. */
export function buildIconGroup(images) {
  const group = Buffer.alloc(6 + images.length * 14);
  group.writeUInt16LE(0, 0);
  group.writeUInt16LE(1, 2);
  group.writeUInt16LE(images.length, 4);
  images.forEach((image, index) => {
    const at = 6 + index * 14;
    group[at] = image.width >= 256 ? 0 : image.width;
    group[at + 1] = image.height >= 256 ? 0 : image.height;
    group[at + 2] = 0;
    group[at + 3] = 0;
    group.writeUInt16LE(1, at + 4);
    group.writeUInt16LE(image.bitsPerPixel, at + 6);
    group.writeUInt32LE(image.data.length, at + 8);
    group.writeUInt16LE(image.id, at + 12);
  });
  return group;
}

/* ---------------------------------------------------- resource tree write */

/**
 * A VERSIONINFO key: UTF-16LE and NUL-terminated, *not* padded — the padding
 * that aligns the value (or the children) is counted from its real length, so
 * pre-padding it would shift every offset that follows.
 * @param {string} key
 */
function keyBuffer(key) {
  return Buffer.from(`${key}\0`, 'utf16le');
}

/**
 * A resource *name* is a 16-bit character count followed by the UTF-16LE
 * characters — no terminator — padded to a 4-byte boundary.
 * @param {string} name
 */
function resourceNameBuffer(name) {
  const characters = Buffer.from(name, 'utf16le');
  const total = DWORD_ALIGN(2 + characters.length);
  const padded = Buffer.alloc(total);
  padded.writeUInt16LE(name.length, 0);
  characters.copy(padded, 2);
  return padded;
}

/**
 * @typedef {{ id?: number, name?: string, language: number, data: Buffer }} ResourceEntry
 * @typedef {{ type: number, resources: ResourceEntry[] }} ResourceGroup
 */

/** One node of a VS_VERSIONINFO tree. */
/**
 * @param {{ key: string, type?: number, value?: string|null, binaryValue?: Buffer|null, children?: Buffer[] }} node
 */
function versionNode({ key, type = 1, value = null, binaryValue = null, children = [] }) {
  const keyBytes = keyBuffer(key);
  /** @type {Buffer[]} */
  const parts = [];
  // Container nodes (StringFileInfo, an individual StringTable, VarFileInfo)
  // carry no value of their own, so wValueLength is zero for them.
  const valueBytes = type === 1
    ? (value === null ? Buffer.alloc(0) : Buffer.from(`${value}\0`, 'utf16le'))
    : (binaryValue ?? Buffer.alloc(0));
  // Every child starts on a DWORD boundary. A node's own wLength stays exact
  // (it may end unaligned); the padding belongs to the parent, which is how
  // rc.exe and Bun lay these blocks out.
  const childrenBytes = Buffer.concat(children.flatMap((child, index) => {
    if (index === children.length - 1) return [child];
    const padding = DWORD_ALIGN(child.length) - child.length;
    return padding ? [child, Buffer.alloc(padding)] : [child];
  }));
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(type === 1 ? (valueBytes.length / 2) : valueBytes.length, 2);
  head.writeUInt16LE(type, 4);
  parts.push(head, keyBytes);
  let length = 6 + keyBytes.length;
  if (valueBytes.length) {
    const valuePadding = DWORD_ALIGN(length) - length;
    parts.push(Buffer.alloc(valuePadding), valueBytes);
    length += valuePadding + valueBytes.length;
  }
  if (childrenBytes.length) {
    const childPadding = DWORD_ALIGN(length) - length;
    parts.push(Buffer.alloc(childPadding), childrenBytes);
    length += childPadding + childrenBytes.length;
  }
  const block = Buffer.concat(parts, length);
  block.writeUInt16LE(length, 0);
  return block;
}

/**
 * Build a complete VS_VERSIONINFO resource.
 * @param {Record<string, string>} strings
 * @param {{ fileVersion: string, productVersion: string, language?: number, codePage?: number }} options
 */
export function buildVersionInfo(strings, { fileVersion, productVersion, language = 0x0409, codePage = 0x04b0 }) {
  const parts = (version) => version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [fileMajor, fileMinor, fileBuild, fileRevision] = parts(fileVersion);
  const [productMajor, productMinor, productBuild, productRevision] = parts(productVersion);
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xfeef04bd, 0);                       // VS_FFI_SIGNATURE
  fixed.writeUInt32LE(0x00010000, 4);                       // VS_FFI_STRUCVERSION
  fixed.writeUInt32LE(((fileMajor << 16) | fileMinor) >>> 0, 8);
  fixed.writeUInt32LE(((fileBuild << 16) | fileRevision) >>> 0, 12);
  fixed.writeUInt32LE(((productMajor << 16) | productMinor) >>> 0, 16);
  fixed.writeUInt32LE(((productBuild << 16) | productRevision) >>> 0, 20);
  fixed.writeUInt32LE(0x3f, 24);                            // VS_FFI_FILEFLAGSMASK
  fixed.writeUInt32LE(0, 28);                               // no debug/prerelease flags
  fixed.writeUInt32LE(0x40004, 32);                         // VOS_NT_WINDOWS32
  fixed.writeUInt32LE(0x1, 36);                             // VFT_APP
  fixed.writeUInt32LE(0, 40);                               // no subtype

  const tableKey = `${language.toString(16).padStart(4, '0').toUpperCase()}${codePage.toString(16).padStart(4, '0').toUpperCase()}`;
  const translation = Buffer.alloc(4);
  translation.writeUInt32LE((((codePage << 16) | language) >>> 0), 0);

  const ordered = [
    'CompanyName',
    'FileDescription',
    'FileVersion',
    'InternalName',
    'LegalCopyright',
    'OriginalFilename',
    'ProductName',
    'ProductVersion',
  ].filter((name) => strings[name] !== undefined);

  return versionNode({
    key: 'VS_VERSION_INFO',
    type: 0,
    binaryValue: fixed,
    children: [
      versionNode({
        key: 'StringFileInfo',
        children: [
          versionNode({
            key: tableKey,
            children: ordered.map((name) => versionNode({ key: name, type: 1, value: strings[name] })),
          }),
        ],
      }),
      versionNode({
        key: 'VarFileInfo',
        children: [
          versionNode({ key: 'Translation', type: 0, binaryValue: translation }),
        ],
      }),
    ],
  });
}

/**
 * Resource directory entries must be sorted: named entries first (by name),
 * then numeric ids ascending. Windows honours the ordering when it picks the
 * "first" resource of a type, so this matters for the icon group.
 * @param {ResourceEntry[]} resources
 * @returns {ResourceEntry[]}
 */
function sortResourceEntries(resources) {
  const named = resources
    .filter((resource) => resource.name !== undefined)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const identified = resources
    .filter((resource) => resource.name === undefined)
    .sort((a, b) => Number(a.id) - Number(b.id));
  return [...named, ...identified];
}

/**
 * Serialise a resource directory: `{ type → { name/id → { language → blob } } }`.
 * @param {ResourceGroup[]} groups
 * @param {number} baseRva  virtual address the tree is written at
 */
export function buildResourceDirectory(groups, baseRva) {
  /** @type {{ chunks: Buffer[], length: number, push: (buffer: Buffer) => number }} */
  const encoder = {
    chunks: [],
    length: 0,
    /** Copy `buffer` at a DWORD boundary and return its relative offset. */
    push(buffer) {
      const aligned = DWORD_ALIGN(this.length);
      if (aligned > this.length) this.chunks.push(Buffer.alloc(aligned - this.length));
      const offset = aligned;
      this.chunks.push(buffer);
      this.length = offset + buffer.length;
      return offset;
    },
  };

  // One directory block per level: root → type → resource name/id → language.
  const sortedGroups = groups
    .map((group) => ({ group, entries: sortResourceEntries(group.resources) }))
    .sort((a, b) => a.group.type - b.group.type);

  /** @typedef {{ names: number, type: Buffer, languages: Buffer[], dataEntries: Buffer[], offsets: { type: number, languages: number[], dataEntries: number[] } }} ResourceBlock */
  /** @type {ResourceBlock[]} */
  const blocks = sortedGroups.map(({ entries }) => {
    const names = entries.filter((entry) => entry.name !== undefined).length;
    return {
      names,
      type: Buffer.alloc(16 + entries.length * 8),
      languages: entries.map(() => Buffer.alloc(16 + 8)),
      dataEntries: entries.map(() => Buffer.alloc(16)),
      offsets: { type: 0, languages: /** @type {number[]} */ ([]), dataEntries: /** @type {number[]} */ ([]) },
    };
  });
  blocks.forEach((block, index) => {
    block.type.writeUInt16LE(block.names, 12);
    block.type.writeUInt16LE(block.dataEntries.length - block.names, 14);
    block.languages.forEach((language) => language.writeUInt16LE(1, 14));
    void index;
  });

  const root = Buffer.alloc(16 + blocks.length * 8);
  root.writeUInt16LE(0, 12);
  root.writeUInt16LE(blocks.length, 14);
  const rootOffset = encoder.push(root);
  if (rootOffset !== 0) throw new Error('internal error: the resource root directory must sit at offset 0');

  // Level 1: the type directories, referenced from the root in ascending order.
  blocks.forEach((block, index) => {
    block.offsets.type = encoder.push(block.type);
    root.writeUInt32LE(sortedGroups[index].group.type >>> 0, 16 + index * 8);
    root.writeUInt32LE((0x80000000 | block.offsets.type) >>> 0, 16 + index * 8 + 4);
  });

  // Level 2: one language directory per resource, plus the name strings.
  blocks.forEach((block) => {
    block.offsets.languages = block.languages.map((language) => encoder.push(language));
  });
  /** @type {(number|null)[]} */
  const nameOffsets = blocks.map((block, index) => {
    const named = sortedGroups[index].entries.find((entry) => entry.name !== undefined);
    return named ? encoder.push(resourceNameBuffer(String(named.name))) : null;
  });

  // Data entries follow the directory blocks, then the blobs themselves.
  blocks.forEach((block) => {
    block.offsets.dataEntries = block.dataEntries.map((entry) => encoder.push(entry));
  });
  blocks.forEach((block, index) => {
    const { entries } = sortedGroups[index];
    const blobOffsets = entries.map((entry) => encoder.push(entry.data));
    entries.forEach((entry, entryIndex) => {
      const at = 16 + entryIndex * 8;
      block.type.writeUInt32LE(
        entry.name !== undefined ? (0x80000000 | Number(nameOffsets[index])) >>> 0 : Number(entry.id) >>> 0,
        at,
      );
      block.type.writeUInt32LE((0x80000000 | block.offsets.languages[entryIndex]) >>> 0, at + 4);
      const language = block.languages[entryIndex];
      language.writeUInt32LE(entry.language, 16);
      // A leaf entry points at a data entry, so DataIsDirectory (bit 31) stays clear.
      language.writeUInt32LE(block.offsets.dataEntries[entryIndex] >>> 0, 20);
      const dataEntry = block.dataEntries[entryIndex];
      dataEntry.writeUInt32LE((baseRva + blobOffsets[entryIndex]) >>> 0, 0);
      dataEntry.writeUInt32LE(entry.data.length, 4);
      dataEntry.writeUInt32LE(1200, 8);
      dataEntry.writeUInt32LE(0, 12);
    });
  });

  const content = Buffer.concat(encoder.chunks);
  return { content, size: DWORD_ALIGN(encoder.length) };
}

/* ------------------------------------------------------------- stamping */

/**
 * Replace the icon and VERSIONINFO resources of a PE image in place.
 *
 * The `.rsrc` section keeps its size, address and file offset; only the bytes
 * inside its raw range are rewritten. Everything else is copied verbatim, which
 * is what `changedWithin` proves to the caller.
 *
 * @param {Buffer} buffer
 * @param {{ icon?: Buffer, versionInfo?: Buffer, keepManifest?: boolean }} options
 */
export function stampExecutable(buffer, { icon, versionInfo } = {}) {
  if (!icon) throw new Error('stampExecutable needs the icon file to embed');
  if (!versionInfo) throw new Error('stampExecutable needs a built VS_VERSIONINFO resource');
  const pe = parsePe(buffer);
  if (pe.machine !== 0x8664) throw new Error(`expected an x86-64 image, found machine 0x${pe.machine.toString(16)}`);
  const directory = pe.dataDirectories[RESOURCE_DIRECTORY_INDEX];
  const section = pe.sectionForRva(directory.rva);
  if (!section || !directory.rva) throw new Error('the executable has no resource section to stamp');
  const regionStart = section.rawPointer;
  const regionEnd = section.rawPointer + section.rawSize;
  if (regionEnd > buffer.length) throw new Error('the resource section runs past the end of the file');

  const existing = listResources(buffer);
  const manifest = existing.find((resource) => resource.type === RT_MANIFEST);
  if (!manifest) throw new Error('the executable has no application manifest; refusing to stamp');
  const manifestBlob = buffer.subarray(manifest.offset, manifest.offset + manifest.size);

  const available = Math.min(section.virtualSize, section.rawSize);
  const images = buildIconResource(icon, { budget: available - 512 });
  /** @type {ResourceGroup[]} */
  const groups = [
    {
      type: RT_ICON,
      resources: images.map((image) => ({ id: image.id, language: 1033, data: image.data })),
    },
    {
      type: RT_GROUP_ICON,
      // Windows' ExtractAssociatedIcon looks for the first icon group; using a
      // numeric id (1) is the most compatible form (resource scripts use
      // IDI_ICON 101 / 1, and some GDI+ paths ignore named groups). Keep the
      // historic name as a second entry so Explorer's Details, verify:artifacts
      // and the existing tests that expect IDI_MYICON continue to pass.
      resources: [
        { id: 1, language: 1033, data: buildIconGroup(images) },
        { name: 'IDI_MYICON', language: 1033, data: buildIconGroup(images) },
      ],
    },
    {
      type: RT_VERSION,
      resources: [{ id: 1, language: 1033, data: versionInfo }],
    },
    {
      type: RT_MANIFEST,
      resources: [{ id: 1, language: 1033, data: manifestBlob }],
    },
  ];
  const { content, size } = buildResourceDirectory(groups, directory.rva);
  if (size > available) {
    throw new Error(`the new resource tree (${size} bytes) does not fit in the ${available} bytes of .rsrc`);
  }

  const output = Buffer.from(buffer);
  output.fill(0, regionStart, regionEnd);
  content.copy(output, regionStart);

  // Proof of surgery: everything before and after the .rsrc section must still
  // be byte-identical to the compiler's output (headers, code, data and the
  // appended Bun payload all live outside it).
  const outsideIntact = output.subarray(0, regionStart).equals(buffer.subarray(0, regionStart))
    && output.subarray(regionEnd).equals(buffer.subarray(regionEnd));
  if (!outsideIntact) throw new Error('stamping modified bytes outside .rsrc — refusing to continue');

  let changedBytes = 0;
  for (let index = regionStart; index < regionEnd; index += 1) {
    if (output[index] !== buffer[index]) changedBytes += 1;
  }

  return {
    buffer: output,
    region: { start: regionStart, end: regionEnd, size: section.rawSize },
    changedBytes,
    resourceSize: size,
    free: available - size,
    icon: { images: images.map((image) => ({ width: image.width, height: image.height, encoded: image.encoded, size: image.data.length, id: image.id })), bytes: images.reduce((sum, image) => sum + image.data.length, 0) },
  };
}

/** Pretty DWORD quantity as hex. */
export function hex(value) {
  return `0x${(value >>> 0).toString(16)}`;
}
