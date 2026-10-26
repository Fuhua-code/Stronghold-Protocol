#!/usr/bin/env node
/**
 * Build an Android package from an external, clean master checkout.
 * Nothing in the source checkout is modified: all patches and Android work happen in staging.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKAGER, classifyBuildFailure, copyTree, exists, fail, hashTree, loadConfig, parseArgs, readJson,
  removeIfExists, run, writeJson, sanitizeDiagnostic,
} from './common.mjs';
import { inspectSource, stageSource } from './source.mjs';
import { checkAssets, normalizeAssetCase } from './assets.mjs';
import { applyOverlay } from './overlay.mjs';
import { applyPersistence } from './persistence.mjs';
import { signingEnv, verifyCertificate } from './signing.mjs';
import { finalizeReport } from './report.mjs';
import { allocateVersionCode, pruneBuilds, recordBuild } from './version.mjs';
import { buildCompatReport, compatStatus, writeBuildOutputs } from './compat.mjs';
import { verifySourceUnchanged } from './workbench.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function profileConfig(name) {
  const p = path.join(PACKAGER, 'profiles', `${name}.json`);
  if (!exists(p)) fail(`unknown profile ${name}; expected profiles/${name}.json`);
  return { ...readJson(p), file: p };
}

async function copyMobileTemplate(templateName, stage) {
  const source = path.join(PACKAGER, 'templates', templateName);
  if (!exists(source)) fail(`missing Android template: ${source}`);
  await copyTree(source, path.join(stage, 'mobile'), {
    filter: (p, rel) => {
      const first = rel.split(/[\\/]/)[0];
      return !['build', 'outputs', 'keystore', 'keys-local'].includes(first);
    },
  });
  // Keep the APK verifier and the staging smoke check on the same dynamic
  // board-resource resolver used by the packager itself.
  const boardAssets = path.join(PACKAGER, 'templates', 'common', 'board-assets.mjs');
  if (exists(boardAssets)) {
    await fsp.copyFile(boardAssets, path.join(stage, 'mobile', 'tools', 'board-assets.mjs'));
  }
}

async function copyRuntimeCache(config, stage) {
  const cache = config.runtimeCacheDir;
  const required = ['runtime', 'termux', 'licenses'];
  const missing = required.filter((x) => !exists(path.join(cache, x)));
  if (missing.length) fail(`runtime cache is incomplete (${missing.join(', ')}); run packager.cmd bootstrap after preparing mobile/build`);
  for (const rel of required) await copyTree(path.join(cache, rel), path.join(stage, 'mobile', 'build', rel));
}

/** Native preference storage is compiled into the activity for every profile (the source rewrite is optional). */
async function copyNativePersistence(stage) {
  const source = path.join(PACKAGER, 'templates', 'common', 'PreferenceStore.java');
  const destination = path.join(stage, 'mobile', 'android', 'java', 'io', 'prts', 'stronghold', 'PreferenceStore.java');
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.copyFile(source, destination);
  const ports = path.join(PACKAGER, 'templates', 'common', 'ports.js');
  const portsDestination = path.join(stage, 'mobile', 'node', 'ports.js');
  if (!exists(portsDestination)) await fsp.copyFile(ports, portsDestination);
}

