# 兼容矩阵与 frozen title

运行时 overlay `connect-runtime@2.1.0`，packs `version 1`，共 **10 个 feature / 47 个锚点**。默认 profile `connect-runtime`。标题页不再依赖 feature pack，而是由 overlay 内 300115 旧版 `title.js`/`guide.js`/`title.css` 等 6 个文件**原样替换**并由 SHA256 校验。

## Feature

| id | 作用 | 锚点 | 依赖 | 漂移时 | 通知 |
|---|---|---:|---|---|---|
| `title-ui` | 300115 旧版初始界面（本地/远程、远程指南、设置/统计/语言/素材）由 overlay 文件提供 | 0 | - | contract 缺失则 **blocked**，不生成失设计 APK | 否 |
| `css` | `public/index.html` 引入 `connect.css` | 1 | - | title/设置依赖它；applyExtension 仍强制注入 | 否 |
| `settings` | 设置弹窗“远程连接”区 | 2 | `css` | 设置列表注入行 + 独立面板 | 是 |
| `stats-tab` | 统计页真第五页签“远程记录”、来源 chip | 9 | - | 统计头部“远程记录”按钮 + 独立面板 | 是 |
| `stats-src` | `ui/stats.js` 透传记录 `src` | 2 | - | 远程面板按服务器分组显示 | 是 |
| `export` | `downloadText/doExport` 同步兜底 | 2 | - | boot 拦截 Blob 的主路径仍有效 | 否 |
| `i18n` | en/ja/ko/zh-TW 增加“远程记录/远程/导出失败” | 4 | - | 中文原文 | 否 |
| `board-runtime` | boardArt/board3d 有界重试、3D 诊断 | 9 | - | 上游原始加载（无重试） | 是 |
| `board` | app.js/assets.js 诊断、GPU 放宽、3D 回退 | 14 | - | 上游原始渲染 | 是 |
| `ui-extras` | 棋盘/商店图片预加载与优先级 | 4 | - | 无（可选优化） | 否 |

`title`/`guide` anchor pack 已删除；旧标题/指南文件直接替换，不能重复应用锚点。

应用规则：

- 每个 feature 的全部锚点必须在**内存模拟文本**中各自唯一命中；否则整个 feature `skipped`，不写盘、不部分应用。
- `requires` 在写盘前检查；依赖未应用则本 feature 也 `skipped`。
- 全锚点命中后写盘；再检查 `markers`，缺失记 `degraded`（APK 仍带该 feature，但提示）。
- build 将结果写入 `public/sp-extension/features.json`；运行时 `ui.js` 只对 settings/stats-tab 的 `skipped` 安装**内联** fallback，全 applied 时不介入。**不存在浮动远程按钮**。

## Core

| core 项 | 内容 | 失败结果 |
|---|---|---|
| `source` | 上游 `package.json`、`server/index.js`、`public/index.html`、`data/*`、git/快照身份 | blocked |
| `assets` | 素材清单/目录/本地素材合并 | blocked |
| `overlay` | 辅助文件复制、feature packs、**6 个旧标题文件 SHA256**、标题依赖导出 contract | blocked |
| `injected-tests` | staging 内 wrapper/extension/标题文件冒烟测试 | blocked |
| `certificate` / `signature` | keystore 指纹、APK v1/v2/v3 | blocked |
| `apk-verification` | 24 项 APK 检查 | blocked |
| `source-integrity` | 构建前后源目录 hash/commit+status 一致 | blocked |

`title-ui` 的文件与 contract 在 `overlays/connect-runtime/title-files.json`：
`title.js`、`guide.js`、`title.css`、`remote-entry.js`、`remote-guide.js`、`connect.css` 原样 SHA256；以及 `openStats`、`SettingsModal`、`LangToggle`、`identity`、`store`、`isValidName` 等上游导出。

## 上游版本

| 上游 | 预期 |
|---|---|
| `0.2.2` – `0.3.x` | 进入 packs；0.3.1 实测 10/10 applied（title-ui + 9 packs） |
| `0.3.x` 后续补丁 | 标题仍为 300115 旧版；stats-tab/stats-src/ui-extras 可 skipped，内联 fallback；标题/启动 contract 缺失则 blocked |
| `0.4+` / 新 major | 不因 sourceVersion 上限被拒绝；标题依赖或 core 契约失败则 blocked |
| `< 0.2.2` | overlay 直接拒绝（blocked） |

旧 `connect@1.1.11` overlay 保留为显式兜底，不由工作台自动切换。

## 通知与退出

| 状态 | 默认退出 | `--strict` | 产物 |
|---|---:|---:|---|
| `success` | 0 | 0 | APK + 全部报告 |
| `degraded` | 0（控制台警告） | 1 | APK + `compat-report` + `BUILD-NOTICE`（标题仍是旧版） |
| `blocked` | 1 | 1 | 不写入新 APK；`failure-report`/`last-failure` |

## 基线

- overlay `connect-runtime 2.1.0`，packager `1.4.0`。
- 300115：旧版设计（overlay 2.0.0 时代），11/11 applied。
- 300118：原样冻结 300115 的 6 个标题文件；10/10 applied，`degraded: []`，APK 24/24。
- 0.3.3 预期：title-ui + css/settings/export/i18n/board-runtime/board = 7/10 applied；stats-tab/stats-src/ui-extras skipped；标题不变，无浮窗。
