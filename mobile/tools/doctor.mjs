#!/usr/bin/env node
// mobile/tools/doctor.mjs — "what do I need before I can build the APK, and what do I have?"
//
//   node mobile/tools/doctor.mjs        (or: npm run apk:doctor)
//
// It reports, in this order:
//   1. the host (OS, architecture, node version, free disk in the workspace and in the toolchain directory);
//   2. the repository: dependencies, vendored client libraries, the game art, the server dependency `ws`;
//   3. the build inputs: the Termux packages the runtime is assembled from (with their download URLs and sizes) and
//      the host tools (`tar`, `xz`) used to unpack them;
//   4. the Android toolchain: JDK, SDK build-tools, platform — and what the first build would download;
//   5. an attached Android device (adb), if there is one, so `adb install` can be run right after the build.
//
// Every line is a fact, never a guess; the summary lists the exact commands to run next. Exit code 1 only when
// something the packager needs is missing and cannot be downloaded by it.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const BUILD = path.join(REPO, 'mobile', 'build');

// ---------------------------------------------------------------------------------------------------
// helpers (kept local so the doctor never depends on the packager's internals)
// ---------------------------------------------------------------------------------------------------

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  return { ok: r.status === 0, status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
};

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const findings = [];
const line = (state, label, detail = '') => {
  const mark = state === 'ok' ? c.ok('  ✔') : state === 'warn' ? c.warn('  !') : state === 'skip' ? c.dim('  –') : c.bad('  ✘');
  console.log(`${mark} ${label}${detail ? c.dim(`  ${detail}`) : ''}`);
  if (state === 'bad') findings.push({ label, detail });
};
const section = (title) => console.log(`\n${c.bold(title)}`);

