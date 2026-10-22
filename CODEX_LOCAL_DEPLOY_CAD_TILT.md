# 本机 Codex：更新部署 R8 CAD 整体倾角转轴修复

请在用户一直使用的 Cesium 项目中完成更新部署与现场验收，接续现有工程。仓库：`https://github.com/cristinomcleary-ship-it/cesium.git`；目标分支：`codex/machinery-integration-20261013`；待核验提交：`REVIEWED_COMMIT_SHA`（用交付消息中的完整 40 位 SHA 替换）。页面版本：`2026.10.22-R8-local-cad-pivot`。

本轮基于 R7 提交 `ecceaeba8ff34e968fba7b85692ec5205f172b63`，修正异常 CAD 包围球导致整体倾角转轴远离现场的问题。新建整体转轴取固定首个相机附近的实际 CAD 几何并保存；已有整体中心和单对象语义不自动改写。保留贴附表面冻结、全量采样、原帧融合缓存、加长播放进度条及结构空间标绘。本机更新部署和原视频现场配准尚未完成。仓库只包含代码、合成验证和通用说明，不提交用户原文件、诊断附件及由其推导的数据分析结果。

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

## 2. 先备份，再改变源码和服务

在原工程之外创建带时间戳的新备份目录。检查剩余空间；备份失败时停止更新并说明具体缺失项。

1. 备份原 HEAD／分支和完整提交历史（例如 `git bundle create <备份文件> --all`），保存 `git diff --binary --output=<工作区补丁>`、`git diff --cached --binary --output=<暂存区补丁>`；另外复制所有已修改、未跟踪文件及其相对路径清单。核对备份文件，不能仅保存文字版 diff。
2. 对 `.gitignore` 排除项单独盘点。至少保留实际三个数据根的完整内容、数据库及附件、`.env*`、`model-converters.json`、原服务记录及配置、转换工具本机配置。凭证只留在本机备份中，不上传 GitHub。
3. 核对模型、倾斜摄影、视频、原 DWG、相机 XML／CSV 等是否引用工程目录以外的文件；备份这些源文件或核验已有可恢复备份，并保留原路径映射。复制 `project-data` 元数据不能代替外部源资产备份。保留浏览器现有本地数据，若有方案导出功能则另行导出；不要清空缓存存储、IndexedDB 或登录状态来“修复”更新。
4. 对正在写入的数据库／资料目录，先核实并停止本项目写入服务，再执行一致性备份；SQLite 主库及相关文件和附件一起保留。不要在持续写入时把普通文件复制当成已验证的数据库备份。

现有 `tools/deploy-ar-local.ps1` 只自动备份 Git 可见改动和旧 `dist`，不会备份 ignored 数据或外部模型，不能替代以上步骤。

若原服务确由本仓库启动器管理，且使用 `127.0.0.1:5173`，在原目录先执行：

```powershell
& .\tools\stop-cesium.ps1 -WhatIf
# 上一步确认 PID、启动时间、工程路径和命令均与原服务匹配后：
& .\tools\stop-cesium.ps1 -Confirm:$false
```

若原服务由其他方式管理、地址／端口不同或脚本无法确认身份，使用已核实的原服务管理方式停止和重启。不要绕过脚本身份校验，不要批量终止 Node 进程，也不要改端口掩盖启动失败。

## 3. 核对远端并保留本机修改

```powershell
$reviewedCommit = 'REVIEWED_COMMIT_SHA'
$targetBranch = 'codex/machinery-integration-20261013'
if ($reviewedCommit -notmatch '^[0-9a-fA-F]{40}$') { throw '先填入交付消息中的完整提交 SHA' }
git fetch --no-tags origin $targetBranch
if ($LASTEXITCODE -ne 0) { throw '远端抓取失败，保留原工程' }
$remoteCommit = (git rev-parse 'FETCH_HEAD^{commit}').Trim()
if ($remoteCommit -ne $reviewedCommit) { throw '远端已有其他更新：先审查差异，禁止覆盖或假称已经部署指定提交' }
git log --oneline --left-right HEAD...$reviewedCommit
git diff --stat HEAD $reviewedCommit
```

工作区干净且历史允许时再安全切换到目标分支。当前分支不同、存在未提交修改或本机独有提交时，先用已验证备份保留原状态，在独立工作树中整合、解决冲突并测试，再更新原工程；不得使用 `reset --hard`、`git clean`、强制切分支或远端旧代码覆盖成果。不要把未审查的本机修改提交到GitHub 远端。开发服务必须在改变其源码前停止。

`deploy-ar-local.ps1` 不负责切分支，只接受目标分支上的干净工作区和可快进历史；保持这些检查，不伪造远端 SHA 来绕过检查。

## 4. 构建、更新和重启

确认 Node.js 24+ 且 `node:sqlite` 可用、`npm.cmd` 和原启动器所需的 pnpm CLI 已安装。需要指定已有运行时时使用 `CESIUM_NODE_EXE`，pnpm 入口可用 `CESIUM_PNPM_JS`；不擅自升级依赖或重写锁文件。

