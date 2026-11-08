# 本机 Codex 执行：临建设施位置调整与硬化自动避让部署

日期：2026-11-08（北京时间）。用户已要求完成本地部署。请在用户 Windows 的现有 Cesium 工程执行检查、整合、构建、浏览器验证和服务更新，不要停留在方案说明。此文件是待执行任务，不是部署成功记录；云端无法连接本机。

## 交付版本

- 仓库：`https://github.com/cristinomcleary-ship-it/cesium.git`
- 分支：`codex/temporary-facilities-position-auto-hardening`
- 功能提交：`5435622aa1f601a454517460c58937b4d723e32c`
- 功能父提交：`bd9eefee27a03f481a7b45caeeea5473a8f581d4`，对应 `temporary-facilities-v1.0.0`。
- 草稿 PR：`https://github.com/cristinomcleary-ship-it/cesium/pull/10`。保持草稿，不合并，不移动原版本标签。
- 本次目标：驻地、钢筋场、便道、硬化的统一平移和升降；硬化自动避让已有设施，移动后同步重算。

云端已通过相关回归 466 项、TypeScript 检查和生产构建。云端浏览器 WebGL 初始化失败，因此这些结果不能替代本机三维验收。

## 1. 核对现用工程并保留回退点

从本机 Codex 当前工作区、现用启动脚本和服务进程确定实际工程目录；不要新建空平台替代用户原工程。读取适用 AGENTS.md、现用配置和最近本机部署记录。

记录现用 Git HEAD、分支、未提交文件、未推送提交、启动模式、实际 PID/命令行/工作目录、完整 URL、私有模型目录以及 `CESIUM_DATA_DIR`、`CESIUM_MANAGEMENT_DATA_DIR`、`CESIUM_SAFETY_DATA_DIR` 三个数据根。不输出密钥。保留原 URL 的主机名和端口，`localhost` 与 `127.0.0.1` 的浏览器方案存储不是同一个来源。

在本机私有目录备份现用代码差异、未跟踪的有效源码、旧构建和运行配置。数据库使用一致性备份；保留原浏览器方案与未保存编辑，不清空 IndexedDB/localStorage。不得运行 `reset --hard`、`git clean`、自动丢弃改动或整目录覆盖。私有模型、业务数据、现场截图及含这些内容的 Git 历史不上传公开仓库。

## 2. 整合明确的功能增量

```powershell
git fetch origin codex/temporary-facilities-position-auto-hardening
if ($LASTEXITCODE -ne 0) { throw '获取交付分支失败' }
git merge-base --is-ancestor 5435622aa1f601a454517460c58937b4d723e32c FETCH_HEAD
if ($LASTEXITCODE -ne 0) { throw '远端分支不含指定功能提交' }
git show --stat 5435622aa1f601a454517460c58937b4d723e32c
```

以现用本机有效状态建立独立整合分支/工作区，保留现有裁剪、机械、资料管理及其他本机修复。审查父提交至功能提交的 13 个文件增量。如果本机尚未包含该功能且具备 1.0 基线，整合该功能提交；已经包含时不重复应用。本机基线不同则先核对依赖与差异，逐项解决冲突，不整体采用远端文件覆盖本机修改。此次分支后续的部署文档提交不改变功能代码。

## 3. 检查并生成暂存构建

沿用本机包管理器与锁文件：pnpm 使用 `pnpm install --frozen-lockfile`，npm 使用 `npm ci`，不混用或重写锁文件。使用 Node.js 24+，验证 `node:sqlite` 可用。依赖已与锁文件一致时无需重复安装。

在整合工作区执行，逐条检查退出码并保存日志；失败时保留旧服务，定位并修复后重跑受影响的检查：

```powershell
node node_modules/typescript/bin/tsc --noEmit
node tools/run-temporary-works-regression.mjs all --output output/position-hardening-verification
node --test tools/designed-surfaces-preview/preview.test.mjs
git diff --check
```

设置 `$candidateBuild` 为整合工作区内新建、此前不存在的 `output/deploy-build-<唯一编号>` 绝对路径，先确认路径再构建；不要清空原 dist。npm 执行 `npm run build -- --outDir $candidateBuild`；pnpm 执行 `pnpm run build --outDir $candidateBuild`。检查退出码。

`$privateAssets` 使用本机已有、经过校验的运行资源目录，包含 manifest、三类 GLB 和 LOGO，不是原始模型包：

