// Optional mobile remote adapter. TLS certificate verification remains enabled.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { APP_VERSION, PROTOCOL_VERSION } from '../../shared/constants.js';
import { normalizeRemoteUrl, isLoopbackHost } from '../../shared/connect.js';
import { ROOT } from './config.js';
import { lanUrls } from './boot.js';
import { sendJson } from './common.js';

export const PROXY_LIMITS = Object.freeze({ timeoutMs: 8000, frames: 64, bytes: 1 << 20, payload: 64 * 1024 });
export const isLoopbackAddress = (value) => isLoopbackHost(value);

function fingerprint(root, inputs, exclude = new Set()) {
  const hash = createHash('sha256');
  const walk = (rel) => {
    if (exclude.has(rel)) return;
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) return;
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) if (!name.startsWith('.')) walk(`${rel}/${name}`);
    } else if (stat.isFile()) hash.update(rel).update('\0').update(fs.readFileSync(file)).update('\0');
  };
  for (const input of [...inputs].sort()) walk(input);
  return hash.digest('hex');
}

export function remoteHealth(root = ROOT) {
  return { protocol: PROTOCOL_VERSION,
    compat: fingerprint(root, ['shared', 'server', 'public/js', 'data'],
      new Set(['data/assets.json', 'data/local-assets.json'])),
    assets: fingerprint(root, ['data/assets.json', 'data/local-assets.json']) };
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const PRIVATE_IP = /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

export function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::') return true;
  if (PRIVATE_IP.test(h)) return true;
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) return true;
  return false;
}

function cancelBody(response) {
  try { response?.body?.cancel?.(); } catch { /* already consumed */ }
}

/**
 * Follow an entry link (including cross-origin join services) before probing.
 * Every hop receives exactly the same URL policy as a manually entered address:
 * http(s), no credentials, no loopback, no control characters. A public entry may not
 * redirect into a private/LAN host; a LAN entry may only stay on the same host.
 * @returns {Promise<{ok:boolean, requestedUrl?:string, url?:string, chain?:object[], response?:Response, reason?:string}>}
 */
export async function resolveRemoteRedirects(raw, { fetchFn = globalThis.fetch, timeoutMs = 8000,
  maxRedirects = 5, signal = null } = {}) {
  const requestedUrl = normalizeRemoteUrl(raw);
  if (!requestedUrl) return { ok: false, reason: 'invalid-url' };
  const start = new URL(requestedUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  const chain = [];
  const seen = new Set();
  let current = requestedUrl;
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (seen.has(current)) return { ok: false, reason: 'redirect-loop', requestedUrl, url: current, chain };
      seen.add(current);
      const response = await fetchFn(current, { redirect: 'manual', signal: controller.signal });
      const status = Number(response?.status || 0);
      if (REDIRECT_STATUS.has(status)) {
        const location = response.headers?.get?.('location');
        if (!location) return { ok: false, reason: 'invalid-redirect', requestedUrl, url: current, chain };
        let next;
        try { next = new URL(location, current).toString(); } catch {
          return { ok: false, reason: 'invalid-redirect', requestedUrl, url: current, chain };
        }
        const normalized = normalizeRemoteUrl(next);
        if (!normalized) return { ok: false, reason: 'local-or-invalid-redirect', requestedUrl, url: current, chain };
        const nextUrl = new URL(normalized);
        if (isPrivateHost(nextUrl.hostname) && !(isPrivateHost(start.hostname) && nextUrl.hostname === start.hostname)) {
          return { ok: false, reason: 'private-redirect', requestedUrl, url: normalized, chain };
        }
        chain.push({ from: current, to: normalized, status });
        cancelBody(response);
        current = normalized;
        continue;
      }
      return { ok: true, requestedUrl, url: current, chain, response };
    }
    return { ok: false, reason: 'too-many-redirects', requestedUrl, url: current, chain };
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'verification-required',
      requestedUrl, url: current, chain };
  } finally { clearTimeout(timer); }
}

