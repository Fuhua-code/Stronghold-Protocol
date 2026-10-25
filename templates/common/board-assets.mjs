import fs from 'node:fs/promises';
import path from 'node:path';

export const BOARD_IMAGES = Object.freeze({
  D: ['map/autochess', 'TX_autochessi_D'],
  N: ['map/autochess', 'TX_autochessi_N_rgb'],
  R: ['map/autochess', 'TX_autochessi_M_rough'],
  E: ['map/autochess', 'TX_autochessi_E'],
  common: ['map/autochess', 'TX_autochessi_common_D'],
  commonE: ['map/autochess', 'TX_autochessi_common_E'],
  BG: ['map/autochess', 'TX_autochessi_BG'],
  wind: ['map/common', 'TX_wind_device'],
  gate: ['map/fx', '[opt]merged_textures'],
  waterN: ['map/water', '[ucp]TX_water_normal'],
  caustics: ['map/water', 'TX_Caustics256'],
  noise: ['map/water', 'T_noise_clouds_01'],
  waterWaves: ['map/water', 'TX_SmoothWaves'],
  waterNoise: ['map/water', 'TX_WaterNoise'],
  waterFoam: ['map/water', 'TX_Water_Foam'],
});

export const BOARD_MESHES = Object.freeze({
  crate: ['mesh/s_common_box_01', 'pCube2'],
  blower: ['mesh/s_wind_device', 'S_wild_wind_device'],
  bgPlane: ['mesh/s_background_common', 'pPlane1'],
});

export const GATE_NODES = Object.freeze({
  startDown: 'Start_down', startUp: 'Start_up', startBack: 'Start_back', endDown: 'Start_down1', endUp: 'Start_up1',
});

function decodeUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('/')) throw new Error(`invalid asset URL: ${url}`);
  let out = url;
  for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(out); i++) out = decodeURIComponent(out);
  const parts = out.split('/').filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..' || /[\\\0]/.test(p))) throw new Error(`unsafe asset URL: ${url}`);
  return parts;
}

function fileFor(publicDir, url) {
  return path.join(publicDir, ...decodeUrl(url));
}

function entryUrl(local, group, name) {
  const entry = local?.groups?.[group]?.[name];
  return typeof entry?.path === 'string' ? entry.path : null;
}

function addName(required, local, publicDir, group, name, reason, fallback = null) {
  const url = entryUrl(local, group, name);
  if (url) required.set(url, reason);
  else if (fallback) required.set(fallback, reason);
  else required.set(`/assets/local/${group}/${name}`, `${reason} (manifest entry missing)`);
  return url;
}

function addDirect(required, url, reason) {
  if (typeof url === 'string' && url.startsWith('/assets/')) required.set(url, reason);
}

function materialTextures(materials) {
  const names = [];
  if (!materials || typeof materials !== 'object') return names;
  for (const material of Object.values(materials)) {
    const textures = material?.textures;
    if (!textures || typeof textures !== 'object') continue;
    for (const slot of Object.values(textures)) if (typeof slot?.texture === 'string' && slot.texture) names.push(slot.texture);
  }
  return [...new Set(names)];
}

async function readJson(publicDir, url) {
  try { return JSON.parse(await fs.readFile(fileFor(publicDir, url), 'utf8')); } catch { return null; }
}

function addManifestEntries(required, local, group, reason) {
  const entries = local?.groups?.[group];
  if (!entries || typeof entries !== 'object') return [];
  const names = [];
  for (const [name, entry] of Object.entries(entries)) {
    const url = typeof entry?.path === 'string' ? entry.path : `/assets/local/${group}/${name}`;
    required.set(url, `${reason} ${name}`);
    names.push(name);
  }
  return names;
}

