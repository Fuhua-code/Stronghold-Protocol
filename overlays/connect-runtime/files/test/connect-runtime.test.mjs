import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startWrapper } from '../mobile/node/wrapper.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function get(port, pathname, { origin = true, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1', port, path: pathname,
      headers: { host: `127.0.0.1:${port}`, ...(origin ? { origin: `http://127.0.0.1:${port}` } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
  });
}

test('runtime profile: wrapper serves the pristine upstream, injected extension and connect control plane', async () => {
  const routes = fs.readFileSync(path.join(ROOT, 'server/http/routes.js'), 'utf8');
  assert.ok(!routes.includes('handleRemote'), 'runtime staging must not mount the control router in upstream routes');
  assert.ok(fs.existsSync(path.join(ROOT, 'server/http/remote.js')), 'control router is staged as an auxiliary file');
  assert.ok(fs.existsSync(path.join(ROOT, 'public/sp-extension/boot.js')), 'boot bridge is injected');
  const title = fs.readFileSync(path.join(ROOT, 'public/js/screens/title.js'), 'utf8');
  assert.ok(title.includes('RemoteEntry') && title.includes('RemoteGuideButton'), '300115 title design is frozen in place');
  assert.ok(fs.readFileSync(path.join(ROOT, 'public/js/ui/guide.js'), 'utf8').includes('RemoteGuideButton'));
  assert.ok(fs.readFileSync(path.join(ROOT, 'public/css/screens/title.css'), 'utf8').includes('.title-main'));
  assert.ok(!fs.readFileSync(path.join(ROOT, 'public/sp-extension/ui.js'), 'utf8').includes('addTitleButton'));
  assert.ok(!fs.readFileSync(path.join(ROOT, 'public/sp-extension/connect.css'), 'utf8').includes('.spx-fab'));

  const server = await startWrapper({ publicDir: path.join(ROOT, 'public'), dataDir: path.join(ROOT, 'data'), host: '127.0.0.1', port: 0 });
  try {
    const health = await get(server.port, '/healthz', { origin: false });
    assert.equal(health.status, 200);
    const parsed = JSON.parse(health.body);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.compat && parsed.protocol, 'wrapper adds protocol/compat to /healthz');
    assert.ok(parsed.assets, 'wrapper adds the assets fingerprint');

    const page = await get(server.port, '/', { origin: false });
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('/sp-extension/boot.js'), 'staged index references the boot bridge');
    assert.ok(page.body.includes('/css/connect.css'), 'staged index loads the frozen remote-entry stylesheet');

    const titleScript = await get(server.port, '/js/screens/title.js', { origin: false });
    assert.equal(titleScript.status, 200);
    assert.ok(titleScript.body.includes('RemoteEntry'));
    const titleCss = await get(server.port, '/css/screens/title.css', { origin: false });
    assert.equal(titleCss.status, 200);
    assert.ok(titleCss.body.includes('.title-main'));

    const boot = await get(server.port, '/sp-extension/boot.js', { origin: false });
    assert.equal(boot.status, 200);
    assert.ok(boot.body.includes('__spExtensionBoot'));

    const ui = await get(server.port, '/sp-extension/ui.js', { origin: false });
    assert.equal(ui.status, 200);
    assert.ok(ui.body.includes('features.json'), 'fallback UI reads the build feature report');
    const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/sp-extension/features.json'), 'utf8'));
    assert.equal(report.mode, 'packs');
    assert.ok(Array.isArray(report.features) && report.features.length >= 1);
    assert.ok(Array.isArray(report.degraded));
    assert.equal(report.features.find((feature) => feature.id === 'title-ui')?.status, 'applied');

    const info = await get(server.port, '/connect/info');
    assert.equal(info.status, 200);
    assert.ok(JSON.parse(info.body).token);
    const token = await get(server.port, '/connect/token');
    assert.equal(token.status, 200);
    assert.ok(JSON.parse(token.body).token);
    const records = await get(server.port, '/connect/records');
    assert.equal(records.status, 403, 'records route is token guarded');

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { origin: `http://127.0.0.1:${server.port}` } });
    socket.on('error', () => {});
    await once(socket, 'open');
    socket.terminate();
  } finally {
    await server.close();
  }
});