/** Copy the runtime extension and inject its external boot/UI scripts and feature report. */
async function applyExtension(stage, profile, overlay) {
  const extension = profile.extension;
  if (!extension) return null;
  const source = path.join(PACKAGER, extension.dir);
  if (!exists(source)) fail(`missing runtime extension directory: ${extension.dir}`);
  const destination = path.join(stage, 'public', 'sp-extension');
  await copyTree(source, destination);
  const boot = extension.boot || 'boot.js';
  if (!exists(path.join(destination, boot))) fail(`runtime extension is missing ${boot}`);
  const ui = extension.ui || (exists(path.join(destination, 'ui.js')) ? 'ui.js' : null);
  const css = extension.css || (exists(path.join(destination, 'connect.css')) ? 'connect.css' : null);
  const index = path.join(stage, 'public', 'index.html');
  let html = await fsp.readFile(index, 'utf8');
  const headTags = [
    ...(css ? [`<link rel="stylesheet" href="/sp-extension/${css}">`] : []),
    ...(/href="\/css\/connect\.css"/.test(html) ? [] : ['<link rel="stylesheet" href="/css/connect.css">']),
    `<script src="/sp-extension/${boot}"></script>`,
  ].filter((tag) => !html.includes(tag));
  if (headTags.length) {
    if (!/<\/head>/i.test(html)) fail('public/index.html has no </head>; cannot inject the runtime boot script', 'overlay-contract-break');
    html = html.replace(/<\/head>/i, `  ${headTags.join('\n  ')}\n</head>`);
  }
  if (ui) {
    const tag = `<script type="module" src="/sp-extension/${ui}"></script>`;
    if (!html.includes(tag)) {
      if (!/<\/body>/i.test(html)) fail('public/index.html has no </body>; cannot inject the runtime UI script', 'overlay-contract-break');
      html = html.replace(/<\/body>/i, `  ${tag}\n</body>`);
    }
  }
  await fsp.writeFile(index, html);
  const features = {
    version: 1,
    mode: overlay?.packs?.mode || 'overlay',
    boot,
    ui,
    css,
    features: overlay?.packs?.features || [],
    degraded: overlay?.packs?.degraded || [],
    generatedAt: new Date().toISOString(),
  };
  await writeJson(path.join(destination, 'features.json'), features);
  if (features.degraded.length) {
    console.warn(`[extension] degraded features: ${features.degraded.map((f) => `${f.id}(${f.status})`).join(', ')}`);
  }
  return { directory: 'public/sp-extension', boot, ui, css, injected: true, features: features.features, degraded: features.degraded };
}

function checkForbidden(stage, profile) {
  for (const rel of profile.forbiddenPaths || []) {
    if (exists(path.join(stage, rel))) fail(`profile ${profile.id} contains forbidden path: ${rel}`);
  }
}

function checkRuntimeToolInputs(stage) {
  // Upstream 0.3.x moved plugin validation into server/plugins/pack.js. Its
  // parser imports are runtime dependencies of the APK, so validate the
  // staged copy before spending time assembling the native package.
  if (!exists(path.join(stage, 'server', 'plugins', 'pack.js'))) return;
  const root = path.join(stage, 'tools', 'assets');
  if (!exists(root)) fail('staging is missing tools/assets required by server/plugins/pack.js', 'toolchain/runtime-failure');
  const required = ['skel.mjs', 'atlas.mjs', 'anim-roles.mjs'];
  const missing = required.filter((name) => !exists(path.join(root, name)));
  if (missing.length) fail(`staging tools/assets is incomplete: ${missing.join(', ')}`, 'toolchain/runtime-failure');
}

async function runApkCheck(stage, apk, json) {
  const checker = path.join(stage, 'mobile', 'tools', 'check-apk.mjs');
  if (!exists(checker)) fail('Android template does not include mobile/tools/check-apk.mjs');
  const cleanEnv = Object.fromEntries(Object.keys(process.env).filter(k => /TOKEN|PASSWORD|SECRET|KEYSTORE/i.test(k)).map(k => [k, '']));
  const result = run(process.execPath, [checker, '--apk', apk, '--json', json], { cwd: stage, env: cleanEnv, allowFail: true });
  if (!result.ok) fail(`APK verification failed\n${result.out.slice(-8000)}`);
  if (!exists(json)) fail('APK checker exited successfully without writing apk-verify.json');
  return readJson(json);
}

