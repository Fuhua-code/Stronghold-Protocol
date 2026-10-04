# 卫戍协议：盟约 · 安卓打包器（Termux 封装）

把整个项目打包成**独立可玩的安卓 APK**：APK 里带着 Node.js 运行时（**Termux 的 Node 24 LTS**）、游戏数据和
全部美术 / 音频，装上就能玩 —— 不需要电脑、不需要联网（第一次进游戏也不用下载素材），同一局域网内可多人联机。

```bash
npm run apk
```

就这一条命令。首次运行会自己准备好一切（依赖、素材、Android 工具链、Node 运行时），从零到出包大约 10–20 分钟
（取决于网速）；之后重跑只需十几秒到一分钟。产物：

```
mobile/build/Stronghold-Protocol-0.1.0-arm64-v8a.apk     约 352 MB，v2+v3 已签名（默认：手机）
mobile/build/Stronghold-Protocol-0.1.0-arm64-v8a-x86_64.apk   约 440 MB（npm run apk:all：手机 + 模拟器）
```

文件名带 ABI，所以两种包可以在同一目录并存、互不覆盖。默认只打 arm64（手机就只需要自己那一套 ABI，Android 也
只会解压与设备相符的 `lib/<abi>/`）；要在 **x86_64 模拟器**（MuMu / 雷电 / 蓝叠 / Google AOSP 镜像）上跑，加
`npm run apk:all`。

> 这是玩家自制的**非官方同人作品**，与鹰角网络、Yostar 无关；《明日方舟》及「卫戍协议」相关素材版权归原权
> 利人所有，**不适用**本项目的 GPL，仅供学习交流与个人非商业使用，**严禁任何形式的盈利**。APK 请勿上架
> 应用商店、请勿售卖。（完整声明见仓库根目录的 [README](../README.md) 与 [NOTICE](../NOTICE.md)。）

---

## 一、命令一览

| 命令 | 作用 |
|---|---|
| `npm run apk` | **一键**：准备 + 构建 + 签名 + 核验，产出 APK（默认仅 arm64-v8a，手机用） |
| `npm run apk:all` | 同上，但同时打包 **arm64-v8a + x86_64**（模拟器用，+88 MB，文件名带 ABI） |
| `npm run apk:doctor` | 体检：主机、仓库、运行时来源、工具链、已连接手机，逐项给结论与下一步 |
| `npm run apk:check` | 自检：**不构建**，只验证「这个克隆能不能出包」（11 项） |
| `npm run apk:prepare` | 只准备（工具链 + Node 运行时 + 待打包目录），不打 APK |
| `npm run apk:verify` | 构建后跑三项验证：服务器自检 → APK 解包实跑 → 无头浏览器点到休整期 |
| `adb install -r mobile/build/Stronghold-Protocol-0.1.0-arm64-v8a.apk` | 装到手机 |
| `adb logcat -s StrongholdProtocol` | 看应用与 Node 的日志 |

`mobile/build-apk.mjs` 也直接接受参数：

```bash
node mobile/build-apk.mjs --all-abis              # 等于 npm run apk:all（arm64 + x86_64）
node mobile/build-apk.mjs --abi=x86_64            # 只打模拟器用的那一套
node mobile/build-apk.mjs --check                 # 等于 npm run apk:check
node mobile/build-apk.mjs --prepare               # 等于 npm run apk:prepare
node mobile/build-apk.mjs --with-dev              # 额外带上 public/dev 开发页
node mobile/build-apk.mjs --skip-dex              # 只重打包资源（改了前端/素材时最快）
node mobile/build-apk.mjs --out=D:/dist/game.apk  # 指定输出
node mobile/build-apk.mjs --no-fetch-assets       # 不下载素材（用占位图出包）
node mobile/build-apk.mjs --no-download           # 一律不联网下载，缺什么就报错
node mobile/build-apk.mjs --no-node               # 只做客户端壳（需要另有一台真实服务器）
```

---

## 二、它是怎么工作的

