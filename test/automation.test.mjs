import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { allocateVersion } from '../ci/version.mjs';
import { decideSkip } from '../ci/detect.mjs';
import { findFullAsset, verifyBundle, archivePaths } from '../ci/inputs.mjs';
import { validateReport, summaryBody } from '../ci/publish.mjs';
import { reportIssue } from '../ci/notify.mjs';
import { releaseMeta, redact, metadataFooter } from '../ci/lib.mjs';

const sha = 'a'.repeat(40);
const cert = 'A'.repeat(64);
const tag = 'v0.3.2';
const version = '0.3.2';
const baseMeta = {
  schema: 2, kind: 'apk', upstreamTag: tag, upstreamSha: sha, upstreamReleaseUrl: 'https://github.com/sganggs/Stronghold-Protocol/releases/tag/v0.3.2',
  version, versionCode: 300118, revision: 1, status: 'degraded',
};

function release({ draft = true, meta = baseMeta, tagName = `apk-${version}-${sha}` } = {}) {
  return { tag_name: tagName, draft, body: `构建摘要\n\n${metadataFooter(meta)}`, html_url: `https://example.test/${tagName}` };
}

function report() {
  return {
    status: 'degraded',
    source: { commit: sha },
    app: { version, versionCode: 300118, packageName: 'io.prts.stronghold' },
    packager: { profile: 'connect-runtime', abis: ['arm64-v8a', 'x86_64'], version: '1.3.0' },
    overlay: {
      id: 'connect-runtime', version: '2.0.0',
      packs: { mode: 'packs', features: [
        { id: 'css', status: 'applied' }, { id: 'settings', status: 'applied' },
        { id: 'title', status: 'skipped' }, { id: 'stats-tab', status: 'skipped' },
      ] },
    },
    apks: [{ path: '/tmp/Stronghold-Protocol-0.3.2-arm64-v8a-x86_64.apk', bytes: 10, sha256: 'b'.repeat(64) }],
    apk: {
      signatures: { v1: true, v2: true, v3: true, certificateSha256: cert },
      verification: { checks: Array.from({ length: 24 }, () => ({ ok: true })), failures: [] },
      runtimeDependencies: [{ elf: { dependencies: [{ needed: 'libc.so' }], unresolved: [] } }],
    },
  };
}

test('release metadata schema 2 and draft/published skip semantics', () => {
  const draft = release();
  assert.equal(releaseMeta(draft).upstreamTag, tag);
  assert.equal(decideSkip([draft], tag, sha).skip, true);
  assert.equal(decideSkip([draft], tag, sha).reason, 'draft');
  assert.equal(decideSkip([draft], tag, sha, true).skip, false);
  assert.equal(decideSkip([draft], tag, sha, true).reason, 'force-draft');
  assert.equal(decideSkip([draft], tag, 'f'.repeat(40)).skip, false);
  const published = release({ draft: false });
  assert.equal(decideSkip([published], tag, sha, true).skip, true);
  assert.equal(decideSkip([published], tag, sha, true).reason, 'published');
  assert.equal(decideSkip([], tag, sha).skip, false);
  assert.equal(releaseMeta({ tag_name: 'android-assests-0.3.1', body: '' }), null);
  assert.throws(() => releaseMeta({ tag_name: 'apk-bad', body: '' }), /metadata/);
});

test('versionCode includes drafts, stays monotonic, and reuses a forced draft', () => {
  assert.equal(allocateVersion({ version, upstreamTag: tag, upstreamSha: sha, releases: [], minimum: 300118 }).versionCode, 300118);
  const draft = release();
  const skipped = allocateVersion({ version, upstreamTag: tag, upstreamSha: sha, releases: [draft], minimum: 300118 });
  assert.equal(skipped.skip, true);
  assert.equal(skipped.versionCode, 300118);
  const forced = allocateVersion({ version, upstreamTag: tag, upstreamSha: sha, releases: [draft], minimum: 300118, force: true });
  assert.equal(forced.skip, false);
  assert.equal(forced.reuse, true);
  assert.equal(forced.versionCode, 300118);
  const next = allocateVersion({ version: '0.3.3', upstreamTag: 'v0.3.3', upstreamSha: 'c'.repeat(40), releases: [draft], minimum: 300118 });
  assert.equal(next.versionCode, 300119);
  assert.equal(next.tag, `apk-0.3.3-${'c'.repeat(40)}`);
  assert.throws(() => allocateVersion({ version, upstreamTag: tag, upstreamSha: 'bad', releases: [], minimum: 300118 }), /SHA/);
});

