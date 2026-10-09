import fs from 'node:fs/promises';
import { run, writeJson } from '../cli/common.mjs';
import { allReleases, failure, outputs, releaseMeta, UPSTREAM } from './lib.mjs';

try {
  const requested = process.env.REQUESTED_SHA || '';
  if (requested && !/^[0-9a-f]{40}$/.test(requested)) throw new Error('upstream_sha must be a full 40-character commit SHA');
  const remote = run('git', ['ls-remote', `https://github.com/${UPSTREAM}.git`, 'refs/heads/master']).out.trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(remote)) throw new Error('Cannot resolve upstream master');
  const sha = requested || remote;
  await outputs({ sha });
  await writeJson('outputs/detection.json', { sha, upstreamMaster: remote, dryRun: process.env.DRY_RUN === 'true' });
  const processed = (await allReleases()).find(r => !r.draft && releaseMeta(r)?.sha === sha);
  if (processed) {
    await outputs({ skip: true, release: processed.html_url });
    console.log(`Already published ${sha}: ${processed.html_url}`);
  } else {
    await outputs({ skip: false }); console.log(`New upstream commit: ${sha}`);
  }
} catch (e) { await failure('toolchain/runtime-failure', e); process.exitCode = 1; }
