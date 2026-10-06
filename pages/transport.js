import { Peer } from 'peerjs';
import config from '#pages-config';
import { WIRE, sameBuild, peerId } from './compat.js';

const CONNECT_MS = 12000;
const MAX_BUFFER = 16 * 1024 * 1024;
const metadata = { wire: WIRE, app: config.app, protocol: config.protocol, compat: config.compat };
const ice = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
const runtime = { mode: 'local', code: null, worker: null, ports: new Map(), host: null, peerFactory: (id) => new Peer(id, { secure: true, config: ice }) };
let net, identity, sequence = 0;

function createCore() {
  if (runtime.ready) return runtime.ready;
  const worker = new Worker(new URL('pages-worker.js', config.baseUrl), { type: 'module' });
  runtime.worker = worker;
  runtime.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('游戏核心加载超时，请刷新页面')), 30000);
    worker.onerror = (event) => { clearTimeout(timer); reject(new Error(event.message || '游戏核心启动失败')); };
    worker.onmessage = ({ data: message }) => {
      if (message.kind === 'ready') { clearTimeout(timer); resolve(); return; }
      if (message.kind === 'failure') { console.error('[pages core]', message.message); clearTimeout(timer); reject(new Error(message.message)); return; }
      const port = runtime.ports.get(message.id);
      if (!port) return;
      if (message.kind === 'frame') port.deliver(message.data);
      else if (message.kind === 'ping') port.ping();
      else if (message.kind === 'close') { runtime.ports.delete(message.id); port.finish(message.code, message.reason); }
    };
    worker.postMessage({ kind: 'init', base: config.baseUrl });
  });
  return runtime.ready;
}
function core(kind, id, extra = {}) { runtime.worker.postMessage({ kind, id, ...extra }); }
function waitPeer(id) {
  return new Promise((resolve, reject) => {
    const peer = runtime.peerFactory(id);
    const timer = setTimeout(() => fail(new Error('联机信令连接超时；单人游玩仍可使用')), CONNECT_MS);
    const fail = (error) => { clearTimeout(timer); peer.destroy(); reject(error); };
    peer.once('error', fail);
    peer.once('open', () => {
      clearTimeout(timer); peer.off('error', fail);
      peer.on('error', (error) => console.warn('[pages peer]', error.type));
      peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
      resolve(peer);
    });
  });
}
function channelSend(connection, message) {
  const queued = connection.dataChannel?.bufferedAmount || 0;
  if (queued > MAX_BUFFER) { connection.close(); throw new Error('联机消息队列过大'); }
  connection.send(message);
}
function acceptGuest(connection) {
  if (runtime.ports.size >= 12 || !sameBuild(metadata, connection.metadata)) {
    connection.on('open', () => { connection.send({ kind: 'reject', reason: '版本不兼容或同盟连接已满，请刷新页面后重试' }); setTimeout(() => connection.close(), 100); });
    return;
  }
  const id = `guest-${++sequence}`;
  let admitted = false;
  const timer = setTimeout(() => connection.close(), CONNECT_MS);
  connection.on('data', (message) => {
    if (!admitted) {
      if (message?.kind !== 'offer' || !sameBuild(metadata, message.build)) {
        connection.send({ kind: 'reject', reason: '游戏版本不兼容，请刷新页面' }); connection.close(); return;
      }
      clearTimeout(timer); admitted = true;
      runtime.ports.set(id, {
        deliver: (data) => channelSend(connection, { kind: 'frame', data }),
        ping: () => channelSend(connection, { kind: 'ping' }),
        finish: (code, reason) => { if (connection.open) connection.send({ kind: 'close', code, reason }); connection.close(); },
      });
      connection.send({ kind: 'accepted', build: metadata }); core('open', id);
      return;
    }
    if (message?.kind === 'frame') core('frame', id, { data: message.data });
    else if (message?.kind === 'pong') core('pong', id);
    else if (message?.kind === 'close') core('close', id, message);
  });
  connection.on('close', () => { clearTimeout(timer); if (admitted) core('close', id); });
  connection.on('error', () => connection.close());
}
async function publishRoom() {
  runtime.host?.destroy(); runtime.host = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const code = Array.from(crypto.getRandomValues(new Uint8Array(4)), (v) => alphabet[v % alphabet.length]).join('');
    try {
      const host = await waitPeer(peerId(code));
      host.on('connection', acceptGuest);
      runtime.host = host; runtime.code = code;
      core('reserve', undefined, { code });
      return;
    } catch (error) {
      if (error.type !== 'unavailable-id') throw new Error('无法连接公共联机信令；请检查网络或选择独立模拟');
    }
  }
  throw new Error('同盟密钥暂时不可用，请重试');
}

