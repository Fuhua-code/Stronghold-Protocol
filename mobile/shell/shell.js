// mobile/shell/shell.js — the connect shell of the APK (mobile-connect-0.2).
//
// This page is what the Android app opens for a **local** entry (`http://127.0.0.1:<port>/connect`, see
// MainActivity + mobile/node/main.js). It is deliberately outside the game client: it must render without the
// simulation being loaded, because the player can also choose to play on another machine.
//
//   本地  → boot the game client exactly as index.html does (dynamic import of /js/main.js) and keep this phone's
//           local server running.
//   远程  → read the link in the field, verify it, and hand it to the app, which opens it in a fresh WebView
//           (a real origin, so the remote host serves and simulates its own game) and stops the local server.
//
// Nothing about the game client changes: it is imported, not modified. A non-localhost caller never sees this page
// (the server keeps serving the default `index.html` there), which is the "未修改界面即为默认初始界面" half of the
// spec.

import { isLoopbackHost, normalizeLink, probeLink, android, inApp, appMode } from './util.js';

const $ = (id) => document.getElementById(id);
const el = {
  root: $('connect'),
  split: $('split'),
  local: $('btn-local'),
  remote: $('btn-remote'),
  input: $('cnode-input'),
  hint: $('cnode-hint'),
  status: $('cnode-status'),
  micro: document.querySelector('.cnode-micro'),
  label: document.querySelector('.cnode-label'),
  boot: $('boot'),
  bootText: $('boot-text'),
  bootErr: $('boot-err'),
  dialog: $('dialog'),
  dialogMark: $('dialog-mark'),
  dialogTitle: $('dialog-title'),
  dialogBody: $('dialog-body'),
  dialogActs: $('dialog-acts'),
};

const NAME_MAX = 12;
let mode = null;          // null | 'local' | 'remote'
let chosen = false;       // true once the player picked a side (by tapping a button); typing may only pre-choose
let busy = false;
let gameLoaded = false;
// live view of the state above, for the headless-browser check (mobile/tools/check-shell.mjs) and for debugging
const stateView = () => ({ mode, chosen, busy, gameLoaded, value: el.input.value, cls: el.root.className });
if (typeof window !== 'undefined') Object.defineProperty(window, '__spShell', { get: stateView });

// ---------------------------------------------------------------------------------------------------
// emblem (the title screen's dot-matrix watchtower, 13×14)
// ---------------------------------------------------------------------------------------------------

const EMBLEM = [
  'XXX..XXX..XXX', 'XXX..XXX..XXX', 'XXXXXXXXXXXXX', '.XXXXXXXXXXX.', '..XXXXXXXXX..', '..XXXXXXXXX..',
  '..XXXX.XXXX..', '..XXXX.XXXX..', '..XXXXXXXXX..', '..XXXXXXXXX..', '..XXXXXXXXX..', '.XXXXXXXXXXX.',
  'XXXXXXXXXXXXX', 'XXXXXXXXXXXXX',
];

function drawEmblem() {
  const g = $('cnode-emblem');
  if (!g) return;
  const NS = 'http://www.w3.org/2000/svg';
  EMBLEM.forEach((row, r) => {
    [...row].forEach((ch, c) => {
      if (ch !== 'X') return;
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', String(c + 0.5));
      dot.setAttribute('cy', String(r + 0.5));
      dot.setAttribute('r', String(0.2 + (r / (EMBLEM.length - 1)) * 0.2));
      const accent = (r === 6 || r === 7) && (c === 5 || c === 7);
      if (accent) dot.setAttribute('class', 'is-accent');
      else dot.setAttribute('class', `d${(r * 13 + c) % 7}`);
      g.appendChild(dot);
    });
  });
}

// ---------------------------------------------------------------------------------------------------
// the 博士代号 → 链接地址 label: the Chinese label is rebuilt glyph by glyph ("拆分为线段重组")
// ---------------------------------------------------------------------------------------------------

function buildLabel() {
  const cn = el.label.getAttribute('data-cn') || '';
  const en = el.label.getAttribute('data-en') || '';
  el.label.textContent = '';
  const from = document.createElement('span');
  from.className = 'cnode-label__from';
  [...cn].forEach((ch, i) => {
    const piece = document.createElement('span');
    piece.className = 'cnode-label__piece';
    piece.textContent = ch;
    piece.style.transitionDelay = `${i * 45}ms`;
    from.appendChild(piece);
  });
  const to = document.createElement('span');
  to.className = 'cnode-label__to cnode-label__ghost';
  [...en].forEach((ch, i) => {
    const piece = document.createElement('span');
    piece.className = 'cnode-label__piece';
    piece.textContent = ch;
    piece.style.transitionDelay = `${140 + i * 45}ms`;
    to.appendChild(piece);
  });
  el.label.append(from, to);
  el.label.dataset.pieces = String([...cn].length + [...en].length);
}

