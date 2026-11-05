# 本机 Codex：部署临建真实 GLB 升级

用户已要求完成本地部署。请在用户正在使用的 Windows Cesium 工程执行代码整合、私有模型安装、构建、服务重启与浏览器验收。不要只输出计划或停在下载源码。本文是本机执行任务；云端准备与通过的测试不能证明用户电脑已经部署。

## 目标版本与资源

- 仓库：https://github.com/cristinomcleary-ship-it/cesium.git
- 交付分支：`feature/temporary-works-glb-integration`
- 固定应用代码提交：`b1211276010be579bd50681c45f689bb9f7d2eda`
- Draft PR：https://github.com/cristinomcleary-ship-it/cesium/pull/8 ，保持 Draft，不合并。
- 私有资源包：`Cesium-Temporary-Works-Private-Assets-20261105.zip`，R2 修正版，50,506,749 字节。
- 包 SHA-256：`010b8d9b5826babdc139eeba6245e597abadfb936a9f801352c74bb505c90ba1`。
- 从用户提供的私有下载入口获取资源，或优先检查用户已下载且哈希匹配的同名 ZIP（同名旧包不是 R2）；不要请求再次上传原 GLB。包内运行资源位于 `temporary-works/`。Library 标识和云端 /workspace 路径不是 Windows 文件路径。

## 1. 识别原工程和回退点

读取当前工作目录及父级适用的 AGENTS.md、启动/数据说明、`output/local-service/service.json` 和原快捷方式；核实实际工程路径、origin、分支、完整 HEAD、未提交与未推送修改。确认正在使用的进程、命令、工作目录、Preview/Development 模式、原 URL（包括 localhost/127.0.0.1 区别）、端口、三个数据根及环境配置。不要输出凭据值。

保留原工程、业务资料、数据库、模型/CAD/录像、环境变量和浏览器站点存储。不得使用 `reset --hard`、`git clean`、自动 stash、整目录覆盖或用新空工程替代原系统。

在本机私有目录保留可恢复的源码状态、未提交差异及必要未跟踪文件、旧运行资源、旧构建和启动配置，记录备份位置及核验结果。数据库备份使用适合其运行状态的一致性方式；不要把正在写入的数据库文件随意复制后宣称备份完整。仅需备份本任务相关代码/资料，不扫描无关磁盘文件。

**本任务不允许自动把本地提交历史推送到公开 GitHub。** 原本地后续提交可能已经包含模型。旧 CAD 部署文档的自动 GitHub 备份路径不适用本任务：
- 不直接运行 `tools/deploy-ar-local.ps1` 或 `tools/github-code-backup.mjs`；它们可能推送完整本地历史，且不扫描历史中的私有资产。
- `更新Cesium并构建.cmd` 不是完整接续入口：它不获取目标代码，也不暂存构建。
- 本任务的模型、贴图、LOGO、实际几何 manifest、现场数据、含模型截图及含这些内容的历史均保持私有。

## 2. 安全整合已交付代码

获取远端交付分支，核验固定代码提交确实存在：

```powershell
git fetch origin feature/temporary-works-glb-integration
git cat-file -e b1211276010be579bd50681c45f689bb9f7d2eda^{commit}
```

比较本机 HEAD、v1.2.0 和交付代码，检查本机新增功能及未提交修改。使用独立本地整合工作区先处理冲突和构建，不直接覆盖现用源码。根据实际历史采用安全快进、合并或逐项整合；不要把本机较新功能回退到旧版本。保留原始暂存/未暂存状态的记录，任何冲突按代码业务含义解决。

运行代码同时依赖 Vite 配置及本地接口，不仅是 dist 文件。整合前后端源码与构建产物，记录实际运行 SHA 和包含的交付 SHA；二者不同应分别报告。若原服务为开发模式，变动其正在使用的源码前先按已核实方式停止该工程服务。仅操作该工程进程。

## 3. 安装私有运行模型

用 `Get-FileHash -Algorithm SHA256` 核对 ZIP。解压到新的私有目录，保留 ZIP 和原文件。安装器只能接收已审计的运行包，不能把原品牌整理 GLB 直接改名代用。

在整合工程中执行（变量须由实际核查结果赋值，不要原样复制占位值）：

```powershell
node tools/install-temporary-works-assets.mjs --from $privateAssetDirectory
if ($LASTEXITCODE -ne 0) { throw '私有模型安装失败，检查输出' }
node tools/install-temporary-works-assets.mjs --check
if ($LASTEXITCODE -ne 0) { throw '私有模型清单校验失败' }
```

`$privateAssetDirectory` 必须指向包内含 `manifest.json` 的 `temporary-works` 目录。默认安装到该脚本所属工程的 `public/models/temporary-works`。同版可重复执行；异版文件会被拒绝覆盖。发生异版冲突时先核对、备份并移走完整旧资源目录，再安装本次资源，不能直接删除旧包或修改哈希以绕过校验。同步到现用工程时同样遵循此规则。

实际运行文件是三份 GLB、LOGO 和 manifest。安装到 public 或构建到 dist 不表示获准公开发布。

## 4. 测试与暂存构建

沿用已验证的 Node.js 24、原包管理器及锁文件。npm 工程用 `npm ci`，pnpm 工程使用其锁定安装方式；不要为部署升级依赖或改写锁文件。原启动器另要求可用 `node:sqlite` 和 pnpm CLI，需按实际启动方式检查。

执行并记录退出码：

```powershell
node node_modules/typescript/bin/tsc --noEmit
node tools/run-temporary-works-regression.mjs all
node --test tools/inspect-video-ar-recovery.test.cjs tools/validate-platform-ar-checkpoints.test.mjs
```