对于使用仓库原启动器、已安全切到目标分支且历史可快进的工程，在保留原数据目录和环境变量的 PowerShell 会话中执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\deploy-ar-local.ps1 -Branch $targetBranch -ExpectedCommit $reviewedCommit -CheckOnly
if ($LASTEXITCODE -ne 0) { throw '部署预检失败' }
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\deploy-ar-local.ps1 -Branch $targetBranch -ExpectedCommit $reviewedCommit -NoBrowser
if ($LASTEXITCODE -ne 0) { throw '部署未完成，检查部署报告与原服务状态' }
git rev-parse HEAD
Get-Content -LiteralPath .\output\local-service\service.json -Raw
```

不传 `-Mode` 时脚本优先沿用旧 `service.json` 中的模式；若原记录缺失，明确传入已经核实的 `-Mode Preview` 或 `-Mode Development`，不能凭默认值改变原模式。脚本会再次核验远端 SHA，按需使用 `npm ci`，在独立目录构建，保留旧 `dist`，再由原启动脚本重启。原环境变量除三个数据目录外不保证自动恢复，必须在调用前保留。

若整合本机提交产生了新的合并 SHA，或原服务不属于该启动器，按上述脚本的等价步骤手动部署：记录实际合并 SHA 和所包含的交付 SHA；按原包管理器与锁文件安装依赖；执行 `npm run build -- --outDir <全新暂存目录> --emptyOutDir`；成功后备份旧 `dist`，停止已核实的原服务，交换构建目录，按原地址、模式、数据根和环境重启。不能把合并 HEAD 冒充交付 SHA。

失败时保留所有日志和新旧构建，检查服务是否已停。若需恢复旧运行版本，先停止本项目新服务、恢复已备份的旧构建及匹配源码／依赖／环境，再按原方式启动；不回滚或删除业务数据来迁就程序。只有进程、原 URL、资料 API 和实际页面均核验后，才能报告服务更新完成。

## 5. 原始素材现场验收

使用原浏览器配置和原访问地址强制刷新页面，确认 `2026.10.22-R8-local-cad-pivot` 和实际部署 SHA。以下每项记录素材名、操作、结果和必要截图；没有执行的项目写“待现场验收”。

1. **CAD 导入与贴附高程**：保留旧资源，以新资源从原 DWG 导入，核对水平构件方向、设计高程、二维／三维多段线、块参照及非水平椭圆。分别检查绝对高程、贴地和贴模型模式：绝对高程 CAD 的真实设计坡度保留；贴附 CAD 在进入 AR 前后应保持对应表面形态，不应又恢复图纸原始 Z。用超过 2000 个顶点的 CAD 检查长短线均完成采样；缺失模型覆盖时应明确报错，不能显示混合高程。陡坎、狭窄构件、洞口及面内部需额外对照原素材检查，5 m 加密采样不能替代现场精度验收。
2. **整体与单对象双轴交互**：先另存原融合方案副本，保留原参数；对已有不合适整体中心的副本，在整体范围使用“重置对象微调”清除原中心，再用默认 0.1° 建立新整体校正。检查新中心接近固定首个相机附近的实际 CAD 几何，两轴小步操作的位移应与现场几何到转轴的距离相符；跳转视频不同时间再操作，中心应保持不变。确认全部 CAD／工程模型围绕同一个固定中心转动、彼此间距保持；显示勾选只控制可见性，3D Tiles／空三／遮挡参照保持原位。对正常范围 CAD 和模型分别检查单对象修正仍保留并与整体校正叠加；异常包围球 CAD 的单对象倾角仍为已知限制，不用此入口代替整体修复验收。检查整体和单对象的正负方向、归零、重置、撤销、重做；倾角归零保留平移、高程和水平旋转，整体重置保留单对象修正。
3. **方案恢复**：保存，退出并重新打开方案，随后刷新页面再打开；检查共同中心、整体两轴倾角、整体位置、各对象修正和空间标绘锚点均恢复。打开无整体参数的旧方案，确认整体默认为 0，不修改原资料和模型定位。
4. **融合缓存**：完成一次缓存后，分别从缓存播放状态修改整体倾角，以及单个 CAD／模型位置或倾角，检查旧缓存失效并重建不同画面；检查首、中、尾帧的几何与遮挡。改变接收模型定位或贴附条件后重新进入融合，检查表面冻结结果，并重新生成缓存。
5. **连续进出五次**：每次进入前记录地图相机和对象姿态；退出后检查姿态恢复、真实鼠标平移、滚轮缩放和资源拾取；记录每轮监听／帧回调／临时资源及 GPU、内存和交互耗时是否持续增长。覆盖正常结束和采样失败／取消后的恢复。最后一轮仍须能够正常浏览地图；云端软件渲染耗时不能替代本机性能验收。
6. **相机、时间对应和画质**：在原视频首、中、尾及转弯处对照可识别结构与控制点检查 XML 优化相机姿态。优化姿态与元数据存在差异时，不能仅凭差异判错；不得自动归零或用 CAD 整体倾角掩盖未核实的相机问题。核对原视频真实帧率、抽帧编号及 PTS，确认照片时间对应，再修改副本并对照。对比源视频与完整融合输出的像素尺寸、帧数和帧时间戳；可变帧率视频按源时间戳核验，不只比较平均帧率。不得为通过测试降低分辨率或源帧率。检查加长播放进度条、拖动定位、原图层、已有标绘与其他功能仍可用。

贴附 CAD 进入 AR 时错误恢复源 Z 的问题不要求重写 CAD 源文件；先用本版重新进入融合并重建缓存。旧 `.cadimport` 若本身已固化错误顶点，则通常缺少还原原图元／块方向所需的信息。受非默认法向／块方向错误、二维多段线高程错误或椭圆平面错误影响的旧资源，需要从对应原 DWG 重新导入；整体倾角微调不能完整修复图元各自的导入错误。尚未检查用户原文件时，无法列出必须重导入的具体文件名；本机核验后列出受影响清单及对应 DWG，保留旧资源和旧方案用于对照。

## 6. 交付结果

报告原项目路径、实际部署完整 SHA（若有合并，另列交付 SHA）、备份位置和范围、构建结果、服务 PID、原 URL、六项现场验收结果及仍未通过／未执行项。仅完成构建或云端合成测试时，不得写“本地部署完成”或“原素材问题已经完全解决”。
