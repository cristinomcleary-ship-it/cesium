# 本机 Codex：更新部署 R9 CAD 交互性能与渲染修复

请在用户一直使用的 Cesium 项目中完成更新部署与现场验收，接续现有工程。仓库：`https://github.com/cristinomcleary-ship-it/cesium.git`；目标分支：`codex/machinery-integration-20261013`；待核验提交：`REVIEWED_COMMIT_SHA`（用交付消息中的完整 40 位 SHA 替换）。页面版本：`2026.10.23-R9-cad-interaction`。

R9 性能与渲染修复已提交为 `7b2df033aeeec239665fe2acc23616089a3f48e2`；本次部署工具在该基线上调整为只使用 GitHub 代码备份。最终待部署 SHA 以交付消息为准，不能直接用该基线 SHA 代替。保留 R8 的整体转轴规则：新建整体转轴取固定首个相机附近的实际 CAD 几何并保存，已有整体中心和单对象语义不自动改写；继续保留贴附表面冻结、全量采样、原帧融合缓存、加长播放进度条及结构空间标绘。实际修复范围和测试结果以交付记录为准，本说明不预设本机验收已通过。本机部署、原素材性能对照和偶发异常复现仍需执行。仓库只包含代码、合成验证和通用说明，不提交用户原文件、诊断附件及由其推导的数据分析结果。

对异常包围球 CAD，现场操作使用“整体工程校正（CAD／模型）”；单对象控件仍可能受异常自身中心影响，不能报告已完全修复。不要未经原视频及工程点核验就归零相机优化姿态，也不要未经帧时间核对就改变抽帧时间。详见 `docs/cad-tilt-r8-verification-20261022.md`。

## 1. 定位原工程和运行状态

读取适用的 `AGENTS.md`；通过当前目录、`CESIUM_PROJECT_DIR`、原快捷方式及 `output/local-service/service.json` 找到原工程。先记录原项目绝对路径、origin、当前分支、完整 HEAD、Git 工作区状态、服务 PID／启动时间／命令／访问地址／运行模式、Node 和包管理器版本。不要另建空工程冒充更新。

```powershell
Set-Location -LiteralPath '本机已核实的原 Cesium 项目绝对路径'
git remote get-url origin
git branch --show-current
git rev-parse HEAD
git status --short --branch --untracked-files=all
git ls-files --others --ignored --exclude-standard
```

记录 `CESIUM_DATA_DIR`、`CESIUM_MANAGEMENT_DATA_DIR`、`CESIUM_SAFETY_DATA_DIR` 的实际绝对路径及原进程其他自定义环境变量。缺省目录通常为工程内 `project-data`，但必须以原服务配置和实际数据为准。保持原资料 ID、模型引用路径、标定参数、融合方案、权限配置和浏览器使用的原站点地址。

## 2. 只在 GitHub 备份代码，原资料留在原位

用户明确要求：不创建本地备份。不要新建备份目录、Git bundle、补丁文件、源码副本、旧 `dist` 副本或融合方案备份副本；已经存在的备份保持原位，不删除、不整理。新代码执行文件和新构建的临时目录只用于本次更新，不用于保存旧文件。

更新源码或服务前，先在同一 GitHub 仓库创建唯一的远端 `backup/...` 分支，指向已审查、准备保留的完整提交 SHA，再从 GitHub 读取该分支并确认 SHA 完全相同。仅创建本地分支不算备份成功；推送或远端核验失败时停止更新。禁止强制覆盖、删除或复用已有远端备份分支。

GitHub 代码备份只覆盖已提交的 Git 内容。必须审查待上传提交的内容及尚未存在于远端的历史，不得上传密码、密钥、`.env*`、工程资料、原模型／CAD／视频／相机数据、诊断记录及其推导分析。脚本遇到未提交或未跟踪修改时只报错并保留原位，不自动复制、暂存或提交文件。若需保护这类代码成果，先确认可上传的代码范围，审查后提交到独立 GitHub 备份分支并核验 SHA；无法与敏感文件或工程资料安全分离时停止说明，不能把整目录上传。

