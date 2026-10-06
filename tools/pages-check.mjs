import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { PeerServer } from 'peer';
import puppeteer from 'puppeteer-core';
import { ROOT, DEFAULT_BASE } from './pages-build.mjs';

const failures = [], pageErrors = [], missing = [], requests = [];
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.atlas': 'text/plain' };
const staticServer = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  requests.push(pathname);
  if (!pathname.startsWith(DEFAULT_BASE)) { missing.push(pathname); res.writeHead(404).end(); return; }
  const rel = pathname.slice(DEFAULT_BASE.length) || 'index.html';
  const file = path.resolve(ROOT, 'pages-dist', rel);
  if (!file.startsWith(path.join(ROOT, 'pages-dist') + path.sep)) { res.writeHead(404).end(); return; }
  try { const body = await fs.readFile(file); res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(body); }
  catch { missing.push(pathname); res.writeHead(404).end(); }
});
await new Promise((resolve) => staticServer.listen(0, '127.0.0.1', resolve));
let signalServer;
await new Promise((resolve) => PeerServer({ port: 0, host: '127.0.0.1', path: '/signal' }, (server) => { signalServer = server; resolve(); }));
const signalSockets = new Set();
signalServer.on('connection', (socket) => { signalSockets.add(socket); socket.on('close', () => signalSockets.delete(socket)); });
const url = `http://127.0.0.1:${staticServer.address().port}${DEFAULT_BASE}`;
const signalPort = signalServer.address().port;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'], protocolTimeout: 120000 });
const shots = path.join(ROOT, 'outputs/pages-check');
await fs.mkdir(shots, { recursive: true });
const record = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (error) { failures.push({ name, message: error.stack }); console.error('FAIL', name, error.message); }
};
async function page(name, target = url) {
  const context = await browser.createBrowserContext();
  const p = await context.newPage();
  p.on('pageerror', (e) => { pageErrors.push({ name, message: e.message }); console.error('PAGE ERROR', name, e.message); });
  await p.setViewport({ width: 1280, height: 720 });
  await p.goto(target, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.__SP__, { timeout: 45000 });
  await p.waitForFunction(() => window.__SP__.net.status === 'connected', { timeout: 45000 });
  await p.evaluate((port) => {
    const { runtime, Peer } = window.__SP_PAGES__;
    runtime.peerFactory = (id) => new Peer(id, { host: '127.0.0.1', port, path: '/signal', secure: false, config: { iceServers: [] } });
  }, signalPort);
  return p;
}
async function enter(p, name) {
  await p.type('.title-login input', name);
  await p.click('.title-login button.btn');
  await p.waitForSelector('.lobby-screen');
  await p.waitForFunction(() => window.__SP__.net.status === 'online');
}
let host, guest, solo, failedJoin;
try {
  await record('original title and local core without server endpoints', async () => {
    solo = await page('solo');
    assert.equal(await solo.$eval('.title-login button.btn', (b) => b.textContent.trim()), '开始');
    assert.equal(await solo.$('.entry-split'), null);
    assert.equal(await solo.$('.remote-guide'), null);
    await solo.screenshot({ path: path.join(shots, 'title.png') });
    await enter(solo, 'SoloTest');
  });
  await record('solo room and unchanged match engine start', async () => {
    await solo.evaluate(() => window.__SP__.net.request('room.create', { mode: 'solo', difficulty: 'FUNNY' }));
    await solo.waitForSelector('.room-screen');
    await solo.evaluate(() => window.__SP__.net.request('room.start'));
    await solo.waitForFunction(() => window.__SP__.store.get().match.public?.phase === 'INFO_CHECK');
    await solo.evaluate(() => window.__SP__.net.request('g.infoReady'));
    await solo.waitForFunction(() => window.__SP__.store.get().match.public?.phase === 'BAND_DRAFT');
    await solo.evaluate(() => window.__SP__.net.request('g.band', { bandId: 'band_bldsk' }));
    await solo.waitForFunction(() => ['PREP', 'SP_DRAFT', 'ROUND_START'].includes(window.__SP__.store.get().match.public?.phase), { timeout: 30000 });
    await solo.waitForSelector('canvas', { timeout: 30000 });
    await solo.waitForFunction(() => [...document.querySelectorAll('canvas')].some((c) => c.width > 0 && c.height > 0));
    await solo.screenshot({ path: path.join(shots, 'solo.png') });
  });
  await record('PeerJS create/join, version gate and actual WebRTC messages', async () => {
    host = await page('host');
    await enter(host, 'HostTest');
    await host.evaluate(() => window.__SP__.net.request('room.create', { mode: 'coop', difficulty: 'FUNNY' }));
    const code = await host.evaluate(() => window.__SP__.store.get().room.code);
    assert.match(code, /^[A-Z]{4}$/);
    await host.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__testInvite = text; } } }));
    const inviteButtons = await host.$$('.invite__btns button');
    await inviteButtons[1].click();
    await host.waitForFunction(() => !!window.__testInvite);
    const invite = await host.evaluate(() => window.__testInvite.split(' ')[0]);
    assert.equal(new URL(invite).pathname, DEFAULT_BASE);
    assert.equal(new URL(invite).searchParams.get('room'), code);
    guest = await page('guest', invite);
    await enter(guest, 'GuestTest');
    await host.waitForFunction(() => window.__SP__.store.get().room?.seats.filter((s) => s && !s.isBot).length === 2);
    assert.equal(await guest.evaluate(() => window.__SP__.store.get().room.code), code);
    const wrongVersion = await guest.evaluate(async () => {
      const { Peer, metadata } = window.__SP_PAGES__;
      const existing = window.__SP__.net.ws.peer;
      return await new Promise((resolve, reject) => {
        const peer = new Peer(undefined, existing.options);
        const timer = setTimeout(() => { peer.destroy(); reject(new Error('Version rejection timeout')); }, 10000);
        peer.on('error', reject);
        peer.on('open', () => {
          const target = window.__SP__.net.ws.channel.peer;
          const c = peer.connect(target, { serialization: 'json', metadata: { ...metadata, app: 'incompatible' } });
          c.on('data', (message) => { if (message.kind === 'reject') { clearTimeout(timer); peer.destroy(); resolve(true); } });
        });
      });
    });
    assert.equal(wrongVersion, true);
    await guest.evaluate(() => window.__SP__.net.request('room.ready', { ready: true }));
    await host.screenshot({ path: path.join(shots, 'alliance.png') });
    await host.evaluate(() => window.__SP__.net.request('room.start'));
    await guest.waitForFunction(() => window.__SP__.store.get().match.public?.phase === 'INFO_CHECK');
    assert.equal(await host.evaluate(() => window.__SP__.store.get().match.public.phase), 'INFO_CHECK');
  });
  await record('guest reconnect resumes room through original token', async () => {
    const id = await guest.evaluate(() => window.__SP__.net.playerId);
    await guest.evaluate(() => window.__SP__.net.reconnectNow());
    await guest.waitForFunction(() => window.__SP__.net.status === 'online');
    assert.equal(await guest.evaluate(() => window.__SP__.net.playerId), id);
  });
  await record('unavailable PeerJS room does not appear as server shutdown or disturb a live room', async () => {
    failedJoin = await page('failed join');
    await enter(failedJoin, 'FailedJoin');
    await failedJoin.evaluate(() => {
      window.__testRoomClosed = 0;
      window.__SP__.net.on('room.closed', () => { window.__testRoomClosed++; });
    });
    const outcome = await failedJoin.evaluate(async () => {
      try {
        await window.__SP__.net.request('room.join', { code: 'ZZZZ' });
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error.message };
      }
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /没有找到.*在线房主/);
    assert.equal(await failedJoin.evaluate(() => window.__testRoomClosed), 0);
    assert.equal(await failedJoin.evaluate(() => window.__SP_PAGES__.runtime.mode), 'local');
    assert.equal(await host.evaluate(() => window.__SP__.store.get().room?.code), await host.evaluate(() => window.__SP_PAGES__.runtime.code));
  });
  await record('complete assets and browser simulation import at project subpath', async () => {
    const result = await solo.evaluate(async () => {
      const base = new URL('.', location.href).href;
      const sim = await import(new URL('sim/spec.js', base));
      const simdata = await import(new URL('sim/simdata.js', base));
      await import(new URL('sim/content/support/index.js', base));
      const local = await (await fetch(new URL('data/local-assets.json', base))).json();
      return { sim: typeof sim.createBattleFromSpec, injected: typeof simdata.setSimData, local: !!local };
    });
    assert.deepEqual(result, { sim: 'function', injected: 'function', local: true });
    assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
    assert.equal(missing.length, 0, JSON.stringify(missing.slice(0, 10)));
    assert.equal(requests.some((s) => /\/(?:healthz|ws|sp-remote|connect\/probe)$/.test(s)), false);
  });
  await record('closing the host ends its room without host migration', async () => {
    await host.close();
    await guest.waitForFunction(() => !window.__SP__.store.get().room && window.__SP_PAGES__.runtime.mode === 'local', { timeout: 45000 });
    await guest.waitForFunction(() => window.__SP__.net.status === 'online', { timeout: 30000 });
    assert.equal(await guest.evaluate(() => window.__SP_PAGES__.runtime.host), null);
  });
} finally {
  await fs.writeFile(path.join(ROOT, 'outputs/pages-check.json'), JSON.stringify({ url, failures, pageErrors, missing, requests: requests.length, completedAt: new Date().toISOString() }, null, 2));
  await browser.close();
  await new Promise((resolve) => staticServer.close(resolve));
  for (const socket of signalSockets) socket.destroy();
  await new Promise((resolve) => signalServer.close(resolve));
}
process.exit(failures.length ? 1 : 0);