```
npm run apk
   │
   ├─ 0. 一键准备        node_modules 缺失 → npm install
   │                     public/assets 缺失 → tools/fetch-assets.mjs（约 250 MB，可续传）
   │
   ├─ 1. Android 工具链   JDK 21（Temurin）、SDK cmdline-tools、build-tools 36.0.0、platform android-34
   │                     全部下载到 <工作区>/.toolchain/，不写进仓库
   │
   ├─ 2. Node 运行时      Termux 仓库的 nodejs-lts（Node 24.18.0）+ libc++、openssl、c-ares、libicu、
   │                     libsqlite、zlib —— **按 ABI 各来一套**（aarch64 与 x86_64）；.deb 由脚本自己
   │                     解析（ar 容器 + xz 载荷）
   │
   ├─ 3. 待打包目录       mobile/build/nodejs-project/ = server/ + shared/ + data/ + docs/research/
   │                     + mobile/node/main.js + node_modules/ws + public/（客户端与全部素材）
   │
   ├─ 4. 编译             aapt2 compile/link（清单 + 图标 + 主题）· javac · d8（MainActivity → classes.dex）
   │
   ├─ 5. 运行时改名       node → libnode.so，libcrypto.so.3 → libcrypto.so …（Android 只解压 lib*.so 形状），
   │                     并就地改写 ELF 的 DT_NEEDED / DT_SONAME（tools/patch-elf-sonames.mjs）
   │
   ├─ 6. 打包             自写 ZIP 打包器：aapt2 的产物 + classes.dex + lib/<abi>/** + assets/**
   │                     全部未压缩存储，lib/**.so 4 字节对齐
   │
   ├─ 7. 签名             zipalign → apksigner（v2+v3，密钥 mobile/keystore/debug.keystore，首次自动生成）
   │
   └─ 8. 核验             apksigner verify · aapt2 dump badging/xmltree · 清单里每个 @type/name 都在资源表内
                          · 资源表引用的 res/** 都真的在 APK 里 · 每个 ABI 都带齐 node+9 个库 · 素材齐全
```

**手机上运行时**：`MainActivity` 首次启动把 `assets/nodejs-project` 解压到应用私有目录（实测约 3 秒），然后
用 `ProcessBuilder` 运行 `lib/arm64-v8a/node`（`LD_LIBRARY_PATH` 指向 `nativeLibraryDir`；若直接 exec 被
Android 的 W^X 拒绝，自动改走 `/system/bin/linker64 <node>`）。服务器用**未改动**的 `startServer()` 在
`0.0.0.0:0` 上监听，自检 `/healthz` 与一次 `/ws` 升级成功后写 `handshake.json`；Activity 轮询到端口后让
WebView 打开 `http://127.0.0.1:<端口>/`。客户端与服务器同源，WebSocket、音频、触摸、刘海屏安全区行为与手机
浏览器一致。

**游戏源码零改动**：服务器侧只新增 `mobile/node/main.js`（复用 `server/index.js` 的 `startServer`），
`server/`、`shared/`、`data/`、`public/` 全部原样打包（和仓库自带 Dockerfile 的运行时镜像同一套文件）。

### 为什么是 Termux 的 Node，而不是 nodejs-mobile

第一版用 nodejs-mobile 的 `libnode.so`（官方预编译的 **Node 18.20.4**）加一个 JNI 外壳，在真机上无法启动：

1. **GWP-ASan TLS 解析失败** —— 外壳与 `libnode.so` 各自带一套 C++ 运行时，Android 16 的动态链接器拒绝解析
   `_ZZN8gwp_asan15getThreadLocalsEvE6Locals`（`TLS symbol … using IE access model`），进程在 `FORTIFY` 里被
   静默 abort；
2. 即使换用共享 libc++，Node 18 也低于 `package.json` 要求的 22。

Termux 的 Node 24 是一个普通的 PIE 可执行文件加几个共享库：不需要 JNI，不与 Android 的 C++ 运行时冲突，
`process.version` 在手机上就是 **v24.18.0** —— 与桌面端同一个大版本。这是本项目在安卓上跑 Node 22+ 的可行路径。

---

## 三、产物结构

```
AndroidManifest.xml      package io.prts.stronghold · minSdk 24 · targetSdk 34 · 横屏 · 明文流量
classes.dex              MainActivity
lib/arm64-v8a/
  node                   Node 24.18.0 可执行文件（Android 只把 lib/** 解压成可执行的原生库目录）
  libc++_shared.so libcrypto.so.3 libssl.so.3 libicu*.so.78 libcares.so libsqlite3.so libz.so.1
res/**                   图标与主题（由 aapt2 编译，打包器保留资源表引用的每个文件）
assets/nodejs-project/
  mobile/node/main.js    移动端入口
  node_modules/ws        服务器唯一依赖（含 package.json 的 exports 映射）
  server/ shared/ data/ docs/research/
  public/                客户端：js/ css/ vendor/ fonts/ assets/（约 262 MB 素材）
```

---

## 四、安装与游玩

| 步骤 | 说明 |
|---|---|
| 1. 安装 | 把 APK 传到手机（数据线 / 聊天软件 / 网盘），点开安装。系统会提示「未知来源应用」，需要允许。 |
| 2. 首次启动 | 解压约 262 MB 素材（实测约 3 秒，屏幕上有进度），随后自动启动服务器并打开游戏。以后启动秒开。 |
| 3. 单人 | 输入代号 → 独立模拟 → 开始。 |
| 4. 联机 | 同盟模拟 → 创建房间 → 把「同盟密钥」或「复制链接」发给朋友；朋友在同一 Wi-Fi 下打开应用或任意浏览器即可。日志与应用界面里都有手机自己的局域网地址。 |
| 5. 横屏 | 游戏需要横屏；应用已锁定横屏。 |