/** Bases to try for /healthz and /ws: the final page directory, then the origin root. */
export function remoteBases(url) {
  const u = new URL(url);
  u.search = ''; u.hash = '';
  const dir = new URL(u.toString());
  dir.pathname = dir.pathname.replace(/\/$/, '') + '/';
  const root = new URL(u.toString());
  root.pathname = '/';
  return [...new Set([dir.toString(), root.toString()])];
}

export function remoteWsUrl(raw) {
  const direct = /^wss?:\/\//i.test(String(raw));
  const normalized = normalizeRemoteUrl(direct ? String(raw).replace(/^ws/i, 'http') : raw);
  if (!normalized) return null;
  const url = new URL(normalized);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (!direct) url.pathname = url.pathname.replace(/\/$/, '') + '/ws';
  url.search = ''; url.hash = '';
  return url.toString();
}

export function checkRemoteWebSocket(raw, timeoutMs = PROXY_LIMITS.timeoutMs) {
  const url = remoteWsUrl(raw);
  if (!url) return Promise.resolve(false);
  return new Promise((resolve) => {
    let socket; let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (socket?.readyState === WebSocket.OPEN) socket.close(); else socket?.terminate();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    try {
      socket = new WebSocket(url, { handshakeTimeout: timeoutMs, maxPayload: PROXY_LIMITS.payload, followRedirects: false });
      socket.once('open', () => done(true)); socket.on('error', () => done(false));
      socket.once('unexpected-response', (_req, response) => { response.resume(); done(false); });
      socket.once('close', () => done(false));
    } catch { done(false); }
  });
}

