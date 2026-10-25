import path from 'node:path';
import { exists, hashTree, run } from './common.mjs';

export function detectCapacity(root) {
  return exists(path.join(root, 'shared', 'playerCapacity.js')) ? '20p' : 'upstream';
}

export function inputChecks(config, { toolchain = true, signing = true } = {}) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });
  const dependency = config.dependencyDir || config.masterDir;
  const runtime = config.runtimeCacheDir || config.masterDir;
  add('upstream', exists(config.masterDir), config.masterDir);
  add('package.json', exists(path.join(config.masterDir, 'package.json')), path.join(config.masterDir, 'package.json'));
  add('server', exists(path.join(config.masterDir, 'server', 'index.js')), path.join(config.masterDir, 'server', 'index.js'));
  add('client', exists(path.join(config.masterDir, 'public', 'index.html')), path.join(config.masterDir, 'public', 'index.html'));
  add('data', exists(path.join(config.masterDir, 'data', 'chess.json')), path.join(config.masterDir, 'data', 'chess.json'));
  add('assets', exists(path.join(config.masterDir, 'data', 'assets.json')), path.join(config.masterDir, 'data', 'assets.json'));
  if (config.assetsDir) add('asset-files', exists(path.join(config.assetsDir, 'public', 'assets')), path.join(config.assetsDir, 'public', 'assets'));
  if (config.localAssetsDir) add('local-art', exists(path.join(config.localAssetsDir, 'public', 'assets', 'local')), path.join(config.localAssetsDir, 'public', 'assets', 'local'));
  add('vendor', exists(path.join(dependency, 'public', 'vendor')), path.join(dependency, 'public', 'vendor'));
  add('node_modules', exists(path.join(dependency, 'node_modules', 'ws')) && exists(path.join(dependency, 'node_modules', 'acorn')), path.join(dependency, 'node_modules'));
  add('runtime-cache', ['runtime', 'termux', 'licenses'].every((name) => exists(path.join(runtime, name))), runtime);
  if (toolchain) {
    add('jdk', exists(path.join(config.toolchainDir, 'jdk')), path.join(config.toolchainDir, 'jdk'));
    add('android-sdk', exists(path.join(config.toolchainDir, 'android-sdk')), path.join(config.toolchainDir, 'android-sdk'));
  }
  if (signing) add('keystore', exists(path.resolve(path.dirname(config.file), config.keystore)), path.resolve(path.dirname(config.file), config.keystore));
  return checks;
}

export async function sourceFingerprint(config) {
  const git = exists(path.join(config.masterDir, '.git'));
  if (!git) {
    const tree = await hashTree(config.masterDir);
    return { snapshot: true, treeHash: tree.digest, files: tree.files, capacity: detectCapacity(config.masterDir) };
  }
  const commit = run('git', ['-C', config.masterDir, 'rev-parse', 'HEAD']).out.trim();
  const status = run('git', ['-C', config.masterDir, 'status', '--porcelain']).out.trim();
  return { snapshot: false, commit, clean: !status, status, capacity: detectCapacity(config.masterDir) };
}

export async function verifySourceUnchanged(config, before) {
  const after = await sourceFingerprint(config);
  if (before.treeHash) return { ok: after.treeHash === before.treeHash, before: before.treeHash, after: after.treeHash };
  const ok = after.commit === before.commit && after.status === before.status;
  return { ok, before: before.commit, after: after.commit };
}
