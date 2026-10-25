import fs from 'node:fs/promises';
import path from 'node:path';
import { copyTree, exists, fail, gitInfo, hashTree, manifestUrls, readJson } from './common.mjs';

async function copyTreeMissing(source, destination, { filter = () => true, root = source } = {}) {
  if (!exists(source)) return;
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) fail(`symbolic link is not allowed in staging: ${source}`);
  if (stat.isFile()) {
    if (!filter(source, path.basename(source))) return;
    if (exists(destination)) {
      if ((await fs.lstat(destination)).isDirectory()) fail(`asset source type conflicts with staged directory: ${destination}`, 'asset-missing-or-mismatch');
      return;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    return;
  }
  if (!stat.isDirectory()) fail(`special file is not allowed in staging: ${source}`);
  if (exists(destination) && !(await fs.lstat(destination)).isDirectory()) {
    fail(`asset source type conflicts with staged file: ${destination}`, 'asset-missing-or-mismatch');
  }
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dst = path.join(destination, entry.name);
    const rel = path.relative(root, src).split(path.sep).join('/');
    if (!filter(src, rel, entry)) continue;
    if (entry.isDirectory()) await copyTreeMissing(src, dst, { filter, root });
    else if (entry.isFile()) await copyTreeMissing(src, dst, { filter, root });
    else fail(`special or symbolic file is not allowed in staging: ${src}`);
  }
}

function uniqueRoots(roots) {
  return [...new Set(roots.filter(Boolean).map((root) => path.resolve(root)))];
}

function assetParts(url) {
  if (typeof url !== 'string' || !/^\/(?:assets|fonts)\//.test(url)) return null;
  let decoded = url;
  for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(decoded); i++) decoded = decodeURIComponent(decoded);
  const parts = decoded.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..' || /[\\/\0]/.test(part))) {
    fail(`unsafe resource URL in staged manifest: ${url}`, 'asset-missing-or-mismatch');
  }
  return parts;
}

async function copyManifestGaps(stage, roots) {
  const manifests = ['assets.json', 'local-assets.json'];
  const urls = new Set();
  for (const name of manifests) {
    const file = path.join(stage, 'data', name);
    if (exists(file)) for (const url of manifestUrls(readJson(file))) urls.add(url);
  }
  for (const url of urls) {
    const parts = assetParts(url);
    if (!parts) continue;
    const destination = path.join(stage, 'public', ...parts);
    if (exists(destination)) continue;
    for (const root of roots) {
      const source = path.join(root, 'public', ...parts);
      if (!exists(source)) continue;
      const stat = await fs.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink()) fail(`asset fallback is not a regular file: ${source}`, 'asset-missing-or-mismatch');
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
      break;
    }
  }
}

