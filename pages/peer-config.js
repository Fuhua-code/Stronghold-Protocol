// TURN credentials are short-lived and fetched server-side through the public Pages credential service.
export const ICE_SERVERS = Object.freeze([
  { urls: ['stun:stun.cloudflare.com:3478'] },
  { urls: ['stun:stun.miwifi.com:3478'] },
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
]);

export const PEER_CONFIG = {
  iceServers: ICE_SERVERS,
  iceCandidatePoolSize: 1,
  iceTransportPolicy: 'all',
};

export const TURN_TTL_SECONDS = 1800;
export const TURN_REFRESH_MARGIN_MS = 120_000;
export const TURN_FAILURE_RETRY_MS = 60_000;

export function normalizeTurnPayload(payload, now = Date.now()) {
  if (!payload || !Array.isArray(payload.iceServers) || !Number.isFinite(payload.expiresAt)) throw new Error('invalid_turn_response');
  const iceServers = [];
  let hasTurn = false;
  for (const server of payload.iceServers) {
    if (!server || typeof server !== 'object') continue;
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
      .filter((url) => typeof url === 'string' && /^(?:stun|stuns|turn|turns):[^\s]+$/i.test(url));
    if (!urls.length) continue;
    const turnUrls = urls.filter((url) => /^(?:turn|turns):/i.test(url));
    if (turnUrls.length) {
      if (typeof server.username !== 'string' || !server.username || typeof server.credential !== 'string' || !server.credential) continue;
      hasTurn = true;
      iceServers.push({ urls, username: server.username, credential: server.credential });
    } else iceServers.push({ urls });
  }
  if (!hasTurn || payload.expiresAt <= now + TURN_REFRESH_MARGIN_MS) throw new Error('invalid_turn_response');
  return { iceServers, expiresAt: payload.expiresAt };
}

export class TurnCredentialCache {
  constructor({ endpoint, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 8000, onUpdate = null } = {}) {
    this.endpoint = endpoint;
    this.fetch = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.onUpdate = onUpdate;
    this.cached = null;
    this.inFlight = null;
    this.refreshTimer = null;
  }

  async get() {
    const now = this.now();
    if (this.cached && now < this.cached.refreshAt) return this.cached.value;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.load(now).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async load(now) {
    if (!this.endpoint || typeof this.fetch !== 'function') return this.fallback(now, 'not_configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = new URL(this.endpoint);
      url.searchParams.set('ttl', String(TURN_TTL_SECONDS));
      const response = await this.fetch(url, { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) return this.fallback(now, `http_${response.status}`);
      const value = normalizeTurnPayload(await response.json(), this.now());
      const result = { ...value, turnAvailable: true, reason: null };
      this.cached = { value: result, refreshAt: Math.max(now, value.expiresAt - TURN_REFRESH_MARGIN_MS) };
      this.scheduleRefresh(value.expiresAt - TURN_REFRESH_MARGIN_MS);
      this.onUpdate?.(result);
      return result;
    } catch (error) {
      // Keep diagnostics generic: upstream body and credentials must never enter logs.
      const reason = error?.name === 'AbortError' ? 'timeout' : 'unavailable';
      return this.fallback(now, reason);
    } finally {
      clearTimeout(timer);
    }
  }

  fallback(now, reason) {
    const value = { iceServers: ICE_SERVERS, expiresAt: 0, turnAvailable: false, reason };
    this.cached = { value, refreshAt: now + TURN_FAILURE_RETRY_MS };
    this.scheduleRefresh(now + TURN_FAILURE_RETRY_MS);
    return value;
  }

  scheduleRefresh(refreshAt) {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delay = Math.max(1000, refreshAt - this.now());
    this.refreshTimer = setTimeout(() => {
      this.cached = null;
      this.get().catch(() => {});
    }, delay);
    this.refreshTimer.unref?.();
  }

  clear() { this.cached = null; this.inFlight = null; if (this.refreshTimer) clearTimeout(this.refreshTimer); this.refreshTimer = null; }
}

export function summarizeIceStats(stats) {
  const records = [...stats.values()];
  const byId = new Map(records.map((record) => [record.id, record]));
  const types = (kind) => [...new Set(records
    .filter((record) => record.type === kind)
    .map((record) => record.candidateType)
    .filter(Boolean))].sort();
  const pairs = records.filter((record) => record.type === 'candidate-pair').map((pair) => ({
    state: pair.state || null,
    nominated: !!pair.nominated,
    local: byId.get(pair.localCandidateId)?.candidateType || null,
    remote: byId.get(pair.remoteCandidateId)?.candidateType || null,
  }));
  return { localCandidateTypes: types('local-candidate'), remoteCandidateTypes: types('remote-candidate'), pairs };
}

export function peerFailureMessage(error, diagnostics = {}, turnState = {}) {
  const type = String(error?.type || '').toLowerCase();
  if (type === 'peer-unavailable') return '没有找到该同盟的在线房主；请核对密钥并确认房主页面仍开启';
  if (['network', 'socket-error', 'server-error'].includes(type)) return '公共联机信令暂不可用；请检查网络后重试';
  if (diagnostics.remoteDescription) {
    if (turnState && Object.prototype.hasOwnProperty.call(turnState, 'turnAvailable') && !turnState.turnAvailable) return 'WebRTC 直连失败，TURN 中继凭据暂不可用；请稍后重试或更换网络，房间仍在线';
    if (diagnostics.localCandidateTypes?.includes('relay') || diagnostics.remoteCandidateTypes?.includes('relay')) return 'WebRTC 直连与 TURN 中继均未能建立数据通道；房间仍在线，请检查网络或稍后重试';
    return '已收到房主连接应答，但 WebRTC 直连失败；房间仍在线，请检查双方 NAT、防火墙和 UDP 网络';
  }
  if (diagnostics.iceGatheringState === 'complete' && diagnostics.localCandidateTypes?.length === 0) {
    return '本机未生成可用的 WebRTC 网络候选；房主同盟不会因此关闭，请检查浏览器版本、网络权限和 UDP';
  }
  if (type === 'webrtc' || type === 'webrtc-timeout' || /ICE|negotiat|超时|timeout/i.test(String(error?.message || ''))) {
    return '无法建立 WebRTC 直连；请核对同盟密钥及双方网络，连接失败不会关闭房主的同盟';
  }
  return '未能连接房主；请核对同盟密钥、网络和房主状态';
}
