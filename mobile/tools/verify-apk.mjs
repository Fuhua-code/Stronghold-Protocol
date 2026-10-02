#!/usr/bin/env node
// mobile/tools/verify-apk.mjs — end-to-end check of the *packaged* APK without an Android device.
//
//   node mobile/tools/verify-apk.mjs [--apk mobile/build/….apk] [--node18 <dir>] [--keep] [--json <report.json>]
//
// What it proves (this is the strongest check that runs on a developer machine):
//   1. the APK contains everything the app needs (classes.dex, resources.arsc, AndroidManifest.xml, the native
//      runtime and the whole assets/nodejs-project tree) and every `assets/**` entry is intact — the ZIP is read
//      with Node's own zlib, so a CRC/size mismatch or a corrupt entry is detected;
//   2. the exact `assets/nodejs-project` tree is unpacked to a temporary directory and started with **Node 18**
//      (the runtime version nodejs-mobile embeds) using the same arguments MainActivity passes on the phone:
//        node <dir>/mobile/node/main.js --public <dir>/public --data <dir>/data --handshake <tmp>/handshake.json
//      — which is the real mobile entry point, the real server and the real client files;
//   3. over that server: /healthz, the client page, /data.js, the /sim/ simulation, vendor libs, fonts, gzip, a
//      206 range request, the /ws upgrade, and a sample of the art the client will request.
//
// It does not replace installing the APK on a phone (Android's own package handling, the WebView, audio and the
// touch UI cannot be exercised here) — but it catches every packaging, path, ESM and Node-version problem.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const o = { apk: null, node18: process.env.SP_NODE18 || null, keep: false, json: null, sample: 120 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apk') o.apk = argv[++i];
    else if (a === '--node18') o.node18 = argv[++i];
    else if (a === '--keep') o.keep = true;
    else if (a === '--json') o.json = argv[++i];
    else if (a === '--sample') o.sample = Number(argv[++i]) || 120;
    else throw new Error(`unknown option ${a}`);
  }
  if (!o.apk) {
    const dir = path.join(REPO, 'mobile', 'build');
    const all = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.apk')) : [];
    // the shipped artifact is `Stronghold-Protocol-<version>-android.apk`; `app-unsigned.apk` is a build leftover
    const shipped = all.filter((f) => /^Stronghold-Protocol-.*-android\.apk$/.test(f));
    const candidates = (shipped.length ? shipped : all).map((f) => path.join(dir, f));
    if (candidates.length !== 1) throw new Error(`found ${candidates.length} APKs (${all.join(', ')}); pass --apk=<file>`);
    o.apk = candidates[0];
  }
  return o;
}

/** Walk the ZIP central directory (32-bit offsets are enough for our APKs) and return local headers. */
async function readZip(apk) {
  const fh = await fsp.open(apk, 'r');
  const { size } = await fh.stat();
  const tailLen = Math.min(size, 66560);
  const tail = Buffer.alloc(tailLen);
  await fh.read(tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a ZIP/APK');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  const cd = Buffer.alloc(cdSize);
  await fh.read(cd, 0, cdSize, cdOffset);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    const compressedSize = cd.readUInt32LE(p + 20);
    const uncompressedSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, crc, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { fh, size, entries };
}

/** Read and decompress one entry (verifying CRC and size — a corrupt APK entry surfaces here, not on the phone). */
async function readEntry(zip, entry) {
  const header = Buffer.alloc(30);
  await zip.fh.read(header, 0, 30, entry.localOffset);
  if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`bad local header for ${entry.name}`);
  const nameLen = header.readUInt16LE(26);
  const extraLen = header.readUInt16LE(28);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  const raw = Buffer.alloc(entry.compressedSize);
  if (entry.compressedSize) await zip.fh.read(raw, 0, entry.compressedSize, start);
  let data;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8) data = zlib.inflateRawSync(raw);
  else throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
  if (data.length !== entry.uncompressedSize) throw new Error(`${entry.name}: size ${data.length} != ${entry.uncompressedSize}`);
  const crc = zlib.crc32 ? zlib.crc32(data) : require$$0crc32(data);
  if (crc >>> 0 !== entry.crc >>> 0) throw new Error(`${entry.name}: CRC mismatch`);
  return data;
}

