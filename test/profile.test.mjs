import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

test('profiles keep pure master, legacy connect and runtime packs separate', () => {
  const master = JSON.parse(fs.readFileSync(path.join(root, 'profiles', 'master.json')));
  const connect = JSON.parse(fs.readFileSync(path.join(root, 'profiles', 'connect.json')));
  const runtime = JSON.parse(fs.readFileSync(path.join(root, 'profiles', 'connect-runtime.json')));
  assert.equal(master.overlay, null);
  assert.equal(connect.overlay, 'connect');
  assert.equal(runtime.overlay, 'connect-runtime');
  assert.equal(runtime.persistence, false);
  assert.ok(runtime.extension);
});

test('connect-runtime declares the schema-2 feature pack contract', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'overlays', 'connect-runtime', 'manifest.json')));
  const packs = JSON.parse(fs.readFileSync(path.join(root, 'overlays', 'connect-runtime', 'packs.json')));
  assert.equal(manifest.id, 'connect-runtime');
  assert.equal(manifest.version, '2.0.0');
  assert.equal(manifest.sourceVersion.maxMinor, 3);
  assert.equal(manifest.packs, 'packs.json');
  assert.ok(Array.isArray(manifest.anchors) && manifest.anchors.length === 0);
  assert.equal(packs.features.length, 11);
  assert.ok(packs.features.some((feature) => feature.id === 'title' && feature.requires.includes('guide')));
});

test('packager manifest owns the independent version and all profiles', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'packager-manifest.json')));
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  assert.equal(manifest.name, 'stronghold-protocol-packager');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, packageJson.version);
  assert.deepEqual(manifest.profiles, ['master', 'connect', 'connect-runtime']);
});
