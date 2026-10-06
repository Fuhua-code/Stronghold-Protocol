// Cloudflare TURN credential broker. Long-lived credentials stay on the Node server.

const DEFAULT_ORIGIN = 'https://fuhua-code.github.io';
const CLOUDFLARE_ENDPOINT = 'https://rtc.live.cloudflare.com/v1/turn/keys';
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
export function readTurnConfig(env = process.env) {
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

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value));
}

function sendJson(res, status, value, origin = null, extra = {}) {
  const body = jsonBytes(value);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(body);
}

function sendOptions(res, origin) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  });
  res.end();
}

/**
 * Create the request handler used by server/index.js. The fetch and clock are injectable for tests.
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, now?: () => number,
 *           timeoutMs?: number, clientKey?: (req: import('node:http').IncomingMessage) => string }} [opts]
 */
export function createTurnBroker(opts = {}) {
  const config = readTurnConfig(opts.env || process.env);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const now = opts.now || Date.now;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const clientKey = opts.clientKey || ((req) => req.socket?.remoteAddress || '?');
  const calls = new Map();

  function allowedOrigin(req) {
    const origin = req.headers?.origin;
    return typeof origin === 'string' && config.origins.has(origin) ? origin : null;
  }

  function allowedByRateLimit(req) {
    const key = String(clientKey(req) || '?');
    const cutoff = now() - TURN_RATE_WINDOW_MS;
    const recent = (calls.get(key) || []).filter((stamp) => stamp > cutoff);
    if (recent.length >= TURN_RATE_LIMIT) {
      calls.set(key, recent);
      return false;
    }
    recent.push(now());
    calls.set(key, recent);
    if (calls.size > 2048) for (const [name, values] of calls) {
      if (!values.some((stamp) => stamp > cutoff)) calls.delete(name);
    }
    return true;
  }

  async function generate(ttl) {
    if (!config.enabled || typeof fetchImpl !== 'function') throw new Error('turn_unavailable');
    const endpoint = `${CLOUDFLARE_ENDPOINT}/${encodeURIComponent(config.keyId)}/credentials/generate-ice-servers`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
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

  async function handle(req, res) {
    const origin = allowedOrigin(req);
    if (req.method === 'OPTIONS') {
      if (!origin) sendJson(res, 403, { error: 'origin_not_allowed' });
      else sendOptions(res, origin);
      return;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' }, origin, { Allow: 'GET, OPTIONS' });
      return;
    }
    if (!origin) {
      sendJson(res, 403, { error: 'origin_not_allowed' });
      return;
    }
    if (!allowedByRateLimit(req)) {
      sendJson(res, 429, { error: 'rate_limited' }, origin);
      return;
    }
    let ttl = TURN_DEFAULT_TTL;
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const raw = url.searchParams.get('ttl');
      if (raw !== null) ttl = parseTurnTtl(raw);
    } catch { ttl = null; }
    if (ttl === null) {
      sendJson(res, 400, { error: 'invalid_ttl', min: TURN_MIN_TTL, max: TURN_MAX_TTL }, origin);
      return;
    }
    try {
      sendJson(res, 200, await generate(ttl), origin);
    } catch {
      sendJson(res, 503, { error: 'turn_unavailable' }, origin);
    }
  }

  // Never expose the credential-bearing config object to callers or diagnostics.
  return { config: { enabled: config.enabled, origins: new Set(config.origins) }, handle, generate };
}
