import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';

test('remote probe distinguishes a client entry page, browser verification and an unrelated page without visiting rejected targets', async (t) => {
  const service = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  const originalFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = originalFetch; await service.close(); });
  const visited = [];
  let response = () => new Response('ordinary page', { status: 200 });
  globalThis.fetch = async (address, options) => {
    const url = new URL(address);
    if (url.hostname === 'fixture.test') { visited.push(url.toString()); return response(url); }
    return originalFetch(address, options);
  };
  const probe = async (url) => (await originalFetch(`${service.url}/connect/probe?url=${encodeURIComponent(url)}`)).json();

  assert.equal((await probe('Doctor')).reason, 'invalid-url');
  assert.equal(visited.length, 0);
  assert.equal((await probe('http://fixture.test/')).valid, false);
  response = () => new Response('<h1>501 Not Implemented</h1><p>Automatic HTTPS enabled. HTTP is invalid; redirecting to HTTPS.</p>', { status: 501 });
  const httpsUpgrade = await probe('http://fixture.test/');
  assert.equal(httpsUpgrade.blocked, true);
  assert.equal(httpsUpgrade.reason, 'https-required');
  assert.equal(httpsUpgrade.candidateUrl, 'https://fixture.test/');
  response = (url) => url.pathname === '/healthz' ? new Response('unavailable', { status: 404 })
    : new Response('<title>STRONGHOLD PROTOCOL</title><script type="module" src="/js/main.js"></script>');
  assert.equal((await probe('http://fixture.test/')).valid, true);
  response = () => new Response('', { status: 302, headers: { location: 'http://localhost:3000/' } });
  const count = visited.length;
  assert.equal((await probe('http://fixture.test/')).reason, 'local-or-invalid-redirect');
  assert.equal(visited.length, count + 1);
});
