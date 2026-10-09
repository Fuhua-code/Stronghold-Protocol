import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { readJson, run, fail, writeJson, exists } from '../cli/common.mjs';
import { fileManifest, safePath, sha256, failure, REPO } from './lib.mjs';

export async function verifyBundle(root, kind, version) {
  const manifest = readJson(path.join(root, 'input-manifest.json'));
  if (manifest.schema !== 1 || manifest.kind !== kind || manifest.version !== version || !Array.isArray(manifest.files) || !manifest.files.length) fail('Invalid input manifest', 'asset-missing-or-mismatch');
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
  return manifest;
}

export function archivePaths(list) {
  for (const line of list.split(/\r?\n/).filter(Boolean)) {
    const name = line.replace(/^\.\//, '').replace(/\/$/, '');
    if (!name || name === '.') continue;
    safePath(path.resolve('cache'), name);
  }
}

async function restore(pin, kind, version, destination) {
  const code = kind === 'assets' ? 'asset-missing-or-mismatch' : 'toolchain/runtime-failure';
  if (!pin || !/^[a-f0-9]{64}$/.test(pin.sha256 || '') || !/^[A-Za-z0-9_.-]+\.tar\.gz$/.test(pin.file || '') || !/^[A-Za-z0-9_.-]+$/.test(pin.tag || '')) fail(`No pinned ${kind} Release input for ${version}`, code);
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
  await fs.mkdir(destination, { recursive: true });
  run('tar', ['-xzf', download, '-C', destination]);
  const manifest = await verifyBundle(destination, kind, version);
  return { ...pin, files: manifest.files.length, bytes: manifest.totalBytes, manifestSha256: await sha256(path.join(destination, 'input-manifest.json')) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const version = process.env.APP_VERSION;
    const pins = readJson('ci/inputs.json');
    const assets = await restore(pins.assets[version], 'assets', version, path.resolve('cache/ci-assets'));
    const runtime = await restore(pins.runtime, 'runtime', pins.runtime.version, path.resolve('cache/ci-runtime'));
    const sourceManifest = path.join(process.env.UPSTREAM_DIR, 'data/assets.json');
    if (await sha256(sourceManifest) !== await sha256('cache/ci-assets/data/assets.json')) fail('Resource Release belongs to a different upstream manifest', 'asset-missing-or-mismatch');
    await writeJson('outputs/input-report.json', { assets, runtime });
    await writeJson('packager.config.json', {
      masterDir: process.env.UPSTREAM_DIR, dependencyDir: process.env.UPSTREAM_DIR, assetsDir: path.resolve('cache/ci-assets'),
      runtimeCacheDir: path.resolve('cache/ci-runtime'), toolchainDir: path.resolve('cache/ci-toolchain'),
      outputDir: 'outputs/apk', defaultProfile: 'connect', defaultAbis: ['arm64-v8a','x86_64'],
      buildTools: '35.0.0', platform: 'android-35', packageName: 'io.prts.stronghold', minimumVersionCode: 2002,
    });
    console.log(`Verified ${assets.files} resource files and ${runtime.files} runtime input files`);
  } catch (e) { await failure('asset-missing-or-mismatch', e, { sha: process.env.UPSTREAM_SHA }); process.exitCode = 1; }
}
