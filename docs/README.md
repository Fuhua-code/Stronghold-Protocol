# Stronghold Protocol 独立 Android 打包器

`Stronghold-Protocol-Packager` 是与上游游戏仓库分开的静态打包器。它读取外部的干净 `master` 工作树，把源码复制到临时 staging，再按 profile 生成 APK。打包器不会切换、拉取、写入或修改上游仓库。

默认命令生成 `connect` 联机 APK；`master` profile 生成只包含上游内容的纯 Android 包。APK 的 `versionName` 和资源清单来自 master，打包器版本记录在报告中独立维护。

## 快速开始

1. 安装 Node.js 22+、JDK 17+、Android SDK（build-tools 35、platform android-35）、Git、GnuPG、`tar` 和 `xz`。
2. 复制 `packager.config.example.json` 为 `packager.config.json`，填写 `masterDir`、工具链目录、资源目录和外置 keystore。
3. 设置签名密码：

   ```powershell
   $env:PACKAGER_STORE_PASSWORD = '本机密钥库密码'
   $env:PACKAGER_KEY_PASSWORD = '本机别名密码'
   ```

4. 在依赖工作树准备 `public/vendor`、`node_modules/ws`；如果本机还没有 runtime 缓存，准备一个包含 `runtime/`、`termux/`、`licenses/` 的外部目录，然后执行：

   ```text
   packager.cmd doctor
   packager.cmd bootstrap --source <已准备的 runtime/termux/licenses 目录>
   packager.cmd
   ```

成功后在 `outputs/<版本>/connect/` 得到 APK、SHA256、覆盖层报告、APK 检查报告和构建报告。

## 安全边界

打包器要求 master 分支且默认要求工作树干净；所有补丁和依赖处理都在 staging 中完成。密钥、密码、SDK、Node runtime、APK、日志和大型素材均被 `.gitignore` 排除，不应提交到打包器 Git。
