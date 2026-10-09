import fs from 'node:fs/promises';
import path from 'node:path';
import { copyTree, PACKAGER, readJson, writeJson } from '../cli/common.mjs';
import { applyOverlay } from '../cli/overlay.mjs';
import { failure } from './lib.mjs';

const stage = path.resolve('.staging', `ci-contract-${process.pid}`);
try {
  await copyTree(process.env.UPSTREAM_DIR, stage, { filter: (p, name) => !['.git','node_modules','assets','fonts','vendor','outputs','mobile'].includes(path.basename(p)) });
  const profile = readJson('profiles/connect.json');
  await copyTree(path.join(PACKAGER, 'templates', profile.mobileTemplate), path.join(stage, 'mobile'));
  const version = readJson(path.join(stage, 'package.json')).version;
  const overlay = await applyOverlay(stage, {}, profile, version);
  await writeJson('outputs/overlay-preflight.json', {status:'success',sha:process.env.UPSTREAM_SHA,version,overlay});
  console.log('Overlay contracts passed');
} catch(e) { await failure('overlay-contract-break',e,{sha:process.env.UPSTREAM_SHA}); process.exitCode=1; }
finally { await fs.rm(stage,{recursive:true,force:true}); }
