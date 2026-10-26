# 故障排查

## 每日运行被 skip

`detect` 发现目标仓库已有该上游 tag 的成功草稿或正式 Release。需要重建草稿时手动 dispatch 并勾选 `force`；已正式发布的 Release 不会被 `force` 覆盖。

## 下载完整 zip 失败

上游 Release 必须包含 `Stronghold-Protocol-v<version>.zip`（排除 lite/update）。检查 Release 资产名、大小、`sha256` digest、网络与 runner 磁盘。失败分类为 `asset-missing-or-mismatch`，不会生成缺素材 APK。

## runtime 校验失败

`ci/inputs.json` 固定 `android-runtime-node24.18.0-r1` 的 SHA256；检查目标仓库 Release 资产是否可下载、`input-manifest.json` 是否逐文件匹配。失败分类为 `toolchain/runtime-failure`。

## overlay 预检失败

`overlay-preflight.json` 报告 requiredPaths/marker 或 feature 状态。只有 core/requiredPaths 失败会阻断；feature skipped 是预期降级，会由运行时 `sp-extension` 提供 fallback，发布摘要会列出。破坏性更新需要人工适配 `overlays/connect-runtime`，不要忽略后强行出包。

## 构建成功但 feature 降级

0.3.2/0.3.3 的标题、指南、统计页签等 DOM 与 0.3.1 不同，但 `connect-runtime` 已用 300115 的 `title.js`/`guide.js`/`title.css` 等 6 个文件原样替换上游标题，初始界面保持不变；packs 为 7/10 applied（title-ui + css/settings/export/i18n/board-runtime/board），stats-tab/stats-src/ui-extras skipped。没有浮动远程按钮；设置/统计只保留内联兼容入口。若标题/启动 contract 缺失，构建会 blocked 而不是退回浮窗。

## 签名或无法覆盖安装

核对 `PACKAGER_KEYSTORE_B64`、alias、两个密码和 `PACKAGER_CERT_SHA256`。证书指纹可用 `keytool -list -v` 或 `apksigner verify --print-certs` 检查。更换密钥会让 Android 视为新应用。

## APK 校验失败

查看 `apk-verify.json` 的 `checks[].ok`、`failures`、runtime ELF unresolved、资源索引和包名/版本。CI 只在全部通过时创建草稿；失败生成/更新反馈 Issue。

## 发布权限/上传失败

publish job 需要 `contents: write`；notify job 需要 `issues: write`。Release 单资产上限 2 GB，APK 约 1.35 GB，上传超时 900 s。失败草稿保留供重试。

## 本地 doctor 报上游/素材缺失

工作台不下载。按 `workbench.config.json`/`packager.config.json` 准备上游、vendor/node_modules、完整素材、runtime cache、JDK/SDK 与 keystore，再运行 `packager.cmd doctor`。

## 模拟器 ABI

CI 与默认本地构建均为 `arm64-v8a,x86_64`。真实 ARM64 手机与 MuMu 等 x86_64 模拟器均可安装；覆盖安装必须使用同一签名。
