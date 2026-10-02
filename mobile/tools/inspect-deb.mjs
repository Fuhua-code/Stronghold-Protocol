// mobile/tools/inspect-deb.mjs — print the member names of a Termux .deb payload (development helper).
//
//   node mobile/tools/inspect-deb.mjs <file.deb> [pattern]
//
// Uses the same readers as mobile/build-apk.mjs (ar + tar, in plain Node), which is what the build relies on.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const [deb, pattern] = process.argv.slice(2);
if (!deb) {
  console.error('usage: node mobile/tools/inspect-deb.mjs <file.deb> [pattern]');
  process.exit(2);
}
const re = pattern ? new RegExp(pattern) : null;

const buf = await fsp.readFile(deb);
if (buf.subarray(0, 8).toString('ascii') !== '!<arch>\n') throw new Error('not an ar archive');
let p = 8;
let payload = null;
let payloadName = '';
while (p + 60 <= buf.length) {
  const name = buf.subarray(p, p + 16).toString('ascii').trim().replace(/\/$/, '');
  const size = parseInt(buf.subarray(p + 48, p + 58).toString('ascii').trim(), 10);
  const start = p + 60;
  if (!Number.isFinite(size) || size < 0) break;
  console.log(`member ${name} (${size} bytes)`);
  if (name.startsWith('data.tar')) { payload = buf.subarray(start, start + size); payloadName = name; }
  p = start + size + (size % 2);
}
if (!payload) throw new Error('no data.tar member');

let tar;
if (payloadName.endsWith('.gz')) tar = zlib.gunzipSync(payload);
else if (payloadName.endsWith('.xz')) {
  const tmpIn = path.join(os.tmpdir(), `inspect-${process.pid}.xz`);
  const tmpOut = `${tmpIn}.out`;
  await fsp.writeFile(tmpIn, payload);
  const r = spawnSync('xz', ['-dc', tmpIn], { stdio: ['ignore', fs.openSync(tmpOut, 'w'), 'inherit'] });
  if (r.status !== 0) throw new Error(`xz failed: ${r.status}`);
  tar = await fsp.readFile(tmpOut);
  await fsp.rm(tmpIn, { force: true });
  await fsp.rm(tmpOut, { force: true });
} else tar = payload;

let off = 0;
let shown = 0;
let files = 0;
while (off + 512 <= tar.length) {
  const header = tar.subarray(off, off + 512);
  if (header.every((b) => b === 0)) break;
  const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
  const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
  const full = prefix ? `${prefix}/${name}` : name;
  const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8) || 0;
  const type = String.fromCharCode(header[156] || 0x30);
  const sizeType = String.fromCharCode(header[124] || 0x30);
  if (type === '0' || type === '\0') files++;
  if (!re || re.test(full)) {
    console.log(`${type} ${sizeType} ${String(size).padStart(10)}  ${full}`);
    if (++shown > 40) break;
  }
  let dataSize = size;
  if (sizeType === 'x' || sizeType === 'g') dataSize = size; // pax headers: size field is the header size
  off += 512 + Math.ceil(dataSize / 512) * 512;
}
console.log(`\n${files} regular files, archive ${tar.length} bytes`);