function morphLabel(remote) {
  // The pieces are already in the DOM (from/to); this only plays them: every glyph of the old label drops out
  // while the new one assembles, which reads as "the label was taken apart and put back together".
  const from = el.label.querySelector('.cnode-label__from');
  const to = el.label.querySelector('.cnode-label__to');
  if (!from || !to) return;
  for (const piece of from.children) piece.style.opacity = remote ? '0' : '1';
  for (const piece of to.children) piece.style.opacity = remote ? '1' : '0';
  to.classList.toggle('cnode-label__ghost', !remote);
  el.label.setAttribute('data-mode', remote ? 'remote' : 'local');
}

// ---------------------------------------------------------------------------------------------------
// mode handling
// ---------------------------------------------------------------------------------------------------

const PLACEHOLDER = { local: '输入你的代号（最多 12 字）', remote: '输入游戏链接（局域网 / 公网 / 内网穿透）' };

/**
 * Switch the console between 本地 and 远程. The two buttons grow/shrink and fill as specified, the label morphs,
 * the field switches between a callsign and a link.
 * @param {'local'|'remote'} next
 * @param {{ clear?: boolean }} [opts] `clear: false` keeps whatever the player has typed (the caller decides)
 */
function setMode(next, { clear = true } = {}) {
  if (busy) return;
  const remote = next === 'remote';
  mode = next;
  el.root.classList.toggle('is-remote', remote);
  el.split.classList.toggle('is-local', next === 'local');
  el.split.classList.toggle('is-remote', remote);
  morphLabel(remote);
  el.micro.textContent = remote ? '局域网/公网链接' : 'CALLSIGN';
  el.micro.classList.toggle('micro--mint', remote);
  el.input.placeholder = PLACEHOLDER[remote ? 'remote' : 'local'];
  el.input.maxLength = remote ? 160 : NAME_MAX;
  if (clear) el.input.value = '';
  el.hint.textContent = remote ? '' : '';
  el.status.textContent = remote ? '远程：由对方主机运行服务器' : '本机服务器已就绪';
  // keep focus in the field but do not raise the keyboard on its own on a touch device
  el.input.blur();
}

/** Boot the game client in this page (本地). Same module the default entry point loads. */
async function playLocal() {
  if (busy) return;
  const name = el.input.value.trim();
  if (!name) { setMode('local'); el.input.focus(); return; }
  busy = true;
  el.root.classList.add('is-busy');
  el.bootText.textContent = 'LOADING SIMULATION';
  el.bootErr.textContent = '';
  try {
    const title = await import('/js/screens/title.js');
    await import('/js/main.js');
    const ok = title.enterSession(name);
    if (!ok) {
      busy = false;
      el.root.classList.remove('is-busy');
      el.hint.textContent = '请输入 1–12 字的有效代号';
      el.input.focus();
      return;
    }
    gameLoaded = true;
    // main.js renders the client into #app: reveal it, show its boot overlay while it starts, and retire the shell
    const app = document.getElementById('app');
    const boot = document.getElementById('boot');
    if (app) app.style.display = '';
    if (boot) { boot.style.display = ''; boot.removeAttribute('aria-hidden'); }
    el.root.style.display = 'none';
  } catch (e) {
    busy = false;
    el.root.classList.remove('is-busy');
    el.bootErr.textContent = `无法载入游戏客户端：${e?.message || e}`;
  }
}

/** Verify the link and hand it to the app (远程). Never touches the field: it holds the link being read. */
async function connectRemote() {
  if (busy) return;
  setMode('remote', { clear: false });
  const url = normalizeLink(el.input.value);
  if (!url) { noticeInvalid(); return; }
  busy = true;
  el.root.classList.add('is-busy');
  el.bootText.textContent = 'CHECKING LINK';
  el.bootErr.textContent = '';
  const probe = await probeLink(url);
  busy = false;
  el.root.classList.remove('is-busy');

  if (probe.reachable) {
    openRemote(url);
    return;
  }
  // Not reachable from the app: the spec says to show it in a browser so the player can see the error / the
  // firewall or domain-authentication page, and then decide.
  dialog({
    mark: 'warn',
    title: '链接无法直接打开',
    body: `${probe.reason === 'timeout' ? '连接超时' : '无法连接到该地址'}：${url}\n\n`
      + '可能被防火墙或域名认证拦截。可先用浏览器打开查看报错或拦截页面，确认后再决定是否进入。',
    actions: [
      { label: '重新输入', kind: 'ghost' },
      {
        label: '用浏览器打开',
        kind: 'primary',
        onClick: () => {
          if (inApp()) android.openExternal(url);
          else window.open(url, '_blank', 'noopener');
        },
      },
      { label: '仍然进入', kind: 'secondary', onClick: () => openRemote(url) },
    ],
  });
}

