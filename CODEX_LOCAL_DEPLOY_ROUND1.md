# 本机 Codex 任务书：第一轮基础整改与 AR 场景切换

本任务针对 `codex/platform-round1-v1.2.2`，开发基线为 `1ab7cc2a86fde718ff8393f9ece50f3e476a0eff`。已核验的**产品代码候选 SHA 为 `83f2a59adbc61dc41e7a59072104d91c61ee48e4`**，不使用移动分支的最新 HEAD 代替。包含本任务书的后续交付提交仅增加部署和验证文档；如 GPT 交付消息指定该完整文档提交 SHA，可核对产品文件与上述候选一致后使用。验证记录见 [第一轮开发验证](docs/releases/round1-development-validation-2026-11-15.md)。

## 1. 分工与现场保护

GPT 工作模式负责产品实现、测试、GitHub 提交和缺陷修复；本机 Codex 负责只读核验、依赖/环境准备、部署、真实素材验证、日志采集与反馈。不要自行修改产品源码、减少断言、放宽预算、升级 Cesium、重构或开启第二轮功能开发。

禁止新建本机备份目录、ZIP、旧版副本、Git bundle、stash、`.bak`，禁止复制或改名现有运行目录作备份。仅在 GitHub 保存可公开代码版本。正常候选检出、构建、依赖、合成测试和验证日志属于工作文件，不得向其中复制生产数据库、浏览器资料或完整现场素材。

不执行 `git reset --hard`、`git clean -fd/-fdx`，不覆盖未提交修改，不清空 IndexedDB/OPFS，不从旧数据库覆盖当前数据。保留账号、权限、SDK、私有模型、数据根和桌面入口。现场数据及私密配置不上传公开 GitHub。

## 2. 先核验实际运行身份

历史地址 `http://127.0.0.1:5289/` 只是线索。先从实际地址和监听端口定位 PID，核对进程启动时间、命令行、工作目录、启动包装、实际源码与 dist 路径。

在该进程使用的源码目录记录：

```powershell
git rev-parse HEAD
git status --short
node --version
npm --version
Get-FileHash -Algorithm SHA256 .\dist\index.html
```

实际路径和完整命令行只保留本机受控记录，对外反馈需脱敏。对照启动包装和实际 HTTP 返回页面/主要 bundle 核验构建，不以另一个候选目录的 HEAD、HTTP 200 或能看到页面作为运行版本证据。

同时记录原协议、主机名、端口、三个数据根以及只读素材引用。`localhost`、`127.0.0.1`、不同端口具有不同浏览器存储身份；正式切换不得更换这些值导致数据看似丢失。

若与开发基线不同，记录准确差异并反馈 GPT，不擅自更换审查依据或覆盖现场改动。切换前确保实际旧代码已有可取回的 GitHub 引用；私有数据仍原位保留。

## 3. 候选准备与配置

使用必要候选目录从 GitHub 检出交付的准确 SHA，不复制旧运行目录。Node 使用 24.x（开发验证版本见本轮记录），按锁文件安装，不顺带升级依赖。

主服务是带 Node 接口的 Vite preview；只复制 dist 到普通静态服务器不能提供完整平台。浏览器要求 WebGL2；记录 Chrome/Edge、GPU、驱动及 ANGLE renderer。SKP SDK、ArcPy、FFmpeg、Python/CUDA仅按实际使用功能检查，保留原配置。

在**独立候选 PowerShell 进程**中、任何可能启动服务的测试之前设置以下测试数据根；不能继承正式数据根跑测试：

```powershell
$env:CESIUM_DATA_DIR = Join-Path $PWD "output\round1-candidate\library"
$env:CESIUM_MANAGEMENT_DATA_DIR = Join-Path $PWD "output\round1-candidate\management"
$env:CESIUM_SAFETY_DATA_DIR = Join-Path $PWD "output\round1-candidate\safety"
```

这些目录由测试或服务创建，不填入生产库。真实素材只读引用，修改/保存/删除操作在合成或已有独立测试项目中完成。

新增 `CESIUM_COOKIE_SECURE=true` 仅用于实际 HTTPS 部署；本地 HTTP 保持未设置或 false。服务不信任任意 `X-Forwarded-Proto` 来决定 Secure。登录和注销应使用同一配置。不要为了测试改机器级环境或正式包装。

私有缓存与摄影挂载仍通过受控接口访问；直接静态读取私有根应拒绝。诊断上报需要登录及 read 权限，读取最新诊断需要 admin；记录经过脱敏并有大小、频率和保留上限。附件保持原单文件上限，新增全局并发/内存预算超限时返回可重试错误；不要提高限额掩盖失败。

## 4. 安装、自动检查与启动

逐条执行，核对退出码；任一失败保留原正式服务，记录问题并反馈 GPT：

```powershell
git rev-parse HEAD
git status --short
npm ci --no-audit --no-fund
npm ci --prefix tools/temporary-works-assets --no-audit --no-fund
npm test
npm run test:cpu
npm run test:tools
npm run build
git diff --check
```

Python 合成测试使用已有兼容环境，或独立候选测试虚拟环境按 `tools/ci/python-requirements.txt` 安装；这不是实际推理/CUDA环境安装器。设置 `PYTHON_EXECUTABLE` 指向该环境的解释器，再运行 `npm run test:python`。Linux跳过的Windows行为须在本机重新核查，不直接沿用历史跳过记录。

