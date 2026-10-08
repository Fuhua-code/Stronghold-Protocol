#!/usr/bin/env node
import path from 'node:path';
import { exists, fail, loadConfig, parseArgs, run } from './common.mjs';
import { inspectSource } from './source.mjs';
import { signingEnv } from './signing.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const checks = [];
  const check = async (name, fn) => { try { checks.push({ name, ok: true, detail: (await fn()) || '' }); } catch (e) { checks.push({ name, ok: false, detail: e.message }); } };
  await check('node', () => { if (Number(process.versions.node.split('.')[0]) < 22) fail(`Node ${process.versions.node} is too old`); return process.version; });
  await check('master checkout', async () => { const x = await inspectSource(config, args.allowDirty); return `${x.git.commit} ${x.package.version}`; });
  await check('dependency checkout', () => { if (!exists(path.join(config.dependencyDir, 'public', 'vendor'))) fail('public/vendor missing; run npm install in dependency checkout'); if (!exists(path.join(config.dependencyDir, 'node_modules', 'ws'))) fail('node_modules/ws missing; run npm ci in dependency checkout'); return config.dependencyDir; });
  await check('toolchain', () => { const jdk = path.join(config.toolchainDir, 'jdk'); const sdk = path.join(config.toolchainDir, 'android-sdk'); if (!exists(jdk) || !exists(sdk)) fail(`toolchain missing at ${config.toolchainDir}`); return config.toolchainDir; });
  await check('runtime cache', () => { for (const rel of ['runtime', 'termux', 'licenses']) if (!exists(path.join(config.runtimeCacheDir, rel))) fail(`cache/${rel} missing; run bootstrap`); return config.runtimeCacheDir; });
  await check('signing key', () => { const s = signingEnv(config); return `${s.keystore} (${s.alias})`; });
  const failed = checks.filter((x) => !x.ok);
  for (const x of checks) console.log(`${x.ok ? 'OK ' : 'ERR'} ${x.name}: ${x.detail}`);
  console.log(`\n${failed.length ? `${failed.length} check(s) failed` : 'all checks passed'}`);
  process.exitCode = failed.length ? 1 : 0;
}
main().catch((e) => { console.error(`DOCTOR FAILED: ${e.message}`); process.exitCode = 1; });
