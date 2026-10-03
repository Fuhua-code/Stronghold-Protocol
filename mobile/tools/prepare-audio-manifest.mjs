// Only adjust the APK's copied manifest. Missing optional audio must not shrink the upstream manifest.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const UI_FALLBACKS = {
  timer: '/assets/audio/sfx/customse/act1autochess/act1autochess_g_ui_yourturn.mp3',
  draft: '/assets/audio/sfx/customse/act1autochess/act1autochess_g_ui_player_ready.mp3',
};

export function prepareAudioManifest(source, publicDir) {
  const manifest = structuredClone(source);
  const changes = [];
  const present = url => {
    const relative = url.replace(/^\//, '');
    const target = path.resolve(publicDir, relative);
    if (!target.startsWith(path.resolve(publicDir) + path.sep)) return false;
    try { return fs.statSync(target).isFile() && fs.statSync(target).size > 0; } catch { return false; }
  };
  const visit = (node, prefix) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && value.startsWith('/assets/audio/') && !present(value)) {
        const fallback = prefix === 'audio.sfx.ui' ? UI_FALLBACKS[key] : null;
        node[key] = fallback && present(fallback) ? fallback : null;
        changes.push({ field: `${prefix}.${key}`, missing: value, replacement: node[key] });
      } else visit(value, `${prefix}.${key}`);
    }
  };
  visit(manifest.audio, 'audio');
  if (changes.length) {
    const urls = new Set();
    const collect = value => {
      if (typeof value === 'string' && /^\/(assets|fonts)\//.test(value)) urls.add(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    collect(manifest);
    if (manifest.stats) {
      manifest.stats.files = urls.size;
      manifest.stats.bytes = [...urls].reduce((total, url) => {
        try { return total + fs.statSync(path.join(publicDir, url.slice(1))).size; } catch { return total; }
      }, 0);
    }
    delete manifest.hash;
    manifest.hash = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 12);
  }
  return { manifest, changes };
}
