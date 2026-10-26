# 每日上游 Release APK

`Upstream release APK` 位于默认分支 `main`，按 **每日 UTC 03:17** 检查上游 `sganggs/Stronghold-Protocol` 的最新正式 Release（GitHub schedule 为尽力调度，可能延迟）。它只临时检出上游 Release tag，不写入目标仓库 `master`，也不自动修改覆盖层。

## 触发

- 每日 schedule：无新 Release 时快速 skip。
- Actions → Upstream release APK → Run workflow：
  - `release_tag` 留空 = 最新正式版；可填 `v0.3.3` 等。
  - `force` = 重建同 tag 的草稿；**不会覆盖已正式发布的 Release**。
  - `dry_run` = 完成构建、签名与校验，只保留 14 天 artifact，不创建 Release。
- `main` 的 `cli/ci/templates/overlays/profiles` 变更触发 dry run，便于先验证打包器改动。

整个工作流按仓库串行（`concurrency`），避免并发分配相同 versionCode。

## 输入

- **源码**：`git fetch --depth=1` 上游 Release tag，检出为 `upstream-source` 的 `master`，校验 commit SHA。
- **检测元数据**：`detect` 上传 `outputs/detection.json` 为 `detection` artifact；`build` 先下载到 `outputs/`，`ci/inputs.mjs` 与 `ci/version.mjs` 都从该文件取上游 Release 资产和版本信息。
- **完整素材/依赖**：上游 Release 的 `Stronghold-Protocol-v<version>.zip`（例如 0.3.3 约 861 MB），内含 `public/assets`、`public/fonts`、`public/vendor`、`node_modules`；下载后校验 release `size` 与 `sha256` digest（若 GitHub 提供），解压并校验包版本。
- **Runtime**：固定 `android-runtime-node24.18.0-r1` Release（约 115 MB），按 `ci/inputs.json` 的 SHA256 和 `input-manifest.json` 逐文件校验。
- **工具链**：Ubuntu 22.04、Node 22.22.0、Temurin 17.0.14+7、build-tools 35.0.0、android-35；上游素材测试另装 Python 3 Pillow（`python3 -m pip install pillow`）；第三方 Action 按 commit SHA 固定。
- 旧 `android-assets-*` bundle 不再参与新流程，但历史 Release 资产保留。

## 成功：草稿 Release

构建成功（`status=success|degraded`）后创建/更新 **draft** Release：

- tag：`apk-<游戏版本>-<完整上游SHA>`
- name：`Android <version> · <sha8> · code <versionCode>`
- 正文：构建摘要（v0.3.3 起 7/10 feature applied 时列为 degraded），包含上游 Release 链接、版本/versionCode、profile/overlay、applied/skipped feature、APK SHA256、签名/APK 校验与 Actions 链接；**不复制上游长文，也不自动 publish**。标题页由 overlay 原样携带 300115 的 6 个旧文件，不随 packs 漂移。
- 资产：APK（约 1.35 GB）、`SHA256SUMS.txt`、`build-report.json`、`overlay-report.json`、`compat-report.json`、`apk-verify.json`、`overlay-tests.log`、`BUILD-NOTICE.txt`、`input-report.json`、`upstream-release.json`、`release-meta.json`。

已存在的成功草稿会在每日检测中跳过；`force` 只重建草稿。已正式发布的 Release 不会被自动覆盖，检测会直接 skip。

## 失败：Issue，不生成 Release

上游测试、输入下载/校验、overlay core、签名、APK 校验或发布校验失败时：

- 按上游 SHA 创建/更新一个反馈 Issue（同一 SHA 只维护一个）。
- Issue 包含分类（`overlay-contract-break`、`asset-missing-or-mismatch`、`toolchain/runtime-failure`、`signing-failure`、`apk-verification-failure`、`release-failure` 等）、脱敏错误摘要、Actions 日志/诊断 artifact 链接。
- **不创建、不修改任何 APK Release**；已有草稿/正式 Release 保留。
- 成功生成草稿后关闭对应 Issue；dry-run 成功不关闭生产 Issue。

## Secrets

仓库 Settings → Secrets and variables → Actions：

| Secret | 内容 |
| --- | --- |
| `PACKAGER_KEYSTORE_B64` | 既有 keystore 文件的 Base64 |
| `PACKAGER_KEY_ALIAS` | 既有 alias |
| `PACKAGER_STORE_PASSWORD` | 密钥库密码 |
| `PACKAGER_KEY_PASSWORD` | key 密码 |
| `PACKAGER_CERT_SHA256` | 已安装 APK 证书的 SHA256，64 位十六进制 |

keystore 只在 runner 临时目录解码，构建后删除；上游测试、APK 解包检查和报告不携带密码/Token。缺少 Secret 会失败并进入反馈 Issue。

权限：`detect`/`build` 需要 `contents: write` 才能读取尚未发布的 Release 草稿（GitHub 只向有写权限的 token 列出 drafts）；`publish` 需要 `contents: write`；`notify` 只需要 `contents: read` + `issues: write`。仓库管理员需允许 Actions 创建 Release/Issue。

## 版本

`versionCode` 历史来自所有 schema 2 成功 Release（**含草稿**），忽略失败 Issue 和旧无元数据 Release。新版本取 `max(SemVer 编码, 历史最大 + 1, 300118)`；首个 0.3.3 构建为 300118，之后 300119+。草稿计入历史，避免每日重复分配；正式 Release 优先，`force` 不覆盖。上限 2,100,000,000。

## Runner 与磁盘

完整 zip 约 861 MB，解压约 1.26 GB；staging、APK 和输出还会占数 GB。构建前清理非必要 runner 目录并输出 `df -h`；build job 上限 120 分钟，publish 30 分钟。若磁盘不足，工作流会明确失败，不会生成缺素材 APK。

## 分支与 Pages

`master` 由维护者自行同步上游；APK Actions 不修改它。Pages 继续由 `feat/github-pages-standalone` 的独立 workflow 管理，`main` 不合并游戏源码。
