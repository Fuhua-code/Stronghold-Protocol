// The upstream title keeps its own artwork/settings. Only loopback receives this entry panel.
import { useState } from '../../vendor/hooks.module.js';
import { html, Button, TextField, confirmDialog, alertDialog } from './components.js';
import { toast } from './toasts.js';
import { net, identity } from '../net.js';
import { normalizeRemoteUrl } from '../connect.js';
import { selectRemoteTarget } from '../remote-session.js';

export function RemoteEntry({ initialName = '', onLocalStart, validateName, touchUi }) {
  const [mode, setMode] = useState(initialName ? 'local' : null);
  const [value, setValue] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const choose = async (next) => {
    if (busy) return;
    if (mode !== next) {
      if (mode) setValue(''); setMode(next);
      return;
    }
    setBusy(true);
    try {
      if (next === 'local') {
        if (!validateName(value)) { toast('请输入博士代号', 'warn'); return; }
        identity.clearToken(); net.reconnectNow(null); onLocalStart(value);
      } else {
        const url = normalizeRemoteUrl(value);
        if (!url) { toast('请输入合法的 HTTP / HTTPS 游戏地址，不能使用本机地址', 'warn'); return; }
        await selectRemoteTarget(url, { confirm: confirmDialog, alert: alertDialog });
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
