import fs from 'node:fs/promises';
import path from 'node:path';
import { copyTree, exists, fail, PACKAGER, parseSemver, readJson, run } from './common.mjs';

export async function applyOverlay(stage, config, profile, sourceVersion) {
  if (!profile.overlay) return { id: null, applied: [], files: [] };
  const root = path.join(PACKAGER, 'overlays', profile.overlay);
  const manifest = readJson(path.join(root, 'manifest.json'));
  const v = parseSemver(sourceVersion);
  const min = parseSemver(manifest.sourceVersion.min);
  if (v.major !== manifest.sourceVersion.maxMajor || v.minor !== manifest.sourceVersion.maxMinor || v.major < min.major || (v.major === min.major && v.minor < min.minor)) {
    fail(`overlay ${manifest.id}@${manifest.version} does not support master ${sourceVersion}`);
  }
  const applied = [];
  for (const rel of manifest.patches || []) {
    const patch = path.join(root, rel);
    if (!exists(patch)) fail(`overlay patch missing: ${rel}`);
    const check = run('git', ['apply', '--check', patch], { cwd: stage, allowFail: true });
    if (!check.ok) fail(`overlay patch conflict: ${rel}\n${check.out.slice(-6000)}`);
    run('git', ['apply', '--unsafe-paths', patch], { cwd: stage });
    applied.push(rel);
  }
  // The Android resource-proxy template already contains its mobile entry changes. The title import is kept as
  // a small anchor edit because upstream title.js legitimately changes its surrounding imports between releases.
  if (manifest.id === 'connect') {
    const title = path.join(stage, 'public', 'js', 'screens', 'title.js');
    if (exists(title)) {
      let text = await fs.readFile(title, 'utf8');
      const oldImport = "import { androidBridge, isLoopbackHost, normalizeRemoteUrl, probeRemoteGame } from '../connect.js';";
      const newImport = "import { androidBridge, clearRemoteProxy, configureRemoteProxy, isLoopbackHost, normalizeRemoteUrl, probeRemoteGame } from '../connect.js';";
      if (text.includes(oldImport)) text = text.replace(oldImport, newImport);
      else if (!text.includes(newImport)) fail('overlay contract anchor missing: title.js connect import');
      await fs.writeFile(title, text);
      applied.push('anchor:title.js remote proxy imports');
    }
  }
  for (const rel of manifest.requiredPaths || []) if (!exists(path.join(stage, rel))) fail(`overlay contract path missing after patch: ${rel}`);
  for (const marker of manifest.requiredMarkers || []) {
    const file = path.join(stage, marker.path); const text = await fs.readFile(file, 'utf8');
    if (!text.includes(marker.text)) fail(`overlay contract marker missing: ${marker.path} → ${marker.text}`);
  }
  return { id: manifest.id, version: manifest.version, applied, files: manifest.requiredPaths || [] };
}
