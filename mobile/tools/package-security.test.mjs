import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertContainedPath,
  findPackageRecord,
  hasPinnedValidSignature,
  normalizeSha256,
  parseDebianPackages,
  parseInReleaseChecksums,
  requireHttpsUrl,
  safeArchivePath,
} from './package-security.mjs';

const digest = 'a'.repeat(64);

test('remote package downloads require HTTPS and an exact SHA-256', () => {
  assert.equal(requireHttpsUrl('https://example.invalid/file').protocol, 'https:');
  assert.throws(() => requireHttpsUrl('http://example.invalid/file'), /HTTPS URL required/);
  assert.throws(() => requireHttpsUrl('https://user@example.invalid/file'), /HTTPS URL required/);
  assert.equal(normalizeSha256(digest), digest);
  assert.throws(() => normalizeSha256('abc'), /SHA-256/);
});

test('archive paths remain below the extraction root', () => {
  assert.equal(safeArchivePath('./usr/bin/node'), 'usr/bin/node');
  assert.equal(assertContainedPath('C:/tmp/extract', 'usr/bin/node'), 'C:\\tmp\\extract\\usr\\bin\\node');
  for (const name of ['../escape', 'usr/../../escape', '/absolute', 'C:/absolute', '\\\\server\\share', 'a\\..\\escape']) {
    assert.throws(() => safeArchivePath(name), /unsafe|absolute|traversal/);
  }
});

test('signed Release SHA256 entries and Debian package metadata are parsed', () => {
  const release = [
    '-----BEGIN PGP SIGNED MESSAGE-----',
    'Hash: SHA512',
    '',
    'Origin: Termux',
    'SHA256:',
    ` ${digest} 1234 main/binary-aarch64/Packages.xz`,
    'SHA512:',
    ' deadbeef 1234 main/binary-aarch64/Packages.xz',
    '-----BEGIN PGP SIGNATURE-----',
    'signature',
  ].join('\n');
  assert.deepEqual(parseInReleaseChecksums(release).get('main/binary-aarch64/Packages.xz'), {
    sha256: digest,
    size: 1234,
  });

  const records = parseDebianPackages([
    'Package: nodejs-lts',
    'Version: 24.18.0-1',
    'Architecture: aarch64',
    'Filename: pool/main/n/nodejs-lts.deb',
    `SHA256: ${digest}`,
    'Description: Termux Node',
    ' package runtime',
    '',
    'Package: libc++',
    'Version: 30',
    'Architecture: all',
    `SHA256: ${digest}`,
    'Filename: pool/main/libc/libc++.deb',
  ].join('\n'));
  assert.equal(findPackageRecord(records, 'nodejs-lts', 'aarch64').version, '24.18.0-1');
  assert.equal(findPackageRecord(records, 'libc++', 'aarch64').filename, 'pool/main/libc/libc++.deb');
  assert.equal(records[0].Description, 'Termux Node\npackage runtime');
  assert.throws(() => findPackageRecord(records, 'openssl', 'aarch64'), /no openssl package/);
});

test('Termux verification only accepts the pinned valid signing key', () => {
  const fingerprint = 'CC72CF8BA7DBFA0182877D045A897D96E57CF20C';
  assert.equal(hasPinnedValidSignature(`[GNUPG:] VALIDSIG ${fingerprint} 2026-10-05 1791204802`, fingerprint), true);
  assert.equal(hasPinnedValidSignature('[GNUPG:] VALIDSIG ABCD 2026-10-05', fingerprint), false);
  assert.equal(hasPinnedValidSignature(`[GNUPG:] GOODSIG ${fingerprint}`, fingerprint), false);
});
