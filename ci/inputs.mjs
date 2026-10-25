import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, run, fail, writeJson, exists } from '../cli/common.mjs';
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
  const actual = (await fileManifest(root)).filter((file) => file.path !== 'input-manifest.json');
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  if (actual.length !== expected.size) fail('Input file count mismatch', 'asset-missing-or-mismatch');
  for (const row of actual) {
    const match = expected.get(row.path);
    if (!match || match.sha256 !== row.sha256 || match.bytes !== row.bytes) fail(`Input content mismatch: ${row.path}`, 'asset-missing-or-mismatch');
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

export function findFullAsset(assets, version) {
  const candidates = (assets || []).filter((asset) => typeof asset.name === 'string' && /\.zip$/i.test(asset.name));
  const exact = candidates.find((asset) => asset.name.toLowerCase() === `stronghold-protocol-v${version}.zip`.toLowerCase());
  if (exact) return exact;
  const full = candidates.filter((asset) => !/(?:^|[-_.])(?:lite|update|assets?|runtime)(?:[-_.]|$)/i.test(asset.name));
  if (!full.length) fail(`Upstream Release has no full game zip for ${version}`, 'asset-missing-or-mismatch');
  return full.sort((a, b) => Number(b.size || 0) - Number(a.size || 0))[0];
}

async function download(url, destination, { expectedSize = null, code = 'asset-missing-or-mismatch' } = {}) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.part`;
  const tls = process.platform === 'win32' ? ['--ssl-no-revoke'] : [];
  const result = run('curl', ['-L', '--fail', '--retry', '3', '--connect-timeout', '30', '--max-time', '1200', '--silent', '--show-error', ...tls, '-o', temp, url], { allowFail: true });
  if (!result.ok) {
    await fs.rm(temp, { force: true });
    fail(`Download failed for ${url}: ${result.out.slice(-1000)}`, code);
  }
  const size = (await fs.stat(temp)).size;
  if (expectedSize != null && size !== Number(expectedSize)) fail(`Downloaded size mismatch: expected ${expectedSize}, got ${size}`, code);
  await fs.rename(temp, destination);
  return size;
}

async function downloadAndVerify(asset, destination) {
  await download(asset.url || asset.browser_download_url, destination, { expectedSize: asset.size });
  const digest = String(asset.digest || '').replace(/^sha256:/i, '').toLowerCase();
  const actual = await sha256(destination);
  if (digest && digest !== actual) fail(`Upstream zip SHA256 mismatch: expected ${digest}, got ${actual}`, 'asset-missing-or-mismatch');
  return actual;
}

async function extractZip(archive, destination) {
  const listing = run('unzip', ['-Z1', archive]).out;
  for (const line of listing.split(/\r?\n/).filter(Boolean)) {
    if (line.endsWith('/')) continue;
    safePath(destination, line);
  }
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  run('unzip', ['-q', archive, '-d', destination]);
  const root = path.join(destination, 'Stronghold-Protocol');
  if (exists(path.join(root, 'package.json'))) return root;
  if (exists(path.join(destination, 'package.json'))) return destination;
  fail('Upstream zip does not contain a Stronghold-Protocol package root', 'asset-missing-or-mismatch');
}

async function verifyFullSource(root, version) {
  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg.version !== version) fail(`Upstream zip package version ${pkg.version} does not match release ${version}`, 'asset-missing-or-mismatch');
  for (const rel of ['public/assets', 'public/fonts', 'public/vendor', 'node_modules/ws', 'node_modules/acorn', 'data/assets.json']) {
    if (!exists(path.join(root, rel))) fail(`Upstream zip is missing ${rel}`, 'asset-missing-or-mismatch');
  }
}

async function restoreRuntime(pin, destination) {
  if (!pin || !/^[A-Za-z0-9_.-]+\.tar\.gz$/.test(pin.file || '') || !/^[a-f0-9]{64}$/.test(pin.sha256 || '') || !/^[A-Za-z0-9_.-]+$/.test(pin.tag || '')) fail('Invalid runtime pin', 'toolchain/runtime-failure');
  await fs.mkdir(path.resolve('cache/downloads'), { recursive: true });
  const archive = path.resolve('cache/downloads', pin.file);
  if (!exists(archive) || await sha256(archive) !== pin.sha256) {
    await download(`https://github.com/${REPO}/releases/download/${pin.tag}/${pin.file}`, archive, { code: 'toolchain/runtime-failure' });
    if (await sha256(archive) !== pin.sha256) fail('Runtime archive SHA256 mismatch', 'toolchain/runtime-failure');
  }
  archivePaths(run('tar', ['-tzf', archive]).out);
  const verbose = run('tar', ['-tvzf', archive]).out;
  if (verbose.split(/\r?\n/).filter(Boolean).some((line) => !['-', 'd'].includes(line[0]))) fail('Runtime archive contains links or special entries', 'toolchain/runtime-failure');
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  run('tar', ['-xzf', archive, '-C', destination]);
  const manifest = await verifyBundle(destination, 'runtime');
  return { ...pin, files: manifest.files.length, bytes: manifest.totalBytes, manifestSha256: await sha256(path.join(destination, 'input-manifest.json')) };
}

