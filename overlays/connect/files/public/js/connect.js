import { isLoopbackHost, normalizeRemoteUrl } from '../../../shared/connect.js';
export { isLoopbackHost, normalizeRemoteUrl } from '../../../shared/connect.js';

export function androidBridge() {
  return typeof window !== 'undefined' ? window.SP_BRIDGE || null : null;
}

export async function probeRemoteGame(url, { fetchFn = globalThis.fetch, timeoutMs = 9000 } = {}) {
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) return { reachable: false, valid: false, blocked: false, reason: 'invalid-url' };
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchFn(`/connect/probe?url=${encodeURIComponent(normalized)}`, { cache: 'no-store', signal: controller?.signal });
    const body = await response.json().catch(() => ({}));
    return response.ok ? body : { ...body, reachable: false, valid: false, reason: body.reason || `HTTP ${response.status}` };
  } catch (error) {
    return { reachable: false, valid: false, blocked: true, reason: error?.name === 'AbortError' ? 'timeout' : 'network-error' };
  } finally { if (timer) clearTimeout(timer); }
}

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
