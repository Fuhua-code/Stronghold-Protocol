// mobile/node/main.js — Android entry point of the Node half (mobile/** only; no game source is modified).
//
// The APK ships this file plus the repository's `server/`, `shared/`, `data/` and the client's `public/` inside
// `assets/nodejs-project/`, which Android extracts into the app's native library directory
// (`context.getApplicationInfo().nativeLibraryDir`), a plain read-only directory the Node runtime can serve from
// directly — the art is not copied a second time into internal storage.
//
//   node main.js --public <dir> [--data <dir>] [--handshake <file>] [--host <addr>] [--port <n>]
//
//   1. Pick the game's `public/` directory: the first candidate that holds an `index.html` (Android passes the
//      extracted assets directory; a desktop run of this file falls back to the directory next to it).
//   2. server/index.js startServer() on an EPHEMERAL port by default (`--port 0`): Android reserves low ports and
//      anything in use would fail the boot; loopback is the default and the Android UI can explicitly opt into LAN.
//   3. Wait until the server really answers (`/healthz` through ordinary HTTP, plus one WebSocket upgrade, which is
//      what the game itself needs) before writing the handshake file, so the WebView is never pointed at a server
//      that cannot serve yet.
//   4. Write `handshake.json` (port, LAN URLs, version) — the Android activity polls it for the address to load —
//      then print the same information, which the JNI shim forwards to logcat.
//
// Everything else is the unmodified game server: the HTTP static service (public/, data/, the /sim/ browser
// simulation, the /data.js stand-in), the `/ws` WebSocket protocol, rooms, reconnect and solo resume windows.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startServer, lanUrls } from '../../server/index.js';
import { APP_VERSION, PROTOCOL_VERSION } from '../../shared/constants.js';

/** This file's directory (…/nodejs-project/mobile/node on Android, …/mobile/node in the repository). */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Every line is prefixed (logcat has no log levels here) and flushed, so `adb logcat` shows progress live. */
const say = (...a) => { console.log('[mobile]', ...a); };

/** Parse `--key value` / `--key=value` (unknown options are ignored, the last occurrence wins). */
function parseArgs(argv) {
  const o = { public: null, data: null, handshake: null, host: process.env.HOST || '127.0.0.1', port: process.env.PORT ?? '0' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(0, eq) : a;
    const inline = eq >= 0 ? a.slice(eq + 1) : null;
    const val = () => (inline != null ? inline : argv[++i]);
    if (key === '--public') o.public = val();
    else if (key === '--data') o.data = val();
    else if (key === '--handshake') o.handshake = val();
    else if (key === '--host') o.host = val();
    else if (key === '--port' || key === '-p') o.port = val();
  }
  const n = Number(o.port);
  o.port = Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 0;
  return o;
}

const hasIndex = (dir) => { try { return !!dir && fs.existsSync(path.join(dir, 'index.html')); } catch { return false; } };

/** First existing directory out of the candidates (absolute paths only). */
function firstDir(cands) {
  for (const c of cands) if (c && hasIndex(c)) return c;
  return null;
}

/**
 * Candidate client roots, most specific first:
 *   1. the explicit `--public` (Android: `<nativeLibraryDir>/public`, where the APK's assets were extracted),
 *   2. `<project>/public` — the layout of the prepared `nodejs-project` (…/mobile/node → …/public),
 *   3. `<project>/../public` — a desktop run straight out of the repository (…/mobile/node → …/Stronghold-Protocol/public).
 */
function resolvePublicDir(explicit) {
  return firstDir([
    explicit,
    path.join(HERE, '..', 'public'),
    path.join(HERE, '..', '..', 'public'),
  ]);
}

/** `dir` when it holds the generated data, else null (server/data.js needs `chess.json` to be usable). */
const isDataDir = (dir) => { try { return !!dir && fs.statSync(path.join(dir, 'chess.json')).isFile(); } catch { return false; } };

/**
 * The prepared project root: the directory that holds `server/index.js` and the generated `data/`. Found by walking
 * up from this file instead of assuming a fixed depth, so the layout works both in the repository
 * (`…/Stronghold-Protocol/mobile/node/main.js` → `…/Stronghold-Protocol`) and inside the APK
 * (`…/nodejs-project/mobile/node/main.js` → `…/nodejs-project`).
 */
