# Stronghold Protocol 独立 Android 打包器

本仓库 `Fuhua-code/Stronghold-Protocol` 是独立静态工作台，与游戏 `master` 分开。工作台读取外部上游工作树，把源码、素材和 Android 运行时复制到 staging，再应用 `connect-runtime` overlay/feature packs 生成 APK；不会拉取、切换、写入或修改上游。

- 默认 profile `connect-runtime`：本地游玩、远程入口/记录、启动期存储/导出桥、可选 UI fallback。
- `connect` legacy profile：旧 1.1.11 overlay，显式 fallback。
- `master` profile：纯上游包，不含联机扩展。

## 文档

- [使用指南](usage.md)
- [每日上游 Release 自动发布](automation.md)
- [上游更新与兼容](upgrade-master.md)
- [故障排查](troubleshooting.md)
- [兼容矩阵](COMPAT-MATRIX.md)
- [工作台细节](WORKBENCH.md)

## 快速开始

1. Node 22+、JDK 17+、Android SDK（build-tools 35、android-35）、Git、curl、unzip、tar、xz。
2. 复制 `packager.config.example.json` 为 `packager.config.json`，填写上游/依赖/素材/runtime/工具链/keystore。
3. 复制 `workbench.config.example.json` 为 `workbench.config.json`，设置 `upstreamDir` 和本地策略。
4. 设置 `PACKAGER_STORE_PASSWORD`、`PACKAGER_KEY_PASSWORD`。
5. 运行 `packager.cmd doctor`，然后 `packager.cmd workbench`。

签名、密码、素材、runtime、APK、日志和 staging 均被 `.gitignore` 排除，不应提交。
