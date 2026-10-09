import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { allocateVersion } from '../ci/version.mjs';
import { fileManifest, safePath, redact, api, releaseMeta, META_PREFIX } from '../ci/lib.mjs';
import { verifyBundle, archivePaths } from '../ci/inputs.mjs';
import { validateReport } from '../ci/publish.mjs';
import { classifyBuildFailure, run } from '../cli/common.mjs';

const sha = 'a'.repeat(40), cert = 'A'.repeat(64);
const release = (versionCode, version='0.2.1', commit=sha) => ({tag_name:`apk-${version}-${commit}`,draft:false,body:`${META_PREFIX}${JSON.stringify({schema:1,sha:commit,version,versionCode})} -->`});
test('same SHA is idempotent; same version new SHA and later versions increase globally', () => {
  assert.equal(allocateVersion('0.2.1',sha,[]).versionCode,2002);
  const history=[release(2002)];
  assert.equal(allocateVersion('0.2.1',sha,history).skip,true);
  const next=allocateVersion('0.2.1','b'.repeat(40),history);
  assert.equal(next.versionCode,2003); assert.equal(next.revision,2);
  assert.equal(allocateVersion('0.2.2','b'.repeat(40),history).versionCode,2003);
  assert.throws(()=>allocateVersion('0.2.1','b'.repeat(40),[release(2_100_000_000)]),/exhausted/);
  assert.throws(()=>releaseMeta({tag_name:'apk-bad',body:''}),/metadata/);
});
test('input manifest rejects mismatched hash, missing paths, extras and traversal', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'packager-input-'));
  try {
    await fs.writeFile(path.join(dir,'resource'),'expected');
    const files=await fileManifest(dir);
    await fs.writeFile(path.join(dir,'input-manifest.json'),JSON.stringify({schema:1,kind:'assets',version:'0.2.1',files}));
    assert.equal((await verifyBundle(dir,'assets','0.2.1')).files.length,1);
    await fs.writeFile(path.join(dir,'resource'),'modified');
    await assert.rejects(()=>verifyBundle(dir,'assets','0.2.1'),/mismatch/);
    await fs.rm(path.join(dir,'resource'));
    await assert.rejects(()=>verifyBundle(dir,'assets','0.2.1'),/count/);
    assert.throws(()=>safePath(dir,'../key'),/Unsafe/);
    assert.throws(()=>archivePaths('./public/a\n../../key\n'),/Unsafe/);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
test('signing/APK failures gate publication; all ELF dependencies must be checked', () => {
  const meta={sha,version:'0.2.1',versionCode:2002};
  const report={status:'success',source:{commit:sha},app:{version:'0.2.1',versionCode:2002,packageName:'io.prts.stronghold'},packager:{profile:'connect',abis:['arm64-v8a','x86_64']},apks:[{sha256:'f'.repeat(64)}],apk:{signatures:{v1:true,v2:true,v3:true,certificateSha256:cert},verification:{ok:true},runtimeDependencies:[{elf:{dependencies:[{needed:'libc.so'}],unresolved:[]}}]}};
  validateReport(report,meta,cert);
  assert.throws(()=>validateReport(report,meta,'B'.repeat(64)),/signing/);
  report.apk.verification.ok=false; assert.throws(()=>validateReport(report,meta,cert),/verification/);
  report.apk.verification.ok=true; report.apk.runtimeDependencies[0].elf.unresolved=['libz.so.1'];
  assert.throws(()=>validateReport(report,meta,cert),/verification/);
});
test('failure categories distinguish contracts, inputs, runtime, signing and APK verification', () => {
  for(const [message,code] of [['overlay patch conflict','overlay-contract-break'],['asset manifest incomplete','asset-missing-or-mismatch'],['runtime missing','toolchain/runtime-failure'],['keystore absent','signing-failure'],['APK verification failed','apk-verification-failure']]) assert.equal(classifyBuildFailure(new Error(message)),code);
});
test('API failures and diagnostics never expose authentication or signing secrets', async () => {
  const oldFetch=globalThis.fetch, old=process.env.PACKAGER_STORE_PASSWORD;
  process.env.PACKAGER_STORE_PASSWORD='fixture-super-secret';
  globalThis.fetch=async()=>({ok:false,status:503});
  try {
    await assert.rejects(()=>api('/repos/example/repo/releases',{method:'POST',body:{}}),/returned 503/);
    assert.ok(!redact('failure: fixture-super-secret pass:another-secret Bearer ghp_fixture').includes('secret'));
  } finally { globalThis.fetch=oldFetch; if(old===undefined)delete process.env.PACKAGER_STORE_PASSWORD;else process.env.PACKAGER_STORE_PASSWORD=old; }
});
test('patch in staging actually applies inside a parent Git checkout; conflict rejects', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'packager-patch-'));
  try {
    run('git',['init',root]);
    const stage=path.join(root,'stage'); await fs.mkdir(stage); await fs.writeFile(path.join(stage,'entry.js'),'old\n');
    const patch=path.join(root,'overlay.patch'); await fs.writeFile(patch,'diff --git a/entry.js b/entry.js\n--- a/entry.js\n+++ b/entry.js\n@@ -1 +1 @@\n-old\n+remote\n');
    const env={GIT_CEILING_DIRECTORIES:root,GIT_DIR:'',GIT_WORK_TREE:''};
    run('git',['apply','--check',patch],{cwd:stage,env}); run('git',['apply',patch],{cwd:stage,env});
    assert.equal((await fs.readFile(path.join(stage,'entry.js'),'utf8')).replace(/\r\n/g,'\n'),'remote\n');
    assert.equal(run('git',['apply','--check',patch],{cwd:stage,env,allowFail:true}).ok,false);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
