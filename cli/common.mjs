import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGER = path.resolve(HERE, '..');

export function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
export function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
export async function writeJson(p, value) { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, JSON.stringify(value, null, 2) + '\n'); }
export function resolveFrom(base, value) { return path.resolve(base, value || '.'); }
export function fail(message, code = 'PACKAGER_ERROR') { const e = new Error(message); e.code = code; throw e; }

export function classifyBuildFailure(error) {
  if (error?.code && error.code !== 'PACKAGER_ERROR') return error.code;
  const text = String(error?.message || error).toLowerCase();
  if (/overlay patch conflict|overlay contract|does not support master|contract marker/.test(text)) return 'overlay-contract-break';
  if (/asset manifest|assets\.json|local-assets|asset archive|resource manifest/.test(text)) return 'asset-missing-or-mismatch';
  if (/keystore|signing|certificate sha-256|key alias|password/.test(text)) return 'signing-failure';
  if (/apk verification|apk checker|signature|dt_needed|unresolved/.test(text)) return 'apk-verification-failure';
  if (/runtime|toolchain|android sdk|build-tools|jdk|aapt2|d8|zipalign|apksigner/.test(text)) return 'toolchain/runtime-failure';
  return 'apk-build-failure';
}

export function sanitizeDiagnostic(value) {
  let text = String(value || '').replace(/\x1b\[[0-9;]*m/g, '');
  for (const [name, secret] of Object.entries(process.env)) {
    if (/TOKEN|PASSWORD|SECRET|KEYSTORE_B64/i.test(name) && secret && secret.length >= 4) text = text.split(secret).join('[redacted]');
  }
  return text.replace(/(?:Bearer\s+|pass:)[^\s"']+/gi, '[redacted]');
}

export function run(command, args = [], { cwd = PACKAGER, env = {}, capture = true, allowFail = false } = {}) {
  const r = spawnSync(command, args, {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true,
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command), maxBuffer: 128 << 20,
    stdio: capture ? ['pipe', 'pipe', 'pipe'] : 'inherit',
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.error && !allowFail) fail(`${command} failed: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) fail(`${path.basename(command)} exited with ${r.status}\n${out.slice(-4000)}`);
  return { ok: r.status === 0, status: r.status, out };
}

export async function copyTree(source, destination, { filter = () => true } = {}) {
  if (!exists(source)) fail(`missing source path: ${source}`);
  const stat = await fsp.lstat(source);
  if (stat.isSymbolicLink()) fail(`symbolic link is not allowed in staging: ${source}`);
  if (stat.isFile()) { if (filter(source, path.basename(source))) { await fsp.mkdir(path.dirname(destination), { recursive: true }); await fsp.copyFile(source, destination); } return; }
  await fsp.mkdir(destination, { recursive: true });
  for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name); const dst = path.join(destination, entry.name);
    const rel = path.relative(source, src);
    if (!filter(src, rel, entry)) continue;
    if (entry.isDirectory()) await copyTree(src, dst, { filter });
    else if (entry.isFile()) { await fsp.mkdir(path.dirname(dst), { recursive: true }); await fsp.copyFile(src, dst); }
    else if (entry.isSymbolicLink()) fail(`symbolic link is not allowed in staging: ${src}`);
  }
}

export async function removeIfExists(p) { if (exists(p)) await fsp.rm(p, { recursive: true, force: true }); }
export async function hashFile(p) { const h = crypto.createHash('sha256'); h.update(await fsp.readFile(p)); return h.digest('hex'); }
export async function hashTree(root) {
  const rows = [];
  async function walk(dir, rel = '') {
    for (const e of (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = rel ? `${rel}/${e.name}` : e.name; const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, next); else if (e.isFile()) rows.push([next, await hashFile(p)]);
    }
  }
  if (exists(root)) await walk(root);
  const h = crypto.createHash('sha256'); for (const [name, digest] of rows) h.update(name).update('\0').update(digest).update('\0');
  return { digest: h.digest('hex'), files: rows.length };
}

export function parseSemver(value) {
  const m = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(String(value || '').trim());
  if (!m) fail(`master version must be stable SemVer (x.y.z), got ${value || '(empty)'}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), text: `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` };
}
export function versionCode(version, minimum = 4) {
  const v = typeof version === 'string' ? parseSemver(version) : version;
  const code = v.major * 1_000_000 + v.minor * 1_000 + v.patch;
  if (!Number.isSafeInteger(code) || code > 2_100_000_000) fail(`versionCode is outside Android range for ${v.text}`);
  return Math.max(minimum, code);
}

export function loadConfig() {
  const file = path.join(PACKAGER, 'packager.config.json');
  if (!exists(file)) fail(`missing ${file}; copy packager.config.example.json to packager.config.json and configure the master path and signing key`);
  const raw = readJson(file); const base = path.dirname(file);
  return { ...raw, file, masterDir: resolveFrom(base, raw.masterDir), dependencyDir: resolveFrom(base, raw.dependencyDir || raw.masterDir), assetsDir: resolveFrom(base, raw.assetsDir || raw.masterDir), toolchainDir: resolveFrom(base, raw.toolchainDir || '../.toolchain'), runtimeCacheDir: resolveFrom(base, raw.runtimeCacheDir || 'cache/runtime'), outputDir: resolveFrom(base, raw.outputDir || 'outputs'), packageName: raw.packageName || 'io.prts.stronghold', minimumVersionCode: Number(raw.minimumVersionCode || 4) };
}

export function parseArgs(argv) {
  const out = { command: 'build', profile: null, abis: null, apk: null, allowDirty: false, json: null, versionCode: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--allow-dirty') { out.allowDirty = true; continue; }
    if (!a.startsWith('-')) { positional.push(a); continue; }
    const [key, inline] = a.split('=', 2);
    const needsValue = ['--profile', '--abis', '--abi', '--apk', '--json', '--version-code'].includes(key);
    if (!needsValue) fail(`unknown option ${a}`);
    const value = inline ?? argv[++i];
    if (value == null || String(value).startsWith('--')) fail(`${key} requires a value`);
    if (key === '--profile') out.profile = value;
    else if (key === '--abis' || key === '--abi') out.abis = String(value).split(',').filter(Boolean);
    else if (key === '--apk') out.apk = value;
    else if (key === '--json') out.json = value;
    else if (key === '--version-code') {
      const code = Number(value);
      if (!Number.isSafeInteger(code) || code < 1 || code > 2_100_000_000) fail(`invalid --version-code: ${value}`);
      out.versionCode = code;
    }
  }
  if (positional[0]) out.command = positional[0];
  return out;
}

export function gitInfo(masterDir, allowDirty = false) {
  const branch = run('git', ['-C', masterDir, 'branch', '--show-current']).out.trim();
  const status = run('git', ['-C', masterDir, 'status', '--porcelain']).out.trim();
  if (branch !== 'master') fail(`masterDir must be on branch master, got ${branch || '(detached)'}`);
  if (status && !allowDirty) fail(`masterDir has uncommitted changes; refusing to package them:\n${status.slice(0, 2000)}`);
  const commit = run('git', ['-C', masterDir, 'rev-parse', 'HEAD']).out.trim();
  return { branch, clean: !status, status, commit };
}

export function manifestUrls(value, out = []) {
  if (typeof value === 'string' && /^\/(?:assets|fonts)\//.test(value)) out.push(value);
  else if (Array.isArray(value)) for (const x of value) manifestUrls(x, out);
  else if (value && typeof value === 'object') for (const x of Object.values(value)) manifestUrls(x, out);
  return out;
}
