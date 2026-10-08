#!/usr/bin/env node
import { removeIfExists, PACKAGER, loadConfig } from './common.mjs';
const config = loadConfig();
await removeIfExists(`${PACKAGER}/.staging`);
await removeIfExists(config.outputDir);
console.log('Removed staging and output artifacts. Runtime cache was preserved.');
