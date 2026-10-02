# 安卓 APK · Android build

把本仓库打包成**独立可玩的安卓应用**：APK 里同时带着 Node.js 运行时（**Termux 的 Node 24 LTS**）、游戏数据和
全部美术 / 音频，装上就能玩，不需要电脑、不需要联网（第一次进游戏也不用下载素材）。同一局域网里的朋友用手机
分享的地址即可联机，玩法和桌面版一致。

> 这是玩家自制的**非官方同人作品**，与鹰角网络、Yostar 无关；《明日方舟》及「卫戍协议」相关素材版权归原权
> 利人所有，**不适用**本项目的 GPL，仅供学习交流与个人非商业使用，**严禁任何形式的盈利**。APK 请勿上架
> 应用商店、请勿售卖。（完整声明见仓库根目录的 [README](../README.md) 与 [NOTICE](../NOTICE.md)。）

## 一、安装与游玩

| 步骤 | 说明 |
|---|---|
| 1. 安装 | 把 `mobile/build/Stronghold-Protocol-<版本>-android.apk`（约 352 MB）传到手机（数据线 / 聊天软件 / 网盘），点开安装。系统会提示「未知来源应用」，需要允许。 |
| 2. 首次启动 | 应用把约 262 MB 素材解压到自己的私有目录（实测约 3 秒，屏幕上有进度），随后启动 Node 服务器并自动打开游戏。以后启动是秒开。 |
| 3. 单人 | 输入代号 → 独立模拟 → 开始。 |
| 4. 联机 | 同盟模拟 → 创建房间 → 把「同盟密钥」或「复制链接」发给朋友；朋友在同一 Wi-Fi 下打开应用（或任意浏览器）输入链接即可。启动日志里会打印手机自己的局域网地址。 |
| 5. 横屏 | 游戏需要横屏；应用已锁定横屏。 |

**系统要求**：Android 7.0（API 24）或更高、**arm64-v8a**（Termux 只提供 aarch64 的 Node 包）、系统 WebView 可
更新。手机上需要约 **650 MB** 空闲空间（安装包 + 首次解压约 262 MB）。

**与桌面版的差异**

| 项目 | 说明 |
|---|---|
| Node.js 版本 | **24.18.0（Termux 的 `nodejs-lts`，aarch64 预编译）**，与桌面版要求的 22+ 一致，服务器代码无需改动。 |
| 官方 3D 棋盘 | **不可用**。官方棋盘贴图需要用 Python + UnityPy 从本机《明日方舟》PC 客户端提取，手机上做不到；游戏自动使用 2D 棋盘（其余美术、Spine 小人、音乐音效都在 APK 里，与整合包一致）。 |
| 端口 | 手机是服务器，端口由系统分配（避开 Android 的低端口限制），启动日志与游戏内都会显示实际地址。 |
| 应用签名 | 自签名（`mobile/keystore/debug.keystore`，脚本首次构建时生成）。更新必须用同一个密钥重新签名，否则 Android 会拒绝覆盖安装。 |
| 后台与息屏 | 游戏期间保持屏幕常亮；切到后台时页面会被暂停，服务器仍在运行，队友按原有「断线 / 暂离」机制继续。 |
| 反作弊抽查 | `SP_VERIFY` 与 `SP_COMBAT` 仍按原样工作，未做改动。 |

## 二、为什么不是 nodejs-mobile（Node 18）

第一版用 nodejs-mobile 的 `libnode.so`（官方预编译的 **Node 18.20.4**）加一个 JNI 外壳，在真机上无法启动：

1. **GWP-ASan TLS 解析失败** —— 外壳与 `libnode.so` 各自带一套 C++ 运行时，Android 16 的动态链接器拒绝解析
   `_ZZN8gwp_asan15getThreadLocalsEvE6Locals`（`TLS symbol … using IE access model`），进程在 `FORTIFY` 里被
   静默 abort；
2. 即使强行换用共享 libc++，Node 18 也低于 `package.json` 要求的 22。

所以改成 **Termux 的 Node 24**：它就是一个普通的 PIE 可执行文件加几个共享库，不需要 JNI，也不与 Android 的
C++ 运行时冲突。**这是本项目在安卓上跑 Node 22+ 的唯一可行路径**（自编译 libnode 需要完整 Node 构建链）。

## 三、构建

```bash
npm install                 # 依赖（postinstall 会生成 public/vendor）
node tools/fetch-assets.mjs # 美术 / 音频（约 250 MB，可中断续传）
node mobile/build-apk.mjs   # 产出 mobile/build/Stronghold-Protocol-0.1.0-android.apk
```

首次运行 `build-apk.mjs` 会准备两类东西：

