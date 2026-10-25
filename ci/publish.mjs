import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, fail, writeJson } from '../cli/common.mjs';
import { api, allReleases, releaseMeta, REPO, UPSTREAM, metadataFooter, sha256, failure } from './lib.mjs';

export function validateReport(report, meta, cert) {
  const sig = report.apk?.signatures;
  if (!['success', 'degraded'].includes(report.status)) fail('Build report is not a successful build', 'apk-verification-failure');
  if (report.source?.commit !== meta.upstreamSha) fail('Build source commit does not match the upstream Release', 'apk-verification-failure');
  if (report.app?.version !== meta.version || report.app?.versionCode !== meta.versionCode || report.app?.packageName !== 'io.prts.stronghold') fail('Build report identity verification failed', 'apk-verification-failure');
  if (report.packager?.profile !== 'connect-runtime' || JSON.stringify([...report.packager.abis].sort()) !== JSON.stringify(['arm64-v8a', 'x86_64'].sort())) fail('Build profile or ABI set is unexpected', 'apk-verification-failure');
  if (!sig?.v1 || !sig.v2 || !sig.v3 || !/^[A-F0-9]{64}$/.test(cert || '') || sig.certificateSha256 !== cert) fail('Build report signing verification failed', 'signing-failure');
  const verification = report.apk?.verification;
  if (!verification || !Array.isArray(verification.checks) || !verification.checks.length || verification.checks.some((check) => !check.ok) || (verification.failures || []).length) fail('APK verification checks did not all pass', 'apk-verification-failure');
  if (!Array.isArray(report.apks) || !report.apks.length) fail('Build report has no APK checksums', 'apk-verification-failure');
  for (const dependency of report.apk?.runtimeDependencies || []) {
    if (!dependency.elf?.dependencies?.length || dependency.elf.unresolved?.length) fail('Runtime ELF dependencies are unresolved', 'apk-verification-failure');
  }
  if (!report.overlay || report.overlay.id !== 'connect-runtime') fail('Build overlay identity is unexpected', 'apk-verification-failure');
  return true;
}

async function findBuildDirectory(meta) {
  const candidates = [];
  try {
    const latest = readJson('state/latest.json');
    if (latest.versionCode === meta.versionCode && latest.profile === 'connect-runtime' && latest.outputDir) candidates.push(latest.outputDir);
  } catch { /* fall through to scanning */ }
  for (const root of ['outputs/apk', 'outputs/builds']) {
    try {
      for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        candidates.push(path.join(root, entry.name));
      }
    } catch { /* absent root */ }
  }
  const found = [];
  for (const candidate of candidates) {
    try {
      const report = readJson(path.join(candidate, 'build-report.json'));
      if (report.app?.versionCode === meta.versionCode && report.packager?.profile === 'connect-runtime') return path.resolve(candidate);
      found.push(candidate);
    } catch { /* not a build dir */ }
  }
  // Versioned layouts are outputs/<version>/<profile>/<code>-<hash>; walk two levels.
  for (const root of ['outputs/apk', 'outputs/builds']) {
    let versions = [];
    try { versions = await fs.readdir(root); } catch { continue; }
    for (const version of versions) {
      let profiles = [];
      try { profiles = await fs.readdir(path.join(root, version)); } catch { continue; }
      for (const profile of profiles) {
        let builds = [];
        try { builds = await fs.readdir(path.join(root, version, profile)); } catch { continue; }
        for (const build of builds) {
          const directory = path.join(root, version, profile, build);
          try {
            const report = readJson(path.join(directory, 'build-report.json'));
            if (report.app?.versionCode === meta.versionCode && report.packager?.profile === 'connect-runtime') return path.resolve(directory);
          } catch { /* not a build dir */ }
        }
      }
    }
  }
  fail(`Cannot find the build directory for versionCode ${meta.versionCode}; tried ${found.join(', ')}`, 'release-failure');
}

function featureSummary(report) {
  const features = report.overlay?.packs?.features || [];
  return {
    total: features.length,
    applied: features.filter((feature) => feature.status === 'applied').length,
    skipped: features.filter((feature) => feature.status !== 'applied').map((feature) => feature.id),
    mode: report.overlay?.packs?.mode || 'overlay',
  };
}