function gamePage(body) {
  return /id=["']app["']/.test(body)
    && (/<script\b[^>]*type=["']module["'][^>]*src=["'](?:\/|\.\/)?(?:js\/)?main\.js["']/.test(body)
      || /卫戍协议|Stronghold\s+Protocol/i.test(body));
}

/**
 * Probe a remote game. Admission is page + WebSocket; the app's overlay-only
 * `compat`/`assets` fields only refine the verification level, because the remote page
 * runs its own client. A non-game page is rejected outright.
 */
export async function probeRemoteGame(raw, { fetchFn = globalThis.fetch, checkWs = checkRemoteWebSocket,
  timeoutMs = 8000, expectedApp = APP_VERSION, expectedProtocol = PROTOCOL_VERSION,
  expectedCompat = remoteHealth().compat, expectedAssets = remoteHealth().assets,
  resolve = resolveRemoteRedirects } = {}) {
  const failure = (reason, extra = {}) => ({ reachable: false, valid: false, proxyable: false, blocked: false,
    reason, requestedUrl: typeof raw === 'string' ? raw : undefined, ...extra });
  const resolved = await resolve(raw, { fetchFn, timeoutMs });
  if (!resolved.ok) {
    const invalid = ['invalid-url', 'local-or-invalid-redirect', 'redirect-loop', 'private-redirect'];
    return failure(resolved.reason, {
      reachable: resolved.reason === 'timeout' ? false : true,
      blocked: !invalid.includes(resolved.reason),
      candidateUrl: resolved.url,
      finalUrl: resolved.url,
      requestedUrl: resolved.requestedUrl,
      redirects: resolved.chain || [],
    });
  }
  const requestedUrl = resolved.requestedUrl;
  const finalUrl = resolved.url;
  const chain = resolved.chain || [];
  const pageResponse = resolved.response;
  const pageOk = !!pageResponse?.ok && gamePage(await pageResponse.text().catch(() => ''));
  const bases = remoteBases(finalUrl);
  let health = null;
  let healthBase = null;
  for (const base of bases) {
    try {
      const response = await fetchFn(new URL('healthz', base), { redirect: 'manual',
        signal: AbortSignal.timeout?.(timeoutMs) });
      if (!response.ok) continue;
      const body = await response.json();
      if (body && typeof body === 'object') { health = body; healthBase = base; break; }
    } catch { /* health is optional */ }
  }
  let wsOk = false;
  for (const base of bases) {
    if (await checkWs(base, timeoutMs)) { wsOk = true; break; }
  }
  const protocol = health?.protocol ?? health?.version;
  const confirmed = health?.ok === true && typeof health.app === 'string' && Number.isInteger(protocol)
    && typeof health.compat === 'string' && health.compat.length > 0
    && typeof health.assets === 'string' && health.assets.length > 0;
  let compatible = null;
  let verification = 'compatible-unknown';
  if (health?.ok === false) { compatible = false; verification = 'incompatible'; }
  else if (confirmed) {
    compatible = health.app === expectedApp && protocol === expectedProtocol && health.compat === expectedCompat;
    verification = compatible ? 'verified' : 'compatible-unknown';
  }
  const assetMatch = typeof health?.assets === 'string' ? health.assets === expectedAssets : null;
  const warnings = [];
  if (!confirmed && health?.ok !== false) warnings.push('health-fingerprint-missing');
  if (compatible === false) warnings.push('version-mismatch');
  if (!wsOk) warnings.push('ws-unavailable');
  const reason = !pageOk ? 'invalid-game-page' : !wsOk ? 'ws-unavailable' : 'game';
  return {
    reachable: true,
    valid: pageOk && wsOk,
    proxyable: pageOk && wsOk,
    blocked: !pageOk || !wsOk,
    reason,
    requestedUrl,
    finalUrl,
    proxyUrl: finalUrl,
    candidateUrl: finalUrl,
    redirects: chain,
    redirectOrigins: [...new Set(chain.map((x) => { try { return new URL(x.to).origin; } catch { return null; } }).filter(Boolean))],
    verification,
    compatible,
    assetMatch,
    pageOk,
    wsOk,
    game: pageOk,
    healthBase,
    remoteHealth: health || undefined,
    warnings,
  };
}

/**
 * Origins and path prefixes the remote page's own manifests use for art. A server may serve its page at
 * https://game.example/ and its art at https://local.example/prefix/; the WebView interceptor needs those
 * targets before it can answer /assets, /fonts, /media or /icons from the APK.
 * @param {string} raw remote page URL (final URL preferred)
 * @param {{ fetchFn?: Function, timeoutMs?: number, expectedAssetHash?: string, resolve?: boolean }} [opts]
 * @returns {Promise<{ origins: string[], prefixes: string[], manifests: string[], finalUrl: string, assetMatch: boolean|null }>}
 */
export async function remoteAssetTargets(raw, { fetchFn = globalThis.fetch, timeoutMs = 12000,
  expectedAssetHash = null, resolve = false } = {}) {
  let normalized = normalizeRemoteUrl(raw);
  if (!normalized) return { origins: [], prefixes: [], manifests: [], finalUrl: null, assetMatch: null };
  let finalUrl = normalized;
  if (resolve) {
    const resolved = await resolveRemoteRedirects(normalized, { fetchFn, timeoutMs });
    if (!resolved.ok) return { origins: [], prefixes: [], manifests: [], finalUrl: resolved.url || null, assetMatch: null };
    finalUrl = resolved.url;
    cancelBody(resolved.response);
  }
  const root = new URL(finalUrl); root.search = ''; root.hash = '';
  root.pathname = root.pathname.replace(/\/$/, '') + '/';
  const origins = new Set([root.origin]);
  const prefixes = new Set(['']);
  const manifests = [];
  let assetMatch = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const artRoot = /\/(?:assets|fonts|media|icons)\//;
  const addTarget = (url) => {
    if (!url) return;
    origins.add(url.origin);
    const at = url.pathname.search(artRoot);
    if (at >= 0) prefixes.add(url.pathname.slice(0, at));
    else {
      const prefix = url.pathname.replace(/\/$/, '');
      if (prefix) prefixes.add(prefix);
    }
  };
  try {
    // A custom build may put art/data on a CDN and name it in js/asset-cdn.js.
    const bases = [root];
    for (const rel of ['js/asset-cdn.js', 'asset-cdn.js']) {
      try {
        const response = await fetchFn(new URL(rel, root), { signal: controller.signal });
        if (!response.ok) continue;
        const text = await response.text();
        for (const match of text.matchAll(/(?:ASSETS_CDN|DATA_CDN)\s*=\s*["']([^"']+)["']/g)) {
          try {
            const base = new URL(match[1], root);
            if (base.protocol !== 'http:' && base.protocol !== 'https:') continue;
            addTarget(base);
            bases.push(new URL(base.pathname.replace(/\/$/, '') + '/', base));
          } catch { /* invalid CDN entry */ }
        }
      } catch { /* older builds use the page origin */ }
    }
    for (const base of [...new Set(bases.map((b) => b.href))].map((href) => new URL(href))) {
      for (const name of ['assets.json', 'local-assets.json']) {
        try {
          const response = await fetchFn(new URL(`data/${name}`, base), { signal: controller.signal });
          if (!response.ok) continue;
          try { origins.add(new URL(response.url).origin); } catch { /* test Response has no URL */ }
          const doc = await response.json();
          manifests.push(name);
          if (name === 'assets.json' && expectedAssetHash && typeof doc?.hash === 'string') {
            assetMatch = doc.hash === expectedAssetHash;
          }
          const note = (value) => {
            if (typeof value !== 'string' || (!value.startsWith('/') && !/^https?:\/\//i.test(value))) return;
            let url;
            try { url = new URL(value, base); } catch { return; }
            if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
            if (!artRoot.test(url.pathname)) return;
            addTarget(url);
          };
          const walk = (node) => {
            if (typeof node === 'string') note(node);
            else if (Array.isArray(node)) node.forEach(walk);
            else if (node && typeof node === 'object') for (const value of Object.values(node)) walk(value);
          };
          walk(doc);
        } catch { /* the page may not expose a manifest; fall back to its own origin */ }
      }
    }
  } finally { clearTimeout(timer); }
  // A page served below /game/ may use page-relative art even without a manifest.
  const rootPrefix = root.pathname.replace(/\/$/, '');
  if (rootPrefix) prefixes.add(rootPrefix);
  return { origins: [...origins].sort(), prefixes: [...prefixes].sort(), manifests, finalUrl, assetMatch };
}

export function createProxyState() {
  return { target: null, sockets: new Set(), clear() {
    this.target = null;
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
  } };
}

function localAssetHash(root = ROOT) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'data/assets.json'), 'utf8')).hash || null; }
  catch { return null; }
}