盘点三个实际数据根、数据库与附件、模型转换配置、原服务配置、外部引用资产及浏览器数据，全部保留原位置、原内容和原引用关系。不要导出方案副本、清空缓存存储／IndexedDB／登录状态，也不要把 ignored 数据加入 Git 来满足备份要求。GitHub 代码备份不覆盖这些数据；任何更新步骤如需迁移、覆盖或删除它们，必须先停下说明影响和此备份范围的缺口，不能直接继续。

若原服务确由本仓库启动器管理，且使用 `127.0.0.1:5173`，在原目录先执行：

```powershell
& .\tools\stop-cesium.ps1 -WhatIf
```

此处只核验服务身份，不提前停服。常规部署由新版部署脚本在 GitHub 备份核验后按需要停止服务。若原服务由其他方式管理、地址／端口不同或脚本无法确认身份，先完成第 4 节的远端备份，再使用已核实的原服务管理方式停止和重启。不要绕过脚本身份校验，不要批量终止 Node 进程，也不要改端口掩盖启动失败。

## 3. 核对远端并保留本机修改

```powershell
$reviewedCommit = 'REVIEWED_COMMIT_SHA'
$targetBranch = 'codex/machinery-integration-20261013'
$projectRoot = (git rev-parse --show-toplevel).Trim()
if ($reviewedCommit -notmatch '^[0-9a-fA-F]{40}$') { throw '先填入交付消息中的完整提交 SHA' }
git fetch --no-tags origin $targetBranch
if ($LASTEXITCODE -ne 0) { throw '远端抓取失败，保留原工程' }
$remoteCommit = (git rev-parse 'FETCH_HEAD^{commit}').Trim()
if ($remoteCommit -ne $reviewedCommit) { throw '远端已有其他更新：先审查差异，禁止覆盖或假称已经部署指定提交' }
git log --oneline --left-right HEAD...$reviewedCommit
git diff --stat HEAD $reviewedCommit
```

这里仅抓取和审查，不调用原目录中的旧版部署脚本，不切换或合并源码。当前分支不同或存在本机独有提交时，按第 4 节先提取新版工具并完成 GitHub 备份核验，再决定整合方式；存在未提交或未跟踪修改时保持原位，先处理其归属和远端保护，不能清空后继续。不得使用 `reset --hard`、`git clean`、强制切分支、自动 stash 或远端旧代码覆盖成果。不要把未审查的本机修改提交到 GitHub 远端。开发服务必须在改变其源码前停止。

`deploy-ar-local.ps1` 不负责切分支，只接受目标分支上的干净工作区和可快进历史；保持这些检查，不伪造远端 SHA 来绕过检查。

## 4. 构建、更新和重启

确认 Node.js 24+ 且 `node:sqlite` 可用、`npm.cmd` 和原启动器所需的 pnpm CLI 已安装。需要指定已有运行时时使用 `CESIUM_NODE_EXE`，pnpm 入口可用 `CESIUM_PNPM_JS`；不擅自升级依赖或重写锁文件。

**先提取已核验提交中的新版工具。** 旧版 `deploy-ar-local.ps1` 会创建本地备份，禁止先运行旧脚本再等待其自更新。以下只将三份新工具暂存到系统临时目录，不复制本机旧源码、旧构建或业务资料：

```powershell
$deployTools = Join-Path ([IO.Path]::GetTempPath()) ('cesium-deploy-tools-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $deployTools -ErrorAction Stop | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
foreach ($toolName in @('deploy-ar-local.ps1', 'github-code-backup.mjs', 'install-staged-build.mjs')) {
  $gitObject = $reviewedCommit + ':tools/' + $toolName
  $toolLines = @(& git -C $projectRoot show $gitObject)
  if ($LASTEXITCODE -ne 0) { throw "无法读取已核验提交中的 $toolName，不执行旧脚本" }
  [IO.File]::WriteAllLines((Join-Path $deployTools $toolName), [string[]]$toolLines, $utf8)
}
$deployScript = Join-Path $deployTools 'deploy-ar-local.ps1'
```

