# 本机 Codex 任务书：第一轮基础整改与 AR 场景切换

本任务针对 `codex/platform-round1-v1.2.2`，开发及性能比较基线仍为 `1ab7cc2a86fde718ff8393f9ece50f3e476a0eff`。**本次必须先恢复临建资源访问：用户反馈“临建结构没有了”及 HTML 被当作 JSON 读取，属于部署回归阻断。** 新增原有私有资源包的只读挂载、HTTP 核验及清单错误诊断；不替换模型、不改变尺寸、锚点、轮廓或原方案数据。此前测试帧驱动和裁剪清理修正继续保留。最终准确提交使用 GPT 本次最终消息给出的完整 SHA，见 [第一轮收口记录与固定验收清单](docs/releases/round1-closeout-2026-11-15.md)。

最新本机报告已验证 595 的两套媒体选择和真实摄影遮挡启停；该报告的桌面实际运行 `b9f88cba03e34cb1e02709eead294a663ac17b75`，仍待完成验收。最新临建截图未附带运行 SHA，必须重新核对实际进程。本次已有产品变更，不能继续声称全部产品与 595 等价；未改动模块的历史结果明确标注原实测 SHA，临建服务、加载和原功能另行验证。本次没有操作用户电脑或切换正式服务。

## 1. 分工与现场保护

GPT 工作模式负责产品实现、测试、GitHub 提交和缺陷修复；本机 Codex 负责只读核验、依赖/环境准备、部署、真实素材验证、日志采集与反馈。不要自行修改产品源码、减少断言、放宽预算、升级 Cesium、重构或开启第二轮功能开发。

禁止新建本机备份目录、ZIP、旧版副本、Git bundle、stash、`.bak`，禁止复制或改名现有运行目录作备份。仅在 GitHub 保存可公开代码版本。正常候选检出、构建、依赖、合成测试和验证日志属于工作文件，不得向其中复制生产数据库、浏览器资料或完整现场素材。

不执行 `git reset --hard`、`git clean -fd/-fdx`，不覆盖未提交修改，不清空 IndexedDB/OPFS，不从旧数据库覆盖当前数据。保留账号、权限、SDK、私有模型、数据根和桌面入口。现场数据及私密配置不上传公开 GitHub。

## 2. 先核验实际运行身份

最新本机反馈已在 `http://127.0.0.1:5289/` 核验运行版本为 `b9f88cba03e34cb1e02709eead294a663ac17b75`，首页构建 SHA256 为 `1690582471e2cc78e1f8eb48384e5de93bd39377e8bd5133f674a94750516024`。595 候选在该机构建的首页哈希为 `a36ee03679c5bf80895236b3d2101af8c8b1c648691ca2037a4476ec7bf1606e`。这些是该次本机报告的证据；重新部署前仍须从实际地址和监听端口定位 PID，核对进程启动时间、命令行、工作目录、启动包装、实际源码与 dist 路径。不同环境的构建哈希不能用来替代提交与 HTTP 主要资源核验。

若该端口没有监听，只能核验磁盘上的源码、构建和启动包装；记录“正式服务当前未运行”，不能使用历史 PID 或旧版本记录代替在线 HTTP 身份证明。

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

`TEMP`/`TMP` 应放在候选源码树外；机械遥测 CLI 会正确拒绝把私有配置写入源码目录。可在同一独立候选 PowerShell 进程创建专用合成临时目录，例如：

```powershell
$round1TestTemp = Join-Path $env:LOCALAPPDATA ("Temp\cesium-round1-test-" + [guid]::NewGuid().ToString("N"))
[System.IO.Directory]::CreateDirectory($round1TestTemp) | Out-Null
$env:TEMP = $round1TestTemp
$env:TMP = $round1TestTemp
```

核对该目录确实位于候选源码树外，不修改机器级变量，不向其中复制正式资料。

新增 `CESIUM_COOKIE_SECURE=true` 仅用于实际 HTTPS 部署；本地 HTTP 保持未设置或 false。服务不信任任意 `X-Forwarded-Proto` 来决定 Secure。登录和注销应使用同一配置。不要为了测试改机器级环境或正式包装。