任何命令失败应记录并定位，不得被后续成功覆盖。参考 `docs/temporary-works-upgrade/test-results.md`：R2 云端主套件 1299/1299、品牌几何工具 25/25；此前补充工具 18/18；5 个独立脚本已有 v1.2.0 同错误基线；Python 部分缺 cv2/paho。按本机实际环境运行适用附属测试，对已有失败逐项对照，新增失败须先处理。不能将已知失败简单计作通过。

在已确认的工程根目录创建唯一的新构建目录，禁止对原 dist 使用 emptyOutDir：

```powershell
$newBuild = Join-Path $projectRoot ('output/deploy-build-' + [Guid]::NewGuid().ToString('N'))
npm run build -- --outDir $newBuild --emptyOutDir
if ($LASTEXITCODE -ne 0) { throw '暂存构建失败，原服务产物不替换' }
node tools/install-temporary-works-assets.mjs --check --to (Join-Path $newBuild 'models/temporary-works')
if ($LASTEXITCODE -ne 0) { throw '暂存模型校验失败，不安装' }
```

若在整合工作区构建，切换前将**新生成产物**放到现用工程自己的唯一 `output/deploy-build-*` 目录；不要将整合工程目录覆盖到现用工程。安装 helper 要求 stage 位于目标工程的 output 下。

## 5. 更新原服务并核验身份

构建和资源检查完成后，按原管理方式停止已确认的工程服务；保留原数据根及环境变量，确保整合源码、模型和运行产物一致。

先审查 `tools/install-staged-build.mjs`，核对真实业务数据根均受保护，然后执行：

```powershell
node tools/install-staged-build.mjs $projectRoot $newBuild
if ($LASTEXITCODE -ne 0) { throw '产物安装失败，检查实际状态并回退' }
```

helper 会预检目标、最后写入 HTML、保留不相关旧文件，但不是原子事务且不自动回滚。若部分安装失败，使用本机回退点恢复已替换内容，再恢复原服务；不要继续宣称更新成功。

使用原模式、URL、端口、数据目录和配置重启。`tools/start-cesium.ps1` 固定使用 `127.0.0.1:5173`，只在原环境确实如此时使用；其他环境沿用原启动方式。不得通过换端口绕开原服务问题，也不得批量结束全部 Node 进程。

核实新服务 PID/命令/工作目录、实际构建入口、首页和 `/__management/session`、`/__library/records` 的预期响应，遵守原认证机制。核对原项目和资料可见。HTTP 200、旧页面版本标记或构建成功不能单独证明本机部署成功。

## 6. 使用真实模型及本机真实摄影验收

通过原 URL 和原浏览器配置打开应用。原场景资料只读；新增验收内容使用独立可删除的测试方案，不删除生产设施或改写其位置。

1. 项目部、钢筋棚：先核实工程 CAD 单位/配准，选择各设施的闭合设计轮廓，点击“按图纸轮廓自动布置”。验证中心、朝向、长宽和保留高度、180° 反转、完整底面在界内及覆盖率；非矩形不能假定完全贴合。确认多点摄影有效率及高差，留意树木等地物和水平底面悬空；对照现场控制高程。再验证手动定位/等比/XYZ、保存刷新、显隐/编辑/删除；旧方案不能被自动重新布置。
   云端取得的《平面布置图(2).dwg》未能确认驻地/钢筋厂闭合外轮廓，且 INSUNITS 与图示单位冲突。优先使用本机当前工程已上传并配准的真实图纸和已选设施边界；不得将泥浆厂/集土坑/单个钢筋工位当成整个厂区。确实缺少正确轮廓时明确标为未验收，不能猜造。
   核对新版驻地屋顶、两翼、旗台、门墙及院内标识和钢筋棚两端，确认旧单位与项目名称已清除；新字是精确透明平面字面。检查临建专属照明在实际场景的效果，其他摄影和机械亮度应不变。网络面板的私有模型 URL 应带与 manifest 一致的 SHA 版本，刷新后不得继续加载旧包。
2. 宣传墙：独立新增、文字/LOGO 更换及延迟读取后的新预览、保存/刷新、显隐/定位/删除。确认钢筋棚旧底栏残片不可见，项目部待配置图板未被当成真实项目资料。
3. 摄影遮挡：关联正确图层，启用/关闭/隐藏/删除/重载/总开关、多临建同时存在、保留其他裁剪；比较实际场景像素及非目标区域。
4. 便道：真实摄影上的处理层底面贴合、处理层和硬化层厚度、弯道/孔洞/陡坎、现场高程基准；确认新建不计算土方，旧历史方案仍读取。
5. 既有功能：场景图层、机械配置/倾覆/侵限、防护人员、铁路安全、CAD 导入/定位、存储及原录像/AR 工作流。保留原数据和业务ID。

记录实际截图、运行错误和操作结果；含模型/现场内容的截图只保存本机私有目录。如果本机也缺真实摄影，明确列为未完成；合成测试面不代替现场验收。实际浏览器加载或功能检查失败时修复后再验证；无法安全完成则恢复原服务并报告具体阻断。

## 7. 本机交付记录

完成后向用户提供：实际工程路径、原URL、当前服务PID/模式、运行完整SHA/整合关系、私有包及安装清单校验、备份/回退位置、实际测试命令与退出码、现场验收截图、已完成和未完成事项。

同时写本机部署记录到私有 output 目录。PR #8 保持 Draft，不发布模型，不自动合并。只有确认代码、私有资源和原服务实际运行一致之后，才可报告“本机部署完成”；现场验收状态应另外明确。
