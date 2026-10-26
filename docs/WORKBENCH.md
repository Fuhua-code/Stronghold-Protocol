# 静态工作台：Android 打包器

这个目录是一个**离线静态工作台**。它不拉取、不切换、不修改上游仓库；上游源码由使用者放到 `workbench.config.json` 的 `upstreamDir`（默认 `../upstream-src`），打包器只读取并复制到 staging。

## 初始界面（冻结 300115）

初始界面不重新设计：`connect-runtime` overlay 原样携带 300115 APK 内的 6 个文件，并替换上游同名文件：

- `title.js`、`guide.js`、`title.css`
- `remote-entry.js`、`remote-guide.js`、`connect.css`

`title-files.json` 记录这些文件的 SHA256；构建时逐字校验，并检查旧标题依赖的上游公开导出（`openStats`/`SettingsModal`/`LangToggle`/`identity`/`store`/`isValidName` 等）。缺失或改动会 `overlay-contract-break` 阻断，不会退回浮窗或重新生成一套标题。`connect.css` 会由 `applyExtension` 幂等强制注入，确保远程入口样式始终加载。

## 一次性准备

1. 把上游 master（含或不含 `.git` 均可）放到 `upstreamDir`：
   - 含 `.git`：默认要求分支 `master` 且工作树干净；本地改动构建时需显式 `--allow-dirty`。
   - 无 `.git`（ZIP 快照）：自动使用 tree hash，构建后复核 hash 未变。
2. 在 `packager.config.json` 配置本机输入：`dependencyDir`（含 `public/vendor`、`node_modules/ws|acorn`）、`assetsDir` / `completeAssetsDir` / `localAssetsDir`、`runtimeCacheDir`、`toolchainDir`、`keystore`。
3. `packager.cmd doctor` 检查全部输入；缺件只报告，不下载。

## 一键出包

双击 `packager.cmd`（无参数）：

1. `doctor` 检查上游、素材、runtime cache、JDK/SDK、签名密钥；
2. 提示输入 keystore 密码（`PACKAGER_STORE_PASSWORD`；未输入 key 密码时复用）；
3. 构建 `connect-runtime`，`--version-code auto --keep 3`；
4. 打印产物/报告路径后暂停。

不会执行任何 `git fetch`、`git pull`、`git checkout` 或网络下载。

## 常用命令

```bat
packager.cmd doctor
packager.cmd version
packager.cmd workbench
packager.cmd build --profile connect-runtime --version-code auto --allow-dirty --master ..\upstream-drift
packager.cmd build --profile connect --version-code 300117
packager.cmd verify --apk outputs\builds\...
```

`build.mjs` 参数：

| 参数 | 作用 |
|---|---|
| `--profile <id>` | `connect-runtime`（默认）/ `connect`（旧 overlay 兜底）/ `master` |
| `--master <dir>` | 覆盖本次上游目录 |
| `--allow-dirty` | 允许 git 工作树有本地改动（doctor 始终允许并记录） |
| `--allow-any-source` | 强制按快照处理（无 `.git` 时自动启用） |
| `--version-code auto\|<n>` | 默认 auto；本地单调递增，显式值不得低于历史最后一次 |
| `--keep <n>` | 版本化产物保留份数（默认 3） |
| `--strict` | feature 降级时以非零退出（仍会产出 APK） |
| `--committed-assets-manifest` | 使用 git HEAD 的 `data/assets.json`（快照源不支持） |

## 目录

```text
workbench.config.json        上游路径、产物/状态目录、floor、保留数、默认 profile
packager.config.json         本机输入与签名（不包含网络地址）
cli/                         build / overlay / packs / wrapper / doctor / version / compat
overlays/connect-runtime/    旧版标题 6 文件 + 辅助文件 + feature packs（默认）
overlays/connect/            旧 overlay（80 锚点，显式兜底）
templates/connect-extension/ boot.js（存储/导出代理）、ui.js/connect.css（设置/统计内联 fallback）
templates/connect-mobile/    Android 壳、mobile Node wrapper、wrapper 测试
state/build-history.json     本地 versionCode 历史
state/latest.json            最近一次构建指针（可能是 degraded；交付版本以 BUILD-NOTICE/记录为准）
outputs/builds/<version>/<profile>/<versionCode>-<sourceHash>/
                             APK、build-report、overlay-report、compat-report、
                             BUILD-NOTICE.txt、apk-verify.json、SHA256SUMS.txt
outputs/0.3.1/...            旧版交付目录（不参与新构建覆盖）
```

## 兼容语义

- **core**：上游结构、依赖、overlay 辅助文件、注入测试、签名、APK 校验、源完整性。任一失败 = `blocked`，不覆盖旧产物，退出非零。
- **feature**：逐个 feature 在内存中匹配全部锚点；任一不命中则整个 feature 不写盘、状态 `skipped`，构建继续。marker 缺失记为 `degraded`（已应用但提示）。`title-ui` 为零锚点 feature，代表旧版标题文件已由 overlay 提供。
- **状态**：`success` / `degraded` / `blocked`。`degraded` 默认退出 0 并通知；`--strict` 退出非零。
- **通知**：控制台 + `BUILD-NOTICE.txt` + App 内一次性横幅（扩展读取 `sp-extension/features.json`）。
- **兜底**：`connect` 旧 overlay 可显式构建；settings/stats 使用内联 fallback，**不再创建浮动远程按钮**；标题/启动 contract 缺失直接 blocked。

## 上游更新后的处理

1. 将新 master 放到 `upstreamDir`（或 `--master` 指向新副本）。
2. 运行 `packager.cmd doctor`。
3. 运行 `packager.cmd workbench`（或双击）。
4. 若 `compat-report.json` 为 `degraded`，查看 `degraded[]` 与 `BUILD-NOTICE.txt`；APK 内对应入口使用兼容面板。
5. 若 `blocked`，报告给出失败 core 项；旧 APK 保留。需要新版本支持时再调整 packs/overlay，而不是先改上游源码。

## 已知边界

- 反代后上游看到的客户端地址是 `127.0.0.1`；wrapper 追加 `X-Forwarded-For/Proto`，上游若未来做 per-IP 限制需另行验证。
- UI 精确适配依赖少量可选锚点；漂移时降级为运行时面板，不保证与上游新 UI 观感完全一致。
- `board-runtime` / `board` 漂移时保留上游原始加载/渲染行为（无额外重试），并在通知中说明。
- 工作台不做任何网络拉取；素材、runtime、keystore、toolchain 必须本地预置。
