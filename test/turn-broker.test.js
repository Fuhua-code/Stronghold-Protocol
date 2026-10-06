import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnBroker, normalizeIceServers, parseTurnTtl, readTurnConfig } from '../server/turn.js';
import { startServer } from '../server/index.js';

const ORIGIN = 'https://fuhua-code.github.io';
const env = { Cloudflare_Turn_API: 'api-token-for-test', Turn_Token: 'turn-key-for-test' };
const payload = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    { urls: ['turn:turn.cloudflare.com:443?transport=tcp'], username: 'temporary-user', credential: 'temporary-credential' },
  ],
};

function fakeResponse() {
  const result = {};
  return { result, req: { method: 'GET', url: '/turn/credentials?ttl=600', headers: { origin: ORIGIN }, socket: { remoteAddress: '203.0.113.4' } },
    res: { writeHead(status, headers) { result.status = status; result.headers = headers; }, end(body) { result.body = body ? JSON.parse(body.toString()) : null; } } };
}

test('Cloudflare TURN configuration uses the existing Windows variable names without exposing values', () => {
  const cfg = readTurnConfig(env);
  assert.equal(cfg.enabled, true);
  assert.deepEqual([...cfg.origins], [ORIGIN]);
  assert.equal(parseTurnTtl('300'), 300);
  assert.equal(parseTurnTtl('1800'), 1800);
  assert.equal(parseTurnTtl('299'), null);
  assert.equal(parseTurnTtl('1801'), null);
  assert.equal(parseTurnTtl('600abc'), null);
  assert.equal(parseTurnTtl('600.5'), null);
  assert.equal(normalizeIceServers(payload.iceServers).length, 2);
  assert.equal(normalizeIceServers([{ urls: ['stun:stun.cloudflare.com:3478'] }]), null);
});

test('TURN broker requests Cloudflare credentials and returns only a short-lived response', async () => {
  const calls = [];
  const broker = createTurnBroker({ env, now: () => 1_000_000, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(payload), { status: 201, headers: { 'content-type': 'application/json' } });
  } });
  const { result, req, res } = fakeResponse();
  await broker.handle(req, res);
  assert.equal(result.status, 200);
  assert.equal(result.body.iceServers[1].username, 'temporary-user');
  assert.equal(result.body.expiresAt, 1_600_000);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /credentials\/generate-ice-servers$/);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer api-token-for-test');
  assert.equal(calls[0].options.body, JSON.stringify({ ttl: 600 }));
});

test('TURN broker enforces origin, method, and rate limits without leaking upstream errors', async () => {
  const broker = createTurnBroker({ env, fetchImpl: async () => { throw new Error('secret upstream response'); } });
  const bad = fakeResponse();
  bad.req.headers.origin = 'https://evil.example';
  await broker.handle(bad.req, bad.res);
  assert.equal(bad.result.status, 403);
  assert.equal(bad.result.body.error, 'origin_not_allowed');

  const method = fakeResponse();
  method.req.method = 'POST';
  await broker.handle(method.req, method.res);
  assert.equal(method.result.status, 405);

  const failed = fakeResponse();
  await broker.handle(failed.req, failed.res);
  assert.equal(failed.result.status, 503);
  assert.deepEqual(failed.result.body, { error: 'turn_unavailable' });
  assert.equal(JSON.stringify(failed.result.body).includes('secret'), false);

  const limited = createTurnBroker({ env, fetchImpl: async () => new Response(JSON.stringify(payload), { status: 201 }) });
  let last;
  for (let i = 0; i < 31; i++) {
    const item = fakeResponse();
    await limited.handle(item.req, item.res);
    last = item.result;
  }
  assert.equal(last.status, 429);
});

test('TURN broker handles missing configuration, malformed upstream data, and CORS preflight', async () => {
  const missing = createTurnBroker({ env: {}, fetchImpl: async () => { throw new Error('must not call upstream'); } });
  const unavailable = fakeResponse();
  await missing.handle(unavailable.req, unavailable.res);
  assert.equal(unavailable.result.status, 503);
  assert.deepEqual(unavailable.result.body, { error: 'turn_unavailable' });

  const malformed = createTurnBroker({ env, fetchImpl: async () => new Response(JSON.stringify({ iceServers: [{ urls: ['stun:only.example'] }] }), { status: 201 }) });
  const invalid = fakeResponse();
  await malformed.handle(invalid.req, invalid.res);
  assert.equal(invalid.result.status, 503);
  assert.deepEqual(invalid.result.body, { error: 'turn_unavailable' });

  const preflight = fakeResponse();
  preflight.req.method = 'OPTIONS';
  await malformed.handle(preflight.req, preflight.res);
  assert.equal(preflight.result.status, 204);
  assert.equal(preflight.result.headers['Access-Control-Allow-Origin'], ORIGIN);
});

test('Node server exposes the broker while preserving health and static routes', async () => {
  const srv = await startServer({
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    turnEnv: env,
    turnFetch: async () => new Response(JSON.stringify(payload), { status: 201 }),
  });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const turn = await fetch(`${base}/turn/credentials?ttl=300`, { headers: { Origin: ORIGIN } });
    assert.equal(turn.status, 200);
    assert.equal((await turn.json()).iceServers.length, 2);
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
  } finally {
    await srv.close();
  }
});
