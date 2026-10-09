import { versionCode, fail, writeJson, readJson } from '../cli/common.mjs';
import { allReleases, ANDROID_MAX, releaseMeta, outputs, failure } from './lib.mjs';
import { pathToFileURL } from 'node:url';

export function allocateVersion(version, sha, releases, minimum = 2002) {
  if (!/^[0-9a-f]{40}$/.test(sha)) fail('Invalid upstream SHA', 'release-failure');
  const history = releases.filter(r => !r.draft).map(releaseMeta).filter(Boolean);
  const existing = history.find(m => m.sha === sha);
  if (existing) return { ...existing, skip: true };
  const previous = Math.max(minimum - 1, ...history.map(m => m.versionCode));
  const code = Math.max(versionCode(version), previous + 1, minimum);
  if (code > ANDROID_MAX) fail('Android versionCode exhausted; publishing blocked', 'release-failure');
  return { schema: 1, version, sha, versionCode: code, revision: history.filter(m => m.version === version).length + 1, tag: `apk-${version}-${sha}`, skip: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const meta = allocateVersion(process.env.APP_VERSION, process.env.UPSTREAM_SHA, await allReleases(), readJson('ci/inputs.json').legacyMaximumVersionCode + 1);
    await writeJson('outputs/release-meta.json', meta); await outputs({ versionCode: meta.versionCode, tag: meta.tag });
    console.log(`APK ${meta.version}, revision ${meta.revision}, versionCode ${meta.versionCode}`);
  } catch (e) { await failure('release-failure', e, { sha: process.env.UPSTREAM_SHA }); process.exitCode = 1; }
}
