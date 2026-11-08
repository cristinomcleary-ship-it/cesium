# 临建设施自动初始高度

基础版本：`temporary-facilities-v1.1.0`，对应提交 `79d24eb63967ac547a725ead7f11ed5300213353`。功能分支：`codex/temporary-facilities-auto-elevation`。

本功能在驻地、钢筋加工场、施工便道和场地硬化生成时，默认从所选倾斜摄影读取一个有效高程作为初始放置高度，减少首次布置时填写标高的操作。生成后的形状、纵坡及结构厚度仍由方案参数决定。

## 使用方法

| 设施 | 默认操作 | 初始高度的用途 |
| --- | --- | --- |
| 项目驻地 | 选择摄影和驻地轮廓，或确定手动平面位置与尺寸后生成 | 在模型实际占地内选择一个取高点，确定建筑底面初始高度 |
| 钢筋加工场 | 选择摄影和钢筋场轮廓，或确定手动平面位置与尺寸后生成 | 在模型实际占地内选择一个取高点，确定模型底面初始高度 |
| 施工便道 | 导入中心线，设置路宽、厚度及可选纵坡后生成 | 在中心线上选择一个取高点；设置纵坡时按取高点桩号换算起点顶高，保持各坡段连续 |
| 场地硬化 | 选择摄影、设置厚度，直接矩形框选或多边形圈选范围后生成 | 在范围内选择一个取高点，确定水平场地或指定坡面的初始高度，并自动避让已有设施 |

驻地、钢筋场和便道的“初始高度”设置默认采用“自动读取范围内摄影高程”。需要精确指定高程时，可切换为“使用填写或已保存的高度”。场地硬化可展开“手动标高与坡度（可选）”，勾选“手动指定初始标高”。手动输入使用场景椭球高，工程标高应按项目采用的高程转换关系填写。

自动框选硬化时，第一个有效角点用于建立绘制参考平面；生成时仍在已完成的实际硬化范围内选取有效高程。范围内永久保留区不作为取高位置。

## 取高规则

1. 每次自动生成只采用一个有效高程结果。优先查询一个候选点；该点缺测时，再查询剩余候选位置，总候选查询点数不超过 9 个。
2. 驻地、钢筋场和硬化的候选点位于实际范围内部，避开轮廓孔洞；便道候选点沿所选中心线分布。候选点仅用于初始高度，不形成逐点贴地网格。
3. 采用首个有效结果，不计算多点平均、最低面或摄影拟合坡面。便道继续按照起点高程和设计纵坡生成；硬化继续按照水平面或指定坡度生成。
4. 所选摄影没有有效高程、范围不在覆盖区或取高结果无效时，停止此次自动生成并显示原因。可以检查摄影与范围后重试，或切换手动高度；缺测不会被当作 0 m，也不会作为有效结果保存。
5. 初始高度来自摄影可见表面，可能对应树木等地物。应查看预览，并按需要调整整体位置或输入已核准高度。初始放置高度不等于场地整平或接顺设计结果。

## 保存后的调整与编辑

在“已保存方案”中点击“位置调整”，通过前后左右和平移步长调整平面位置，通过升高、降低和升降步长调整标高。预览确认后保存；取消或 Esc 恢复调整前位置。

位置调整保留设施形状、坡度、厚度及原方案编号，不重新自动取高。已有硬化仍按照设施新的占地范围更新避让关系。

重新编辑已保存的驻地、钢筋场、便道或硬化时，沿用已保存的高度，不因再次生成预览而自动回到摄影表面。只有主动重新选择自动取高，才重新读取摄影高程。复核中的初始取高记录是生成时的历史信息；位置调整后不能把该记录视为新位置的采样结果。

## Windows 本地检出与验证

以下是本机执行步骤，本文没有代为部署或重启用户电脑上的服务，也不声明这些命令已在用户电脑执行成功。测试结果与实际运行提交应在本机执行后记录。

沿用现有项目的 Node.js 24 和包管理器。`package.json` 已有 `dev`、`build`、`preview` 脚本，其中 `build` 执行 `tsc && vite build`；测试使用仓库已有 Node 验证入口。下面按现有 npm 工程说明，不新增 npm 脚本、不改写依赖或锁文件。原项目使用 pnpm 时，应沿用 `pnpm install --frozen-lockfile` 及对应构建命令。

