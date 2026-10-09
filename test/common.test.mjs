import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestUrls, parseArgs, parseSemver, versionCode } from '../cli/common.mjs';

test('stable SemVer and deterministic Android versionCode', () => {
  assert.deepEqual(parseSemver('0.2.1'), { major: 0, minor: 2, patch: 1, text: '0.2.1' });
  assert.equal(versionCode('0.2.1'), 2001);
  assert.equal(versionCode('0.0.1', 4), 4);
});

test('build arguments do not consume the command or following flags', () => {
  assert.deepEqual(parseArgs(['build', '--profile', 'master', '--abis', 'arm64-v8a,x86_64']), {
    command: 'build', profile: 'master', abis: ['arm64-v8a', 'x86_64'], apk: null, allowDirty: false, json: null, versionCode: null,
  });
});

test('asset manifest walker only returns public asset URLs', () => {
  assert.deepEqual(manifestUrls({ a: '/assets/a.png', b: ['/fonts/x.woff2', '/data/nope'], c: { d: '/assets/a.png' } }), ['/assets/a.png', '/fonts/x.woff2', '/assets/a.png']);
});
