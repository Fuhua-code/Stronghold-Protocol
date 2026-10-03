// mobile/tools/check-server.mjs — boot the mobile entry point (mobile/node/main.js) on this machine and check that it
// really serves the game, the way the Android WebView will use it.
//
//   node mobile/tools/check-server.mjs [--public <dir>] [--data <dir>] [--json <report.json>] [--keep]
//
// Checks, in order:
//   1. the server writes its handshake file and reports ok / a port / a websocket,
//   2. GET /healthz, /, /data.js, /sim/simdata.js, /vendor/pixi.min.js, /fonts/fonts.css (status + content type),
//   3. gzip (Accept-Encoding) and byte-range (206) branches of the static handler,
//   4. a real `Upgrade: websocket` handshake on /ws (101), plus the lobby's first exchange (hello -> welcome),
//   5. every `/assets/...` and `/fonts/...` URL of data/assets.json answers 200 (this is the "art is complete" gate
//      the APK build also enforces statically).
//
// Exit code 0 = everything that must work works. `--json` writes the full report; without `--keep` the child is
// stopped at the end.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const ENTRY = path.join(REPO, 'mobile', 'node', 'main.js');

function parseArgs(argv) {
  const o = { public: null, data: null, json: null, keep: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--public') o.public = argv[++i];
    else if (a === '--data') o.data = argv[++i];
    else if (a === '--json') o.json = argv[++i];
    else if (a === '--keep') o.keep = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One HTTP request; never throws. Returns { status, headers, body, bytes }. */
function request(port, pathname, { headers = {}, method = 'GET', host = '127.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: pathname, method, headers, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body, bytes: body.length, text: body.toString('utf8') });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, error: e.message, headers: {}, body: Buffer.alloc(0), bytes: 0, text: '' }));
    req.end();
  });
}

/** A raw `Upgrade: websocket` handshake; resolves true on 101 (optionally returning the socket for a first exchange). */
function wsHandshake(port, { keepSocket = false } = {}) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/ws',
      timeout: 8000,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        Origin: `http://127.0.0.1:${port}`,
        Host: `127.0.0.1:${port}`,
      },
    });
    const fail = (why) => resolve({ ok: false, why, socket: null });
    req.on('upgrade', (res, socket) => {
      socket.on('error', () => {});
      const accept = res.headers['sec-websocket-accept'];
      const expect = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (res.statusCode !== 101 || accept !== expect) { socket.destroy(); return fail(`status ${res.statusCode}, accept ${accept === expect ? 'ok' : 'mismatch'}`); }
      if (keepSocket) resolve({ ok: true, why: '101', socket });
      else { socket.destroy(); resolve({ ok: true, why: '101', socket: null }); }
    });
    req.on('response', (res) => fail(`no upgrade (${res.statusCode})`));
    req.on('timeout', () => { req.destroy(); fail('timeout'); });
    req.on('error', (e) => fail(e.message));
    req.end();
  });
}

/** Encode a small client->server text frame (masked, as a browser must). */
function wsFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else throw new Error('frame too large for this probe');
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/** Read one unmasked server->client text frame (the lobby's `welcome`). */
function wsReadFrame(socket, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.off('data', onData); resolve(null); }, timeoutMs);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 2) return;
      const len0 = buf[1] & 0x7f;
      let off = 2;
      let len = len0;
      if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      if (buf.length < off + len) return;
      clearTimeout(timer);
      socket.off('data', onData);
      const opcode = buf[0] & 0x0f;
      const payload = buf.subarray(off, off + len);
      if (opcode === 0x9) { resolve({ ping: true, text: '' }); return; } // ping: let the caller continue reading
      resolve({ ping: false, text: payload.toString('utf8') });
    };
    socket.on('data', onData);
  });
}

