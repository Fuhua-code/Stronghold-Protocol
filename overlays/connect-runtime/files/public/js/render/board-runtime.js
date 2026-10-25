// Runtime helpers shared by the 2D/3D board loaders in the mobile overlay.
// Android WebView can briefly return an empty/failed response while the copied
// project is still becoming available. These helpers keep retries bounded and
// make a failed request observable without exposing credentials or full URLs in
// user-facing diagnostics.

const DEFAULT_DELAYS = Object.freeze([120, 400, 1200]);
const state = globalThis.__SP_BOARD_DIAGNOSTICS__ || {
  mode: 'unknown', webgl2: null, allowSlow: false, slowGpu: false, failures: [], retries: 0, contextLosses: 0, reason: null,
};
globalThis.__SP_BOARD_DIAGNOSTICS__ = state;

export function normalizeAssetUrl(input) {
  if (typeof input !== 'string' || !input) return null;
  const hash = input.indexOf('#');
  const query = input.indexOf('?');
  const cut = [hash, query].filter((x) => x >= 0).sort((a, b) => a - b)[0] ?? input.length;
  const pathname = input.slice(0, cut);
  const suffix = input.slice(cut);
  try {
    let decoded = pathname;
    for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(decoded); i++) decoded = decodeURIComponent(decoded);
    return decoded.split('/').map((part, i) => i === 0 && part === '' ? '' : encodeURIComponent(part)).join('/') + suffix;
  } catch {
    return input;
  }
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function retryFetch(url, { json = false, retries = 2, timeout = 8000, delays = DEFAULT_DELAYS } = {}) {
  const normalized = normalizeAssetUrl(url) || url;
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
    try {
      const res = await fetch(normalized, { cache: 'no-cache', signal: controller?.signal });
      if (res.ok) return json ? await res.json() : await res.text();
      last = new Error(`HTTP ${res.status}`); last.status = res.status;
      // A missing file will not become available through a retry, but mobile
      // file publication can transiently report 408/429/5xx.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
    } catch (error) { last = error; }
    state.retries++;
    if (attempt < retries) await wait(delays[Math.min(attempt, delays.length - 1)] || 0);
    if (timer) clearTimeout(timer);
  }
  state.failures = [...state.failures.slice(-19), String(normalized)];
  throw last || new Error('asset request failed');
}

export async function retryImage(assets, url, options = {}) {
  const normalized = normalizeAssetUrl(url) || url;
  const retries = options.retries ?? 2;
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const image = await assets.image(normalized);
      if (image && (image.width || image.naturalWidth) > 0) return image;
      last = new Error('image has no dimensions');
    } catch (error) { last = error; }
    state.retries++;
    if (attempt < retries) await wait(DEFAULT_DELAYS[Math.min(attempt, DEFAULT_DELAYS.length - 1)]);
  }
  state.failures = [...state.failures.slice(-19), String(normalized)];
  return null;
}

export function boardDiagnostics() { return { ...state, failures: [...state.failures] }; }
export function recordBoardFailure(url, reason) {
  state.reason = String(reason || 'asset failure');
  if (url) state.failures = [...state.failures.slice(-19), String(url)];
}
export function recordContextLoss() { state.contextLosses++; state.reason = 'webgl-context-lost'; }
export function setBoardMode(mode, details = {}) { Object.assign(state, details, { mode }); }
export function resetBoardRuntime() { state.failures = []; state.retries = 0; state.reason = null; }

/** A small, non-blocking Android notice. It is intentionally one per field. */
export function showBoardNotice(host, { mode = '2d', reason = '', onRetry = null } = {}) {
  if (!host || !/Android/i.test(globalThis.navigator?.userAgent || '')) return;
  let box = host.querySelector?.('.sp-board-notice');
  if (!box) {
    box = document.createElement('div');
    box.className = 'sp-board-notice';
    Object.assign(box.style, { position: 'absolute', left: '8px', right: '8px', bottom: '8px', zIndex: '20', padding: '6px 8px', background: 'rgba(12,20,20,.9)', color: '#f5d89a', font: '12px sans-serif', border: '1px solid rgba(245,216,154,.55)', borderRadius: '4px' });
    host.appendChild(box);
  }
  box.textContent = mode === '2d' ? `地图资源加载失败，已切换 2D${reason ? `（${reason}）` : ''}` : '地图 3D 已恢复';
  if (onRetry) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = '重试';
    button.style.marginLeft = '8px'; button.onclick = () => { box.remove(); onRetry(); };
    box.appendChild(button);
  }
}