浏览器/媒体测试按脚本设置 `PLAYWRIGHT_MODULE`、`BROWSER_EXECUTABLE`、`FFMPEG_EXECUTABLE`、`FFPROBE_EXECUTABLE`：

```powershell
node tests/surface-edit-panel-browser.mjs
node tests/surface-edit-browser.mjs
node tests/model-edit-appearance-browser.mjs
node tests/round1-scene-lifecycle-browser.mjs
node tools/verify-video-overlay-spatial.mjs
```

新场景专项及已有地表脚本可通过 `BROWSER_LAUNCH_OPTIONS` 使用指定浏览器启动配置。保存实际 renderer；SwiftShader/llvmpipe 只能记为软件渲染。`verify-video-overlay-spatial.mjs` 当前固定 SwiftShader，不能靠指定浏览器路径将其算作真实硬件 AR 验收。浏览器启动受限应记录 blocked，不算通过。

新场景专项硬件验收时同时设置 `$env:ROUND1_REQUIRE_HARDWARE = "1"`，避免将默认软件 WebGL 当成现场显卡结果；`ROUND1_BROWSER_OUT` 可指定报告目录。该开关仍以浏览器报告的 renderer 判断，必须与本机 GPU/驱动信息对照。

候选服务在确认空闲的独立端口上启动，例如：

```powershell
node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5290 --strictPort
```

不要通过占用正式端口测试重启行为。主平台默认 dev 为5173、preview为4173，实际正式包装以现场为准。可选旧Python WS默认8765/8766、AR V2默认5199；本轮没有改变这些服务的部署协议。

## 5. 第一轮真实场景验收矩阵

| 场景 | 必查结果 |
| --- | --- |
| 旧剖切→CC AR→退出 | AR能正常接管；退出恢复当前剖切位置、偏移和开关；无被销毁集合错误 |
| 旧开挖→另一套AR→退出 | 原开挖参数保留，暂停时旧辅助图形/地下效果不干扰；退出重新建立有效效果 |
| 旧开挖/剖切与临建、便道、新地表同目标 | 已知 owner 可暂停交接；关闭旧效果后受管贡献自动恢复；未知外部 owner不被销毁 |
| 嵌套缓存/拾取与AR退出 | 仍有租约时不提前恢复；最后释放才恢复；异常、取消与重复退出无残留 |
| 暂停期间修改参数/删除源/切项目/撤权 | 恢复当前有效状态；不复活已删除资源、不提交旧上下文候选 |
| AR休眠但保存遮挡开启，普通图层刷新 | 正在绘制/生成的地表任务不被取消，缺失摄影源也不能误暂停 |
| 未保存操作→尝试关闭→选择留在页面 | 管理、安全、机械与地图继续可用；实际离页才清理 |
| 慢影像A→快影像B、视频方案连续选择 | 最后有效选择生效，旧候选释放，不覆盖较新结果 |
| 模型加载中撤权/删除/换项目 | 不提交过期资源，隐藏候选不闪现；恢复权限后可重新加载 |
| 贴图保存中连续应用属性 | 最新有效表单生效，失败有反馈，不静默丢弃第二次修改 |
| 登录限速、文件访问和上传预算 | 多个时间窗口均限流；受控模型访问正常；静态私有路径拒绝；断开释放上传预算 |
| 反复切换与性能 | 按同设备/素材/视角测帧时、任务耗时、资源峰值和持续趋势；明确记录次数与时长 |

原模型位置与外观、摄影融合、SKP、CAD/GIS、资料库权限、便道临建硬化、机械倾覆、安全限界/人员、AR缓存/标注/导出、地表纹理与显隐等均按影响范围回归。没有采样阈值升级，原超限应受控拒绝，不能以卡死结束。

旧地下工具的锚点和参数仍是原有全局未保存草稿，不随项目切换清空；仅作用于当前权限允许的载入对象。这不等同于新增按项目保存开挖方案。新地表工具继续使用原有项目作用域。视频方案恢复的共享解码阶段串行运行，较新选择需等待前一不可中断的异步步骤返回；重点验证慢媒体、损坏媒体及中途手动导入，不把 CPU 测试作为解码耗时证明。

## 6. 反馈、切换与回退

反馈包括：准确候选SHA、原运行SHA、实际访问origin、Node/Python/浏览器/renderer、合成或真实素材类别、复现步骤、预期/实际、console和服务stderr、耗时与资源数据。不要向公开GitHub上传未脱敏HAR、真实模型/视频/数据库、凭据或私有路径。

自动检查通过不代表已通过本机验收。相关硬件与真实流程未验证时，候选保持待验证，不切换正式版本。发现产品缺陷时，Codex保留现场并反馈；GPT修复提交新SHA后重新部署验证。

相关验收通过且原代码GitHub回退引用已核实后，使用既有包装切换，保留原origin、数据根、账号权限和SDK；只停止经PID、启动时间、命令行及工作目录共同确认的本平台进程。更新匹配的源码SHA和dist/index.html哈希，验证原地址、桌面冷启动、重复启动复用及原业务数据可读。

失败时可恢复未改动的原启动引用，或从GitHub准确旧SHA重建匹配运行产物；不创建旧目录副本，不清空浏览器或项目资料，不用旧库覆盖当前数据。无法在约束内恢复时报告具体阻断。

最终反馈必须明确：已部署/仅候选、实际SHA及构建身份、自动与硬件结果、失败/跳过/未执行项、旧功能回归、GitHub回退点，以及本轮没有新建本机备份。