async function main() {
  const detection = readJson('outputs/detection.json');
  const pins = readJson('ci/inputs.json');
  const asset = findFullAsset(detection.assets, detection.version);
  const archive = path.resolve('cache/upstream', `${detection.tag}.zip`);
  const archiveSha = await downloadAndVerify(asset, archive);
  const fullRoot = await extractZip(archive, path.resolve('cache/upstream', detection.tag));
  await verifyFullSource(fullRoot, detection.version);
  const runtime = await restoreRuntime(pins.runtime, path.resolve('cache/ci-runtime'));
  const upstreamRoot = path.resolve(process.env.UPSTREAM_DIR || 'upstream-source');
  const toolchain = path.resolve('cache/ci-toolchain');
  await writeJson('packager.config.json', {
    masterDir: upstreamRoot,
    dependencyDir: fullRoot,
    assetsDir: fullRoot,
    completeAssetsDir: null,
    localAssetsDir: fullRoot,
    fontsDir: fullRoot,
    defaultProfile: 'connect-runtime',
    defaultAbis: ['arm64-v8a', 'x86_64'],
    toolchainDir: toolchain,
    runtimeCacheDir: path.resolve('cache/ci-runtime'),
    outputDir: 'outputs/apk',
    packageName: 'io.prts.stronghold',
    minimumVersionCode: 300118,
    buildTools: '35.0.0',
    platform: 'android-35',
    certificateSha256: process.env.PACKAGER_CERT_SHA256 || '',
    keystore: process.env.PACKAGER_KEYSTORE || '',
    keyAlias: process.env.PACKAGER_KEY_ALIAS || 'stronghold',
    storePasswordEnv: 'PACKAGER_STORE_PASSWORD',
    keyPasswordEnv: 'PACKAGER_KEY_PASSWORD',
  });
  await writeJson('workbench.config.json', {
    upstreamDir: upstreamRoot,
    outputDir: 'outputs/apk',
    stateDir: 'state',
    defaultProfile: 'connect-runtime',
    versionCodeFloor: 300118,
    keepBuilds: 1,
    strict: false,
  });
  const report = {
    schema: 2,
    status: 'success',
    upstream: {
      tag: detection.tag,
      version: detection.version,
      sha: detection.sha,
      releaseUrl: detection.releaseUrl,
      asset: { name: asset.name, size: asset.size, sha256: archiveSha, digest: asset.digest || null },
      root: fullRoot,
    },
    runtime,
    source: { masterDir: upstreamRoot },
  };
  await writeJson('outputs/input-report.json', report);
  await writeJson('outputs/upstream-release.json', detection);
  console.log(`Inputs ready: ${asset.name} (${asset.size} bytes, ${archiveSha.slice(0, 12)}), runtime ${runtime.file}, ${runtime.files} files`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    const code = error.code === 'toolchain/runtime-failure' ? 'toolchain/runtime-failure' : 'asset-missing-or-mismatch';
    await failure(code, error, { tag: process.env.UPSTREAM_TAG || null, sha: process.env.UPSTREAM_SHA || null });
    process.exitCode = 1;
  });
}