function findProjectRoot() {
  let dir = HERE;
  for (let i = 0; i < 4; i++) {
    dir = path.dirname(dir);
    try {
      if (fs.existsSync(path.join(dir, 'server', 'index.js')) && isDataDir(path.join(dir, 'data'))) return dir;
    } catch { /* keep walking */ }
  }
  return path.join(HERE, '..', '..');
}

function writeHandshake(file, payload) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 1));
    fs.renameSync(tmp, file); // atomic: the activity never reads a half-written file
    return true;
  } catch (e) {
    say('could not write the handshake file', file, e?.message ?? e);
    return false;
  }
}

/** GET /healthz over ordinary HTTP (never throws). */
function httpHealthz(port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
  });
}

/** A real WebSocket upgrade against /ws — the same path the game client uses (never throws). */
function wsUpgradeCheck(port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/ws',
      timeout: timeoutMs,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        Origin: `http://127.0.0.1:${port}`,
        Host: `127.0.0.1:${port}`,
      },
    });
    // On success the socket is handed over to the 101 response; there is nothing left to destroy.
    const done = (ok) => { if (settled) return; settled = true; resolve(ok); };
    req.on('upgrade', (res) => done(res.statusCode === 101));
    req.on('response', (res) => done(res.statusCode === 101));
    req.on('timeout', () => { try { req.destroy(); } catch { /* gone */ } done(false); });
    req.on('error', () => done(false));
    req.end();
  });
}

/** The phone's own addresses, best effort — only for display (friends type them, or use the room link). */
function networkAddresses() {
  const out = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list ?? []) {
        if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
      }
    }
  } catch { /* no interfaces: the LAN line stays empty */ }
  return out;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const publicDir = resolvePublicDir(o.public);
  if (!publicDir) {
    console.error(`[mobile] no client directory with index.html found (tried --public ${o.public ?? '(none)'}).`);
    process.exit(1);
  }
  const root = findProjectRoot();
  const dataDir = isDataDir(o.data) ? o.data : path.join(root, 'data');
  say(`public=${publicDir}`);
  say(`data=${dataDir}${isDataDir(dataDir) ? '' : ' (not found: running without generated game data)'}`);

  const srv = await startServer({ port: o.port, host: o.host, publicDir, dataDir, quiet: true });

  // Ready means it answers, not just that it listens.
  const health = await httpHealthz(srv.port);
  const ws = await wsUpgradeCheck(srv.port);
  const lan = lanUrls(srv.port);

  const payload = {
    ok: !!(health && health.status === 200),
    port: srv.port,
    host: srv.host,
    url: `http://127.0.0.1:${srv.port}/`,
    lan,
    ws,
    health: health ? health.status : 0,
    addresses: networkAddresses(),
    version: APP_VERSION,
    protocol: PROTOCOL_VERSION,
    node: process.versions.node,
    startedAt: new Date().toISOString(),
  };
  say(`listening on ${srv.host}:${srv.port} (healthz ${payload.health}, websocket ${ws ? 'ok' : 'FAILED'})`);
  for (const u of lan) say(`LAN: ${u}`);
  if (o.handshake) writeHandshake(o.handshake, payload);
  if (!payload.ok || !ws) say('WARNING: the server did not answer its own health check; the app will report an error.');

  // The app ends the process with the activity; keep the shutdown path of server/index.js (rooms get room.closed).
  let stopping = false;
  const stop = (signal) => {
    if (stopping) { process.exit(1); }
    stopping = true;
    say(`${signal}: shutting down`);
    setTimeout(() => process.exit(0), 3000).unref();
    srv.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('unhandledRejection', (e) => console.error('[mobile] unhandled rejection', e));
  process.on('uncaughtException', (e) => console.error('[mobile] uncaught exception', e));
}

main().catch((e) => {
  console.error('[mobile] failed to start', e?.stack || e);
  const file = parseArgs(process.argv.slice(2)).handshake;
  if (file) writeHandshake(file, { ok: false, error: String(e?.message || e) });
  process.exit(1);
});
