import { Peer } from 'peerjs';
import config from '#pages-config';
import { WIRE, sameBuild, peerId } from './compat.js';
import { PEER_CONFIG, peerFailureMessage, summarizeIceStats } from './peer-config.js';

const SIGNAL_TIMEOUT_MS = 12000;
const DIRECT_TIMEOUT_MS = 30000;
const SELECT_TIMEOUT_MS = SIGNAL_TIMEOUT_MS + DIRECT_TIMEOUT_MS + 1000;
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_DIAGNOSTICS = 100;
const metadata = { wire: WIRE, app: config.app, protocol: config.protocol, compat: config.compat };
// Use independent STUN providers so a single blocked UDP endpoint does not make a room unreachable.
// Pages remains relay-free: a network that cannot form a direct WebRTC candidate still needs TURN.
const runtime = { mode: 'local', code: null, worker: null, ports: new Map(), host: null, failure: null, diagnostics: [], peerFactory: (id) => new Peer(id, { secure: true, config: PEER_CONFIG }) };
let net, identity, sequence = 0;

function recordDiagnostic(role, event, details = {}) {
  const entry = { at: new Date().toISOString(), role, event, ...details };
  runtime.diagnostics.push(entry);
  if (runtime.diagnostics.length > MAX_DIAGNOSTICS) runtime.diagnostics.splice(0, runtime.diagnostics.length - MAX_DIAGNOSTICS);
  console.info('[pages peer]', role, event, details);
  return entry;
}

function snapshotConnection(connection, role) {
  const pc = connection?.peerConnection;
  if (!pc) {
    const summary = { dataChannelOpen: !!connection?.open, localCandidateTypes: [], remoteCandidateTypes: [], pairs: [], remoteDescription: false };
    recordDiagnostic(role, 'peer-connection-unavailable', summary);
    return Promise.resolve(summary);
  }
  const state = {
    iceGatheringState: pc.iceGatheringState,
    iceConnectionState: pc.iceConnectionState,
    connectionState: pc.connectionState,
    remoteDescription: !!pc.remoteDescription,
  };
  let timer;
  const stats = Promise.race([
    Promise.resolve().then(() => pc.getStats()),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('ICE stats timeout')), 1500); }),
  ]);
  return stats.then((report) => {
    const summary = { ...state, ...summarizeIceStats(report) };
    recordDiagnostic(role, 'ice-summary', summary);
    return summary;
  }).catch(() => ({ ...state, localCandidateTypes: [], remoteCandidateTypes: [], pairs: [] })).finally(() => clearTimeout(timer));
}

