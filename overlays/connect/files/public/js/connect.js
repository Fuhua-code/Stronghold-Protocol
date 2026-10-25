import { isLoopbackHost, normalizeRemoteUrl } from '../../shared/connect.js';
export { isLoopbackHost, normalizeRemoteUrl } from '../../shared/connect.js';

export function androidBridge() {
  return typeof window !== 'undefined' ? window.SP_BRIDGE || null : null;
}

let controlTokenPromise = null;

async function controlToken(fetchFn, reset = false) {
  if (reset) controlTokenPromise = null;
  if (!controlTokenPromise) {
    controlTokenPromise = fetchFn('/connect/token', { cache: 'no-store' })
      .then((response) => response.json())
      .then((body) => (typeof body?.token === 'string' ? body.token : ''))
      .catch(() => '');
  }
  return controlTokenPromise;
}

async function controlGet(path, { fetchFn = globalThis.fetch, signal } = {}) {
  let token = await controlToken(fetchFn);
  const request = () => fetchFn(path, { cache: 'no-store', signal, headers: { 'x-sp-control': token } });
  let response = await request();
  if (response.status === 403) {
    token = await controlToken(fetchFn, true);
    response = await request();
  }
  return response;
}
export { controlGet };

/** Authenticated control-plane call with a body / method (records archive, future control routes). */
export async function controlRequest(path, { method = 'GET', body = null, fetchFn = globalThis.fetch } = {}) {
  let token = await controlToken(fetchFn);
  const request = () => fetchFn(path, {
    method, cache: 'no-store', body,
    headers: { 'x-sp-control': token, ...(body ? { 'content-type': 'application/json' } : {}) },
  });
  let response = await request();
  if (response.status === 403) {
    token = await controlToken(fetchFn, true);
    response = await request();
  }
  return response;
}

/** One loopback call: resolve the entry link, admit the game, discover asset targets. */
export async function resolveRemoteSession(url, { fetchFn = globalThis.fetch, timeoutMs = 25000 } = {}) {
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) return { ok: false, valid: false, reason: 'invalid-url' };
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await controlGet(`/connect/session?url=${encodeURIComponent(normalized)}`, { fetchFn, signal: controller?.signal });
    const body = await response.json().catch(() => ({}));
    console.log('[remote-art] session', normalized, response.status, JSON.stringify(body));
    return response.ok ? body : { ...body, valid: false, reason: body.reason || `HTTP ${response.status}` };
  } catch (error) {
    return { valid: false, blocked: true, reason: error?.name === 'AbortError' ? 'timeout' : 'network-error' };
  } finally { if (timer) clearTimeout(timer); }
}

export async function probeRemoteGame(url, { fetchFn = globalThis.fetch, timeoutMs = 12000 } = {}) {
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) return { reachable: false, valid: false, blocked: false, reason: 'invalid-url' };
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await controlGet(`/connect/probe?url=${encodeURIComponent(normalized)}`, { fetchFn, signal: controller?.signal });
    const body = await response.json().catch(() => ({}));
    return response.ok ? body : { ...body, reachable: false, valid: false, reason: body.reason || `HTTP ${response.status}` };
  } catch (error) {
    return { reachable: false, valid: false, blocked: true, reason: error?.name === 'AbortError' ? 'timeout' : 'network-error' };
  } finally { if (timer) clearTimeout(timer); }
}

export async function discoverRemoteAssets(url, { fetchFn = globalThis.fetch, timeoutMs = 12000 } = {}) {
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) return { origins: [], prefixes: [], manifests: [], assetMatch: null, finalUrl: null };
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await controlGet(`/connect/assets?url=${encodeURIComponent(normalized)}`, { fetchFn, signal: controller?.signal });
    const body = await response.json().catch(() => ({}));
    console.log('[remote-art] discover', normalized, response.status, JSON.stringify(body));
    return {
      origins: Array.isArray(body.origins) ? body.origins.filter((x) => typeof x === 'string') : [],
      prefixes: Array.isArray(body.prefixes) ? body.prefixes.filter((x) => typeof x === 'string') : [],
      manifests: Array.isArray(body.manifests) ? body.manifests.filter((x) => typeof x === 'string') : [],
      assetMatch: typeof body.assetMatch === 'boolean' ? body.assetMatch : null,
      finalUrl: typeof body.finalUrl === 'string' ? body.finalUrl : null,
    };
  } catch (error) {
    console.log('[remote-art] discover failed', String(error));
    return { origins: [], prefixes: [], manifests: [], assetMatch: null, finalUrl: null };
  } finally { if (timer) clearTimeout(timer); }
}

// Legacy local-proxy helpers. The Android shell no longer uses them; kept for older pages/tests.
export async function configureRemoteProxy(url, { fetchFn = globalThis.fetch } = {}) {
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) return { ok: false, reason: 'invalid-url' };
  try {
    const response = await fetchFn(`/sp-remote?url=${encodeURIComponent(normalized)}`, { cache: 'no-store' });
    return await response.json().catch(() => ({ ok: response.ok }));
  } catch { return { ok: false, reason: 'proxy-failed' }; }
}

export async function clearRemoteProxy({ fetchFn = globalThis.fetch } = {}) {
  try {
    const response = await fetchFn('/sp-remote?url=', { cache: 'no-store' });
    return await response.json().catch(() => ({ ok: response.ok }));
  } catch { return { ok: false, reason: 'proxy-clear-failed' }; }
}