对于已在目标分支、工作区干净且历史可快进，并使用仓库原启动器的工程，在保留原数据目录和环境变量的同一 PowerShell 会话中执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $deployScript -ProjectPath $projectRoot -Branch $targetBranch -ExpectedCommit $reviewedCommit -CheckOnly
if ($LASTEXITCODE -ne 0) { throw '部署预检失败' }
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $deployScript -ProjectPath $projectRoot -Branch $targetBranch -ExpectedCommit $reviewedCommit -NoBrowser
if ($LASTEXITCODE -ne 0) { throw '部署未完成，检查部署报告与原服务状态' }
git rev-parse HEAD
Get-Content -LiteralPath .\output\local-service\service.json -Raw
Get-Content -LiteralPath .\output\local-service\deployment.json -Raw
```

`-CheckOnly` 只预检，不创建 GitHub 备份，也不能作为备份成功的依据。正式执行时，脚本先拒绝脏工作区，再创建唯一 `backup/local-deploy/...` 远端分支并核验原 HEAD 的完整 SHA；成功后才按需要停止开发服务、快进源码和安装依赖。缺少 GitHub 写权限或远端核验失败时不继续更新，不改成本地备份。

不传 `-Mode` 时脚本优先沿用旧 `service.json` 中的模式；若原记录缺失，明确传入已经核实的 `-Mode Preview` 或 `-Mode Development`，不能凭默认值改变原模式。原环境变量除三个数据目录外不保证自动恢复，必须在调用前保留。脚本按需使用 `npm ci`，新构建输出到 `output/deploy-build-<GUID>`，验证后由安装 helper 仅更新 `dist` 中新构建对应的同路径文件，保留其他既有文件，不复制旧 `dist`。数据根和目标符号链接校验失败时停止，不能绕过保护。`output/local-service/deployment.json` 是本次执行状态记录，不是本地代码或数据备份。

**分支不同、本机有独有提交或使用其他服务管理方式时**，先完成内容审查；工作区干净后，可单独运行新版备份 helper：

```powershell
$beforeCommit = (git -C $projectRoot rev-parse HEAD).Trim()
$backupResult = & node (Join-Path $deployTools 'github-code-backup.mjs') $projectRoot $beforeCommit
if ($LASTEXITCODE -ne 0) { throw 'GitHub 代码备份失败，保持源码和服务原状' }
$githubBackup = $backupResult | ConvertFrom-Json
$remoteBackup = @(& git -C $projectRoot ls-remote --heads origin ('refs/heads/' + $githubBackup.branch))
if ($LASTEXITCODE -ne 0 -or $remoteBackup.Count -ne 1 -or
    ($remoteBackup[0] -split '\s+')[0] -ne $beforeCommit -or $githubBackup.sha -ne $beforeCommit) {
  throw 'GitHub 备份 SHA 核验失败，停止更新'
}
$githubBackup
```

远端备份核验后，再按已审查历史安全切换或整合源码，并记录实际合并 SHA 及所包含的交付 SHA；不能把合并 HEAD 冒充交付 SHA。手动部署使用原包管理器和锁文件，并使用以下新构建暂存路径和安全安装接口：

```powershell
$newBuild = Join-Path $projectRoot ('output/deploy-build-' + [Guid]::NewGuid().ToString('N'))
npm run build -- --outDir $newBuild --emptyOutDir
if ($LASTEXITCODE -ne 0) { throw '新构建失败，不安装、不改原 dist' }
# 在此按已核实的原服务管理方式停服；开发服务须更早在改变源码前停止。
# 必须确认服务已停止，并保留实际数据根的环境变量，再执行：
& node (Join-Path $deployTools 'install-staged-build.mjs') $projectRoot $newBuild
if ($LASTEXITCODE -ne 0) { throw '构建安装失败，先检查状态，不自动重启或删除资料' }
```

随后按原地址、模式、数据根和环境重启，并核验 API 和实际页面。不要手工整目录删除或交换 `dist`，不要保存旧构建副本。

失败时查看现有执行记录并确认服务状态；新构建生成失败不应更改原 `dist`，但安装或启动失败不能承诺本机即时回滚。需要恢复旧代码时，从已核验 GitHub 备份分支／SHA 重新取得源码并按其锁文件构建，再通过同样的安全流程恢复运行；不回滚、迁移或删除业务数据来迁就程序。任何恢复步骤若会覆盖 Git 外数据必须先停下说明。只有进程、原 URL、资料 API 和实际页面均核验后，才能报告服务更新完成。

## 5. 原始素材现场验收

使用原浏览器配置和原访问地址强制刷新页面，确认 `2026.10.23-R9-cad-interaction` 和实际部署 SHA。以下每项记录素材名、操作、结果和必要截图，记录仅保留在本机；没有执行的项目写“待现场验收”。

1. **CAD 导入与贴附高程**：保留旧资源，以新资源从原 DWG 导入，核对水平构件方向、设计高程、二维／三维多段线、块参照及非水平椭圆。分别检查绝对高程、贴地和贴模型模式：绝对高程 CAD 的真实设计坡度保留；贴附 CAD 在进入 AR 前后应保持对应表面形态，不应又恢复图纸原始 Z。用超过 2000 个顶点的 CAD 检查长短线均完成采样；缺失模型覆盖时应明确报错，不能显示混合高程。陡坎、狭窄构件、洞口及面内部需额外对照原素材检查，5 m 加密采样不能替代现场精度验收。
2. **整体与单对象双轴交互**：保留原融合方案和原参数，不创建其备份副本、不覆盖正式方案。在本次新建的验收方案中检查校正；已有中心不合适时，只在该验收方案的整体范围使用“重置对象微调”清除中心，再用默认 0.1° 建立新整体校正。检查新中心接近固定首个相机附近的实际 CAD 几何，两轴小步操作的位移应与现场几何到转轴的距离相符；跳转视频不同时间再操作，中心应保持不变。确认全部 CAD／工程模型围绕同一个固定中心转动、彼此间距保持；显示勾选只控制可见性，3D Tiles／空三／遮挡参照保持原位。对正常范围 CAD 和模型分别检查单对象修正仍保留并与整体校正叠加；异常包围球 CAD 的单对象倾角仍为已知限制，不用此入口代替整体修复验收。检查整体和单对象的正负方向、归零、重置、撤销、重做；倾角归零保留平移、高程和水平旋转，整体重置保留单对象修正。若系统只能覆盖正式方案才能完成该项，先停止说明。
3. **方案恢复**：保存本次新建的验收方案，退出并重新打开，随后刷新页面再打开；检查共同中心、整体两轴倾角、整体位置、各对象修正和空间标绘锚点均恢复。只读打开无整体参数的旧方案，确认整体默认为 0，不修改原方案、资料和模型定位。
4. **融合缓存**：完成一次缓存后，分别从缓存播放状态修改整体倾角，以及单个 CAD／模型位置或倾角，检查旧缓存失效并重建不同画面；检查首、中、尾帧的几何与遮挡。改变接收模型定位或贴附条件后重新进入融合，检查表面冻结结果，并重新生成缓存。
5. **连续进出至少五次**：每次进入前记录地图相机和对象姿态；退出后检查姿态恢复、真实鼠标平移、滚轮缩放和资源拾取；记录每轮监听／帧回调／临时资源及 GPU、内存和交互耗时是否持续增长。覆盖正常结束和采样失败／取消后的恢复；发生渲染异常时先读取现有日志并核对复现步骤，再检查恢复状态，不能仅用刷新页面代替退出恢复验收。最后一轮仍须能够正常浏览地图；云端软件渲染耗时不能替代本机性能验收。
6. **相机、时间对应和画质**：在原视频首、中、尾及转弯处对照可识别结构与控制点检查 XML 优化相机姿态。优化姿态与元数据存在差异时，不能仅凭差异判错；不得自动归零或用 CAD 整体倾角掩盖未核实的相机问题。核对原视频真实帧率、抽帧编号及 PTS，确认照片时间对应；参数试调仅用于本次验收方案，不覆盖原方案和原相机文件。对比源视频与完整融合输出的像素尺寸、帧数和帧时间戳；可变帧率视频按源时间戳核验，不只比较平均帧率。不得为通过测试降低分辨率或源帧率。检查加长播放进度条、拖动定位、原图层、已有标绘与其他功能仍可用。

贴附 CAD 进入 AR 时错误恢复源 Z 的问题不要求重写 CAD 源文件；先用本版重新进入融合并重建缓存。旧 `.cadimport` 若本身已固化错误顶点，则通常缺少还原原图元／块方向所需的信息。受非默认法向／块方向错误、二维多段线高程错误或椭圆平面错误影响的旧资源，需要从对应原 DWG 重新导入；整体倾角微调不能完整修复图元各自的导入错误。尚未检查用户原文件时，无法列出必须重导入的具体文件名；本机核验后列出受影响清单及对应 DWG，保留旧资源和旧方案用于对照。

## 6. 原素材性能对照与异常记录

在更新前可操作的原版本中记录一次基线；若已经更新且没有可比记录，注明“缺少更新前基线”，不要为补测覆盖现有工程或业务数据。使用同一台电脑、浏览器、窗口尺寸、模型／CAD 可见集合、相机位置和原视频，区分首次加载／采样／缓存构建与资源就绪后的交互。分别记录地图平移缩放和拾取、整体及单对象倾角连续小步调整、视频拖动定位、缓存播放、退出 AR 后操作的响应时间、明显停顿、CPU／GPU／内存变化及异常次数；完成上述至少五次进出。已有工具能测量时记录实际值，不能测量的项目明确标记，不填推测数字。对照保持源视频分辨率、帧率、几何精度及场景资源一致，不能通过降质、隐藏重资源或换小模型宣称卡顿改善。

出现“三维场景渲染发生错误”或相关控制台异常时，先核对发生时间、实际 SHA、浏览器及显卡版本、当时所在页面和最近的操作顺序；展开错误详情，读取已有堆栈和运行日志。日志可能包含相机坐标、图层名和工程信息，保留系统已有记录原位，不额外复制为本地备份；仅由用户明确选择提供。禁止上传 GitHub、附到 PR／issue，或提交从日志及原素材推导的分析结果。

优先在原站点、原登录会话中打开相对地址 `/__diagnostics/render-error/latest`，直接查看已有 JSON，不另建诊断副本。核对 `occurredAt` 与本次异常时间，避免把上一次记录当成本次证据。该接口返回 404“暂无渲染异常记录”、网络失败或登录限制时，记录实际情况，不关闭权限控制；再在同一站点的浏览器开发者工具控制台读取现有浏览器记录：

```javascript
const rawRenderError = localStorage.getItem('cesium-last-render-error-v1');
console.log(rawRenderError ? JSON.parse(rawRenderError) : '该站点没有本地渲染异常记录');
```

本机 `.render-errors/latest.json`、对应时间文件及 localStorage 中的现有记录保持原位，不复制、不清空。日志接口或 localStorage 没有记录，不足以证明未发生错误，应结合错误面板、控制台和操作时间说明证据范围；需要用户提供日志时明确对应记录，不自动上传。

偶发错误未复现时写“本轮指定场景和次数内未复现，原异常尚未确认消除”，同时列出实际覆盖范围；不能写“已完全解决”。性能对照改善、合成测试通过、日志无新记录分别陈述，不能相互替代。

## 7. 交付结果

报告原项目路径、实际部署完整 SHA（若有合并，另列交付 SHA）、GitHub 备份分支 URL／完整 SHA／远端核验结果及范围、构建结果、服务 PID、原 URL、六项现场验收结果、原素材性能对照条件与结果、偶发异常复现状态及仍未通过／未执行项。明确未创建本地备份，Git 外资料／模型／配置保留原位且未上传。异常日志只报告现有记录的位置，不上传其内容。仅完成构建或云端合成测试时，不得写“本地部署完成”或“原素材问题已经完全解决”。
