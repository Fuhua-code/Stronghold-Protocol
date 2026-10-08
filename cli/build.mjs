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
  PACKAGER, copyTree, exists, fail, hashTree, loadConfig, parseArgs, readJson,
  removeIfExists, run, versionCode, writeJson,
} from './common.mjs';
import { inspectSource, stageSource } from './source.mjs';
import { checkAssets } from './assets.mjs';
import { applyOverlay } from './overlay.mjs';
import { signingEnv, verifyCertificate } from './signing.mjs';
import { finalizeReport } from './report.mjs';

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
}

async function copyRuntimeCache(config, stage) {
  const cache = config.runtimeCacheDir;
  const required = ['runtime', 'termux', 'licenses'];
  const missing = required.filter((x) => !exists(path.join(cache, x)));
  if (missing.length) fail(`runtime cache is incomplete (${missing.join(', ')}); run packager.cmd bootstrap after preparing mobile/build`);
  for (const rel of required) await copyTree(path.join(cache, rel), path.join(stage, 'mobile', 'build', rel));
}

function checkForbidden(stage, profile) {
  for (const rel of profile.forbiddenPaths || []) {
    if (exists(path.join(stage, rel))) fail(`profile ${profile.id} contains forbidden path: ${rel}`);
  }
}

async function runApkCheck(stage, apk, json) {
  const checker = path.join(stage, 'mobile', 'tools', 'check-apk.mjs');
  if (!exists(checker)) fail('Android template does not include mobile/tools/check-apk.mjs');
  const result = run(process.execPath, [checker, '--apk', apk, '--json', json], { cwd: stage, allowFail: true });
  if (!result.ok) fail(`APK verification failed\n${result.out.slice(-8000)}`);
  if (!exists(json)) fail('APK checker exited successfully without writing apk-verify.json');
  return readJson(json);
}

async function build(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = loadConfig();
  const profile = profileConfig(args.profile || config.defaultProfile || 'connect');
  const abis = args.abis || config.defaultAbis || ['arm64-v8a'];
  if (!abis.length) fail('at least one ABI is required');
  const source = await inspectSource(config, args.allowDirty);
  const version = source.package.version;
  const code = versionCode(version, config.minimumVersionCode);
  const signing = signingEnv(config);
  const stage = path.join(PACKAGER, '.staging', `${version}-${profile.id}-${process.pid}-${Date.now()}`);
  const outputDir = path.join(config.outputDir, version, profile.id);
  await removeIfExists(stage);
  await fsp.mkdir(stage, { recursive: true });
  await fsp.mkdir(outputDir, { recursive: true });
  let keptStage = true;
  try {
    console.log(`Building ${profile.id} from master ${source.git.commit} (${version})`);
    await stageSource(config, stage);
    const assets = await checkAssets(stage);
    await copyMobileTemplate(profile.mobileTemplate, stage);
    await copyRuntimeCache(config, stage);
    const overlay = await applyOverlay(stage, config, profile, version);
    checkForbidden(stage, profile);
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
    const javaHome = path.join(config.toolchainDir, 'jdk');
    if (exists(javaHome)) verifyCertificate(javaHome, signing);
    const mobileBuilder = path.join(stage, 'mobile', 'build-apk.mjs');
    if (!exists(mobileBuilder)) fail('Android template is missing mobile/build-apk.mjs');
    const argsForBuilder = [mobileBuilder, `--abi=${abis.join(',')}`, `--out=${stagedApk}`, `--json=${reportPath}`, '--no-download'];
    const built = run(process.execPath, argsForBuilder, { cwd: stage, env, allowFail: true });
    if (!built.ok) fail(`Android build failed\n${built.out.slice(-10000)}`);
    if (!exists(stagedApk)) fail(`Android builder did not produce ${stagedApk}`);
    const builderReport = exists(reportPath) ? readJson(reportPath) : null;
    const finalApk = path.join(outputDir, apkName);
    await fsp.copyFile(stagedApk, finalApk);
    const verifyPath = path.join(outputDir, 'apk-verify.json');
    const verify = await runApkCheck(stage, finalApk, verifyPath);
    const finalReport = {
      status: 'success', generatedAt: new Date().toISOString(),
      source: { directory: config.masterDir, branch: source.git.branch, commit: source.git.commit, clean: source.git.clean },
      app: { version, versionCode: code, packageName: config.packageName },
      packager: { version: readJson(path.join(PACKAGER, 'package.json')).version, profile: profile.id, abis },
      assets: { ...assets, stagingTree: tree },
      overlay,
      apk: {
        path: finalApk,
        verification: verify,
        signatures: builderReport?.apk?.signatures || null,
        runtimeDependencies: builderReport?.runtime || [],
      },
    };
    await finalizeReport(outputDir, finalReport, [finalApk]);
    await writeJson(path.join(outputDir, 'overlay-report.json'), overlay);
    await removeIfExists(stage);
    keptStage = false;
    console.log(`\nSUCCESS: ${finalApk}`);
    console.log(`Report: ${path.join(outputDir, 'build-report.json')}`);
    return finalReport;
  } finally {
    if (keptStage) console.error(`Staging retained for diagnosis: ${stage}`);
  }
}

build().catch((error) => { console.error(`\nPACKAGER FAILED: ${error.message}`); process.exitCode = 1; });