async function build(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = loadConfig();
  if (args.master) config.masterDir = path.resolve(args.master);
  const profile = profileConfig(args.profile || config.defaultProfile || 'connect-runtime');
  const abis = args.abis || config.defaultAbis || ['arm64-v8a'];
  if (!abis.length) fail('at least one ABI is required');
  const source = await inspectSource(config, args.allowDirty, args.allowAnySource);
  const version = source.package.version;
  const explicitCode = args.versionCode === 'auto' ? null : args.versionCode;
  const allocation = await allocateVersionCode(config, { version, explicit: explicitCode });
  const code = allocation.code;
  if (args.versionCode === 'auto') console.log(`[version] auto ${code} (floor ${allocation.floor}, last ${allocation.last || 'none'})`);
  const signing = signingEnv(config);
  const sourceLabel = source.git.commit.slice(0, 12);
  const outputDir = path.join(config.buildsDir || config.outputDir, version, profile.id, `${code}-${sourceLabel}`);
  const stage = path.join(PACKAGER, '.staging', `${version}-${profile.id}-${code}-${process.pid}-${Date.now()}`);
  const sourceBefore = source.treeHash
    ? { treeHash: source.treeHash }
    : { commit: source.git.commit, clean: source.git.clean, status: source.git.status };
  const core = [];
  let injected = { ran: false, ok: true, tests: [] };
  await removeIfExists(stage);
  await fsp.mkdir(stage, { recursive: true });
  await fsp.mkdir(outputDir, { recursive: true });
  let keptStage = true;
  try {
    console.log(`Building ${profile.id} from ${source.git.branch} ${source.git.commit} (${version}, versionCode ${code})`);
    await stageSource(config, stage);
    const manifestSource = args.committedAssetsManifest ? `commit:${source.git.commit}` : 'working-tree';
    if (args.committedAssetsManifest) {
      if (source.treeHash) fail('--committed-assets-manifest requires a git checkout, not a source snapshot');
      const committed = run('git', ['-C', config.masterDir, 'show', `${source.git.commit}:data/assets.json`]).out;
      try { JSON.parse(committed); } catch { fail(`committed data/assets.json at ${source.git.commit} is invalid`, 'asset-missing-or-mismatch'); }
      await fsp.writeFile(path.join(stage, 'data', 'assets.json'), committed);
    }
    await normalizeAssetCase(stage);
    const assets = { ...(await checkAssets(stage)), manifestSource };
    core.push({ id: 'source', ok: true, detail: `${source.git.branch} ${source.git.commit} (${version}, ${source.capacity})` });
    core.push({ id: 'assets', ok: true, detail: `${manifestSource} (${assets.files ?? assets.count ?? 'ok'})` });
    checkRuntimeToolInputs(stage);
    await copyMobileTemplate(profile.mobileTemplate, stage);
    await copyRuntimeCache(config, stage);
    await copyNativePersistence(stage);
    const overlay = await applyOverlay(stage, config, profile, version);
    core.push({ id: 'overlay', ok: true, detail: overlay.id ? `${overlay.id}@${overlay.version} (${overlay.packs?.mode || 'anchors'})` : 'none' });
    const persistence = profile.persistence === false ? null : await applyPersistence(stage);
    const extension = await applyExtension(stage, profile, overlay);
    checkForbidden(stage, profile);
    if (process.env.PACKAGER_CI === 'true') {
      const env = { SP_E2E: '0', SP_REAL_E2E: '0', RENDER_E2E: '0', NO_COLOR: '1',
        ...Object.fromEntries(Object.keys(process.env).filter(k => /TOKEN|PASSWORD|SECRET|KEYSTORE/i.test(k)).map(k => [k, ''])) };
      // The upstream suite already ran against the original checkout.  Run only the
      // profile's injected tests here: many upstream tests inspect Git metadata or
      // repository-relative documentation and cannot be meaningful in staging.
      const injectedTests = profile.injectedTests || (profile.id === 'connect' ? ['test/remote-overlay.test.mjs'] : []);
      const tested = injectedTests.length ? run(process.execPath, ['--test', ...injectedTests], { cwd: stage, env, allowFail: true }) : { ok: true, out: '' };
      await fsp.writeFile(path.join(outputDir, 'overlay-tests.log'), sanitizeDiagnostic(tested.out));
      injected = { ran: injectedTests.length > 0, ok: tested.ok, tests: injectedTests };
      if (!tested.ok) fail(`Injected server tests failed\n${sanitizeDiagnostic(tested.out.slice(-6000))}`, 'overlay-contract-break');
    }
    core.push({ id: 'injected-tests', ok: true, detail: injected.ran ? injected.tests.join(', ') : 'skipped (PACKAGER_CI not set)' });
    const tree = await hashTree(stage);
    const apkName = `Stronghold-Protocol-${version}-${abis.join('-')}.apk`;
    const stagedApk = path.join(stage, apkName);
    const reportPath = path.join(stage, 'build-report.json');
    const env = {
      SP_VERSION_CODE: String(code),
      SP_TOOLCHAIN: config.toolchainDir,
      SP_KEYSTORE: signing.keystore,
      SP_KEY_ALIAS: signing.alias,
      SP_STORE_PASSWORD: signing.storePassword,
      SP_KEY_PASSWORD: signing.keyPassword,
      SP_BUILD_TOOLS: config.buildTools || '35.0.0',
      SP_PLATFORM: config.platform || 'android-35',
      SP_PACKAGE_NAME: config.packageName,
    };
    const javaHome = exists(path.join(config.toolchainDir, 'jdk')) ? path.join(config.toolchainDir, 'jdk') : process.env.JAVA_HOME;
    if (!javaHome) fail('JDK is required to verify the signing certificate', 'signing-failure');
    verifyCertificate(javaHome, signing);
    core.push({ id: 'certificate', ok: true, detail: signing.expected });
    const mobileBuilder = path.join(stage, 'mobile', 'build-apk.mjs');
    if (!exists(mobileBuilder)) fail('Android template is missing mobile/build-apk.mjs');
    const argsForBuilder = [mobileBuilder, `--abi=${abis.join(',')}`, `--out=${stagedApk}`, `--json=${reportPath}`, '--no-download'];
    const built = run(process.execPath, argsForBuilder, { cwd: stage, env, allowFail: true });
    if (!built.ok) fail(`Android build failed\n${built.out.slice(-10000)}`);
    if (!exists(stagedApk)) fail(`Android builder did not produce ${stagedApk}`);
    const builderReport = exists(reportPath) ? readJson(reportPath) : null;
    const sig = builderReport?.apk?.signatures;
    if (!sig?.v1 || !sig.v2 || !sig.v3 || sig.certificateSha256 !== signing.expected) fail('APK signature or certificate verification failed', 'signing-failure');
    core.push({ id: 'signature', ok: true, detail: `v1/v2/v3 ${sig.certificateSha256}` });
    const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || path.join(config.toolchainDir, 'android-sdk');
    const aapt = path.join(sdk, 'build-tools', config.buildTools || '35.0.0', process.platform === 'win32' ? 'aapt2.exe' : 'aapt2');
    const badging = run(aapt, ['dump', 'badging', stagedApk]).out;
    if (!badging.includes(`name='${config.packageName}'`) || !badging.includes(`versionName='${version}'`) || !badging.includes(`versionCode='${code}'`)) fail('APK package/version mismatch', 'apk-verification-failure');
    const unchanged = await verifySourceUnchanged(config, sourceBefore);
    if (!unchanged.ok) fail(`upstream source changed during the build (${unchanged.before} → ${unchanged.after}); refusing to publish a mixed build`, 'upstream-source-changed');
    core.push({ id: 'source-integrity', ok: true, detail: `unchanged ${unchanged.after}` });
    const finalApk = path.join(outputDir, apkName);
    await fsp.copyFile(stagedApk, finalApk);
    const verifyPath = path.join(outputDir, 'apk-verify.json');
    const verify = await runApkCheck(stage, finalApk, verifyPath);
    core.push({ id: 'apk-verification', ok: true, detail: `${verify.checks?.length || 0} checks` });
    const packagerManifest = readJson(path.join(PACKAGER, 'packager-manifest.json'));
    const finalReport = {
      status: 'success', generatedAt: new Date().toISOString(),
      source: { directory: config.masterDir, branch: source.git.branch, commit: source.git.commit, clean: source.git.clean, treeHash: source.treeHash, capacity: source.capacity },
      app: { version, versionCode: code, versionCodeOverridden: explicitCode != null, packageName: config.packageName },
      packager: { version: packagerManifest.version, schemaVersion: packagerManifest.schemaVersion, profile: profile.id, abis },
      assets: { ...assets, stagingTree: tree },
      overlay,
      persistence,
      extension,
      apk: {
        path: finalApk,
        verification: verify,
        signatures: builderReport?.apk?.signatures || null,
        runtimeDependencies: builderReport?.runtime || [],
      },
    };
    await finalizeReport(outputDir, finalReport, [finalApk]);
    await writeJson(path.join(outputDir, 'overlay-report.json'), overlay);
    const compat = buildCompatReport({
      source: { ...source, directory: config.masterDir }, version, versionCode: code, profile: profile.id, abis,
      assets, overlay, core, status: '',
    });
    compat.status = compatStatus({ core, features: compat.degraded });
    finalReport.compatibility = { status: compat.status, report: 'compat-report.json', degraded: compat.degraded.length };
    finalReport.status = compat.status;
    await writeJson(path.join(outputDir, 'build-report.json'), finalReport);
    await writeBuildOutputs(outputDir, { compat, report: finalReport });
    await recordBuild(config, {
      versionCode: code, version, profile: profile.id, status: compat.status,
      outputDir: path.relative(PACKAGER, outputDir), apk: path.relative(PACKAGER, finalApk),
      source: source.git.commit, treeHash: source.treeHash, features: compat.featureSummary,
    });
    await writeJson(path.join(config.stateDir, 'latest.json'), {
      version, versionCode: code, profile: profile.id, status: compat.status,
      outputDir: path.relative(PACKAGER, outputDir), apk: path.relative(PACKAGER, finalApk),
      generatedAt: finalReport.generatedAt,
    });
    const kept = await pruneBuilds(config.buildsDir || config.outputDir, version, profile.id, args.keep || config.keepBuilds);
    if (kept.length) console.log(`[retention] removed old builds: ${kept.join(', ')}`);
    await removeIfExists(stage);
    keptStage = false;
    if (compat.status === 'degraded') {
      const message = `DEGRADED: ${compat.degraded.length} feature pack(s) skipped — ${compat.degraded.map((feature) => feature.id).join(', ')}; runtime fallback is active`;
      if (args.strict || config.strict) { console.error(message); process.exitCode = 1; } else console.warn(message);
    }
    console.log(`\nSUCCESS (${compat.status}): ${finalApk}`);
    console.log(`Report: ${path.join(outputDir, 'build-report.json')}`);
    console.log(`Compat: ${path.join(outputDir, 'compat-report.json')}`);
    return finalReport;
  } finally {
    if (keptStage) console.error(`Staging retained for diagnosis: ${stage}`);
  }
}

build().catch(async (error) => {
  console.error(`\nPACKAGER FAILED: ${sanitizeDiagnostic(error.message)}`);
  // CI consumes this small, credential-free marker when the build fails before a normal report exists.
  const failure = {
    status: 'failed',
    compatibility: { status: 'blocked', core: [{ id: 'build', ok: false, detail: sanitizeDiagnostic(error.message || error).slice(0, 1000) }] },
    generatedAt: new Date().toISOString(),
    code: classifyBuildFailure(error),
    message: sanitizeDiagnostic(error.message || error).slice(0, 4000),
  };
  try {
    await writeJson(path.join(PACKAGER, 'outputs', 'failure-report.json'), failure);
    await writeJson(path.join(PACKAGER, 'state', 'last-failure.json'), failure);
  } catch { /* preserve the original build failure */ }
  process.exitCode = 1;
});
