#!/usr/bin/env node
// Build the local art index shipped inside the APK. The index lets the Android WebView answer a
// remote page's /assets, /fonts, /media and /icons requests from assets/nodejs-project without
// touching remote /js, /data, /p, /cs or /vs requests.
//
// The hashes must be the same ones the server puts in its asset URLs:
//   * 16 hex digits of SHA-256 for a file;
//   * for a Spine model, SHA-256 of its members' hashes joined by newlines (assetIndex.modelHash).
// Reusing server/http/assetIndex.js and assetViews.js keeps this in lockstep with the served manifests.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.json': 'application/json', '.atlas': 'text/plain', '.skel': 'application/octet-stream',
  '.txt': 'text/plain', '.xml': 'application/xml',
};
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.aac']);

function mimeOf(rel) {
  return MIME[path.posix.extname(rel).toLowerCase()] || 'application/octet-stream';
}

async function listFiles(root, roots) {
  const out = [];
  const walk = async (dir, rel) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      const next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(abs, next);
      else if (entry.isFile()) out.push(next);
    }
  };
  for (const rootName of roots) await walk(path.join(root, rootName), rootName);
  return out.sort();
}

/**
 * @param {{ repo: string, publicDir: string, dataDir: string, outFile: string, log?: Console }} opts
 * @returns {Promise<{ count: number, files: number, aliases: number, outFile: string }>}
 */
export async function buildArtIndex({ repo, publicDir, dataDir, outFile, log = console }) {
  const { createAssetIndex } = await import(pathToFileURL(path.join(repo, 'server', 'http', 'assetIndex.js')).href);
  const { rewriteManifest } = await import(pathToFileURL(path.join(repo, 'server', 'http', 'assetViews.js')).href);
  const index = createAssetIndex({ publicDir, roots: ['assets', 'fonts', 'icons'], cacheFile: null, delayMs: 0 });
  await index.refresh();

  const models = [];
  for (const name of ['assets.json', 'local-assets.json', 'local-fx.json']) {
    const file = path.join(dataDir, name);
    if (!fs.existsSync(file)) continue;
    const doc = JSON.parse(await fsp.readFile(file, 'utf8'));
    const rewritten = rewriteManifest(doc, name, index);
    models.push(...rewritten.models);
  }
  index.setModels(models);

  const files = await listFiles(publicDir, ['assets', 'fonts', 'icons']);
  /** @type {Map<string, { assetPath: string, fileHash: string, modelHashes: Set<string>, size: number, mime: string }>} */
  const rows = new Map();
  for (const rel of files) {
    const fileHash = index.hashOf(rel);
    if (!fileHash) continue;
    const stat = await fsp.stat(path.join(publicDir, rel));
    if (!stat.isFile()) continue;
    const url = `/${rel}`;
    if (/[\t\r\n]/.test(url)) throw new Error(`unsafe art index URL: ${url}`);
    rows.set(url, {
      assetPath: `public/${rel}`,
      fileHash,
      modelHashes: new Set(),
      size: stat.size,
      mime: mimeOf(rel),
    });
  }
  for (const list of models) {
    const hash = index.modelHash(list);
    if (!hash) continue;
    for (const rel of list) {
      const row = rows.get(`/${rel}`);
      if (row) row.modelHashes.add(hash);
    }
  }

  // /media/<stem> is the audio alias the client uses; add it only when the stem is unambiguous.
  const media = new Map();
  for (const [url, row] of rows) {
    if (!url.startsWith('/assets/audio/')) continue;
    const ext = path.posix.extname(url).toLowerCase();
    if (!AUDIO_EXT.has(ext)) continue;
    const stem = path.posix.basename(url, path.posix.extname(url));
    const key = `/media/${stem}`;
    if (media.has(key)) media.set(key, null);
    else media.set(key, row);
  }
  let aliases = 0;
  for (const [url, row] of media) {
    if (!row || rows.has(url)) continue;
    rows.set(url, row);
    aliases++;
  }

  const keys = [...rows.keys()].sort();
  const lines = keys.map((url) => {
    const row = rows.get(url);
    const modelHashes = [...row.modelHashes].sort().join(',') || '-';
    return [url, row.fileHash, modelHashes, String(row.size), row.mime, row.assetPath].join('\t');
  });
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  await fsp.writeFile(outFile, `# schema=1 count=${lines.length}\n${lines.join('\n')}\n`, 'utf8');
  log?.info?.(`[art-index] ${lines.length} URLs (${files.length} files, ${aliases} media aliases, ${models.length} Spine models)`);
  return { count: lines.length, files: files.length, aliases, outFile };
}
