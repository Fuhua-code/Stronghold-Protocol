#!/usr/bin/env node
// mobile/build-apk.mjs — the Android packager: turn this repository into a standalone Android APK.
//
//   node mobile/build-apk.mjs                 build the APK (arm64-v8a, i.e. phones)
//   node mobile/build-apk.mjs --all-abis      build for phones **and** x86_64 emulators in one APK
//   node mobile/build-apk.mjs --prepare       only prepare (toolchain + Termux Node runtime + assets tree)
//   node mobile/build-apk.mjs --check         build nothing: verify the toolchain, the runtime, the art and the module graph
//
//   npm run apk            (same as the first line)      → …-arm64-v8a.apk
//   npm run apk:all        (same as --all-abis)          → …-arm64-v8a-x86_64.apk
//   npm run apk:prepare    (same as --prepare)
//   npm run apk:check      (same as --check)
//
//     --all-abis          package arm64-v8a **and** x86_64 (adds ~88 MB; for MuMu, LDPlayer, BlueStacks, the
//                         Google AOSP/Play images — every one of them is x86_64)
//     --abi=<list>        explicit ABI list; overrides --all-abis (arm64-v8a, x86_64)
//     --out=<file>        output APK path (default: the file name carries the ABIs it contains)
//     --with-dev          also package public/dev (the in-browser dev harnesses; not needed to play)
//     --fetch-assets      download the game art even if it is present, and never ask
//     --no-fetch-assets   never download the game art (fail with instructions instead)
//     --skip-dex          skip javac/d8 (fast iteration on the packaged assets)
//     --no-node           skip the Node runtime (a client-only APK that must point at a real server)
//     --no-download       never download toolchain pieces outside `npm install` / the art step (fail instead)
//     --toolchain=<dir>   toolchain root (default <workspace>/.toolchain, then <repo>/.toolchain)
//     --json=<file>       write a build report
//     -h, --help          this text
//
// Why arm64 only by default: a phone only ever needs its own ABI, and Android unpacks just the `lib/<abi>/`
// directory that matches the device — so the extra copy is dead weight (88 MB) on the phone. Emulator users opt in
// with `--all-abis`, which writes a differently named file so both variants can sit side by side.
//
// What it does, in order (see mobile/README.md):
//   0. one-command setup: `npm install` when node_modules is missing, `tools/fetch-assets.mjs` when the art is
//      missing (skipped with --no-fetch-assets), so a fresh clone needs nothing else;
//   1. require a prepared repository (public/vendor, public/assets, data/*.json) and, unless --no-download,
//      fetch the missing pieces of the Android toolchain (JDK, cmdline-tools, build-tools, platform)
//      into the toolchain directory;
//   2. fetch the Node runtime — **Termux's Node 24 LTS** (`nodejs-lts` plus its libraries: libc++, openssl,
//      c-ares, libicu, libsqlite, zlib) from packages.termux.dev — into `mobile/build/runtime/`;
//   3. assemble `mobile/build/nodejs-project/` — the same file set the Dockerfile ships as its runtime image,
//      plus `mobile/node/main.js` and `node_modules/ws` — and copy the client's public/ into it
//      (this is the art that makes the APK work offline);
//   4. `aapt2 compile` + `aapt2 link` the tiny Android resources; `javac` + `d8` the activity;
//   5. write the APK with a deterministic ZIP writer: everything aapt2 produced (manifest, resources.arsc,
//      res/** — including the launcher icons), then classes.dex, the Node runtime in `lib/<abi>/` and the whole
//      game in `assets/nodejs-project/**`, every entry stored and the native libraries 4 KB aligned;
//   6. `zipalign` and `apksigner` (v2+v3) with `mobile/keystore/debug.keystore` (created on first use);
//   7. verify the finished APK (signature, badging, packaged assets/native libs, manifest resource references,
//      resource-table file references) and print a summary. Exit code 0 = a signed, verified APK.
//
// Nothing outside mobile/ is modified: the APK embeds (copies of) the repository's server/, shared/, data/ and
// public/, exactly like the Docker image does.
//
// Why Termux's Node instead of nodejs-mobile: nodejs-mobile is stuck on Node 18 and its `libnode.so` cannot be
// started from a JNI shim here (it aborts with a GWP-ASan TLS resolution failure on Android 16). Termux's Node 24
// is a plain PIE executable with a handful of shared libraries: Android runs it through `/system/bin/linker64`
// (or directly, where exec from the app's data directory is permitted), and the shell environment of the game
// (public/, data/, ws) is untouched — `node --version` on the phone reports v24.18.0.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { patchRuntimeDir } from './tools/patch-elf-sonames.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BUILD = path.join(HERE, 'build');
const ANDROID = path.join(HERE, 'android');
const KEYSTORE_DIR = path.join(HERE, 'keystore');
const KEYSTORE = path.join(KEYSTORE_DIR, 'debug.keystore');

const NODEJS_MOBILE = { version: '18.20.4' }; // historical: the previous nodejs-mobile-based build (see mobile/README.md)

/** The Node runtime the APK ships: Termux's Node 24 build, per architecture (packages.termux.dev). */
const TERMUX = {
  base: process.env.SP_TERMUX_MIRROR || 'https://packages.termux.dev/apt/termux-main',
  // package name → [path under pool/ (with `<arch>` for the architecture), files copied into lib/<abi>/]
  packages: [
    { pkg: 'nodejs-lts', file: 'pool/main/n/nodejs-lts/nodejs-lts_24.18.0-1_<arch>.deb', bins: { 'bin/node': 'node' } },
    { pkg: 'libc++', file: 'pool/main/libc/libc++/libc++_30_<arch>.deb', libs: { 'lib/libc++_shared.so': 'libc++_shared.so' } },
    { pkg: 'openssl', file: 'pool/main/o/openssl/openssl_1%3A3.6.5_<arch>.deb', libs: { 'lib/libcrypto.so.3': 'libcrypto.so.3', 'lib/libssl.so.3': 'libssl.so.3' } },
    { pkg: 'libicu', file: 'pool/main/libi/libicu/libicu_78.3_<arch>.deb', libs: { 'lib/libicuuc.so.78.3': 'libicuuc.so.78', 'lib/libicui18n.so.78.3': 'libicui18n.so.78', 'lib/libicudata.so.78.3': 'libicudata.so.78' } },
    { pkg: 'c-ares', file: 'pool/main/c/c-ares/c-ares_1.34.8_<arch>.deb', libs: { 'lib/libcares.so': 'libcares.so' } },
    { pkg: 'libsqlite', file: 'pool/main/libs/libsqlite/libsqlite_3.53.4_<arch>.deb', libs: { 'lib/libsqlite3.so.3.53.4': 'libsqlite3.so' } },
    { pkg: 'zlib', file: 'pool/main/z/zlib/zlib_1.3.2_<arch>.deb', libs: { 'lib/libz.so.1.3.2': 'libz.so.1' } },
  ],
};

/** Versions of the toolchain this build was tested with (overridable through the environment). */
const TOOLS = {
  cmdlineTools: process.env.SP_CMDLINE_TOOLS || 'commandlinetools-win-11076708_latest.zip',
  // 34.0.0's d8 (R8 8.2) crashes on anonymous classes and lambdas ("Cannot invoke String.length()"), which the
  // activity needs; 35+ dexes them correctly. Both parse the same resources and produce a valid APK.
  buildTools: process.env.SP_BUILD_TOOLS || '36.0.0',
  platform: process.env.SP_PLATFORM || 'android-34',
  minSdk: process.env.SP_MIN_SDK || '24',
  targetSdk: process.env.SP_TARGET_SDK || '34',
};

/**
 * Android ABI → the architecture name the Termux packages use. Phones are `aarch64`; every mainstream Android
 * emulator (MuMu, LDPlayer, BlueStacks, the Google AOSP/Play images on a PC) is `x86_64`, and Termux publishes
 * both — so both fit in one APK and Android unpacks the one that matches the device.
 */
const ABI_ALIASES = {
  'arm64-v8a': 'arm64-v8a', arm64: 'arm64-v8a', aarch64: 'arm64-v8a',
  x86_64: 'x86_64', x64: 'x86_64', amd64: 'x86_64',
};
const ABI_TERMUX = { 'arm64-v8a': 'aarch64', x86_64: 'x86_64' };
/** Phones are arm64; x86_64 (emulators) is opt-in through `--all-abis`. */
const DEFAULT_ABIS = ['arm64-v8a'];
/** What `--all-abis` packages: phones **and** every mainstream Android emulator. */
const ALL_ABIS = ['arm64-v8a', 'x86_64'];

/**
 * The shared libraries the runtime needs, under the names they get **after** `patch-elf-sonames.mjs` has made them
 * Android-legal (see `stageRuntime`). Android only extracts `lib*.so` shaped entries, so the versioned Termux
 * sonames (`libcrypto.so.3`, `libicuuc.so.78`, …) are shortened and the ELF records are rewritten to match.
 */
const RUNTIME_LIBS = ['libc++_shared.so', 'libcares.so', 'libsqlite3.so', 'libcrypto.so', 'libssl.so', 'libicuuc.so', 'libicui18n.so', 'libicudata.so', 'libz.so'];

const APP = {
  package: 'io.prts.stronghold',
  label: '卫戍协议：盟约',
  versionName: null, // from package.json
  versionCode: 1,
};

// ---------------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------------

const log = (...a) => console.log(...a);
const step = (n, s) => log(`\n\x1b[36m▶ ${n}\x1b[0m ${s}`);
const warn = (s) => log(`\x1b[33m  ! ${s}\x1b[0m`);
const fail = (s) => { log(`\x1b[31m  ✘ ${s}\x1b[0m`); throw new Error(s); };
const ok = (s) => log(`\x1b[32m  ✔\x1b[0m ${s}`);
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const bytes = (n) => `${(n / 1048576).toFixed(1)} MB`;