async function sceneRuntime(publicDir, local) {
  const requirements = new Map();
  const missing = [];
  const stages = [];
  const groups = Object.entries(local?.groups || {})
    .filter(([name, entries]) => name.startsWith('scene/') && name !== 'scene/tex' && entries && typeof entries === 'object');
  const textures = local?.groups?.['scene/tex'] || {};
  if (groups.length) addManifestEntries(requirements, local, 'scene/tex', 'shared scene texture');

  for (const [group, entries] of groups) {
    const stageId = group.slice('scene/'.length);
    const add = (name, reason) => {
      const entry = entries[name];
      const url = typeof entry?.path === 'string' ? entry.path : `/assets/local/${group}/${name}`;
      requirements.set(url, `${group}: ${reason}`);
      return url;
    };
    for (const [name, entry] of Object.entries(entries)) {
      const url = typeof entry?.path === 'string' ? entry.path : `/assets/local/${group}/${name}`;
      requirements.set(url, `${group}: manifest asset ${name}`);
    }

    const sceneUrl = add('scene', 'scene.json');
    const binUrl = add('bin', 'scene.bin');
    const doc = await readJson(publicDir, sceneUrl);
    let bin = null;
    try { bin = await fs.readFile(fileFor(publicDir, binUrl)); } catch { /* reported by the file pass below */ }
    const stageMissing = [];
    const issue = (url, reason) => {
      const item = { url, reason: `${group}: ${reason}` };
      missing.push(item);
      stageMissing.push(item);
    };

    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      issue(sceneUrl, 'scene manifest is missing or invalid JSON');
      stages.push({ id: stageId, files: Object.keys(entries).length, binBytes: null, chunks: 0, materials: 0, lightmaps: 0, textures: [], valid: false });
      continue;
    }
    if (doc.version !== 1) issue(sceneUrl, `unsupported scene layout version ${String(doc.version)}`);
    if (!bin) issue(binUrl, 'scene binary is missing');
    else if (!Number.isSafeInteger(doc.binBytes) || doc.binBytes !== bin.length) {
      issue(binUrl, `scene binBytes mismatch: manifest ${String(doc.binBytes)}, file ${bin.length}`);
    }

    const mats = doc.materials && typeof doc.materials === 'object' && !Array.isArray(doc.materials) ? doc.materials : {};
    const chunks = Array.isArray(doc.chunks) ? doc.chunks : [];
    if (!chunks.length) issue(sceneUrl, 'scene has no geometry chunks');
    const ranges = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const verts = chunk?.verts;
      const tris = chunk?.tris;
      const offset = chunk?.offset;
      const index32 = chunk?.index32 === true;
      if (!Number.isSafeInteger(verts) || verts <= 0 || !Number.isSafeInteger(tris) || tris <= 0
        || !Number.isSafeInteger(offset) || offset < 0 || offset % 4 !== 0
        || (chunk?.index32 != null && typeof chunk.index32 !== 'boolean')
        || typeof chunk?.material !== 'string' || !Object.hasOwn(mats, chunk.material)) {
        issue(sceneUrl, `chunk ${i} has invalid layout fields or material`);
        continue;
      }
      const indexCount = tris * 3;
      const indexBytes = index32 ? 4 : 2;
      const indexOffset = offset + verts * 36;
      const end = indexOffset + indexCount * indexBytes;
      if (!Number.isSafeInteger(end) || !bin || end > bin.length) {
        issue(binUrl, `chunk ${i} exceeds scene binary bounds`);
        continue;
      }
      ranges.push({ start: offset, end, index: i });
      if (Array.isArray(chunk.bounds)) {
        const bounds = chunk.bounds;
        if (bounds.length !== 6 || !bounds.every(Number.isFinite)
          || bounds[0] > bounds[3] || bounds[1] > bounds[4] || bounds[2] > bounds[5]) {
          issue(sceneUrl, `chunk ${i} has invalid bounds`);
        }
      }
      if (bin) {
        for (let j = 0; j < indexCount; j++) {
          const index = index32 ? bin.readUInt32LE(indexOffset + j * 4) : bin.readUInt16LE(indexOffset + j * 2);
          if (index >= verts) {
            issue(binUrl, `chunk ${i} index ${j} (${index}) exceeds ${verts} vertices`);
            break;
          }
        }
      }
    }
    ranges.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i].start < ranges[i - 1].end) issue(binUrl, `chunks ${ranges[i - 1].index} and ${ranges[i].index} overlap`);
    }

    const textureNames = [...new Set(Object.values(mats).flatMap((material) =>
      ['map', 'emissionMap', 'normalMap', 'glossMap']
        .map((key) => material?.[key]).filter((name) => typeof name === 'string' && name)))];
    for (const name of textureNames) {
      const entry = textures[name];
      const url = typeof entry?.path === 'string' ? entry.path : `/assets/local/scene/tex/${name}`;
      requirements.set(url, `${group}: material texture ${name}`);
      if (!entry?.path) issue(url, `scene/tex manifest entry missing for material texture ${name}`);
    }

    const lightmaps = doc.lightmaps;
    if (!Number.isSafeInteger(lightmaps) || lightmaps < 0 || lightmaps > 16) {
      issue(sceneUrl, `invalid lightmap page count ${String(lightmaps)}`);
    } else {
      for (let i = 0; i < lightmaps; i++) {
        const name = `lm${i}`;
        const url = add(name, `lightmap ${name}`);
        if (!entries[name]?.path) issue(url, `lightmap entry ${name} missing from scene group`);
      }
    }
    if (doc.env && typeof doc.env === 'object' && !Array.isArray(doc.env)) {
      const url = add('env', 'environment reflection');
      if (!entries.env?.path) issue(url, 'environment reflection entry missing from scene group');
    }
    stages.push({
      id: stageId, files: Object.keys(entries).length, binBytes: Number.isSafeInteger(doc.binBytes) ? doc.binBytes : null,
      chunks: chunks.length, materials: Object.keys(mats).length, lightmaps: Number.isSafeInteger(lightmaps) ? lightmaps : 0,
      textures: textureNames, valid: stageMissing.length === 0,
    });
  }

  for (const [url, reason] of requirements) {
    try {
      const stat = await fs.lstat(fileFor(publicDir, url));
      if (!stat.isFile() || stat.size === 0 || stat.isSymbolicLink()) missing.push({ url, reason: `${reason}: missing, empty, or not a regular file` });
    } catch {
      missing.push({ url, reason: `${reason}: missing or invalid path` });
    }
  }

  const inventory = await sceneTreeInventory(path.join(publicDir, 'assets', 'local', 'scene'));
  for (const item of inventory.missing) missing.push(item);
  for (const stage of stages) {
    stage.valid = stage.valid && !missing.some((item) => String(item.reason).startsWith(`scene/${stage.id}:`));
  }
  return {
    requirements: [...requirements.entries()].map(([url, reason]) => ({ url, reason })),
    missing,
    stages,
    files: inventory.files,
    bytes: inventory.bytes,
    manifestFiles: Object.entries(local?.groups || {})
      .filter(([name]) => name.startsWith('scene/'))
      .reduce((sum, [, group]) => sum + (group && typeof group === 'object' ? Object.keys(group).length : 0), 0),
  };
}

