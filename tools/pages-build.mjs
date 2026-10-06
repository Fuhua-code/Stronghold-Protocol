import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { APP_VERSION, PROTOCOL_VERSION } from '../shared/constants.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_BASE = '/Stronghold-Protocol/';
// Pages can run without a broker; a public Node server is injected at build time when TURN is enabled.
export const DEFAULT_TURN_CREDENTIALS_URL = '';
const hash = (data) => createHash('sha256').update(data).digest('hex');
export async function walk(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(file));
    else out.push(file);
  }
  return out.sort();
}
export function rewritePaths(text, base) {
  return text.replace(/(["'`(=])\/(assets|fonts|vendor|data|sim|js|css|media)(?=[/.])/g, `$1${base}$2`);
}
export function rewriteManifest(value, base) {
  if (typeof value === 'string') return value.replace(/^\/(assets|fonts)\//, `${base}$1/`);
  if (Array.isArray(value)) return value.map((v) => rewriteManifest(v, base));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteManifest(v, base)]));
  return value;
}
export function resourcePaths(value, paths = new Set()) {
  if (typeof value === 'string' && /^\/(assets|fonts)\//.test(value)) paths.add(value);
  else if (Array.isArray(value)) value.forEach((v) => resourcePaths(v, paths));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => resourcePaths(v, paths));
  return paths;
}
export async function behaviorFingerprint(root = ROOT) {
  const digest = createHash('sha256');
  for (const dir of ['server/match', 'server/sim', 'shared']) {
    for (const file of await walk(path.join(root, dir))) {
      if (!file.endsWith('.js') || file.endsWith('nodeData.js')) continue;
      digest.update(path.relative(root, file).replaceAll('\\', '/')).update(await fs.readFile(file));
    }
  }
  for (const file of ['server/net.js', 'server/lobby.js', ...await fs.readdir(path.join(root, 'data')).then((files) => files.filter((f) => f.endsWith('.json') && !f.includes('assets')).sort().map((f) => `data/${f}`))]) {
    digest.update(file).update(await fs.readFile(path.join(root, file)));
  }
  return digest.digest('hex');
}
export async function buildPages({ assetRoot = path.join(ROOT, '.cache/pages-assets'), base = DEFAULT_BASE } = {}) {
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base)) throw new Error('Base must be an absolute directory path');
  const out = path.join(ROOT, 'pages-dist');
  const standard = JSON.parse(await fs.readFile(path.join(ROOT, 'data/assets.json')));
  const supplied = await fs.readFile(path.join(assetRoot, 'data/assets.json'));
  if (hash(supplied) !== hash(await fs.readFile(path.join(ROOT, 'data/assets.json')))) throw new Error('Resource manifest differs from the game version');
  const local = JSON.parse(await fs.readFile(path.join(assetRoot, 'data/local-assets.json')));
  const required = [...resourcePaths(standard), ...resourcePaths(local)];
  for (const url of required) await fs.access(path.join(assetRoot, 'public', url));
  const dataFiles = (await fs.readdir(path.join(ROOT, 'data'))).filter((f) => f.endsWith('.json') && !f.includes('assets')).sort().map((f) => f.slice(0, -5));
  const turnCredentialsUrl = process.env.PAGES_TURN_CREDENTIALS_URL?.trim() || DEFAULT_TURN_CREDENTIALS_URL;
  if (turnCredentialsUrl) {
    let parsed;
    try { parsed = new URL(turnCredentialsUrl); } catch { throw new Error('TURN credentials URL must be an HTTPS /turn/credentials endpoint'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash
      || parsed.pathname !== '/turn/credentials' || parsed.search) {
      throw new Error('TURN credentials URL must be an HTTPS /turn/credentials endpoint');
    }
  }
  const config = { app: APP_VERSION, protocol: PROTOCOL_VERSION, compat: await behaviorFingerprint(), base, dataFiles, turnCredentialsUrl };
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });
  for (const dir of ['css', 'vendor']) await fs.cp(path.join(ROOT, 'public', dir), path.join(out, dir), { recursive: true });
  for (const dir of ['assets', 'fonts']) await fs.cp(path.join(assetRoot, 'public', dir), path.join(out, dir), { recursive: true });
  await fs.cp(path.join(ROOT, 'data'), path.join(out, 'data'), { recursive: true });
  for (const [name, manifest] of [['assets.json', standard], ['local-assets.json', local]]) await fs.writeFile(path.join(out, 'data', name), JSON.stringify(rewriteManifest(manifest, base)));
  await fs.cp(path.join(ROOT, 'server/sim'), path.join(out, 'sim'), { recursive: true, filter: (p) => !p.endsWith('nodeData.js') });
  await fs.cp(path.join(ROOT, 'shared'), path.join(out, 'shared'), { recursive: true });
  await fs.writeFile(path.join(out, 'data.js'), `import { getSimData } from './sim/simdata.js';\nexport function getData() { return getSimData() || {}; }\nexport function resetData() {}\n`);
  for (const dir of ['css', 'fonts', 'sim']) for (const file of await walk(path.join(out, dir))) {
    if (/\.(js|css)$/.test(file)) {
      let source = rewritePaths(await fs.readFile(file, 'utf8'), base);
      if (dir === 'sim') {
        const served = '/' + path.relative(out, file).replaceAll('\\', '/');
        source = source.replace(/((?:\bfrom\s*|\bimport\s*\(\s*)["'])(\.{1,2}\/[^"']+)(["'])/g,
          (_, before, relative, after) => before + base + new URL(relative, `https://pages.invalid${served}`).pathname.slice(1) + after);
      }
      await fs.writeFile(file, source);
    }
  }
  let html = rewritePaths(await fs.readFile(path.join(ROOT, 'public/index.html'), 'utf8'), base);
  await fs.writeFile(path.join(out, 'index.html'), html);
  const plugin = {
    name: 'pages-browser-runtime',
    setup(b) {
      b.onResolve({ filter: /^#pages-config$/ }, () => ({ path: 'config', namespace: 'pages' }));
      b.onLoad({ filter: /.*/, namespace: 'pages' }, () => ({ contents: `export default {...${JSON.stringify(config)}, baseUrl:new URL(${JSON.stringify(base)}, globalThis.location.href).href};`, loader: 'js' }));
      b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: path.join(ROOT, 'pages/adapters/crypto.js') }));
      b.onResolve({ filter: /^node:net$/ }, () => ({ path: path.join(ROOT, 'pages/adapters/ip.js') }));
      b.onResolve({ filter: /nodeData\.js$/ }, () => ({ path: 'node-data', namespace: 'empty' }));
      b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: 'export default null;', loader: 'js' }));
      b.onResolve({ filter: /data\.js$/ }, (args) => path.resolve(args.resolveDir, args.path) === path.join(ROOT, 'server/data.js') ? { path: path.join(ROOT, 'pages/adapters/data.js') } : undefined);
      b.onResolve({ filter: /^\/(?:Stronghold-Protocol\/)?(?:sim|vendor)\// }, (args) => ({ path: args.path, external: true }));
      b.onLoad({ filter: /\.js$/ }, async (args) => {
        if (args.path.includes(`${path.sep}node_modules${path.sep}`) || args.path.includes(`${path.sep}vendor${path.sep}`)) return;
        let source = await fs.readFile(args.path, 'utf8');
        // Guarded variable imports must remain complete after bundling: esbuild cannot infer import(path).
        if (args.path.includes(`${path.sep}sim${path.sep}content${path.sep}`) && source.includes('return await import(path);')) {
          const name = path.basename(args.path);
          const imports = name === 'index.js'
            ? [...[1, 2, 3, 4, 5, 6].map((t) => `./kits/tier${t}.js`), ...['tokens', 'devices', 'enemies', 'bosses', 'bonds', 'garrisons', 'items', 'bands', 'choices'].map((n) => `./${n}.js`)]
            : name === 'bonds.js' ? ['./bonds/core.js', './bonds/addon.js', './support/meta.js'] : ['./bands/battle.js', './bands/meta.js'];
          source = source.replace('return await import(path);', `const modules = {${imports.map((p) => `${JSON.stringify(p)}:()=>import(${JSON.stringify(p)})`).join(',')}}; if(!modules[path]) throw new Error('Unknown content module'); return await modules[path]();`);
        }
        if (args.path === path.join(ROOT, 'public/js/main.js')) {
          source = `import { installPages } from '../../pages/transport.js';\n` + source;
          source = source.replace('boot().catch(', 'installPages(net, identity);\nboot().catch(');
          source = source.replace('startBuildGuard({', '(() => {})({');
        }
        if (args.path.endsWith(`${path.sep}screens${path.sep}title.js`)) source = source.replaceAll('正在连接服务器', '正在启动游戏核心').replaceAll('已连接服务器', '游戏核心已就绪');
        return { contents: rewritePaths(source, base), loader: 'js' };
      });
    },
  };
  for (const [entry, target] of [['public/js/main.js', 'js/main.js'], ['pages/worker.js', 'pages-worker.js']]) {
    await build({ entryPoints: [path.join(ROOT, entry)], outfile: path.join(out, target), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', plugins: [plugin], define: { 'process.env.SP_COMBAT': '"client"' }, minify: true, logLevel: 'warning' });
  }
  for (const target of ['js/main.js', 'pages-worker.js']) {
    const source = await fs.readFile(path.join(out, target), 'utf8');
    if (/\b(?:from\s*|import\s*\()\s*["']node:/.test(source)) throw new Error(`Node dependency survived in ${target}`);
    if (/HF_TOKEN|FastRTC|turn\.fastrtc\.org|Cloudflare_Turn_API|Turn_Token|CLOUDFLARE_TURN_|Authorization\s*:\s*["']Bearer/i.test(source)) {
      throw new Error(`TURN server secret or upstream API leaked into ${target}`);
    }
  }
  for (const name of ['LICENSE', 'NOTICE.md', 'THIRD-PARTY-NOTICES.md']) await fs.copyFile(path.join(ROOT, name), path.join(out, name));
  await fs.writeFile(path.join(out, '.nojekyll'), '');
  const files = await walk(out);
  let bytes = 0;
  for (const file of files) bytes += (await fs.stat(file)).size;
  if (bytes >= 1024 ** 3) throw new Error('Static site exceeds the Pages 1 GiB limit');
  const report = { ...config, files: files.length, bytes, manifestPaths: new Set(required).size };
  await fs.writeFile(path.join(out, 'pages-build.json'), JSON.stringify(report, null, 2));
  console.log(`Pages ready: ${files.length} files, ${(bytes / 1024 ** 2).toFixed(1)} MiB; ${config.app}; base ${base}`);
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  await buildPages({ assetRoot: value('assets') ? path.resolve(value('assets')) : undefined, base: value('base') || DEFAULT_BASE });
}
