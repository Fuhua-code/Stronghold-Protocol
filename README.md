# Stronghold Protocol Android Packager

独立、离线的 Android 静态工作台与上游 Release 自动出包仓库。`main` 只维护打包器、运行时扩展和自动化；`master` 是游戏源码镜像，本仓库的 Actions 不修改它。

- 本机使用：[打包器指南](docs/README.md)、[操作步骤](docs/usage.md)
- 自动发布：[每日上游 Release APK](docs/automation.md)
- 上游更新：[升级与兼容](docs/upgrade-master.md)
- 兼容矩阵：[COMPAT-MATRIX.md](docs/COMPAT-MATRIX.md)

默认 profile 为 `connect-runtime`：本地游玩 + 远程入口/记录 + 启动期存储/导出桥 + 可选 UI feature packs。`connect` 旧 overlay 保留为显式 fallback，`master` profile 仅生成纯上游包。

GitHub Actions 每日检查上游 `sganggs/Stronghold-Protocol` 的正式 Release；有新版本时下载完整 Release zip 构建双 ABI APK。构建成功创建 **Release 草稿**（正文为构建摘要，不自动发布）；构建失败创建/更新反馈 Issue，不生成失败 Release。
