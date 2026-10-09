// Maintainer-only: produce immutable Release inputs; never copy signing keys or outputs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { copyTree, run, writeJson, readJson } from '../cli/common.mjs';
import { checkAssets } from '../cli/assets.mjs';
import { fileManifest, sha256 } from './lib.mjs';

const [kind, source, version, destination, manifestSource = source] = process.argv.slice(2);
if (!['assets', 'runtime'].includes(kind) || !source || !version || !destination) throw new Error('Usage: node ci/make-input.mjs assets|runtime <source> <version> <new-output-dir> [master-dir]');
const root = path.resolve(destination, 'bundle');
try { await fs.access(root); throw new Error('Bundle output exists; use a fresh directory'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
await fs.mkdir(root, { recursive: true });
if (kind === 'assets') {
  for (const rel of ['public/assets', 'public/fonts']) await copyTree(path.join(source, rel), path.join(root, rel));
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  // Git blob bytes avoid Windows autocrlf changing a pin later checked by a Linux runner.
  await fs.writeFile(path.join(root, 'data/assets.json'), run('git', ['show','HEAD:data/assets.json'], { cwd: manifestSource }).out);
  try { await fs.copyFile(path.join(source, 'data/local-assets.json'), path.join(root, 'data/local-assets.json')); } catch(e) { if (e.code !== 'ENOENT') throw e; }
  await checkAssets(root);
} else {
  for (const abi of ['arm64-v8a', 'x86_64']) await copyTree(path.join(source, 'runtime', abi), path.join(root, 'runtime', abi));
  await copyTree(path.join(source, 'licenses'), path.join(root, 'licenses'));
  await copyTree(path.join(source, 'termux/repository'), path.join(root, 'termux/repository'));
  for (const arch of ['aarch64', 'x86_64']) {
    const dir = path.join(source, 'termux', arch);
    for (const name of await fs.readdir(dir)) if (name.endsWith('.deb')) await copyTree(path.join(dir, name), path.join(root, 'termux', arch, name));
  }
}
const files = await fileManifest(root);
const manifest = { schema: 1, kind, version, files, totalBytes: files.reduce((a,f) => a + f.bytes, 0) };
await writeJson(path.join(root, 'input-manifest.json'), manifest);
const name = `stronghold-${kind}-${version}.tar.gz`; const archive = path.resolve(destination, name);
run('tar', ['-czf', archive, '-C', root, '.']);
const digest = await sha256(archive);
await fs.writeFile(path.join(destination, 'SHA256SUMS.txt'), `${digest}  ${name}\n`);
await writeJson(path.join(destination, 'input-manifest.json'), manifest);
await writeJson(path.join(destination, 'pin.json'), { tag: kind === 'assets' ? `android-assets-${version}` : `android-runtime-${version}`, file: name, sha256: digest });
console.log(JSON.stringify({ archive, sha256: digest, files: files.length, bytes: manifest.totalBytes }));
