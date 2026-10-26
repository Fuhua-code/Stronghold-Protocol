import { versionCode, fail, writeJson, readJson } from '../cli/common.mjs';
import { allReleases, ANDROID_MAX, releaseMeta, outputs, failure } from './lib.mjs';
import { pathToFileURL } from 'node:url';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function allocateVersion({ version, upstreamTag, upstreamSha, releases, minimum = 300118, force = false }) {
  if (!/^[0-9a-f]{40}$/.test(upstreamSha)) fail('Invalid upstream SHA', 'release-failure');
  if (!SEMVER.test(version)) fail(`Invalid game version ${version}`, 'release-failure');
  const rows = releases.map((release) => ({ release, meta: releaseMeta(release) })).filter((row) => row.meta);
  const same = rows.filter((row) => row.meta.upstreamTag === upstreamTag && row.meta.upstreamSha === upstreamSha);
  const published = same.find((row) => !row.release.draft);
  if (published) return { ...published.meta, skip: true, reuse: true, releaseId: published.release.id, releaseUrl: published.release.html_url, reason: 'published' };
  const draft = same.find((row) => row.release.draft);
  if (draft && !force) return { ...draft.meta, skip: true, reuse: true, releaseId: draft.release.id, releaseUrl: draft.release.html_url, reason: 'draft' };
  if (draft && force) return { ...draft.meta, skip: false, reuse: true, releaseId: draft.release.id, releaseUrl: draft.release.html_url, reason: 'force-draft' };
  const previous = Math.max(minimum - 1, ...rows.map((row) => row.meta.versionCode));
  const code = Math.max(versionCode(version), previous + 1, minimum);
  if (code > ANDROID_MAX) fail('Android versionCode exhausted; publishing blocked', 'release-failure');
  return {
    schema: 2,
    kind: 'apk',
    upstreamTag,
    upstreamSha,
    version,
    versionCode: code,
    revision: rows.filter((row) => row.meta.version === version).length + 1,
    tag: `apk-${version}-${upstreamSha}`,
    skip: false,
    reuse: false,
    reason: 'new',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let detected = null;
    try { detected = readJson('outputs/detection.json'); } catch { /* detection artifact not present */ }
    const detection = detected
      ? {
          ...detected,
          tag: process.env.UPSTREAM_TAG || detected.tag,
          sha: process.env.UPSTREAM_SHA || detected.sha,
          version: process.env.APP_VERSION || detected.version,
          releaseUrl: process.env.UPSTREAM_RELEASE_URL || detected.releaseUrl || null,
          publishedAt: process.env.UPSTREAM_PUBLISHED_AT || detected.publishedAt || null,
          releaseName: process.env.UPSTREAM_RELEASE_NAME || detected.releaseName || null,
        }
      : {
          tag: process.env.UPSTREAM_TAG,
          sha: process.env.UPSTREAM_SHA,
          version: process.env.APP_VERSION,
          releaseUrl: process.env.UPSTREAM_RELEASE_URL || null,
          publishedAt: process.env.UPSTREAM_PUBLISHED_AT || null,
          releaseName: process.env.UPSTREAM_RELEASE_NAME || null,
        };
    const pins = readJson('ci/inputs.json');
    const meta = allocateVersion({
      version: detection.version,
      upstreamTag: detection.tag,
      upstreamSha: detection.sha,
      releases: await allReleases(),
      minimum: Number(pins.legacyMaximumVersionCode || 300117) + 1,
      force: process.env.FORCE === 'true',
    });
    const output = {
      ...meta,
      upstreamReleaseUrl: detection.releaseUrl,
      upstreamPublishedAt: detection.publishedAt,
      upstreamReleaseName: detection.releaseName,
    };
    await writeJson('outputs/release-meta.json', output);
    await outputs({ versionCode: output.versionCode, tag: output.tag, skip: output.skip ? 'true' : 'false', reuse: output.reuse ? 'true' : 'false' });
    console.log(`APK ${output.version}, revision ${output.revision}, versionCode ${output.versionCode} (${output.reason})`);
  } catch (e) { await failure('release-failure', e, { tag: process.env.UPSTREAM_TAG || null, sha: process.env.UPSTREAM_SHA || null }); process.exitCode = 1; }
}
