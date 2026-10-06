// Direct WebRTC configuration shared by the Pages transport and its tests.
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

export function peerFailureMessage(error, diagnostics = {}) {
  const type = String(error?.type || '').toLowerCase();
  if (type === 'peer-unavailable') return '没有找到该同盟的在线房主；请核对密钥并确认房主页面仍开启';
  if (['network', 'socket-error', 'server-error'].includes(type)) return '公共联机信令暂不可用；请检查网络后重试';
  if (diagnostics.remoteDescription) {
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
