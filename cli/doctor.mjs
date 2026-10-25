#!/usr/bin/env node
import path from 'node:path';
import fsp from 'node:fs/promises';
import { exists, fail, loadConfig, parseArgs } from './common.mjs';
import { inspectSource } from './source.mjs';
import { inputChecks } from './workbench.mjs';
import { readHistory } from './version.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  if (args.master) config.masterDir = path.resolve(args.master);
  const checks = [];
  const check = async (name, fn) => { try { checks.push({ name, ok: true, detail: (await fn()) || '' }); } catch (e) { checks.push({ name, ok: false, detail: e.message }); } };

  await check('node', () => { if (Number(process.versions.node.split('.')[0]) < 22) fail(`Node ${process.versions.node} is too old`); return process.version; });
  await check('upstream source', async () => {
    const source = await inspectSource(config, true, args.allowAnySource);
    const identity = source.treeHash ? `snapshot ${source.treeHash.slice(0, 12)}` : `${source.git.commit.slice(0, 12)}${source.git.clean ? '' : ' (dirty)'}`;
    return `${source.package.version} ${identity} ${source.capacity} at ${config.masterDir}`;
  });

  for (const item of inputChecks(config, { toolchain: true, signing: false })) {
    await check(item.id, () => { if (!item.ok) fail(`missing: ${item.detail}`); return item.detail; });
  }

  await check('signing key', () => {
    const keystore = path.resolve(path.dirname(config.file), config.keystore);
    if (!exists(keystore)) fail(`keystore missing: ${keystore}`);
    const ready = Boolean(process.env[config.storePasswordEnv || 'PACKAGER_STORE_PASSWORD']);
    return `${keystore}${ready ? '' : ' (passwords must be set in the environment at build time)'}`;
  });

  await check('workbench state', async () => {
    await fsp.mkdir(config.stateDir, { recursive: true });
    await fsp.mkdir(config.buildsDir, { recursive: true });
    const history = await readHistory(config);
    const last = history.entries.reduce((max, entry) => Math.max(max, Number(entry.versionCode) || 0), 0);
    const floor = Math.max(Number(config.versionCodeFloor || 0), Number(history.floor || 0), Number(config.minimumVersionCode || 0));
    return `next versionCode ${Math.max(floor, last + 1)} (floor ${floor}, last ${last || 'none'}), keep ${config.keepBuilds}, builds ${config.buildsDir}`;
  });

  const failed = checks.filter((x) => !x.ok);
  for (const x of checks) console.log(`${x.ok ? 'OK ' : 'ERR'} ${x.name}: ${x.detail}`);
  console.log(`\n${failed.length ? `${failed.length} check(s) failed` : 'all checks passed'}`);
  process.exitCode = failed.length ? 1 : 0;
}
main().catch((e) => { console.error(`DOCTOR FAILED: ${e.message}`); process.exitCode = 1; });
