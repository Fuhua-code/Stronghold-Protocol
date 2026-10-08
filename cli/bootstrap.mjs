#!/usr/bin/env node
import path from 'node:path';
import { copyTree, exists, fail, loadConfig, resolveFrom, writeJson } from './common.mjs';
import { inspectSource } from './source.mjs';

async function main() {
  const config = loadConfig();
  await inspectSource(config, false);
  const raw = process.argv.slice(2);
  // packager.cmd forwards the original command token on Windows; tolerate it so both wrappers and direct Node
  // invocation accept the same syntax.
  if (raw[0] === 'bootstrap') raw.shift();
  let source = config.runtimeSourceDir ? resolveFrom(path.dirname(config.file), config.runtimeSourceDir) : null;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '--source' || raw[i] === '--from') {
      source = resolveFrom(process.cwd(), raw[++i]);
      continue;
    }
    if (raw[i] === '--help' || raw[i] === '-h') {
      console.log('usage: packager.cmd bootstrap --source <prepared build directory>');
      console.log('The source must contain runtime/, termux/ and licenses/. It is read only.');
      return;
    }
    fail(`unknown bootstrap option ${raw[i]}`);
  }
  if (!source) fail('runtime source is not configured; pass --source <prepared build directory>');
  const depBuild = path.resolve(source);
  if (!exists(depBuild)) fail(`runtime source does not exist: ${depBuild}`);
  for (const rel of ['runtime', 'termux', 'licenses']) {
    const from = path.join(depBuild, rel);
    if (!exists(from)) fail(`dependency cache is missing mobile/build/${rel}`);
    await copyTree(from, path.join(config.runtimeCacheDir, rel));
  }
  const report = { status: 'success', source: config.masterDir, runtimeSource: depBuild, runtimeCache: config.runtimeCacheDir, copied: ['runtime', 'termux', 'licenses'], at: new Date().toISOString() };
  await writeJson(path.join(config.runtimeCacheDir, 'bootstrap-report.json'), report);
  console.log(`Bootstrap complete: ${config.runtimeCacheDir}`);
}
main().catch((e) => { console.error(`BOOTSTRAP FAILED: ${e.message}`); process.exitCode = 1; });
