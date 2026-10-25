// Match records the Android shell collected from remote servers' own clients (see server/http/remote.js
// /connect/records). A separate archive: viewable per server, optionally merged into this device's stats
// with a source tag. Strings stay Chinese literals like the rest of the connect overlay.
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button, MicroLabel, Spinner, confirmDialog } from './components.js';
import { controlGet, controlRequest } from '../connect.js';
import { importStats, loadStats, saveStats } from './stats.js';

export function serverLabel(server) {
  if (server?.host) return server.host;
  try { return new URL(server?.origin || '').host; } catch { return server?.origin || '—'; }
}

/** Per-origin buckets, newest activity first, shaped for the list UI. */
export function groupServers(doc) {
  const out = [];
  for (const [origin, server] of Object.entries(doc?.servers || {})) {
    if (!server || typeof server !== 'object') continue;
    out.push({
      origin,
      host: server.host || serverLabel({ origin }),
      label: serverLabel({ ...server, origin }),
      app: server.app || '',
      verification: server.verification || '',
      firstSeen: Number(server.firstSeen) || 0,
      lastSeen: Number(server.lastSeen) || 0,
      records: Array.isArray(server.records) ? server.records : [],
    });
  }
  out.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  return out;
}

/** Export-shaped payload of one server's raw records, each tagged with its source for mergeStats. */
export function prepareMerge(server) {
  const records = (server?.records || [])
    .map((row) => (row && typeof row.raw === 'object' && row.raw ? {
      ...row.raw,
      src: {
        origin: String(server.origin || ''),
        host: String(server.host || ''),
        app: String(server.app || ''),
        verification: String(server.verification || ''),
        collectedAt: Number(row.collectedAt) || 0,
      },
    } : null))
    .filter(Boolean);
  return { app: 'stronghold-protocol', kind: 'local-stats', v: 2, exportedAt: new Date().toISOString(), records };
}