### 1. 在独立工作区检出功能分支

先在现用仓库检查工作状态，并记录未提交修改及本机增量。将下面的路径替换为实际工程路径，`$checkRoot` 必须是尚不存在的独立目录。

```powershell
$projectRoot = 'F:\实际目录\cesium'
$checkRoot = Join-Path (Split-Path $projectRoot -Parent) ('cesium-auto-elevation-check-' + [Guid]::NewGuid().ToString('N'))
Set-Location $projectRoot
git status --short --branch
git log -5 --oneline
git fetch origin codex/temporary-facilities-auto-elevation
if ($LASTEXITCODE -ne 0) { throw '功能分支获取失败，请检查远端连接和分支名称' }
git worktree add --track -b codex/temporary-facilities-auto-elevation $checkRoot origin/codex/temporary-facilities-auto-elevation
if ($LASTEXITCODE -ne 0) { throw '独立工作区未建立，请核对本地分支和工作区状态' }
Set-Location $checkRoot
git rev-parse HEAD
git merge-base --is-ancestor 79d24eb63967ac547a725ead7f11ed5300213353 HEAD
if ($LASTEXITCODE -ne 0) { throw '当前检出不包含指定的 1.1.0 基线，请核对分支' }
```

如果本地已存在同名分支，先用 `git worktree list` 核对其位置及工作状态；复用已有独立工作区，或使用其他唯一的本地验证分支名关联上述远端分支。不要重置或删除现有分支来绕过错误。现用工程存在更新的本机修复时，应先在独立整合分支保留这些修复，再纳入本功能改动。

### 2. 安装锁定依赖并执行检查

在独立工作区运行，并逐项记录退出码：

```powershell
npm ci
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' }
node node_modules/typescript/bin/tsc --noEmit
if ($LASTEXITCODE -ne 0) { throw 'TypeScript 检查失败' }
node tools/run-temporary-works-regression.mjs related --output output/auto-elevation-related
if ($LASTEXITCODE -ne 0) { throw '临建相关回归未通过' }
node tools/run-temporary-works-regression.mjs all --output output/auto-elevation-all
if ($LASTEXITCODE -ne 0) { throw '全量回归未通过，请核对失败项' }
node --test tools/designed-surfaces-preview/preview.test.mjs
if ($LASTEXITCODE -ne 0) { throw '隔离预览服务检查失败' }
git diff --check
if ($LASTEXITCODE -ne 0) { throw '差异格式检查失败' }
```

检查结果按实际执行记录填写。历史版本的测试数量、通过状态和浏览器验收记录不能代替当前分支及本机整合后的结果。

### 3. 暂存构建与本机验收

沿用[私有资源安装流程](temporary-works-upgrade/deployment.md)，在独立工作区保留并校验已有 GLB、贴图及资源清单后，构建到新建的暂存目录：

```powershell
$newBuild = Join-Path $checkRoot ('output/deploy-build-' + [Guid]::NewGuid().ToString('N'))
npm run build -- --outDir $newBuild --emptyOutDir
if ($LASTEXITCODE -ne 0) { throw '暂存构建失败' }
node tools/install-temporary-works-assets.mjs --check --to (Join-Path $newBuild 'models/temporary-works')
if ($LASTEXITCODE -ne 0) { throw '暂存模型资源检查失败' }
```

本机浏览器至少核对：四类设施不填初始标高即可生成；首个点缺测后可使用范围内其他有效点；全部缺测时不生成；手动高度有效；便道纵坡与硬化坡度保留；保存后升降和平移生效；重新打开或编辑已保存方案不自动取高；设施移动后硬化避让正确更新。

正式切换服务应按照现用项目的[本机部署流程](../CODEX_LOCAL_DEPLOY_TEMPORARY_WORKS.md)执行，保留原 URL、端口、数据根、认证配置及私有资源。独立工作区检出、检查和暂存构建完成，仅说明候选版本已准备；本机服务实际切换并通过浏览器验收后，才能记录为部署完成。
