import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fail, writeJson } from '../cli/common.mjs';

export const REPO = process.env.GITHUB_REPOSITORY || 'Fuhua-code/Stronghold-Protocol';
export const UPSTREAM = 'sganggs/Stronghold-Protocol';
export const META_PREFIX = '<!-- stronghold-apk:';
export const ANDROID_MAX = 2_100_000_000;

export function redact(value) {
  let text = String(value ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  for (const [name, secret] of Object.entries(process.env)) {
    if (/TOKEN|PASSWORD|SECRET|KEYSTORE_B64/i.test(name) && secret && secret.length >= 4) text = text.split(secret).join('[redacted]');
  }
  return text.replace(/(?:Bearer\s+|(?:pass:|password=))[^\s"']+/gi, '[redacted]');
}

export async function api(route, { method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
  const res = await fetch(`https://api.github.com${route}`, {
    method, headers: { Accept: accept, 'User-Agent': 'Stronghold-Protocol-Packager', 'X-GitHub-Api-Version': '2022-11-28',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) { const e = new Error(`GitHub API ${method} ${route.split('?')[0]} returned ${res.status}`); e.status = res.status; throw e; }
  return res.status === 204 ? null : res.json();
}

export async function allReleases() {
  const rows = [];
  for (let page = 1; ; page++) {
    const chunk = await api(`/repos/${REPO}/releases?per_page=100&page=${page}`);
    rows.push(...chunk); if (chunk.length < 100) return rows;
  }
}

export function releaseMeta(release) {
  const raw = /<!-- stronghold-apk:(.*?) -->/.exec(release.body || '')?.[1];
  if (!raw) {
    if (/^apk-/.test(release.tag_name)) fail('Automated Release has no version metadata; refusing to reuse its versionCode', 'release-failure');
    return null;
  }
  let m; try { m = JSON.parse(raw); } catch { fail('Malformed automated Release metadata', 'release-failure'); }
  if (m.schema !== 1 || !/^[0-9a-f]{40}$/.test(m.sha) || !Number.isSafeInteger(m.versionCode) || m.versionCode < 1 || m.versionCode > ANDROID_MAX) fail('Invalid automated Release metadata', 'release-failure');
  return m;
}

export async function sha256(file) {
  const h = createHash('sha256'); const handle = await fs.open(file);
  try { for await (const chunk of handle.createReadStream()) h.update(chunk); } finally { await handle.close(); }
  return h.digest('hex');
}

export function safePath(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.startsWith('/') || relative.split('/').some(x => x === '..' || x === '.') || /^[A-Za-z]:/.test(relative)) fail('Unsafe input path', 'asset-missing-or-mismatch');
  const out = path.resolve(root, relative);
  if (!out.startsWith(path.resolve(root) + path.sep)) fail('Input path escaped its root', 'asset-missing-or-mismatch');
  return out;
}

export async function fileManifest(root) {
  const files = [];
  async function walk(dir, rel = '') {
    for (const e of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = rel ? `${rel}/${e.name}` : e.name; const file = safePath(root, name);
      if (e.isDirectory()) await walk(file, name);
      else if (e.isFile()) files.push({ path: name, bytes: (await fs.stat(file)).size, sha256: await sha256(file) });
      else fail('Input bundle contains a symlink or special file', 'asset-missing-or-mismatch');
    }
  }
  await walk(root); return files;
}

export async function outputs(values) {
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k,v]) => `${k}=${v}\n`).join(''));
}

export async function failure(stage, error, meta = {}) {
  const code = error.code && error.code !== 'PACKAGER_ERROR' ? error.code : stage;
  const report = { status: 'failed', code, stage, breaking: code === 'overlay-contract-break', ...meta, message: redact(error.message || error).slice(-4000), runUrl: process.env.GITHUB_RUN_ID ? `https://github.com/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}` : null };
  await writeJson('outputs/automation-failure.json', report);
  console.error(`${code}: ${report.message}`);
}