/** Every `/assets/...` / `/fonts/...` URL in data/assets.json (the same walk as tools/setup.mjs checkAssets). */
function manifestUrls(node, out = []) {
  if (typeof node === 'string') { if (/^\/(assets|fonts)\//.test(node)) out.push(node); }
  else if (Array.isArray(node)) for (const x of node) manifestUrls(x, out);
  else if (node && typeof node === 'object') for (const x of Object.values(node)) manifestUrls(x, out);
  return out;
}

async function waitForHandshake(file, child, timeoutMs = 60000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const raw = await fsp.readFile(file, 'utf8');
      const hs = JSON.parse(raw);
      if (hs && (hs.port || hs.error)) return hs;
    } catch { /* not written yet */ }
    if (child.exitCode !== null) return null;
    await sleep(250);
  }
  return null;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('node mobile/tools/check-server.mjs [--public <dir>] [--data <dir>] [--json <report.json>] [--keep] [--quiet]');
    return 0;
  }
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-mobile-'));
  const handshakeFile = path.join(tmp, 'handshake.json');
  const args = [ENTRY, '--port', '0', '--handshake', handshakeFile];
  if (o.public) args.push('--public', path.resolve(o.public));
  if (o.data) args.push('--data', path.resolve(o.data));

  const report = { node: process.versions.node, entry: ENTRY, startedAt: new Date().toISOString(), checks: [], failures: [] };
  const check = (name, ok, detail = '') => {
    report.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 400) });
    if (!o.quiet) console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  — ${String(detail).slice(0, 200)}` : ''}`);
    if (!ok) report.failures.push(name);
    return !!ok;
  };

  if (!o.quiet) console.log(`\n▶ booting ${path.relative(REPO, ENTRY)} with node ${process.versions.node}`);
  const child = spawn(process.execPath, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  let childOut = '';
  child.stdout.on('data', (c) => { childOut += c; if (!o.quiet) process.stdout.write(String(c).replace(/^/gm, '   │ ')); });
  child.stderr.on('data', (c) => { childOut += c; process.stderr.write(String(c).replace(/^/gm, '   ! ')); });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

  let hs = null;
  try {
    hs = await waitForHandshake(handshakeFile, child);
    check('handshake file written', !!hs, hs ? '' : 'timeout after 60 s');
    if (!hs) throw new Error('no handshake');
    check('handshake ok=true', hs.ok === true, `health ${hs.health}`);
    check('ephemeral port assigned', Number.isInteger(hs.port) && hs.port > 0, `port ${hs.port}`);
    check('websocket ready (self-check)', hs.ws === true, '');
    if (hs.error) throw new Error(hs.error);
    const port = hs.port;
    report.port = port;
    report.handshake = hs;

    // ---- static service -------------------------------------------------------------------------------------
    const pages = [
      ['/', 'text/html'],
      ['/index.html', 'text/html'],
      ['/css/theme.css', 'text/css'],
      ['/js/main.js', 'text/javascript'],
      ['/data.js', 'text/javascript'],
      ['/sim/simdata.js', 'text/javascript'],
      ['/shared/constants.js', 'text/javascript'],
      ['/data/config.json', 'application/json'],
      ['/vendor/pixi.min.js', 'text/javascript'],
      ['/vendor/preact.module.js', 'text/javascript'],
      ['/fonts/fonts.css', 'text/css'],
    ];
    for (const [p, type] of pages) {
      const r = await request(port, p);
      check(`GET ${p} → 200 ${type}`, r.status === 200 && String(r.headers['content-type'] || '').startsWith(type),
        `status ${r.status}, type ${r.headers['content-type'] || '-'}, ${r.bytes} B`);
    }
    const notFound = await request(port, '/nope-does-not-exist.js');
    check('GET /nope → 404', notFound.status === 404, `status ${notFound.status}`);
    const traversal = await request(port, '/../package.json');
    check('path traversal refused', traversal.status === 403 || traversal.status === 404, `status ${traversal.status}`);

    // ---- the connect shell (本地/远程 entry, mobile-connect-0.2) ---------------------------------------------
    const shell = await request(port, '/connect/');
    check('GET /connect/ → the connect shell',
      shell.status === 200 && /id="btn-local"/.test(shell.text) && /id="btn-remote"/.test(shell.text),
      `status ${shell.status}, ${shell.bytes} B`);
    for (const [p, type] of [['/connect/shell.css', 'text/css'], ['/connect/shell.js', 'text/javascript'], ['/connect/util.js', 'text/javascript']]) {
      const r = await request(port, p);
      check(`GET ${p}`, r.status === 200 && String(r.headers['content-type'] || '').startsWith(type),
        `${r.status} ${r.headers['content-type'] || '-'} ${r.bytes} B`);
    }
    // the shell must not shadow the client: a non-localhost entry point keeps serving the game's own page
    const rootPage = await request(port, '/');
    check('GET / is still the game client (the shell is only at /connect/)',
      rootPage.status === 200 && /STRONGHOLD PROTOCOL/.test(rootPage.text) && !/id="btn-local"/.test(rootPage.text),
      `${rootPage.bytes} B`);
    // the handshake the app reads must point a *local* player at the shell (that is how the app picks its entry)
    const connectUrl = hs.connectUrl || '';
    check('handshake advertises the connect entry for local play',
      /^http:\/\/127\.0\.0\.1:\d+\/connect\/$/.test(connectUrl), connectUrl || '(missing connectUrl)');
    const entry = await request(port, '/connect/');
    check('the advertised entry actually serves the shell', entry.status === 200 && /id="btn-local"/.test(entry.text), `status ${entry.status}`);

    const gz = await request(port, '/js/main.js', { headers: { 'Accept-Encoding': 'gzip' } });
    check('gzip branch (content-encoding: gzip)', gz.status === 200 && gz.headers['content-encoding'] === 'gzip',
      `encoding ${gz.headers['content-encoding'] || '-'}`);
    const ranged = await request(port, '/vendor/pixi.min.js', { headers: { Range: 'bytes=0-99' } });
    check('byte-range branch → 206 (100 B)', ranged.status === 206 && ranged.bytes === 100,
      `status ${ranged.status}, ${ranged.bytes} B, ${ranged.headers['content-range'] || '-'}`);

    // ---- websocket protocol ---------------------------------------------------------------------------------
    const hs2 = await wsHandshake(port, { keepSocket: true });
    check('Upgrade /ws → 101 with correct accept', hs2.ok, hs2.why);
    if (hs2.ok && hs2.socket) {
      hs2.socket.write(wsFrame(JSON.stringify({ t: 'hello', rid: 1, name: 'check', v: 1 })));
      let frame = await wsReadFrame(hs2.socket);
      if (frame && frame.ping) frame = await wsReadFrame(hs2.socket); // skip a heartbeat ping
      let msg = null;
      try { msg = frame ? JSON.parse(frame.text) : null; } catch { /* not JSON */ }
      check('hello → welcome', !!(msg && (msg.t === 'welcome' || msg.type === 'welcome')), msg ? `t=${msg.t || msg.type}` : 'no frame');
      report.welcome = msg;
      hs2.socket.destroy();
    }

    // ---- art completeness (the same gate the APK build enforces) ---------------------------------------------
    const manifestPath = path.join(o.data ? path.resolve(o.data) : path.join(REPO, 'data'), 'assets.json');
    let urls = [];
    try { urls = [...new Set(manifestUrls(JSON.parse(await fsp.readFile(manifestPath, 'utf8'))))]; } catch { /* absent */ }
    if (!urls.length) {
      check('data/assets.json lists art URLs', false, `nothing parsed from ${manifestPath}`);
    } else {
      const missing = [];
      const t0 = Date.now();
      // A handful at a time: the server gzips small files on demand and a serial walk of ~4000 files is slow.
      const CONC = 8;
      for (let i = 0; i < urls.length; i += CONC) {
        const batch = urls.slice(i, i + CONC);
        const results = await Promise.all(batch.map((u) => request(port, u)));
        results.forEach((r, k) => { if (r.status !== 200 || r.bytes === 0) missing.push(`${batch[k]} (${r.status})`); });
      }
      check(`all ${urls.length} manifest art URLs → 200`, missing.length === 0,
        missing.length ? `${missing.length} missing, e.g. ${missing.slice(0, 6).join(', ')}` : `${Math.round((Date.now() - t0) / 1000)} s`);
      report.artUrls = urls.length;
      report.artMissing = missing.slice(0, 50);
    }

    // ---- /healthz as the app reads it -----------------------------------------------------------------------
    const health = await request(port, '/healthz');
    let healthJson = null;
    try { healthJson = JSON.parse(health.text); } catch { /* plain text */ }
    check('/healthz JSON with version + app', health.status === 200 && !!healthJson && !!healthJson.version && !!healthJson.app,
      healthJson ? `version ${healthJson.version}, app ${healthJson.app}, uptime ${healthJson.uptimeSec}s` : health.text.slice(0, 80));
  } catch (e) {
    check('verification run', false, e?.message || String(e));
  } finally {
    if (!o.keep) {
      child.kill('SIGTERM');
      const code = await Promise.race([exited, sleep(6000).then(() => 'timeout')]);
      if (!o.quiet) console.log(`   child exit: ${code}`);
    } else if (!o.quiet) {
      console.log(`   --keep: child still running (pid ${child.pid}), handshake ${handshakeFile}`);
    }
    report.childLog = childOut.slice(-4000);
    report.finishedAt = new Date().toISOString();
    report.passed = report.failures.length === 0;
    if (o.json) {
      await fsp.writeFile(path.resolve(o.json), JSON.stringify(report, null, 1));
      if (!o.quiet) console.log(`   report: ${path.resolve(o.json)}`);
    }
    if (!o.quiet) {
      console.log(`\n${report.passed ? '✔ all checks passed' : `✘ ${report.failures.length} failed: ${report.failures.join(', ')}`}\n`);
    }
  }
  process.exit(report.passed ? 0 : 1);
}

main().catch((e) => { console.error(e?.stack || e); process.exit(2); });