function randomToken() {
  return randomBytes(16).toString('hex');
}

// ---- Remote match-record archive: the Android shell collects these from remote pages' localStorage ----
export const RECORDS_LIMITS = Object.freeze({ perServer: 200, servers: 8, maxChars: 2_000_000, postBytes: 8 << 20 });

function readRecordsDocFile(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return doc && typeof doc === 'object' && doc.servers && typeof doc.servers === 'object' ? doc : null;
  } catch { return null; }
}

/** Load the archive, falling back to the last good copy and the external app mirror. */
export function loadRecordsDoc(file, mirrorFile = null) {
  const primary = readRecordsDocFile(file);
  if (primary) return primary;
  if (fs.existsSync(file)) {
    // keep the unreadable primary for diagnosis even when a fallback copy is available
    try { fs.copyFileSync(file, `${file}.damaged-${Date.now()}`); } catch { /* keep it in place */ }
  }
  // the mirror is written with every save; .bak is one version behind, so prefer the mirror
  if (mirrorFile) {
    const mirror = readRecordsDocFile(mirrorFile);
    if (mirror) return mirror;
  }
  const backup = readRecordsDocFile(`${file}.bak`);
  if (backup) return backup;
  return { servers: {} };
}

/** Merge one collection payload into the doc; records are stored raw (normalization happens at view/merge time). */
export function ingestRecords(doc, payload, now = Date.now()) {
  const origin = String(payload?.origin || '');
  let url;
  try { url = new URL(origin); } catch { return { doc, added: 0 }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { doc, added: 0 };
  const incoming = Array.isArray(payload?.records) ? payload.records : [];
  const servers = { ...doc.servers };
  const previous = servers[origin];
  const bucket = previous ? { ...previous, records: [...previous.records] }
    : { host: url.host, app: '', verification: '', firstSeen: now, lastSeen: now, records: [] };
  bucket.host = String(payload.host || bucket.host || url.host).slice(0, 128);
  bucket.app = String(payload.app || bucket.app || '').slice(0, 32);
  bucket.verification = String(payload.verification || bucket.verification || '').slice(0, 32);
  bucket.lastSeen = now;
  const known = new Set(bucket.records.map((r) => r.id));
  let added = 0;
  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '');
    if (!id || known.has(id)) continue;
    known.add(id);
    bucket.records.push({ id, collectedAt: now, raw });
    added += 1;
  }
  bucket.records.sort((a, b) => (a.collectedAt || 0) - (b.collectedAt || 0));
  if (bucket.records.length > RECORDS_LIMITS.perServer) bucket.records = bucket.records.slice(-RECORDS_LIMITS.perServer);
  servers[origin] = bucket;
  return { doc: { servers }, added };
}

