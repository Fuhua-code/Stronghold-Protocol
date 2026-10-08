#!/usr/bin/env node
import path from 'node:path';
import { exists, fail, loadConfig, PACKAGER, parseArgs, readJson, run } from './common.mjs';

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();
if (!args.apk) fail('verify requires --apk <path>');
const apk = path.resolve(args.apk);
if (!exists(apk)) fail(`APK not found: ${apk}`);
const inferredProfile = args.profile || (path.dirname(apk).split(/[\\/]/).includes('master') ? 'master' : 'connect');
if (!['master', 'connect'].includes(inferredProfile)) fail(`unknown profile ${inferredProfile}`);
const template = inferredProfile === 'master' ? 'master-mobile' : 'connect-mobile';
const checker = path.join(PACKAGER, 'templates', template, 'tools', 'check-apk.mjs');
if (!exists(checker)) fail(`APK checker not found: ${checker}`);
const json = args.json || path.join(path.dirname(apk), 'apk-verify.json');
const r = run(process.execPath, [checker, '--apk', apk, '--json', path.resolve(json)], { cwd: config.dependencyDir, allowFail: true });
process.stdout.write(r.out);
if (!r.ok) process.exitCode = 1;

const reportFile = path.join(path.dirname(apk), 'build-report.json');
if (exists(reportFile)) {
  const report = readJson(reportFile);
  const signatures = report.apk?.signatures;
  const dependencies = report.apk?.runtimeDependencies || [];
  const signatureOk = signatures?.v1 === true && signatures?.v2 === true && signatures?.v3 === true;
  const dependenciesOk = dependencies.every((x) => (x.elf?.unresolved || []).length === 0);
  console.log(`Build report audit: signatures=${signatureOk ? 'ok' : 'failed'}, ELF DT_NEEDED=${dependenciesOk ? 'resolved' : 'failed'}`);
  if (!signatureOk || !dependenciesOk) process.exitCode = 1;
}
