import { PROTOCOL_VERSION, APP_VERSION } from '../../shared/constants.js';
import { isLoopbackHost, normalizeRemoteUrl } from '../../shared/connect.js';
import { sendJson } from './common.js';

export function isLoopbackAddress(address) {
  let value = String(address || '').toLowerCase().replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
  if (value === '::1' || value === '::' || value === 'localhost') return true;
  return /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(value) || value === '0.0.0.0';
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, done: () => clearTimeout(timer) };
}

function gamePage(body) {
  return /STRONGHOLD\s+PROTOCOL|public\/js\/main\.js|type=["']module["']/i.test(body);
}

function remoteWsUrl(base) {
  const url = new URL(base);
  url.pathname = url.pathname.replace(/\/$/, '') + '/ws';
  return url;
}

async function request(fetchFn, url, options, timeoutMs) {
  const { controller, done } = withTimeout(timeoutMs);
  try { return await fetchFn(url, { ...options, redirect: 'manual', signal: controller.signal }); }
  finally { done(); }
}

export async function probeRemoteGame(raw, { fetchFn = globalThis.fetch, timeoutMs = 8000, expectedApp = APP_VERSION, expectedProtocol = PROTOCOL_VERSION } = {}) {
  const url = normalizeRemoteUrl(raw);
  if (!url) return { reachable: false, valid: false, blocked: false, reason: 'invalid-url' };
  const base = new URL(url);
  const root = new URL(base);
  root.pathname = root.pathname.replace(/\/$/, '') + '/';
  let health;
  try {
    const response = await request(fetchFn, new URL('healthz', root), {}, timeoutMs);
    if (response.status >= 300 && response.status < 400) return { reachable: true, valid: false, blocked: false, reason: 'local-or-invalid-redirect' };
    if (!response.ok) return { reachable: true, valid: false, blocked: false, reason: 'health-missing' };
    health = await response.json();
  } catch (error) {
    const blocked = error?.name === 'AbortError' || /certificate|tls|forbidden|challenge/i.test(String(error?.message || ''));
    return { reachable: false, valid: false, blocked, reason: blocked ? 'verification-required' : 'unreachable' };
  }
  if (health?.ok !== true || typeof health.app !== 'string' || typeof health.version !== 'string' || typeof health.compat !== 'string' || typeof health.assets !== 'string') {
    return { reachable: true, valid: false, blocked: false, reason: 'health-missing' };
  }
  if (health.app !== expectedApp || health.version !== expectedProtocol) {
    return { reachable: true, valid: false, blocked: false, reason: 'version-mismatch', remoteHealth: health };
  }
  try {
    const response = await request(fetchFn, root, {}, timeoutMs);
    if (response.status >= 300 && response.status < 400) return { reachable: true, valid: false, blocked: false, reason: 'local-or-invalid-redirect' };
    const body = await response.text();
    if (!response.ok || !gamePage(body)) return { reachable: true, valid: false, blocked: false, reason: 'invalid-game-page' };
  } catch { return { reachable: false, valid: false, blocked: false, reason: 'page-unavailable' }; }
  // A normal HTTP request cannot perform a WebSocket upgrade. The endpoint is still advertised so the Android
  // bridge can attempt the real upgrade; servers that do not expose /ws are rejected by the bridge itself.
  return { reachable: true, valid: true, blocked: false, remoteHealth: health, compatible: true, assetMatch: true, proxyable: true, proxyUrl: remoteWsUrl(root).toString() };
}

export function createRemoteRouter({ host, getPort, proxy, expectedApp = APP_VERSION, expectedProtocol = PROTOCOL_VERSION } = {}) {
  return async function handleRemote(req, res, parts) {
    if (!['/connect/info', '/connect/probe', '/sp-remote'].includes(parts.rawPath)) return false;
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      sendJson(req, res, 403, { ok: false, reachable: false, valid: false, reason: 'local-only' });
      return true;
    }
    if (parts.rawPath === '/connect/info') {
      const port = Number(getPort?.() || 0);
      sendJson(req, res, 200, { ok: true, port, lan: [], lanAvailable: host !== '127.0.0.1' && host !== '::1' });
      return true;
    }
    if (parts.rawPath === '/sp-remote') {
      const target = new URLSearchParams(parts.query).get('url') || '';
      if (!target) {
        if (proxy) proxy.target = null;
        sendJson(req, res, 200, { ok: true, cleared: true });
        return true;
      }
      const normalized = normalizeRemoteUrl(target);
      if (!normalized) { sendJson(req, res, 400, { ok: false, reason: 'invalid-url' }); return true; }
      if (proxy) proxy.target = remoteWsUrl(normalized).toString();
      sendJson(req, res, 200, { ok: true, target: proxy?.target || null });
      return true;
    }
    const query = new URLSearchParams(parts.query);
    const result = await probeRemoteGame(query.get('url'), { expectedApp, expectedProtocol });
    sendJson(req, res, 200, result);
    return true;
  };
}
