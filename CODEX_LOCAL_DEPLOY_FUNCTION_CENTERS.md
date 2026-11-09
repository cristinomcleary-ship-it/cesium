# 本机 Codex：部署六大功能中心与对象管理

用户已要求执行本地部署。请在用户电脑完成代码整合、构建、更新原服务和真实浏览器验收，不要停在方案、下载或构建阶段。本任务只部署已实现的第一、二步；不扩展后续架构阶段。本文为通用部署任务，不记录用户电脑的实际路径、端口、资源位置或凭据，也不是部署成功记录。

## 1. 固定交付与验证依据

- 仓库：<https://github.com/cristinomcleary-ship-it/cesium>
- 交付分支：`codex/function-centers-object-management-20261109`
- 功能代码提交：`c697c0d0443af779329275a898383f68c4ab96a8`
- 稳定祖先：`24f79e0c2a62613417c61f61077949aee147c97e`。
- 草稿 PR：<https://github.com/cristinomcleary-ship-it/cesium/pull/12>；保持草稿，不合并或公开部署。
- 功能说明：`docs/function-centers-object-management.md`。
- 云端验证记录：`docs/function-centers-validation.json`。

功能包括六中心分类与搜索、对象目录的编辑/显隐/移出/删除入口、按对象编号进入原编辑器，以及未保存编辑和取点操作的切换保护。保留自动初始高度和后续高度调整。未改变依赖清单、锁文件或数据库结构。

功能提交已通过构建和 575 项自动测试（514＋34＋27，不重复计数）。云浏览器缺少 WebGL2，真实 Cesium 场景验收需在本机补齐。分支后续文档提交不改变固定功能提交；如发现额外代码提交，先审查差异，不能盲目部署最新 HEAD。

## 2. 现场识别与备份

读取当前工程及父级适用的 AGENTS.md、原快捷方式、版本说明、启动脚本和服务状态。核实实际工程、Git HEAD、未提交与未推送修改、运行进程、启动模式、原 URL、全部数据根及认证配置。不要根据仓库默认脚本猜测用户的实际环境。

保留本机定制启动器、主机名、端口、浏览器配置和数据路径。不同主机名或端口的浏览器存储互不等同，不能通过换地址让旧方案看似消失。不要用目标分支默认启动脚本覆盖原有定制。现场存在的功能限制和运行包装语义保持不变。

先记录当前状态并建立可恢复备份，包括旧源码差异、必要未跟踪文件、旧构建、启动配置、数据库、附件、资料记录及浏览器站点存储。数据库使用一致性备份，不能只复制正在写入的主文件。原始模型、摄影、CAD、录像与其他业务资料原地保留；仅处理本工程相关内容。路径、凭据、资源和现场截图只留在本机，不写入公开 GitHub。

使用独立 worktree 整合，不自动 stash、reset、clean，不覆盖现有修改。若本机有后续业务功能，按实际业务含义整合并保留。不要调用自动公开推送整个本地历史的备份工具。

## 3. 获取固定代码并验证

核实 origin 后执行，原工作区不切换分支：

```powershell
git fetch origin codex/function-centers-object-management-20261109
if ($LASTEXITCODE -ne 0) { throw '获取交付代码失败' }
$featureCommit = 'c697c0d0443af779329275a898383f68c4ab96a8'
git cat-file -e ($featureCommit + '^{commit}')
if ($LASTEXITCODE -ne 0) { throw '固定功能提交不存在' }
git merge-base --is-ancestor 24f79e0c2a62613417c61f61077949aee147c97e $featureCommit
if ($LASTEXITCODE -ne 0) { throw '目标代码不包含指定稳定祖先' }
```

建立唯一的新工作区和本地整合分支，从固定功能提交开始，与本机后续修改比较并整合。记录最终整合 SHA、工作区差异和交付提交的关系，不复用或清理已有工作区。

沿用 Node.js 24 和现有锁定包管理器；npm 使用 `npm ci`，pnpm 使用已有锁文件的 frozen 安装方式，不交叉重写锁文件。检查实际启动链所需运行时能力。候选构建使用本机现有、已验证的运行资源副本，保持原件不动，不下载旧版替换现有资源。

在整合工作区执行以下回归；每条命令后检查退出码，新增失败先修复，不继续切换：

```powershell
node tools/run-temporary-works-regression.mjs related --output output/function-centers-local-validation
node --experimental-transform-types --import ./tools/test-module-loader.mjs --test src/workbenchNavigation.test.ts src/functionCenters.test.ts tests/function-centers-dom.test.mjs tests/function-center-management.test.mjs src/objectEditorSelection.test.ts src/foundationPitDisplay.test.ts src/markupDisplay.test.ts
node --experimental-transform-types --import ./tools/test-module-loader.mjs --test tests/scene-library-cad-lifecycle.test.mjs tests/machinery-documents-workspace.test.mjs
git diff --check
```

