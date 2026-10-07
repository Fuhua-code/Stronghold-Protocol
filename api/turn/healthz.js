// Vercel Node Function: non-secret deployment health check for the TURN broker.

import { readTurnConfig, TURN_DEFAULT_TTL, TURN_MAX_TTL, TURN_MIN_TTL } from '../../server/turn-core.js';

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

export function createHealthHandler(env = process.env) {
  const config = readTurnConfig(env);
  return function healthHandler(req, res) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      provider: 'cloudflare',
      configured: config.enabled,
      defaultTtl: TURN_DEFAULT_TTL,
      minTtl: TURN_MIN_TTL,
      maxTtl: TURN_MAX_TTL,
    });
  };
}

export default createHealthHandler();