function noticeInvalid() {
  dialog({
    mark: 'warn',
    title: '请输入有效链接',
    body: '链接需要形如 http://192.168.1.5:3000 或 https://example.com/?room=ABCD 的地址，也可以省略 http://。',
    actions: [{ label: '知道了', kind: 'primary' }],
  });
}

/** Recover from an unexpected failure while entering a game (the shell must never dead-end). */
function showLoadError(e) {
  busy = false;
  el.root.classList.remove('is-busy');
  el.bootErr.textContent = String(e?.message || e);
}

/** Hand a verified remote link to the app (stops the local server) or navigate there in a plain browser. */
function openRemote(url) {
  if (inApp() && typeof android.openRemote === 'function') {
    el.bootText.textContent = 'CONNECTING REMOTE';
    el.root.classList.add('is-busy');
    android.openRemote(url);
    return;
  }
  // Browser fallback (LAN use: a friend opened http://<host>:3000/connect on their own machine)
  location.href = url;
}

// ---------------------------------------------------------------------------------------------------
// dialog
// ---------------------------------------------------------------------------------------------------

function closeDialog() {
  el.dialog.hidden = true;
  el.dialogActs.textContent = '';
}

function dialog({ mark = 'info', title, body, actions = [] }) {
  el.dialogMark.style.borderColor = mark === 'warn' ? 'var(--amber)' : 'var(--mint-500)';
  el.dialogMark.style.background = mark === 'warn' ? 'var(--amber-a20)' : 'var(--mint-a20)';
  el.dialogTitle.textContent = title;
  el.dialogBody.textContent = body;
  el.dialogActs.textContent = '';
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn btn--${action.kind || 'secondary'} btn--lg`;
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      closeDialog();
      action.onClick?.();
    });
    el.dialogActs.appendChild(btn);
  }
  el.dialog.hidden = false;
}

// ---------------------------------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------------------------------

function wire() {
  buildLabel();
  drawEmblem();

  el.local.addEventListener('click', () => {
    // first tap only chooses the mode (the spec's "再次点击本地按键，进入后续界面")
    if (mode !== 'local') { chosen = true; setMode('local', { clear: false }); return; }
    playLocal().catch(showLoadError);
  });
  el.remote.addEventListener('click', () => {
    if (mode !== 'remote') { chosen = true; setMode('remote', { clear: false }); return; }
    connectRemote().catch(showLoadError);
  });
  // Typing pre-chooses a side while the player has not tapped a button yet; after an explicit choice it only fills
  // the field. The field itself is never touched here, so a pasted link survives the switch.
  el.input.addEventListener('input', () => {
    el.hint.textContent = '';
    if (chosen) return;
    const value = el.input.value;
    if (!value) return;
    const asLink = !!normalizeLink(value) && value.trim().length > NAME_MAX;
    setModeQuiet(asLink ? 'remote' : 'local');
  });
  el.input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    if (mode === 'remote') connectRemote().catch(showLoadError);
    else playLocal().catch(showLoadError);
  });
  window.addEventListener('hashchange', applyHash);
  applyHash();
}

/** setMode while the player is typing: never touch the field, never override a deliberate choice. */
function setModeQuiet(next) {
  if (!next || next === mode || busy) return;
  setMode(next, { clear: false });
}

/** `#remote=<url>`, or the link the app was opened with (Android bridge), pre-fills the remote side. */
function applyHash() {
  const hash = String(location.hash || '');
  let url = hash.startsWith('#remote=') ? decodeURIComponent(hash.slice('#remote='.length)) : '';
  if (!url && appMode() === 'remote') {
    try { url = (android.initialUrl && android.initialUrl()) || ''; } catch { url = ''; }
  }
  if (!url) return;
  setMode('remote');
  el.input.value = url;
  el.hint.textContent = '已填入链接，点击「远程」连接';
}

// The shell only makes sense on the machine itself: a LAN visitor gets the game's default entry point.
if (!isLoopbackHost() && !inApp() && !location.hash) {
  location.replace('/');
} else {
  wire();
}
