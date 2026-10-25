import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyFeaturePacks } from '../cli/overlay.mjs';
import { allocateVersionCode, pruneBuilds, readHistory, recordBuild } from '../cli/version.mjs';
import { buildCompatReport, compatStatus, writeBuildOutputs } from '../cli/compat.mjs';
import { detectCapacity, inputChecks, verifySourceUnchanged } from '../cli/workbench.mjs';
import { inspectSource } from '../cli/source.mjs';

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function write(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

test('feature packs apply atomically, honour requires, and skip missing files', async () => {
  const stage = await tempDir('sp-pack-');
  const root = await tempDir('sp-spec-');
  await write(path.join(stage, 'a.js'), 'alpha\n');
  await write(path.join(stage, 'b.js'), 'beta\n');
  const spec = {
    version: 1,
    features: [
      { id: 'base', label: 'Base', anchors: [{ path: 'a.js', find: 'alpha', replace: 'ALPHA' }] },
      { id: 'needs-base', label: 'Needs base', requires: ['base'], anchors: [{ path: 'b.js', find: 'beta', replace: 'BETA' }] },
      { id: 'needs-missing', label: 'Needs missing', requires: ['absent'], anchors: [{ path: 'b.js', find: 'BETA', replace: 'GAMMA' }] },
      { id: 'missing-file', label: 'Missing file', anchors: [{ path: 'nope.js', find: 'x', replace: 'y' }] },
      { id: 'broken', label: 'Broken', anchors: [{ path: 'a.js', find: 'not-there', replace: 'x' }] },
    ],
  };
  const report = await applyFeaturePacks(stage, root, spec);
  const status = Object.fromEntries(report.features.map((feature) => [feature.id, feature.status]));
  assert.deepEqual(status, {
    base: 'applied', 'needs-base': 'applied', 'needs-missing': 'skipped', 'missing-file': 'skipped', broken: 'skipped',
  });
  assert.equal(await fs.readFile(path.join(stage, 'a.js'), 'utf8'), 'ALPHA\n');
  assert.equal(await fs.readFile(path.join(stage, 'b.js'), 'utf8'), 'BETA\n');
  assert.equal(report.degraded.length, 3);
});

test('versionCode is monotonic and build history records one row per profile/code', async () => {
  const stateDir = await tempDir('sp-state-');
  const config = { stateDir, versionCodeFloor: 300114, minimumVersionCode: 4 };
  assert.equal((await allocateVersionCode(config, { version: '0.3.1' })).code, 300114);
  await recordBuild(config, { versionCode: 300115, version: '0.3.1', profile: 'connect-runtime' });
  assert.equal((await allocateVersionCode(config, { version: '0.3.1' })).code, 300116);
  await assert.rejects(() => allocateVersionCode(config, { version: '0.3.1', explicit: 300114 }), /must move upward/);
  assert.equal((await allocateVersionCode(config, { version: '0.3.1', explicit: 300116 })).code, 300116);
  await recordBuild(config, { versionCode: 300116, version: '0.3.1', profile: 'connect-runtime' });
  const history = await readHistory(config);
  assert.equal(history.entries.filter((entry) => entry.versionCode === 300116).length, 1);
});

test('pruneBuilds keeps the newest N directories', async () => {
  const root = await tempDir('sp-builds-');
  for (const name of ['300113-ab', '300114-cd', '300115-ef']) await fs.mkdir(path.join(root, '0.3.1', 'connect-runtime', name), { recursive: true });
  const removed = await pruneBuilds(root, '0.3.1', 'connect-runtime', 2);
  assert.deepEqual(removed, ['300113-ab']);
  assert.ok(await fs.stat(path.join(root, '0.3.1', 'connect-runtime', '300115-ef')));
});

test('compat report separates degraded features from a blocked core', () => {
  const overlay = { packs: { mode: 'packs', features: [
    { id: 'title', label: 'Title', status: 'applied' },
    { id: 'settings', label: 'Settings', status: 'skipped', fallback: 'panel', reason: 'anchor' },
  ] } };
  const base = { source: { git: { branch: 'master', commit: 'abc', clean: true }, capacity: '20p' }, version: '0.3.1', versionCode: 1, profile: 'connect-runtime', abis: ['arm64-v8a'], overlay, assets: null, core: [{ id: 'x', ok: true }] };
  const report = buildCompatReport({ ...base, status: '' });
  assert.equal(compatStatus({ core: report.core, features: report.degraded }), 'degraded');
  assert.equal(report.featureSummary.applied, 1);
  assert.equal(report.degraded[0].id, 'settings');
  assert.equal(compatStatus({ core: [{ id: 'x', ok: false }], features: report.degraded }), 'blocked');
});

test('build outputs write the compat report, notice and latest pointer', async () => {
  const directory = await tempDir('sp-out-');
  const overlay = { packs: { mode: 'packs', features: [
    { id: 'title', label: 'Title', status: 'applied' },
    { id: 'settings', label: 'Settings', status: 'skipped', fallback: 'panel', reason: 'anchor' },
  ] } };
  const compat = buildCompatReport({
    source: { git: { branch: 'master', commit: 'abc', clean: false }, capacity: 'upstream' },
    version: '0.3.1', versionCode: 300116, profile: 'connect-runtime', abis: ['arm64-v8a'],
    overlay, assets: null, core: [{ id: 'x', ok: true }], status: 'degraded',
  });
  const report = {
    source: { version: '0.3.1' },
    app: { version: '0.3.1', versionCode: 300116 },
    packager: { profile: 'connect-runtime' },
    apk: { path: 'outputs/builds/x.apk' },
    generatedAt: '2026-10-25T00:00:00.000Z',
  };
  await writeBuildOutputs(directory, { compat, report });
  const latest = JSON.parse(await fs.readFile(path.join(directory, 'latest-build.json'), 'utf8'));
  assert.equal(latest.version, '0.3.1');
  assert.equal(latest.versionCode, 300116);
  const notice = await fs.readFile(path.join(directory, 'BUILD-NOTICE.txt'), 'utf8');
  assert.match(notice, /DEGRADED/);
  assert.match(notice, /Settings/);
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'compat-report.json'), 'utf8'));
  assert.equal(saved.status, 'degraded');
});

test('snapshot sources are hashed, detected and re-checked', async () => {
  const root = await tempDir('sp-source-');
  for (const rel of ['server/index.js', 'shared/x.js', 'public/index.html', 'data/assets.json', 'data/chess.json']) await write(path.join(root, rel), rel);
  await write(path.join(root, 'package.json'), '{"name":"x","version":"0.3.1"}');
  const config = { masterDir: root };
  const before = await inspectSource(config, false, true);
  assert.equal(before.package.version, '0.3.1');
  assert.equal(before.git.branch, 'snapshot');
  assert.equal(detectCapacity(root), 'upstream');
  const checks = inputChecks(config, { toolchain: false, signing: false });
  assert.equal(checks.find((check) => check.id === 'server').ok, true);
  assert.equal((await verifySourceUnchanged(config, { treeHash: before.treeHash })).ok, true);
  await write(path.join(root, 'shared/x.js'), 'changed');
  assert.equal((await verifySourceUnchanged(config, { treeHash: before.treeHash })).ok, false);
});
