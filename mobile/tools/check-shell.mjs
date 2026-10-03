#!/usr/bin/env node
// mobile/tools/check-shell.mjs — verify the connect shell (本地 / 远程) in a real browser.
//
//   node mobile/tools/check-shell.mjs [--chrome <exe>] [--json <file>] [--keep]
//
// The shell is the page the APK opens for a local entry (mobile/shell/, served at /connect/). It is easy to break
// in ways a static check cannot see — a full-screen overlay swallowing clicks, a mode that flips back while typing,
// the game client having nowhere to mount — so this drives the real page in headless Chrome and asserts the
// behaviour the spec asks for:
//
//   1. the 开始 button is split into 本地 (mint) and 远程 (white), both outlined;
//   2. typing a callsign grows 本地 to ~2/3, hides 远程's label and fills 本地 solid mint;
//   3. tapping 远程 grows it to ~2/3, hides 本地's label, morphs 博士代号 → 链接地址, swaps the micro label for
//      局域网/公网链接, swaps the person icon for a chain link and fills the button solid white;
//   4. an unusable link opens the 请输入有效链接 notice;
//   5. going back to 本地 restores the callsign console, and a second tap enters the game client;
//   6. `/` still serves the untouched game client (the shell is only reachable at /connect/).
//
// Chrome/Edge is auto-detected (or CHROME_PATH / --chrome); puppeteer-core comes from devDependencies. Exits 1 on
// the first failed check. The server it starts is a real `mobile/node/main.js`, so this also covers that mount.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const ENTRY = path.join(REPO, 'mobile', 'node', 'main.js');

