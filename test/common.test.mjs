import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestUrls, parseArgs, parseSemver, versionCode } from '../cli/common.mjs';

test('stable SemVer and deterministic Android versionCode', () => {
  assert.deepEqual(parseSemver('0.3.2'), { major: 0, minor: 3, patch: 2, text: '0.3.2' });
  assert.equal(versionCode('0.3.2'), 3002);
  assert.equal(versionCode('0.0.1', 4), 4);
});

test('build arguments accept the workbench flags and keep values', () => {
  const args = parseArgs(['build', '--profile', 'connect-runtime', '--abis', 'arm64-v8a,x86_64', '--version-code', 'auto', '--master', 'upstream', '--allow-dirty', '--strict', '--keep', '2']);
  assert.equal(args.command, 'build');
  assert.equal(args.profile, 'connect-runtime');
  assert.deepEqual(args.abis, ['arm64-v8a', 'x86_64']);
  assert.equal(args.versionCode, 'auto');
  assert.equal(args.master, 'upstream');
  assert.equal(args.allowDirty, true);
  assert.equal(args.strict, true);
  assert.equal(args.keep, 2);
});

test('asset manifest walker only returns public asset URLs', () => {
  assert.deepEqual(manifestUrls({ a: '/assets/a.png', b: ['/fonts/x.woff2', '/data/nope'], c: { d: '/assets/a.png' } }), ['/assets/a.png', '/fonts/x.woff2', '/assets/a.png']);
});
