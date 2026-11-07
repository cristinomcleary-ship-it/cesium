# 本机 Codex 接续：设计便道、场地硬化和亮度调节

日期：2026-11-07（北京时间）。用户已授权继续本地部署任务。请执行整合、验证及符合下述条件的服务更新，不要只回复计划。云端无法访问用户 Windows 工程，以下步骤必须由本机 Codex 执行，不能把本文或云端测试当作本机执行结果。

## 目标及必须保留的已有成果

- 仓库：`cristinomcleary-ship-it/cesium`。
- Draft PR：<https://github.com/cristinomcleary-ship-it/cesium/pull/9>；保持 Draft，不合并。
- 交付分支：`feature/designed-roads-hardening-lighting`。功能提交 `a9618b757c1e788d784bafccda48f4a8d4be7e27`；其后同一 PR 的锁文件、隔离验证入口及接续说明增补一并核查。记录本次实际取用的完整远端 SHA，不仅记录分支名。
- 交付父基线：`19b150b3fa7c040a6ab4954ce7827efe4c25aec3`。不要重放 PR #8 的旧部署任务把设计便道重新换成逐点贴地采样。
- 最近本机验收记录：`01bff9fb409d872d32e682bd2f8ed02be43ca9c3`，其四文件裁剪/调度/销毁恢复修复必须保留。它尚未在公开远端取得。以本机实际 HEAD 和工作区为准，更晚的修改同样保留，不能退回到 01b。
- 本轮不重制模型。沿用已核验的私有 R2 运行资源；不要重新要求上传原件，不把模型、贴图、真实资源映射、CAD 坐标、场景截图、业务数据或可能包含它们的本地 Git 历史推送到公开仓库。

## 1. 核对原环境，保留工作状态

首先读取适用的 AGENTS.md、运行配置和最近本机验收报告。记录工程路径、Git HEAD、暂存与未暂存修改、未跟踪文件、未推送提交、实际服务 PID/启动方式、URL/端口及业务数据根。不要输出密钥内容。原 URL 最近记录为 `http://127.0.0.1:5173/`，最终以实际进程为准。

使用只读 Git 检查：

```powershell
git status --short --branch
git log -12 --oneline --decorate
git log --branches --not --remotes --oneline
git diff --stat
git diff --cached --stat
```

在本机私有备份目录保存必要源码、Git 历史、未提交差异、未跟踪文件、旧 dist、启动配置及运行资源；分别记录已完整备份和仅登记清单的范围。业务数据库使用一致性备份，不能复制活动 SQLite 后冒称完整备份。保留原 Chrome 页面、未保存表单和浏览器存储，不强制刷新用户正在编辑的页面。

不运行 `reset --hard`、`git clean`、自动 stash、公开历史备份脚本或整目录覆盖。不得为修复旧验收证明而重放历史摄影 PUT/DELETE driver、wrapper 或旧业务写操作。

## 2. 在独立整合工作区保留本机增量

```powershell
git fetch origin feature/designed-roads-hardening-lighting
git rev-parse origin/feature/designed-roads-hardening-lighting
git merge-base --is-ancestor a9618b757c1e788d784bafccda48f4a8d4be7e27 origin/feature/designed-roads-hardening-lighting
if ($LASTEXITCODE -ne 0) { throw '交付分支不含指定功能提交，停止整合并核查' }
```

审查 `19b150b3..origin/feature/designed-roads-hardening-lighting` 的提交和文件清单。以本机现有状态建立唯一的独立整合分支/工作区，把本机未提交但需要保留的有效修改逐项纳入候选版本，再按顺序整合交付增量。不要直接用远端工作树替换原工程；不要推送含私有文件的整合历史。

遇到冲突逐项核对含义，特别保留现用 `01b` 的裁剪调度、外部裁剪所有权和销毁恢复行为。禁止用自动选择整侧文件消除冲突。不能取得本机修复时，停止正式替换，但继续完成可独立执行的检查并报告缺失项。

## 3. 锁定依赖、运行检查和暂存构建

沿用本机已验证的 Node 24 和包管理器。pnpm 工程执行 `pnpm install --frozen-lockfile`；npm 工程执行 `npm ci`。不要使用 `--no-frozen-lockfile` 或删锁文件掩盖依赖不一致。不要同时用两种包管理器重写同一个 node_modules。

记录每条命令及独立退出码，失败不能被下一条成功覆盖：

```powershell
node node_modules/typescript/bin/tsc --noEmit
node tools/run-temporary-works-regression.mjs all --output output/designed-surfaces-verification
node --test tools/designed-surfaces-preview/preview.test.mjs
node --test tools/temporary-works-assets/geometry-signs.test.mjs tools/inspect-video-ar-recovery.test.cjs tools/validate-platform-ar-checkpoints.test.mjs
git diff --check
```

使用本机已有 Python 虚拟环境执行适用附属测试；记录已有失败、平台跳过和新增失败。云端主回归 1420 项的历史记录不等于整合后的本机结果，本机已有测试可能使数量增加。禁止跳过失败来凑通过数。新增失败和无法解释的行为差异必须在正式切换前处理。

构建到本机工程 `output/deploy-build-<唯一编号>` 新目录，不对原 dist 使用 `--emptyOutDir`。先确认变量路径：

