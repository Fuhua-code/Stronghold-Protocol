import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { rewritePaths, rewriteManifest, resourcePaths, behaviorFingerprint } from '../tools/pages-build.mjs';
import { WIRE, sameBuild, peerId } from '../pages/compat.js';
import { randomBytes, randomInt } from '../pages/adapters/crypto.js';

test('Pages paths stay under the project path without rewriting external URLs', () => {
  const base = '/Stronghold-Protocol/';
  assert.equal(rewritePaths('<script src="/js/main.js"></script>', base), '<script src="/Stronghold-Protocol/js/main.js"></script>');
  assert.equal(rewritePaths('url(/assets/a.png)', base), 'url(/Stronghold-Protocol/assets/a.png)');
  assert.equal(rewritePaths("fetch(`/data/${name}.json`)", base), "fetch(`/Stronghold-Protocol/data/${name}.json`)");
  assert.equal(rewritePaths('https://host.test/js/main.js', base), 'https://host.test/js/main.js');
  assert.deepEqual(rewriteManifest({ atlas: ['/assets/a.atlas'], other: 'other' }, base), { atlas: ['/Stronghold-Protocol/assets/a.atlas'], other: 'other' });
  assert.deepEqual([...resourcePaths({ a: ['/assets/a.png'], font: '/fonts/a.woff2', external: 'https://host.test/a' })], ['/assets/a.png', '/fonts/a.woff2']);
});
test('Peer transport rejects application, protocol and behavior incompatibility', () => {
  const expected = { wire: WIRE, app: '0.1.4', protocol: 1, compat: 'abc' };
  assert.equal(sameBuild(expected, expected), true);
  for (const [field, value] of [['app', '0.1.3'], ['protocol', 2], ['compat', 'other'], ['wire', 'other']]) assert.equal(sameBuild(expected, { ...expected, [field]: value }), false);
  assert.equal(sameBuild(expected, null), false);
  assert.equal(peerId('ABCD'), 'stronghold-pages-ABCD');
  assert.throws(() => peerId('../x'));
});
test('browser crypto supplies the existing lobby/session token surface', () => {
  assert.match(randomBytes(16).toString('hex'), /^[a-f0-9]{32}$/);
  for (let i = 0; i < 1000; i++) {
    const n = randomInt(2 ** 32);
    assert.ok(n >= 0 && n < 2 ** 32 && Number.isInteger(n));
    assert.ok(randomInt(10, 12) >= 10);
  }
  assert.throws(() => randomInt(0));
});
test('Pages compatibility fingerprint is stable and covers the upstream rules', async () => {
  const a = await behaviorFingerprint();
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(await behaviorFingerprint(), a);
  const source = await fs.readFile(new URL('../tools/pages-build.mjs', import.meta.url), 'utf8');
  for (const dir of ['server/match', 'server/sim', 'shared', 'server/net.js', 'server/lobby.js']) assert.ok(source.includes(dir));
});
