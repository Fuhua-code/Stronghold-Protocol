import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { readJson, writeJson } from '../cli/common.mjs';
import { failure, outputs, redact } from './lib.mjs';

const cwd = process.env.UPSTREAM_DIR;
const env = { ...process.env, SP_E2E: '0', SP_REAL_E2E: '0', RENDER_E2E: '0', NO_COLOR: '1', HOST: '127.0.0.1' };
for (const name of Object.keys(env)) if (/TOKEN|PASSWORD|SECRET|KEYSTORE/i.test(name)) delete env[name];
async function command(label, executable, args) {
  console.log(label);
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', maxBuffer: 128 << 20, windowsHide: true, shell: process.platform === 'win32' && executable.endsWith('.cmd') });
  await fs.mkdir('outputs/logs', { recursive: true });
  const text = redact(`${result.stdout || ''}${result.stderr || ''}`);
  await fs.writeFile(`outputs/logs/${label}.log`, text);
  if (result.status !== 0) throw new Error(`${label} failed: ${text.slice(-4000)}`);
}
try {
  const pkg = readJson(path.join(cwd, 'package.json'));
  await outputs({ version: pkg.version });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await command('install', npm, ['ci', '--no-audit', '--no-fund']);
  if (await fs.stat(path.join(cwd, 'tools/setup.mjs')).catch(() => null)) await command('setup', process.execPath, ['tools/setup.mjs', '--check', '--no-local']);
  await command('upstream-tests', npm, ['test']);
  for (const name of ['lint', 'check:imports', 'typecheck']) if (pkg.scripts[name]) await command(name.replace(':','-'), npm, ['run', name]);
  const server = spawn(process.execPath, ['--input-type=module', '-e', "import {startServer} from './server/index.js'; const s=await startServer({host:'127.0.0.1',port:0}); console.log('SMOKE_PORT='+s.server.address().port);"], { cwd, env, stdio: ['ignore','pipe','pipe'], windowsHide: true });
  let log = ''; server.stdout.on('data', x => log += x); server.stderr.on('data', x => log += x);
  try {
    const deadline = Date.now() + 30_000;
    while (!/SMOKE_PORT=(\d+)/.test(log) && Date.now() < deadline && server.exitCode === null) await new Promise(r => setTimeout(r, 200));
    const port = /SMOKE_PORT=(\d+)/.exec(log)?.[1];
    if (!port) throw new Error('Server smoke check did not bind: ' + redact(log).slice(-1000));
    for (const [route, test] of [['/healthz', x => JSON.parse(x).ok === true], ['/', x => /<html/i.test(x)], ['/vendor/pixi.min.js', x => x.length > 100]]) {
      const r = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok || !test(await r.text())) throw new Error(`Server smoke failed for ${route}`);
    }
  } finally { server.kill(); }
  await writeJson('outputs/upstream-check.json', { status: 'success', sha: process.env.UPSTREAM_SHA, version: pkg.version, tests: ['npm ci','setup','npm test','lint','check:imports','typecheck','server smoke'] });
} catch(e) { await failure('upstream-test-failure', e, { sha: process.env.UPSTREAM_SHA }); process.exitCode = 1; }