生成全新暂存产物，以下当前目录必须是独立整合工作区：

```powershell
$integrationRoot = (Get-Location).Path
$newBuild = Join-Path $integrationRoot ('output/deploy-build-' + [Guid]::NewGuid().ToString('N'))
npm run build -- --outDir $newBuild --emptyOutDir
if ($LASTEXITCODE -ne 0) { throw '暂存构建失败，保留原服务' }
node tools/install-temporary-works-assets.mjs --check --to (Join-Path $newBuild 'models/temporary-works')
if ($LASTEXITCODE -ne 0) { throw '暂存资源校验失败，保留原服务' }
```

`emptyOutDir` 只用于新目录，不能指向原构建、数据或运行环境。先用隔离数据、浏览器配置和测试端口验证真实 WebGL2 场景；最终回到现场核实的原入口。不要让固定端口的旧验收脚本误写正式服务。

## 4. 切换原服务

候选验证通过且回退点可用后，按原管理方式停止已确认属于该工程的服务；不要批量结束 Node 或其他项目进程。按审核后的文件差异安装整合源码与暂存产物，保留本机定制、数据和资源，不整目录覆盖。

如使用 `tools/install-staged-build.mjs`，先阅读实现：stage 必须位于目标工程的 `output/deploy-build-*` 新目录；需要显式绑定现场核实的三类数据根作为保护目录。该工具写入 dist 后删除 stage，既非原子更新也不自动回滚，必须提前保存可恢复的旧产物。失败立即按回退点恢复。

若原启动链校验运行版本或构建指纹，应根据新产物同步更新对应身份字段并保留校验逻辑；不关闭校验，也不继续用旧 SHA 标识新构建。其他原配置及功能限制保持不变。

通过原桌面入口重启，核对 PID、命令、工作目录、监听地址和真实构建来源。检查首页、静态资源与原认证下的后台接口，核对原项目和资料可见。预期的未登录认证响应不算服务故障；首页 HTTP 200 不能单独证明部署成功。

## 5. 真实浏览器验收

对已有业务资料只做查看；保存、编辑和删除测试使用明确标识的测试对象与临时资源，只清理本次测试项。

1. 六中心展开、搜索和打开正常；“便道”可定位临建规划。管理/现场工作台入口、原 query URL 和独立工具入口可达；桌面与窄屏可操作，切换不新增 Cesium Viewer。
2. 目录配置分别进入所选机械、临建、基坑/监测点、标绘的原编号，不重复创建、不误选其他对象。
3. 隐藏保留记录；“移出场景”只卸载当前会话，资料和分组仍在，可重新载入。刷新仍按原自动加载规则恢复，不误称永久隐藏。测试机械删除后台账与场景同步。
4. 临建有未保存修改、预览、取点或计算时切换，取消后草稿和导航高亮保留；保存/删除过程中不切走。模型、标绘、基坑取点的跨编辑器切换得到阻止提示，完成或取消后能正常导航。
5. 自动初始高度与后续升降、保存、刷新正常；便道、硬化、遮挡和原模型展示保持。不要重新自动布置已有生产方案。
6. 原机械倾覆/侵限、CAD 定位、图层透明度、基坑读数和标绘等常用功能可用；无数据不生成监测值。账号/项目切换沿用权限及草稿保护。存储失败测试只在隔离副本进行。
7. 控制台、网络、模型和 Cesium Worker 加载无新增错误；刷新及再次通过桌面入口启动后，仍运行新版本且原项目、对象、资料可见。

## 6. 回退与交付

新服务不能启动、身份不一致、场景加载失败或出现数据缺失时，停止本次服务，恢复匹配的旧源码、旧构建、旧启动配置及身份信息，重新启动原入口并验证。业务数据未被修改时不覆盖；恢复测试影响前保护期间新增业务记录。不清空浏览器存储，保留失败候选供诊断。

部署记录和现场截图保存在本机。向用户报告实际 URL、运行完整 SHA/整合关系、实际服务状态、备份位置、测试结果、真实三维验收和未通过项；不输出凭据，不把现场细节上传公开仓库。只有原入口已运行新代码且本机验证有证据，才报告“本地部署完成”。

本轮已授权本地部署；历史只读审计任务的阶段限制不应被误用为本轮暂停条件。遇到真实业务冲突或缺少必需资源时，完成可独立推进的工作，保持或恢复原服务，并报告具体阻断。