**系统要求**：Android 7.0（API 24）或更高、**arm64-v8a（手机）或 x86_64（模拟器）**、系统 WebView 可更新。
手机上需要约 **650 MB** 空闲空间（默认安装包 352 MB + 首次解压 262 MB）；`npm run apk:all` 的双版本包为
440 MB。

**在安卓模拟器上跑**（MuMu / LDPlayer / BlueStacks / Google AOSP 镜像都是 x86_64）：

```bash
npm run apk:all                            # 手机 + 模拟器：一个 APK 里带两套运行时
adb connect 127.0.0.1:5555                 # MuMu 的调试端口（模拟器界面里可查；蓝叠/雷电常用 5555 / 7555）
adb -s 127.0.0.1:5555 install -r mobile/build/Stronghold-Protocol-0.1.0-arm64-v8a-x86_64.apk
```

也可以 `npm run apk && node mobile/build-apk.mjs --abi=x86_64` 分别出两个单 ABI 的包（各约 352 MB）。
模拟器内存建议 4 GB 以上（战斗在 WebView 里模拟）。

**与桌面版的差异**

| 项目 | 说明 |
|---|---|
| Node.js 版本 | 24.18.0（Termux `nodejs-lts`），与桌面版要求一致，服务器代码无需改动。 |
| 官方 3D 棋盘 | **不可用**：官方棋盘贴图要用 Python + UnityPy 从本机《明日方舟》PC 客户端提取，手机上做不到；游戏自动使用 2D 棋盘（其余美术、Spine 小人、音乐音效都在 APK 里）。 |
| 端口 | 手机是服务器，端口由系统分配（避开 Android 的低端口限制），启动日志与游戏内都会显示实际地址。 |
| 应用签名 | 自签名（`mobile/keystore/debug.keystore`，首次构建时生成）。更新必须用同一个密钥重新签名。 |
| 后台与息屏 | 游戏期间保持屏幕常亮；切到后台时页面暂停、服务器继续运行，队友按原有「断线 / 暂离」机制继续。 |

---

## 五、目录结构

```
mobile/                        ← 打包器（本分支新增，其他文件与上游一致）
├─ build-apk.mjs               打包器主体：--prepare / --check / 默认构建
├─ node/main.js                移动端 Node 入口（服务器侧唯一新增文件）
├─ android/
│  ├─ java/io/prts/stronghold/MainActivity.java   解压素材 → 运行 Node → 轮询握手 → 打开 WebView
│  └─ res/mipmap-*/ic_launcher.png                图标（tools/make-icons.mjs 生成）
├─ tools/
│  ├─ doctor.mjs               体检（npm run apk:doctor）
│  ├─ patch-elf-sonames.mjs    把 Termux 运行时改成 Android 合法的 lib*.so 命名并改写 ELF 的 NEEDED/SONAME
│  ├─ check-server.mjs         在本机以移动端入口启动服务器并逐项自检
│  ├─ check-apk.mjs            直接读 APK：逐条 CRC 校验、解包、用本机 Node 跑起来再测一遍
│  ├─ check-client.mjs         无头 Chrome/Edge 打开真实客户端，点到「开始模拟 → 准备就绪 → 休整期」
│  ├─ make-icons.mjs           生成图标（无依赖的 PNG 编码器）
│  ├─ inspect-deb.mjs          查看 Termux .deb 的成员（开发辅助）
│  └─ download.mjs             断点续传下载小工具
├─ keystore/                   签名密钥（生成物，不入库）
└─ build/                      构建缓存与产物（生成物，不入库）
```

---

## 六、真机验证记录

在 **realme RMX3820 · Android 16（API 36）· arm64-v8a** 上实测：

```
adb install -r mobile/build/Stronghold-Protocol-0.1.0-arm64-v8a.apk    # Success
adb shell am start -n io.prts.stronghold/.MainActivity

copy: apkChanged=true needCode=true needArt=true
program copied in 391 ms
art copied in 2531 ms
node: [mobile] listening on 0.0.0.0:37305 (healthz 200, websocket ok)
server ready on http://127.0.0.1:37305/  lan=http://172.30.243.175:37305  node=24.18.0
WebView loading http://127.0.0.1:37305/
```

| 检查 | 结果 |
|---|---|
| 冷启动 | ✔ 解压程序 391 ms、素材 2531 ms，随后 Node 启动 |
| **Node 版本（实机）** | ✔ **24.18.0**（日志 `node=24.18.0`） |
| 本机服务器 | ✔ `/healthz` 200、WebSocket ok |
| 局域网地址 | ✔ 识别到两个网段 |
| 客户端 | ✔ 标题页显示「已连接服务器」，可进入「确认本局信息」 |
| 画面 | ✔ 横屏、HUD、领袖立绘、盟约图标、按钮正常渲染 |
| console 错误 | ✔ 无 |
| 二次启动 | ✔ 复用已解压素材（`needCode=false needArt=false`），秒开 |

