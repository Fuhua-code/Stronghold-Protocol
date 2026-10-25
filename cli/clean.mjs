#!/usr/bin/env node
import path from 'node:path';
import { removeIfExists, PACKAGER } from './common.mjs';
await removeIfExists(path.join(PACKAGER, '.staging'));
await removeIfExists(path.join(PACKAGER, 'outputs', 'failure-report.json'));
console.log('Removed staging and the failure marker. Build outputs, state and runtime cache were preserved.');
