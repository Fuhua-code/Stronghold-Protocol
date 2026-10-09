import path from 'node:path';
import { exists, fail, run } from './common.mjs';

export function signingEnv(config) {
  const keystore = process.env.PACKAGER_KEYSTORE || config.keystore;
  const alias = process.env.PACKAGER_KEY_ALIAS || config.keyAlias || 'stronghold';
  const storePassword = process.env[config.storePasswordEnv || 'PACKAGER_STORE_PASSWORD'];
  const keyPassword = process.env[config.keyPasswordEnv || 'PACKAGER_KEY_PASSWORD'] || storePassword;
  const expected = String(process.env.PACKAGER_CERT_SHA256 || config.certificateSha256 || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (!keystore || !exists(path.resolve(path.dirname(config.file), keystore))) fail('external signing key is not configured or does not exist; set PACKAGER_KEYSTORE/config.keystore', 'signing-failure');
  if (!storePassword || !keyPassword) fail('signing passwords must be supplied through PACKAGER_STORE_PASSWORD and PACKAGER_KEY_PASSWORD', 'signing-failure');
  if (!/^[0-9A-F]{64}$/.test(expected)) fail('PACKAGER_CERT_SHA256 or certificateSha256 must be a SHA256 fingerprint', 'signing-failure');
  return { keystore: path.resolve(path.dirname(config.file), keystore), alias, storePassword, keyPassword, expected };
}

export function verifyCertificate(javaHome, signing) {
  const keytool = path.join(javaHome, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool');
  const r = run(keytool, ['-list', '-v', '-keystore', signing.keystore, '-alias', signing.alias, '-storepass:env', 'PACKAGER_STORE_PASSWORD'], { allowFail: true, env: { PACKAGER_STORE_PASSWORD: signing.storePassword, LC_ALL: 'C' } });
  if (!r.ok) fail(`cannot read external signing key ${signing.keystore}; check alias/password`, 'signing-failure');
  const got = (/SHA256:\s*([0-9A-Fa-f:]+)/.exec(r.out)?.[1] || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (got !== signing.expected) fail(`certificate SHA-256 mismatch: expected ${signing.expected}, got ${got || '(none)'}`, 'signing-failure');
  return got;
}