/** The existing Net client uses this WebSocket-shaped local/PeerJS adapter unchanged. */
export class PagesSocket {
  readyState = 0;
  bufferedAmount = 0;
  constructor() {
    this.id = `local-${++sequence}`;
    queueMicrotask(() => this.open().catch((error) => this.fail(error)));
  }
  async open() {
    await createCore();
    if (this.readyState === 3) return;
    if (runtime.mode === 'local') {
      runtime.ports.set(this.id, { deliver: (data) => this.message(data), ping: () => core('pong', this.id), finish: (code, reason) => this.finish(code, reason) });
      core('open', this.id); this.opened(); return;
    }
    const targetCode = runtime.code;
    const peer = await waitPeer();
    this.peer = peer;
    if (this.readyState === 3) { peer.destroy(); return; }
    const connection = peer.connect(peerId(targetCode), { reliable: true, serialization: 'json', metadata });
    this.channel = connection;
    this.timer = setTimeout(() => this.fail(new Error('未能连接房主；请确认密钥和网络，房主需保持页面开启')), CONNECT_MS);
    connection.on('open', () => channelSend(connection, { kind: 'offer', build: metadata }));
    connection.on('data', (message) => {
      if (message?.kind === 'accepted') {
        if (!sameBuild(metadata, message.build)) { this.fail(new Error('房主版本不兼容，请刷新页面')); return; }
        clearTimeout(this.timer); this.opened();
      }
      else if (message?.kind === 'reject') this.fail(new Error(message.reason));
      else if (message?.kind === 'frame' && this.readyState === 1 && typeof message.data === 'string') this.message(message.data);
      else if (message?.kind === 'ping') channelSend(connection, { kind: 'pong' });
      else if (message?.kind === 'close') this.finish(message.code, message.reason);
    });
    connection.on('close', () => this.finish(1006, '房主连接中断'));
    connection.on('error', (error) => this.fail(error));
  }
  opened() { if (this.readyState === 3) return; this.readyState = 1; this.onopen?.({}); }
  message(data) { this.onmessage?.({ data }); }
  send(data) {
    if (this.readyState !== 1) throw new Error('Connection is not open');
    if (this.channel) channelSend(this.channel, { kind: 'frame', data });
    else core('frame', this.id, { data });
  }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    if (this.channel?.open) channelSend(this.channel, { kind: 'close', code, reason });
    else if (runtime.ports.has(this.id)) core('close', this.id, { code, reason });
    this.finish(code, reason);
  }
  fail(error) {
    this.failure = error;
    this.onerror?.(error);
    if (runtime.mode === 'remote' && this.readyState === 0) {
      this.message(JSON.stringify({ t: 'room.closed', reason: 'shutdown' }));
      runtime.mode = 'local'; runtime.code = null; identity.clearToken();
    }
    this.finish(1006, error.message || '联机连接失败');
  }
  finish(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3; clearTimeout(this.timer);
    runtime.ports.delete(this.id);
    this.channel?.close(); this.peer?.destroy();
    this.onclose?.({ code, reason });
  }
}
function waitOnline() {
  if (net.status === 'online') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('连接超时，请确认房主在线、密钥正确且网络允许 WebRTC 连接')); }, CONNECT_MS * 2 + 1000);
    const off = net.on('status', (state) => { if (state.status === 'online') { clearTimeout(timer); off(); resolve(); } });
  });
}
async function select(mode, code = null) {
  net.close();
  runtime.host?.destroy(); runtime.host = null;
  runtime.mode = mode; runtime.code = code;
  identity.clearToken(); net.url = 'pages:local'; net.connect();
  await waitOnline();
  if (runtime.mode !== mode) throw new Error('无法加入同盟，请核对密钥和网络');
}
export function installPages(client, persistence) {
  net = client; identity = persistence;
  net.WS = PagesSocket; net.url = 'pages:local';
  const request = net.request.bind(net);
  net.request = async (type, fields = {}) => {
    if (type === 'room.create') {
      if (runtime.mode !== 'local') await select('local');
      if (fields.mode !== 'solo') await publishRoom();
      else { runtime.host?.destroy(); runtime.host = null; runtime.code = null; }
    } else if (type === 'room.join' || type === 'room.spectate') {
      const code = String(fields.code || '').toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(code)) throw new Error('同盟密钥应为四位字母或数字');
      if (code !== runtime.code) await select('remote', code);
    }
    const result = await request(type, fields);
    if (type === 'room.leave' || type === 'g.leave') {
      if (runtime.mode === 'remote') await select('local');
      else { runtime.host?.destroy(); runtime.host = null; runtime.code = null; }
    }
    return result;
  };
  addEventListener('pagehide', () => runtime.host?.destroy());
  // Exposed like __SP__: permits deployment diagnostics and deterministic local signaling tests.
  globalThis.__SP_PAGES__ = { runtime, metadata, sameBuild, Peer };
}
