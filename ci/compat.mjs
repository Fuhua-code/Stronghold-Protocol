import fs from 'node:fs/promises';
import path from 'node:path';
import { copyTree, PACKAGER, readJson, writeJson } from '../cli/common.mjs';
import { applyOverlay } from '../cli/overlay.mjs';
import { failure } from './lib.mjs';

const stage = path.resolve('.staging', `ci-contract-${process.pid}`);
try {
  await copyTree(process.env.UPSTREAM_DIR, stage, {
    filter: (p) => !['.git', 'node_modules', 'assets', 'fonts', 'vendor', 'outputs', 'mobile'].includes(path.basename(p)),
  });
  const profile = readJson('profiles/connect-runtime.json');
  await copyTree(path.join(PACKAGER, 'templates', profile.mobileTemplate), path.join(stage, 'mobile'));
  const version = readJson(path.join(stage, 'package.json')).version;
  const overlay = await applyOverlay(stage, {}, profile, version);
  const features = overlay.packs?.features || [];
  const report = {
    status: 'success',
    tag: process.env.UPSTREAM_TAG || null,
    sha: process.env.UPSTREAM_SHA || null,
    version,
    overlay: { id: overlay.id, version: overlay.version },
    featureSummary: {
      total: features.length,
      applied: features.filter((feature) => feature.status === 'applied').length,
      skipped: features.filter((feature) => feature.status !== 'applied').map((feature) => feature.id),
    },
    features,
  };
  await writeJson('outputs/overlay-preflight.json', report);
  console.log(`Overlay preflight: ${report.featureSummary.applied}/${report.featureSummary.total} applied`);
  if (report.featureSummary.skipped.length) console.warn(`Skipped features: ${report.featureSummary.skipped.join(', ')}`);
} catch (e) {
  await failure('overlay-contract-break', e, { tag: process.env.UPSTREAM_TAG || null, sha: process.env.UPSTREAM_SHA || null });
  process.exitCode = 1;
} finally { await fs.rm(stage, { recursive: true, force: true }); }