async function sceneTreeInventory(root) {
  let files = 0;
  let bytes = 0;
  const missing = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (err) {
      if (err?.code !== 'ENOENT') missing.push({ url: '/assets/local/scene', reason: `cannot read scene resource directory: ${err.message}` });
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const stat = await fs.lstat(file);
        files++;
        bytes += stat.size;
        if (stat.size === 0) missing.push({ url: `/assets/local/scene/${path.relative(root, file).split(path.sep).join('/')}`, reason: 'empty scene resource file' });
      } else {
        missing.push({ url: `/assets/local/scene/${path.relative(root, file).split(path.sep).join('/')}`, reason: 'scene resource is not a regular file' });
      }
    }
  }
  await walk(root);
  return { files, bytes, missing };
}

/**
 * Resolve the board renderer's dynamic closure from the current local-art manifest.
 * This intentionally follows the renderer's data (tiles/materials/prefab) so a new
 * upstream crop or mesh is detected without tying the packager to an app version.
 */
export async function boardRuntimeUrls(publicDir, local) {
  const required = new Map();
  for (const [key, [group, name]] of Object.entries(BOARD_IMAGES)) addName(required, local, publicDir, group, name, `board image ${key}`);
  for (const [key, [group, name]] of Object.entries(BOARD_MESHES)) addName(required, local, publicDir, group, name, `board mesh ${key}`);

  const diffuse = entryUrl(local, 'map/autochess', 'TX_autochessi_D');
  const tilesFallback = diffuse ? diffuse.replace(/\/[^/]*$/, '/tiles.json') : '/assets/local/map/autochess/tiles.json';
  const tilesUrl = addName(required, local, publicDir, 'map/autochess', 'tiles', 'board crop table', tilesFallback);
  const themeUrl = addName(required, local, publicDir, 'map/autochess', 'materials', 'board materials');
  const fxMaterialsUrl = addName(required, local, publicDir, 'map/fx', 'materials', 'FX materials');
  const prefabUrl = addName(required, local, publicDir, 'map/fx', 'prefab', 'FX prefab');
  const tiles = tilesUrl ? await readJson(publicDir, tilesUrl) : null;
  const fxPrefab = prefabUrl ? await readJson(publicDir, prefabUrl) : null;

  for (const source of Object.values(tiles?.source || {})) if (typeof source?.path === 'string') addDirect(required, source.path, 'tiles source texture');
  for (const name of materialTextures(await readJson(publicDir, themeUrl))) addName(required, local, publicDir, 'map/autochess', name, 'board material texture');
  for (const name of materialTextures(await readJson(publicDir, fxMaterialsUrl))) addName(required, local, publicDir, 'map/fx', name, 'FX material texture');
  for (const node of Object.values(GATE_NODES)) {
    const rec = Array.isArray(fxPrefab) ? fxPrefab.find((p) => p?.name === node && (node !== 'Start_back' || p.parent === '[opt]start_box')) : null;
    addName(required, local, publicDir, 'map/fx', typeof rec?.mesh === 'string' ? rec.mesh : node, `gate mesh ${node}`);
  }
  return [...required.entries()].map(([url, reason]) => ({ url, reason }));
}

export async function checkBoardRuntimeAssets(publicDir, local) {
  const boardRequirements = await boardRuntimeUrls(publicDir, local);
  const missing = [];
  for (const item of boardRequirements) {
    try {
      const stat = await fs.lstat(fileFor(publicDir, item.url));
      if (!stat.isFile() || stat.size === 0 || stat.isSymbolicLink()) missing.push({ ...item, reason: `${item.reason}: missing, empty, or not a regular file` });
    } catch { missing.push(item); }
  }
  const scene = await sceneRuntime(publicDir, local);
  missing.push(...scene.missing);
  const requirements = [...new Map([...boardRequirements, ...scene.requirements].map((item) => [item.url, item])).values()];
  return {
    requirements, missing, count: requirements.length,
    sceneStages: scene.stages, sceneRuntimeFiles: scene.files, sceneRuntimeBytes: scene.bytes,
    sceneRuntimeMissing: scene.missing, sceneManifestFiles: scene.manifestFiles,
  };
}
