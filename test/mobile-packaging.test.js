import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareAudioManifest } from '../mobile/tools/prepare-audio-manifest.mjs';

test('APK audio preparation preserves upstream and required assets while falling back only for missing audio', async t => {
  const publicDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-apk-audio-'));
  t.after(() => fs.rm(publicDir, { recursive: true, force: true }));
  const fallback = '/assets/audio/sfx/customse/act1autochess/act1autochess_g_ui_yourturn.mp3';
  const loop = '/assets/audio/bgm/loop.mp3';
  for (const url of [fallback, loop]) {
    await fs.mkdir(path.dirname(path.join(publicDir, url)), { recursive: true });
    await fs.writeFile(path.join(publicDir, url), 'audio');
  }
  const source = { hash: 'upstream', stats: { files: 5 }, ui: { required: '/assets/missing.png' },
    audio: { bgm: { loop, intro: '/assets/audio/bgm/missing.mp3' },
      sfx: { ui: { timer: '/assets/audio/missing-timer.mp3', draft: '/assets/audio/missing-draft.mp3' } } } };
  const before = JSON.stringify(source);
  const result = prepareAudioManifest(source, publicDir);
  assert.equal(JSON.stringify(source), before);
  assert.equal(result.manifest.audio.bgm.loop, loop);
  assert.equal(result.manifest.audio.bgm.intro, null);
  assert.equal(result.manifest.audio.sfx.ui.timer, fallback);
  assert.equal(result.manifest.audio.sfx.ui.draft, null);
  assert.equal(result.manifest.ui.required, '/assets/missing.png');
  assert.equal(result.changes.length, 3);
  assert.notEqual(result.manifest.hash, source.hash);
});

test('complete audio manifest is copied without changing its hash or metadata', () => {
  const source = { hash: 'upstream', stats: { files: 0 }, audio: { sfx: {} } };
  const result = prepareAudioManifest(source, os.tmpdir());
  assert.deepEqual(result.manifest, source);
  assert.notEqual(result.manifest, source);
  assert.deepEqual(result.changes, []);
});