/** Run a command, echoing it (stdio: inherit unless a capture was asked for). */
function run(cmd, args, { cwd = REPO, env, capture = false, allowFail = false, input, stdoutFile = null } = {}) {
  if (!capture && !stdoutFile) log(`\x1b[2m  $ ${path.basename(cmd)} ${args.join(' ')}\x1b[0m`);
  let fd = null;
  if (stdoutFile) {
    fd = fs.openSync(stdoutFile, 'w');
  }
  const r = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: stdoutFile ? ['ignore', fd, 'pipe'] : (capture ? ['pipe', 'pipe', 'pipe'] : (input ? ['pipe', 'inherit', 'inherit'] : 'inherit')),
    input,
    encoding: capture ? 'utf8' : undefined,
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd),
    windowsHide: true,
    maxBuffer: 64 << 20,
  });
  if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  if (r.error) { if (allowFail) return { ok: false, out: String(r.error.message) }; fail(`${cmd}: ${r.error.message}`); }
  const out = capture ? `${r.stdout || ''}${r.stderr || ''}` : (stdoutFile ? `${r.stderr || ''}` : '');
  if (r.status !== 0 && !allowFail) fail(`${path.basename(cmd)} exited with ${r.status}${out ? `\n${out.split('\n').slice(-25).join('\n')}` : ''}`);
  return { ok: r.status === 0, status: r.status, out };
}

async function download(url, dest, { expectMinBytes = 1024 } = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  if (exists(dest) && (await fsp.stat(dest)).size >= expectMinBytes) return dest;
  const tmp = `${dest}.part`;
  log(`  ↓ ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) fail(`download failed: HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  const out = fs.createWriteStream(tmp);
  let seen = 0; let lastPct = -5;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.length;
    if (total) { const pct = Math.floor((seen / total) * 100); if (pct >= lastPct + 5) { lastPct = pct; process.stdout.write(`\r    ${pct}% (${bytes(seen)}/${bytes(total)})   `); } }
    if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
  }
  await new Promise((resolve, reject) => { out.end((e) => (e ? reject(e) : resolve())); });
  if (total) process.stdout.write('\r');
  const size = (await fsp.stat(tmp)).size;
  if (size < expectMinBytes) fail(`download too small (${size} bytes): ${url}`);
  await fsp.rename(tmp, dest);
  return dest;
}

async function unzip(zipPath, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  // tar (bsdtar, shipped with Windows 10+ and every Unix) handles ZIP and keeps the forward-slash layout intact.
  const r = run('tar', ['-xf', zipPath, '-C', destDir], { capture: true, allowFail: true });
  if (!r.ok) {
    // fallback: PowerShell's Expand-Archive
    const ps = run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`], { capture: true, allowFail: true });
    if (!ps.ok) fail(`cannot extract ${zipPath}: ${r.out || ps.out}`);
  }
}

async function dirSize(dir) {
  let total = 0; let files = 0;
  const walk = async (d) => {
    let entries = [];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) { total += (await fsp.stat(p)).size; files++; }
    }
  };
  await walk(dir);
  return { bytes: total, files };
}

/** A stable short hash of every file below `dir` (path + size + mtime), used as the art version marker. */
async function hashTree(dir) {
  const h = crypto.createHash('sha256');
  const walk = async (d, rel) => {
    const entries = (await fsp.readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p, r);
      else if (e.isFile()) {
        const st = await fsp.stat(p);
        h.update(`${r}\0${st.size}\0${Math.floor(st.mtimeMs)}\0`);
      }
    }
  };
  await walk(dir, '');
  return h.digest('hex').slice(0, 16);
}

async function copyTree(from, to, { filter } = {}) {
  const walk = async (src, dst, rel) => {
    if (filter && !filter(src, rel)) return;
    const st = await fsp.stat(src);
    if (st.isFile()) {
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.copyFile(src, dst);
      return;
    }
    await fsp.mkdir(dst, { recursive: true });
    for (const e of await fsp.readdir(src, { withFileTypes: true })) {
      await walk(path.join(src, e.name), path.join(dst, e.name), rel ? `${rel}/${e.name}` : e.name);
    }
  };
  await walk(from, to, '');
}

// ---------------------------------------------------------------------------------------------------
// toolchain
// ---------------------------------------------------------------------------------------------------

function findJavaHome(toolchain) {
  const cands = [];
  if (process.env.JAVA_HOME) cands.push(process.env.JAVA_HOME);
  const jdkRoot = path.join(toolchain, 'jdk');
  if (exists(jdkRoot)) for (const d of fs.readdirSync(jdkRoot)) cands.push(path.join(jdkRoot, d));
  for (const d of ['C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Java', 'C:\\Program Files\\Microsoft\\jdk', 'C:\\Program Files\\Zulu', '/usr/lib/jvm']) {
    if (exists(d)) for (const s of fs.readdirSync(d)) cands.push(path.join(d, s));
  }
  for (const c of cands) {
    if (exists(path.join(c, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'))) {
      const v = run(path.join(c, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), ['-version'], { capture: true, allowFail: true });
      const m = /version "(\d+)/.exec(v.out);
      if (m && Number(m[1]) >= 17) return { home: c, major: Number(m[1]), version: (/(\d+\.\d+\.\d+[^"]*)/.exec(v.out) || [])[1] || m[1] };
    }
  }
  return null;
}

async function ensureJdk(toolchain, allowDownload) {
  const found = findJavaHome(toolchain);
  if (found) { ok(`JDK ${found.version} at ${found.home}`); return found.home; }
  if (!allowDownload) fail('no JDK 17+ found (set JAVA_HOME or --toolchain=<dir>)');
  step('1b', 'downloading a portable JDK 21 …');
  const api = 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse';
  const meta = await (await fetch(api)).json();
  const pkg = meta?.[0]?.binary?.package;
  if (!pkg?.link) fail('cannot resolve a JDK download from api.adoptium.net');
  const zip = await download(pkg.link, path.join(toolchain, 'downloads', 'jdk21.zip'), { expectMinBytes: 50 << 20 });
  await unzip(zip, path.join(toolchain, 'jdk'));
  const jdkDirs = fs.readdirSync(path.join(toolchain, 'jdk')).map((d) => path.join(toolchain, 'jdk', d));
  const javaBin = (d) => path.join(d, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
  const home = jdkDirs.find((d) => exists(javaBin(d)));
  if (!home) fail(`the JDK archive did not contain a JDK (looked in ${path.join(toolchain, 'jdk')})`);
  ok(`JDK installed at ${home}`);
  return home;
}

/** The Android SDK root (…/android-sdk) with build-tools/<v>, platforms/<p> and the command-line tools. */
async function ensureSdk(toolchain, javaHome, allowDownload) {
  const sdk = path.join(toolchain, 'android-sdk');
  const sdkmanager = path.join(sdk, 'cmdline-tools', 'latest', 'bin', process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager');
  const env = {
    JAVA_HOME: javaHome,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${process.env.PATH}`,
  };
  if (!exists(sdkmanager)) {
    if (!allowDownload) fail(`Android SDK command-line tools not found at ${sdkmanager}`);
    step('1c', 'downloading Android SDK command-line tools …');
    const zip = await download(`https://dl.google.com/android/repository/${TOOLS.cmdlineTools}`, path.join(toolchain, 'downloads', 'cmdline-tools.zip'), { expectMinBytes: 20 << 20 });
    const tmp = path.join(sdk, '.unpack');
    await unzip(zip, tmp);
    const src = path.join(tmp, 'cmdline-tools');
    const dst = path.join(sdk, 'cmdline-tools', 'latest');
    await fsp.mkdir(dst, { recursive: true });
    for (const e of await fsp.readdir(src)) await fsp.rename(path.join(src, e), path.join(dst, e));
    await fsp.rm(tmp, { recursive: true, force: true });
    ok('command-line tools installed');
  }
  // Install/refresh the packages this build needs (idempotent; sdkmanager reports "already installed").
  const want = [`build-tools;${TOOLS.buildTools}`, `platforms;${TOOLS.platform}`];
  const have = [];
  for (const p of want) {
    const dir = p.startsWith('build-tools') ? path.join(sdk, 'build-tools', TOOLS.buildTools) : path.join(sdk, 'platforms', TOOLS.platform);
    if (exists(dir)) have.push(p);
  }
  if (have.length !== want.length) {
    if (!allowDownload) fail(`missing SDK packages: ${want.filter((w) => !have.includes(w)).join(', ')}`);
    step('1d', `installing SDK packages (${want.filter((w) => !have.includes(w)).join(', ')}) …`);
    // `y` on stdin accepts the licences (CRLF: sdkmanager's line reader needs a real line ending on Windows)
    const yes = 'y\r\n'.repeat(80);
    run(sdkmanager, ['--sdk_root=' + sdk, '--licenses'], { env, capture: true, allowFail: true, input: yes });
    const r = run(sdkmanager, ['--sdk_root=' + sdk, ...want], { env, capture: true, allowFail: true, input: yes });
    if (r.status !== 0 && !exists(path.join(sdk, 'build-tools', TOOLS.buildTools))) fail(`sdkmanager failed:\n${r.out.split('\n').slice(-30).join('\n')}`);
    ok('SDK packages installed');
  }
  const bt = path.join(sdk, 'build-tools', TOOLS.buildTools);
  // Windows ships `aapt2.exe` / `zipalign.exe` but `d8.bat` / `apksigner.bat`; on Unix everything is extensionless.
  const isWin = process.platform === 'win32';
  const exeName = (n) => (isWin ? (n === 'aapt2' || n === 'zipalign' ? `${n}.exe` : `${n}.bat`) : n);
  const exe = (n) => path.join(bt, exeName(n));
  for (const n of ['aapt2', 'd8', 'zipalign', 'apksigner']) if (!exists(exe(n))) fail(`missing ${n} in ${bt}`);
  return { sdk, bt, env, aapt2: exe('aapt2'), d8: exe('d8'), zipalign: exe('zipalign'), apksigner: exe('apksigner'), androidJar: path.join(sdk, 'platforms', TOOLS.platform, 'android.jar') };
}

/**
 * Extract selected members out of a `.deb` (an `ar` archive holding `data.tar.xz`).
 *
 * Implemented in plain Node on purpose: a `.deb` contains symlinks (`bin/corepack` → `../lib/…`) that Windows
 * cannot create, and driving `xz` through a pipe truncated the 95 MB payload on this host — so `xz` is asked to
 * write *a file* (`-c` into a file descriptor) and the tar headers are walked here, taking only regular files.
 *
 * @param {string} deb path to the .deb
 * @param {string} destDir where the payload is unpacked (layout preserved)
 * @returns {Promise<string[]>} the extracted member names
 */