test('selects the full upstream zip and validates the runtime bundle', async () => {
  const assets = [
    { name: 'Stronghold-Protocol-v0.3.2-lite.zip', size: 1 },
    { name: 'Stronghold-Protocol-v0.3.2-update.zip', size: 2 },
    { name: 'Stronghold-Protocol-v0.3.2.zip', size: 861090108 },
  ];
  assert.equal(findFullAsset(assets, version).name, 'Stronghold-Protocol-v0.3.2.zip');
  assert.equal(findFullAsset([{ name: 'other.zip', size: 900 }, { name: 'lite.zip', size: 1 }], version).name, 'other.zip');
  assert.throws(() => findFullAsset([{ name: 'lite.zip', size: 1 }], version), /full game zip/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-runtime-'));
  try {
    await fs.writeFile(path.join(root, 'node'), 'runtime');
    const files = [{ path: 'node', bytes: 7, sha256: 'd'.repeat(64) }];
    await fs.writeFile(path.join(root, 'input-manifest.json'), JSON.stringify({ schema: 1, kind: 'runtime', files, totalBytes: 7 }));
    await fs.writeFile(path.join(root, 'node'), 'runtimE');
    await assert.rejects(() => verifyBundle(root, 'runtime'), /mismatch/);
    assert.throws(() => archivePaths('./runtime\n../../secret\n'), /Unsafe/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('publish validation accepts degraded builds and rejects signing, verification and runtime failures', () => {
  validateReport(report(), baseMeta, cert);
  assert.throws(() => validateReport(report(), baseMeta, 'B'.repeat(64)), /signing/);
  const failed = report(); failed.status = 'failed';
  assert.throws(() => validateReport(failed, baseMeta, cert), /successful/);
  const unresolved = report(); unresolved.apk.runtimeDependencies[0].elf.unresolved = ['libz.so.1'];
  assert.throws(() => validateReport(unresolved, baseMeta, cert), /ELF/);
  const badCheck = report(); badCheck.apk.verification.checks[3].ok = false;
  assert.throws(() => validateReport(badCheck, baseMeta, cert), /checks/);
});

test('draft summary contains upstream link and skipped features, not the upstream long body', () => {
  const { body, metadata } = summaryBody(report(), { ...baseMeta, upstreamReleaseName: '卫戍协议：盟约 v0.3.2' }, cert);
  assert.match(body, /Android APK 构建摘要/);
  assert.match(body, /github\.com\/sganggs\/Stronghold-Protocol\/releases\/tag\/v0\.3\.2/);
  assert.match(body, /title, stats-tab/);
  assert.match(body, /草稿/);
  assert.ok(body.length < 5000);
  assert.equal(metadata.kind, 'apk');
  assert.equal(metadata.status, 'degraded');
  assert.deepEqual(metadata.featureSummary.skipped, ['title', 'stats-tab']);
});

test('failure notification creates one Issue and never touches Releases', async () => {
  const issues = [];
  const routes = [];
  const client = async (route, options = {}) => {
    routes.push(`${options.method || 'GET'} ${route.split('?')[0]}`);
    if (!options.method) return issues;
    if (options.method === 'POST') { const row = { ...options.body, number: 1, state: 'open' }; issues.push(row); return row; }
    Object.assign(issues[0], options.body); return issues[0];
  };
  const code = await reportIssue({ tag, sha, version, report: { code: 'overlay-contract-break', stage: 'compat', message: 'marker changed' }, runId: '1' }, client);
  assert.equal(code, 'overlay-contract-break');
  assert.equal(issues.length, 1);
  assert.match(issues[0].title, /破坏性更新/);
  assert.match(issues[0].body, /marker changed/);
  assert.ok(routes.every((route) => route.includes('/issues')));
  await reportIssue({ tag, sha, version, succeeded: true, runId: '1' }, client);
  assert.equal(issues[0].state, 'closed');
  await reportIssue({ tag, sha, version, succeeded: true, dryRun: true, runId: '1' }, client);
  assert.equal(issues[0].state, 'closed');
});

test('redaction removes signing/password/token values', () => {
  const old = process.env.PACKAGER_STORE_PASSWORD;
  process.env.PACKAGER_STORE_PASSWORD = 'fixture-super-secret';
  try {
    const text = redact('failure: fixture-super-secret pass:another-secret Bearer ghp_fixture');
    assert.ok(!text.includes('fixture-super-secret'));
    assert.ok(!text.includes('another-secret'));
    assert.ok(!text.includes('ghp_fixture'));
  } finally { if (old === undefined) delete process.env.PACKAGER_STORE_PASSWORD; else process.env.PACKAGER_STORE_PASSWORD = old; }
});
