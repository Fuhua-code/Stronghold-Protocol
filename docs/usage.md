# 使用指南

## 目录和配置

`masterDir` 指向用户同步后的上游 `master`，不能指向联机分支。`dependencyDir` 提供已经准备好的 `public/vendor` 与 `node_modules/ws`；`assetsDir` 提供大体积美术、字体和 `data/local-assets.json`。`toolchainDir` 需要包含 `jdk` 和 `android-sdk`。

签名配置支持 `keystore`、`keyAlias`、`certificateSha256`，密码只从 `PACKAGER_STORE_PASSWORD` 与 `PACKAGER_KEY_PASSWORD` 读取。证书指纹必须与已安装 APK 一致，否则构建会停止，避免生成无法覆盖安装的 APK。

## 命令

```text
packager.cmd doctor
packager.cmd bootstrap
packager.cmd                         # connect + arm64-v8a
packager.cmd build --profile master
packager.cmd build --profile connect --abis arm64-v8a,x86_64
packager.cmd verify --apk <APK绝对路径>
packager.cmd clean                   # 删除 staging 和 outputs，保留 runtime cache
```

`master` profile 不使用远程入口、远程指南、探测接口、代理或独立远程 WebView；`connect` profile 在上游源码上应用版本化远程覆盖层，并使用联机 Android 模板。覆盖层按稳定锚点检查，冲突时停止并保留 staging 目录供诊断。

## 更新上游后的标准流程

用户先在上游目录执行：

```text
git fetch upstream
git switch master
git pull --ff-only upstream master
```

确认 `git status` 干净后回到打包器目录运行 `packager.cmd doctor` 和 `packager.cmd`。新的 `package.json.version` 自动成为 APK `versionName`；版本代码由 `major*1000000 + minor*1000 + patch` 计算，同一提交可重复构建。

## 安装和测试

```text
adb install -r outputs/<版本>/connect/Stronghold-Protocol-<版本>-arm64-v8a.apk
```

ARM64 包用于真实手机；MuMu 等 x86_64 模拟器使用双 ABI 命令。覆盖安装必须使用同一 keystore 和 alias。构建报告的 `status` 必须为 `success`，APK 检查报告的所有 `checks[].ok` 必须为 `true` 后再交付。

## Agent 自动流程

Agent 应依次运行 `doctor`、`build`，读取 `build-report.json`、`apk-verify.json` 和 `SHA256SUMS.txt`。只有 `status=success`、源分支为 `master`、源工作树为 clean、签名指纹匹配且所有 APK 检查通过时，才报告构建完成。失败时保留 `.staging/<版本>-<profile>-<pid>-<时间戳>`，修复原因后重新运行，不修改 master。

