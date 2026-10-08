#!/usr/bin/env node
import path from 'node:path';
import { copyTree, exists, fail, loadConfig, writeJson } from './common.mjs';
import { inspectSource } from './source.mjs';

async function main() {
  const config = loadConfig();
  await inspectSource(config, false);
  const depBuild = path.join(config.dependencyDir, 'mobile', 'build');
  if (!exists(depBuild)) fail(`prepared mobile/build is missing in ${config.dependencyDir}; run the existing Android builder once first`);
  for (const rel of ['runtime', 'termux', 'licenses']) {
    const from = path.join(depBuild, rel);
    if (!exists(from)) fail(`dependency cache is missing mobile/build/${rel}`);
    await copyTree(from, path.join(config.runtimeCacheDir, rel));
  }
  const report = { status: 'success', source: config.masterDir, runtimeCache: config.runtimeCacheDir, copied: ['runtime', 'termux', 'licenses'], at: new Date().toISOString() };
  await writeJson(path.join(config.runtimeCacheDir, 'bootstrap-report.json'), report);
  console.log(`Bootstrap complete: ${config.runtimeCacheDir}`);
}
main().catch((e) => { console.error(`BOOTSTRAP FAILED: ${e.message}`); process.exitCode = 1; });