| 组件 | 来源 | 用途 |
|---|---|---|
| JDK 21 | Adoptium（自动下载到 `.toolchain/`） | `javac` / `d8` / `apksigner` 的运行时 |
| Android SDK cmdline-tools | Google | 安装下面两个包 |
| build-tools **36.0.0** | Google | `aapt2` / `d8` / `zipalign` / `apksigner`（**34.0.0 的 d8 有 bug**：遇到匿名内部类会抛 `NullPointerException`，35+ 已修复） |
| platform android-34 | Google | 编译 Activity 用的 `android.jar` |
| **Node 24.18.0** | `packages.termux.dev` 的 `nodejs-lts` | 运行游戏服务器 |
| Node 的运行库 | Termux：`libc++`、`openssl`、`c-ares`、`libicu`、`libsqlite`、`zlib` | `libc++_shared.so`、`libcrypto.so.3`、`libssl.so.3`、`libicu*.so.78`、`libcares.so`、`libsqlite3.so`、`libz.so.1` |

**不需要 Gradle、Android Studio、AndroidX、Kotlin 或 NDK**：整个 APK 由 `mobile/build-apk.mjs` 用这些命令行工具
直接组装，便于复现和审阅。

常用选项：

```bash
node mobile/build-apk.mjs --with-dev           # 额外带上 public/dev 开发页
node mobile/build-apk.mjs --skip-dex           # 只重打包资源（改了前端/素材时更快）
node mobile/build-apk.mjs --no-node            # 只做客户端壳（需要另有一台真实服务器）
node mobile/build-apk.mjs --toolchain=D:/android-tc
```

## 四、结构

```
mobile/
├─ build-apk.mjs            一条命令完成：工具链 → Termux Node 运行时 → 素材树 → aapt2 → javac → d8 → 打包 → 签名 → 核验
├─ node/main.js             移动端 Node 入口（★ 唯一新增的服务器侧文件；复用 server/index.js 的 startServer）
├─ android/
│  ├─ java/io/prts/stronghold/MainActivity.java   解压素材 → 运行 Node 24 → 轮询握手 → 打开 WebView
│  └─ res/mipmap-*/ic_launcher.png                图标（由 tools/make-icons.mjs 生成）
├─ tools/
│  ├─ verify-server.mjs     在本机以「移动端入口」启动服务器并逐项自检（HTTP、gzip、206、WebSocket、素材）
│  ├─ verify-apk.mjs        直接读 APK：校验每个条目的 CRC、解包 nodejs-project、用 Node 跑起来再测一遍
│  ├─ verify-client.mjs     用无头 Chrome/Edge 打开真实客户端，一路点到「开始模拟 → 准备就绪 → 休整期」
│  ├─ make-icons.mjs        生成图标
│  ├─ inspect-deb.mjs       查看 Termux .deb 的成员（开发辅助）
│  └─ download.mjs          工具链断点续传下载小工具
├─ keystore/                签名密钥（生成物，不入库）
└─ build/                   构建缓存与产物（生成物，不入库）
```

APK 内容：

```
AndroidManifest.xml      package io.prts.stronghold · minSdk 24 · targetSdk 34 · 横屏 · 明文流量
classes.dex              MainActivity
lib/arm64-v8a/
  node                   Node 24.18.0（可执行文件；Android 只会把 lib/** 解压成可执行的原生库目录）
  libc++_shared.so libcrypto.so.3 libssl.so.3 libicu*.so.78 libcares.so libsqlite3.so libz.so.1
res/**                   图标（由 aapt2 编译；打包脚本保留资源表引用的每个文件）
assets/nodejs-project/
   mobile/node/main.js   入口
   node_modules/ws       服务器唯一依赖（含 package.json 的 exports 映射到 wrapper.mjs）
   server/ shared/ data/ docs/research/     与 Docker 镜像同一套运行时文件
   public/               客户端：js/ css/ vendor/ fonts/ assets/（约 262 MB 素材）
```

**运行时流程**：`MainActivity` 首次启动把 `assets/nodejs-project` 解压到 `filesDir`（更新时按
`public/ASSETS-VERSION` 判断是否需要重解压素材）→ 用 `ProcessBuilder` 启动 `lib/arm64-v8a/node`
（`LD_LIBRARY_PATH` 指向 `nativeLibraryDir`；若直接 exec 被 W^X 拒绝，则自动改走
`/system/bin/linker64 <node>`）→ `main.js` 用**未改动**的 `startServer()` 在 `0.0.0.0:0` 上监听，自检
`/healthz` 与一次 `/ws` 升级成功后写 `handshake.json` → Activity 轮询到端口后让 WebView 打开
`http://127.0.0.1:<端口>/`。客户端与服务器同源，WebSocket、音频、触摸、安全区（刘海屏）行为与手机浏览器一致。

## 五、真机调试

```bash
adb install -r mobile/build/Stronghold-Protocol-0.1.0-android.apk
adb logcat -s StrongholdProtocol      # 应用的全部状态 + Node 的 stdout + WebView 的 console
```

日志里能看到（真机实测）：

```
copy: apkChanged=true needCode=true needArt=true
program copied in 391 ms
art copied in 2531 ms
node: [mobile] listening on 0.0.0.0:37305 (healthz 200, websocket ok)
server ready on http://127.0.0.1:37305/  lan=http://172.30.243.175:37305  node=24.18.0
WebView loading http://127.0.0.1:37305/
```

**排错对照表**

