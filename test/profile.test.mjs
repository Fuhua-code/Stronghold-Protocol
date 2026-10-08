import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

test('profiles keep pure master separate from connect overlay', () => {
  const master = JSON.parse(fs.readFileSync(path.join(root, 'profiles', 'master.json')));
  const connect = JSON.parse(fs.readFileSync(path.join(root, 'profiles', 'connect.json')));
  assert.equal(master.overlay, null);
  assert.equal(connect.overlay, 'connect');
  assert.ok(master.forbiddenPaths.includes('shared/connect.js'));
  assert.ok(connect.requiredPaths.includes('server/index.js'));
});

test('connect overlay declares an explicit supported source range and contracts', () => {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'overlays', 'connect', 'manifest.json')));
  assert.equal(m.sourceVersion.maxMinor, 2);
  assert.ok(m.patches.length >= 2);
  assert.ok(m.requiredMarkers.some((x) => x.path === 'server/index.js' && x.text === '/healthz'));
});