**尚未覆盖**（需要人工操作）：完整打完一局、音频输出、表情、两人联机与断线重连、长时间后台。建议按第四节
实际操作确认。

### 模拟器（MuMu Player · x86_64 · Android 12 / API 32）

同一份 APK 在 MuMu 上：

```
adb connect 127.0.0.1:5555
adb -s 127.0.0.1:5555 install -r mobile/build/Stronghold-Protocol-0.1.0-arm64-v8a-x86_64.apk    # Success
# 解压出的运行时（MuMu 只解压与自己 ABI 相符的一套）
lib/x86_64/: libnode.so libc++_shared.so libcrypto.so libssl.so libicuuc.so libicui18n.so
             libicudata.so libcares.so libsqlite3.so libz.so
```

启动后标题页正常显示并显示「已连接服务器」，与手机同样可玩。

**模拟器上曾经踩到的坑（已修）**：MuMu 是 x86_64，早先的 APK 只有 arm64-v8a，于是
`nativeLibraryDir` 里**一个运行时文件都没有**（应用报「Node 运行时缺失」）。更深一层的原因是 **Android 只解压
`lib*.so` 形状的条目**：可执行文件 `node`、以及 `libcrypto.so.3` / `libicu*.so.78` / `libz.so.1` 这类带版本后缀的
名字会被直接跳过（实测 10 个文件只落地 3 个）。打包器现在把运行时改名成 Android 合法的形状
（`node` → `libnode.so` 等）并就地改写 ELF 的 `DT_NEEDED` / `DT_SONAME`
（`tools/patch-elf-sonames.mjs`），10 个文件全部落地、可执行。

---

## 七、排错

| 现象 | 原因 / 处理 |
|---|---|
| `npm run apk` 报缺少素材 | 首次运行会自动下载；若被网络中断，`--no-fetch-assets` 也可出包（用占位图），或手动 `node tools/fetch-assets.mjs` 续传。 |
| 报 `xz is not available` | 解包 Termux 包需要 `xz`；Windows 10+ 自带 `tar`，`xz` 可用 `winget install xz` / `scoop install xz` 安装。 |
| 报 `no JDK 17+ found` 且无法下载 | 用 `--toolchain=<目录>` 指向已有 JDK/SDK，或设置 `JAVA_HOME`。 |
| 安装时报「签名不一致」 | 之前装过别的密钥签名的版本：`adb uninstall io.prts.stronghold` 后重装。 |
| 卡在「正在解压美术与音频…」 | 正常，约 4000 个文件 / 262 MB；确认手机剩余空间 ≥ 650 MB（默认 352 MB 安装包 + 262 MB 解压；双版本包为 440 MB）。 |
| 卡在「正在启动本机服务器…」后显示错误页 | `adb logcat -s StrongholdProtocol` 看 Node 报错；多为素材解压不完整 →「设置 → 应用 → 清除数据」后重开。 |
| 「Node 运行时缺失」 | ① APK 用 `--no-node` 构建的客户端壳 → 用默认参数重建；② 设备 ABI 不在包里（错误信息会列出包内 ABI 与本机 ABI）→ 加 `--abi=` 重建。模拟器请用默认双 ABI 构建。 |
| 朋友连不上 | 确认在同一 Wi-Fi；访客网络常开「AP 隔离」会禁止设备互访；把日志里的局域网地址或房间链接发给对方即可。 |
| 画面卡顿 | 游戏内「设置」降画质；低端机可用 `?render=fallback`。 |

---

## 八、许可

`mobile/` 下的代码（`build-apk.mjs`、`MainActivity.java`、`main.js` 及各工具）与本仓库其余代码一致，以
**GPL-3.0-or-later** 发布。打包进 APK 的第三方组件：

| 组件 | 许可 |
|---|---|
| Node.js 运行时与 Termux 的 Node 包（`node`、`libc++_shared.so`、openssl、c-ares、libicu、libsqlite、zlib） | Node.js 为 MIT；各 Termux 包沿用上游许可（openssl Apache-2.0、libicu ICU、zlib zlib、c-ares MIT、libsqlite 公共领域） |
| `ws`、PixiJS、pixi-spine（含 Spine Runtimes 许可）、three.js、Preact、htm | 见仓库 [THIRD-PARTY-NOTICES](../THIRD-PARTY-NOTICES.md) |
| 《明日方舟》美术 / 音频 / 数据 | © Hypergryph / Yostar，**不适用** GPL，仅限非商业个人使用 |