const dateTime = (ms) => {
  const d = ms ? new Date(ms) : null;
  if (!d || Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const difficultyName = (v) => ({ 1: '标准', 2: '险境', 3: '绝境', 4: '终极' }[Number(v)] || '—');

function RecordRow({ row, server, onOpen }) {
  const rec = row.raw || {};
  const quit = rec.end === 'quit';
  const won = rec.victory === true;
  const src = {
    origin: String(server.origin || ''),
    host: String(server.host || ''),
    app: String(server.app || ''),
    verification: String(server.verification || ''),
    collectedAt: Number(row.collectedAt) || 0,
  };
  const open = () => onOpen({ ...rec, src });
  const view = !quit && rec.compact !== true;
  return html`<tr class=${quit ? 'is-quit' : won ? 'is-win' : 'is-lose'} title=${view ? '点击查看该局结算' : '中途退出或已压缩的记录不能回看结算'}
      tabIndex=${view ? 0 : undefined}
      onClick=${view ? open : undefined} onKeyDown=${view ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } : undefined}>
    <td class="st-t">${dateTime(Number(rec.t) || Number(row.collectedAt) || 0)}</td>
    <td>${difficultyName(rec.difficulty)}</td>
    <td>${rec.roomMode === 'solo' ? '单人' : rec.roomMode === 'coop' ? '同盟' : '—'}</td>
    <td class="st-res">${quit ? html`<span class="t-quit">中途退出</span>` : html`<span class=${won ? 't-win' : 't-lose'}>${won ? '胜' : '负'}</span>`}</td>
    <td class="num">${Number.isFinite(rec.roundsPassed) ? rec.roundsPassed : '—'}</td>
    <td class="st-go" aria-hidden="true">${view ? '›' : null}</td>
  </tr>`;
}

function ServerBlock({ server, busy, onMerge, onClear, onOpen }) {
  return html`<section class="st-section st-remote__server">
    <div class="st-section__head">
      <span class="st-section__title">${server.host}<${MicroLabel}>REMOTE<//></span>
      <span class="st-remote__meta">${server.origin}${server.app ? ` · v${server.app}` : ''}${server.verification ? ` · ${server.verification}` : ''} · 最近收集 ${dateTime(server.lastSeen)}</span>
      <span class="st-storage__actions">
        <${Button} variant="ghost" size="sm" disabled=${busy || !server.records.length} onClick=${() => onMerge(server)}>并入本机统计<//>
        <${Button} variant="ghost" size="sm" disabled=${busy || !server.records.length} onClick=${() => onClear(server)}>清空<//>
      </span>
    </div>
    <div class="st-tablewrap"><table class="st-table st-table--history">
      <thead><tr><th>时间</th><th>难度</th><th>模式</th><th>结果</th><th class="num">回合</th><th aria-hidden="true"></th></tr></thead>
      <tbody>${server.records.slice().reverse().map((row) => html`<${RecordRow} key=${row.id} row=${row} server=${server} onOpen=${onOpen} />`)}</tbody>
    </table></div>
  </section>`;
}

/** The 远程记录 tab of the stats screen: what the shell collected, per server. */
export function RemoteRecordsTab({ onOpen, onChanged }) {
  const [state, setState] = useState({ loading: true, servers: [], error: '' });
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const reload = async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const res = await controlGet('/connect/records');
      const body = await res.json().catch(() => ({}));
      setState({ loading: false, servers: res.ok && body.ok ? groupServers(body) : [], error: res.ok ? '' : `HTTP ${res.status}` });
    } catch (err) {
      setState({ loading: false, servers: [], error: String(err?.message || err) });
    }
  };
  useEffect(() => { reload(); }, []);
  const merge = async (server) => {
    setBusy(server.origin);
    setNote('');
    try {
      const payload = prepareMerge(server);
      if (!payload.records.length) return;
      const { stats, added } = importStats(payload, loadStats());
      saveStats(stats);
      setNote(`已并入 ${added} 条来自 ${server.host} 的记录（重复自动跳过）。`);
      onChanged?.();
    } catch (err) {
      setNote(err?.code === 'stats-newer-version' ? '该服务器的记录由更新版本客户端写出，请先升级本机客户端再并入。' : `并入失败：${String(err?.message || err)}`);
    } finally {
      setBusy('');
    }
  };
  const clear = async (server) => {
    const ok = await confirmDialog({
      title: '清空该服务器的远程记录',
      text: `删除本机收集的 ${server.host} 对局记录（${server.records.length} 条）。\n服务器与本机统计不受影响；之后的对局仍会自动收集。`,
      okText: '清空',
      cancelText: '取消',
    });
    if (!ok) return;
    setBusy(server.origin);
    try {
      await controlRequest(`/connect/records?origin=${encodeURIComponent(server.origin)}`, { method: 'DELETE' });
      setNote('');
      await reload();
    } finally {
      setBusy('');
    }
  };
  if (state.loading) return html`<div class="st-loading"><${Spinner} size="md" /></div>`;
  if (state.error) return html`<p class="st-empty">读取本机收集服务失败（${state.error}）；远程记录收集仅 Android 客户端提供。</p>`;
  if (!state.servers.length) {
    return html`<p class="st-empty">还没有远程记录 —— 在远程服务器完成对局后，本机会自动收集到这里，并标注来源服务器。</p>`;
  }
  return html`<div class="st-remote">
    <p class="st-hint">以下对局记录由本机自动收集自远程服务器的页面存储，只保存在这台设备上；并入本机统计后会带上来源标记。</p>
    ${state.servers.map((s) => html`<${ServerBlock} key=${s.origin} server=${s} busy=${busy === s.origin} onMerge=${merge} onClear=${clear} onOpen=${onOpen} />`)}
    ${note ? html`<p class="st-keys__note" role="status" aria-live="polite">${note}</p>` : null}
  </div>`;
}
