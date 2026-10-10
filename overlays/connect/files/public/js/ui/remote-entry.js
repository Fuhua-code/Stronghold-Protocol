// The upstream title keeps its own artwork/settings. Only loopback receives this entry panel.
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button, TextField, confirmDialog, alertDialog } from './components.js';
import { toast } from './toasts.js';
import { net, identity } from '../net.js';
import { androidBridge, normalizeRemoteUrl, clearRemoteProxy } from '../connect.js';
import { selectRemoteTarget } from '../remote-session.js';


export function RemoteEntry({ initialName = '', onLocalStart, validateName, touchUi }) {
  const [mode, setMode] = useState(initialName ? 'local' : null);
  const [value, setValue] = useState(initialName);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    try {
      if (sessionStorage.getItem('sp-remote-resource-mode')) {
        sessionStorage.removeItem('sp-remote-resource-mode'); toast('远程连接已建立，正在使用本机资源');
      }
    } catch { /* private browsing */ }
    const event = async ({ detail }) => {
      if (detail?.kind === 'certificate') {
        const accepted = await confirmDialog({ title: '链接证书需要确认', micro: 'REMOTE CERTIFICATE',
          text: `该 HTTPS 证书无法通过验证，无法确认服务器身份。\n${detail.url}\n仅在你信任此地址时继续，本次确认不会关闭全局证书校验。`,
          okText: '仅本次继续', cancelText: '返回本地' });
        androidBridge()?.answerCertificate?.(String(detail.token), accepted);
      } else if (['error', 'invalid'].includes(detail?.kind)) {
        await alertDialog({ title: '远程页面无法打开', text: detail.message || '该页面未能显示游戏初始界面。', okText: '知道了' });
      }
    };
    window.addEventListener('sp-remote-event', event);
    return () => window.removeEventListener('sp-remote-event', event);
  }, []);
  const choose = async (next) => {
    if (busy) return;
    if (mode !== next) {
      if (mode) setValue(''); setMode(next);
      if (next === 'local') await clearRemoteProxy();
      return;
    }
    setBusy(true);
    try {
      if (next === 'local') {
        if (!validateName(value)) { toast('请输入博士代号', 'warn'); return; }
        const cleared = await clearRemoteProxy();
        if (!cleared.ok && androidBridge()) { toast('无法清除远程配置，请重试', 'warn'); return; }
        identity.clearToken(); net.reconnectNow(null); onLocalStart(value);
      } else {
        const url = normalizeRemoteUrl(value);
        if (!url) { toast('请输入合法的 HTTP / HTTPS 游戏地址，不能使用本机地址', 'warn'); return; }
        await selectRemoteTarget(url, { confirm: confirmDialog, resetIdentity: () => { identity.clearToken(); identity.setEntered(false); } });
      }
    } catch { toast('远程连接失败，请检查网络后重试', 'warn'); }
    finally { setBusy(false); }
  };
  const remote = mode === 'remote';
  return html`<div class=${`entry-console${remote ? ' is-remote' : ''}`}>
    <${TextField} label=${remote ? '链接地址' : '博士代号'} micro=${remote ? 'LINK ADDRESS' : 'CALLSIGN'} size="lg"
      icon=${remote ? 'link' : 'user'} value=${value} maxLength=${remote ? 2048 : 12} autoFocus=${!touchUi}
      placeholder=${remote ? '输入远程游戏地址' : '输入你的代号'} onInput=${setValue} onEnter=${() => choose(mode || 'local')} />
    <div class=${`entry-split${mode === 'local' ? ' is-local' : ''}${remote ? ' is-remote' : ''}`}>
      <${Button} variant="primary" size="xl" block=${true} class="entry-btn entry-btn--local" disabled=${busy}
        aria-pressed=${mode === 'local'} onClick=${() => choose('local')}>本地<//>
      <${Button} variant="primary" size="xl" block=${true} class="entry-btn entry-btn--remote" disabled=${busy}
        aria-pressed=${remote} onClick=${() => choose('remote')}>${busy && remote ? '正在连接' : '远程'}<//>
    </div>
  </div>`;
}
