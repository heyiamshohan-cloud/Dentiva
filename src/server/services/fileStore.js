/**
 * Secure file storage for clinical attachments (§ 28, § 68).
 *
 * Security rules enforced here:
 *  - the stored file name is generated (UUID + validated extension); the
 *    original user supplied name is never used for storage,
 *  - extensions are checked against an allow-list,
 *  - every resolved path is verified to stay inside the attachments root
 *    (path-traversal defence), including symlink-free normalisation,
 *  - files are written atomically (temp file + rename) so a crash can never
 *    leave a half-written radiograph,
 *  - a SHA-256 digest is calculated during the write and stored for integrity
 *    verification (backup/restore, Settings → Data).
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, copyFileSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { ATTACHMENT_EXTENSIONS, ATTACHMENT_MIME_BY_EXT, MAX_ATTACHMENT_BYTES } from '../../shared/constants.js';
import { FileError } from '../../shared/errors.js';

export function attachmentsRoot(dataDir) {
  return join(dataDir, 'attachments');
}

/** Extract and validate the extension of an uploaded file. */
export function validateExtension(fileName, declaredMime = null) {
  const ext = extname(String(fileName ?? '')).replace('.', '').toLowerCase();
  if (!ext) throw new FileError('files.missingExtension');
  if (!ATTACHMENT_EXTENSIONS.includes(ext)) throw new FileError('files.unsupportedType', { extension: ext });
  const mime = ATTACHMENT_MIME_BY_EXT[ext] ?? declaredMime ?? 'application/octet-stream';
  return { extension: ext, mime };
}

/** Build the `YYYY/MM` bucket for a date and a collision-proof stored name. */
export function buildStoragePath(date = new Date(), extension = 'bin') {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const storedName = `${randomUUID()}.${extension}`;
  return { relPath: `${year}/${month}/${storedName}`, storedName, year, month };
}

/**
 * Resolve a relative storage path inside the attachments root.
 * Throws when the path would escape the root (traversal) or is absolute.
 */
export function resolveStoredPath(dataDir, relPath) {
  const root = resolve(attachmentsRoot(dataDir));
  const candidate = resolve(root, normalize(String(relPath ?? '')));
  const relativePath = relative(root, candidate);
  if (!relativePath || relativePath.startsWith('..') || relativePath.includes(`..${sep}`) || resolve(candidate) === root) {
    throw new FileError('files.invalidPath');
  }
  return candidate;
}

/** Folder safety: ensures the directory exists (no user input in the path). */
function ensureDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

/**
 * Atomically store bytes for an attachment.
 * @param {string} dataDir
 * @param {{ data: Uint8Array|ArrayBuffer|Blob|ReadableStream, extension: string, capturedAt?: Date }} input
 * @returns {Promise<{ relPath: string, storedName: string, sizeBytes: number, sha256: string, absolutePath: string }>}
 */
export async function storeFile(dataDir, input) {
  const capturedAt = input.capturedAt ?? new Date();
  const { relPath, storedName } = buildStoragePath(capturedAt, input.extension);
  const absolutePath = resolveStoredPath(dataDir, relPath);
  ensureDir(absolutePath);
  const tempPath = `${absolutePath}.part`;

  const hash = createHash('sha256');
  let sizeBytes = 0;

  /** @type {any} */
  const source = input.data;
  const isStreamLike =
    source && typeof source === 'object' && (typeof source.stream === 'function' || typeof source[Symbol.asyncIterator] === 'function');

  if (isStreamLike && typeof source.arrayBuffer !== 'function') {
    const nodeStream = source instanceof Readable ? source : Readable.fromWeb(source);
    let bytes = 0;
    const hashStream = new (await import('node:stream')).Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_ATTACHMENT_BYTES) {
          callback(new FileError('files.tooLarge', { maxMb: Math.round(MAX_ATTACHMENT_BYTES / 1048576) }));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(nodeStream, hashStream, createWriteStream(tempPath));
    sizeBytes = bytes;
  } else {
    const buffer = Buffer.isBuffer(source)
      ? source
      : source instanceof Uint8Array
        ? Buffer.from(source)
        : source instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(source))
          : source && typeof source.arrayBuffer === 'function'
            ? Buffer.from(await source.arrayBuffer())
            : Buffer.from(source ?? []);
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      throw new FileError('files.tooLarge', { maxMb: Math.round(MAX_ATTACHMENT_BYTES / 1048576) });
    }
    hash.update(buffer);
    sizeBytes = buffer.length;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(tempPath, buffer);
  }

  renameSync(tempPath, absolutePath);
  return {
    relPath,
    storedName,
    sizeBytes,
    sha256: hash.digest('hex'),
    absolutePath,
  };
}

/** Hash an existing stored file (restore verification, integrity checks). */
export async function hashFile(absolutePath) {
  const hash = createHash('sha256');
  const stream = createReadStream(absolutePath);
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), sizeBytes: size };
}

export function fileExists(absolutePath) {
  try {
    return existsSync(absolutePath) && statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

export function fileSize(absolutePath) {
  try {
    return statSync(absolutePath).size;
  } catch {
    return 0;
  }
}

export function removeStoredFile(dataDir, relPath) {
  try {
    const absolutePath = resolveStoredPath(dataDir, relPath);
    if (fileExists(absolutePath)) unlinkSync(absolutePath);
    return true;
  } catch {
    return false;
  }
}

export function copyStoredFile(dataDir, relPath, destinationPath) {
  const absolutePath = resolveStoredPath(dataDir, relPath);
  ensureDir(destinationPath);
  copyFileSync(absolutePath, destinationPath);
  return destinationPath;
}

/** Build a stream that the HTTP layer can pipe straight to the client. */
export function streamStoredFile(dataDir, relPath) {
  const absolutePath = resolveStoredPath(dataDir, relPath);
  if (!fileExists(absolutePath)) throw new FileError('files.missing', null, 404);
  return { stream: createReadStream(absolutePath), absolutePath, size: fileSize(absolutePath) };
}

/** Safe, human friendly download name (keeps unicode, strips separators). */
export function safeDownloadName(name, fallback = 'attachment') {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length ? cleaned.slice(0, 160) : fallback;
}