// Node 18/20 have no zlib.crc32: a tiny table implementation keeps this tool dependency-free.
function require$$0crc32(buf) {
  const table = require$$0crc32.table || (require$$0crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function request(port, pathname, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers, timeout: 20000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, error: e.message, headers: {}, body: Buffer.alloc(0) }));
    req.end();
  });
}

function wsUpgrade(port) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.request({
      host: '127.0.0.1', port, path: '/ws', timeout: 8000,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        Origin: `http://127.0.0.1:${port}`, Host: `127.0.0.1:${port}`,
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.on('error', () => {}); // the server closes the socket when the child is stopped
      fin(res.statusCode === 101);
    });
    req.on('response', (res) => fin(res.statusCode === 101));
    req.on('timeout', () => { try { req.destroy(); } catch { /* gone */ } fin(false); });
    req.on('error', () => fin(false));
    req.end();
  });
}

/** A Node 18 executable: --node18, $SP_NODE18, or any node18 we can find (a plain `node` is used as a last resort). */
function resolveNode18(explicit) {
  const cands = [explicit, process.env.SP_NODE18, path.join(os.tmpdir(), 'node18-probe', 'node-v18.20.4-win-x64', 'node.exe')].filter(Boolean);
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return null;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const report = { apk: o.apk, startedAt: new Date().toISOString(), checks: [], failures: [] };
  const check = (name, ok, detail = '') => {
    report.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  — ${String(detail).slice(0, 180)}` : ''}`);
    if (!ok) report.failures.push(name);
    return !!ok;
  };

  console.log(`\n▶ verifying ${path.relative(REPO, o.apk)}`);
  const zip = await readZip(o.apk);
  const byName = new Map(zip.entries.map((e) => [e.name, e]));
  report.entries = zip.entries.length;
  report.apkBytes = zip.size;
  check('APK is a valid ZIP with entries', zip.entries.length > 100, `${zip.entries.length} entries, ${(zip.size / 1048576).toFixed(1)} MB`);

  for (const need of ['classes.dex', 'resources.arsc', 'AndroidManifest.xml']) {
    check(`APK contains ${need}`, byName.has(need));
  }
  const libs = zip.entries.filter((e) => /^lib\/[^/]+\/.*\.so$/.test(e.name)).map((e) => e.name).sort();
  check('APK contains the Node runtime + JNI shim', libs.includes('lib/arm64-v8a/libnode.so') && libs.includes('lib/arm64-v8a/libspnode.so'), libs.join(', '));

  // ---- unpack assets/nodejs-project (the exact tree the phone copies into filesDir) ------------------------
  const assets = zip.entries.filter((e) => e.name.startsWith('assets/nodejs-project/'));
  check('assets/nodejs-project is packaged', assets.length > 3000, `${assets.length} entries`);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-apk-'));
  const projectDir = path.join(tmp, 'nodejs-project');
  let bytes = 0;
  const t0 = Date.now();
  for (const e of assets) {
    if (e.name.endsWith('/')) continue;
    const rel = e.name.slice('assets/nodejs-project/'.length);
    const data = await readEntry(zip, e); // verifies size + CRC of every packaged file
    bytes += data.length;
    const dest = path.join(projectDir, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, data);
  }
  await zip.fh.close();
  check('every packaged asset unpacks with a valid CRC', true, `${assets.length} files, ${(bytes / 1048576).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // ---- the checks Node 18 / 22 / 24 in the mobile entry point ---------------------------------------------
  const node18 = resolveNode18(o.node18);
  const exe = node18 || process.execPath;
  const version = (await new Promise((r) => {
    const c = spawn(exe, ['-v'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let s = ''; c.stdout.on('data', (d) => { s += d; }); c.on('exit', () => r(s.trim()));
  })) || '?';
  check(node18 ? `using the Node 18 runtime (${version})` : `Node 18 not found, using ${version} (SP_NODE18=… to set it)`, true, exe);

  const handshakeFile = path.join(tmp, 'handshake.json');
  const child = spawn(exe, [
    path.join(projectDir, 'mobile/node/main.js'),
    '--public', path.join(projectDir, 'public'),
    '--data', path.join(projectDir, 'data'),
    '--handshake', handshakeFile,
    '--host', '127.0.0.1', '--port', '0',
  ], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] });
  let childLog = '';
  child.stdout.on('data', (d) => { childLog += d; });
  child.stderr.on('data', (d) => { childLog += d; });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));

  try {
    let hs = null;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && !hs) {
      try { hs = JSON.parse(await fsp.readFile(handshakeFile, 'utf8')); } catch { await sleep(300); }
      if (child.exitCode !== null && child.exitCode !== 0) break;
    }
    check('the packaged project starts under ' + version, !!hs && hs.ok === true, hs ? `port ${hs.port}, node ${hs.node}, ws ${hs.ws}` : childLog.split('\n').slice(-4).join(' | '));
    if (!hs) throw new Error('no handshake');
    const port = hs.port;

    for (const [p, type] of [['/', 'text/html'], ['/data.js', 'text/javascript'], ['/sim/simdata.js', 'text/javascript'], ['/vendor/pixi.min.js', 'text/javascript'], ['/fonts/fonts.css', 'text/css'], ['/data/chess.json', 'application/json']]) {
      const r = await request(port, p);
      check(`GET ${p}`, r.status === 200 && String(r.headers['content-type'] || '').startsWith(type), `${r.status} ${r.headers['content-type'] || '-'} ${r.body.length} B`);
    }
    const gz = await request(port, '/js/main.js', { headers: { 'Accept-Encoding': 'gzip' } });
    check('gzip works', gz.status === 200 && gz.headers['content-encoding'] === 'gzip');
    const range = await request(port, '/vendor/pixi.min.js', { headers: { Range: 'bytes=0-99' } });
    check('byte ranges work (206)', range.status === 206 && range.body.length === 100, `${range.status} ${range.body.length} B`);
    check('/ws upgrade accepted (101)', await wsUpgrade(port));

    // the client will fetch ~4000 asset URLs; sample them (all of them are already CRC-checked above)
    const index = JSON.parse(await fsp.readFile(path.join(projectDir, 'data', 'assets.json'), 'utf8'));
    const urls = [];
    const walk = (n) => {
      if (typeof n === 'string') { if (/^\/(assets|fonts)\//.test(n)) urls.push(n); }
      else if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === 'object') Object.values(n).forEach(walk);
    };
    walk(index);
    const uniq = [...new Set(urls)];
    const step = Math.max(1, Math.floor(uniq.length / o.sample));
    const sample = uniq.filter((_, i) => i % step === 0).slice(0, o.sample);
    const missing = [];
    for (let i = 0; i < sample.length; i += 8) {
      const batch = sample.slice(i, i + 8);
      const rs = await Promise.all(batch.map((u) => request(port, u)));
      rs.forEach((r, k) => { if (r.status !== 200 || !r.body.length) missing.push(`${batch[k]} (${r.status})`); });
    }
    check(`sampled ${sample.length}/${uniq.length} art URLs → 200`, missing.length === 0, missing.slice(0, 5).join(', '));
    report.artUrls = uniq.length;
    report.artSampled = sample.length;
  } catch (e) {
    check('packaged run', false, e?.message || String(e));
  } finally {
    if (!o.keep) {
      child.kill('SIGTERM');
      const code = await Promise.race([exited, sleep(5000).then(() => 'timeout')]);
      report.childExit = code;
    } else {
      report.keepPid = child.pid;
      report.projectDir = projectDir;
    }
    report.childLog = childLog.slice(-3000);
    if (!o.keep) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  report.passed = report.failures.length === 0;
  report.finishedAt = new Date().toISOString();
  if (o.json) await fsp.writeFile(path.resolve(o.json), JSON.stringify(report, null, 1));
  console.log(`\n${report.passed ? '✔ the packaged APK runs its own server and serves the game' : `✘ ${report.failures.length} failed: ${report.failures.join(', ')}`}\n`);
  process.exit(report.passed ? 0 : 1);
}

main().catch((e) => { console.error(e?.stack || e); process.exit(2); });
