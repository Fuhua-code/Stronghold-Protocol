import test from 'node:test';
import assert from 'node:assert/strict';
import { createVercelHandler } from '../api/turn/credentials.js';
import { createHealthHandler } from '../api/turn/healthz.js';

const ORIGIN = 'https://fuhua-code.github.io';
const env = { CLOUDFLARE_TURN_API_TOKEN: 'private-api-token', CLOUDFLARE_TURN_KEY_ID: 'private-key-id' };
const payload = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    { urls: ['turn:turn.cloudflare.com:443?transport=tcp'], username: 'temporary-user', credential: 'temporary-credential' },
  ],
};

function fakeRequest({ method = 'GET', url = '/api/turn/credentials', origin = ORIGIN, ip = '203.0.113.4' } = {}) {
  const result = {};
  const req = { method, url, ip, headers: origin ? { origin } : {} };
  const res = {
    writeHead(status, headers) { result.status = status; result.headers = headers; },
    end(body) { result.body = body ? JSON.parse(body) : null; },
  };
  return { req, res, result };
}

test('Vercel TURN handler returns validated short-lived credentials and no-store headers', async () => {
  const calls = [];
  const handler = createVercelHandler({ env, now: () => 1_000_000, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(payload), { status: 201 });
  } });
  const { req, res, result } = fakeRequest({ url: '/api/turn/credentials?ttl=900' });
  await handler(req, res);
  assert.equal(result.status, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers['Access-Control-Allow-Origin'], ORIGIN);
  assert.deepEqual(Object.keys(result.body).sort(), ['expiresAt', 'iceServers']);
  assert.equal(result.body.expiresAt, 1_900_000);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /private-key-id\/credentials\/generate-ice-servers$/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer private-api-token');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.body, JSON.stringify({ ttl: 900 }));
});

test('Vercel TURN handler enforces CORS, method, TTL, and per-instance rate limits', async () => {
  const handler = createVercelHandler({ env, fetchImpl: async () => new Response(JSON.stringify(payload), { status: 201 }) });
  const badOrigin = fakeRequest({ origin: 'https://evil.example' });
  await handler(badOrigin.req, badOrigin.res);
  assert.equal(badOrigin.result.status, 403);
  assert.deepEqual(badOrigin.result.body, { error: 'origin_not_allowed' });

  const preflight = fakeRequest({ method: 'OPTIONS' });
  await handler(preflight.req, preflight.res);
  assert.equal(preflight.result.status, 204);
  assert.equal(preflight.result.headers['Access-Control-Allow-Methods'], 'GET, OPTIONS');

  const previewHandler = createVercelHandler({
    env: { ...env, TURN_ALLOWED_ORIGINS: `${ORIGIN},https://preview.example` },
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 201 }),
  });
  const preview = fakeRequest({ origin: 'https://preview.example' });
  await previewHandler(preview.req, preview.res);
  assert.equal(preview.result.status, 200);
  assert.equal(preview.result.headers['Access-Control-Allow-Origin'], 'https://preview.example');

  const badMethod = fakeRequest({ method: 'POST' });
  await handler(badMethod.req, badMethod.res);
  assert.equal(badMethod.result.status, 405);

  for (const ttl of ['299', '1801', 'nope']) {
    const invalid = fakeRequest({ url: `/api/turn/credentials?ttl=${ttl}` });
    await handler(invalid.req, invalid.res);
    assert.equal(invalid.result.status, 400);
    assert.deepEqual(invalid.result.body, { error: 'invalid_ttl', min: 300, max: 1800 });
  }

  const limited = createVercelHandler({ env, fetchImpl: async () => new Response(JSON.stringify(payload), { status: 201 }) });
  let last;
  for (let i = 0; i < 31; i++) {
    const item = fakeRequest();
    await limited(item.req, item.res);
    last = item.result;
  }
  assert.equal(last.status, 429);
  assert.deepEqual(last.body, { error: 'rate_limited' });
});

test('Vercel TURN handler fails closed for missing config, TLS errors, malformed data, and hidden upstream errors', async () => {
  const cases = [
    createVercelHandler({ env: {}, fetchImpl: async () => { throw new Error('must not call'); } }),
    createVercelHandler({ env, fetchImpl: async () => { throw new Error('private-api-token private-key-id temporary-credential'); } }),
    createVercelHandler({ env, fetchImpl: async () => new Response('not json', { status: 503 }) }),
    createVercelHandler({ env, fetchImpl: async () => new Response(JSON.stringify({ iceServers: [{ urls: ['stun:only.example'] }] }), { status: 201 }) }),
  ];
  for (const handler of cases) {
    const item = fakeRequest();
    await handler(item.req, item.res);
    assert.equal(item.result.status, 503);
    assert.deepEqual(item.result.body, { error: 'turn_unavailable' });
    assert.doesNotMatch(JSON.stringify(item.result), /private-api-token|private-key-id|temporary-credential/);
  }
});

test('Vercel TURN handler aborts a stalled Cloudflare request and returns a generic failure', async () => {
  const handler = createVercelHandler({
    env,
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
    }),
  });
  const item = fakeRequest();
  await handler(item.req, item.res);
  assert.equal(item.result.status, 503);
  assert.deepEqual(item.result.body, { error: 'turn_unavailable' });
});

test('Vercel health endpoint reports configuration state without key material', () => {
  const handler = createHealthHandler(env);
  const item = fakeRequest({ url: '/api/turn/healthz' });
  handler(item.req, item.res);
  assert.equal(item.result.status, 200);
  assert.deepEqual(item.result.body, {
    ok: true,
    provider: 'cloudflare',
    configured: true,
    defaultTtl: 600,
    minTtl: 300,
    maxTtl: 1800,
  });
  assert.doesNotMatch(JSON.stringify(item.result), /private-api-token|private-key-id/);
});
