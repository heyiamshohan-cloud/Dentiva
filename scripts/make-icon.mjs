/**
 * DENTIVA — application icon generator.
 *
 * Draws the Dentiva mark (a tooth on a teal tile) in pure JavaScript and writes
 * every artefact the build needs — no image library, no downloaded artwork:
 *
 *   src/renderer/assets/icon.png   window favicon + in-app logo (256 px)
 *   resources/icon.png             installer / documentation image
 *   resources/icon.ico             multi-size Windows icon for the executable
 *
 *     bun run icon
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* ------------------------------------------------------------------ colours */

const TILE_TOP = [13, 116, 108];       // deep teal
const TILE_BOTTOM = [20, 178, 166];    // bright teal
const TILE_EDGE = [8, 74, 70];
const MARK = [255, 255, 255];
const MARK_SHADOW = [214, 240, 237];

/** @param {number} value @param {number} min @param {number} max */
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
/** Smooth 0→1 transition across `edge`. */
const smoothstep = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a.map((value, index) => value + (b[index] - value) * t);

/** Signed distance to a rounded rectangle (negative inside). */
function roundedRectDistance(x, y, cx, cy, halfWidth, halfHeight, radius) {
  const dx = Math.abs(x - cx) - (halfWidth - radius);
  const dy = Math.abs(y - cy) - (halfHeight - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/**
 * A tooth: rounded crown plus two tapered roots. All coordinates are in a
 * 0..1 unit square so the same shape scales to any size.
 * @param {number} x
 * @param {number} y
 * @returns {number} negative inside the tooth
 */
function toothDistance(x, y) {
  const crown = roundedRectDistance(x, y, 0.5, 0.41, 0.255, 0.195, 0.095);
  const rootLeft = roundedRectDistance(x, y, 0.4, 0.64, 0.082, 0.2, 0.07);
  const rootRight = roundedRectDistance(x, y, 0.6, 0.64, 0.082, 0.2, 0.07);
  const notch = roundedRectDistance(x, y, 0.5, 0.62, 0.042, 0.1, 0.035);
  return Math.max(Math.min(crown, Math.min(rootLeft, rootRight)), -notch);
}

/**
 * Render the icon at one size.
 * @param {number} size
 * @returns {Uint8Array} RGBA bytes
 */
function render(size) {
  const pixels = new Uint8Array(size * size * 4);
  const samples = 4;                      // supersampling factor per axis
  const step = 1 / (size * samples);
  const edge = 1.5 / size;                // anti-aliasing width in unit space

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px * samples + sx + 0.5) * step;
          const y = (py * samples + sy + 0.5) * step;

          // Tile — the Dentiva mark is a rounded teal tile (22 % corner radius).
          const tile = roundedRectDistance(x, y, 0.5, 0.5, 0.5, 0.5, 0.22);
          const tileAlpha = 1 - smoothstep(-edge, edge, tile);
          if (tileAlpha <= 0) continue;

          let colour = mix(TILE_TOP, TILE_BOTTOM, clamp((y - 0.06) / 0.88, 0, 1));
          // Soft inner edge so the tile reads well on dark and light desktops.
          colour = mix(colour, TILE_EDGE, clamp(-tile / 0.14, 0, 1) * 0.35);

          const tooth = toothDistance(x, y);
          const toothAlpha = 1 - smoothstep(-edge, edge, tooth);
          if (toothAlpha > 0) {
            const shadow = 1 - smoothstep(0, 0.02, tooth + 0.012);
            colour = mix(colour, MARK_SHADOW, toothAlpha * shadow * 0.45);
            colour = mix(colour, MARK, toothAlpha);
          }

          r += colour[0] * tileAlpha;
          g += colour[1] * tileAlpha;
          b += colour[2] * tileAlpha;
          a += tileAlpha;
        }
      }
      const total = samples * samples;
      const index = (py * size + px) * 4;
      const coverage = a / total;
      pixels[index] = Math.round(coverage > 0 ? r / a : 0);
      pixels[index + 1] = Math.round(coverage > 0 ? g / a : 0);
      pixels[index + 2] = Math.round(coverage > 0 ? b / a : 0);
      pixels[index + 3] = Math.round(coverage * 255);
    }
  }
  return pixels;
}

/* --------------------------------------------------------------------- png */

/** @param {Uint8Array} pixels @param {number} size */
function png(pixels, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // RGBA
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** @param {Buffer} buffer */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/* --------------------------------------------------------------------- ico */

/**
 * One `.ico` frame: a 32-bit BMP (colour rows + AND mask, both bottom-up).
 *
 * The AND mask is the part that is easiest to get wrong and the part Windows
 * is least forgiving about: **every mask row is padded to a four-byte
 * boundary**, so its size is `ceil(width / 32) * 4 * height`, not
 * `width * height / 8`. Those two only agree when the width is a multiple of
 * 32, which is why 16, 24 and 48 px frames used to be written 32, 24 and 96
 * bytes too short — Windows and GDI+ then read past the end of the frame and
 * either reject the image or hand back an empty one.
 *
 * `biSizeImage` counts the colour *and* the mask bytes so a loader that trusts
 * it reserves the right amount.
 *
 * @param {Uint8Array} pixels @param {number} size
 */
function bmpEntry(pixels, size) {
  const xorSize = size * size * 4;
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const maskSize = maskRowBytes * size;

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);   // height is doubled for the AND mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(xorSize + maskSize, 20);

  const body = Buffer.alloc(xorSize);
  const mask = Buffer.alloc(maskSize);
  for (let y = 0; y < size; y += 1) {
    // Bitmaps are stored bottom-up, BGRA order; the mask rows follow the
    // same bottom-up order, one bit per pixel, most significant bit first.
    const source = (size - 1 - y) * size * 4;
    const maskRow = y * maskRowBytes;
    for (let x = 0; x < size; x += 1) {
      const from = source + x * 4;
      const to = (y * size + x) * 4;
      body[to] = pixels[from + 2];
      body[to + 1] = pixels[from + 1];
      body[to + 2] = pixels[from];
      body[to + 3] = pixels[from + 3];
      // 1 = transparent. Pixels carrying a real alpha value stay 0 (opaque)
      // so the mask and the alpha channel never disagree.
      if (pixels[from + 3] === 0) mask[maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, body, mask]);
}

/** @param {number[]} sizes */
function ico(sizes) {
  const entries = sizes.map((size) => ({ size, data: bmpEntry(render(size), size) }));
  const directory = Buffer.alloc(6 + entries.length * 16);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(entries.length, 4);
  let offset = directory.length;
  entries.forEach((entry, index) => {
    const at = 6 + index * 16;
    directory[at] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 2] = 0;
    directory[at + 3] = 0;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });
  return Buffer.concat([directory, ...entries.map((entry) => entry.data)]);
}

/* -------------------------------------------------------------------- main */

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function write(path, buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buffer);
  return `${path.replace(`${ROOT}/`, '')} (${(buffer.length / 1024).toFixed(1)} kB)`;
}

function main() {
  const icon256 = png(render(256), 256);
  const targets = [
    write(join(ROOT, 'src/renderer/assets/icon.png'), icon256),
    write(join(ROOT, 'resources/icon.png'), icon256),
    write(join(ROOT, 'resources/icon.ico'), ico(ICO_SIZES)),
  ];
  console.log('Dentiva icon written:');
  for (const line of targets) console.log(`  ${line}`);
}

main();

export { render, png, ico, ICO_SIZES };