/** Free bytes on the volume that holds `p` (Windows: the drive; elsewhere the filesystem via statfs). */
async function freeBytes(p) {
  try {
    const st = await fsp.statfs(p);
    return st.bsize * st.bavail;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// 1. host
// ---------------------------------------------------------------------------------------------------

console.log(`\n${c.bold('卫戍协议：盟约 · Android packager — doctor')}   ${c.dim(REPO)}`);

section('1. 主机 / host');
{
  const node = process.versions.node;
  const major = Number(node.split('.')[0]);
  const pkg = readJson(path.join(REPO, 'package.json'));
  const required = Number(String(pkg?.engines?.node || '>=22').replace(/[^\d]/g, '')) || 22;
  line(major >= required ? 'ok' : 'bad', `Node.js ${node}`, major >= required ? `满足 >= ${required}` : `需要 ${required} 或更高`);
  line('ok', `${os.platform()} ${os.release()} · ${os.arch()} · ${os.cpus().length} 核 · 内存 ${(os.totalmem() / 1073741824).toFixed(1)} GB`);
  const free = await freeBytes(REPO);
  if (free != null) {
    const enough = free > 4 * 1073741824;
    line(enough ? 'ok' : 'warn', `可用磁盘 ${(free / 1073741824).toFixed(1)} GB`, enough ? '' : '构建 + 工具链约需 3–4 GB');
  }
}

// ---------------------------------------------------------------------------------------------------
// 2. repository
// ---------------------------------------------------------------------------------------------------

section('2. 仓库准备 / repository');
const toolchainCandidates = [
  process.env.SP_TOOLCHAIN,
  path.join(path.dirname(REPO), '.toolchain'),
  path.join(REPO, '.toolchain'),
].filter(Boolean);
const toolchain = toolchainCandidates.find((d) => exists(d)) || path.join(path.dirname(REPO), '.toolchain');

{
  const nodeModules = exists(path.join(REPO, 'node_modules'));
  line(nodeModules ? 'ok' : 'warn', 'node_modules', nodeModules ? '' : '缺少 → 首次 `npm run apk` 会自动 `npm install`');
  const vendor = ['pixi.min.js', 'pixi-spine.js', 'preact.module.js', 'hooks.module.js', 'htm.module.js']
    .filter((f) => !exists(path.join(REPO, 'public', 'vendor', f)));
  line(vendor.length === 0 ? 'ok' : 'warn', 'public/vendor（前端库）', vendor.length ? `缺少 ${vendor.join(', ')} → npm install` : '');

  const ws = path.join(REPO, 'node_modules', 'ws');
  const wsPkg = exists(ws) ? readJson(path.join(ws, 'package.json')) : null;
  if (wsPkg) {
    const missing = Object.values(wsPkg.exports || {}).map((t) => (typeof t === 'string' ? t : t?.import || t?.require || t?.default))
      .filter((r) => typeof r === 'string' && !exists(path.join(ws, r)));
    line(missing.length === 0 ? 'ok' : 'bad', `服务器依赖 ws v${wsPkg.version}`, missing.length ? `缺少导出文件 ${missing.join(', ')}` : '导出映射完整');
  } else {
    line('warn', '服务器依赖 ws', '未安装 → npm install');
  }

  const manifest = readJson(path.join(REPO, 'data', 'assets.json'));
  const urls = (() => {
    const out = [];
    const walk = (n) => {
      if (typeof n === 'string') { if (/^\/(assets|fonts)\//.test(n)) out.push(n); }
      else if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === 'object') Object.values(n).forEach(walk);
    };
    walk(manifest);
    return [...new Set(out)];
  })();
  const missingArt = urls.filter((u) => {
    const p = path.join(REPO, 'public', ...u.split('/').filter(Boolean).map(decodeURIComponent));
    try { return !fs.statSync(p).size; } catch { return true; }
  });
  if (!urls.length) line('bad', 'data/assets.json', '清单为空或无法解析');
  else if (missingArt.length === 0) line('ok', `美术/音频 ${urls.length} 个文件`, '完整');
  else line('warn', `美术/音频 缺 ${missingArt.length}/${urls.length}`, '首次 `npm run apk` 会自动下载（约 250 MB，可续传）');
}

// ---------------------------------------------------------------------------------------------------
// 3. runtime sources + host tools
// ---------------------------------------------------------------------------------------------------

section('3. 运行时来源 / runtime');
{
  const src = await fsp.readFile(path.join(REPO, 'mobile', 'build-apk.mjs'), 'utf8');
  const packages = [...src.matchAll(/\{\s*pkg:\s*'([^']+)'[\s\S]{0,200}?file:\s*'([^']+)'/g)].map((m) => ({ pkg: m[1], file: m[2] }));
  const base = /base:\s*process\.env\.SP_TERMUX_MIRROR\s*\|\|\s*'([^']+)'/.exec(src)?.[1] || 'https://packages.termux.dev/apt/termux-main';
  line(packages.length ? 'ok' : 'bad', `Termux 包清单：${packages.map((p) => p.pkg).join(', ') || '(未找到)'}`, `来源 ${base.replace(/^https?:\/\//, '')}`);
  for (const p of packages) {
    line('skip', `  ${p.pkg}`, `${base}/${p.file.replace(/aarch64/g, 'aarch64')}`);
  }
  const cached = exists(path.join(BUILD, 'runtime'))
    ? fs.readdirSync(path.join(BUILD, 'runtime'))
    : [];
  line(cached.length ? 'ok' : 'skip', '已缓存的运行时', cached.length ? cached.join(', ') : '首次构建时下载（约 90 MB）');
  for (const tool of ['tar', 'xz']) {
    const r = run(tool, ['--version']);
    line(r.ok ? 'ok' : 'bad', `${tool}（解包 Termux 包所需）`, r.ok ? r.out.split('\n')[0].slice(0, 60) : '未找到；Windows 10+ 自带 tar，xz 可用 winget/scoop 安装');
  }
}

// ---------------------------------------------------------------------------------------------------
// 4. android toolchain
// ---------------------------------------------------------------------------------------------------

section('4. Android 工具链 / toolchain');
{
  const btVersion = /buildTools:\s*process\.env\.SP_BUILD_TOOLS\s*\|\|\s*'([^']+)'/.exec(await fsp.readFile(path.join(REPO, 'mobile', 'build-apk.mjs'), 'utf8'))?.[1] || '36.0.0';
  line(exists(toolchain) ? 'ok' : 'skip', `工具链目录 ${toolchain}`, exists(toolchain) ? '' : '首次构建时创建');

  let jdk = null;
  const jdkRoot = path.join(toolchain, 'jdk');
  if (exists(jdkRoot)) {
    for (const d of fs.readdirSync(jdkRoot)) {
      const bin = path.join(jdkRoot, d, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
      if (exists(bin)) jdk = path.join(jdkRoot, d);
    }
  }
  if (!jdk && process.env.JAVA_HOME && exists(path.join(process.env.JAVA_HOME, 'bin', 'javac.exe'))) jdk = process.env.JAVA_HOME;
  line(jdk ? 'ok' : 'skip', 'JDK 17+', jdk || '首次构建时下载 Temurin 21（约 200 MB）');

  const bt = path.join(toolchain, 'android-sdk', 'build-tools', btVersion);
  const platform = path.join(toolchain, 'android-sdk', 'platforms', 'android-34', 'android.jar');
  line(exists(bt) ? 'ok' : 'skip', `build-tools ${btVersion}`, exists(bt) ? 'aapt2 / d8 / zipalign / apksigner' : '首次构建时通过 sdkmanager 安装');
  line(exists(platform) ? 'ok' : 'skip', 'platform android-34', exists(platform) ? 'android.jar' : '首次构建时安装');

  const keystore = path.join(REPO, 'mobile', 'keystore', 'debug.keystore');
  line(exists(keystore) ? 'ok' : 'skip', '签名密钥', exists(keystore) ? 'mobile/keystore/debug.keystore' : '首次构建时生成（自签名）');
}

// ---------------------------------------------------------------------------------------------------
// 5. device (optional)
// ---------------------------------------------------------------------------------------------------

section('5. 安卓设备（可选）/ device');
{
  const adb = [
    process.env.ADB,
    path.join(toolchain, 'android-sdk', 'platform-tools', 'adb.exe'),
    path.join(toolchain, 'android-sdk', 'platform-tools', 'adb'),
  ].filter(Boolean).find((p) => exists(p)) || (run('adb', ['version']).ok ? 'adb' : null);
  if (!adb) {
    line('skip', 'adb', '未安装（只影响真机安装；APK 仍然可以构建）');
  } else {
    line('ok', 'adb', adb);
    const devices = run(adb, ['devices', '-l']);
    const rows = devices.out.split('\n').slice(1).filter((l) => l.trim() && !/^\s*\*/.test(l));
    if (!rows.length) line('skip', '已连接设备', '无（用数据线连接手机并开启 USB 调试）');
    for (const row of rows) {
      const [serial, state, ...rest] = row.split(/\s+/);
      const model = /model:(\S+)/.exec(rest.join(' '))?.[1] || '';
      line(state === 'device' ? 'ok' : 'warn', `设备 ${serial} ${model}`, state === 'device' ? '已授权' : `${state}（在手机上允许 USB 调试）`);
    }
    const apk = fs.existsSync(path.join(BUILD))
      ? fs.readdirSync(path.join(BUILD))
        // the shipped artifacts (`Stronghold-Protocol-<version>-<abis>.apk`), not the intermediate app-unsigned.apk
        .filter((f) => /^Stronghold-Protocol-.*\.apk$/.test(f) && !/unsigned/.test(f))
        .map((f) => path.join(BUILD, f))
      : [];
    line(apk.length ? 'ok' : 'skip', '已构建的 APK', apk.length ? apk.map((p) => `${path.basename(p)} (${mb(fs.statSync(p).size)})`).join(', ') : '尚未构建（npm run apk）');
  }
}

// ---------------------------------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------------------------------

section('结论 / next steps');
if (findings.length === 0) {
  console.log(c.ok('  ✔ 没有阻塞项。') + '  一键构建：' + c.bold('npm run apk'));
} else {
  for (const f of findings) console.log(c.bad(`  ✘ ${f.label} — ${f.detail}`));
}
console.log(c.dim('  npm run apk           构建 APK（默认 arm64-v8a，手机用）'));
console.log(c.dim('  npm run apk:all       同时打包 arm64-v8a + x86_64（模拟器用，体积 +88 MB）'));
console.log(c.dim('  npm run apk:prepare   只准备，不打 APK'));
console.log(c.dim('  npm run apk:check     自检：不构建，只验证'));
console.log(c.dim('  npm run apk:verify    构建后再跑三项验证（服务器 / APK / 浏览器）'));
console.log(c.dim('  adb install -r mobile/build/Stronghold-Protocol-<版本>-<abi>.apk'));
console.log('');

process.exit(findings.length === 0 ? 0 : 1);
