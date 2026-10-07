// Vercel Node Function: short-lived Cloudflare TURN credential broker.
// Long-lived Cloudflare credentials are read only from Vercel environment variables.

import {
  TURN_DEFAULT_TTL,
  TURN_MAX_TTL,
  TURN_MIN_TTL,
  allowedOrigin,
  createTurnGenerator,
  createTurnRateLimiter,
  parseTurnTtl,
} from '../../turn-core.js';

function header(req, name) {
  const value = req.headers?.[name.toLowerCase()] ?? req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function requestKey(req) {
  if (req.ip) return req.ip;
  const realIp = header(req, 'x-real-ip');
  if (typeof realIp === 'string' && realIp) return realIp;
  const forwarded = header(req, 'x-forwarded-for');
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',').at(-1).trim();
  return req.socket?.remoteAddress || '?';
}

function sendJson(res, status, value, origin = null, extra = {}) {
  const body = JSON.stringify(value);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
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

export function createVercelHandler(opts = {}) {
  const generator = createTurnGenerator(opts);
  const config = generator.config;
  const now = opts.now || Date.now;
  const limited = createTurnRateLimiter({ now, keyFn: requestKey });

  return async function vercelTurnHandler(req, res) {
    const origin = allowedOrigin(config, header(req, 'origin'));
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
      const url = new URL(req.url || '/', 'https://vercel.invalid');
      const raw = url.searchParams.get('ttl');
      if (raw !== null) ttl = parseTurnTtl(raw);
    } catch {
      ttl = null;
    }
    if (ttl === null) {
      sendJson(res, 400, { error: 'invalid_ttl', min: TURN_MIN_TTL, max: TURN_MAX_TTL }, origin);
      return;
    }
    try {
      sendJson(res, 200, await generator.generate(ttl), origin);
    } catch {
      sendJson(res, 503, { error: 'turn_unavailable' }, origin);
    }
  };
}

export default createVercelHandler();
