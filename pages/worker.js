import { Network, SessionRegistry } from '../server/net.js';
import { Lobby } from '../server/lobby.js';
import { setSimData } from '../server/sim/simdata.js';
import { setData } from './adapters/data.js';
import config from '#pages-config';

globalThis.setImmediate = (fn, ...args) => setTimeout(fn, 0, ...args);
const ports = new Map();
let network, lobby, reservedCode;
class WorkerSocket {
  readyState = 1;
  bufferedAmount = 0;
  listeners = new Map();
  constructor(id) { this.id = id; }
  on(type, fn) {
    const list = this.listeners.get(type) || [];
    list.push(fn); this.listeners.set(type, list);
  }
  emit(type, ...args) { for (const fn of this.listeners.get(type) || []) fn(...args); }
  send(data, done) { postMessage({ kind: 'frame', id: this.id, data }); done?.(); }
  ping() { postMessage({ kind: 'ping', id: this.id }); }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close'); ports.delete(this.id);
    postMessage({ kind: 'close', id: this.id, code, reason });
  }
  terminate() { this.close(1006, 'connection closed'); }
}
async function init(base) {
  const entries = await Promise.all(config.dataFiles.map(async (name) => {
    const r = await fetch(new URL(`data/${name}.json`, base));
    if (!r.ok) throw new Error(`Game data unavailable: ${name}`);
    return [name, await r.json()];
  }));
  const data = Object.fromEntries(entries);
  setData(data); setSimData(data);
  const registry = new SessionRegistry();
  lobby = new Lobby({ registry, log: console });
  const genCode = lobby.genCode.bind(lobby);
  lobby.genCode = () => { const code = reservedCode; reservedCode = null; return code || genCode(); };
  network = new Network({ registry, handler: lobby, log: console, options: { maxConnections: 12 } });
  postMessage({ kind: 'ready' });
}
onmessage = async ({ data: message }) => {
  try {
    if (message.kind === 'init') { await init(message.base); return; }
    if (!network) throw new Error('Game core not initialized');
    if (message.kind === 'reserve') { reservedCode = message.code; return; }
    if (message.kind === 'open') {
      const socket = new WorkerSocket(message.id);
      ports.set(message.id, socket);
      network.handleConnection(socket, { socket: { remoteAddress: '127.0.0.1' } });
      return;
    }
    const socket = ports.get(message.id);
    if (message.kind === 'frame' && socket) {
      const frame = message.data;
      if (typeof frame !== 'string' || new TextEncoder().encode(frame).length > 64 * 1024) {
        socket.close(1009, 'message too large'); return;
      }
      socket.emit('message', frame, false);
    } else if (message.kind === 'pong') socket?.emit('pong');
    else if (message.kind === 'close') socket?.close(message.code, message.reason);
    else if (message.kind === 'dispose') {
      for (const room of [...lobby.rooms.values()]) lobby.disposeRoom(room, 'shutdown');
      network.close(); close();
    }
  } catch (error) {
    postMessage({ kind: 'failure', message: error.message });
  }
};