私有缓存与摄影挂载仍通过受控接口访问；直接静态读取私有根应拒绝。诊断上报需要登录及 read 权限，读取最新诊断需要 admin；记录经过脱敏并有大小、频率和保留上限。附件保持原单文件上限，新增全局并发/内存预算超限时返回可重试错误；不要提高限额掩盖失败。

### 3.1 临建原资源必须原位接入

公开 GitHub 不包含项目部、钢筋棚、宣传墙的私有 GLB、LOGO 和真实几何清单。`npm ci --prefix tools/temporary-works-assets` 只安装工具依赖，**不会安装或恢复这些模型**。此前候选部署遗漏了这一环节；构建通过不能证明原临建功能可用。

从原实际运行目录及既有私有包配置核实完整资源所在位置，优先核对原 `public/models/temporary-works` 或 `dist/models/temporary-works`。不要全盘搜索、创建新备份、复制旧运行目录或重新生成简化模型。完整原包包含 `manifest.json`、其声明的 camp/steel/wall 三个 GLB 与 `cr24-logo.png`。存在多个包时以原运行 HTTP 内容和清单 SHA/尺寸/锚点核对，不凭最新时间选取。

在候选进程中设定下列变量为**经核对的原资源目录绝对路径**；示例中的占位路径不可直接使用：

```powershell
$env:CESIUM_TEMPORARY_WORKS_ASSETS_DIR = "<原有完整临建资源目录的绝对路径>"
node tools/install-temporary-works-assets.mjs --check --to "$env:CESIUM_TEMPORARY_WORKS_ASSETS_DIR"
```

此处只运行 `--check`，不运行复制安装的 `--from`，不写入、重命名、删除原包。该变量是服务端配置，浏览器仍使用原 `/models/temporary-works/` 地址；不能把本机路径填入模型 URL 或上传到 GitHub。未设置变量的既有安装继续读取 dev 的 public 或 preview 的 dist 资源。配置无效时保留原文件并报告具体阻断，不静默切到其他版本的包。

变量必须在服务启动前设置，变更变量后重启对应候选服务。旧 public/dist 方式也应在资源齐备后启动；不能在 dev 服务运行中写入 public 后，利用尚未同步的 Vite 文件监听缓存判断部署是否成功。本轮恢复优先使用上述原包只读挂载。

正式启动包装也必须保留这个经核验的变量。若原包位于将被构建覆盖的候选 `dist` 内，不得在该处先执行清理构建；使用已存在且不受候选构建影响的原包位置。只有候选代码而找不到完整原包时，记录“原私有资源不可定位”，停止正式切换并反馈，不把隐藏临建、空模型、删除方案当作修复。

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

Windows 无文件 symlink 创建权限时，仅接受测试本身在创建文件链接夹具阶段明确标出的环境跳过；按实际测试名与原因逐项记录，不固定跳过数量、不手动屏蔽测试。本轮新增临建资源逃逸测试也使用同一受限夹具。普通路径、HTTP权限、旧日志脱敏和目录 junction 检查必须继续执行，失败仍需处理；有权限的 CI 必须实际执行文件链接边界。不要为通过测试提升权限或改机器策略。跳过不算该机对应边界验证通过，但可以继续执行其他验收项，反馈中保留跳过原因。

浏览器/媒体测试按脚本设置 `PLAYWRIGHT_MODULE`、`BROWSER_EXECUTABLE`、`FFMPEG_EXECUTABLE`、`FFPROBE_EXECUTABLE`：

```powershell
node tests/surface-edit-panel-browser.mjs
node tests/surface-edit-browser.mjs
node tests/model-edit-appearance-browser.mjs
node tests/round1-scene-lifecycle-browser.mjs
node tests/round1-media-intent-browser.mjs
node tools/verify-video-overlay-spatial.mjs
```

新场景专项及已有地表脚本可通过 `BROWSER_LAUNCH_OPTIONS` 使用指定浏览器启动配置。保存实际 renderer；SwiftShader/llvmpipe 只能记为软件渲染。`verify-video-overlay-spatial.mjs` 当前固定 SwiftShader，不能靠指定浏览器路径将其算作真实硬件 AR 验收。浏览器启动受限应记录 blocked，不算通过。

