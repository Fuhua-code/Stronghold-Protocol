import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { allocateVersion } from '../ci/version.mjs';
import { fileManifest, safePath, redact, api, releaseMeta, META_PREFIX } from '../ci/lib.mjs';
import { verifyBundle, archivePaths, collectAssetReferences, assessCoverage, selectAssets } from '../ci/inputs.mjs';
import { stageSource } from '../cli/source.mjs';
import { validateReport, resourceMetadata } from '../ci/publish.mjs';
import { classifyBuildFailure, run } from '../cli/common.mjs';
import { reportIssue } from '../ci/notify.mjs';
import { applyOverlay, verifyContracts } from '../cli/overlay.mjs';
import { checkAssets } from '../cli/assets.mjs';

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
    await fs.writeFile(path.join(dir,'input-manifest.json'),JSON.stringify({schema:1,kind:'assets',version:'0.1.0',files}));
    assert.equal((await verifyBundle(dir,'assets','0.2.2')).files.length,1);
    await fs.writeFile(path.join(dir,'resource'),'modified');
    await assert.rejects(()=>verifyBundle(dir,'assets','0.2.1'),/mismatch/);
    await fs.rm(path.join(dir,'resource'));
    await assert.rejects(()=>verifyBundle(dir,'assets','0.2.1'),/count/);
    assert.throws(()=>safePath(dir,'../key'),/Unsafe/);
    assert.throws(()=>archivePaths('./public/a\n../../key\n'),/Unsafe/);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('asset bundles are selected by content coverage, not version or manifest bytes', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'packager-coverage-'));
  try {
    const source=path.join(root,'source'), bundle=path.join(root,'bundle');
    await fs.mkdir(path.join(source,'data'),{recursive:true});
    await fs.writeFile(path.join(source,'data','assets.json'),JSON.stringify(['/assets/board.bin']));
    await fs.writeFile(path.join(source,'data','local-assets.json'),JSON.stringify(['/fonts/ui.woff2']));
    await fs.mkdir(path.join(bundle,'public','assets'),{recursive:true});
    await fs.mkdir(path.join(bundle,'public','fonts'),{recursive:true});
    await fs.writeFile(path.join(bundle,'public','assets','board.bin'),'board');
    await fs.writeFile(path.join(bundle,'public','assets','extra.bin'),'extra');
    await fs.writeFile(path.join(bundle,'public','fonts','ui.woff2'),'font');
    const refs=await collectAssetReferences(source);
    const files=await fileManifest(bundle);
    const manifest={schema:1,kind:'assets',version:'0.2.1',files,totalBytes:files.reduce((sum,row)=>sum+row.bytes,0)};
    await fs.writeFile(path.join(bundle,'input-manifest.json'),JSON.stringify(manifest));
    const verified=await verifyBundle(bundle,'assets');
    const coverage=await assessCoverage(bundle,refs,verified);
    assert.deepEqual(refs,['public/assets/board.bin','public/fonts/ui.woff2']);
    assert.equal(coverage.complete,true);
    assert.deepEqual(coverage.missing,[]);
    assert.deepEqual(coverage.extra,['public/assets/extra.bin']);
    await fs.rm(path.join(bundle,'public','fonts','ui.woff2'));
    const incomplete=await assessCoverage(bundle,refs,verified);
    assert.equal(incomplete.complete,false);
    assert.deepEqual(incomplete.missing,['public/fonts/ui.woff2']);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('complete upstream source coverage is selected without a bundle manifest', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'packager-source-coverage-'));
  try {
    await fs.mkdir(path.join(root, 'data'), { recursive: true });
    await fs.mkdir(path.join(root, 'public', 'assets'), { recursive: true });
    await fs.writeFile(path.join(root, 'data', 'assets.json'), JSON.stringify(['/assets/board.bin']));
    await fs.writeFile(path.join(root, 'public', 'assets', 'board.bin'), 'board');
    const selected = await selectAssets({ source: root, pins: { bundles: [] }, cacheRoot: path.join(root, 'cache') });
    assert.equal(selected.id, 'upstream-source');
    assert.equal(selected.coverage.complete, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('staging preserves the current upstream asset manifests', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'packager-stage-'));
  try {
    const source=path.join(root,'source'), assets=path.join(root,'assets'), stage=path.join(root,'stage');
    await fs.mkdir(path.join(source,'data'),{recursive:true});
    await fs.mkdir(path.join(source,'server'),{recursive:true});
    await fs.mkdir(path.join(source,'public','vendor'),{recursive:true});
    await fs.mkdir(path.join(source,'public','assets'),{recursive:true});
    await fs.mkdir(path.join(source,'public','fonts'),{recursive:true});
    await fs.mkdir(path.join(source,'node_modules','ws'),{recursive:true});
    await fs.mkdir(path.join(source,'shared'),{recursive:true});
    await fs.writeFile(path.join(source,'server','index.js'),'server');
    await fs.writeFile(path.join(source,'shared','protocol.js'),'protocol');
    await fs.writeFile(path.join(source,'public','index.html'),'index');
    await fs.writeFile(path.join(source,'public','vendor','vendor.js'),'vendor');
    await fs.writeFile(path.join(source,'node_modules','ws','index.js'),'ws');
    await fs.writeFile(path.join(source,'data','assets.json'),'["/assets/current.bin"]');
    await fs.writeFile(path.join(source,'data','local-assets.json'),'["/assets/current.bin"]');
    await fs.mkdir(path.join(assets,'public','assets'),{recursive:true});
    await fs.writeFile(path.join(assets,'public','assets','current.bin'),'current');
    await fs.mkdir(path.join(assets,'public','fonts'),{recursive:true});
    await stageSource({masterDir:source,dependencyDir:source,assetsDir:assets},stage);
    assert.equal(await fs.readFile(path.join(stage,'data','assets.json'),'utf8'),'["/assets/current.bin"]');
    assert.equal(await fs.readFile(path.join(stage,'data','local-assets.json'),'utf8'),'["/assets/current.bin"]');
    assert.equal(await fs.readFile(path.join(stage,'public','assets','current.bin'),'utf8'),'current');
  } finally { await fs.rm(root,{recursive:true,force:true}); }
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

test('all blocked paths create one SHA Issue, retries update it, successful publication closes it', async () => {
  const rows=[],writes=[];
  const client=async(route,opts={})=>{
    if(!opts.method)return rows;
    writes.push(opts.method);
    if(opts.method==='POST'){const row={...opts.body,number:1,state:'open'};rows.push(row);return row;}
    Object.assign(rows[0],opts.body);return rows[0];
  };
  for(const code of ['overlay-contract-break','asset-missing-or-mismatch','toolchain/runtime-failure','signing-failure','apk-verification-failure','release-failure']) {
    await reportIssue({sha,report:{code,message:'fixture failure'},runId:'1'},client);
    assert.equal(rows.length,1);
    assert.ok(rows[0].body.includes(code));
    assert.equal(rows[0].title.includes('破坏性更新'),code==='overlay-contract-break');
  }
  assert.equal(writes.filter(x=>x==='POST').length,1);
  await reportIssue({sha,succeeded:true,dryRun:true},client);assert.equal(rows[0].state,'open');
  await reportIssue({sha,succeeded:true},client);assert.equal(rows[0].state,'closed');
});

test('unsupported upstream and absent markers are breaking contracts; unsafe asset URLs reject', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'packager-contract-'));
  try {
    await assert.rejects(()=>applyOverlay(root,{}, {overlay:'connect'},'0.3.0'),e=>e.code==='overlay-contract-break');
    await fs.writeFile(path.join(root,'title.js'),'original title');
    await assert.rejects(()=>verifyContracts(root,{requiredPaths:['title.js'],requiredMarkers:[{path:'title.js',text:'androidBridge'}]}),e=>e.code==='overlay-contract-break');
    await fs.mkdir(path.join(root,'data'));await fs.writeFile(path.join(root,'data/assets.json'),JSON.stringify(['/assets/%2e%2e/private']));
    await assert.rejects(()=>checkAssets(root),e=>e.code==='asset-missing-or-mismatch');
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('Release metadata supports selected multipart resource bundles',()=>{
  const m=resourceMetadata({schema:2,selected:{id:'bundle',input:{manifestSha256:'abc',parts:[{file:'a.tgz',sha256:'def'}]}},runtime:{sha256:'runtime'}});
  assert.equal(m.assetsSha256,'abc');assert.equal(m.assetParts[0].sha256,'def');
  assert.equal(resourceMetadata({assets:{sha256:'legacy'},runtime:{sha256:'r'}}).assetsSha256,'legacy');
});