async function extractDeb(deb, destDir) {
  const work = path.join(BUILD, 'termux');
  await fsp.mkdir(work, { recursive: true });
  const dataXz = path.join(work, `${path.basename(deb)}.data.tar.xz`);
  const dataTar = path.join(work, `${path.basename(deb)}.data.tar`);

  // 1. the ar container: take the data.tar.* member
  const buf = await fsp.readFile(deb);
  if (buf.subarray(0, 8).toString('ascii') !== '!<arch>\n') fail(`${deb} is not an ar archive`);
  let p = 8;
  let payload = null;
  let payloadName = '';
  while (p + 60 <= buf.length) {
    const name = buf.subarray(p, p + 16).toString('ascii').trim().replace(/\/$/, '');
    const size = parseInt(buf.subarray(p + 48, p + 58).toString('ascii').trim(), 10);
    const start = p + 60;
    if (!Number.isFinite(size) || size < 0) break;
    if (name.startsWith('data.tar')) { payload = buf.subarray(start, start + size); payloadName = name; }
    p = start + size + (size % 2);
  }
  if (!payload) fail(`${deb}: no data.tar member found`);
  const xzPath = payloadName.endsWith('.gz') ? null : dataXz;
  if (payloadName.endsWith('.gz')) {
    await fsp.writeFile(dataTar, zlib.gunzipSync(payload));
  } else {
    await fsp.writeFile(xzPath, payload);
    // 2. xz → tar *through files*: an 8 KB pipe buffer silently truncates the stream on Windows
    const inFd = fs.openSync(xzPath, 'r');
    const outFd = fs.openSync(dataTar, 'w');
    const r = spawnSync('xz', ['-dc'], { stdio: [inFd, outFd, 'pipe'] });
    fs.closeSync(inFd);
    fs.closeSync(outFd);
    if (r.status !== 0) fail(`xz failed for ${path.basename(deb)}: ${r.stderr || `exit ${r.status}`}`);
  }
  const tar = await fsp.readFile(dataTar);
  if (tar.length < 512) fail(`${path.basename(deb)}: empty tar payload`);

  // 3. walk the tar and write the regular files (symlinks/hardlinks are skipped: nothing needs them)
  const out = [];
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const raw = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const full = (prefix ? `${prefix}/${raw}` : raw).replace(/^\.\//, '');
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8) || 0;
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = off + 512;
    if ((type === '0' || type === '\0') && full && !full.endsWith('/')) {
      const dest = path.join(destDir, ...full.split('/'));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, tar.subarray(dataStart, dataStart + size));
      out.push(full);
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  fs.rmSync(xzPath, { force: true });
  fs.rmSync(dataTar, { force: true });
  return out;
}

/**
 * Unpack a `.deb` (an `ar` archive) and return the path of its data tarball, written next to the control files
 * inside `destDir`.
 */
async function unpackDeb(deb, destDir) {
  const buf = await fsp.readFile(deb);
  if (buf.subarray(0, 8).toString('ascii') !== '!<arch>\n') fail(`${deb} is not an ar archive`);
  let p = 8;
  let dataPath = null;
  while (p + 60 <= buf.length) {
    const name = buf.subarray(p, p + 16).toString('ascii').trim().replace(/\/$/, '');
    const size = parseInt(buf.subarray(p + 48, p + 58).toString('ascii').trim(), 10);
    const start = p + 60;
    if (!Number.isFinite(size) || size < 0) break;
    if (name.startsWith('data.tar')) {
      dataPath = path.join(destDir, name);
      await fsp.writeFile(dataPath, buf.subarray(start, start + size));
    }
    p = start + size + (size % 2); // ar members are 2-byte aligned
  }
  if (!dataPath) fail(`${deb}: no data.tar member found`);
  return dataPath;
}

/**
 * Fetch the Node runtime from the Termux repository and unpack it into `mobile/build/runtime/<abi>/`.
 *
 * The .deb files are ordinary `ar` archives containing a tar payload; both are read in plain Node (see
 * `unpackDeb` / `extractTarMembers`) so a Windows host needs no `ar`, and the packages' symlinks — which Windows
 * cannot create — are irrelevant because only regular files are taken out (the runtime executable and the shared
 * libraries Node links against).
 *
 * @returns {Promise<{ bin: string, libs: string[], node: string }>} paths inside `mobile/build/runtime/<abi>`
 */
async function fetchTermuxNode(toolchain, abi, allowDownload) {
  const arch = ABI_TERMUX[abi];
  if (!arch) fail(`unsupported ABI ${abi}: Termux publishes aarch64 and x86_64 only (use --abi=arm64-v8a or --abi=x86_64)`);
  const destDir = path.join(BUILD, 'runtime', abi);
  const stamp = path.join(destDir, 'RUNTIME.json');
  if (exists(stamp) && exists(path.join(destDir, 'node'))) {
    const info = JSON.parse(await fsp.readFile(stamp, 'utf8'));
    ok(`${abi}: runtime cached — Node ${info.node} (${info.packages.length} packages)`);
    return { bin: path.join(destDir, 'node'), libs: info.libs, node: info.node };
  }
  await fsp.rm(destDir, { recursive: true, force: true });
  await fsp.mkdir(destDir, { recursive: true });
  const work = path.join(BUILD, 'termux', arch);
  await fsp.mkdir(work, { recursive: true });

  const libs = [];
  let nodeVersion = null;
  for (const p of TERMUX.packages) {
    const file = p.file.replace('<arch>', arch);
    const deb = path.join(work, `${p.pkg}.deb`);
    if (!exists(deb)) {
      if (!allowDownload) fail(`missing ${deb} and downloads are disabled`);
      await download(`${TERMUX.base}/${file}`, deb, { expectMinBytes: 4000 });
    }
    const out = path.join(work, p.pkg);
    await fsp.rm(out, { recursive: true, force: true });
    await fsp.mkdir(out, { recursive: true });
    const members = await extractDeb(deb, out);
    if (!members.length) fail(`${p.pkg}: the package has no regular files`);
    const usr = path.join(out, 'data', 'data', 'com.termux', 'files', 'usr');
    const wanted = { ...(p.bins || {}), ...(p.libs || {}) };
    const missing = Object.keys(wanted).filter((rel) => !exists(path.join(usr, ...rel.split('/'))));
    if (missing.length) fail(`${p.pkg} (${arch}): ${missing.join(', ')} not found in the package (${members.length} files unpacked)`);
    for (const [from, to] of Object.entries(wanted)) {
      await fsp.copyFile(path.join(usr, ...from.split('/')), path.join(destDir, to));
      if (p.libs) libs.push(to);
    }
    if (p.bins) nodeVersion = /nodejs-lts_(\d+\.\d+\.\d+)/.exec(p.file)?.[1] || '24.x';
  }
  await fsp.writeFile(stamp, JSON.stringify({ abi, arch, node: nodeVersion, packages: TERMUX.packages.map((p) => p.pkg), libs, fetchedAt: new Date().toISOString() }, null, 1) + '\n');
  ok(`${abi}: Node ${nodeVersion} + ${libs.length} shared libraries (${bytes((await dirSize(destDir)).bytes)})`);
  return { bin: path.join(destDir, 'node'), libs, node: nodeVersion };
}

// ---------------------------------------------------------------------------------------------------
// nodejs-project (what the APK ships as assets/nodejs-project)
// ---------------------------------------------------------------------------------------------------

async function prepareNodejsProject({ withDev, abis = [] }) {
  const dest = path.join(BUILD, 'nodejs-project');
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(dest, { recursive: true });

  // 1. the source set of the Docker runtime image (+ the mobile entry point)
  await copyTree(path.join(REPO, 'server'), path.join(dest, 'server'));
  await copyTree(path.join(REPO, 'shared'), path.join(dest, 'shared'));
  await copyTree(path.join(REPO, 'data'), path.join(dest, 'data'));
  await copyTree(path.join(REPO, 'mobile', 'node'), path.join(dest, 'mobile', 'node'));
  // the APK's connect shell (the 本地/远程 entry) — the mobile server mounts it at /connect/, see mobile/shell/
  await copyTree(path.join(REPO, 'mobile', 'shell'), path.join(dest, 'shell'));
  await fsp.mkdir(path.join(dest, 'docs'), { recursive: true });
  await copyTree(path.join(REPO, 'docs', 'research'), path.join(dest, 'docs', 'research'));

  // 2. the client, minus the dev harnesses: this is what makes the APK work offline
  const pubSrc = path.join(REPO, 'public');
  const pubDst = path.join(dest, 'public');
  await fsp.mkdir(pubDst, { recursive: true });
  for (const entry of await fsp.readdir(pubSrc, { withFileTypes: true })) {
    if (!withDev && entry.name === 'dev') continue;
    await copyTree(path.join(pubSrc, entry.name), path.join(pubDst, entry.name));
  }
  const missing = ['index.html', 'css', 'js', 'vendor', 'assets', 'fonts'].filter((n) => !exists(path.join(pubDst, n)));
  if (missing.length) fail(`public/ is incomplete (missing ${missing.join(', ')}); run \`npm install\` and \`node tools/fetch-assets.mjs\` first`);

  // 2b. the marker the app compares before re-unpacking 290 MB of art after an update (MainActivity's needArt):
  //     any change to the shipped client or art changes this value, so the phone re-extracts exactly once.
  const pkgVersion = JSON.parse(await fsp.readFile(path.join(REPO, 'package.json'), 'utf8')).version;
  const artHash = await hashTree(pubDst);
  await fsp.writeFile(path.join(pubDst, 'ASSETS-VERSION'), `${pkgVersion}-${artHash}\n`);

  // 3. the only runtime dependency of the server, at the project root: `server/index.js` imports 'ws' by bare
  //    specifier, and Node resolves that by walking up from the importing module — so it has to live in a
  //    node_modules directory that contains (or is above) `server/`. The whole package directory is copied (minus
  //    a nested node_modules) because `ws` maps its ESM entry point through `wrapper.mjs`.
  const wsDest = path.join(dest, 'node_modules', 'ws');
  const wsSrc = path.join(REPO, 'node_modules', 'ws');
  if (!exists(wsSrc)) fail('node_modules/ws is missing; run `npm install` first');
  // (the filter is relative to the package, so it never matches the repository's own node_modules path)
  await copyTree(wsSrc, wsDest, { filter: (p, rel) => !/(^|[\\/])node_modules([\\/]|$)/.test(rel) });
  // `ws` is CommonJS while the project itself is ESM: `node_modules/package.json` pins the module system for
  // everything below it, so `import { WebSocketServer } from 'ws'` keeps working from the ESM server.
  await fsp.writeFile(path.join(dest, 'node_modules', 'package.json'), '{ "type": "commonjs" }\n');

  // 4. a package.json so the Node runtime and tools see a normal project. `type: module` is required: the game is
  //    ESM everywhere (including this entry point), and Node resolves a `.js` file's module system from the nearest
  //    package.json. The vendored `ws` needs `"type": "commonjs"` — the reverse — which is why it carries a
  //    package.json of its own inside mobile/node/node_modules (see above).
  const pkg = JSON.parse(await fsp.readFile(path.join(REPO, 'package.json'), 'utf8'));
  await fsp.writeFile(path.join(dest, 'package.json'), JSON.stringify({
    name: 'stronghold-protocol-android-runtime',
    version: pkg.version,
    private: true,
    type: 'module',
    description: '卫戍协议：盟约 — Node runtime packaged into the Android APK (generated by mobile/build-apk.mjs)',
    main: 'mobile/node/main.js',
    license: pkg.license,
  }, null, 2) + '\n');
  await fsp.writeFile(path.join(dest, 'BUILD-INFO.json'), JSON.stringify({
    app: path.basename(REPO),
    version: pkg.version,
    builtAt: new Date().toISOString(),
    builtBy: `node ${process.versions.node}`,
    runtime: `Termux nodejs-lts (Node 24) for ${abis.join(' + ') || 'no ABI'}, started through /system/bin/linker64`,
    withDev,
    sourceCommit: run('git', ['-C', REPO, 'rev-parse', 'HEAD'], { capture: true, allowFail: true }).out.trim() || null,
  }, null, 2) + '\n');

  const size = await dirSize(dest);
  ok(`nodejs-project prepared: ${size.files} files, ${bytes(size.bytes)}`);
  return { dir: dest, size };
}