export async function inspectSource(config, allowDirty = false, allowAny = false) {
  let git;
  let treeHash = null;
  const hasGit = exists(path.join(config.masterDir, '.git'));
  if (allowAny || !hasGit) {
    const tree = await hashTree(config.masterDir);
    treeHash = tree.digest;
    git = { branch: 'snapshot', clean: false, status: '', commit: tree.digest.slice(0, 12) };
  } else {
    git = gitInfo(config.masterDir, allowDirty);
  }
  const pkgFile = path.join(config.masterDir, 'package.json');
  if (!exists(pkgFile)) fail(`missing upstream package.json: ${pkgFile}`);
  const pkg = readJson(pkgFile);
  if (!pkg.version) fail('master/package.json has no version');
  for (const rel of ['server/index.js', 'shared', 'public/index.html', 'data/assets.json']) if (!exists(path.join(config.masterDir, rel))) fail(`master is missing ${rel}`);
  const capacity = exists(path.join(config.masterDir, 'shared', 'playerCapacity.js')) ? '20p' : 'upstream';
  return { git, package: pkg, treeHash, capacity };
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
  // Keep only production packages needed by the mobile server.  The 0.3.x
  // plugin/studio import chain uses acorn in addition to ws; browser packages
  // and dev dependencies remain outside the staging tree.
  for (const name of ['ws', 'acorn']) {
    const packageDir = path.join(dep, 'node_modules', name);
    if (!exists(packageDir)) fail(`node_modules/${name} is missing in ${dep}; run npm ci in a prepared dependency checkout or packager bootstrap`);
    await copyTree(packageDir, path.join(stage, 'node_modules', name));
  }
  await fs.writeFile(path.join(stage, 'node_modules', 'package.json'), '{"type":"commonjs"}\n');

  const completeRoot = config.completeAssetsDir || null;
  const assetRoots = uniqueRoots([source, completeRoot, config.assetsDir]);
  const fontRoots = uniqueRoots([source, completeRoot, config.assetsDir]);
  const skipLocalArt = (_file, rel) => rel !== 'local' && !rel.startsWith('local/');
  for (const root of assetRoots) {
    await copyTreeMissing(path.join(root, 'public', 'assets'), path.join(stage, 'public', 'assets'), { filter: skipLocalArt });
  }
  for (const root of fontRoots) {
    await copyTreeMissing(path.join(root, 'public', 'fonts'), path.join(stage, 'public', 'fonts'));
  }

  // Local art is a separate input from the upstream asset manifest. Use any
  // source-local copy first, then legacy resources for gaps; the explicitly
  // selected full package is authoritative and replaces this subtree.
  for (const root of uniqueRoots([source, config.localAssetsDir, config.assetsDir])) {
    await copyTreeMissing(path.join(root, 'public', 'assets', 'local'), path.join(stage, 'public', 'assets', 'local'));
  }
  const completeLocalArt = completeRoot && path.join(completeRoot, 'public', 'assets', 'local');
  if (completeLocalArt && exists(completeLocalArt)) {
    await fs.rm(path.join(stage, 'public', 'assets', 'local'), { recursive: true, force: true });
    await copyTree(completeLocalArt, path.join(stage, 'public', 'assets', 'local'));
  }
  for (const rel of ['public/assets', 'public/fonts']) if (!exists(path.join(stage, rel))) fail(`required asset directory is missing after staging: ${rel}`);
  // Local art is optional upstream metadata. Supply the verified bundle's index only
  // when upstream did not provide its own; never replace a current upstream manifest.
  const local = 'data/local-assets.json';
  if (!exists(path.join(stage, local))) {
    for (const root of uniqueRoots([completeRoot, config.localAssetsDir, config.assetsDir, config.fontsDir])) {
      const candidate = path.join(root, local);
      if (exists(candidate)) {
        await fs.mkdir(path.dirname(path.join(stage, local)), { recursive: true });
        await fs.copyFile(candidate, path.join(stage, local));
        break;
      }
    }
  }
  await copyManifestGaps(stage, uniqueRoots([config.localAssetsDir, config.fontsDir]));
  await trimDesktopFiles(stage);
  return stage;
}

// Mobile staging keeps the responsive game and server, while dropping desktop-only
// development/demo and installation metadata.  This is deliberately path based and
// runs after the source copy, so the upstream checkout remains byte-for-byte untouched.
export async function trimDesktopFiles(stage) {
  const removed = [];
  const paths = [
    'public/dev',
    'public/manifest.json',
    'public/favicon.ico',
    'public/favicon.svg',
    'public/robots.txt',
    'public/service-worker.js',
    'scripts/windows',
    'scripts/desktop',
    'desktop',
    'install.ps1',
    'install.cmd',
  ];
  for (const rel of paths) {
    const target = path.join(stage, rel);
    if (exists(target)) {
      await fs.rm(target, { recursive: true, force: true });
      removed.push(rel);
    }
  }
  // The upstream HTML may reference PWA metadata/icons even when the files are
  // present. Remove only those optional tags; leave shared CSS, input and game UI.
  const index = path.join(stage, 'public/index.html');
  if (exists(index)) {
    let html = await fs.readFile(index, 'utf8');
    const before = html;
    html = html
      .replace(/\s*<link[^>]+rel=["'](?:manifest|shortcut icon|icon)["'][^>]*>/gi, '')
      .replace(/\s*<meta[^>]+(?:name|property)=["'](?:apple-mobile-web-app-capable|mobile-web-app-capable|msapplication-[^"']+)["'][^>]*>/gi, '');
    if (html !== before) {
      await fs.writeFile(index, html);
      removed.push('public/index.html:pwa-metadata');
    }
  }
  await fs.writeFile(path.join(stage, 'mobile-trim-report.json'), JSON.stringify({ removed }, null, 2));
  return { removed };
}
