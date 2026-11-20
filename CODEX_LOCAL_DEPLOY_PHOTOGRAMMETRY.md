# 本机 Codex：第二轮倾斜摄影位置调整

用户已确认上一轮完成。本轮继承基线为 9c8b1b4fb273914904f0528e6ee9400cbc8be330，独立分支 codex/photogrammetry-transform-v1.2.2。只部署 GPT 本次最终交付消息指定的完整 SHA；GitHub 提交和 CI 通过不等于用户电脑已上线。

## 保护条件

GPT 负责产品代码，本机 Codex 只做环境核验、部署、真实模型/GPU验收和反馈，不自行重构。不得新建本机备份、旧目录副本、ZIP、.bak、stash 或 bundle；不清空 IndexedDB/OPFS，不复制生产数据库或浏览器资料作测试副本。原工程/摄影/临建模型、视频、CAD、数据库、账号权限、SDK、私人配置及密钥原位保留，不上传公开 GitHub。必要候选检出、依赖、构建、合成测试与脱敏日志可创建。

## 核验运行身份与环境

从实际访问地址/桌面入口定位监听 PID、命令行、工作目录、启动包装、源码和 dist。记录实际 git rev-parse HEAD、dist/index.html SHA-256，并核对 HTTP 主要 bundle。此前原地址为 http://127.0.0.1:5289/，以现场核验为准；保持原 origin、三个数据根、SDK和启动方式。localhost、127.0.0.1及不同端口具有不同浏览器存储身份，不得误判为数据消失。

Node使用24.x和原锁文件，浏览器支持WebGL2；不升级Cesium或应用依赖。记录浏览器、GPU、驱动及ANGLE renderer。主服务必须使用带Node接口的Vite preview，普通静态服务器不具备完整资料库能力。

在独立候选PowerShell进程中、任何可能启动测试服务的检查之前设置合成数据根，不能继承正式数据根：

    $env:CESIUM_DATA_DIR = Join-Path $PWD "output\photo-candidate\library"
    $env:CESIUM_MANAGEMENT_DATA_DIR = Join-Path $PWD "output\photo-candidate\management"
    $env:CESIUM_SAFETY_DATA_DIR = Join-Path $PWD "output\photo-candidate\safety"
    $photoTestTemp = Join-Path $env:LOCALAPPDATA ("Temp\cesium-photo-test-" + [guid]::NewGuid().ToString("N"))
    [System.IO.Directory]::CreateDirectory($photoTestTemp) | Out-Null
    $env:TEMP = $photoTestTemp
    $env:TMP = $photoTestTemp

正常候选检出最终SHA；保留未提交改动，不用reset --hard、clean或覆盖旧运行目录。逐条执行并检查退出码：

    git rev-parse HEAD
    git status --short
    npm ci --no-audit --no-fund
    npm ci --prefix tools/temporary-works-assets --no-audit --no-fund
    npm test
    npm run test:cpu
    npm run test:tools
    npm run build
    git diff --check

Python使用已有兼容环境或按tools/ci/python-requirements.txt准备合成验证环境，设置PYTHON_EXECUTABLE后执行npm run test:python。Windows文件symlink权限不足时，只接受测试自己明确记录的夹具跳过，不提权或手动删测；普通路径、目录junction等继续执行。

## 临建原资源与候选服务

保留已核验的CESIUM_TEMPORARY_WORKS_ASSETS_DIR，指向原完整临建资源目录。变量必须在服务启动前设置；不因新源码检出而漏掉原私有包。只读核验，不复制或生成简化模型。原包不能位于即将被候选构建清理的dist中。

    node tools/install-temporary-works-assets.mjs --check --to "$env:CESIUM_TEMPORARY_WORKS_ASSETS_DIR"
    node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5290 --strictPort

先确认候选端口空闲，不停止未经PID/工作目录核实的进程。在保留同一变量的另一候选终端执行：

    node tools/verify-temporary-works-deployment.mjs --origin http://127.0.0.1:5290 --directory "$env:CESIUM_TEMPORARY_WORKS_ASSETS_DIR"

清单、三个GLB及LOGO的HTTP字节/哈希全部一致才通过；确认原项目部、钢筋棚、宣传墙完整结构、位置和外观保持。找不到原包或资源返回HTML时阻止正式切换，保留现场。

## 摄影位置验收

真实模型只读引用。保存等写操作使用已有独立测试项目或合成资料，不复制生产库、不随意改变正式融合位置。