function watchDataConnection(connection, role) {
  recordDiagnostic(role, 'data-connection-created', { peerAvailable: !!connection.peer });
  connection.on('open', () => recordDiagnostic(role, 'data-channel-open'));
  connection.on('close', () => {
    recordDiagnostic(role, 'data-channel-close');
    void snapshotConnection(connection, role);
  });
  connection.on('error', (error) => recordDiagnostic(role, 'connection-error', {
    type: error?.type || null,
  }));

  let attached = null;
  const attach = () => {
    const pc = connection.peerConnection;
    if (!pc || pc === attached) return;
    attached = pc;
    pc.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate) recordDiagnostic(role, 'ice-candidate', { type: candidate.type, protocol: candidate.protocol });
      else recordDiagnostic(role, 'ice-gathering-complete');
    });
    pc.addEventListener('icecandidateerror', (event) => recordDiagnostic(role, 'ice-candidate-error', {
      url: event.url || null,
      errorCode: event.errorCode || null,
      errorText: String(event.errorText || '').slice(0, 160),
    }));
    for (const [event, state] of [
      ['icegatheringstatechange', () => pc.iceGatheringState],
      ['iceconnectionstatechange', () => pc.iceConnectionState],
      ['connectionstatechange', () => pc.connectionState],
      ['signalingstatechange', () => pc.signalingState],
    ]) pc.addEventListener(event, () => {
      const value = state();
      recordDiagnostic(role, event, { state: value });
      if (value === 'failed' || value === 'closed') void snapshotConnection(connection, role);
    });
    recordDiagnostic(role, 'peer-connection-created');
  };
  const poll = setInterval(attach, 100);
  const stop = setTimeout(() => clearInterval(poll), DIRECT_TIMEOUT_MS);
  connection.on('open', () => { clearInterval(poll); clearTimeout(stop); attach(); });
  connection.on('close', () => { clearInterval(poll); clearTimeout(stop); attach(); });
}

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
    recordDiagnostic('peer', 'signal-connecting');
    const timer = setTimeout(() => fail(Object.assign(new Error('联机信令连接超时；单人游玩仍可使用'), { type: 'network' })), SIGNAL_TIMEOUT_MS);
    const fail = (error) => {
      clearTimeout(timer);
      recordDiagnostic('peer', 'signal-error', { type: error?.type || null });
      peer.destroy(); reject(error);
    };
    peer.once('error', fail);
    peer.once('open', () => {
      clearTimeout(timer); peer.off('error', fail);
      recordDiagnostic('peer', 'signal-open');
      peer.on('error', (error) => recordDiagnostic('peer', 'signal-error', { type: error?.type || null }));
      peer.on('disconnected', () => {
        recordDiagnostic('peer', 'signal-disconnected');
        if (!peer.destroyed) peer.reconnect();
      });
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
  watchDataConnection(connection, 'host');
  if (runtime.ports.size >= 12 || !sameBuild(metadata, connection.metadata)) {
    connection.on('open', () => { connection.send({ kind: 'reject', reason: '版本不兼容或同盟连接已满，请刷新页面后重试' }); setTimeout(() => connection.close(), 100); });
    return;
  }
  const id = `guest-${++sequence}`;
  let admitted = false;
  const timer = setTimeout(() => connection.close(), SELECT_TIMEOUT_MS);
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
  connection.on('error', (error) => {
    recordDiagnostic('host', 'guest-error', { type: error?.type || null });
    connection.close();
  });
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
    peer.on('error', (error) => {
      recordDiagnostic('guest', 'peer-error', { type: error?.type || null });
      if (this.readyState === 0) this.fail(error);
    });
    const connection = peer.connect(peerId(targetCode), { reliable: true, serialization: 'json', metadata });
    this.channel = connection;
    watchDataConnection(connection, 'guest');
    this.timer = setTimeout(() => this.fail(Object.assign(new Error('WebRTC 直连等待超时'), { type: 'webrtc-timeout' })), DIRECT_TIMEOUT_MS);
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
    connection.on('close', () => {
      if (this.readyState !== 3) this.fail(Object.assign(new Error('WebRTC 数据通道已关闭'), { type: 'webrtc' }));
    });
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
  async fail(error) {
    if (this.readyState === 3 || this.failing) return;
    this.failing = true;
    this.failure = error;
    const remoteAttempt = runtime.mode === 'remote' && this.readyState === 0;
    if (remoteAttempt) {
      runtime.failure = new Error(peerFailureMessage(error));
      runtime.mode = 'local'; runtime.code = null; identity.clearToken();
    }
    const diagnostics = this.channel ? await snapshotConnection(this.channel, 'guest') : {};
    const message = peerFailureMessage(error, diagnostics);
    if (remoteAttempt && runtime.failure) runtime.failure.message = message;
    this.onerror?.(error);
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
    const timer = setTimeout(() => { off(); reject(new Error('连接超时；请确认房主在线且网络允许 WebRTC 直连')); }, SELECT_TIMEOUT_MS);
    const off = net.on('status', (state) => {
      if (runtime.failure) { clearTimeout(timer); off(); reject(runtime.failure); }
      else if (state.status === 'online') { clearTimeout(timer); off(); resolve(); }
    });
  });
}
async function select(mode, code = null) {
  net.close();
  runtime.host?.destroy(); runtime.host = null;
  runtime.failure = null;
  runtime.mode = mode; runtime.code = code;
  identity.clearToken(); net.url = 'pages:local'; net.connect();
  await waitOnline();
  if (runtime.failure) {
    const failure = runtime.failure;
    runtime.failure = null;
    throw failure;
  }
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
