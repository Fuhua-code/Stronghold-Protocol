import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { rewritePaths, rewriteManifest, resourcePaths, behaviorFingerprint } from '../tools/pages-build.mjs';
import { WIRE, sameBuild, peerId } from '../pages/compat.js';
import { randomBytes, randomInt } from '../pages/adapters/crypto.js';
import { ICE_SERVERS, PEER_CONFIG, peerFailureMessage, summarizeIceStats } from '../pages/peer-config.js';

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

test('Peer transport uses several STUN providers and keeps direct-failure text distinct from shutdown', () => {
  assert.ok(ICE_SERVERS.length >= 3);
  assert.ok(ICE_SERVERS.every((server) => Array.isArray(server.urls) && server.urls.length > 0));
  assert.equal(PEER_CONFIG.iceServers, ICE_SERVERS);
  assert.match(peerFailureMessage({ type: 'peer-unavailable' }), /没有找到.*在线房主/);
  assert.match(peerFailureMessage({ type: 'network' }), /联机信令/);
  assert.match(peerFailureMessage({ type: 'webrtc-timeout' }, { remoteDescription: true }), /房间仍在线.*UDP/);
  assert.match(peerFailureMessage({ type: 'webrtc-timeout' }, { iceGatheringState: 'complete', localCandidateTypes: [] }), /未生成.*候选/);
  assert.match(peerFailureMessage({ type: 'webrtc-timeout' }), /不会关闭房主的同盟/);
});

test('ICE summaries retain candidate types and pair state without exposing addresses', () => {
  const summary = summarizeIceStats(new Map([
    ['local', { id: 'local', type: 'local-candidate', candidateType: 'srflx', address: '203.0.113.2' }],
    ['remote', { id: 'remote', type: 'remote-candidate', candidateType: 'relay', ip: '203.0.113.3' }],
    ['pair', { id: 'pair', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local', remoteCandidateId: 'remote' }],
  ]));
  assert.deepEqual(summary, {
    localCandidateTypes: ['srflx'],
    remoteCandidateTypes: ['relay'],
    pairs: [{ state: 'succeeded', nominated: true, local: 'srflx', remote: 'relay' }],
  });
  assert.equal(JSON.stringify(summary).includes('203.0.113.'), false);
});
