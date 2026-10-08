// mobile/tools/make-icons.mjs — generate the launcher icons (mobile/android/res/mipmap-*/ic_launcher.png).
//
//   node mobile/tools/make-icons.mjs
//
// The icons are checked in so that a build needs no image tooling: this script writes them with a tiny PNG
// encoder (zlib + CRC32, no dependencies) and is re-run only when the artwork should change.
//
// Artwork: the client's own palette — the dark background #0c0f0e and the teal #4ed8af — with the shield/fortress
// mark of the game's boot screen (the SVG in public/index.html), drawn at five densities.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RES = path.join(HERE, '..', 'android', 'res');

const BG = [0x0c, 0x0f, 0x0e];
const FG = [0x4e, 0xd8, 0xaf];
const EDGE = [0x8f, 0xf0, 0xd4];

/** The shield of public/index.html's favicon as a unit-square point list: `M5 3h3v2h2V3h4v2h2V3h3v5l-2 2v7l2 2v2H5v-2l2-2v-7L5 8z`. */
const SHIELD = [
  [5, 3], [8, 3], [8, 5], [10, 5], [10, 3], [14, 3], [14, 5], [16, 5], [16, 3], [19, 3],
  [19, 8], [17, 10], [17, 17], [19, 19], [19, 21], [5, 21], [5, 19], [7, 17], [7, 10], [5, 8],
];

/** Even-odd point-in-polygon, sampling at pixel centres (anti-aliasing comes from the supersample factor). */
function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode an RGBA pixel buffer (size*size*4) as a PNG. */
function encodePng(pixels, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter type 0 (none)
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Render the icon at `size` px with a 3× supersample for soft edges. */
function render(size) {
  const SS = 3;
  const px = Buffer.alloc(size * size * 4);
  const scale = 24 / size; // the shield is drawn in the favicon's 24×24 space
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      let total = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (x + (sx + 0.5) / SS) * scale;
          const uy = (y + (sy + 0.5) / SS) * scale;
          total++;
          if (inPolygon(ux, uy, SHIELD)) hits++;
        }
      }
      let r = BG[0]; let g = BG[1]; let b = BG[2];
      if (hits) {
        const a = hits / total;
        // a light rim: brighten where the shape is only partially covered (the polygon's outline)
        const rim = hits < total ? EDGE : FG;
        r = Math.round(BG[0] * (1 - a) + rim[0] * a);
        g = Math.round(BG[1] * (1 - a) + rim[1] * a);
        b = Math.round(BG[2] * (1 - a) + rim[2] * a);
      }
      const o = (y * size + x) * 4;
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
    }
  }
  return { png: encodePng(px, size), size };
}

const DENSITIES = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
];

async function main() {
  for (const [density, size] of DENSITIES) {
    const dir = path.join(RES, `mipmap-${density}`);
    await fsp.mkdir(dir, { recursive: true });
    const { png } = render(size);
    const file = path.join(dir, 'ic_launcher.png');
    await fsp.writeFile(file, png);
    console.log(`  ${path.relative(path.join(RES, '..'), file)}  ${size}×${size}  ${png.length} bytes`);
  }
  // A 512 px copy for documentation / store listings (kept out of the APK: it lives outside res/).
  const doc = path.join(HERE, '..', 'icon-512.png');
  const big = render(512).png;
  await fsp.writeFile(doc, big);
  console.log(`  ${path.relative(path.join(HERE, '..'), doc)}  512×512  ${big.length} bytes`);
}

main().catch((e) => { console.error(e?.stack || e); process.exitCode = 1; });
