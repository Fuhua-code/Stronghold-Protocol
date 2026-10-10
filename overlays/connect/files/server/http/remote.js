// Optional mobile remote adapter. TLS certificate verification remains enabled.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
    compat: fingerprint(root, ['shared', 'server/net.js', 'server/lobby.js', 'server/match', 'server/sim', 'public/js', 'data'],
      new Set(['data/assets.json', 'data/local-assets.json'])),
    assets: fingerprint(root, ['data/assets.json', 'data/local-assets.json']) };
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
  return /id=["']app["']/.test(body) && /<script\b[^>]*type=["']module["'][^>]*src=["'](?:\/|\.\/)?js\/main\.js["']/.test(body);
}

export async function probeRemoteGame(raw, { fetchFn = globalThis.fetch, checkWs = checkRemoteWebSocket,
  timeoutMs = 8000, expectedApp = APP_VERSION, expectedProtocol = PROTOCOL_VERSION,
  expectedCompat = remoteHealth().compat, expectedAssets = remoteHealth().assets } = {}) {
  const normalized = normalizeRemoteUrl(raw);
  const failure = (reason, extra = {}) => ({ reachable: false, valid: false, proxyable: false, blocked: false, reason, ...extra });
  if (!normalized) return failure('invalid-url');
  const root = new URL(normalized); root.search = ''; root.hash = '';
  root.pathname = root.pathname.replace(/\/$/, '') + '/';
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  const get = async (address) => {
    const response = await fetchFn(address, { redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) {
      const redirect = new URL(response.headers.get('location') || '', address);
      if (!normalizeRemoteUrl(redirect.toString())) throw Object.assign(new Error('invalid redirect'), { code: 'INVALID_REDIRECT' });
      throw new Error('browser verification required');
    }
    return response;
  };
  let health;
  try {
    const response = await get(new URL('healthz', root));
    if (!response.ok) return failure('health-missing', { reachable: true, blocked: [401, 403, 503].includes(response.status), candidateUrl: normalized });
    try { health = await response.json(); } catch { return failure('health-missing', { reachable: true }); }
    const protocol = health?.protocol ?? health?.version;
    const confirmed = health?.ok === true && typeof health.app === 'string' && Number.isInteger(protocol)
      && typeof health.compat === 'string' && health.compat.length > 0 && typeof health.assets === 'string' && health.assets.length > 0;
    if (!confirmed) return failure('health-missing', { reachable: true, remoteHealth: health });
    const compatible = health.app === expectedApp && protocol === expectedProtocol && health.compat === expectedCompat;
    const assetMatch = health.assets === expectedAssets;
    if (!compatible) return failure('version-mismatch', { reachable: true, remoteHealth: health, compatible: false, assetMatch });
    const page = await get(root);
    if (!page.ok || !gamePage(await page.text())) return failure('invalid-game-page', { reachable: true, blocked: true, candidateUrl: normalized });
    if (!await checkWs(normalized, timeoutMs)) return failure('ws-unavailable', { reachable: true, remoteHealth: health, compatible, assetMatch });
    return { reachable: true, valid: true, proxyable: true, blocked: false, reason: 'game', remoteHealth: health,
      compatible, assetMatch, proxyUrl: normalized };
  } catch (error) {
    if (error?.code === 'INVALID_REDIRECT') return failure('local-or-invalid-redirect');
    return failure(error?.name === 'AbortError' ? 'timeout' : 'verification-required', { blocked: true, candidateUrl: normalized });
  } finally { clearTimeout(timer); }
}

export function createProxyState() {
  return { target: null, sockets: new Set(), clear() {
    this.target = null;
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
  } };
}

export function createRemoteRouter({ host, getPort, proxy, wsProxy = false, fingerprints = remoteHealth(), probe = probeRemoteGame } = {}) {
  return async function handleRemote(req, res, parts) {
    if (!['/connect/info', '/connect/probe', '/sp-remote'].includes(parts.rawPath)) return false;
    const origin = req.headers?.origin;
    if (!isLoopbackAddress(req.socket?.remoteAddress) || (origin && origin !== `http://${req.headers.host}`)) {
      sendJson(req, res, 403, { ok: false, reason: 'local-only' }); return true;
    }
    if (parts.rawPath === '/connect/info') {
      const port = Number(getPort?.() || 0);
      sendJson(req, res, 200, { ok: true, port, lan: lanUrls(port), lanAvailable: !isLoopbackHost(host), proxyActive: !!proxy?.target }); return true;
    }
    const raw = new URLSearchParams(parts.query).get('url') || '';
    if (parts.rawPath === '/sp-remote') {
      if (!wsProxy || !proxy) { sendJson(req, res, 404, { ok: false, reason: 'proxy-disabled' }); return true; }
      if (!raw) { proxy.clear(); sendJson(req, res, 200, { ok: true, cleared: true }); return true; }
      const direct = /^wss?:\/\//i.test(raw); const target = remoteWsUrl(raw);
      const pageUrl = direct ? raw.replace(/^ws/i, 'http').replace(/\/ws(?:[?#].*)?$/, '/') : raw;
      if (!target || !normalizeRemoteUrl(pageUrl)) { sendJson(req, res, 400, { ok: false, reason: 'invalid-url' }); return true; }
      const result = await probe(pageUrl, { expectedCompat: fingerprints.compat, expectedAssets: fingerprints.assets });
      if (!result.proxyable) { sendJson(req, res, 409, { ok: false, ...result }); return true; }
      proxy.clear(); proxy.target = target;
      sendJson(req, res, 200, { ok: true, assetMatch: result.assetMatch }); return true;
    }
    sendJson(req, res, 200, await probe(raw, { expectedCompat: fingerprints.compat, expectedAssets: fingerprints.assets })); return true;
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
