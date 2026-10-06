import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ROOT, walk, resourcePaths } from './pages-build.mjs';
const value = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const source = path.resolve(value('source') || ROOT);
const out = path.join(ROOT, 'outputs/pages-assets');
await fs.mkdir(out, { recursive: true });
const files = [...await walk(path.join(source, 'public/assets')), ...await walk(path.join(source, 'public/fonts')), path.join(source, 'data/assets.json'), path.join(source, 'data/local-assets.json')];
for (const manifest of ['assets.json', 'local-assets.json']) {
  const data = JSON.parse(await fs.readFile(path.join(source, 'data', manifest)));
  for (const url of resourcePaths(data)) await fs.access(path.join(source, 'public', url));
}
if (!Buffer.from(await fs.readFile(path.join(source, 'data/assets.json'))).equals(await fs.readFile(path.join(ROOT, 'data/assets.json')))) throw new Error('Standard assets manifest must match Pages game version');
const inventory = [];
for (const file of files) {
  const contents = await fs.readFile(file);
  inventory.push({ path: path.relative(source, file).replaceAll('\\', '/'), bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') });
}
const archive = path.join(out, 'stronghold-pages-assets-v0.1.4.tar.gz');
const result = spawnSync('tar', ['-czf', archive, '-C', source, 'public/assets', 'public/fonts', 'data/assets.json', 'data/local-assets.json'], { windowsHide: true, stdio: 'inherit' });
if (result.status !== 0) throw new Error('Resource archive creation failed');
const sha256 = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
await fs.writeFile(path.join(out, 'resource-manifest.json'), JSON.stringify({ version: '0.1.4', files: inventory }, null, 2));
await fs.writeFile(path.join(out, 'SHA256SUMS.txt'), `${sha256}  ${path.basename(archive)}\n`);
const release = { tag: 'pages-assets-v0.1.4', file: path.basename(archive), sha256 };
await fs.writeFile(path.join(ROOT, 'pages/resources.json'), JSON.stringify(release, null, 2) + '\n');
console.log(JSON.stringify({ archive, sha256, files: inventory.length, bytes: inventory.reduce((sum, f) => sum + f.bytes, 0) }));