```powershell
node tools/install-temporary-works-assets.mjs --check --to $privateAssets
node tools/install-temporary-works-assets.mjs --from $privateAssets --to (Join-Path $candidateBuild 'models/temporary-works')
node tools/install-temporary-works-assets.mjs --check --to (Join-Path $candidateBuild 'models/temporary-works')
```

本次不修改私有资源。异版冲突时核对来源，不强制覆盖。完整平台依赖 Vite 的本地服务接口，不能仅用普通静态服务器运行 dist 代替平台。

## 4. 浏览器验收

先运行 `node tools/designed-surfaces-preview/server.mjs --help`，使用本机空闲验证端口及 `--assets $privateAssets` 启动隔离验证页。该页只有内存方案；重载内存不能冒称浏览器持久化验证。随后在独立测试数据/浏览器配置中检查完整平台保存、刷新及旧方案恢复。使用本机支持 WebGL 的浏览器，出现渲染错误应修复后继续。

| 项目 | 必须验证的结果 |
| --- | --- |
| 四类位置调整 | 已保存驻地、钢筋场、便道、硬化均出现位置调整；视角方向/地图方向正确，平移与升降步长独立，连续点击累计值正确 |
| 保存与取消 | 保存更新原编号，不重复新建；取消、Esc、恢复原位有效；保存后重开、刷新保持新位置，重新编辑便道不跳回原 CAD 位置 |
| 自动避让 | 框选范围同时覆盖驻地、钢筋场、便道、另一硬化时，无需手动点选即可扣除真实占地；保留庭院孔洞、永久保留区，重复重叠只扣除一次 |
| 联动与恢复 | 设施移动后旧区补回、新区扣除；隐藏/恢复、测试记录删除、取消预览后恢复正确；关闭摄影遮挡仍保留设施占地 |
| 异常与兼容 | 切项目、保存失败不留下重复模型和裁剪；既有机械、图层、资料及旧临建正常；缩放/连续移动无明显新增卡顿 |

自动排除建筑占地不代表建筑地坪已接顺。便道升降可能使邻接硬化要求重新复核高差；这是保留的控制逻辑。整体移动不重新采样摄影，历史土方不能当作新位置结果。独立宣传墙沿用既有规则。记录真实结果和截图；无法执行的项目明确标记未验证。

## 5. 更新原服务并核验

检查通过后完成本机更新，无须仅因本任务再次要求部署授权。将已经验收的源码增量同步到现用工程，保留该工程其他本机改动，核对源码与构建一致。沿用原服务模式、URL、认证配置和三个数据根。

使用现有暂存安装器时，将**新构建**准备在目标工程 `$projectRoot\output\deploy-build-<唯一编号>` 下，令 `$targetStage` 指向该目录。安装器只接受位置参数：

```powershell
node tools/install-staged-build.mjs $projectRoot $targetStage
```

该安装器不是原子切换，没有自动备份或回退；安装前保留旧构建、待替换文件清单和新构建副本，成功后暂存目录会被删除。为安装进程明确设置现用三个数据根，确保保护规则覆盖实际业务目录。不要把旧 dist 整体塞入暂存构建。

只停止本工程已核验身份的服务，不批量结束 Node。若原服务使用仓库的固定 `127.0.0.1:5173` 启动器，先读取现用 `output/local-service/service.json`，可用 `tools/stop-cesium.ps1 -WhatIf` 核对目标，再停止和安装；按原模式运行 `tools/start-cesium.ps1 -Mode Preview -NoBrowser` 或 `-Mode Development -NoBrowser`。启动器不会替换已经运行的进程；必须核实新进程及资源版本。原服务使用其他启动方式时继续沿用，不擅自更换端口或模式。

启动后检查原 URL、管理/资料接口、模型资源、项目资料和浏览器现有方案，并完成一次位置保存及硬化避让复核。不能把 HTTP 200 当作全部成功。失败时恢复旧代码/构建和原服务配置；保留新产生的数据，不用旧数据库覆盖期间的业务变化。

## 6. 返回实际执行报告

报告本机工程路径、整合前后完整 SHA、原有改动保留情况、验证命令及结果、实际运行 URL/PID/模式、四类位置调整和自动避让的浏览器结果、回退位置。明确区分“已部署”“验证失败”“尚未执行”；有阻断时保留可用旧服务并说明确切原因。不能将本文中的命令或云端测试写成本机已经执行。
