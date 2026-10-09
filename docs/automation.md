# 上游自动 APK 发布

`Upstream connect APK` 位于默认分支 `main`。每 6 小时（UTC 00:17 / 06:17 / 12:17 / 18:17）读取上游 `master`；GitHub schedule 为尽力调度，可能延迟。它仅临时检出源码，不写回游戏 `master`，也不自动修改覆盖层。

## 触发与验收

Actions → Upstream connect APK → Run workflow。`upstream_sha` 留空检查最新上游；诊断时填完整 40 位 SHA。勾选 `dry_run` 时仍完成双 ABI 构建与签名验证，只保存 14 天 artifact，不发布 Release。`main` 的打包逻辑变更也触发 dry run。

成功 Release 标签是 `apk-<游戏版本>-<完整上游SHA>`。已发布 SHA 再次运行直接退出，不覆盖旧包。整个工作流串行执行，避免并发分配相同版本代码。Release 元数据记录成功 SHA，作为持久监测状态。

`versionName` 等于上游版本；`versionCode` 取 SemVer 编码、全部已发布自动 APK 的最高代码加一、既有发布迁移下限三者的最大值。同版本多个 SHA 递增；即使重建较旧版本也不能倒退。现有打包器 0.2.1 代码为 2001，因此自动发布从至少 2002 开始。旧 Release 不自动修改。超过 Android 的 2100000000 上限时禁止发布。APK 不保证逐字节可复现（签名和报告含时间）；固定来源、哈希和版本使输入与结果可追溯。

## Secrets

仓库 Settings → Secrets and variables → Actions：

| Secret | 内容 |
| --- | --- |
| `PACKAGER_KEYSTORE_B64` | 既有 keystore 文件的 Base64 |
| `PACKAGER_KEY_ALIAS` | 既有 alias |
| `PACKAGER_STORE_PASSWORD` | 密钥库密码 |
| `PACKAGER_KEY_PASSWORD` | key 密码 |
| `PACKAGER_CERT_SHA256` | 已安装版本证书的 SHA256，64 位十六进制 |

仅在构建步骤注入签名 Secret。密钥解码到 runner 临时目录；构建后即删除。上游与注入后的测试、APK 解包启动检查不继承密钥、密码或 Token。证书在签名前和 APK 签名后分别核验。签名启用 V1/V2/V3，缺少 Secret 时失败，不生成新密钥。

检查/构建 job 只有 `contents: read`；发布 job 有 `contents: write`；报告 job 有 `issues: write`。管理员需允许 Actions 创建 Release/Issue。失败 Issue 的通知遵循你的 GitHub 通知设置，可在仓库 Watch 中启用 Issues，并在 GitHub Notifications 中启用 Actions 失败通知。

## 固定资源与 runtime

冷 runner 从公开专用 Release 恢复完整资源与 Termux runtime，随后按提交在 `ci/inputs.json` 的 SHA256 和包内逐文件清单检查。既不信任同次下载的 checksum 来替代代码中的 pin，也不依赖本机缓存。资源清单必须和选定上游提交的 `data/assets.json` 字节一致；字体、3D、本地素材与 `local-assets.json` 共同检查。新版本没有已准备好的资源包时自动停止并报告。

维护者在本机已验证的资源目录上准备新包：

```text
node ci/make-input.mjs assets <完整资源目录> <游戏版本> outputs/new-assets <对应master目录>
node ci/make-input.mjs runtime <runtime缓存目录> node24.18.0-r1 outputs/new-runtime
```

上传 archive、`SHA256SUMS.txt`、`input-manifest.json` 至 `android-assets-<版本>` 或 `android-runtime-<runtime版本>` Release；再把生成 `pin.json` 的 tag/file/sha256 更新到 `ci/inputs.json`。已有资源 Release 不覆盖；资源变化时创建新的带修订号 tag。runtime 含原始 Node/native libraries、固定签名 Termux InRelease/index、deb 与许可文件；构建仍用仓库固定 Termux 公钥校验索引。新 runtime 必须更新版本与哈希。

Linux runner 使用 Ubuntu 22.04、Node 22.22.0、Temurin 17.0.14+7、SDK build-tools 35.0.0、android-35、系统 GnuPG/tar/xz。Actions 依赖按 commit SHA 固定；JDK 发行版与 SDK 版本由固定 Actions/官方安装源供应。完整资源约 555 MB、压缩输入约 421 MB，APK 为数百 MB；runner 至少应有约 8 GB 可用空间。工作流构建上限 75 分钟，下载上限 10 分钟；失败保留日志和报告，不上传 staging、keystore 或未签名 APK。

## 失败处理

| 分类 | 处理 |
| --- | --- |
| `overlay-contract-break` | 补丁冲突、版本范围或 marker 变化；这是破坏性更新，人工适配覆盖层 |
| `upstream-test-failure` | 上游或注入后测试/服务检查失败 |
| `asset-missing-or-mismatch` | 准备对应版本资源 Release，或核对 manifest/hash |
| `toolchain/runtime-failure` | 检查 SDK、固定 runtime 输入、下载服务、磁盘容量 |
| `signing-failure` | 核对 Secret、alias、证书；不要更换签名身份 |
| `apk-verification-failure` | 排查包内源码、资源、版本、ELF 或解包启动检查 |
| `release-failure` | 排查 Release 权限、上传、历史元数据或版本上限 |

同一上游 SHA 只创建一个 Issue，重试更新正文；成功发布后关闭对应 Issue。失败始终令 Workflow 失败，日志摘要脱敏。上传先创建 draft，全部产物齐全后才公开；失败草稿留作重试，旧成功 Release 不变。dry run 成功不关闭生产阻断 Issue。

## 分支与 Pages

默认分支变为 `main` 后，现有 PR 的目标分支无需改变。`master` 应由维护者快进同步上游；APK Actions 不修改它。Pages 继续保留在 `feat/github-pages-standalone`。`main` 保留 Pages 的手动部署工作流入口，它显式 checkout Pages 分支；Pages 分支的 push 触发也继续有效。游戏源码不会合并进 `main`。