| 现象 | 原因 / 处理 |
|---|---|
| 安装时报「应用未安装 / 签名不一致」 | 之前装过用别的密钥签名的版本：`adb uninstall io.prts.stronghold` 后重装。 |
| 卡在「正在解压美术与音频…」 | 属正常，约 4000 个文件 / 262 MB；确认剩余空间 ≥ 650 MB。 |
| 卡在「正在启动本机服务器…」后显示错误页 | `adb logcat -s StrongholdProtocol` 看 Node 的报错；多为素材解压不完整 → 「设置 → 应用 → 清除数据」后重开。 |
| 「Node 运行时缺失」 | APK 是用 `--no-node` 构建的（客户端壳），需要用默认参数重新构建。 |
| 朋友连不上 | 确认在同一 Wi-Fi；访客网络常开启「AP 隔离」会禁止设备互访；把日志里的局域网地址或房间链接发给对方即可，不需要端口转发。 |
| 画面卡顿 | 游戏内「设置」里降低画质；低端机可用 `?render=fallback` 或不使用 3D 棋盘（本 APK 默认即为 2D）。 |

## 六、验证

```bash
node mobile/tools/verify-server.mjs --json mobile/build/verify.json  # 移动端入口自检（每次改动后运行）
node mobile/tools/verify-apk.mjs                                    # 直接检查产出的 APK（见下）
node mobile/tools/verify-client.mjs --shots mobile/build/shots      # 无头浏览器跑真实客户端
node --test                                                         # 全套测试（Node 18/22/24 都应通过）
```

- `verify-server.mjs`：握手文件、临时端口、`/healthz`、全部静态路由、gzip 与 206 分支、路径穿越防护、
  `/ws` 升级与 `hello → welcome`、以及 `data/assets.json` 里**每一条**素材 URL 都能 200。
- `verify-apk.mjs`：逐条解压 `assets/nodejs-project/**` 并校验 CRC，然后把解出来的工程用本机 Node 按 Android
  传的同一组参数启动，再测页面、`/data.js`、`/sim/`、vendor、字体、gzip、206、`/ws` 与素材抽样。
- `verify-client.mjs`：用无头 Chrome/Edge 打开真实客户端并一路操作到休整期，断言零 console 错误、零
  pageerror、零失败请求、零 4xx/5xx。
- `build-apk.mjs` 打包时自己核验：素材完整断言、`apksigner verify`、`aapt2 dump badging`（包名 / SDK / 权限）、
  清单里每个 `@type/name` 都在资源表里、资源表引用的 `res/**` 文件都真的在 APK 里、`lib/**` 必须未压缩且 4 字节
  对齐，以及逐条核对 APK 条目。

### 实机验收结果（2026-10-03，realme RMX3820 · Android 16 / API 36）

| 检查 | 结果 |
|---|---|
| `adb install` | ✔ 成功（351.5 MB，v2+v3 签名） |
| 冷启动 | ✔ 解压程序 391 ms、解压素材 2531 ms，随后 Node 启动 |
| **Node 版本（实机）** | ✔ **24.18.0**（日志 `node=24.18.0`） |
| 本机服务器 | ✔ `listening on 0.0.0.0:37305 (healthz 200, websocket ok)` |
| 局域网地址 | ✔ 识别到两个网段（`172.30.243.175`、`10.4.59.67`） |
| 客户端 | ✔ WebView 打开 `http://127.0.0.1:37305/`，标题页显示「已连接服务器」，随后可进入「确认本局信息」 |
| 画面 | ✔ 横屏、HUD、领袖立绘、盟约图标、按钮全部正常渲染 |
| console 错误 | ✔ 无 |
| 二次启动 | ✔ `needCode=false needArt=false`（复用已解压素材，秒开） |
| 产物 | `Stronghold-Protocol-0.1.0-android.apk` · sha256 `f5be2fd6d75957b3f1d9dffec6a355cd2e96448f8ec0c162408a6f025ae5e06e` |

**尚未在真机上覆盖的部分**（需要人工操作）：完整打完一局（招募 → 部署 → 作战 → 结算）、音频输出、表情、
两人联机与断线重连、长时间后台。这些依赖触摸与听觉，建议按「一、安装与游玩」的步骤实际操作确认。

## 七、许可

`mobile/` 下的代码（含 `build-apk.mjs`、`MainActivity.java`、`main.js`）与本仓库其余代码一致，以
**GPL-3.0-or-later** 发布。打包进 APK 的第三方组件：

| 组件 | 许可 |
|---|---|
| Node.js 运行时与 Termux 的 Node 包（`node`、`libc++_shared.so`、openssl、c-ares、libicu、libsqlite、zlib） | Node.js 为 MIT；Termux 包各自沿用上游许可（openssl 为 Apache-2.0，libicu 为 ICU，zlib 为 zlib，c-ares 为 MIT，libsqlite 为公共领域） |
| `ws`、PixiJS、pixi-spine（含 Spine Runtimes 许可）、three.js、Preact、htm | 见仓库 [THIRD-PARTY-NOTICES](../THIRD-PARTY-NOTICES.md) |
| 《明日方舟》美术 / 音频 / 数据 | © Hypergryph / Yostar，**不适用** GPL，仅限非商业个人使用 |
