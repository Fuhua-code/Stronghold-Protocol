import { androidBridge, normalizeRemoteUrl, resolveRemoteSession, configureRemoteProxy, clearRemoteProxy, discoverRemoteAssets } from './connect.js';

export const REMOTE_ART_MODE_KEY = 'sp.pref.remoteArtMode';
export const REMOTE_STATS_COLLECT_KEY = 'sp.pref.remoteStatsCollect';
const CONFIRMED_PREFIX = 'sp.remote.confirmed.';

/** The WebView remote-page art policy: local-first by default, strict matching only when chosen. */
export function readRemoteArtMode() {
  try { return globalThis.localStorage?.getItem(REMOTE_ART_MODE_KEY) === 'strict' ? 'strict' : 'local-first'; }
  catch { return 'local-first'; }
}

export function writeRemoteArtMode(mode) {
  const value = mode === 'strict' ? 'strict' : 'local-first';
  try { globalThis.localStorage?.setItem(REMOTE_ART_MODE_KEY, value); } catch { /* private browsing */ }
  return value;
}

/** Auto-collect the remote page's match records into the on-device archive; on unless switched off. */
export function readCollectStats() {
  try { return globalThis.localStorage?.getItem(REMOTE_STATS_COLLECT_KEY) !== 'off'; }
  catch { return true; }
}

export function writeCollectStats(on) {
  const value = on ? 'on' : 'off';
  try { globalThis.localStorage?.setItem(REMOTE_STATS_COLLECT_KEY, value); } catch { /* private browsing */ }
  return on;
}

function confirmed(origin) {
  try { return globalThis.sessionStorage?.getItem(CONFIRMED_PREFIX + origin) === '1'; } catch { return false; }
}

function markConfirmed(origin) {
  try { globalThis.sessionStorage?.setItem(CONFIRMED_PREFIX + origin, '1'); } catch { /* private browsing */ }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

/**
 * Resolve + admit a remote game, then hand the final origin and its asset targets to the
 * Android bridge. The bridge loads the requested entry URL (so the browser keeps the join
 * service's cookies) but only authorizes a landing on finalUrl.
 */
export async function selectRemoteTarget(url, { bridge = androidBridge(), probe = resolveRemoteSession,
  configure = configureRemoteProxy, clear = clearRemoteProxy,
  confirm = async () => false, alert = async () => {},
  navigate = (target) => { location.href = target; }, resetIdentity = () => {}, localUrl = globalThis.location?.href,
  artMode = readRemoteArtMode(), discover = discoverRemoteAssets } = {}) {
  const requested = normalizeRemoteUrl(url);
  if (!requested) {
    await alert({ title: '地址无效', text: '请输入合法的 HTTP / HTTPS 游戏地址，不能使用本机回环地址。', okText: '知道了' });
    return 'rejected';
  }
  const result = await probe(requested);
  // Never open a page from an unprobed URL: without the resolved final origin the native
  // navigation policy cannot authorize the join service's redirect chain.
  const finalUrl = normalizeRemoteUrl(result.finalUrl) || normalizeRemoteUrl(result.proxyUrl);
  if (!finalUrl) {
    await alert({ title: '无法解析服务器地址', text: '远程探测没有返回最终游戏地址（超时、证书或网络错误）。请检查网络后重试。', okText: '知道了' });
    return 'rejected';
  }
  if (['invalid-url', 'local-or-invalid-redirect', 'private-redirect', 'redirect-loop'].includes(result.reason)) {
    await alert({ title: '已阻止远程地址', text: '该地址会跳转到本机、回环或私有网络，远程浏览器不会打开它。', okText: '知道了' });
    return 'rejected';
  }
  if (result.game === false || result.reason === 'invalid-game-page') {
    await alert({ title: '这不是游戏服务器', text: '该地址没有提供卫戍协议的客户端页面，远程浏览器只允许访问游戏服务器。', okText: '知道了' });
    return 'rejected';
  }
  const gameOrigin = (() => { try { return new URL(result.gameOrigin || finalUrl).origin; } catch { return null; } })();
  const hybrid = bridge && typeof bridge.openRemoteWithArt === 'function';
  const openHybrid = async (probeResult) => {
    let targets = {
      origins: Array.isArray(probeResult.origins) ? probeResult.origins : [],
      prefixes: Array.isArray(probeResult.prefixes) ? probeResult.prefixes : [],
      manifests: Array.isArray(probeResult.manifests) ? probeResult.manifests : [],
      assetMatch: typeof probeResult.assetMatch === 'boolean' ? probeResult.assetMatch : null,
    };
    if (!targets.origins.length) {
      try { targets = { ...targets, ...(await discover(finalUrl)) }; } catch { /* page origin only */ }
    }
    const payload = JSON.stringify({
      requestedUrl: requested,
      finalUrl,
      gameOrigin: gameOrigin || new URL(finalUrl).origin,
      origins: targets.origins,
      assetOrigins: targets.origins,
      prefixes: targets.prefixes,
      manifests: targets.manifests,
      redirectOrigins: Array.isArray(probeResult.redirectOrigins) ? probeResult.redirectOrigins : [],
      mode: artMode,
      verification: probeResult.verification || 'compatible-unknown',
      assetMatch: probeResult.assetMatch ?? targets.assetMatch ?? null,
      collectStats: readCollectStats(),
    });
    try {
      const opened = bridge.openRemoteWithArt(requested, artMode,
        probeResult.assetMatch === true || targets.assetMatch === true, payload) !== false;
      console.log('[remote-art] hybrid', artMode, payload, opened);
      return opened;
    } catch (error) {
      console.log('[remote-art] bridge failed', String(error));
      return false;
    }
  };
  const verified = result.verification === 'verified';
  if (!verified) {
    const originKey = gameOrigin || finalUrl;
    if (!confirmed(originKey)) {
      const accepted = await confirm({
        title: '连接未验证的服务器',
        micro: 'REMOTE CHECK',
        text: `服务器 ${hostOf(finalUrl)} 没有提供完整的版本指纹（或连接状态未确认）。\n继续后会打开该服务器自己的客户端；素材按设置里的“远程素材”决定。\n本次 App 运行期间不会再次询问这台服务器。`,
        okText: '继续连接',
        cancelText: '返回本地',
      });
      if (!accepted) return 'cancelled';
      markConfirmed(originKey);
    }
  }
  try { await clear(); } catch { /* legacy proxy */ }
  if (hybrid) {
    if (await openHybrid(result)) return 'remote-art';
    await alert({ title: '远程页面无法打开', text: '本机桥接没有接受该地址，请检查地址后重试。', okText: '知道了' });
    return 'failed';
  }
  if (bridge?.openRemote) {
    resetIdentity();
    bridge.openRemote(requested);
    return 'remote-page';
  }
  navigate(finalUrl);
  return 'remote-page';
}
