#!/usr/bin/env node
import path from 'node:path';
import { exists, fail, loadConfig, parseArgs, run } from './common.mjs';

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();
if (!args.apk) fail('verify requires --apk <path>');
const apk = path.resolve(args.apk);
if (!exists(apk)) fail(`APK not found: ${apk}`);
const checker = path.join(config.dependencyDir, 'mobile', 'tools', 'check-apk.mjs');
if (!exists(checker)) fail(`APK checker not found: ${checker}`);
const json = args.json || path.join(path.dirname(apk), 'apk-verify.json');
const r = run(process.execPath, [checker, '--apk', apk, '--json', path.resolve(json)], { cwd: config.dependencyDir, allowFail: true });
process.stdout.write(r.out);
if (!r.ok) process.exitCode = 1;

