import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, fail, writeJson } from '../cli/common.mjs';
import { api, allReleases, releaseMeta, REPO, UPSTREAM, META_PREFIX, sha256, failure } from './lib.mjs';

export function validateReport(report, meta, cert) {
  const sig = report.apk?.signatures;
  if (report.status !== 'success' || report.source?.commit !== meta.sha || report.app?.version !== meta.version || report.app?.versionCode !== meta.versionCode || report.app?.packageName !== 'io.prts.stronghold' || report.packager?.profile !== 'connect' || JSON.stringify([...report.packager.abis].sort()) !== JSON.stringify(['arm64-v8a','x86_64'].sort())) fail('Build report identity verification failed', 'apk-verification-failure');
  if (!sig?.v1 || !sig.v2 || !sig.v3 || !/^[A-F0-9]{64}$/.test(cert || '') || sig.certificateSha256 !== cert) fail('Build report signing verification failed', 'signing-failure');
  if (!report.apk.verification?.ok || !report.apks?.length || !report.apk.runtimeDependencies?.length || report.apk.runtimeDependencies.some(r => !r.elf?.dependencies?.length || r.elf.unresolved?.length)) fail('APK, runtime or ELF verification failed', 'apk-verification-failure');
}

export function resourceMetadata(pins) {
  const input = pins.selected?.input || pins.assets;
  return { assetsBundle: pins.selected?.id || null,
    assetsSha256: input?.manifestSha256 || input?.sha256 || pins.selected?.coverage?.manifestSha256 || null,
    assetParts: input?.parts || (input?.file ? [{ file: input.file, sha256: input.sha256 }] : []),
    runtimeSha256: pins.runtime.sha256 };
}

async function publish() {
  const meta = readJson('outputs/release-meta.json');
  const directory = path.join('outputs/apk', meta.version, 'connect');
  const report = readJson(path.join(directory, 'build-report.json'));
  validateReport(report, meta, String(process.env.PACKAGER_CERT_SHA256 || '').replace(/:/g,'').toUpperCase());
  const history = await allReleases();
  const existing = history.find(r => r.tag_name === meta.tag || (!r.draft && releaseMeta(r)?.sha === meta.sha));
  if (existing && !existing.draft) { console.log(`Already published: ${existing.html_url}`); return; }
  if (history.filter(r => !r.draft).some(r => (releaseMeta(r)?.versionCode || 0) >= meta.versionCode)) fail('Release history moved; versionCode must be reallocated', 'release-failure');
  for (const apk of report.apks) if (await sha256(path.join(directory, path.basename(apk.path))) !== apk.sha256) fail('APK hash changed before publishing', 'apk-verification-failure');
  const pins = readJson('outputs/input-report.json');
  const metadata = { ...meta, overlayVersion: report.overlay.version, ...resourceMetadata(pins) };
  const body = `联机 Android APK，支持 ARM64 手机与 x86_64 模拟器。\n\n- 游戏版本：${meta.version}\n- versionCode：${meta.versionCode}（修订 ${meta.revision}）\n- 上游提交：[${meta.sha}](https://github.com/${UPSTREAM}/commit/${meta.sha})\n- 联机覆盖层：${report.overlay.version}\n- 打包器：${report.packager.version}\n- 资源 SHA256：${metadata.assetsSha256 || 'upstream-source'}\n- Runtime SHA256：${pins.runtime.sha256}\n- 构建：[Actions](https://github.com/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID})\n\nAPK 已通过包名、版本、V1/V2/V3 签名、证书、资源、ELF 依赖及解包服务启动检查。安装命令：\`adb install -r <APK>\`。设备游戏体验需另行验收。\n\n${META_PREFIX}${JSON.stringify(metadata)} -->`;
  // Draft first: no partially uploaded Release becomes publicly advertised.
  const release = existing || await api(`/repos/${REPO}/releases`, { method:'POST', body:{ tag_name:meta.tag, target_commitish:process.env.PACKAGER_SHA || 'main', name:`Android ${meta.version} · ${meta.sha.slice(0,8)} · code ${meta.versionCode}`, body, draft:true, prerelease:false } });
  if (existing) await api(`/repos/${REPO}/releases/${release.id}`, { method:'PATCH', body:{ body } });
  const names = [...report.apks.map(a => path.basename(a.path)), 'SHA256SUMS.txt','build-report.json','overlay-report.json','apk-verify.json'];
  const extra = ['input-report.json','upstream-check.json','release-meta.json'];
  for (const name of extra) await fs.copyFile(path.join('outputs',name), path.join(directory,name));
  for (const name of [...names,...extra]) {
    const prior = release.assets?.find(a => a.name === name);
    if (prior) await api(`/repos/${REPO}/releases/assets/${prior.id}`, { method:'DELETE' });
    const file = path.join(directory, name);
    const { size } = await fs.stat(file);
    const handle = await fs.open(file);
    try {
      const response = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
        method:'POST', headers:{ Authorization:`Bearer ${process.env.GITHUB_TOKEN}`, 'User-Agent':'Stronghold-Protocol-Packager', 'Content-Type':'application/octet-stream','Content-Length':String(size) },
        body:handle.createReadStream(), duplex:'half', signal:AbortSignal.timeout(600_000),
      });
      if (!response.ok) throw new Error(`Release asset upload failed: HTTP ${response.status}`);
    } finally { await handle.close(); }
  }
  const assets = await api(`/repos/${REPO}/releases/${release.id}/assets`);
  if (![...names,...extra].every(n => assets.some(a => a.name === n && a.size > 0))) throw new Error('Incomplete Release upload');
  const published = await api(`/repos/${REPO}/releases/${release.id}`, { method:'PATCH',body:{draft:false} });
  await writeJson('outputs/publish-result.json',{status:'success',sha:meta.sha,versionCode:meta.versionCode,url:published.html_url});
  console.log(published.html_url);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await publish(); } catch(e) { await failure('release-failure',e,{sha:process.env.UPSTREAM_SHA}); process.exitCode=1; }
}
