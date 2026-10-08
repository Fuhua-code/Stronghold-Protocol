# 故障排查

## doctor 报 master 不正确

`masterDir` 必须是 Git 工作树，当前分支必须精确为 `master`。提交或清理未提交文件后重试。打包器不会自动 stash 或覆盖这些文件。

## 缺少资源或 vendor

在 `dependencyDir` 完成依赖安装和 vendor 生成；大型资源应放入 `assetsDir/public/assets`、`assetsDir/public/fonts`，并确保 `data/assets.json` 中的每个 URL 都存在。打包器不会替换、删除或静默下载资源。

## runtime cache 缺失

先使用现有 Android 打包器准备 `mobile/build/runtime`、`mobile/build/termux` 和 `mobile/build/licenses`，再运行 `packager.cmd bootstrap`。缓存只读复制到 staging，缺失时构建直接停止。

## 覆盖层冲突

查看失败时保留的 staging 路径和补丁诊断。检查上游对应文件是否改变了稳定上下文；确认后更新 `overlays/connect/patches`、锚点和 manifest 支持范围。不要忽略冲突继续生成 APK。

## 签名或无法覆盖安装

确认 keystore、alias、两个密码和 `certificateSha256`。证书指纹可用 `keytool -list -v` 或 `apksigner verify --print-certs` 检查。更换密钥会使 Android 把包视为新应用，不能覆盖旧安装。

## 模拟器 ABI

真实 ARM64 手机使用默认包；MuMu、LDPlayer 等 x86_64 模拟器使用 `packager.cmd build --profile connect --abis arm64-v8a,x86_64`。报告中的 `runtimeAbis` 必须包含目标设备 ABI。

