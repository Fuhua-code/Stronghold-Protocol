// Remote-connection settings live in the existing SettingsModal. The remote entry itself
// stays free of switches so the title/game UI keeps its original layout.
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button, MicroLabel, confirmDialog } from './components.js';
import { androidBridge } from '../connect.js';
import { readRemoteArtMode, writeRemoteArtMode, readCollectStats, writeCollectStats } from '../remote-session.js';
import { openStats } from '../screens/stats.js';

function formatBytes(value) {
  const n = Number(value) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function RemoteSettingsSection() {
  const bridge = androidBridge();
  const [mode, setMode] = useState(() => readRemoteArtMode());
  const [collect, setCollect] = useState(() => readCollectStats());
  const [stats, setStats] = useState({});
  const [note, setNote] = useState('');
  const readStats = () => {
    try { return JSON.parse(bridge?.remoteCacheStats?.() || '{}'); } catch { return {}; }
  };
  useEffect(() => { if (bridge) setStats(readStats()); }, []);
  if (!bridge) return null;
  const applyMode = (next) => setMode(writeRemoteArtMode(next));
  const dedupe = () => {
    const removed = Number(bridge.dedupeRemotePacks?.() || 0);
    setStats(readStats());
    setNote(removed > 0 ? `已清理 ${removed} 个与本地重复的 L2 文件。` : '没有与本地重复的 L2 文件。');
  };
  const clear = async () => {
    const ok = await confirmDialog({
      title: '清除 L2 素材包',
      text: '清除 App 管理的服务器素材包，并安排在下一次连接时清理该服务器的页面缓存。\n不会影响 App 内置素材（L0）；之后需要重新下载。',
      okText: '清除',
      cancelText: '取消',
    });
    if (!ok) return;
    const removed = Number(bridge.clearRemotePacks?.() || 0);
    bridge.requestRemoteCacheClear?.();
    setStats(readStats());
    setNote(removed > 0 ? `已清除 ${removed} 个 L2 文件；页面缓存将在下次连接时清理。` : 'App 管理的 L2 已为空；页面缓存将在下次连接时清理。');
  };
  return html`<section class="set-plugins" data-testid="remote-settings" aria-labelledby="set-remote-title">
    <div class="set-keys__head">
      <span class="set-row__label" id="set-remote-title">远程连接<${MicroLabel}>REMOTE<//></span>
    </div>
    <p class="set-hint">仅 Android 客户端：远程服务器页面使用本机素材；额外素材自动缓存，返回本地时清理。</p>
    <div class="set-row">
      <span class="set-row__label">远程素材<${MicroLabel}>REMOTE ART<//></span>
      <div class="set-seg" role="radiogroup" aria-label="远程素材">
        <button type="button" role="radio" aria-checked=${mode === 'local-first' ? 'true' : 'false'}
          class=${mode === 'local-first' ? 'is-on' : ''} onClick=${() => applyMode('local-first')}>本地优先</button>
        <button type="button" role="radio" aria-checked=${mode === 'strict' ? 'true' : 'false'}
          class=${mode === 'strict' ? 'is-on' : ''} onClick=${() => applyMode('strict')}>严格匹配</button>
      </div>
    </div>
    <p class="set-hint">本地优先按路径使用手机里的素材，进服更快，但可能显示旧素材；严格匹配只在 hash/清单一致时使用本地素材。下一次连接生效。</p>
    <div class="set-row">
      <span class="set-row__label">远程战绩收集<${MicroLabel}>REMOTE RECORDS<//></span>
      <div class="set-seg" role="radiogroup" aria-label="远程战绩收集">
        <button type="button" role="radio" aria-checked=${collect ? 'true' : 'false'}
          class=${collect ? 'is-on' : ''} onClick=${() => setCollect(writeCollectStats(true))}>开启</button>
        <button type="button" role="radio" aria-checked=${!collect ? 'true' : 'false'}
          class=${!collect ? 'is-on' : ''} onClick=${() => setCollect(writeCollectStats(false))}>关闭</button>
      </div>
      <span class="set-storage__actions">
        <${Button} variant="ghost" size="sm" onClick=${() => openStats('remote')}>查看远程记录<//>
      </span>
    </div>
    <p class="set-hint">远程服务器完成对局后，本机自动收集该局记录并按来源服务器分组，可查看、并入本机统计或清空；数据只保存在这台设备里。覆盖安装更新会保留；卸载或清除应用数据会删除。</p>
    <div class="set-row">
      <span class="set-row__label">会话缓存（L1）<${MicroLabel}>SESSION<//></span>
      <span class="set-row__val">自动</span>
    </div>
    <p class="set-hint">额外素材在本次远程会话内自动缓存，不弹确认；返回本地入口时清理。不会复制 App 内置素材。</p>
    <div class="set-row">
      <span class="set-row__label">服务器素材包（L2）<${MicroLabel}>SERVER PACK<//></span>
      <span class="set-row__val num">${formatBytes(stats.packBytes)} / ${Number(stats.packFiles) || 0}</span>
    </div>
    <p class="set-hint">服务器长期素材包由服务器的缓存功能管理；App 管理的 L2 会校验清单/hash 后再并集、按 hash 去重。页面自管的缓存由“清除 L2”在下次连接时处理。</p>
    <div class="set-row">
      <span class="set-row__label">L2 管理<${MicroLabel}>CACHE<//></span>
      <span class="set-storage__actions">
        <${Button} variant="ghost" size="sm" onClick=${dedupe}>清理与本地重复项<//>
        <${Button} variant="ghost" size="sm" onClick=${clear}>清除 L2<//>
      </span>
    </div>
    ${note ? html`<p class="set-keys__note" role="status" aria-live="polite">${note}</p>` : null}
  </section>`;
}
