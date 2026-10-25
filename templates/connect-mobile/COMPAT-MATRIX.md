# 兼容矩阵与 feature packs

运行时 overlay `connect-runtime@2.0.0`，packs `version 1`，共 **11 个 feature / 62 个锚点**。默认 profile `connect-runtime`。

## Feature

| id | 作用 | 锚点 | 依赖 | 漂移时 | 通知 |
|---|---|---:|---|---|---|
| `guide` | 远程指南按钮/页面、lobby 入口 | 12 | - | UI 面板内“指南”标签 | 是 |
| `css` | `public/index.html` 引入 `connect.css` | 1 | - | title/settings 依赖它，缺失时一并 skip | 否 |
| `title` | 标题页“本地/远程”双入口、远程指南按钮 | 3 | `guide`, `css` | 浮动“远程”按钮 + 独立面板 | 是 |
| `settings` | 设置弹窗“远程连接”区 | 2 | `css` | 设置列表注入行 + 独立面板 | 是 |
| `stats-tab` | 统计页真第五页签“远程记录”、来源 chip | 9 | - | 统计头部“远程记录”按钮 + 独立面板 | 是 |
| `stats-src` | `ui/stats.js` 透传记录 `src` | 2 | - | 远程面板按服务器分组显示 | 是 |
| `export` | `downloadText/doExport` 同步兜底 | 2 | - | boot 拦截 Blob 的主路径仍有效 | 否 |
| `i18n` | en/ja/ko/zh-TW 增加“远程记录/远程/导出失败” | 4 | - | 中文原文 | 否 |
| `board-runtime` | boardArt/board3d 有界重试、3D 诊断 | 9 | - | 上游原始加载（无重试） | 是 |
| `board` | app.js/assets.js 诊断、GPU 放宽、3D 回退 | 14 | - | 上游原始渲染 | 是 |
| `ui-extras` | 棋盘/商店图片预加载与优先级 | 4 | - | 无（可选优化） | 否 |

应用规则：

- 每个 feature 的全部锚点必须在**内存模拟文本**中各自唯一命中；否则整个 feature `skipped`，不写盘、不部分应用。
- `requires` 在写盘前检查；依赖未应用则本 feature 也 `skipped`（例如 `guide` 缺失时 `title` 不会留下缺失的 `RemoteGuideButton` import）。
- 全锚点命中后写盘；再检查 `markers`，缺失记 `degraded`（APK 仍带该 feature，但提示）。
- build 将结果写入 `public/sp-extension/features.json`，运行时 `ui.js` 只对 `skipped` 的 feature 安装 fallback；全 applied 时不介入。

## Core

| core 项 | 内容 | 失败结果 |
|---|---|---|
| `source` | 上游 `package.json`、`server/index.js`、`public/index.html`、`data/*`、git/快照身份 | blocked |
| `assets` | 素材清单/目录/本地素材合并 | blocked |
| `overlay` | 辅助文件复制、旧锚点（若有）、feature packs 引擎 | blocked |
| `injected-tests` | staging 内 wrapper/extension 冒烟测试 | blocked |
| `certificate` / `signature` | keystore 指纹、APK v1/v2/v3 | blocked |
| `apk-verification` | 24 项 APK 检查 | blocked |
| `source-integrity` | 构建前后源目录 hash/commit+status 一致 | blocked |

## 上游版本

| 上游 | 预期 |
|---|---|
| `0.2.2` – `0.3.x` | 进入 packs；0.3.1 实测 11/11 applied |
| `0.3.x` 后续补丁 | 逐 feature 尝试；UI 漂移则对应 `skipped` + fallback；core 通过即出包 |
| `0.4+` / 新 major | 不再被 `sourceVersion` 上限拒绝，进入同一流程；`startServer`/`/ws`/wrapper 契约测试失败则 blocked |
| `< 0.2.2` | overlay 直接拒绝（blocked） |

旧 `connect@1.1.11` overlay 保留为显式兜底，不由工作台自动切换。

## 通知与退出

| 状态 | 默认退出 | `--strict` | 产物 |
|---|---:|---:|---|
| `success` | 0 | 0 | APK + 全部报告 |
| `degraded` | 0（控制台警告） | 1 | APK + `compat-report` + `BUILD-NOTICE` |
| `blocked` | 1 | 1 | 不写入新 APK；`failure-report`/`last-failure` |

## 0.3.1 基线

- overlay `connect-runtime 2.0.0`，packager `1.3.0`。
- 300115：11/11 applied，`degraded: []`，APK 24/24。
- 300116（漂移副本）：7/11 applied，`title/settings/stats-tab/board` skipped，运行时 fallback 生效。
- 300117：漂移复建，7/11 applied；fallback 设置行只注入可见列表并定时补装，入口改为右侧竖排，避免遮挡主操作。
