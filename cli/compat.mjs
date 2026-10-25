import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJson } from './common.mjs';

export function featureSummary(overlay) {
  const features = overlay?.packs?.features || [];
  return {
    mode: overlay?.packs?.mode || 'overlay',
    total: features.length,
    applied: features.filter((feature) => feature.status === 'applied').length,
    features,
    degraded: features.filter((feature) => feature.status !== 'applied'),
  };
}

export function compatStatus({ core = [], features = [] } = {}) {
  if (core.some((check) => !check.ok)) return 'blocked';
  return features.length ? 'degraded' : 'success';
}

export function buildCompatReport({ source, version, versionCode, profile, abis, assets, overlay, core, status }) {
  const summary = featureSummary(overlay);
  return {
    schemaVersion: 1,
    status,
    generatedAt: new Date().toISOString(),
    source: {
      directory: source?.directory || null,
      version,
      branch: source?.git?.branch || 'snapshot',
      commit: source?.git?.commit || null,
      clean: source?.git?.clean ?? false,
      treeHash: source?.treeHash || null,
      capacity: source?.capacity || 'unknown',
    },
    build: { versionCode, profile, abis },
    assets: assets ? { manifestSource: assets.manifestSource, stagingTree: assets.stagingTree, files: assets.files } : null,
    core,
    features: summary.features,
    featureSummary: { mode: summary.mode, total: summary.total, applied: summary.applied, degraded: summary.degraded.length },
    degraded: summary.degraded,
    remediation: summary.degraded.map((feature) => `${feature.label} (${feature.id}): ${feature.reason || feature.status}; runtime fallback: ${feature.fallback || 'none'}`),
  };
}

export function noticeText(report) {
  const lines = [
    `Stronghold Protocol ${report.source.version}  versionCode ${report.build.versionCode}`,
    `Profile: ${report.build.profile}   ABIs: ${report.build.abis.join(', ')}`,
    `Status: ${report.status.toUpperCase()}`,
    `Feature packs: ${report.featureSummary.applied}/${report.featureSummary.total} applied`,
    `Source: ${report.source.commit || '(snapshot)'}  version=${report.source.version}  clean=${report.source.clean}  capacity=${report.source.capacity}`,
    `Built: ${report.generatedAt}`,
    '',
  ];
  if (report.degraded.length) {
    lines.push('Degraded features (the APK was still built; runtime fallbacks are active):');
    for (const feature of report.degraded) {
      lines.push(`  - ${feature.label} (${feature.id}): ${feature.status}${feature.reason ? ` — ${feature.reason}` : ''}`);
      if (feature.fallback) lines.push(`    fallback: ${feature.fallback}`);
    }
    lines.push('');
  }
  lines.push('The upstream source directory was not modified by this build.');
  return `${lines.join('\n')}\n`;
}

export async function writeBuildOutputs(directory, { compat, report }) {
  await writeJson(path.join(directory, 'compat-report.json'), compat);
  await fs.writeFile(path.join(directory, 'BUILD-NOTICE.txt'), noticeText(compat));
  await writeJson(path.join(directory, 'latest-build.json'), {
    version: report.app.version,
    versionCode: report.app.versionCode,
    profile: report.packager.profile,
    status: compat.status,
    apk: report.apk.path,
    generatedAt: report.generatedAt,
  });
}
