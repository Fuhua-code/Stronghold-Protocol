#!/usr/bin/env node
// mobile/tools/verify-client.mjs — load the *real* client (the one packaged into the APK, as unpacked on the phone)
// in a headless Chromium and prove that a player can get into a game: the page boots, the WebSocket connects, a
// solo simulation starts, and the prep screen renders with its shop and board.
//
//   node mobile/tools/verify-client.mjs [--public <dir>] [--chrome <exe>] [--shots <dir>] [--keep] [--json <file>]
//
// `--public` defaults to the prepared `mobile/build/nodejs-project/public` when it exists, else the repository's
// `public/`. Chrome is auto-detected (Chrome, then Edge); puppeteer-core comes from the repository's devDependencies
// (`npm install`). The assertions on the client are the same kind the project's own SP_E2E suites make: no console
// error, no page error, no failed request.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const o = { public: null, chrome: process.env.CHROME_PATH || null, shots: null, keep: false, json: null, headed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--public') o.public = argv[++i];
    else if (a === '--chrome') o.chrome = argv[++i];
    else if (a === '--shots') o.shots = argv[++i];
    else if (a === '--json') o.json = argv[++i];
    else if (a === '--keep') o.keep = true;
    else if (a === '--headed') o.headed = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

function findChrome(explicit) {
  const cands = [
    explicit,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return cands.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
}

async function waitHandshake(file, child, timeoutMs = 90000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const hs = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (hs && (hs.port || hs.error)) return hs;
    } catch { /* not yet */ }
    if (child.exitCode !== null) return null;
    await sleep(250);
  }
  return null;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const publicDir = o.public
    ? path.resolve(o.public)
    : (fs.existsSync(path.join(REPO, 'mobile', 'build', 'nodejs-project', 'public', 'index.html'))
      ? path.join(REPO, 'mobile', 'build', 'nodejs-project', 'public')
      : path.join(REPO, 'public'));
  const dataDir = path.resolve(publicDir, '..', 'data');
  const chrome = findChrome(o.chrome);
  const report = { publicDir, chrome, startedAt: new Date().toISOString(), checks: [], failures: [] };
  const check = (name, ok, detail = '') => {
    report.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  — ${String(detail).slice(0, 200)}` : ''}`);
    if (!ok) report.failures.push(name);
    return !!ok;
  };
  if (!chrome) { console.error('no Chrome/Edge found (use --chrome <path> or CHROME_PATH)'); return 2; }

  console.log(`\n▶ client check: ${path.relative(REPO, publicDir)}  ·  ${path.basename(chrome)}`);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-client-'));
  const handshakeFile = path.join(tmp, 'handshake.json');
  const child = spawn(process.execPath, [
    path.join(REPO, 'mobile', 'node', 'main.js'),
    '--public', publicDir, '--data', dataDir, '--handshake', handshakeFile, '--host', '127.0.0.1', '--port', '0',
  ], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  let childLog = '';
  child.stdout.on('data', (d) => { childLog += d; });
  child.stderr.on('data', (d) => { childLog += d; });

  let browser = null;
  try {
    const hs = await waitHandshake(handshakeFile, child);
    if (!check('mobile server started', !!hs && hs.port > 0, hs ? `port ${hs.port}, ws ${hs.ws}` : childLog.split('\n').slice(-3).join(' | '))) throw new Error('no server');
    const base = `http://127.0.0.1:${hs.port}`;
    report.base = base;

    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: chrome, headless: !o.headed, args: ['--no-sandbox', '--disable-gpu', '--mute-audio'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    const problems = [];
    let assets = 0;
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));
    page.on('request', (r) => { if (/^\/(js|css|vendor|data|assets|fonts|sim|shared)\//.test(new URL(r.url()).pathname)) assets++; });
    page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('fonts.googleapis')) problems.push(`http ${r.status()}: ${r.url().slice(0, 120)}`); });

    await page.goto(`${base}/`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => !!document.querySelector('.screen:not(.gload)'), { timeout: 30000 });
    check('client booted (a screen mounted)', true, await page.evaluate(() => document.querySelector('.screen').className));
    const title = await page.evaluate(() => document.querySelector('.screen')?.textContent?.replace(/\s+/g, ' ').slice(0, 90) || '');
    check('title screen rendered', /代号|模拟|STRONGHOLD|卫戍/i.test(title), title);
    check('the client loaded its own assets over the local server', assets > 20, `${assets} requests to /js, /css, /vendor, /data, /assets or /fonts`);

    // Playing the first moves is the real test of the mobile server: the client talks to it over the WebSocket
    // protocol (the same path co-op uses) and the server answers with the game state.
    const shot = async (name) => {
      if (!o.shots) return;
      await fsp.mkdir(path.resolve(o.shots), { recursive: true });
      await page.screenshot({ path: path.join(path.resolve(o.shots), `${name}.png`) });
    };
    const clickText = (re) => page.evaluate((src) => {
      const rx = new RegExp(src);
      const el = [...document.querySelectorAll('button, [role="button"], .btn, [class*="btn"], [class*="card"], li, div[tabindex]')]
        .filter((b) => rx.test((b.textContent || '').trim()) && !b.disabled && b.offsetParent !== null)
        .pop();
      if (!el) return null;
      el.click();
      return (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    }, re.source);
    const bodyText = () => page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160));
    const waitFor = (re, timeout = 20000) => page.waitForFunction((src) => new RegExp(src).test(document.body.innerText || ''), { timeout }, re.source).then(() => true, () => false);

    // The client walks title → lobby (confirm the nickname) → solo simulation → briefing → prep.
    const nameInput = await page.$('input[type="text"], input:not([type])');
    if (nameInput) {
      await nameInput.click();
      await page.keyboard.type('手机测试');
    }
    // title screen: confirm the callsign (the button is labelled 开始 / 确认进入 …)
    const entered = await clickText(/^(开始|进入|确认|开始模拟)$/);
    check('entered the lobby from the title screen', !!entered, entered || 'no start button on the title screen');
    await sleep(800);

    const solo = await page.evaluate(() => {
      // the mode cards are buttons carrying 独立模拟 / 同盟模拟
      const el = [...document.querySelectorAll('button')].filter((b) => /独立模拟/.test(b.textContent || '') && b.offsetParent !== null).pop();
      if (!el) return null;
      el.click();
      return (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 20);
    });
    check('selected solo simulation', !!solo, solo || 'no button with 独立模拟');
    await sleep(500);
    const start = await clickText(/开始独立模拟|开始模拟|创建同盟/);
    check('pressed the start button', !!start, start || 'none');
    // solo creates the room straight away: the lobby shows the seat and waits for 开始模拟
    const started = await waitFor(/待命中/, 15000);
    check('solo room created (seat shown, 待命中)', started, started ? '' : await bodyText());
    await shot('lobby');
    const go = await clickText(/开始模拟/);
    check('pressed 开始模拟', !!go, go || 'none');
    let phase = '';
    if (await waitFor(/确认本局信息/, 25000)) {
      phase = 'briefing';
      const confirm = await clickText(/准备就绪/);
      check('passed the briefing screen (准备就绪)', !!confirm, confirm || 'no 准备就绪 button');
    } else {
      check('briefing screen reached', false, await bodyText());
    }
    // a co-op match drafts a band first; solo goes straight to the prep phase — click through if it does
    if (await waitFor(/选择策略/, 6000)) {
      phase += '/draft';
      await clickText(/选择|确定|就绪/);
      await sleep(800);
    }
    const inMatch = await waitFor(/休整期|招募|刷新|整备区|调度中心|回合/, 30000);
    check('a match is running (prep screen reached)', inMatch, inMatch ? phase : await bodyText());
    await sleep(1200);
    await shot('match');
    check('no console / page / request errors', problems.length === 0, problems.slice(0, 4).join(' | '));

    if (o.shots) {
      await shot('title');
      report.shots = path.resolve(o.shots);
    }
  } catch (e) {
    check('client check', false, e?.message || String(e));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!o.keep) child.kill('SIGTERM');
    report.childLog = childLog.slice(-1500);
    if (!o.keep) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  report.passed = report.failures.length === 0;
  if (o.json) await fsp.writeFile(path.resolve(o.json), JSON.stringify(report, null, 1));
  console.log(`\n${report.passed ? '✔ the packaged client boots and renders against the mobile server' : `✘ ${report.failures.length} failed: ${report.failures.join(', ')}`}\n`);
  process.exit(report.passed ? 0 : 1);
}

main().catch((e) => { console.error(e?.stack || e); process.exit(2); });
