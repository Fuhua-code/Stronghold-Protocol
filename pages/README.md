# GitHub Pages 浏览器版

此分支基于上游 0.1.4，保留原版标题页、玩法说明、设置和大厅。Pages 只托管静态网页；游戏核心在浏览器 Worker 内运行，不需要在 Pages 部署 Node 服务。

- **单人**：输入博士代号并开始，在大厅选择独立模拟。下载页面和所需资源后，对局不依赖联机信令；本版未实现离线启动缓存。
- **联机房主**：在大厅选择同盟模式并创建同盟，将四位密钥或邀请链接发给同伴。房主浏览器托管对局，必须保持页面开启。关闭或刷新房主页面会结束房间，不迁移房主。
- **加入者**：打开同一网站，输入代号后用密钥或邀请链接加入。同盟成员可以短暂断线后重连；双方版本、协议及行为指纹必须一致。

公共 PeerJS 服务仅用于信令，实际联机数据走 WebRTC。Pages 优先尝试直连；配置了托管 TURN 时会按需获取短期凭据，并在直连失败后使用 relay。凭据接口只返回临时 `iceServers`，不向浏览器暴露 Hugging Face 或 Cloudflare 长期密钥。若接口不可用，仍回退到 STUN-only，单人模式不受影响。本版不提供外部 Node 服务器入口，也不改变 Android APP 的联机实现。

TURN 凭据由独立的 Hugging Face Space 通过 FastRTC 生成，Space 运行时 Secret 中保存 `HF_TOKEN`。客户端不记录 TURN 用户名、密码或 Token；直连和中继都失败时显示联机失败原因，房主同盟不会被误报为已关闭。

## 可复现构建

1. `npm ci` 安装锁定依赖并准备前端库。
2. 下载 `pages/resources.json` 指定的 `pages-assets-v0.1.4` Release 资源包，核对 SHA256，解压到 `.cache/pages-assets/`。
3. `npm run pages:test` 后执行 `npm run pages:build`，生成 `pages-dist/`，默认路径 `/Stronghold-Protocol/`。

本机完整资源已存在时，可执行 `npm run pages:build -- --assets=<包含 public/assets、public/fonts、data 的目录>`。生成目录和大资源不提交 Git；标准资源清单必须与游戏版本一致。

构建会包含本机提取的 3D 棋盘、标准美术及音频、字体和本地 UI 清单。素材属于原权利人，未纳入代码 GPL 授权，详见仓库素材声明和 THIRD-PARTY-NOTICES.md。

`pages.yml` 仅发布 `feat/github-pages-standalone`。资源包固定版本和校验值，Actions 从 Release 下载后构建、上传并部署 Pages，不合并到 master。修改游戏版本后须先校验新资源，再更新资源包版本及校验值。
