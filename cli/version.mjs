import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, fail, loadConfig, readJson, versionCode, writeJson } from './common.mjs';

export function historyFile(config) {
  return path.join(config.stateDir, 'build-history.json');
}

export async function readHistory(config) {
  const file = historyFile(config);
  if (!exists(file)) return { schemaVersion: 1, floor: config.versionCodeFloor || 0, entries: [] };
  const raw = readJson(file);
  return {
    schemaVersion: 1,
    floor: Number(raw.floor || 0),
    entries: Array.isArray(raw.entries) ? raw.entries : [],
  };
}

/**
 * versionCode moves upward only. An explicit code may repeat the last one (rebuild of the
 * same artefact) but may not go below it; auto allocation always takes the next value.
 */
export async function allocateVersionCode(config, { version, explicit = null } = {}) {
  const history = await readHistory(config);
  const last = history.entries.reduce((max, entry) => Math.max(max, Number(entry.versionCode) || 0), 0);
  const floor = Math.max(
    Number(config.versionCodeFloor || 0),
    Number(history.floor || 0),
    Number(config.minimumVersionCode || 0),
    versionCode(version),
  );
  if (explicit != null) {
    const code = Number(explicit);
    if (!Number.isSafeInteger(code) || code < 1 || code > 2_100_000_000) fail(`invalid versionCode: ${explicit}`);
    if (code < last) fail(`versionCode ${code} is below the last recorded build ${last}; versionCode must move upward`);
    return { code, floor, last, history };
  }
  return { code: Math.max(floor, last + 1), floor, last, history };
}

export async function recordBuild(config, entry) {
  const history = await readHistory(config);
  const entries = history.entries.filter((item) => !(Number(item.versionCode) === Number(entry.versionCode) && item.profile === entry.profile));
  entries.push({ ...entry, builtAt: entry.builtAt || new Date().toISOString() });
  entries.sort((a, b) => (Number(a.versionCode) - Number(b.versionCode)) || String(a.profile).localeCompare(String(b.profile)));
  history.floor = Math.max(Number(history.floor || 0), Number(entry.versionCode) || 0);
  history.entries = entries;
  await writeJson(historyFile(config), history);
  return history;
}

/** Keep the newest N versioned build directories for one version/profile. */
export async function pruneBuilds(root, version, profile, keep) {
  const directory = path.join(root, version, profile);
  if (!exists(directory)) return [];
  const names = (await fsp.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d+-/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(b.split('-')[0]) - Number(a.split('-')[0]));
  const removed = names.slice(Math.max(1, keep));
  for (const name of removed) await fsp.rm(path.join(directory, name), { recursive: true, force: true });
  return removed;
}

async function cli() {
  const config = loadConfig();
  const history = await readHistory(config);
  const last = history.entries.reduce((max, entry) => Math.max(max, Number(entry.versionCode) || 0), 0);
  const floor = Math.max(Number(config.versionCodeFloor || 0), Number(history.floor || 0), Number(config.minimumVersionCode || 0));
  console.log(`state:     ${historyFile(config)}`);
  console.log(`floor:     ${floor}`);
  console.log(`last:      ${last || '(none)'}`);
  console.log(`next auto: ${Math.max(floor, last + 1)}`);
  for (const entry of history.entries.slice(-5)) {
    console.log(`  ${entry.versionCode}  ${entry.version || ''}  ${entry.profile || ''}  ${entry.status || ''}  ${entry.outputDir || ''}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((error) => { console.error(`VERSION FAILED: ${error.message}`); process.exitCode = 1; });
}