export function trimRecordsDoc(doc) {
  const servers = { ...doc.servers };
  let keys = Object.keys(servers);
  while (keys.length > RECORDS_LIMITS.servers) {
    let oldest = keys[0];
    for (const k of keys) if ((servers[k].lastSeen || 0) < (servers[oldest].lastSeen || 0)) oldest = k;
    delete servers[oldest];
    keys = Object.keys(servers);
  }
  const tooBig = () => JSON.stringify({ servers }).length > RECORDS_LIMITS.maxChars;
  while (tooBig()) {
    let target = null;
    for (const k of keys) if (!target || servers[k].records.length > servers[target].records.length) target = k;
    if (!target || !servers[target].records.length) break;
    servers[target] = { ...servers[target], records: servers[target].records.slice(1) };
  }
  return { servers };
}

export function saveRecordsDoc(file, doc, mirrorFile = null) {
  const text = JSON.stringify(doc);
  const write = (target) => {
    const tmp = `${target}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, target);
  };
  // never replace a good .bak with a corrupt primary
  if (fs.existsSync(file) && readRecordsDocFile(file)) {
    try { fs.copyFileSync(file, `${file}.bak`); } catch { /* the primary remains authoritative */ }
  }
  write(file);
  if (mirrorFile && mirrorFile !== file) {
    try { write(mirrorFile); } catch (error) { console.warn('[records] mirror write failed:', error?.message ?? error); }
  }
}

function collectBody(req, limit) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { req.destroy(); resolve(null); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

export function createRemoteRouter({ host, getPort, proxy, wsProxy = false, fingerprints = remoteHealth(),
  probe = probeRemoteGame, assetTargets = remoteAssetTargets, token = randomToken(), requireToken = true,
  assetHash = null, recordsFile = path.join(process.env.HOME || ROOT, 'remote-records.json'),
  recordsMirrorFile = process.env.SP_EXTERNAL_FILES
    ? path.join(process.env.SP_EXTERNAL_FILES, 'remote-records.json') : null } = {}) {
  const controlToken = token;
  const expectedAssetHash = assetHash ?? localAssetHash();
  return async function handleRemote(req, res, parts) {
    const paths = ['/connect/info', '/connect/token', '/connect/session', '/connect/probe', '/connect/assets',
      '/connect/records', '/sp-remote'];
    if (!paths.includes(parts.rawPath)) return false;
    const origin = req.headers?.origin;
    if (!isLoopbackAddress(req.socket?.remoteAddress) || (origin && origin !== `http://${req.headers.host}`)) {
      sendJson(req, res, 403, { ok: false, reason: 'local-only' }); return true;
    }
    if (parts.rawPath === '/connect/info') {
      const port = Number(getPort?.() || 0);
      const lanAvailable = host === '0.0.0.0' || host === '::' || !isLoopbackHost(host);
      sendJson(req, res, 200, { ok: true, port, lan: lanUrls(port), lanAvailable, proxyActive: !!proxy?.target,
        token: controlToken }); return true;
    }
    if (parts.rawPath === '/connect/token') {
      sendJson(req, res, 200, { ok: true, token: controlToken }); return true;
    }
    if (requireToken && ['/connect/session', '/connect/probe', '/connect/assets', '/connect/records'].includes(parts.rawPath)) {
      const supplied = req.headers?.['x-sp-control'] || new URLSearchParams(parts.query || '').get('token') || '';
      if (supplied !== controlToken) { sendJson(req, res, 403, { ok: false, reason: 'token-required' }); return true; }
    }
    const raw = new URLSearchParams(parts.query).get('url') || '';
    const expected = { expectedCompat: fingerprints.compat, expectedAssets: fingerprints.assets };
    if (parts.rawPath === '/connect/session') {
      if (!raw) { sendJson(req, res, 400, { ok: false, reason: 'invalid-url' }); return true; }
      const result = await probe(raw, expected);
      if (!result.reachable) { sendJson(req, res, 200, { ok: false, ...result }); return true; }
      if (result.game === false || result.reason === 'invalid-game-page') {
        sendJson(req, res, 200, { ok: false, reason: 'invalid-game-page', ...result }); return true;
      }
      const targets = await assetTargets(result.finalUrl || raw, { expectedAssetHash: expectedAssetHash });
      sendJson(req, res, 200, {
        ok: true, ...result, ...targets,
        assetMatch: result.assetMatch ?? targets.assetMatch ?? null,
      });
      return true;
    }
    if (parts.rawPath === '/connect/assets') {
      if (!raw) { sendJson(req, res, 400, { ok: false, reason: 'invalid-url' }); return true; }
      const resolved = await resolveRemoteRedirects(raw);
      if (!resolved.ok) { sendJson(req, res, 200, { ok: false, reason: resolved.reason }); return true; }
      const targets = await assetTargets(resolved.url, { expectedAssetHash: expectedAssetHash });
      sendJson(req, res, 200, { ok: true, ...targets, requestedUrl: resolved.requestedUrl,
        finalUrl: targets.finalUrl || resolved.url, redirects: resolved.chain }); return true;
    }
    if (parts.rawPath === '/connect/records') {
      const params = new URLSearchParams(parts.query);
      if (req.method === 'GET') {
        const doc = loadRecordsDoc(recordsFile, recordsMirrorFile);
        if (params.get('ids') === '1') {
          const ids = (doc.servers[params.get('origin') || '']?.records || []).map((r) => r.id);
          sendJson(req, res, 200, { ok: true, ids }); return true;
        }
        sendJson(req, res, 200, { ok: true, ...doc }); return true;
      }
      if (req.method === 'POST') {
        const body = await collectBody(req, RECORDS_LIMITS.postBytes);
        if (body === null) { sendJson(req, res, 413, { ok: false, reason: 'too-large' }); return true; }
        let payload;
        try { payload = JSON.parse(body); } catch { sendJson(req, res, 400, { ok: false, reason: 'invalid-json' }); return true; }
        const ingested = ingestRecords(loadRecordsDoc(recordsFile, recordsMirrorFile), payload);
        saveRecordsDoc(recordsFile, trimRecordsDoc(ingested.doc), recordsMirrorFile);
        sendJson(req, res, 200, { ok: true, added: ingested.added }); return true;
      }
      if (req.method === 'DELETE') {
        const origin = params.get('origin') || '';
        if (!origin) { sendJson(req, res, 400, { ok: false, reason: 'origin-required' }); return true; }
        const doc = loadRecordsDoc(recordsFile, recordsMirrorFile);
        delete doc.servers[origin];
        saveRecordsDoc(recordsFile, doc, recordsMirrorFile);
        sendJson(req, res, 200, { ok: true }); return true;
      }
      sendJson(req, res, 405, { ok: false, reason: 'method-not-allowed' }); return true;
    }
    if (parts.rawPath === '/sp-remote') {
      if (!wsProxy || !proxy) { sendJson(req, res, 404, { ok: false, reason: 'proxy-disabled' }); return true; }
      if (!raw) { proxy.clear(); sendJson(req, res, 200, { ok: true, cleared: true }); return true; }
      const direct = /^wss?:\/\//i.test(raw); const target = remoteWsUrl(raw);
      const pageUrl = direct ? raw.replace(/^ws/i, 'http').replace(/\/ws(?:[?#].*)?$/, '/') : raw;
      if (!target || !normalizeRemoteUrl(pageUrl)) { sendJson(req, res, 400, { ok: false, reason: 'invalid-url' }); return true; }
      const result = await probe(pageUrl, expected);
      if (!result.proxyable) { sendJson(req, res, 409, { ok: false, ...result }); return true; }
      proxy.clear(); proxy.target = remoteWsUrl(result.finalUrl || pageUrl);
      sendJson(req, res, 200, { ok: true, assetMatch: result.assetMatch }); return true;
    }
    sendJson(req, res, 200, await probe(raw, expected)); return true;
  };
}

/** Text/binary bridge with bounded pre-open queue and symmetric shutdown. */
export function createWsProxy({ proxy, enabled, limits = PROXY_LIMITS }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.payload, perMessageDeflate: false });
  return { close() { proxy?.clear(); wss.close(); }, upgrade(req, socket, head) {
    if (!enabled || !proxy?.target) return false;
    if (!isLoopbackAddress(req.socket.remoteAddress)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return true; }
    const target = proxy.target;
    if (proxy.sockets.size >= 64) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return true; }
    wss.handleUpgrade(req, socket, head, (local) => {
      proxy.sockets.add(local);
      const upstream = new WebSocket(target, { handshakeTimeout: limits.timeoutMs, maxPayload: limits.payload, followRedirects: false });
      const queue = []; let queuedBytes = 0; let closed = false;
      const close = () => {
        if (closed) return;
        closed = true; clearTimeout(timer); queue.length = 0; proxy.sockets.delete(local);
        local.terminate(); upstream.terminate();
      };
      const timer = setTimeout(close, limits.timeoutMs);
      const send = (to, data, binary) => {
        if (to.bufferedAmount + data.length > limits.bytes) { close(); return; }
        to.send(data, { binary }, (error) => { if (error) close(); });
      };
      local.on('message', (data, binary) => {
        if (closed) return;
        if (upstream.readyState === WebSocket.OPEN) { send(upstream, data, binary); return; }
        queuedBytes += data.length;
        if (queue.length >= limits.frames || queuedBytes > limits.bytes) { close(); return; }
        queue.push([data, binary]);
      });
      upstream.on('open', () => { clearTimeout(timer); for (const [data, binary] of queue) send(upstream, data, binary); queue.length = 0; queuedBytes = 0; });
      upstream.on('message', (data, binary) => { if (!closed && local.readyState === WebSocket.OPEN) send(local, data, binary); });
      for (const peer of [local, upstream]) { peer.on('error', close); peer.on('close', close); }
      upstream.on('unexpected-response', (_req, response) => { response.resume(); close(); });
    });
    return true;
  } };
}