```powershell
npm run build -- --outDir $newBuild --emptyOutDir
if ($LASTEXITCODE -ne 0) { throw '暂存构建失败，不替换服务' }
node tools/install-temporary-works-assets.mjs --check --to (Join-Path $newBuild 'models/temporary-works')
if ($LASTEXITCODE -ne 0) { throw '暂存私有资源检查失败，不替换服务' }
```

pnpm 环境用其对应 `pnpm run build` 传参方式。`$newBuild` 必须是新建且已确认的暂存目录；安装资源前对原版本做私有备份，异版冲突不强制覆盖。

## 4. 先执行隔离 GPU 冒烟检查

在整合工作区运行新的验证入口，启动前阅读其帮助：

```powershell
node tools/designed-surfaces-preview/server.mjs --help
node tools/designed-surfaces-preview/server.mjs --port 5288 --assets $privateAssetDirectory
```

`$privateAssetDirectory` 是本机已校验、含 manifest 的运行资源目录，不是 ZIP 或云端路径。入口仅监听回环地址、使用内存方案；不连接正式业务 API。保留正式服务原端口，5288 仅为临时验证页。先加载合成场景，再加载私有真实模型。页面显示合成摄影，不能把它截图标成现场验收。

检查真实驻地、钢筋棚、宣传墙和合成 PBR/SpecGloss 材质：50%/100%/200%、单独/统一亮度、独立保存、日间/夜间、近景/远景；检查浏览器 Console 与实际画面。`Model.ready` 在首次实际绘制前触发，所以“加载成功”不代表 shader 实际编译绘制成功。固定局部光照也不保证最终像素不受全局雾、大气与 HDR 影响，不能通过关闭全平台雾或修改全局曝光来修临建亮度。

操作便道预览、保存、重载内存方案，框选硬化并验证与便道重叠。内存方案刷新页面会丢失；“重载内存方案”仅验证面板恢复路径，正式持久化须在下一节检查。检查结束只关闭本次启动的验证进程。

## 5. 真实场景和性能验收

使用独立的数据/浏览器配置副本验证候选版本，实际摄影与模型可只读引用原私有文件；不要把候选接口错误连接到正式数据库。新增测试方案只写入明确的测试数据副本，不重放旧验收的生产写动作。

|检查|最低验收内容|
|---|---|
|便道|原失败中心线完整长度与参数；水平、正负纵坡、反向、结构厚度、0 摄影采样、实际占地裁剪、取消与保存刷新；侧面检查悬空及摄影切壁，不能把竖直封边当成已接地|
|硬化|矩形/凹多边形/永久孔洞；与便道、驻地、钢筋场、另一硬化的两两和三重重叠；未知地坪不猜测，确认轮廓/顶高/厚度后再生成；异高明确提示|
|恢复|关闭遮挡保留地面占地；隐藏/删除释放占地；移动后旧区恢复、新区避让；取消/保存失败/加载失败/刷新后无重复面和错误裁剪，其他模块剪裁保留|
|亮度|真实白墙、金属、玻璃、透明文字贴图；单独保存和浏览器重开恢复；其他摄影、机械和图层外观不被改动|
|其他业务|原图层、机械管理、铁路安全、CAD 导入、存储及本机已有其他模块的关键流程，保留原数据|

先记录未改现用版本的固定性能基线，再用同机、同场景、同相机与同操作序列比较候选版本。至少记录静置/旋转/缩放帧时间、输入响应、长任务、预览与取消时间、反复增删后的资源和内存。测量预热条件一致，不把首轮资源下载与缓存后的运行混比。记录实际数值与波动，出现明显退化不能发布；不能通过降低摄影质量、扩大采样间距或隐藏其他业务模型制造“变快”。

真实坐标、高程或正确设计外轮廓缺失时，列为具体未验收项，不用树冠、水面、屋顶高度或错误 CAD 图元补造答案。所有包含真实模型、现场数据的截图和日志仅留本机私有目录。

## 6. 切换、核验与回退

只有整合与上述检查达到可发布条件，才按已核对的原启动方式更新服务。操作目标必须是该工程明确的进程；禁止批量终止 Node。保留原 URL、模式、端口、认证配置和三个数据根。

使用现有暂存安装流程前，检查 `tools/install-staged-build.mjs` 对实际数据目录的保护；它不是原子安装且会移除成功安装后的暂存目录，需先保留构建清单及可恢复旧产物。部分失败时按清单恢复被替换的代码/资源，不能用旧数据库覆盖升级后的其他业务更新。

切换后核验 PID、命令行、实际运行完整提交、主入口及资源内容版本、原项目资料与图层。若实际整合 SHA 与交付 SHA 不同，分别记录。HTTP 200、自动测试或服务启动成功均不等于真实场景通过。

新版设计便道与硬化记录可能不被旧程序理解，回退时保留新记录副本，并使用兼容的数据副本核查恢复；不得清空全部浏览器存储或删除其他模块记录。遇到真实场景/性能未通过则保留旧服务，报告候选状态及确切阻断原因。

最终交付本机实际执行报告：整合前后 SHA、本机修复保留情况、未提交文件处置、每条测试命令/退出码、固定基线性能对照、真实场景截图的私有路径、成功/失败/未验证清单和回退点。不要把本任务书中的命令当作已经执行。
