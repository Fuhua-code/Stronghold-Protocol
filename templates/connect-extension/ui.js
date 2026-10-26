// Runtime UI fallback. The exact 0.3.x overlay still owns the normal title/settings/stats UI;
// this module only activates when the build's feature report says a feature was skipped or
// degraded. It never patches upstream modules: it adds a floating/header/settings entry and a
// self-contained panel, reusing the overlay's control/storage helpers through dynamic imports.
const FEATURES_URL = '/sp-extension/features.json';
const NOTICE_KEY = 'sp.extension.notice';
const PANEL_ID = 'spx-panel';
const FALLBACK_FEATURES = ['settings', 'stats-tab'];

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function isVisible(node) {
  try {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  } catch { return false; }
}

function button(label, cls, onClick) {
  const node = el('button', cls || 'spx-btn', label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function status(node, text, tone) {
  node.textContent = text || '';
  node.dataset.tone = tone || '';
}

function fmtTime(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const d = new Date(value);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function resultText(raw) {
  if (!raw) return '—';
  if (raw.end === 'quit') return '中途退出';
  return raw.victory ? '胜' : '负';
}

async function loadFeatures() {
  try {
    const response = await fetch(FEATURES_URL, { cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}

async function connectPanel() {
  const { normalizeRemoteUrl } = await import('/js/connect.js');
  const { selectRemoteTarget } = await import('/js/remote-session.js');
  const dialogs = await import('/js/ui/components.js');
  return { normalizeRemoteUrl, selectRemoteTarget, dialogs };
}

async function recordsPanel() {
  const [{ controlGet, controlRequest }, records, stats, dialogs] = await Promise.all([
    import('/js/connect.js'),
    import('/js/ui/remote-records.js'),
    import('/js/ui/stats.js'),
    import('/js/ui/components.js'),
  ]);
  return { controlGet, controlRequest, records, stats, dialogs };
}

async function settingsPanel() {
  return import('/js/remote-session.js');
}

const guideText = [
  ['局域网联机', '同一 Wi-Fi 或路由器下的设备，在本机初始界面选择“远程”，输入本机局域网地址即可加入。'],
  ['外部服务器', '不在同一局域网时，使用服务器提供的内网穿透地址或完整 HTTP/HTTPS 游戏地址。'],
  ['权限与缓存', '远程浏览器只访问游戏服务器；本机素材优先，服务器额外素材自动缓存到本机。'],
];

function createPanel() {
  if (document.getElementById(PANEL_ID)) return document.getElementById(PANEL_ID);
  const overlay = el('div', 'spx-overlay');
  overlay.id = PANEL_ID;
  overlay.hidden = true;
  const card = el('div', 'spx-card');
  const head = el('div', 'spx-head');
  const title = el('div', 'spx-title', '远程连接');
  const close = button('关闭', 'spx-close', () => { overlay.hidden = true; });
  head.append(title, close);
  const tabs = el('div', 'spx-tabs');
  const body = el('div', 'spx-body');
  const tabDefs = [
    ['connect', '连接'], ['settings', '设置'], ['records', '远程记录'], ['guide', '指南'],
  ];
  const tabButtons = new Map();
  for (const [id, label] of tabDefs) {
    const tab = button(label, 'spx-tab', () => openTab(id));
    tabButtons.set(id, tab);
    tabs.appendChild(tab);
  }
  card.append(head, tabs, body);
  overlay.appendChild(card);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) overlay.hidden = true; });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hidden) overlay.hidden = true;
  });
  document.body.appendChild(overlay);

  const state = { overlay, body, tabButtons, tab: 'connect' };

  function note(text, tone) {
    const line = el('p', 'spx-status');
    status(line, text, tone);
    state.body.appendChild(line);
  }

  async function renderTab(tab) {
    for (const [id, node] of tabButtons) node.classList.toggle('is-on', id === tab);
    body.textContent = '';
    if (tab === 'connect') { renderConnect(); return; }
    if (tab === 'settings') { renderSettings(); return; }
    if (tab === 'records') { await renderRecords(); return; }
    renderGuide();
  }

  function openTab(tab) {
    state.tab = tab;
    state.overlay.hidden = false;
    renderTab(tab).catch((error) => note(`加载失败：${error?.message || error}`, 'error'));
  }

  function renderConnect() {
    const form = el('div', 'spx-form');
    const input = el('input', 'spx-input');
    input.type = 'url';
    input.placeholder = '输入远程游戏地址（http/https）';
    input.autocomplete = 'off';
    const go = button('连接', 'spx-btn is-primary', async () => {
      try {
        go.disabled = true;
        const api = await connectPanel();
        const url = api.normalizeRemoteUrl(input.value.trim());
        if (!url) { note('请输入合法的 HTTP / HTTPS 游戏地址，不能使用本机地址。', 'error'); return; }
        note('正在探测服务器…');
        const result = await api.selectRemoteTarget(url, {
          confirm: api.dialogs.confirmDialog, alert: api.dialogs.alertDialog,
        });
        if (result === 'rejected' || result === 'failed') note('远程连接未完成。', 'error');
        else note('已打开远程页面。', 'ok');
      } catch (error) {
        note(`连接失败：${error?.message || error}`, 'error');
      } finally { go.disabled = false; }
    });
    form.append(input, go);
    body.append(form);
    note('上游 UI 变化时使用此兼容入口；正常版本仍使用标题页的双入口。');
  }

  function renderSettings() {
    const wrap = el('div', 'spx-form');
    const addGroup = (labelText, options, current, apply) => {
      const row = el('div', 'spx-row');
      row.appendChild(el('span', 'spx-label', labelText));
      const group = el('div', 'spx-seg');
      for (const [value, text] of options) {
        const btn = button(text, 'spx-seg-btn', () => {
          apply(value);
          for (const child of group.children) child.classList.toggle('is-on', child.dataset.value === String(value));
        });
        btn.dataset.value = String(value);
        if (String(value) === String(current)) btn.classList.add('is-on');
        group.appendChild(btn);
      }
      row.appendChild(group);
      wrap.appendChild(row);
    };
    const render = async () => {
      const api = await settingsPanel();
      wrap.textContent = '';
      addGroup('远程素材', [['local-first', '本地优先'], ['strict', '严格匹配']], api.readRemoteArtMode(), (value) => api.writeRemoteArtMode(value));
      addGroup('战绩收集', [['on', '开启'], ['off', '关闭']], api.readCollectStats() ? 'on' : 'off', (value) => api.writeCollectStats(value === 'on'));
      body.append(wrap);
      note('设置只影响本机；下次连接生效。');
    };
    render().catch((error) => note(`设置加载失败：${error?.message || error}`, 'error'));
  }

  async function renderRecords() {
    const api = await recordsPanel();
    body.textContent = '';
    const toolbar = el('div', 'spx-toolbar');
    const reload = button('刷新', 'spx-btn', () => openTab('records'));
    toolbar.append(reload);
    body.appendChild(toolbar);
    const holder = el('div', 'spx-servers');
    body.appendChild(holder);
    const response = await api.controlGet('/connect/records');
    if (!response.ok) { note(`读取远程记录失败（HTTP ${response.status}）。`, 'error'); return; }
    const doc = await response.json();
    const servers = api.records.groupServers(doc);
    if (!servers.length) { holder.appendChild(el('p', 'spx-status', '还没有从服务器收集到记录。')); return; }
    for (const server of servers) {
      const section = el('section', 'spx-server');
      const head = el('div', 'spx-server-head');
      const name = el('div', 'spx-server-name', server.label || server.host || server.origin);
      const meta = el('div', 'spx-server-meta',
        `${server.origin} · ${server.verification || 'unknown'} · 最近 ${fmtTime(server.lastSeen)} · ${server.records.length} 条`);
      const actions = el('div', 'spx-server-actions');
      const merge = button(`并入本机统计（${server.records.length}）`, 'spx-btn', async () => {
        try {
          const payload = api.records.prepareMerge(server);
          const current = api.stats.loadStats();
          const { stats, added } = api.stats.importStats(payload, current);
          if (added && !api.stats.saveStats(stats)) { note('写入本机统计失败。', 'error'); return; }
          note(added ? `已并入 ${added} 条记录。` : '没有新记录（全部重复）。', 'ok');
        } catch (error) {
          note(error?.code === 'stats-newer-version' ? '记录来自更新版本的客户端，无法并入。' : `并入失败：${error?.message || error}`, 'error');
        }
      });
      const clear = button('清空', 'spx-btn is-danger', async () => {
        const ok = await api.dialogs.confirmDialog({
          title: '清空远程记录', danger: true, okText: '清空', cancelText: '取消',
          text: `将删除 ${server.label || server.host || server.origin} 在本机归档的远程记录，无法恢复。`,
        });
        if (!ok) return;
        try {
          const result = await api.controlRequest(`/connect/records?origin=${encodeURIComponent(server.origin)}`, { method: 'DELETE' });
          if (!result.ok) { note(`清空失败（HTTP ${result.status}）。`, 'error'); return; }
          openTab('records');
        } catch (error) { note(`清空失败：${error?.message || error}`, 'error'); }
      });
      actions.append(merge, clear);
      head.append(name, meta);
      section.append(head, actions);
      const list = el('div', 'spx-records');
      for (const row of server.records.slice().reverse()) {
        const raw = row.raw || row;
        const item = el('div', 'spx-record');
        item.append(
          el('span', 'spx-record-time', fmtTime(raw.t || row.collectedAt)),
          el('span', 'spx-record-result', resultText(raw)),
          el('span', 'spx-record-rounds', raw.roundsPassed != null ? `${raw.roundsPassed} 回合` : '—'),
        );
        list.appendChild(item);
      }
      section.appendChild(list);
      holder.appendChild(section);
    }
  }

  function renderGuide() {
    for (const [title, text] of guideText) {
      body.appendChild(el('h4', 'spx-sub', title));
      body.appendChild(el('p', 'spx-status', text));
    }
  }

  return { openTab, state };
}

