// mobile/node/wrapper.js — public HTTP/WS wrapper around the untouched upstream server.
//
// The upstream `startServer()` has no route/upgrade hooks, so the Android shell owns the public
// listener instead: the clean upstream runs on an ephemeral loopback port, and this wrapper adds
// the connect control plane, health compatibility fields, CSP frame guard, and a transparent
// HTTP/WS reverse proxy. Nothing under `server/` or `public/` is modified at runtime.
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../server/index.js';
import { isLocalHostHeader } from '../../server/http/hostGuard.js';
import { createRemoteRouter, createProxyState, createWsProxy, remoteHealth } from '../../server/http/remote.js';
import { portCandidates } from './ports.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

function clientIp(req) {
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

function upstreamHeaders(req) {
  const headers = { ...req.headers };
  const ip = clientIp(req);
  if (ip) headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${ip}` : ip;
  headers['x-forwarded-proto'] = 'http';
  return headers;
}

function withFrameGuard(headers) {
  const guard = "frame-src 'none'; object-src 'none'";
  const csp = headers['content-security-policy'];
  headers['content-security-policy'] = csp ? `${csp}; ${guard}` : guard;
  return headers;
}

function connectOnce(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function listenAvailable(create, host, preferred) {
  for (const port of portCandidates(preferred)) {
    const resource = create();
    try {
      await connectOnce(resource.server, host, port);
      return resource;
    } catch (error) {
      try { resource.server.close(); } catch { /* not listening */ }
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('Local ports 3000–3009 are occupied; close the conflicting application and retry.');
}

/**
 * Start the wrapped server. Returns `{ port, host, upstreamPort, server, upstream, close }`.
 * @param {{publicDir:string, dataDir:string, host?:string, port?:number}} options
 */
export async function startWrapper({ publicDir, dataDir, host = '127.0.0.1', port = 3000 } = {}) {
  const upstream = await startServer({ port: 0, host: '127.0.0.1', publicDir, dataDir, quiet: true });
  const upstreamPort = upstream.port;
  const proxy = createProxyState();
  const frames = remoteHealth(ROOT);
  let boundPort = port;
  const control = createRemoteRouter({
    host,
    getPort: () => boundPort,
    proxy,
    wsProxy: true,
    fingerprints: frames,
    recordsFile: path.join(process.env.HOME || ROOT, 'remote-records.json'),
  });
  const wsProxy = createWsProxy({ proxy, enabled: true });
  let publicServer = null;

  function proxyHttp(req, res) {
    const request = http.request({
      host: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers: upstreamHeaders(req),
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, withFrameGuard({ ...upstreamRes.headers }));
      upstreamRes.pipe(res);
    });
    request.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('upstream unavailable');
    });
    req.pipe(request);
  }

  function proxyHealth(req, res) {
    const request = http.request({
      host: '127.0.0.1', port: upstreamPort, path: '/healthz', method: 'GET', headers: upstreamHeaders(req),
    }, (upstreamRes) => {
      const chunks = [];
      upstreamRes.on('data', (chunk) => chunks.push(chunk));
      upstreamRes.on('end', () => {
        const status = upstreamRes.statusCode || 502;
        let body = Buffer.concat(chunks);
        const headers = withFrameGuard({ ...upstreamRes.headers });
        const encoded = !!headers['content-encoding'];
        if (status === 200 && !encoded) {
          try {
            const health = JSON.parse(body.toString('utf8'));
            health.protocol = health.protocol || frames.protocol;
            health.compat = health.compat || frames.compat;
            health.assets = health.assets || frames.assets;
            body = Buffer.from(JSON.stringify(health));
            headers['content-type'] = 'application/json; charset=utf-8';
            headers['content-length'] = String(body.length);
          } catch { /* forward the original body if it is not JSON */ }
        }
        res.writeHead(status, headers);
        res.end(body);
      });
    });
    request.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('upstream unavailable');
    });
    request.end();
  }

  async function handleHttp(req, res) {
    try {
      if (!isLocalHostHeader(req)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('forbidden host');
        return;
      }
      const url = new URL(req.url, 'http://local');
      if (await control(req, res, { rawPath: url.pathname, query: url.search.slice(1) })) return;
      if (url.pathname === '/healthz') { proxyHealth(req, res); return; }
      proxyHttp(req, res);
    } catch (error) {
      console.warn('[wrapper] request failed:', error?.message || error);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('wrapper error');
    }
  }

  function tunnel(req, socket, head) {
    const headers = upstreamHeaders(req);
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [name, value] of Object.entries(headers)) {
      if (value == null) continue;
      for (const item of Array.isArray(value) ? value : [value]) raw += `${name}: ${item}\r\n`;
    }
    raw += '\r\n';
    const target = net.connect(upstreamPort, '127.0.0.1', () => {
      target.write(raw);
      if (head?.length) target.write(head);
      socket.pipe(target);
      target.pipe(socket);
    });
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
    // A WebSocket close is a normal FIN, not an error: tear down the peer explicitly so a
    // closed game page cannot leave the internal upstream socket (and shutdown) hanging.
    socket.on('close', () => target.destroy());
    socket.on('end', () => target.destroy());
    target.on('close', () => socket.destroy());
    target.on('end', () => socket.end());
  }

  function handleUpgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, 'http://local'); } catch { socket.destroy(); return; }
    if (url.pathname === '/ws') { tunnel(req, socket, head); return; }
    if (url.pathname === '/sp-remote' || url.pathname === '/connect/ws') {
      if (!wsProxy.upgrade(req, socket, head)) socket.destroy();
      return;
    }
    socket.destroy();
  }

  try {
    const started = await listenAvailable(() => {
      const server = http.createServer((req, res) => { handleHttp(req, res); });
      server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head));
      return { server };
    }, host, port);
    publicServer = started.server;
    boundPort = publicServer.address().port;
  } catch (error) {
    try { await upstream.close(); } catch { /* already failing */ }
    throw error;
  }

  return {
    port: boundPort,
    host,
    upstreamPort,
    server: publicServer,
    upstream,
    async close() {
      try { wsProxy.close(); } catch { /* no upgrade server */ }
      proxy.clear();
      if (publicServer) {
        if (typeof publicServer.closeAllConnections === 'function') publicServer.closeAllConnections();
        await new Promise((resolve) => publicServer.close(() => resolve()));
      }
      try { await upstream.close(); } catch { /* already closed */ }
    },
  };
}
