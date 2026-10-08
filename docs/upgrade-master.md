# 上游 master 更新和覆盖层兼容

打包器不负责拉取上游，也不会替用户切换分支。每次上游更新后先在独立的 master 工作树执行 `git fetch upstream`、`git switch master` 和 `git pull --ff-only upstream master`。确认没有本地修改后再构建。

`overlays/connect/manifest.json` 声明支持的 master 版本范围、补丁顺序、必需文件和契约 marker。版本超出范围、稳定锚点缺失、补丁冲突或契约不满足都会安全失败。不要用 `--allow-dirty` 代替正式同步；该选项只适合本机诊断。

上游仅更新版本或资源时通常无需修改打包器。若标题页、服务端路由、消息协议或 Android bridge 的稳定接口发生变化，应先更新覆盖层和契约测试，再重新构建两个 profile。

