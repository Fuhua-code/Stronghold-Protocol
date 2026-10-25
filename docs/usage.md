# 使用指南

## 目录和配置

`upstreamDir`/`masterDir` 指向用户同步后的上游工作树。静态工作台只读取并复制，不 fetch、不切换、不写入上游。`dependencyDir` 提供 `public/vendor` 与 `node_modules/ws|acorn`；`assetsDir`/`completeAssetsDir`/`localAssetsDir` 提供 `public/assets`、`public/fonts` 和 `data/local-assets.json`；`toolchainDir` 需要包含 `jdk` 与 `android-sdk`。

`workbench.config.json` 控制 `upstreamDir`、`outputDir`、`stateDir`、默认 profile、`versionCodeFloor`、保留份数和 strict；`packager.config.json` 控制本机输入与签名。两者都不提交，示例见 `*.example.json`。密码只从 `PACKAGER_STORE_PASSWORD` 与 `PACKAGER_KEY_PASSWORD` 读取。

## 命令

```text
packager.cmd doctor
packager.cmd version
packager.cmd workbench
packager.cmd build --profile connect-runtime --version-code auto
packager.cmd build --profile connect-runtime --master <上游目录> --allow-dirty
packager.cmd build --profile connect                  # 旧 overlay fallback
packager.cmd verify --apk <APK绝对路径>
packager.cmd clean                                    # 只删 staging 和失败标记
```

`workbench` 先运行 doctor，再构建 `connect-runtime`，默认 `--version-code auto --keep 3`。产物在 `outputs/builds/<version>/<profile>/<versionCode>-<sourceHash>/`，包含 APK、`build-report.json`、`overlay-report.json`、`compat-report.json`、`BUILD-NOTICE.txt`、`apk-verify.json` 和 `SHA256SUMS.txt`。`state/latest.json` 指向最近一次构建，可能是 degraded。

## 版本

`versionCode` 本地单调递增：`auto` 取 `max(floor, 历史最后值 + 1)`；显式值不得低于历史最后一次。CI 从 300118 起，并把草稿 Release 计入历史；首次上游 0.3.x 构建为 300118，之后 300119+。旧 2004/300117 不会回退。

## 安装和测试

```text
adb install -r outputs/builds/<version>/<profile>/<code>-<hash>/Stronghold-Protocol-<version>-arm64-v8a-x86_64.apk
```

覆盖安装必须使用同一 keystore 和 alias。构建报告 `status` 为 `success` 或 `degraded`；degraded 表示部分 UI feature 使用了运行时 fallback，APK 仍可用。`apk-verify.json` 的所有 `checks[].ok` 必须为 `true`。失败时 staging 保留在 `.staging/<version>-<profile>-<code>-...` 供诊断，不修改上游。

## Agent 自动流程

运行 `doctor`、`workbench`，读取 `build-report.json`、`compat-report.json`、`apk-verify.json` 和 `SHA256SUMS.txt`。只有 `status` 为 `success|degraded`、签名指纹匹配且所有 APK 检查通过时才报告完成；degraded 必须同时报告 skipped feature。