/** Every `/assets/…` or `/fonts/…` URL of data/assets.json (tools/setup.mjs checkAssets does the same walk). */
function manifestUrls(node, out = []) {
  if (typeof node === 'string') { if (/^\/(assets|fonts)\//.test(node)) out.push(node); }
  else if (Array.isArray(node)) for (const x of node) manifestUrls(x, out);
  else if (node && typeof node === 'object') for (const x of Object.values(node)) manifestUrls(x, out);
  return out;
}

/** Refuse to build an APK whose art is incomplete: the client would silently fall back to placeholders. */
async function assertArtComplete(nodeProjectDir) {
  const pub = path.join(nodeProjectDir, 'public');
  const manifest = JSON.parse(await fsp.readFile(path.join(REPO, 'data', 'assets.json'), 'utf8'));
  const urls = [...new Set(manifestUrls(manifest))];
  const missing = [];
  for (const u of urls) {
    const p = path.join(pub, ...u.split('/').filter(Boolean).map(decodeURIComponent));
    try { const st = await fsp.stat(p); if (!st.size) missing.push(u); } catch { missing.push(u); }
  }
  if (!urls.length) fail('data/assets.json lists no art; the APK would have no visuals');
  if (missing.length) fail(`art is incomplete: ${missing.length} of ${urls.length} files missing (e.g. ${missing.slice(0, 5).join(', ')}) — run \`node tools/fetch-assets.mjs\``);
  ok(`art complete: ${urls.length} manifest URLs present under public/`);
  return urls.length;
}

// ---------------------------------------------------------------------------------------------------
// Android build
// ---------------------------------------------------------------------------------------------------

async function writeAndroidProject({ abis, versionName, packageName }) {
  const gen = path.join(BUILD, 'android');
  await fsp.rm(gen, { recursive: true, force: true });
  await fsp.mkdir(path.join(gen, 'res', 'values'), { recursive: true });
  await fsp.mkdir(path.join(gen, 'src'), { recursive: true });
  await fsp.mkdir(path.join(gen, 'jniLibs'), { recursive: true });

  // resources: only the app name, a dark background and the theme; no AndroidX, no AppCompat.
  // (No `res/xml/network_security_config.xml`: `android:usesCleartextTraffic="true"` already allows the loopback
  // and LAN HTTP the game needs, and a manifest reference to a missing XML resource makes Android refuse to start
  // the application at all — "Failed to parse XML configuration from network_security_config", seen on Android 16.)
  await fsp.writeFile(path.join(gen, 'res', 'values', 'strings.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <string name="app_name">${APP.label}</string>\n</resources>\n`);
  await fsp.writeFile(path.join(gen, 'res', 'values', 'colors.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="sp_bg">#0C0F0E</color>\n  <color name="sp_fg">#D8E3DE</color>\n  <color name="sp_accent">#4ED8AF</color>\n</resources>\n`);
  await fsp.writeFile(path.join(gen, 'res', 'values', 'styles.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <style name="SPTheme" parent="@android:style/Theme.Material.NoActionBar.Fullscreen">\n    <item name="android:windowBackground">@color/sp_bg</item>\n    <item name="android:colorAccent">@color/sp_accent</item>\n  </style>\n</resources>\n`);

  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="${packageName}"
    android:versionCode="${APP.versionCode}"
    android:versionName="${versionName}"
    android:installLocation="auto">

    <uses-sdk android:minSdkVersion="${TOOLS.minSdk}" android:targetSdkVersion="${TOOLS.targetSdk}" />

    <!-- LAN co-op: the phone is the server and the players connect to it over the local network. -->
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />

    <uses-feature android:name="android.hardware.touchscreen" android:required="false" />
    <uses-feature android:name="android.hardware.gamepad" android:required="false" />

    <application
        android:label="@string/app_name"
        android:icon="@mipmap/ic_launcher"
        android:roundIcon="@mipmap/ic_launcher"
        android:theme="@style/SPTheme"
        android:hardwareAccelerated="true"
        android:usesCleartextTraffic="true"
        android:extractNativeLibs="true"
        android:allowBackup="false"
        android:requestLegacyExternalStorage="false"
        android:supportsRtl="false">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:label="@string/app_name"
            android:launchMode="singleTask"
            android:screenOrientation="userLandscape"
            android:configChanges="orientation|screenSize|smallestScreenSize|screenLayout|keyboardHidden|keyboard|navigation|uiMode|density|fontScale|locale|layoutDirection|touchscreen"
            android:resizeableActivity="false">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

        <meta-data android:name="android.max_aspect" android:value="5.0" />
    </application>
</manifest>
`;
  await fsp.writeFile(path.join(gen, 'AndroidManifest.xml'), manifest);

  // Java sources + resources shipped with the mobile project (MainActivity, mipmaps, …)
  await copyTree(path.join(ANDROID, 'res'), path.join(gen, 'res'));
  await copyTree(path.join(ANDROID, 'java'), path.join(gen, 'src'));

  // the assets tree (nodejs-project) at the root of assets/
  await copyTree(path.join(BUILD, 'nodejs-project'), path.join(gen, 'assets', 'nodejs-project'));
  return gen;
}

/**
 * Native libraries in `jniLibs/<abi>/`; Android extracts these into the app's `nativeLibraryDir`, which is the one
 * directory where the app may execute a program and where the dynamic linker finds its dependencies without a
 * W^X violation.
 *
 * Android only extracts entries whose name has the `lib*.so` shape, and Termux's runtime uses names that do not
 * (`node`, `libcrypto.so.3`, `libicu*.so.78`, `libz.so.1` — verified: on MuMu only three of ten files were
 * extracted). The runtime is therefore copied under Android-legal names and the ELF records that reference them
 * are rewritten in place (`tools/patch-elf-sonames.mjs`), which is why `node` ships as `libnode.so`.
 */
async function stageRuntime({ runtime, abi, jniLibs }) {
  const dir = path.join(jniLibs, abi);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.copyFile(runtime.bin, path.join(dir, 'node'));
  for (const lib of runtime.libs) await fsp.copyFile(path.join(path.dirname(runtime.bin), lib), path.join(dir, lib));
  const patched = await patchRuntimeDir(dir);
  if (!patched.patched && !patched.renamed.length) warn(`${abi}: nothing needed patching (unexpected)`);
  const files = (await fsp.readdir(dir)).sort();
  ok(`runtime staged in lib/${abi}/: ${files.length} entries, ${patched.patched} ELF patched (${bytes((await dirSize(dir)).bytes)})`);
  return dir;
}

// ---------------------------------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------------------------------

/**
 * Check the ZIP alignment of the packaged native libraries the way `zipalign -c` does: the *data* of every
 * uncompressed entry must start on a 4-byte boundary (lib/<abi>/*.so are the ones that matter — Android's loader
 * reads them straight out of the APK). The data offset is the local header offset plus the header, name and extra
 * field, which is why the local header itself is read here.
 */
async function checkAlignment(apk, abis) {
  const { entries } = await readCentralDirectory(apk);
  const fh = await fsp.open(apk, 'r');
  const bad = [];
  let checked = 0;
  try {
    for (const [name, e] of entries) {
      if (!/^lib\/[^/]+\/.*\.so$/.test(name)) continue;
      const header = Buffer.alloc(30);
      await fh.read(header, 0, 30, e.localOffset);
      if (header.readUInt32LE(0) !== 0x04034b50) { bad.push(`${name}: bad local header`); continue; }
      const dataOffset = e.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      checked++;
      if (dataOffset % 4 !== 0) bad.push(`${name} data @ ${dataOffset} (% 4 = ${dataOffset % 4})`);
    }
  } finally {
    await fh.close();
  }
  if (bad.length) return { ok: false, problem: `native libraries not 4-byte aligned: ${bad.join(', ')}` };
  return { ok: true, detail: `${checked} .so entries 4-byte aligned${abis.length ? ` (${abis.join(', ')})` : ''}` };
}

/**
 * Everything aapt2 linked (manifest, resources.arsc and the compiled `res/**` entries, e.g. the launcher icons)
 * plus the entries this build adds. A hand-written ZIP writer is used instead of `jar` because the APK layout is
 * exact: `lib/**` must be *stored* and page-aligned, and an earlier `jar -C <dir>` repack silently dropped every
 * `res/**` entry aapt2 had produced (the app then failed to load its own launcher icon, and Android refuses to
 * start an application whose manifest references a resource the APK does not contain).
 *
 * @param {{ apkPath: string, fromApk: string, extra: { name: string, data: Buffer, align?: number }[], outPath: string }} opts
 */
async function writeApk({ fromApk, extra, outPath }) {
  const sources = await readCentralDirectory(fromApk);
  const fh = await fsp.open(fromApk, 'r');
  const out = await fsp.open(outPath, 'w');
  const central = [];
  let offset = 0;
  const write = async (buf) => { await out.write(buf, 0, buf.length, offset); offset += buf.length; };

  const addEntry = async (name, data, { align = 1 } = {}) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const pad = align > 1 ? (align - ((offset + 30 + nameBuf.length) % align)) % align : 0;
    const extraField = pad ? Buffer.concat([Buffer.from([0x99, 0x99, pad & 0xff, pad >> 8]), Buffer.alloc(pad)]) : Buffer.alloc(0);
    const localOffset = offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);              // version needed
    header.writeUInt16LE(0, 6);               // flags
    header.writeUInt16LE(0, 8);               // method 0 = stored for every entry
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(extraField.length, 28);
    await write(header);
    await write(nameBuf);
    if (extraField.length) await write(extraField);
    await write(data);
    central.push({ name: nameBuf, crc, size: data.length, localOffset });
    return localOffset;
  };

  // 1. what aapt2 produced, in its own order (AndroidManifest.xml first, then resources.arsc, then res/**).
  //    Its entries are read (and inflated) here and written again as stored: the game's art is already compressed,
  //    so a second deflate pass would cost build time and disk writes for a few kilobytes.
  for (const [name, e] of sources.entries) {
    if (name.endsWith('/')) continue;
    const data = await readEntry({ fh }, e);
    await addEntry(name, data);
  }
  // 2. classes.dex, the native libraries and the game itself (the .so files need their 4-byte alignment)
  for (const item of extra) await addEntry(item.name, item.data, { align: item.align ?? 1 });
  await fh.close();

  // central directory + end-of-central-directory
  const cdStart = offset;
  for (const e of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);              // version made by
    header.writeUInt16LE(20, 6);              // version needed
    header.writeUInt16LE(0, 8);               // flags
    header.writeUInt16LE(0, 10);              // method 0 = stored
    header.writeUInt32LE(e.crc, 16);
    header.writeUInt32LE(e.size, 20);
    header.writeUInt32LE(e.size, 24);
    header.writeUInt16LE(e.name.length, 28);
    header.writeUInt32LE(e.localOffset, 42);
    await write(header);
    await write(e.name);
  }
  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  await write(eocd);
  await out.close();
  return { entries: central.length, bytes: offset };
}

/** CRC32 (the ZIP variant) without a dependency; Node 20+ has zlib.crc32 but Node 18 does not. */
function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
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

/**
 * Read the APK's central directory: entry name → { method, crc, sizes, localOffset }.
 * Used both to inspect a finished APK and to copy what aapt2 produced into the final one.
 * @param {string | { fh: import('node:fs/promises').FileHandle }} src
 */
async function readCentralDirectory(src) {
  const own = typeof src === 'string';
  const fh = own ? await fsp.open(src, 'r') : src.fh;
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 66560);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('no ZIP end-of-central-directory record (not a ZIP?)');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const entries = new Map();
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
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      let localOffset = cd.readUInt32LE(p + 42);
      let extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      while (extra.length >= 4) { // ZIP64 extra field
        const id = extra.readUInt16LE(0);
        const len = extra.readUInt16LE(2);
        if (id === 0x0001) { localOffset = Number(extra.readBigUInt64LE(4)); break; }
        extra = extra.subarray(4 + len);
      }
      entries.set(name, { method, crc, compressedSize, uncompressedSize, stored: method === 0, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    if (entries.size !== count) throw new Error(`central directory truncated (${entries.size}/${count})`);
    return { entries, size };
  } finally {
    if (own) await fh.close();
  }
}

/** Read and decompress one entry of an already-opened ZIP (verifying size and CRC). */
async function readEntry({ fh }, entry) {
  const header = Buffer.alloc(30);
  await fh.read(header, 0, 30, entry.localOffset);
  if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`bad local header for ${entry.name ?? ''}`);
  const start = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const raw = Buffer.alloc(entry.compressedSize);
  if (entry.compressedSize) await fh.read(raw, 0, entry.compressedSize, start);
  const data = entry.method === 0 ? raw : zlib.inflateRawSync(raw);
  if (data.length !== entry.uncompressedSize) throw new Error(`size mismatch in ${entry.name ?? ''}`);
  if (crc32(data) !== (entry.crc >>> 0)) throw new Error(`CRC mismatch in ${entry.name ?? ''}`);
  return data;
}

async function verifyApk(apk, { apksigner, aapt2, abis, expectedArt, expectNode }) {
  const problems = [];
  const notes = [];

  // Every `@type/name` the manifest references must really exist in the packaged resources. A missing one (e.g. a
  // `@xml/…` file that was referenced but never written) compiles fine and then makes Android refuse to start the
  // application — exactly the crash this check exists to prevent.
  const manifestSrc = await fsp.readFile(path.join(BUILD, 'android', 'AndroidManifest.xml'), 'utf8');
  const refs = [...new Set([...manifestSrc.matchAll(/[@?](string|style|color|mipmap|drawable|xml|layout|array|bool|integer)\/([A-Za-z0-9_.]+)/g)]
    .map((m) => `${m[1]}/${m[2]}`))];
  if (refs.length) {
    const dump = run(aapt2, ['dump', 'resources', apk], { capture: true, allowFail: true }).out;
    for (const ref of refs) {
      const [type, name] = ref.split('/');
      if (!new RegExp(`${type}\\/[^\\s]*${name}\\b`).test(dump)) problems.push(`the manifest references @${ref}, but the APK has no such resource`);
    }
    // …and the resource table must actually carry the files it points at (aapt2 says so with a warning)
    const missing = [...dump.matchAll(/is a file reference to '([^']+)' but no such path exists/g)].map((m) => m[1]);
    if (missing.length) problems.push(`the resource table points at files that are not in the APK: ${[...new Set(missing)].join(', ')}`);
  }
  notes.push(`manifest resource references checked: ${refs.length ? refs.join(', ') : 'none'}`);

  // signature
  const sign = run(apksigner, ['verify', '--verbose', apk], { capture: true, allowFail: true });
  if (!/Verified using v2 scheme \(APK Signature Scheme v2\): true/.test(sign.out) && !/Verifies/.test(sign.out)) problems.push(`apksigner: ${sign.out.split('\n').slice(-6).join(' ')}`);
  const certs = run(apksigner, ['verify', '--print-certs', apk], { capture: true, allowFail: true });
  const signer = /Signer #1 certificate DN: (.*)/.exec(certs.out)?.[1]?.trim() || '?';

  // badging / manifest
  const badging = run(aapt2, ['dump', 'badging', apk], { capture: true, allowFail: true }).out;
  const pkgLine = /^package: (.*)$/m.exec(badging)?.[1] || '';
  const sdkLine = /sdkVersion:'(\d+)'[\s\S]*?targetSdkVersion:'(\d+)'/.exec(badging);
  if (!pkgLine.includes(`name='${APP.package}'`)) problems.push(`unexpected package line: ${pkgLine}`);
  if (!/application-label-zh-CN:'|application-label:'/.test(badging)) problems.push('no application label in badging');
  const perms = [...badging.matchAll(/uses-permission: name='([^']+)'/g)].map((m) => m[1]);
  if (!perms.includes('android.permission.INTERNET')) problems.push('INTERNET permission missing (LAN co-op would fail)');
  const xmltree = run(aapt2, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apk], { capture: true, allowFail: true }).out;
  if (!/extractNativeLibs[^\n]*0xffffffff|extractNativeLibs[^\n]*\(type 0x12\)0xffffffff/.test(xmltree) && !/extractNativeLibs/.test(xmltree)) notes.push('extractNativeLibs not visible in the manifest dump');
  if (!/usesCleartextTraffic/.test(xmltree)) notes.push('usesCleartextTraffic not visible in the manifest dump');

  // entries
  const { entries, size } = await readCentralDirectory(apk);
  const need = ['classes.dex', 'resources.arsc', 'AndroidManifest.xml', 'assets/nodejs-project/mobile/node/main.js', 'assets/nodejs-project/public/index.html', 'assets/nodejs-project/data/chess.json', 'assets/nodejs-project/server/index.js', 'assets/nodejs-project/shared/constants.js', 'assets/nodejs-project/shell/index.html', 'assets/nodejs-project/shell/shell.js', 'assets/nodejs-project/shell/shell.css'];
  if (expectNode) {
    need.push('assets/nodejs-project/node_modules/ws/package.json', 'assets/nodejs-project/node_modules/ws/lib/websocket.js');
    // every entry point the package's own export map references must be packaged (a missing `wrapper.mjs` is
    // exactly how the first on-device run failed)
    const wsPkg = JSON.parse(await fsp.readFile(path.join(REPO, 'node_modules', 'ws', 'package.json'), 'utf8'));
    for (const target of Object.values(wsPkg.exports || {})) {
      const rel = typeof target === 'string' ? target : (target && (target.import || target.require || target.default));
      if (typeof rel === 'string') need.push(`assets/nodejs-project/node_modules/ws/${rel.replace(/^\.\//, '')}`);
    }
    for (const abi of abis) {
      // every runtime file must have the Android-legal `lib*.so` shape, or it is never extracted (see stageRuntime)
      need.push(`lib/${abi}/libnode.so`);
      for (const lib of RUNTIME_LIBS) need.push(`lib/${abi}/${lib}`);
    }
  }
  need.push('res/mipmap-mdpi-v4/ic_launcher.png', 'res/mipmap-xxxhdpi-v4/ic_launcher.png');
  for (const n of need) if (!entries.has(n)) problems.push(`missing entry: ${n}`);

  // ZIP64? a >4 GB APK would need it; ZIP64 entries would confuse the plain reader above
  const nodeFiles = [...entries.keys()].filter((n) => n.startsWith('assets/nodejs-project/'));
  const artFiles = nodeFiles.filter((n) => /^assets\/nodejs-project\/public\/(assets|fonts|vendor)\//.test(n));
  if (expectedArt && artFiles.length < expectedArt) problems.push(`only ${artFiles.length} of ${expectedArt} manifest art files are packaged`);

  // the native libraries must be stored (uncompressed) so Android extracts and executes them
  for (const abi of abis) {
    for (const [name, e] of entries) {
      if (!name.startsWith(`lib/${abi}/`)) continue;
      if (!e.stored) problems.push(`${name} is compressed (Android only extracts stored native libraries)`);
    }
  }
  const compressedAssets = nodeFiles.filter((n) => entries.get(n)?.stored === false);
  if (compressedAssets.length) notes.push(`${compressedAssets.length} assets/nodejs-project entries are compressed`);

  notes.push(`${entries.size} entries, ${bytes(size)}, signer ${signer}`);
  if (sdkLine) notes.push(`minSdk ${sdkLine[1]}, targetSdk ${sdkLine[2]}`);
  notes.push(`permissions: ${perms.join(', ') || 'none'}`);
  notes.push(`nodejs-project files: ${nodeFiles.length} (art+vendor+fonts: ${artFiles.length})`);
  return { ok: problems.length === 0, problems, notes, entries: entries.size, size, signer, badging, permissions: perms };
}

// ---------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const o = {
    // arm64-v8a only by default: that is what a phone needs, and Android ignores the other ABIs anyway, so the
    // x86_64 copy (emulators) is opt-in via --all-abis — it adds ~88 MB and only matters for MuMu/LDPlayer/
    // BlueStacks/the AOSP images. `--abi=<list>` overrides both.
    abis: [...DEFAULT_ABIS],
    explicitAbis: false,
    out: null, withDev: false, node: true, dex: true, download: true, toolchain: null, json: null, help: false,
    mode: 'build',            // 'build' | 'prepare' | 'check'
    fetchAssets: 'ask',       // 'ask' | 'always' | 'never'
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(0, eq) : a;
    const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
    // `--out <file>` and `--out=<file>` are both accepted; a flag value is never another `--flag`
    const value = () => (inline !== undefined ? inline : (argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[++i] : ''));
    if (key === '--abi') { o.abis = String(value() || '').split(',').map((s) => ABI_ALIASES[s.trim()]).filter(Boolean); o.explicitAbis = true; }
    else if (key === '--all-abis' || key === '--abis' || key === '--with-x86' || key === '--x86') o.abis = [...ALL_ABIS];
    else if (key === '--out') o.out = value();
    else if (key === '--with-dev') o.withDev = true;
    else if (key === '--no-node' || key === '--no-nodejs-mobile') o.node = false;
    else if (key === '--skip-dex') o.dex = false;
    else if (key === '--no-download') o.download = false;
    else if (key === '--toolchain') o.toolchain = path.resolve(value());
    else if (key === '--json') o.json = value();
    else if (key === '--prepare' || key === '--prepare-only') o.mode = 'prepare';
    else if (key === '--check' || key === '--selftest') o.mode = 'check';
    else if (key === '--fetch-assets') o.fetchAssets = 'always';
    else if (key === '--no-fetch-assets') o.fetchAssets = 'never';
    else if (key === '--help' || key === '-h') o.help = true;
    else throw new Error(`unknown option ${a} (try --help)`);
  }
  if (!o.abis.length) o.abis = [...DEFAULT_ABIS];
  if (!o.node) o.abis = [];
  if (o.mode === 'check') o.fetchAssets = 'never';
  return o;
}

/**
 * Step 0 of the one-command flow: make a fresh clone ready without the user running anything else.
 *
 *   * `npm install` when node_modules (or the vendored client libraries) is missing;
 *   * `node tools/fetch-assets.mjs` when the art is missing — ~250 MB, resumable, and skipped entirely with
 *     `--no-fetch-assets`. Without art the game still runs, but with placeholder visuals, so the packager asks
 *     before doing it in a terminal and simply does it when it is not a terminal (CI, `npm run apk`).
 */
async function ensureRepositoryReady(o) {
  const missing = [];
  for (const [what, rel] of [['node_modules', 'node_modules'], ['public/vendor', 'public/vendor'], ['data/chess.json', 'data/chess.json']]) {
    if (!exists(path.join(REPO, rel))) missing.push(what);
  }
  if (missing.length && !o.download) fail(`missing ${missing.join(', ')} — run \`npm install\` first (or drop --no-download)`);
  if (missing.length) {
    step('0', `preparing the repository (${missing.join(', ')} missing)`);
    const r = run('npm', ['install', '--no-audit', '--no-fund'], { env: { npm_config_loglevel: 'warn' }, allowFail: true });
    if (!r.ok) fail('`npm install` failed — run it by hand to see the error');
    for (const [what, rel] of [['node_modules', 'node_modules'], ['public/vendor', 'public/vendor']]) {
      if (!exists(path.join(REPO, rel))) fail(`${what} is still missing after npm install`);
    }
    ok('dependencies installed (public/vendor populated by the postinstall)');
  }

  const assets = path.join(REPO, 'public', 'assets');
  const haveArt = exists(assets) && fs.readdirSync(assets).length > 0;
  if (haveArt && o.fetchAssets !== 'always') return;
  if (o.fetchAssets === 'never') {
    if (!haveArt) warn('public/assets is missing: the APK will fall back to placeholder visuals (--no-fetch-assets)');
    return;
  }
  step('0b', haveArt ? 'refreshing the game art' : 'downloading the game art (~250 MB, resumable)');
  const r = run(process.execPath, [path.join(REPO, 'tools', 'fetch-assets.mjs')], { allowFail: true });
  if (!r.ok || !exists(assets)) warn('the art download did not finish: the APK will use placeholder visuals (re-run to resume)');
  else ok('game art ready');
}

function help() {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const start = src.findIndex((l) => l.startsWith('//   node mobile/build-apk.mjs'));
  const end = src.findIndex((l, i) => i > start && l.startsWith('// Nothing outside'));
  return src.slice(start, end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
}

/**
 * `--check`: verify without building. This is the "is this clone able to produce an APK?" question, answered
 * against the *local* files (module graph, art completeness, manifest resource references, platform binaries).
 */
async function selfCheck(o) {
  const checks = [];
  const check = (name, fn) => {
    try {
      const detail = fn();
      checks.push({ name, ok: true, detail: detail || '' });
      ok(`${name}${detail ? ` — ${detail}` : ''}`);
    } catch (e) {
      checks.push({ name, ok: false, detail: e.message });
      log(`\x1b[31m  ✘\x1b[0m ${name} — ${e.message}`);
    }
  };
  const need = (cond, msg) => { if (!cond) throw new Error(msg); };
  const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

  log(`\n\x1b[1m卫戍协议：盟约 · Android packager self-check\x1b[0m  (${REPO})`);
  step('check', 'repository, runtime sources, art and module graph');

  check('node version (>= 22, matching package.json engines)', () => {
    const major = Number(process.versions.node.split('.')[0]);
    need(major >= 22, `node ${process.versions.node} is too old`);
    return `node ${process.versions.node}`;
  });
  check('package.json name/version', () => {
    const pkg = readJson(path.join(REPO, 'package.json'));
    need(pkg.main === 'server/index.js', `unexpected main: ${pkg.main}`);
    return `${pkg.name} v${pkg.version}`;
  });
  check('server + shared + client sources', () => {
    for (const rel of ['server/index.js', 'server/net.js', 'shared/constants.js', 'shared/protocol.js', 'public/index.html', 'public/js/main.js', 'data/chess.json']) {
      need(exists(path.join(REPO, rel)), `missing ${rel}`);
    }
    return 'server/, shared/, public/, data/ present';
  });
  check('vendored client libraries (public/vendor)', () => {
    for (const f of ['pixi.min.js', 'pixi-spine.js', 'preact.module.js', 'hooks.module.js', 'htm.module.js']) {
      need(exists(path.join(REPO, 'public', 'vendor', f)), `missing public/vendor/${f} — run npm install`);
    }
    return 'pixi, pixi-spine, preact, htm';
  });
  check('server dependency `ws` (resolvable from server/index.js)', () => {
    const ws = path.join(REPO, 'node_modules', 'ws');
    need(exists(path.join(ws, 'package.json')), 'node_modules/ws is missing — run npm install');
    const pkg = readJson(path.join(ws, 'package.json'));
    for (const [, target] of Object.entries(pkg.exports || {})) {
      const rel = typeof target === 'string' ? target : (target && (target.import || target.require || target.default));
      if (typeof rel === 'string') need(exists(path.join(ws, rel)), `ws export ${rel} is not installed`);
    }
    return `ws v${pkg.version} with its export map intact`;
  });
  check('game art complete (data/assets.json)', () => {
    const manifest = readJson(path.join(REPO, 'data', 'assets.json'));
    const urls = [...new Set(manifestUrls(manifest))];
    need(urls.length > 0, 'data/assets.json lists no art');
    const missing = urls.filter((u) => {
      const p = path.join(REPO, 'public', ...u.split('/').filter(Boolean).map(decodeURIComponent));
      try { return !fs.statSync(p).size; } catch { return true; }
    });
    need(missing.length === 0, `${missing.length}/${urls.length} art files missing — run node tools/fetch-assets.mjs (e.g. ${missing.slice(0, 3).join(', ')})`);
    return `${urls.length} files`;
  });
  check('Android resources and activity', () => {
    for (const rel of ['android/java/io/prts/stronghold/MainActivity.java', 'android/res/mipmap-mdpi/ic_launcher.png', 'android/res/mipmap-xxxhdpi/ic_launcher.png', 'tools/make-icons.mjs', 'node/main.js']) {
      need(exists(path.join(HERE, rel)), `missing mobile/${rel}`);
    }
    return 'MainActivity, launcher icons, mobile entry point';
  });
  check('connect shell (本地 / 远程 entry)', () => {
    for (const rel of ['shell/index.html', 'shell/shell.css', 'shell/shell.js', 'shell/util.js', 'shell/README.md']) {
      need(exists(path.join(HERE, rel)), `missing mobile/${rel}`);
    }
    const html = fs.readFileSync(path.join(HERE, 'shell', 'index.html'), 'utf8');
    for (const needle of ['btn-local', 'btn-remote', '/connect/shell.css', '/connect/shell.js', 'type="importmap"', 'id="app"']) {
      need(html.includes(needle), `mobile/shell/index.html is missing ${needle}`);
    }
    // the shell's spacing must stay inside the client's own scale, so it matches at every resolution
    const css = fs.readFileSync(path.join(HERE, 'shell', 'shell.css'), 'utf8');
    need(/rem/.test(css) && /@media/.test(css), 'mobile/shell/shell.css has no rem sizes / no media queries');
    return 'index.html + shell.css + shell.js + util.js';
  });
  check('packaged runtime sources (Termux packages)', () => {
    const node = TERMUX.packages.find((p) => p.bins);
    need(!!node, 'no Node package configured');
    const libs = TERMUX.packages.flatMap((p) => Object.values(p.libs || {}));
    for (const want of ['libc++_shared.so', 'libcrypto.so.3', 'libssl.so.3', 'libicudata.so.78', 'libcares.so', 'libsqlite3.so', 'libz.so.1']) {
      need(libs.includes(want), `runtime library ${want} is not configured`);
    }
    for (const abi of DEFAULT_ABIS) need(!!ABI_TERMUX[abi], `no Termux architecture for ${abi}`);
    return `${node.pkg} + ${libs.length} libraries for ${DEFAULT_ABIS.join(' + ')} from ${TERMUX.base.replace(/^https?:\/\//, '')}`;
  });
  check('Android SDK toolchain', () => {
    if (!o.download) return 'skipped (--no-download)';
    const toolchain = resolveToolchain(o.toolchain);
    const jdk = findJavaHome(toolchain);
    need(!!jdk, `no JDK 17+ found (looked in ${toolchain}/jdk and the usual places)`);
    const bt = path.join(toolchain, 'android-sdk', 'build-tools', TOOLS.buildTools);
    const jar = path.join(toolchain, 'android-sdk', 'platforms', TOOLS.platform, 'android.jar');
    if (!exists(bt) || !exists(jar)) return `JDK ok; SDK not installed yet (first build fetches build-tools ${TOOLS.buildTools} + ${TOOLS.platform})`;
    for (const f of ['aapt2.exe', 'd8.bat', 'zipalign.exe', 'apksigner.bat']) {
      const p = path.join(bt, f);
      const alt = path.join(bt, f.replace(/\.(exe|bat)$/, ''));
      need(exists(p) || exists(alt), `build-tools ${TOOLS.buildTools} is incomplete (${f})`);
    }
    return `JDK ${jdk.version}, build-tools ${TOOLS.buildTools}, ${TOOLS.platform}`;
  });
  check('host tools for the runtime unpack (tar, xz)', () => {
    for (const tool of ['tar', 'xz']) {
      const r = run(tool, ['--version'], { capture: true, allowFail: true });
      need(r.ok, `\`${tool}\` is not available on PATH (needed to unpack the Termux packages)`);
    }
    return 'tar + xz';
  });
  check('code signing key', () => (exists(KEYSTORE) ? 'mobile/keystore/debug.keystore (generated)' : 'will be generated on the first build'));

  const failed = checks.filter((c) => !c.ok);
  log(`\n${failed.length ? `\x1b[31m✘ ${failed.length} of ${checks.length} checks failed\x1b[0m` : `\x1b[32m✔ all ${checks.length} checks passed — \`npm run apk\` will produce a signed APK\x1b[0m`}\n`);
  return { ok: failed.length === 0, checks };
}

/** The toolchain root: --toolchain, else $SP_TOOLCHAIN, else <workspace>/.toolchain, else <repo>/.toolchain. */
function resolveToolchain(explicit) {
  if (explicit) return explicit;
  return [process.env.SP_TOOLCHAIN, path.join(path.dirname(REPO), '.toolchain'), path.join(REPO, '.toolchain')]
    .find((d) => d && exists(d)) || path.join(path.dirname(REPO), '.toolchain');
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); return 2; }
  if (o.help) { console.log(help()); return 0; }

  const t0 = Date.now();
  const pkg = JSON.parse(await fsp.readFile(path.join(REPO, 'package.json'), 'utf8'));
  APP.versionName = pkg.version;
  const toolchain = resolveToolchain(o.toolchain);
  await fsp.mkdir(BUILD, { recursive: true });

  if (o.mode === 'check') {
    const result = await selfCheck(o);
    if (o.json) await fsp.writeFile(path.resolve(o.json), JSON.stringify({ ...result, at: new Date().toISOString() }, null, 1));
    return result.ok ? 0 : 1;
  }

  const report = { startedAt: new Date().toISOString(), repo: REPO, toolchain, abis: o.abis, node: process.versions.node, mode: o.mode, steps: [] };
  const record = (name, data) => { report.steps.push({ name, ...data }); };

  log(`\n\x1b[1m卫戍协议：盟约 · Android APK\x1b[0m  v${APP.versionName}   (${REPO})`);
  log(`  toolchain: ${toolchain}`);
  log(`  ABIs:      ${o.abis.join(', ') || '(none: client-only APK)'}`);
  log(`  mode:      ${o.mode}`);

  // 0. one-command setup: dependencies and the game art
  await ensureRepositoryReady(o);

  // 0. prerequisites
  step('1', 'checking the repository is prepared');
  for (const [what, p] of [['node_modules', path.join(REPO, 'node_modules')], ['public/vendor', path.join(REPO, 'public', 'vendor')], ['public/assets', path.join(REPO, 'public', 'assets')], ['data/chess.json', path.join(REPO, 'data', 'chess.json')]]) {
    if (!exists(p)) fail(`${what} is missing — run \`npm install\` and \`node tools/fetch-assets.mjs\` first (${p})`);
  }
  ok('node_modules, public/vendor, public/assets and data/ are present');

  // 1. toolchain
  step('1b', 'resolving the Android toolchain');
  const javaHome = await ensureJdk(toolchain, o.download);
  const sdk = await ensureSdk(toolchain, javaHome, o.download);
  const env = { ...sdk.env, JAVA_HOME: javaHome };
  const javaBin = (n) => path.join(javaHome, 'bin', process.platform === 'win32' ? `${n}.exe` : n);
  ok(`aapt2 ${TOOLS.buildTools}, ${TOOLS.platform}, javac at ${javaHome}`);

  // 2. the Node runtime (Termux Node 24 + its shared libraries), one per packaged ABI
  const runtimes = new Map();
  if (o.node) {
    step('2', `fetching the Node runtime for ${o.abis.join(', ')} (Termux nodejs-lts)`);
    for (const abi of o.abis) runtimes.set(abi, await fetchTermuxNode(toolchain, abi, o.download));
  }

  // 3. the assets tree
  step('3', 'assembling assets/nodejs-project');
  const prepared = await prepareNodejsProject({ withDev: o.withDev, abis: o.abis });
  const artUrls = await assertArtComplete(prepared.dir);

  if (o.mode === 'prepare') {
    const size = await dirSize(prepared.dir);
    let rtFiles = 0;
    let rtBytes = 0;
    for (const abi of o.abis) {
      const d = await dirSize(path.join(BUILD, 'runtime', abi));
      rtFiles += d.files;
      rtBytes += d.bytes;
    }
    const nodeVersions = [...new Set([...runtimes.values()].map((r) => r.node))];
    log(`\n\x1b[32m\x1b[1m✔ preparation complete\x1b[0m`);
    log(`  toolchain   ${toolchain}`);
    log(`  runtime     Node ${nodeVersions.join(' / ') || '(skipped)'} · ${rtFiles} files · ${bytes(rtBytes)}  (${o.abis.join(', ')})`);
    log(`  packaged    ${size.files} files · ${bytes(size.bytes)} (assets/nodejs-project)`);
    log(`  next        node mobile/build-apk.mjs          build the APK`);
    log(`              node mobile/build-apk.mjs --check  verify without building\n`);
    if (o.json) await fsp.writeFile(path.resolve(o.json), JSON.stringify({ ...report, prepared: { files: size.files, bytes: size.bytes }, runtime: nodeVersions }, null, 1));
    return 0;
  }

  // 4. android project
  step('4', 'writing the Android project (manifest, resources, sources)');
  const gen = await writeAndroidProject({ abis: o.abis, versionName: APP.versionName, packageName: APP.package });
  ok(`${path.relative(REPO, gen)}`);

  // 5. resources
  step('5', 'aapt2 compile + link');
  const resZip = path.join(BUILD, 'res.zip');
  run(sdk.aapt2, ['compile', '--dir', path.join(gen, 'res'), '-o', resZip], { env });
  const unsigned = path.join(BUILD, 'app-unsigned.apk');
  const linkArgs = [
    'link', '-o', unsigned,
    '-I', sdk.androidJar,
    '--manifest', path.join(gen, 'AndroidManifest.xml'),
    '--java', path.join(BUILD, 'gen'),
    '--custom-package', APP.package,
    '--min-sdk-version', TOOLS.minSdk,
    '--target-sdk-version', TOOLS.targetSdk,
    '--version-code', String(APP.versionCode),
    '--version-name', APP.versionName,
    '--no-version-vectors',
    resZip,
  ];
  run(sdk.aapt2, linkArgs, { env });
  if (!exists(unsigned)) fail('aapt2 link produced no APK');
  ok(`resources linked (${bytes(fs.statSync(unsigned).size)})`);

  // 6. java + dex
  const dexDir = path.join(BUILD, 'dex');
  if (o.dex) {
    step('6', 'javac + d8');
    await fsp.mkdir(dexDir, { recursive: true });
    const javaFiles = [];
    const walkJava = async (d) => {
      for (const e of await fsp.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walkJava(p);
        else if (e.name.endsWith('.java')) javaFiles.push(p);
      }
    };
    await walkJava(path.join(gen, 'src'));
    if (exists(path.join(BUILD, 'gen'))) await walkJava(path.join(BUILD, 'gen'));
    if (!javaFiles.length) fail('no Java sources to compile');
    const classDir = path.join(BUILD, 'classes');
    await fsp.mkdir(classDir, { recursive: true });
    // Compile against Android, not the JDK: `-source`/`-target` 8 keeps d8 happy (it desugars), and the boot
    // classpath is android.jar plus build-tools' core-lambda-stubs.jar (lambdas on Android target java.lang.invoke,
    // which android.jar does not declare). Verified with JDK 21 + build-tools 34.
    const lambdaStubs = path.join(sdk.bt, 'core-lambda-stubs.jar');
    const bootClassPath = [sdk.androidJar, exists(lambdaStubs) ? lambdaStubs : null].filter(Boolean).join(path.delimiter);
    run(javaBin('javac'), ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-nowarn', '-Xlint:-options',
      '-bootclasspath', bootClassPath, '-d', classDir, ...javaFiles], { env, capture: false });
    const classes = [];
    const walkClass = async (d) => {
      for (const e of await fsp.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walkClass(p);
        else if (e.name.endsWith('.class')) classes.push(p);
      }
    };
    await walkClass(classDir);
    run(sdk.d8, ['--min-api', TOOLS.minSdk, '--lib', sdk.androidJar, '--output', dexDir, ...classes], { env });
    if (!exists(path.join(dexDir, 'classes.dex'))) fail('d8 produced no classes.dex');
    ok(`classes.dex ${bytes(fs.statSync(path.join(dexDir, 'classes.dex')).size)} (${classes.length} classes)`);
  } else {
    warn('--skip-dex: reusing the previous classes.dex if present');
    if (!exists(path.join(dexDir, 'classes.dex'))) fail('--skip-dex but no previous dex exists');
  }

  // 7. the runtime in jniLibs (Android extracts `lib/**` into the app's executable native library directory)
  const jniLibs = path.join(gen, 'jniLibs');
  if (o.node) {
    step('7', `staging the Node runtime in ${o.abis.map((a) => `lib/${a}/`).join(', ')}`);
    for (const abi of o.abis) await stageRuntime({ runtime: runtimes.get(abi), abi, jniLibs });
  }

  // 8. package the APK: aapt2's manifest/resources/icons + classes.dex + lib/** + assets/nodejs-project/**
  step('8', 'packaging (manifest, res/**, resources.arsc, classes.dex, lib/**, assets/**)');
  // The file name carries the ABIs it actually contains, so the phone build and the phone+emulator build can sit
  // in the same directory without overwriting each other.
  const abiTag = o.abis.length ? o.abis.join('-') : 'client-only';
  const apkOut = o.out ? path.resolve(o.out) : path.join(BUILD, `Stronghold-Protocol-${APP.versionName}-${abiTag}.apk`);
  await fsp.mkdir(path.dirname(apkOut), { recursive: true });
  await fsp.rm(apkOut, { force: true });
  const extra = [{ name: 'classes.dex', data: await fsp.readFile(path.join(dexDir, 'classes.dex')) }];
  if (o.node) {
    for (const abi of o.abis) {
      const dir = path.join(jniLibs, abi);
      for (const f of (await fsp.readdir(dir)).sort()) {
        extra.push({ name: `lib/${abi}/${f}`, data: await fsp.readFile(path.join(dir, f)), align: 4 });
      }
    }
  }
  // the game itself: the prepared nodejs-project becomes `assets/nodejs-project/**` (the one unavoidable copy)
  let assetFiles = 0;
  const addTree = async (dir, prefix) => {
    for (const e of (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await addTree(p, `${prefix}/${e.name}`);
      else if (e.isFile()) { extra.push({ name: `${prefix}/${e.name}`, data: await fsp.readFile(p) }); assetFiles++; }
    }
  };
  await addTree(prepared.dir, 'assets/nodejs-project');
  const written = await writeApk({ fromApk: unsigned, extra, outPath: apkOut });
  ok(`packaged ${written.entries} entries (${assetFiles} game files) · ${bytes(written.bytes)}`);

  // 9. align + sign
  step('9', 'zipalign + apksigner');
  const aligned = path.join(BUILD, 'app-aligned.apk');
  await fsp.rm(aligned, { force: true });
  // `-p` = page-align the uncompressed native libraries (they are already 4-byte aligned by the package writer).
  const zipAlign = run(sdk.zipalign, ['-f', '-p', '4', apkOut, aligned], { env, allowFail: true });
  if (!exists(aligned)) run(sdk.zipalign, ['-f', '4', apkOut, aligned], { env });
  if (!exists(aligned)) fail(`zipalign produced no output:\n${zipAlign.out}`);
  const alignment = await checkAlignment(aligned, o.abis);
  if (!alignment.ok) fail(alignment.problem);
  ok(`aligned (${alignment.detail})`);
  const store = await ensureKeystore(javaHome);
  await fsp.rm(apkOut, { force: true });
  run(sdk.apksigner, ['sign', '--ks', KEYSTORE, '--ks-pass', `pass:${store.password}`, '--key-pass', `pass:${store.password}`,
    '--ks-key-alias', store.alias, '--min-sdk-version', TOOLS.minSdk,
    '--v1-signing-enabled', 'false', '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true',
    '--out', apkOut, aligned], { env });
  await fsp.rm(aligned, { force: true });
  ok(`signed: ${path.relative(REPO, apkOut)}`);

  // 10. verify
  step('10', 'verifying the APK');
  const v = await verifyApk(apkOut, { apksigner: sdk.apksigner, aapt2: sdk.aapt2, abis: o.abis, expectedArt: artUrls, expectNode: o.node });
  for (const n of v.notes) log(`    · ${n}`);
  if (!v.ok) { for (const p of v.problems) fail(p); }
  ok('APK verified');

  const sha = crypto.createHash('sha256').update(await fsp.readFile(apkOut)).digest('hex');
  const sums = path.join(path.dirname(apkOut), 'SHA256SUMS.txt');
  await fsp.writeFile(sums, `${sha}  ${path.basename(apkOut)}\n`);
  const total = await dirSize(path.join(BUILD, 'nodejs-project'));

  record('built', { apk: apkOut, bytes: v.size, sha256: sha, entries: v.entries, signer: v.signer, artUrls });
  report.finishedAt = new Date().toISOString();
  report.durationSec = Math.round((Date.now() - t0) / 1000);
  report.apk = { path: apkOut, bytes: v.size, sha256: sha, signer: v.signer, entries: v.entries, permissions: v.permissions };
  report.assets = { files: total.files, bytes: total.bytes };
  if (o.json) await fsp.writeFile(path.resolve(o.json), JSON.stringify(report, null, 1));

  log(`\n\x1b[32m\x1b[1m✔ done\x1b[0m  ${path.relative(REPO, apkOut)}`);
  log(`  size      ${bytes(v.size)}   (assets tree ${bytes(total.bytes)}, ${total.files} files)`);
  log(`  sha256    ${sha}`);
  log(`  version   ${APP.versionName} (${APP.package}), ABIs ${o.abis.join(', ') || 'none'}`);
  log(`  install   adb install -r "${apkOut}"   (or copy it to the phone and open it)`);
  log(`  sums      ${path.relative(REPO, sums)}`);
  if (!o.explicitAbis && o.abis.length === 1 && o.abis[0] === 'arm64-v8a') {
    log(`  \x1b[2mfor an Android emulator (x86_64) build both ABIs: npm run apk:all\x1b[0m`);
  }
  log('');
  return 0;
}

async function ensureKeystore(javaHome) {
  const password = 'android';
  const alias = 'androiddebugkey';
  await fsp.mkdir(KEYSTORE_DIR, { recursive: true });
  if (exists(KEYSTORE)) {
    const readme = path.join(KEYSTORE_DIR, 'README.md');
    if (!exists(readme)) await fsp.writeFile(readme, KEYSTORE_README(password, alias));
    return { password, alias };
  }
  const keytool = path.join(javaHome, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool');
  const r = run(keytool, ['-genkeypair', '-keystore', KEYSTORE, '-alias', alias, '-keyalg', 'RSA', '-keysize', '2048',
    '-validity', '10950', '-storepass', password, '-keypass', password,
    '-dname', 'CN=Stronghold Protocol (unofficial fan remake), OU=mobile, O=PRTS, L=-, ST=-, C=CN'], { capture: true, allowFail: true });
  if (!exists(KEYSTORE)) fail(`keytool failed:\n${r.out}`);
  await fsp.writeFile(path.join(KEYSTORE_DIR, 'README.md'), KEYSTORE_README(password, alias));
  ok('created mobile/keystore/debug.keystore');
  return { password, alias };
}

const KEYSTORE_README = (password, alias) => `# mobile/keystore — APK signing key (generated by mobile/build-apk.mjs)

    file       debug.keystore
    alias      ${alias}
    password   ${password}   (store password and key password)
    validity   30 years
    subject    CN=Stronghold Protocol (unofficial fan remake), OU=mobile, O=PRTS, C=CN

This is a self-signed **debug** key: it exists only so that Android accepts the APK and so that later builds can
replace an installed copy (Android refuses an update whose signature differs). Builds of this fan project are
non-commercial and must not be distributed through app stores; if you publish your own build, generate your own key
and **keep it out of the repository**:

    keytool -genkeypair -keystore mobile/keystore/release.keystore -alias release -keyalg RSA -keysize 2048 \\
            -validity 10950 -storepass <password> -keypass <password> -dname "CN=<you>"

then sign with \`apksigner sign --ks mobile/keystore/release.keystore …\` instead of re-running this script's default.

The keystore is deliberately **not** committed (.gitignore): anyone can generate their own.
`;

main().then((code) => { process.exitCode = code; }, (e) => {
  console.error(`\n\x1b[31m${e?.message || e}\x1b[0m`);
  if (e?.stack && process.env.DEBUG) console.error(e.stack);
  process.exitCode = 1;
});