新场景专项硬件验收时同时设置 `$env:ROUND1_REQUIRE_HARDWARE = "1"`，避免将默认软件 WebGL 当成现场显卡结果；`ROUND1_BROWSER_OUT` 可指定报告目录。该开关仍以浏览器报告的 renderer 判断，必须与本机 GPU/驱动信息对照。

新增媒体专项使用合成 MP4/XML、真实资料库与 CC 原面板。它通过原“使用”按钮和文件输入重现延迟 HTTP 请求，在旧响应放行前后导出原生配准诊断，连续验证三次，并验证真实旧剖切下的遮挡开关、进入/退出和未知 owner 拒绝，共 6 项。`ROUND1_MEDIA_BROWSER_OUT` 可指定输出目录；该脚本的编码器变量为 `MEDIA_BROWSER_ENCODER`（默认 `libx264`，可选本机已有的 `libopenh264`），与旧视频脚本的 `FFMPEG_VIDEO_ENCODER` 分开。硬件配置继续使用 `BROWSER_LAUNCH_OPTIONS` 和 `ROUND1_REQUIRE_HARDWARE=1`。此专项不包含旧 `VideoArFusion` 的原生面板，该面板的手动选择、附属文件和自动保存仍须另行实际验证。脚本启动受限返回 2、断言失败返回 1；blocked 不能计为通过。

新第七项要求保留首次创建的同一自有 Globe 裁剪集合，工具销毁后禁用但仍未销毁，Viewer 销毁后该集合才销毁，再次销毁仍安全。最新本机报告已在旧候选取得两次完整 7/7 及 `retainedTerrainDestroyed: true`；新交付仍需回归，不能沿用旧结果。地表报告的 404 已由本机定位到 `/favicon.ico`，本轮没有修改旧页面图标；继续保存 `consoleErrorLocations`、`httpErrors` 和 `requestFailures`，不把图标结果代替模型/纹理请求验证。

若本机 FFmpeg 没有 `libx264`，先用 `ffmpeg -encoders` 核对已有编码器；可通过脚本已有的 `FFMPEG_VIDEO_ENCODER` 参数指定确认可用的 `libopenh264`。该软件渲染脚本仍不能计作真实硬件 AR 验收。

候选服务在确认空闲的独立端口上启动，例如：

```powershell
node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5290 --strictPort
```

服务启动后在保留同一配置的另一个候选终端执行实际 HTTP 核验：

```powershell
node tools/verify-temporary-works-deployment.mjs --origin http://127.0.0.1:5290 --directory "$env:CESIUM_TEMPORARY_WORKS_ASSETS_DIR"
```

该检查必须验证原清单、三类 GLB 及 LOGO 的实际 HTTP 响应与原包字节一致；只读流式计算哈希，不保存模型副本。缺文件、HTML 响应、错误内容或哈希不符均不能通过。随后在实际页面复验三类临建“生成并预览→保存→刷新重开”，并检查已有临建的结构/外观、位置与高程、尺寸/旋转、显隐/编辑、摄影遮挡切换。已有正式方案只读核对，保存等操作用隔离测试方案。记录请求 URL、状态、Content-Type 及 console 错误；不能只截图首页或只检查文件存在。

不要通过占用正式端口测试重启行为。主平台默认 dev 为5173、preview为4173，实际正式包装以现场为准。可选旧Python WS默认8765/8766、AR V2默认5199；本轮没有改变这些服务的部署协议。

## 5. 第一轮真实场景验收矩阵

