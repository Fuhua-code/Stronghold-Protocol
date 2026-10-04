#!/usr/bin/env node
// mobile/tools/download.mjs — resumable downloader used while preparing the Android toolchain.
//
//   node mobile/tools/download.mjs <url> <dest> [--min-bytes=N]
//
// Node's fetch follows redirects (Google's repository and GitHub releases both use them) and is markedly faster on
// this kind of host than PowerShell's Invoke-WebRequest. An interrupted run resumes from the existing `.part` file
// through a Range request, so a slow or flaky connection does not have to start over.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const [url, dest, ...rest] = process.argv.slice(2);
if (!url || !dest) {
  console.error('usage: node mobile/tools/download.mjs <url> <dest> [--min-bytes=N]');
  process.exit(2);
}
const minBytes = Number((rest.find((a) => a.startsWith('--min-bytes=')) || '').split('=')[1] || 1024);
const out = path.resolve(dest);
const part = `${out}.part`;
await fsp.mkdir(path.dirname(out), { recursive: true });

if (fs.existsSync(out) && (await fsp.stat(out)).size >= minBytes) {
  console.log(`already present: ${out} (${((await fsp.stat(out)).size / 1048576).toFixed(1)} MB)`);
  process.exit(0);
}

let offset = 0;
try { offset = (await fsp.stat(part)).size; } catch { /* no partial file */ }
console.log(`↓ ${url}\n  → ${out}${offset ? ` (resuming at ${(offset / 1048576).toFixed(1)} MB)` : ''}`);

const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
const res = await fetch(url, { redirect: 'follow', headers });
if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} for ${url}`);
if (res.status === 200 && offset > 0) offset = 0; // server ignored the range: start over
const total = Number(res.headers.get('content-length') || 0) + offset;
const stream = fs.createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' });

const started = Date.now();
let seen = offset;
let lastReport = 0;
for await (const chunk of res.body) {
  seen += chunk.length;
  if (!stream.write(chunk)) await new Promise((r) => stream.once('drain', r));
  const now = Date.now();
  if (now - lastReport > 5000) {
    lastReport = now;
    const pct = total ? ` ${((seen / total) * 100).toFixed(1)}%` : '';
    const rate = seen - offset ? ((seen - offset) / 1048576 / ((now - started) / 1000)) : 0;
    console.log(`  ${(seen / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)}` : ''}${pct}  ${rate.toFixed(2)} MB/s`);
  }
}
await new Promise((resolve, reject) => stream.end((e) => (e ? reject(e) : resolve())));

const size = (await fsp.stat(part)).size;
if (size < minBytes) throw new Error(`too small: ${size} bytes`);
await fsp.rename(part, out);
console.log(`✔ ${out}  ${(size / 1048576).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(0)} s`);
