# Stronghold Protocol Android Packager

独立 Android 打包器与上游自动发布工作流。`main` 只维护打包器和联机覆盖层；`master` 为上游游戏镜像。打包器不会修改源工作树，也不会自动修复上游破坏性接口变更。

- 本机使用：[打包器指南](docs/README.md)、[操作步骤](docs/usage.md)
- 自动发布：[GitHub Actions 部署与故障处理](docs/automation.md)
- 上游更新：[升级 master](docs/upgrade-master.md)

默认联机包保留本地游玩、局域网、远程 UI、严格地址/版本校验、本机素材复用 WebSocket 代理及 Android 证书人工确认回退。云端自动发布仅构建 `connect` 双 ABI；本机另支持纯 `master` profile。