let panel = null;
function openPanel(tab) {
  panel = panel || createPanel();
  panel.openTab(tab || 'connect');
}

function syncDom(skipped) {
  if (skipped.has('stats-tab')) {
    for (const host of document.querySelectorAll('.st-top__right')) {
      if (!isVisible(host)) continue;
      if (host.querySelector('[data-spx="stats"]')) continue;
      const btn = button('远程记录', 'spx-inline', () => openPanel('records'));
      btn.dataset.spx = 'stats';
      host.insertBefore(btn, host.firstChild);
    }
  }
  if (skipped.has('settings')) {
    for (const list of document.querySelectorAll('.set-list')) {
      if (!isVisible(list)) continue;
      if (list.querySelector('[data-spx="settings"]')) continue;
      const row = el('div', 'spx-set-row');
      row.dataset.spx = 'settings';
      row.append(el('span', 'spx-label', '远程连接'), button('打开', 'spx-btn', () => openPanel('settings')));
      list.appendChild(row);
    }
  }
}

function showNotice(features) {
  const warnings = (features.degraded || []).filter((f) => f.warning !== false);
  if (!warnings.length) return;
  const build = features.generatedAt || 'unknown';
  try { if (localStorage.getItem(NOTICE_KEY) === build) return; } catch { /* storage unavailable */ }
  const banner = el('div', 'spx-banner');
  const text = el('span', 'spx-banner-text',
    `上游更新导致以下功能使用兼容入口：${warnings.map((f) => f.label || f.id).join('、')}。`);
  const open = button('查看', 'spx-banner-btn', () => openPanel(warnings[0]?.id === 'stats-tab' ? 'records' : warnings[0]?.id === 'settings' ? 'settings' : 'connect'));
  const dismiss = button('知道了', 'spx-banner-btn', () => {
    banner.remove();
    try { localStorage.setItem(NOTICE_KEY, build); } catch { /* storage unavailable */ }
  });
  banner.append(text, open, dismiss);
  document.body.appendChild(banner);
}

async function main() {
  const features = await loadFeatures();
  if (!features) return;
  const list = Array.isArray(features.features) ? features.features : [];
  const skipped = new Set(list.filter((f) => f.status === 'skipped').map((f) => f.id));
  const hasFallback = FALLBACK_FEATURES.some((id) => skipped.has(id));
  if (!hasFallback && !(features.degraded || []).length) return;
  showNotice(features);
  if (!skipped.has('stats-tab') && !skipped.has('settings')) return;
  const sync = () => { try { syncDom(skipped); } catch { /* page is navigating */ } };
  sync();
  new MutationObserver(() => {
    if (sync.pending) return;
    sync.pending = true;
    setTimeout(() => { sync.pending = false; sync(); }, 120);
  }).observe(document.documentElement, { childList: true, subtree: true });
  // lit-html replaces the settings list on re-render; keep the visible list patched.
  const timer = setInterval(sync, 1500);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  document.addEventListener('visibilitychange', sync);
}

main().catch((error) => console.warn('[sp-extension] UI fallback failed', error));