function parseArgs(argv) {
  const o = { chrome: process.env.CHROME_PATH || null, json: null, keep: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--chrome') o.chrome = argv[++i];
    else if (a === '--json') o.json = argv[++i];
    else if (a === '--keep') o.keep = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--help' || a === '-h') { console.log('node mobile/tools/check-shell.mjs [--chrome <exe>] [--json <file>] [--keep]'); process.exit(0); }
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

export function findChrome(explicit) {
  const candidates = [
    explicit,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  return null;
}

const o = parseArgs(process.argv.slice(2));
const report = { startedAt: new Date().toISOString(), checks: [], failures: [] };
const check = (name, ok, detail = '') => {
  report.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  if (!o.quiet) console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  — ${String(detail).slice(0, 180)}` : ''}`);
  if (!ok) report.failures.push(name);
  return !!ok;
};

const chrome = findChrome(o.chrome);
if (!chrome) {
  console.error('no Chrome/Edge found; pass --chrome <exe> or set CHROME_PATH');
  process.exit(2);
}
const puppeteer = (await import('puppeteer-core')).default;

// ---- start the real mobile server (its own mount of /connect/) --------------------------------------
const child = spawn(process.execPath, [ENTRY, '--port', '0'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (c) => { out += c; });
child.stderr.on('data', (c) => { out += c; });
const port = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 40000);
  const tick = setInterval(() => {
    const m = /listening on [^:]+:(\d+)/.exec(out);
    if (m) { clearInterval(tick); clearTimeout(t); resolve(Number(m[1])); }
  }, 150);
});
if (!o.quiet) console.log(`\n▶ connect shell on http://127.0.0.1:${port}/connect/ (${path.relative(REPO, chrome)})\n`);

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // `no-cache` still lets a heuristic cache win on a second run: always fetch fresh
  await page.setExtraHTTPHeaders({ 'Cache-Control': 'no-cache' });
  await page.goto(`http://127.0.0.1:${port}/connect/`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#btn-local', { timeout: 15000 });
  await page.waitForFunction(() => !!window.__spShell, { timeout: 5000 });

  const state = () => page.evaluate(() => {
    const visible = (el) => {
      let opacity = 1;
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
      return opacity > 0.5;
    };
    const w = (el) => el.getBoundingClientRect().width;
    const local = document.getElementById('btn-local');
    const remote = document.getElementById('btn-remote');
    const total = w(local) + w(remote);
    const pieces = (sel) => [...document.querySelectorAll(sel)].filter(visible).map((p) => p.textContent).join('');
    return {
      shell: window.__spShell,
      label: pieces('.cnode-label__piece'),
      micro: document.querySelector('.cnode-micro').textContent,
      localPct: Math.round((100 * w(local)) / total),
      remotePct: Math.round((100 * w(remote)) / total),
      localTextOpacity: Number(getComputedStyle(local.querySelector('.cnode-btn__text')).opacity),
      remoteTextOpacity: Number(getComputedStyle(remote.querySelector('.cnode-btn__text')).opacity),
      localBg: getComputedStyle(local).backgroundColor,
      remoteBg: getComputedStyle(remote).backgroundColor,
      userOpacity: Number(getComputedStyle(document.querySelector('.cnode-ico__user')).opacity),
      linkOpacity: Number(getComputedStyle(document.querySelector('.cnode-ico__link')).opacity),
      placeholder: document.getElementById('cnode-input').placeholder,
      dialog: !document.getElementById('dialog').hasAttribute('hidden'),
      dialogTitle: document.getElementById('dialog-title').textContent,
    };
  });
  const setField = (v) => page.evaluate((val) => {
    const i = document.getElementById('cnode-input');
    i.value = val;
    i.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);
  const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

  // ---- 1. the split button ---------------------------------------------------------------------------
  const s0 = await state();
  check('初始为两个等宽按钮：本地（绿）/ 远程（白）',
    s0.localPct === 50 && s0.remotePct === 50 && s0.label === '博士代号' && s0.micro === 'CALLSIGN'
    && s0.localBg === 'rgba(0, 0, 0, 0)' && s0.remoteBg === 'rgba(0, 0, 0, 0)',
    `${s0.localPct}/${s0.remotePct}, label=${s0.label}, ${s0.micro}`);

  // ---- 2. typing a callsign = choosing 本地 ----------------------------------------------------------
  await page.type('#cnode-input', '312');
  await settle();
  const s1 = await state();
  check('输入代号 → 本地扩大到约 2/3、远程字样隐去、本地变实心绿',
    s1.localPct >= 60 && s1.remotePct <= 40 && s1.remoteTextOpacity === 0 && s1.localTextOpacity === 1
    && s1.localBg === 'rgb(78, 216, 175)',
    `本地 ${s1.localPct}%, 本地底色 ${s1.localBg}, 远程字样 ${s1.remoteTextOpacity}`);

  // ---- 3. 远程: grow, morph the label, swap the icon, fill white -------------------------------------
  await setField('');
  await page.click('#btn-remote');
  await settle(1100);
  const s2 = await state();
  check('点「远程」→ 远程扩大到约 2/3、本地字样隐去、变实心白',
    s2.remotePct >= 60 && s2.localPct <= 40 && s2.localTextOpacity === 0 && s2.remoteTextOpacity === 1
    && s2.remoteBg === 'rgb(255, 255, 255)',
    `远程 ${s2.remotePct}%, 远程底色 ${s2.remoteBg}, 本地字样 ${s2.localTextOpacity}`);
  check('标签「博士代号」→「链接地址」，英文改为「局域网/公网链接」',
    s2.label === '链接地址' && s2.micro === '局域网/公网链接', `${s2.label} / ${s2.micro}`);
  check('输入框图标：绿色人像 → 绿色锁链', s2.userOpacity === 0 && s2.linkOpacity === 1,
    `人像 ${s2.userOpacity}, 锁链 ${s2.linkOpacity}`);
  check('输入框切换为链接输入', /链接/.test(s2.placeholder), s2.placeholder);

  // ---- 4. an unusable link ---------------------------------------------------------------------------
  await setField('not a link');
  await page.click('#btn-remote');
  await settle(1000);
  const s3 = await state();
  check('无效链接 → 提示框「请输入有效链接」', s3.dialog && s3.dialogTitle === '请输入有效链接',
    `dialog=${s3.dialog}, title=${s3.dialogTitle}`);
  await page.evaluate(() => document.querySelector('#dialog-acts button')?.click());
  await settle(300);

  // ---- 5. back to 本地, then enter the game ----------------------------------------------------------
  await setField('');
  await page.click('#btn-local');
  await settle(1000);
  const s4 = await state();
  check('点回「本地」→ 恢复代号界面（实心绿）',
    s4.label === '博士代号' && s4.micro === 'CALLSIGN' && s4.userOpacity === 1 && s4.linkOpacity === 0
    && s4.localBg === 'rgb(89, 244, 202)',
    `${s4.label} / ${s4.micro} / ${s4.localBg}`);

  await setField('312');
  await settle(300);
  await page.click('#btn-local');
  await page.waitForFunction(() => document.getElementById('connect').style.display === 'none', { timeout: 15000 })
    .catch(() => {});
  await settle(2500);
  const entered = await page.evaluate(() => ({
    shellHidden: document.getElementById('connect').style.display === 'none',
    screens: [...document.querySelectorAll('main, [class*=screen]')].map((e) => e.className.split(' ')[0]).slice(0, 6),
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 80),
  }));
  check('再次点「本地」（有代号）→ 进入游戏客户端',
    entered.shellHidden && /lobby|title/.test(entered.screens.join(' ')) && entered.text.length > 10,
    entered.screens.join(','));

  // ---- 6. the shell must not shadow the client -------------------------------------------------------
  const rootPage = await browser.newPage();
  const res = await rootPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  const rootHtml = await rootPage.content();
  check('GET / 仍是未修改的游戏客户端（外壳只在 /connect/）',
    res.status() === 200 && /STRONGHOLD PROTOCOL/.test(rootHtml) && !/id="btn-local"/.test(rootHtml),
    `status ${res.status()}`);

  check('页面无脚本错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  if (!o.keep) child.kill();
}

report.passed = report.failures.length === 0;
report.finishedAt = new Date().toISOString();
if (o.json) await fsp.writeFile(path.resolve(o.json), JSON.stringify(report, null, 1));
console.log(`\n${report.passed ? '✔ the connect shell behaves as specified' : `✘ ${report.failures.length} failed: ${report.failures.join(', ')}`}\n`);
if (o.keep) console.log(`server left running on http://127.0.0.1:${port}/connect/ (pid ${child.pid})\n`);
process.exit(report.passed ? 0 : 1);
