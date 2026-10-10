import { androidBridge, normalizeRemoteUrl, probeRemoteGame, configureRemoteProxy, clearRemoteProxy } from './connect.js';
export async function selectRemoteTarget(url, { bridge = androidBridge(), probe = probeRemoteGame,
  configure = configureRemoteProxy, clear = clearRemoteProxy, confirm = async () => false,
  navigate = (target) => { location.href = target; }, resetIdentity = () => {}, localUrl = globalThis.location?.href } = {}) {
  const result = await probe(url);
  if (result.valid && result.proxyable && bridge) {
    const configured = await configure(result.proxyUrl || url);
    if (configured.ok) {
      const local = new URL(localUrl); local.search = new URL(url).search; local.hash = '';
      resetIdentity();
      try { sessionStorage.setItem('sp-remote-resource-mode', 'local-assets'); } catch { /* private browsing */ }
      navigate(local.toString());
      return 'proxy';
    }
  } else if (result.valid && !bridge) { navigate(url); return 'remote-page'; }
  await clear();
  if (!result.valid && !result.blocked && !['version-mismatch', 'health-missing', 'ws-unavailable'].includes(result.reason)) {
    return 'rejected';
  }
  const accepted = await confirm({ title: '确认打开远程完整页面', micro: 'REMOTE CHECK',
    text: '本机与远端的版本、协议、证书或连接状态未能确认兼容。继续后使用远端完整页面和素材；证书与网页验证仍需你手动确认。',
    okText: '打开远程页面', cancelText: '返回本地' });
  if (!accepted) return 'cancelled';
  const target = normalizeRemoteUrl(result.candidateUrl) || url;
  if (bridge?.openExternal && result.blocked) bridge.openExternal(target);
  else if (bridge?.openRemote) bridge.openRemote(target);
  else navigate(target);
  return 'fallback';
}

