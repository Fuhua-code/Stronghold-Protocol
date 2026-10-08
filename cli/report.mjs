import fs from 'node:fs/promises';
import path from 'node:path';
import { hashFile, writeJson } from './common.mjs';

export async function finalizeReport(outputDir, report, apkFiles) {
  report.apks = [];
  const candidates = new Set(apkFiles);
  // Keep checksums for every ABI variant in this version/profile directory. A later build (for example the
  // emulator bundle) must not erase the phone-only checksum from the same output directory.
  for (const entry of await fs.readdir(outputDir)) {
    if (entry.toLowerCase().endsWith('.apk')) candidates.add(path.join(outputDir, entry));
  }
  for (const apk of [...candidates].sort()) {
    const stat = await fs.stat(apk);
    if (!stat.isFile()) continue;
    report.apks.push({ path: apk, bytes: stat.size, sha256: await hashFile(apk) });
  }
  await writeJson(path.join(outputDir, 'build-report.json'), report);
  await fs.writeFile(path.join(outputDir, 'SHA256SUMS.txt'), report.apks.map((x) => `${x.sha256}  ${path.basename(x.path)}`).join('\n') + '\n');
}
