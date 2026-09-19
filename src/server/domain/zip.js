/**
 * Minimal ZIP reader/writer (deflate or stored), used by the backup/restore and
 * data-export tools (§ 49).
 *
 * Why hand-rolled: the app must stay dependency-free and work offline, and ZIP is
 * the one archive format every Windows machine can open without extra software.
 * Only the parts of the format we need are implemented — no ZIP64, no encryption,
 * no multi-disk — and both directions are covered so a backup can be verified and
 * restored by the same process that wrote it.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

export function crc32(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let crc = -1;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[index]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  return Buffer.from(String(data ?? ''), 'utf8');
}

function dosDateTime(date = new Date()) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, date: day };
}

/**
 * Build a ZIP archive in memory.
 * @param {{ name: string, data: Buffer|Uint8Array|string, store?: boolean, mtime?: string|number|Date }[]} entries
 * @returns {Buffer}
 */
export function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(String(entry.name).replace(/\\/g, '/'), 'utf8');
    const data = toBuffer(entry.data);
    const crc = crc32(data);
    // Very small or already-compressed payloads stay stored, everything else deflates.
    const shouldStore = entry.store === true || data.length < 96;
    const compressed = shouldStore ? data : deflateRawSync(data, { level: 6 });
    const method = shouldStore ? 0 : 8;
    const { time, date } = dosDateTime(entry.mtime ? new Date(entry.mtime) : new Date());

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attributes
    centralHeader.writeUInt32LE(0, 38); // external attributes
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

/**
 * List the entries of a ZIP archive.
 * @param {Buffer|Uint8Array} archive
 */
export function listZip(archive) {
  const buffer = toBuffer(archive);
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd === -1) throw new Error('Invalid ZIP archive: end of central directory not found');
  const total = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error('Invalid ZIP archive: bad central directory entry');
    const method = buffer.readUInt16LE(pointer + 10);
    const crc = buffer.readUInt32LE(pointer + 16);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const size = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
    entries.push({ name, method, crc, compressedSize, size, localOffset });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 66000);
  for (let index = buffer.length - 22; index >= minimum; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

/**
 * Read one entry out of an archive (verifying its CRC).
 * @param {Buffer|Uint8Array} archive
 * @param {{ name: string, localOffset: number, method: number, compressedSize: number, size: number, crc: number }} entry
 */
export function readZipEntry(archive, entry) {
  const buffer = toBuffer(archive);
  if (buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error(`Invalid ZIP entry: ${entry.name}`);
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);
  let data;
  if (entry.method === 0) data = Buffer.from(raw);
  else if (entry.method === 8) data = inflateRawSync(raw);
  else throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
  if (data.length !== entry.size) throw new Error(`ZIP entry ${entry.name} has the wrong size`);
  if (crc32(data) !== entry.crc) throw new Error(`ZIP entry ${entry.name} failed its checksum`);
  return data;
}

/** Convenience: extract the whole archive into a `{ name → Buffer }` map. */
export function extractZip(archive) {
  const buffer = toBuffer(archive);
  const files = new Map();
  for (const entry of listZip(buffer)) {
    if (entry.name.endsWith('/')) continue;
    files.set(entry.name, readZipEntry(buffer, entry));
  }
  return files;
}

export function readZipText(archive, entry) {
  return readZipEntry(toBuffer(archive), entry).toString('utf8');
}
