// Node HTTP adapter for the shared Cloudflare TURN broker.

import {
  TURN_DEFAULT_TTL,
  TURN_MAX_TTL,
  TURN_MIN_TTL,
  allowedOrigin,
  createTurnGenerator,
  createTurnRateLimiter,
  parseTurnTtl,
  normalizeIceServers,
} from '../vercel-turn-broker/turn-core.js';

export {
  TURN_DEFAULT_TTL,
  TURN_MAX_TTL,
  TURN_MIN_TTL,
  normalizeIceServers,
  parseTurnTtl,
  readTurnConfig,
} from '../vercel-turn-broker/turn-core.js';

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
  const generator = createTurnGenerator(opts);
  const config = generator.config;
  const now = opts.now || Date.now;
  const limited = createTurnRateLimiter({ now, keyFn: opts.clientKey || ((req) => req.socket?.remoteAddress || '?') });

  function originFor(req) {
    return allowedOrigin(config, req.headers?.origin);
  }

  async function handle(req, res) {
    const origin = originFor(req);
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
    if (!limited(req)) {
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
      sendJson(res, 200, await generator.generate(ttl), origin);
    } catch {
      sendJson(res, 503, { error: 'turn_unavailable' }, origin);
    }
  }

  return { config, handle, generate: generator.generate };
}
