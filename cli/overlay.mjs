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

/**
 * Apply data-driven feature packs. A feature is applied only when every anchor matches once in
 * the simulated text; otherwise the whole feature is skipped (never partially applied) and the
 * build reports it instead of failing. The runtime extension uses the statuses to install its
 * fallback UI.
 */
export async function applyFeaturePacks(stage, root, spec) {
  const data = typeof spec === 'string'
    ? JSON.parse(await fs.readFile(path.join(root, spec), 'utf8'))
    : spec;
  const features = [];
  const appliedIds = new Set();
  for (const feature of data?.features || []) {
    const texts = new Map();
    const read = async (rel) => {
      if (!texts.has(rel)) texts.set(rel, await fs.readFile(path.join(stage, rel), 'utf8'));
      return texts.get(rel);
    };
    let status = 'applied';
    let reason = null;
    for (const anchor of feature.anchors || []) {
      let text;
      try {
        text = await read(anchor.path);
      } catch {
        status = 'skipped';
        reason = `${anchor.path}: file missing`;
        break;
      }
      const variants = [anchor, ...(anchor.alternatives || [])];
      const matches = variants.filter(v => text.split(v.find).length - 1 === 1);
      if (matches.length !== 1) {
        status = 'skipped';
        reason = `${anchor.path}: anchor not found uniquely`;
        break;
      }
      texts.set(anchor.path, text.replace(matches[0].find, matches[0].replace ?? ''));
    }
    if (status === 'applied' && feature.requires?.length) {
      const missing = feature.requires.filter((id) => !appliedIds.has(id));
      if (missing.length) {
        status = 'skipped';
        reason = `requires ${missing.join(', ')}`;
      }
    }
    if (status === 'applied') {
      for (const [rel, text] of texts) await fs.writeFile(path.join(stage, rel), text);
      for (const marker of feature.markers || []) {
        let text;
        try {
          text = await fs.readFile(path.join(stage, marker.path), 'utf8');
        } catch {
          status = 'degraded';
          reason = `${marker.path}: file missing`;
          break;
        }
        if (!text.includes(marker.text)) {
          status = 'degraded';
          reason = `${marker.path}: marker missing (${marker.text})`;
          break;
        }
      }
    }
    if (status !== 'skipped') appliedIds.add(feature.id);
    features.push({
      id: feature.id, label: feature.label || feature.id, fallback: feature.fallback || '',
      warning: feature.warning !== false, status, ...(reason ? { reason } : {}),
    });
  }
  const degraded = features.filter((f) => f.status !== 'applied');
  if (degraded.length) {
    console.warn(`[overlay] degraded features: ${degraded.map((f) => `${f.id}(${f.status})`).join(', ')}`);
  }
  return { version: data?.version || 1, mode: 'packs', features, degraded };
}

export async function applyOverlay(stage, config, profile, sourceVersion) {
  if (!profile.overlay) return { id: null, applied: [], files: [] };
  const root = path.join(PACKAGER, 'overlays', profile.overlay);
  const manifest = readJson(path.join(root, 'manifest.json'));
  const v = parseSemver(sourceVersion);
  const min = parseSemver(manifest.sourceVersion.min);
  const belowMin = v.major < min.major || (v.major === min.major && (v.minor < min.minor || (v.minor === min.minor && v.patch < min.patch)));
  if (belowMin) fail(`overlay ${manifest.id}@${manifest.version} requires master >= ${manifest.sourceVersion.min}, got ${sourceVersion}`, 'overlay-contract-break');
  const tested = v.major === Number(manifest.sourceVersion.maxMajor) && v.minor <= Number(manifest.sourceVersion.maxMinor);
  if (!tested) {
    console.warn(`[overlay] upstream ${sourceVersion} is newer than the tested range (${manifest.sourceVersion.min} .. ${manifest.sourceVersion.maxMajor}.${manifest.sourceVersion.maxMinor}); attempting optional feature packs`);
  }
  const applied = [];
  const copied = [];
  const anchors = [];
  // Older overlay manifests briefly stored anchor objects beside file mappings.
  // Accept that shape while keeping normal manifests explicit and forward-compatible.
  const fileEntries = (manifest.files || []).filter((entry) => entry && (typeof entry === 'string' || entry.source || entry.destination));
  for (const entry of fileEntries) {
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
  const inlineAnchors = (manifest.files || []).filter((entry) => entry && entry.path && entry.find && !entry.source);
  for (const anchor of [...(manifest.anchors || []), ...inlineAnchors]) {
    const target = path.join(stage, anchor.path);
    if (!exists(target)) fail(`overlay anchor file missing: ${anchor.path}`, 'overlay-contract-break');
    let text = await fs.readFile(target, 'utf8');
    const variants = [anchor, ...(anchor.alternatives || [])];
    const matches = variants.filter(v => text.split(v.find).length - 1 === 1);
    if (matches.length !== 1) fail(`overlay anchor must match exactly once: ${anchor.path} → ${anchor.find}`, 'overlay-contract-break');
    const selected = matches[0];
    text = text.replace(selected.find, selected.replace ?? '');
    await fs.writeFile(target, text);
    anchors.push({ path: anchor.path, find: selected.find });
  }
  const packs = manifest.packs ? await applyFeaturePacks(stage, root, manifest.packs) : null;
  await verifyContracts(stage, manifest);
  for (const forbidden of manifest.forbiddenPaths || []) {
    if (exists(path.join(stage, forbidden))) fail(`overlay contains forbidden path: ${forbidden}`);
    const hit = await forbiddenContent(stage, forbidden);
    if (hit) fail(`overlay contains forbidden token "${forbidden}" in ${hit}`);
  }
  return { id: manifest.id, version: manifest.version, applied, copied, anchors, packs, files: manifest.requiredPaths || [] };
}
