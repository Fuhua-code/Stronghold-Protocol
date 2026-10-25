import { pathToFileURL } from 'node:url';
import { run, writeJson } from '../cli/common.mjs';
import { allReleases, api, failure, outputs, releaseMeta, UPSTREAM } from './lib.mjs';

const TAG_PATTERN = /^[A-Za-z0-9._/-]+$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function resolveTagSha(tag) {
  if (!TAG_PATTERN.test(tag)) throw new Error(`Invalid upstream release tag: ${tag}`);
  const result = run('git', ['ls-remote', `https://github.com/${UPSTREAM}.git`, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { allowFail: true });
  if (!result.ok) throw new Error(`Cannot resolve upstream tag ${tag}: ${result.out.slice(-1000)}`);
  const lines = result.out.split(/\r?\n/).filter(Boolean);
  const peeled = lines.find((line) => line.endsWith(`refs/tags/${tag}^{}`));
  const direct = lines.find((line) => line.endsWith(`refs/tags/${tag}`));
  const sha = (peeled || direct || '').split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Upstream tag ${tag} did not resolve to a commit SHA`);
  return sha;
}

export function decideSkip(releases, tag, sha, force = false) {
  const rows = releases.map((release) => ({ release, meta: releaseMeta(release) })).filter((row) => row.meta);
  const same = rows.filter((row) => row.meta.upstreamTag === tag && row.meta.upstreamSha === sha);
  const published = same.find((row) => !row.release.draft);
  if (published) return { skip: true, reason: 'published', release: published.release, meta: published.meta };
  const draft = same.find((row) => row.release.draft);
  if (draft && !force) return { skip: true, reason: 'draft', reuse: true, release: draft.release, meta: draft.meta };
  if (draft && force) return { skip: false, reason: 'force-draft', reuse: true, release: draft.release, meta: draft.meta };
  return { skip: false, reason: 'new' };
}

async function detect() {
  const requested = String(process.env.REQUESTED_RELEASE_TAG || '').trim();
  const force = process.env.FORCE === 'true';
  const release = requested
    ? await api(`/repos/${UPSTREAM}/releases/tags/${encodeURIComponent(requested)}`)
    : await api(`/repos/${UPSTREAM}/releases/latest`);
  if (!release || release.draft) throw new Error('Upstream latest Release is a draft or missing');
  if (release.prerelease) throw new Error(`Upstream latest Release ${release.tag_name} is a prerelease; stable release required`);
  if (requested && release.tag_name !== requested) throw new Error(`Upstream Release tag mismatch: asked ${requested}, got ${release.tag_name}`);
  const tag = release.tag_name;
  const version = tag.replace(/^v/, '');
  if (!SEMVER.test(version)) throw new Error(`Upstream Release tag is not stable SemVer: ${tag}`);
  const sha = resolveTagSha(tag);
  const decision = decideSkip(await allReleases(), tag, sha, force);
  const detection = {
    schema: 2,
    tag,
    version,
    sha,
    releaseId: release.id,
    releaseName: release.name || tag,
    releaseUrl: release.html_url,
    publishedAt: release.published_at || release.created_at || null,
    assets: (release.assets || []).map((asset) => ({
      name: asset.name,
      size: asset.size,
      digest: asset.digest || null,
      url: asset.browser_download_url,
    })),
    skip: decision.skip,
    reason: decision.reason,
    reuse: Boolean(decision.reuse),
    existingTag: decision.release?.tag_name || null,
    dryRun: process.env.DRY_RUN === 'true',
  };
  await writeJson('outputs/detection.json', detection);
  await outputs({ skip: decision.skip ? 'true' : 'false', tag, sha, version, reason: decision.reason });
  console.log(`${decision.skip ? 'Skipping' : 'Detected'} upstream ${tag} (${version}, ${sha.slice(0, 8)}): ${decision.reason}`);
  if (decision.release) console.log(`Existing release: ${decision.release.html_url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  detect().catch(async (error) => {
    await failure('toolchain/runtime-failure', error, { tag: process.env.REQUESTED_RELEASE_TAG || null });
    process.exitCode = 1;
  });
}
