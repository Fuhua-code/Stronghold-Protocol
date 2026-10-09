import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { readJson, run, fail, writeJson, exists, manifestUrls } from '../cli/common.mjs';
import { fileManifest, safePath, sha256, failure, REPO } from './lib.mjs';

export async function verifyBundle(root, kind) {
  const manifest = readJson(path.join(root, 'input-manifest.json'));
  if (manifest.schema !== 1 || manifest.kind !== kind || !Array.isArray(manifest.files) || !manifest.files.length) fail('Invalid input manifest', 'asset-missing-or-mismatch');
  if (manifest.version !== undefined && typeof manifest.version !== 'string') fail('Invalid input manifest version metadata', 'asset-missing-or-mismatch');
  const names = new Set();
  for (const row of manifest.files) {
    safePath(root, row.path);
    if (names.has(row.path) || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0) fail('Invalid or duplicate input manifest entry', 'asset-missing-or-mismatch');
    names.add(row.path);
  }
  const actual = (await fileManifest(root)).filter(f => f.path !== 'input-manifest.json');
  const expected = new Map(manifest.files.map(f => [f.path, f]));
  if (actual.length !== expected.size) fail('Input file count mismatch', 'asset-missing-or-mismatch');
  for (const row of actual) {
    const m = expected.get(row.path);
    if (!m || m.sha256 !== row.sha256 || m.bytes !== row.bytes) fail(`Input content mismatch: ${row.path}`, 'asset-missing-or-mismatch');
  }
  if (manifest.totalBytes !== undefined && manifest.totalBytes !== actual.reduce((sum, row) => sum + row.bytes, 0)) fail('Input manifest totalBytes mismatch', 'asset-missing-or-mismatch');
  return manifest;
}

export function archivePaths(list) {
  for (const line of list.split(/\r?\n/).filter(Boolean)) {
    const name = line.replace(/^\.\//, '').replace(/\/$/, '');
    if (!name || name === '.') continue;
    safePath(path.resolve('cache'), name);
  }
}

function normalizePins(value) {
  if (Array.isArray(value?.bundles)) return value.bundles;
  if (value && typeof value === 'object') return Object.entries(value)
    .filter(([key, pin]) => key !== 'bundles' && pin && typeof pin === 'object')
    .map(([version, pin]) => ({ ...pin, sourceVersion: version }));
  return [];
}

function normalizeResourceUrl(url) {
  if (typeof url !== 'string' || !/^\/(?:assets|fonts)\//.test(url)) return null;
  const parts = url.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\\/\0]/.test(part))) fail(`Unsafe resource URL: ${url}`, 'asset-missing-or-mismatch');
  return `public/${parts.join('/')}`;
}

export async function collectAssetReferences(source) {
  const references = new Set();
  for (const name of ['assets.json', 'local-assets.json']) {
    const file = path.join(source, 'data', name);
    if (!exists(file)) continue;
    for (const url of manifestUrls(readJson(file))) {
      const relative = normalizeResourceUrl(url);
      if (relative) references.add(relative);
    }
  }
  return [...references].sort();
}

export async function assessCoverage(root, references, manifest = null) {
  // Source coverage uses a synthetic manifest made from the upstream paths,
  // while downloaded bundles use manifest rows with path/hash metadata.
  // Normalize both shapes before calculating extras so a current upstream
  // checkout can be selected without dereferencing an undefined row.path.
  const listed = new Set((manifest?.files || []).map((row) => typeof row === 'string' ? row : row?.path).filter(Boolean));
  const missing = [];
  for (const relative of references) {
    const file = safePath(root, relative);
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size === 0) missing.push(relative);
    } catch { missing.push(relative); }
  }
  const required = new Set(references);
  const provided = [...listed].filter((relative) => relative.startsWith('public/assets/') || relative.startsWith('public/fonts/'));
  const extra = provided.filter((relative) => !required.has(relative)).sort();
  return { required: references.length, covered: references.length - missing.length, missing, extra, complete: missing.length === 0 };
}

async function restore(pin, kind, destination) {
  const code = kind === 'assets' ? 'asset-missing-or-mismatch' : 'toolchain/runtime-failure';
  if (!pin || !/^[a-f0-9]{64}$/.test(pin.sha256 || '') || !/^[A-Za-z0-9_.-]+\.tar\.gz$/.test(pin.file || '') || !/^[A-Za-z0-9_.-]+$/.test(pin.tag || '')) fail(`Invalid ${kind} Release input`, code);
  const download = path.resolve('cache/downloads', pin.file);
  await fs.mkdir(path.dirname(download), { recursive: true });
  if (!exists(download) || await sha256(download) !== pin.sha256) {
    const res = await fetch(`https://github.com/${REPO}/releases/download/${pin.tag}/${pin.file}`, { signal: AbortSignal.timeout(600_000) });
    if (!res.ok) fail(`${kind} Release download returned HTTP ${res.status}`, code);
    await pipeline(res.body, createWriteStream(download + '.part'));
    if (await sha256(download + '.part') !== pin.sha256) fail(`${kind} archive SHA256 mismatch`, code);
    await fs.rename(download + '.part', download);
  }
  archivePaths(run('tar', ['-tzf', download]).out);
  const verbose = run('tar', ['-tvzf', download]).out;
  if (verbose.split(/\r?\n/).filter(Boolean).some(x => !['-', 'd'].includes(x[0]))) fail('Archive contains links or special entries', code);
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  run('tar', ['-xzf', download, '-C', destination]);
  const manifest = await verifyBundle(destination, kind);
  return { ...pin, files: manifest.files.length, bytes: manifest.totalBytes, manifestSha256: await sha256(path.join(destination, 'input-manifest.json')) };
}