| 操作 | 必查结果 |
| --- | --- |
| 原加载与旧偏移 | 经纬度偏移仍为度、高程仍为米；URL/ion/本地目录、质量和旧恢复路径不变；打开调整位置不能跳动 |
| 精确预览 | 东向X、北向Y、高程米、旋转度实时生效；重复输入不累积漂移；预览不写资料库 |
| 地图两点 | 实际点击起终点计算固定ENU平面差；高程保持；天空点继续等待、Esc取消；不密集采样 |
| 旋转中心 | 经纬高输入、地图点和轴标识一致；围绕所选中心旋转，正角度从东向北 |
| 取消/旧工具切换 | 恢复本次打开前精确矩阵，旧开挖/剖切/地表恢复；临建、工程模型及机械操作保持；没有拾取或监听残留 |
| 确认与刷新 | 仅确认写入，等待成功后关闭；刷新重开相同位置和参数；settings.matrix与编辑元数据一致 |
| 保存失败 | 合成服务制造错误；不报成功、不自动后台重试；回包丢失只读核验，结果未确认时明确提示，取消预览不等于撤销可能已到达服务端的写入 |
| 恢复原始位置 | 恢复首次位置编辑前矩阵（含旧加载校正），先预览后确认；取消仍回当前已存位置 |
| 生命周期 | 隐藏/删除/卸载、撤权、项目A→B→A、离页、重复打开，不产生迟到场景写入或复活对象；保存中正常导航受保护 |
| AR同步 | 保存后两套AR使用最终摄影矩阵；旧缓存正确失效并核验；已有参考位置变化按原流程重新读取成果定位/重新生成；退出AR仍为已存位置 |
| 地表与临建 | 取消预览原地表可恢复；确认移动后依赖旧采样的地表按原机制提示重建；保留其数据，不自动挪动工程结构、临建或旧补面 |

原工程模型位置/外观、资料权限、AR启停与缓存、开挖/剖切恢复、临建生成/保存/刷新、便道及硬化按影响范围回归。新功能通过不能代替旧功能验收。

AR验收边界：摄影新位置不会自动重算原视频轨迹或相机校准。当前已加载CC方案可重新读取成果定位；从资料库恢复含旧关联矩阵的CC方案时，现有校验会拒绝恢复，并清空失败的当前会话，原资料库方案和文件保留。此时需按新定位重新建立或校准方案，不能把“旧方案直接恢复成功”列为已交付能力。先在测试项目验证新定位，不随意改变已验收的正式融合位置。

浏览器变量沿用PLAYWRIGHT_MODULE、BROWSER_EXECUTABLE、FFMPEG_EXECUTABLE、FFPROBE_EXECUTABLE；新增脚本支持PHOTOGRAMMETRY_BROWSER_OUT和MEDIA_BROWSER_ENCODER。

    node tests/photogrammetry-transform-browser.mjs
    node tests/round1-media-intent-browser.mjs
    node tests/round1-scene-lifecycle-browser.mjs
    node tests/surface-edit-browser.mjs
    node tests/model-edit-appearance-browser.mjs

默认软件WebGL仅算合成验证，不能冒充真实GPU/素材验收。现场以同设备、同摄影和视角检查输入响应、地图缩放、加载和AR渲染，记录帧时、内存趋势、操作次数和耗时。没有新增密集摄影采样或逐帧重建，旧采样预算不变。

## 切换、反馈与回退

候选与原资源核验通过后按已有包装切换，保留origin、数据根、账号、SDK和原临建包配置。核验正式服务的准确SHA、构建与HTTP资源、冷启动、重复启动复用及原资料，不以候选目录HEAD代替实际运行身份。

反馈包含准确SHA、实际origin、环境/renderer、操作步骤、HTTP URL/状态/类型、浏览器console及服务stderr、相关矩阵/原生AR诊断、业务数据是否保持。私有路径、账号、真实模型或未脱敏HAR不得上传公开GitHub。

回退从GitHub基线9c8b1b4fb273914904f0528e6ee9400cbc8be330重建并恢复原启动引用，不新建本机副本。旧版本继续读取settings.matrix，因此已确认的新摄影位置仍保留；旧版没有本轮编辑按钮。若要回到首次位置，先在新版本预览“恢复原始位置”并确认；不能删除记录或用旧库覆盖。新增可选元数据可由旧版忽略，回退代码不等于撤销已保存业务操作。