export function summaryBody(report, meta, cert) {
  const features = featureSummary(report);
  const apk = report.apks[0];
  const apkName = path.basename(apk.path);
  const upstreamUrl = meta.upstreamReleaseUrl || `https://github.com/${UPSTREAM}/releases/tag/${meta.upstreamTag}`;
  const runUrl = process.env.GITHUB_RUN_ID ? `https://github.com/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}` : '—';
  const skipped = features.skipped.length ? features.skipped.join(', ') : '无';
  const state = report.status === 'degraded'
    ? 'degraded：APK 可用，运行时 fallback 生效；跳过项见下。'
    : 'success：全部 feature pack 命中。';
  const metadata = {
    schema: 2,
    kind: 'apk',
    upstreamTag: meta.upstreamTag,
    upstreamSha: meta.upstreamSha,
    upstreamReleaseUrl: upstreamUrl,
    upstreamPublishedAt: meta.upstreamPublishedAt || null,
    version: meta.version,
    versionCode: meta.versionCode,
    revision: meta.revision,
    status: report.status,
    featureSummary: features,
    overlayVersion: report.overlay?.version || null,
  };
  const body = `## Android APK 构建摘要

- 上游 Release：[${meta.upstreamReleaseName || meta.upstreamTag}](${upstreamUrl})（${meta.upstreamTag}，${meta.upstreamPublishedAt || '发布时间未知'}）
- 上游源码：\`${meta.upstreamSha}\`
- 游戏版本 / versionCode：\`${meta.version}\` / \`${meta.versionCode}\`（修订 ${meta.revision}）
- Profile / overlay：\`connect-runtime\` / \`${report.overlay?.version || 'unknown'}\`
- Feature packs：${features.applied}/${features.total} applied；skipped：${skipped}
- 状态：${state}
- APK：\`${apkName}\`，SHA256：\`${apk.sha256}\`
- 校验：签名 v1/v2/v3、证书 \`${cert}\`、apk-verify ${report.apk?.verification?.checks?.length || 0}/${report.apk?.verification?.checks?.length || 0}、注入测试已通过
- Actions：[构建日志与诊断](${runUrl})
- 本 Release 为草稿，尚未自动发布；确认后再发布。

${metadataFooter(metadata)}`;
  return { body, metadata, features, apkName };
}

async function publish() {
  const meta = readJson('outputs/release-meta.json');
  if (meta.skip) { console.log(`Version allocation skipped: ${meta.reason}`); return; }
  const cert = String(process.env.PACKAGER_CERT_SHA256 || '').replace(/:/g, '').toUpperCase();
  const directory = await findBuildDirectory(meta);
  const report = readJson(path.join(directory, 'build-report.json'));
  validateReport(report, meta, cert);
  for (const apk of report.apks) if (await sha256(path.join(directory, path.basename(apk.path))) !== apk.sha256) fail('APK hash changed before publishing', 'apk-verification-failure');
  const history = await allReleases();
  const existing = history.find((release) => release.tag_name === meta.tag) || history.find((release) => release.draft && releaseMeta(release)?.upstreamTag === meta.upstreamTag && releaseMeta(release)?.upstreamSha === meta.upstreamSha);
  if (existing && !existing.draft) { console.log(`Already published: ${existing.html_url}`); return; }
  const { body, metadata } = summaryBody(report, meta, cert);
  const release = existing || await api(`/repos/${REPO}/releases`, {
    method: 'POST',
    body: {
      tag_name: meta.tag,
      target_commitish: process.env.PACKAGER_SHA || 'main',
      name: `Android ${meta.version} · ${meta.upstreamSha.slice(0, 8)} · code ${meta.versionCode}`,
      body,
      draft: true,
      prerelease: false,
    },
  });
  if (existing) await api(`/repos/${REPO}/releases/${release.id}`, { method: 'PATCH', body: { name: `Android ${meta.version} · ${meta.upstreamSha.slice(0, 8)} · code ${meta.versionCode}`, body } });
  const extras = ['input-report.json', 'upstream-release.json', 'upstream-check.json', 'overlay-preflight.json', 'release-meta.json'];
  for (const name of extras) {
    try { await fs.copyFile(path.join('outputs', name), path.join(directory, name)); } catch { /* optional diagnostic */ }
  }
  const names = [
    ...report.apks.map((apk) => path.basename(apk.path)),
    'SHA256SUMS.txt', 'build-report.json', 'overlay-report.json', 'compat-report.json', 'apk-verify.json',
    'BUILD-NOTICE.txt', 'overlay-tests.log', ...extras,
  ].filter((name, index, list) => list.indexOf(name) === index);
  for (const name of names) {
    const file = path.join(directory, name);
    const prior = release.assets?.find((asset) => asset.name === name);
    if (prior) await api(`/repos/${REPO}/releases/assets/${prior.id}`, { method: 'DELETE' });
    const { size } = await fs.stat(file);
    const handle = await fs.open(file);
    try {
      const response = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          'User-Agent': 'Stronghold-Protocol-Packager',
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(size),
        },
        body: handle.createReadStream(),
        duplex: 'half',
        signal: AbortSignal.timeout(900_000),
      });
      if (!response.ok) throw new Error(`Release asset upload failed for ${name}: HTTP ${response.status}`);
    } finally { await handle.close(); }
  }
  const assets = await api(`/repos/${REPO}/releases/${release.id}/assets`);
  if (!names.every((name) => assets.some((asset) => asset.name === name && asset.size > 0))) throw new Error('Incomplete Release upload');
  await writeJson('outputs/publish-result.json', {
    status: 'success',
    draft: true,
    tag: meta.tag,
    version: meta.version,
    versionCode: meta.versionCode,
    upstreamTag: meta.upstreamTag,
    upstreamSha: meta.upstreamSha,
    releaseId: release.id,
    releaseUrl: release.html_url,
    assets: names,
    metadata,
  });
  console.log(`Draft Release ready: ${release.html_url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await publish(); } catch (e) { await failure('release-failure', e, { tag: process.env.UPSTREAM_TAG || null, sha: process.env.UPSTREAM_SHA || null }); process.exitCode = 1; }
}
