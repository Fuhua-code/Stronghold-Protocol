import fs from 'node:fs/promises';
import path from 'node:path';
import { PACKAGER, exists, fail } from './common.mjs';

// Shared Android adaptation, independent of the optional remote-connect overlay.
export async function applyPersistence(stage) {
  const changed = [];
  for (const rel of ['public/js/store.js', 'public/js/ui/stats.js', 'public/js/screens/stats.js']) {
    const file = path.join(stage, rel);
    if (!exists(file)) {
      if (rel.endsWith('/store.js')) fail('Preference contract missing: store.js', 'overlay-contract-break');
      continue; // Older upstream versions have no statistics module.
    }
    let text = await fs.readFile(file, 'utf8');
    if (!text.includes('globalThis.localStorage')) fail(`Preference contract changed: ${rel}`, 'overlay-contract-break');
    const modulePath = rel === 'public/js/store.js' ? './preference-storage.js' : '../preference-storage.js';
    // store.js is the common preference API.  stats.js also touches localStorage directly
    // for its bounded history and damaged-envelope backup, so rewrite both paths to the
    // same native bridge.  This keeps settled history, loadouts and operator preferences
    // in the app-private AtomicFile across an APK code/resource replacement.
    text = `import { preferenceStorage } from '${modulePath}';\n` + text.replaceAll('globalThis.localStorage', 'preferenceStorage');
    await fs.writeFile(file, text);
    changed.push(rel);
  }
  const copies = [
    ['templates/common/preference-storage.js', 'public/js/preference-storage.js'],
    ['templates/common/ports.js', 'mobile/node/ports.js'],
    ['templates/common/PreferenceStore.java', 'mobile/android/java/io/prts/stronghold/PreferenceStore.java'],
  ];
  for (const [source, destination] of copies) {
    const target = path.join(stage, destination);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(PACKAGER, source), target);
  }
  // JavascriptInterface is visible to frames. Block frames/objects on the trusted local server,
  // including srcdoc/data frames that a URL request filter cannot reliably identify.
  const securityFile = path.join(stage, 'server/http/common.js');
  let security = await fs.readFile(securityFile, 'utf8');
  const anchor = 'export function setSecurityHeaders(res) {';
  if (security.split(anchor).length !== 2) fail('Local WebView security header contract changed', 'overlay-contract-break');
  security = security.replace(anchor, `${anchor}\n  res.setHeader('Content-Security-Policy', "frame-src 'none'; object-src 'none'");`);
  await fs.writeFile(securityFile, security);
  return { version: 1, backend: 'Android AtomicFile / browser localStorage', prefix: 'sp.pref.', defaultPort: 3000, fallbackPorts: [3001, 3009], changed };
}