async function sourceCoverage(source, references) {
  // The upstream checkout is already Git-verified; inspect only referenced files and
  // avoid walking its .git directory as if it were a resource bundle.
  return assessCoverage(source, references, { files: references });
}

export async function selectAssets({ source, pins, cacheRoot }) {
  const references = await collectAssetReferences(source);
  const candidates = [];
  const sourceReport = await sourceCoverage(source, references);
  const reports = [{ id: 'upstream-source', sourceVersion: null, coverage: sourceReport }];
  if (sourceReport.complete) {
    const report = { schema: 2, status: 'success', source: { directory: source, references: references.length }, selected: { id: 'upstream-source', coverage: sourceReport, input: null }, candidates: reports };
    await writeJson('outputs/input-report.json', report);
    return { id: 'upstream-source', root: source, priority: Number.MAX_SAFE_INTEGER, coverage: sourceReport, references, report };
  }
  for (const [index, pin] of normalizePins(pins).entries()) {
    const id = pin.tag || `bundle-${index + 1}`;
    const destination = path.resolve(cacheRoot, `bundle-${index + 1}`);
    try {
      const restored = await restore(pin, 'assets', destination);
      const coverage = await assessCoverage(destination, references, await verifyBundle(destination, 'assets'));
      reports.push({ id, sourceVersion: pin.sourceVersion || null, coverage });
      if (coverage.complete) candidates.push({ id, root: destination, priority: Number.isFinite(Number(pin.priority)) ? Number(pin.priority) : 0, coverage, input: restored });
    } catch (error) {
      reports.push({ id, sourceVersion: pin.sourceVersion || null, status: 'invalid', error: String(error.message || error).slice(-1000) });
    }
  }

  candidates.sort((a, b) => b.priority - a.priority || b.coverage.covered - a.coverage.covered || a.id.localeCompare(b.id));
  const selected = candidates[0];
  const report = { schema: 2, status: selected ? 'success' : 'failed', source: { directory: source, references: references.length }, selected: selected ? { id: selected.id, coverage: selected.coverage, input: selected.input || null } : null, candidates: reports };
  await writeJson('outputs/input-report.json', report);
  if (!selected) {
    const summary = reports.filter((row) => row.id !== 'upstream-source').map((row) => row.coverage ? `${row.id}: ${row.coverage.missing.length} missing` : `${row.id}: ${row.error || 'invalid input'}`).join('; ');
    const error = new Error(`No resource bundle fully covers the current upstream manifest (${references.length} references). ${summary || 'No usable resource bundle configured.'}`);
    error.code = 'asset-missing-or-mismatch';
    error.details = report;
    throw error;
  }
  return { ...selected, references, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const version = process.env.APP_VERSION;
    const pins = readJson('ci/inputs.json');
    const assets = await selectAssets({ source: process.env.UPSTREAM_DIR, pins: pins.assets, cacheRoot: path.resolve('cache/ci-assets') });
    const runtime = await restore(pins.runtime, 'runtime', path.resolve('cache/ci-runtime'));
    await writeJson('packager.config.json', {
      masterDir: process.env.UPSTREAM_DIR, dependencyDir: process.env.UPSTREAM_DIR, assetsDir: assets.root,
      runtimeCacheDir: path.resolve('cache/ci-runtime'), toolchainDir: path.resolve('cache/ci-toolchain'),
      outputDir: 'outputs/apk', defaultProfile: 'connect', defaultAbis: ['arm64-v8a','x86_64'],
      buildTools: '35.0.0', platform: 'android-35', packageName: 'io.prts.stronghold', minimumVersionCode: 2002,
    });
    const inputReport = readJson('outputs/input-report.json');
    inputReport.runtime = runtime;
    inputReport.appVersion = version;
    await writeJson('outputs/input-report.json', inputReport);
    console.log(`Selected ${assets.id} with ${assets.coverage.covered}/${assets.coverage.required} resources; verified ${runtime.files} runtime input files`);
  } catch (e) { await failure('asset-missing-or-mismatch', e, { sha: process.env.UPSTREAM_SHA }); process.exitCode = 1; }
}
