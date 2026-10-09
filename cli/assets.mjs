import fs from 'node:fs/promises';
import path from 'node:path';
import { exists, fail, hashTree, manifestUrls, readJson } from './common.mjs';

export async function checkAssets(stage) {
  const manifests = ['assets.json', 'local-assets.json'].filter((name) => exists(path.join(stage, 'data', name)));
  if (!manifests.includes('assets.json')) fail('data/assets.json is missing from staged source');
  const urls = [...new Set(manifests.flatMap((name) => manifestUrls(readJson(path.join(stage, 'data', name)))))]; const missing = [];
  for (const url of urls) {
    const p = path.join(stage, 'public', ...url.split('/').filter(Boolean).map(decodeURIComponent));
    try { const stat = await fs.stat(p); if (!stat.isFile() || stat.size === 0) missing.push(url); } catch { missing.push(url); }
  }
  if (missing.length) fail(`asset manifest is incomplete: ${missing.length}/${urls.length} missing (e.g. ${missing.slice(0, 8).join(', ')})`, 'asset-missing-or-mismatch');
  const tree = await hashTree(path.join(stage, 'public'));
  return { manifests, manifestFiles: urls.length, publicFiles: tree.files, publicSha256: tree.digest };
}
