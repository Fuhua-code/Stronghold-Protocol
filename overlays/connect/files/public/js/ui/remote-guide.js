// Existing mobile remote guide content, shared with the upstream viewer.
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, MicroLabel } from './components.js';
export function RemoteGuide() {
  const [info, setInfo] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/connect/info', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Connection information unavailable');
        const body = await response.json();
        if (!body.ok || !Array.isArray(body.lan)) throw new Error('Invalid connection information');
        if (!controller.signal.aborted) setInfo(body);
      }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, []);
  return html`<div class="guide__tips remote-guide">
    <section>
      <${MicroLabel} tone="mint">LAN // 局域网联机<//>
      <p>同一 Wi-Fi 或路由器下的设备，在本机初始界面选择“远程”，在“链接地址”处输入以下任一局域网链接，再次点击“远程”连接。</p>
      <div class="remote-guide__addresses">
        ${info ? info.lan.length ? info.lan.map((url) => html`<code key=${url} class="num">${url}</code>`)
          : html`<span class="t-lo">暂无局域网地址，请连接 Wi-Fi 后重新打开指南。</span>`
          : html`<span class="t-lo">${failed ? '无法读取地址，请查看后端终端的 LAN 地址。' : '正在读取本机局域网地址…'}</span>`}
      </div>
      ${info?.lanAvailable === false ? html`<p class="t-lo">当前服务仅允许本机访问。请让服务监听局域网接口后再联机。</p>` : null}
      <p>以上地址与后端终端的 LAN 输出一致。无法连接时，请检查防火墙是否允许游戏端口，以及路由器是否开启了访客网络或 AP 隔离。</p>
    </section>
    <section>
      <${MicroLabel} tone="mint">PUBLIC // 公网联机<//>
      <p>不在同一局域网时，由开服方使用内网穿透，将游戏服务${info ? `（本机端口 ${info.port}）` : ''}映射到公网；其他玩家输入穿透服务提供的公网 IP 与端口，或完整的 http / https 服务器地址。局域网地址不能直接用于公网连接。</p>
      <p>也可在云服务器部署游戏，并提供服务器地址。穿透或反向代理需支持 WebSocket（/ws），游戏应部署在域名根路径。若链接需要访问验证，先完成验证再连接。</p>
    </section>
    <section>
      <${MicroLabel} tone="mint">ALLIANCE // 加入同盟<//>
      <p>连接地址用于进入同一游戏服务器，同盟密钥用于选择该服务器内的房间。房主选择“同盟模拟”并创建房间，将同盟密钥或邀请链接发给同伴；同伴连接后输入博士代号，再加入同盟。所有玩家准备就绪后，由房主开始。</p>
    </section>
  </div>`;
}

