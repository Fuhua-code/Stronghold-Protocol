import fs from 'node:fs/promises';
import path from 'node:path';
import { copyTree, exists, fail, PACKAGER, parseSemver, readJson, run } from './common.mjs';

const TEXT_EXTENSIONS = new Set(['.cjs', '.cmd', '.css', '.html', '.java', '.js', '.json', '.mjs', '.md', '.ps1', '.sh', '.toml', '.ts', '.txt', '.xml', '.yaml', '.yml']);

async function forbiddenContent(stage, token) {
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'assets' || entry.name === 'fonts' || entry.name === 'runtime' || entry.name === 'termux') continue;
        const found = await walk(file);
        if (found) return found;
      } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const stat = await fs.stat(file);
        if (stat.size <= 8 * 1024 * 1024 && (await fs.readFile(file, 'utf8')).includes(token)) return path.relative(stage, file);
      }
    }
    return null;
  }
  return walk(stage);
}

export async function verifyContracts(stage, manifest) {
  for (const rel of manifest.requiredPaths || []) if (!exists(path.join(stage, rel))) fail(`overlay contract path missing after patch: ${rel}`, 'overlay-contract-break');
  for (const marker of manifest.requiredMarkers || []) {
    const file = path.join(stage, marker.path); const text = await fs.readFile(file, 'utf8');
    if (!text.includes(marker.text)) fail(`overlay contract marker missing: ${marker.path} → ${marker.text}`, 'overlay-contract-break');
  }
}

export async function applyOverlay(stage, config, profile, sourceVersion) {
  if (!profile.overlay) return { id: null, applied: [], files: [] };
  const root = path.join(PACKAGER, 'overlays', profile.overlay);
  const manifest = readJson(path.join(root, 'manifest.json'));
  const v = parseSemver(sourceVersion);
  const min = parseSemver(manifest.sourceVersion.min);
  if (v.major !== manifest.sourceVersion.maxMajor || v.minor !== manifest.sourceVersion.maxMinor || v.major < min.major || (v.major === min.major && (v.minor < min.minor || (v.minor === min.minor && v.patch < min.patch)))) {
    fail(`overlay ${manifest.id}@${manifest.version} does not support master ${sourceVersion}`, 'overlay-contract-break');
  }
  const applied = [];
  const copied = [];
  const anchors = [];
  for (const entry of manifest.files || []) {
    const sourceRel = typeof entry === 'string' ? entry : entry?.source;
    const destinationRel = typeof entry === 'string' ? entry : entry?.destination;
    if (!sourceRel || !destinationRel || path.isAbsolute(sourceRel) || path.isAbsolute(destinationRel) || sourceRel.includes('..') || destinationRel.includes('..')) {
      fail(`overlay file mapping is invalid: ${JSON.stringify(entry)}`, 'overlay-contract-break');
    }
    const source = path.join(root, sourceRel);
    const destination = path.join(stage, destinationRel);
    if (!exists(source)) fail(`overlay file missing: ${sourceRel}`, 'overlay-contract-break');
    const destinationParent = path.dirname(destination);
    await fs.mkdir(destinationParent, { recursive: true });
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`overlay file is not a regular file: ${sourceRel}`, 'overlay-contract-break');
    await fs.copyFile(source, destination);
    copied.push({ source: sourceRel, destination: destinationRel });
  }
  for (const rel of manifest.patches || []) {
    const patch = path.join(root, rel);
    if (!exists(patch)) fail(`overlay patch missing: ${rel}`);
    // A staging directory lives inside the packager checkout. Prevent Git from discovering that parent repo,
    // otherwise git apply silently skips patch paths outside the staging prefix while returning success.
    const gitEnv = { GIT_CEILING_DIRECTORIES: path.dirname(stage), GIT_DIR: '', GIT_WORK_TREE: '' };
    const check = run('git', ['apply', '--check', patch], { cwd: stage, env: gitEnv, allowFail: true });
    if (!check.ok) fail(`overlay patch conflict: ${rel}\n${check.out.slice(-6000)}`, 'overlay-contract-break');
    run('git', ['apply', patch], { cwd: stage, env: gitEnv });
    applied.push(rel);
  }
  for (const anchor of manifest.anchors || []) {
    const target = path.join(stage, anchor.path);
    if (!exists(target)) fail(`overlay anchor file missing: ${anchor.path}`, 'overlay-contract-break');
    let text = await fs.readFile(target, 'utf8');
    const count = text.split(anchor.find).length - 1;
    if (count !== 1) fail(`overlay anchor must match exactly once: ${anchor.path} → ${anchor.find}`, 'overlay-contract-break');
    text = text.replace(anchor.find, anchor.replace ?? '');
    await fs.writeFile(target, text);
    anchors.push({ path: anchor.path, find: anchor.find });
  }
  await verifyContracts(stage, manifest);
  for (const forbidden of manifest.forbiddenPaths || []) {
    if (exists(path.join(stage, forbidden))) fail(`overlay contains forbidden path: ${forbidden}`);
    const hit = await forbiddenContent(stage, forbidden);
    if (hit) fail(`overlay contains forbidden token "${forbidden}" in ${hit}`);
  }
  return { id: manifest.id, version: manifest.version, applied, copied, anchors, files: manifest.requiredPaths || [] };
}
