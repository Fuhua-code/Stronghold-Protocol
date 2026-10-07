// Shared Cloudflare TURN broker logic. Adapters keep transport-specific response handling separate.

export const DEFAULT_ORIGIN = 'https://fuhua-code.github.io';
export const CLOUDFLARE_ENDPOINT = 'https://rtc.live.cloudflare.com/v1/turn/keys';
export const TURN_MIN_TTL = 300;
export const TURN_MAX_TTL = 1800;
export const TURN_DEFAULT_TTL = 600;
export const TURN_RATE_WINDOW_MS = 60_000;
export const TURN_RATE_LIMIT = 30;

const isTurnUrl = (value) => typeof value === 'string'
  && /^(?:turn|turns):[^\s]+$/i.test(value);
const isStunUrl = (value) => typeof value === 'string'
  && /^(?:stun|stuns):[^\s]+$/i.test(value);

/** Read canonical names first, then the names already configured on Windows. */
export function readTurnConfig(env = (typeof process !== 'undefined' ? process.env : {})) {
  const apiToken = String(env.CLOUDFLARE_TURN_API_TOKEN || env.Cloudflare_Turn_API || '').trim();
  const keyId = String(env.CLOUDFLARE_TURN_KEY_ID || env.Turn_Token || '').trim();
  const origins = String(env.TURN_ALLOWED_ORIGINS || DEFAULT_ORIGIN)
    .split(',').map((value) => value.trim()).filter(Boolean);
  return { apiToken, keyId, origins: new Set(origins), enabled: !!(apiToken && keyId) };
}

/** Keep only WebRTC server entries that Cloudflare returned in the expected shape. */
export function normalizeIceServers(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  let hasTurn = false;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rawUrls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
    const urls = rawUrls.filter((url) => isTurnUrl(url) || isStunUrl(url));
    if (!urls.length) continue;
    const turn = urls.some(isTurnUrl);
    if (turn) {
      if (typeof entry.username !== 'string' || !entry.username
        || typeof entry.credential !== 'string' || !entry.credential) continue;
      out.push({ urls, username: entry.username, credential: entry.credential });
      hasTurn = true;
    } else out.push({ urls });
  }
  return hasTurn ? out : null;
}

export function parseTurnTtl(value) {
  const raw = String(value ?? TURN_DEFAULT_TTL).trim();
  if (!/^\d+$/.test(raw)) return null;
  const ttl = Number(raw);
  return Number.isInteger(ttl) && ttl >= TURN_MIN_TTL && ttl <= TURN_MAX_TTL ? ttl : null;
}

export function allowedOrigin(config, value) {
  return typeof value === 'string' && config.origins.has(value) ? value : null;
}

/** Generate short-lived credentials without exposing config or upstream errors. */
export function createTurnGenerator(opts = {}) {
  const config = readTurnConfig(opts.env || (typeof process !== 'undefined' ? process.env : {}));
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const now = opts.now || Date.now;
  const timeoutMs = opts.timeoutMs ?? 8000;

  async function generate(ttl) {
    if (!config.enabled || typeof fetchImpl !== 'function') throw new Error('turn_unavailable');
    const endpoint = `${CLOUDFLARE_ENDPOINT}/${encodeURIComponent(config.keyId)}/credentials/generate-ice-servers`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ ttl }),
        signal: controller.signal,
      });
      if (!response || !response.ok) throw new Error('turn_unavailable');
      const body = await response.json();
      const iceServers = normalizeIceServers(body?.iceServers);
      if (!iceServers) throw new Error('turn_unavailable');
      return { iceServers, expiresAt: now() + ttl * 1000 };
    } catch {
      throw new Error('turn_unavailable');
    } finally {
      clearTimeout(timer);
    }
  }

  return { config: { enabled: config.enabled, origins: new Set(config.origins) }, generate };
}

/** Best-effort per-instance limiter suitable for both Node and Vercel adapters. */
export function createTurnRateLimiter({ now = Date.now, keyFn = () => '?' } = {}) {
  const calls = new Map();
  return (request) => {
    const key = String(keyFn(request) || '?');
    const current = now();
    const cutoff = current - TURN_RATE_WINDOW_MS;
    const recent = (calls.get(key) || []).filter((stamp) => stamp > cutoff);
    if (recent.length >= TURN_RATE_LIMIT) {
      calls.set(key, recent);
      return false;
    }
    recent.push(current);
    calls.set(key, recent);
    if (calls.size > 2048) for (const [name, values] of calls) {
      if (!values.some((stamp) => stamp > cutoff)) calls.delete(name);
    }
    return true;
  };
}

export { isTurnUrl, isStunUrl };
