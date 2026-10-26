# 上游更新和覆盖层兼容

## 本地静态工作台

工作台不拉取、不切换、不修改上游。用户自行把上游 master/tag 放到 `workbench.config.json` 的 `upstreamDir`（或 `--master`），确认 `doctor` 通过后运行 `packager.cmd workbench`。CI 也是先用 `git fetch --depth=1` 检出上游 Release tag，再以只读方式复制到 staging。

## 自动发布

每日 workflow 只跟随上游**正式 Release**；不跟随 master 每次提交。上游不发布 Release 时不会重复构建。指定 tag 诊断可用 `workflow_dispatch` 的 `release_tag`。

## 覆盖层与 feature packs

`overlays/connect-runtime/manifest.json` 声明 sourceVersion 范围与辅助文件契约；`packs.json` 逐个 feature 检查锚点：

- core/requiredPaths/marker 失败 → `overlay-contract-break`，构建阻断并更新反馈 Issue。
- 单个 feature 锚点不命中 → 只跳过该 feature；settings/stats 使用内联 fallback，APK 仍可构建。
- `title`/`guide` 已从锚点 packs 移除：初始界面由 overlay 原样携带 300115 的 `title.js`/`guide.js`/`title.css` 等 6 个文件；`title-files.json` 校验 SHA256，并检查旧标题依赖的公开导出。缺失则 blocked，不会退回浮窗或重新做一套标题。
- `connect` 旧 overlay 保留为显式 fallback，不由工作台/CI 自动切换。

上游变化后先跑 `packager.cmd build --profile connect-runtime --master <新目录> --allow-dirty --version-code <临时值>`（或 CI 的 `dry_run`），查看 `compat-report.json`/`overlay-preflight.json`。需要完整 UI 时再补 packs 锚点，不要改上游源码。

## 素材与 runtime

CI 使用上游 Release 完整 zip 中的 `public/assets`/`public/fonts`/`public/vendor`/`node_modules`，因此新版本素材无需另发 bundle。runtime 仍是固定 Release；升级 Node/Termux 时更新 `ci/inputs.json` 的 version/tag/file/sha256，并重新验证 APK。

## Pages

Pages 由 `feat/github-pages-standalone` 的独立 workflow 部署；`main` 只改打包器和自动化，不合并游戏源码。