| 场景 | 必查结果 |
| --- | --- |
| 原临建私有资源与已存方案 | 同一原包通过只读校验及实际 HTTP 字节核验；项目部/钢筋棚/宣传墙完整结构恢复，已存方案位置/尺寸/外观不变，生成、编辑、保存/刷新、显隐、摄影遮挡正常 |
| 旧剖切→CC AR→退出 | AR能正常接管；退出恢复当前剖切位置、偏移和开关；无被销毁集合错误 |
| CC面板选视频/XML→勾选实景遮挡 | 选文件后仍可启用已知裁剪源遮挡；成功后暂停旧效果，退出恢复；重复勾选与换源无残留 |
| 未知外部裁剪→勾选实景遮挡 | 仍明确拒绝，不销毁/修改未知集合；只释放本次新取得的暂停资源 |
| 旧开挖→另一套AR→退出 | 原开挖参数保留，暂停时旧辅助图形/地下效果不干扰；退出重新建立有效效果 |
| 旧开挖/剖切与临建、便道、新地表同目标 | 已知 owner 可暂停交接；关闭旧效果后受管贡献自动恢复；未知外部 owner不被销毁 |
| 嵌套缓存/拾取与AR退出 | 仍有租约时不提前恢复；最后释放才恢复；异常、取消与重复退出无残留 |
| 暂停期间修改参数/删除源/切项目/撤权 | 恢复当前有效状态；不复活已删除资源、不提交旧上下文候选 |
| AR休眠但保存遮挡开启，普通图层刷新 | 正在绘制/生成的地表任务不被取消，缺失摄影源也不能误暂停 |
| 未保存操作→尝试关闭→选择留在页面 | 管理、安全、机械与地图继续可用；实际离页才清理 |
| 慢影像A→快影像B、视频方案连续选择 | 最后有效选择生效，旧候选释放，不覆盖较新结果 |
| 旧视频方案读取中→手动选择新视频 | 两套AR分别测试；旧GET完成后原生诊断、方案名与文件输入仍属于新选择；旧请求不能清空新输入 |
| 模型加载中撤权/删除/换项目 | 不提交过期资源，隐藏候选不闪现；恢复权限后可重新加载 |
| 贴图保存中连续应用属性 | 最新有效表单生效，失败有反馈，不静默丢弃第二次修改 |
| 登录限速、文件访问和上传预算 | 多个时间窗口均限流；受控模型访问正常；静态私有路径拒绝；断开释放上传预算 |
| 反复切换与性能 | 按同设备/素材/视角测帧时、任务耗时、资源峰值和持续趋势；明确记录次数与时长 |

原模型位置与外观、摄影融合、SKP、CAD/GIS、资料库权限、便道临建硬化、机械倾覆、安全限界/人员、AR缓存/标注/导出、地表纹理与显隐等均按影响范围回归。没有采样阈值升级，原超限应受控拒绝，不能以卡死结束。

旧地下工具的锚点和参数仍是原有全局未保存草稿，不随项目切换清空；仅作用于当前权限允许的载入对象。这不等同于新增按项目保存开挖方案。新地表工具继续使用原有项目作用域。视频方案恢复的共享解码阶段串行运行，较新选择需等待前一不可中断的异步步骤返回；重点验证慢媒体、损坏媒体及中途手动导入，不把 CPU 测试作为解码耗时证明。

## 6. 反馈、切换与回退

反馈包括：准确候选SHA、原运行SHA、实际访问origin、Node/Python/浏览器/renderer、合成或真实素材类别、复现步骤、预期/实际、console和服务stderr、耗时与资源数据。不要向公开GitHub上传未脱敏HAR、真实模型/视频/数据库、凭据或私有路径。

自动检查通过不代表已通过本机验收。临建原功能恢复是本次切换的必要条件，未恢复前不得标记第一轮完成。本次固定批次通过并完成第 6 节的部署身份核验后，即记录第一轮完成，不因范围外专项尚未验证而继续保留第一轮待办。发现具体产品回归时，Codex保留现场并反馈准确失败链；GPT按影响范围修复，不能要求无关已通过项目从头复验。

相关验收通过且原代码GitHub回退引用已核实后，使用既有包装切换，保留原origin、数据根、账号权限和SDK；只停止经PID、启动时间、命令行及工作目录共同确认的本平台进程。更新匹配的源码SHA和dist/index.html哈希，验证原地址、桌面冷启动、重复启动复用及原业务数据可读。

失败时可恢复未改动的原启动引用，或从GitHub准确旧SHA重建匹配运行产物；不创建旧目录副本，不清空浏览器或项目资料，不用旧库覆盖当前数据。无法在约束内恢复时报告具体阻断。

最终反馈必须明确：已部署/仅候选、实际SHA及构建身份、自动与硬件结果、失败/跳过/未执行项、旧功能回归、GitHub回退点，以及本轮没有新建本机备份。
