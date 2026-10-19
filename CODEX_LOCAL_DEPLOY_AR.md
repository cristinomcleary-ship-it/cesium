# AR 修复版本：本机 Codex 部署任务

此文件交给运行在用户 Windows 电脑上的 Codex。聊天中的云工作区无法直接控制该电脑；只有本机 Codex 执行并完成验收后，才可以报告本地部署成功。

仓库：`https://github.com/cristinomcleary-ship-it/cesium.git`
目标分支：`codex/machinery-integration-20261013`
默认入口：`http://127.0.0.1:5173/`

## 给本机 Codex 的任务

1. 找到用户一直使用的原 Cesium 项目目录。优先使用当前工作目录、`CESIUM_PROJECT_DIR`、现有启动快捷方式及 `output/local-service/service.json`。不要另建一个空项目冒充更新完成，不要清空浏览器或删除 `project-data`。
2. 读取该目录的 `AGENTS.md`，核对 `origin`、当前分支、提交历史、未提交修改和启动方式。目标是保留当前模型、资料、保存的融合方案及其他模块功能。
3. 用户若给出了本轮 GitHub 完整提交 SHA，使用下述 `-ExpectedCommit` 固定它。远端若已变化，先审查差异。没有固定 SHA 时，脚本快进到运行时该目标分支的最新版本，并记录实际部署 SHA。
4. 用下面的 `-CheckOnly` 检查。若有脏修改，正式脚本会保存二进制 patch 和工作文件副本后停止，交由本机 Codex 对比、合并、提交。禁止 `reset --hard`、`git clean`、强制 checkout、覆盖用户文件或自动丢弃修改。若当前分支不同或历史分叉，审查后安全合并修复提交；脚本不替用户猜测或强制切分支。
5. 执行部署脚本。它会安装必要的锁定依赖、运行 `npm run build`、保存原 `dist`，通过现有服务脚本只重启能够确认属于当前项目的服务。不得执行 `taskkill /IM node.exe`、关闭所有 Node 进程或占用其他端口来掩盖失败。
6. 打开页面强制刷新，确认 AR 面板显示 `版本 2026.10.19-R3`，浏览器加载的是新构建。用用户原航拍视频、CC XML 和原模型播放，记录源分辨率、播放时长、明显停顿次数和退出前后场景拖动效果。至少重复进入、播放、退出 AR 三次。确认退出后不需要刷新页面即可正常移动、缩放，并检查其他模块、方案读取、标注及视频导出。生成连续预览所需的等待时间与播放中的停顿分别记录。
7. 报告实际路径、完整 Git SHA、构建结果、服务 PID、访问 URL、浏览器验收结果及尚未解决的问题。只运行了脚本或构建通过，不等于用户视频性能验收通过。

## 在原项目中运行

已经安装本机 Codex CLI 时，可在原项目打开终端交接任务：

```powershell
codex -C "D:\你的原项目目录" "请读取 CODEX_LOCAL_DEPLOY_AR.md，按其中要求审查并部署本轮 GitHub AR 修复版本，完成原视频播放和退出后的实际性能验收，报告实际提交 SHA 和服务状态。"
```

这条命令启动的是执行该命令电脑上的 Codex，不会从聊天云工作区远程连接电脑。保留本机 Codex 的正常审查与权限设置。

先在 PowerShell 进入原项目目录，或用 `-ProjectPath` 明确指定。脚本仅支持已有 Git 仓库，自动识别不扫描整台电脑。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\deploy-ar-local.ps1 -CheckOnly
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\deploy-ar-local.ps1 -NoBrowser
```

明确原目录并固定已审查的版本：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\deploy-ar-local.ps1 -ProjectPath "D:\你的原项目目录" -ExpectedCommit "替换为本轮GitHub的40位完整提交SHA" -NoBrowser
```

仅构建，暂不重启现有服务：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\deploy-ar-local.ps1 -SkipRestart -NoBrowser
```

`-SkipRestart` 不能用于报告已部署。`-Mode Preview` 或 `-Mode Development` 可明确指定服务模式；未指定时优先沿用已有服务记录。Node.js 需要 24+，可以通过 `CESIUM_NODE_EXE` 指定已有运行时。原服务启动器需要已安装 pnpm，脚本不会自动下载或升级包管理器。

如果本机还没有这两个新文件，先让本机 Codex只读获取目标提交中的文件内容并审查，再运行。不要为了获取脚本在脏工作区直接 `git pull`。也可以先在一个临时目录下载这两个文件，使用 `-ProjectPath` 指向原项目；脚本仍会在更新前备份并拒绝覆盖脏修改。

备份和日志保存在原项目的 `.local-backups/ar-local-时间戳/`，其中 `deployment.json` 记录更新前、目标提交及完成状态。失败时保留日志并停止，脚本不会自动回退 Git 历史或删除文件。原构建位于 `previous-dist` 时，由本机 Codex在确认服务停止后恢复；必须记录回退后的版本，不能把旧构建报告为新版本。
