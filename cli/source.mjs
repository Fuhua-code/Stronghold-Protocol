import fs from 'node:fs/promises';
import path from 'node:path';
import { copyTree, exists, fail, gitInfo, readJson } from './common.mjs';

export async function inspectSource(config, allowDirty = false) {
  const git = gitInfo(config.masterDir, allowDirty);
  const pkgFile = path.join(config.masterDir, 'package.json');
  const pkg = readJson(pkgFile);
  if (!pkg.version) fail('master/package.json has no version');
  for (const rel of ['server/index.js', 'shared', 'public/index.html', 'data/assets.json']) if (!exists(path.join(config.masterDir, rel))) fail(`master is missing ${rel}`);
  return { git, package: pkg };
}

export async function stageSource(config, stage) {
  const source = config.masterDir;
  const skipped = new Set(['.git', '.cache', 'node_modules', 'mobile', 'outputs', 'build', 'staging']);
  await copyTree(source, stage, { filter: (p, rel) => {
    const first = rel.split(/[\\/]/)[0];
    if (skipped.has(first)) return false;
    if (rel === 'public/vendor' || rel.startsWith('public/vendor/')) return false;
    if (rel === 'public/assets' || rel.startsWith('public/assets/')) return false;
    if (rel === 'public/fonts' || rel.startsWith('public/fonts/')) return false;
    return true;
  }});
  await fs.mkdir(path.join(stage, 'node_modules'), { recursive: true });
  const dep = config.dependencyDir;
  const vendor = exists(path.join(dep, 'public', 'vendor')) ? path.join(dep, 'public', 'vendor') : path.join(source, 'public', 'vendor');
  if (!exists(vendor)) fail(`public/vendor is missing in dependencyDir ${dep}; run packager bootstrap after preparing dependencies`);
  await copyTree(vendor, path.join(stage, 'public', 'vendor'));
  const ws = path.join(dep, 'node_modules', 'ws');
  if (!exists(ws)) fail(`node_modules/ws is missing in ${dep}; run npm ci in a prepared dependency checkout or packager bootstrap`);
  await copyTree(ws, path.join(stage, 'node_modules', 'ws'));
  await fs.writeFile(path.join(stage, 'node_modules', 'package.json'), '{"type":"commonjs"}\n');

  const assetRoot = config.assetsDir;
  const assetCandidates = [
    [path.join(assetRoot, 'public', 'assets'), path.join(stage, 'public', 'assets')],
    [path.join(assetRoot, 'public', 'fonts'), path.join(stage, 'public', 'fonts')],
  ];
  for (const [from, to] of assetCandidates) {
    if (exists(from)) {
      if ((await fs.lstat(from)).isDirectory()) await copyTree(from, to); else { await fs.mkdir(path.dirname(to), { recursive: true }); await fs.copyFile(from, to); }
    }
  }
  for (const rel of ['public/assets', 'public/fonts']) if (!exists(path.join(stage, rel))) fail(`required asset directory is missing after staging: ${rel}`);
  // Local art is optional upstream metadata. Supply the verified bundle's index only
  // when upstream did not provide its own; never replace a current upstream manifest.
  const local = 'data/local-assets.json';
  if (!exists(path.join(stage, local)) && exists(path.join(assetRoot, local))) await fs.copyFile(path.join(assetRoot, local), path.join(stage, local));
  return stage;
}
