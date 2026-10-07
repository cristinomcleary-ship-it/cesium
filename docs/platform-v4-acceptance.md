# Cesium 平台 V4 实施与验收记录

2026-10-07。在已验证基线 `765df3de4427e526d5415738bec60d7309af4259` 上增量实施，唯一完整要求为 `Cesium_Platform_Design_v4/00-CODEX-START.md`。本文记录现有真实工程的证据；设计包中的合成模型、概念图片和参考录像不作为项目通过证据。

**当前真实资产范围内，G01–G12 的视觉与功能检查通过。** 实际三维五组、19 个业务状态与 21 项主流程、12 项边界、6 项世界动效及 5 项最终运行检查均完成；原 CAD 30 项、AR 19 项回归和 192 项单元测试通过。最终单路 4K 视频与标准动效同跑为 **28.83 FPS**，暂停装饰为 **28.92 FPS**，均零视频丢帧；长业务操作后为 **24.89 FPS**。三组均低于建议的 30 FPS，性能目标仍未达到。正式业务接口和工程精度缺项另列。

## 生产接入与实际改动

沿用原 TypeScript/Vite 页面和同一个 Cesium Viewer，未创建独立演示站。实际依赖为 Cesium 1.144.0、ECharts 6.1.0、Vite 7.3.6、TypeScript 5.9.3，未为设计包升级依赖。

| 文件或目录 | 实际接入职责 |
| --- | --- |
| `src/safetyScenePresentation.ts` | 原场景与 V4 runtime 的适配入口。使用已注册、已加载的真实倾斜摄影；管理材质/裁切归属、模型变化、创建/销毁、绘制暂退和模式恢复；不启用强制覆盖既有材质 |
| `src/presentationV4/install-presentation.js`、`scene-presentation.js`、`effects.js` | 从设计包接入的运行模块及对 Cesium 1.144.0 的实际适配；原模型表面 CustomShader、世界裁切、独立侧壁/底面/边线和世界坐标动效 |
| `src/presentationV4/projectDisplayConfiguration.ts`、`production2-display-envelope.json` | 独立显示外缘和项目总览相机；绑定真实资产与变换版本。按中央可用空间计算镜头，显示范围不写入施工或铁路台账 |
| `src/safetySceneEffects.ts`、`safetyWorldEffectGeometry.ts` | 复用业务动画时钟，真实航迹流光、选中描边和脉冲；保留真实轨迹，移除旧中心到无人机的示意连线；控制标签与动效预算 |
| `src/safetySpatialEditor.ts`、`safetySpatialDisplayGeometry.ts` | 人工已存几何采用逐点 ECEF 的独立网格与边线；仅显示增加 0.12 m 偏移，不修改原坐标，不把地面范围分类投射到桥面 |
| `src/safetyWorkspace.ts`、`safetyDashboardV3.ts` 及对应 CSS | 保留四模块与原媒体/图层接口；正式进入总览固定展示模式，主题切换保持相机，回到总览恢复专用镜头；精简布局、设置和空态 |
| `src/main.ts`、`src/safetyWorkspace.css` | 未提供 Ion 令牌时使用本地坐标搜索入口；保持 Cesium 署名可见与可操作，避免令牌警示占据项目画面 |
| `tools/verify-platform-v4*.cjs`、相关测试文件 | 实际项目场景、19 状态、严格取点边界、世界动效及 CPU 回归验收 |

显示外缘绑定 `Production_2` 资产 `8bc58629-cf26-45de-986e-086479db11a0`，包含从该模型表面采样的 574 个显示顶点，采样间距最大 3 m。顶缘高程约 16.90–37.66 m，显示底深 42 m；这些数值只控制独立展示构件。相机标定航向 68°、俯角 −42.5°，距离随可用区域调整。原模型矩阵、工程高程和人工台账点未被底座或镜头配置改写。

## 启动和复测

保持原使用方式，在已有依赖的本机运行：

```powershell
Set-Location 'F:\codex\cesium'
Remove-Item Env:CESIUM_SAFETY_DATA_DIR -ErrorAction SilentlyContinue
& 'F:\Node.js\node.exe' node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort
```

打开 `http://127.0.0.1:5173/?screen=safety`，也可使用 `tools/start-safety-dashboard.ps1`。新目录按锁文件执行 `pnpm install --frozen-lockfile`，仍使用原工程资料库；源码包不另带 GB 级模型和视频。

复测采用新的独立业务数据目录，不能复用既有正式数据或清空之前的验收目录：

```powershell
$env:CESIUM_SAFETY_DATA_DIR = Join-Path (Get-Location) ('tmp/platform-v4-test-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
& 'F:\Node.js\node.exe' node_modules/vite/bin/vite.js --config tools/vite.platform-acceptance.config.mjs --host 127.0.0.1 --port 5197 --strictPort
```

另开终端，配置本机 `PLAYWRIGHT_MODULE`，串行执行真实浏览器脚本，避免多个 GPU 浏览器相互影响：

```powershell
node tools/verify-platform-v4-scene.cjs
node tools/verify-platform-v4.cjs
node tools/verify-platform-v4-edges.cjs
node tools/verify-platform-v4-motion.cjs
node tools/verify-platform-v4-final.cjs
```

最终冻结波次使用 `tmp/platform-v4-final-acceptance-20261007`、端口 5197，顺序为 scene → main → edges → motion → final。重新复验请生成另一个新目录，不复用或清空上述记录。

主脚本要求初始施工/铁路/风险点为 0/0/0、事件为空；后续脚本读取主脚本保存的人工对象。验收对象与事件名称明确标注“验收示例”，仅写独立目录；不能按名称自动删除已有来源不明记录。脚本拦截原资料库写请求，日常启动前清除验收目录环境变量。

## 十二门槛

| 门槛 | 当前结果与证据 |
| --- | --- |
| G01 默认 | **通过。** 从实景近景刷新/重进和点击回到总览，均恢复展示与项目镜头；单独切展示/实景保持相机。`scene-acceptance-report.json` |
| G02 材质 | **真实场景检查通过。** 同镜头、停动画、隐藏界面的展示/实景图中网格实际可见；95/95 个同像素采样命中共同真实地物，世界位置一致、模型矩阵未变。最终像素报告中 95/95 个样本均发生表面色彩改变，平均绝对 RGB 差 62.458246（0–255 范围），最大对应世界点误差 0.000000 m；`material-pixel-comparison.json` 绑定最终场景报告 SHA，不能仅凭 Shader 已赋值判断完成 |
| G03 构图 | **通过。** 1920×1080 与 2048×1017 的宽高占比、前缘和四侧留白符合目标，实测数值见下表 |
| G04 裁切 | **通过。** 业务范围关闭时，真实模型仍有有限外缘；旋转约 30°外缘保持世界位置。纯三维截图及 `04-real-project-viewer.mp4`，无屏幕遮罩代替裁切 |
| G05 底座 | **通过。** 两种相差约 30°的实际视角显示独立厚度；总览前缘 58.65/55.11 px，旋转视角 57.76 px。原模型矩阵不变，未移动工程模型制造厚度 |
| G06 边界 | **通过。** 人工施工/铁路范围按原逐点高度形成独立网格，填充 12%，正常边线 3 px、选中 4 px，无 ground clamp、分类投射或穿透线材质。上方展示/实景和约 30°旋转截图中，青色施工面、琥珀铁路面均可辨并保持世界位置，无尖片或误投桥面；实际桥面遮挡仍保留，不为显色开启穿透 |
| G07 标签 | **通过。** 实际总览为 4 个、聚焦为 2 个标签，分别小于总预算 8/5，计数包含设备。原 CAD 杂注默认关闭，绘制时隐藏干扰；`motion-acceptance-report.json` |
| G08 配置 | **通过。** 三类手动定义、名称唯一必填、默认待评估；铁路为手绘闭合多边形，实际按钮完成撤销/完成/取消、命名保存。98.744 秒人工操作录像及 19 状态截图 |
| G09 数据 | **通过。** 独立空集合 0/0/0；保存和刷新恢复、编辑取消、两种保存 503 失败留稿/重试、软删除与撤销/最近删除恢复、天空与画布外无效点、注册/变换失配及失焦回滚均验证。模型锚点、ID、版本和原始坐标保留，原 25 份元数据哈希前后相同 |
| G10 动态 | **通过。** 27.047 秒实录含 16.861 秒实际动画、约 30°旋转及 18% 距离缩放；世界锚点固定，屏幕投影跟随相机。实际 UI 暂停和减少动态各持续至少 3 秒，材质时间及原 Viewer 画面均稳定（两组像素差为 0）。共用宿主时钟、最多三组动效，3467 个流光顶点逐点对应真实轨迹；业务快照、轨迹和模型矩阵不变 |
| G11 页面 | **通过。** 最终三尺寸实际 Viewer 布局无横滚、署名与状态栏/面板重叠为 0；`final-runtime-report.json`。另有 30 项隔离 UI 检查通过；本机坐标搜索、无默认令牌警示和署名入口有独立实测。真实视频/事件/资料缺项显示空态，未虚构在线状态 |
| G12 成果 | **通过。** 实景/展示同镜头、纯三维、旋转侧壁、人工创建保存刷新均有真实项目证据，Viewer 录像 28.746 秒；具体限制与性能未达项在本文列明 |

所有通过声明以项目报告和实际画面为依据；包内 `evidence/` 仅用于比照实现方法。完整读取和实际打开索引、状态及播放动态参考的过程见 `output/platform-v4/reference-inspection.json`。

### 总览构图实测

以侧栏之间、顶栏之下、工具栏之上的中央区域为基准；比例仅约束总览，不约束对象近景。

| 分辨率 | 主景宽占比 | 主景高占比 | 前缘厚度 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 1920×1080 | 82.00% | 75.31% | 58.65 px | 满足 G03、G05 |
| 2048×1017 | 70.46% | 78.00% | 55.11 px | 满足 G03、G05 |
| 1366×768 | 56.88% | 78.00% | 36.95 px | 紧凑布局无横滚；G03/G05 的全尺寸比例目标不套用于该尺寸 |

1920 中央可用区域为 `(360,162,1200,738)`，主景投影范围为 `(468.00,253.10)–(1452.00,808.90)`，四侧均超过 24 px 留白。2048 亦按实际可用区域标定，保留前缘及工具栏空间。旋转录像另外核对侧壁连续性，不把旋转视角当作总览构图测量。

## 运行质量、数据保护与适用范围

| 检查 | 实际结果 |
| --- | --- |
| 类型检查、单元与构建 | `tsc --noEmit` 通过；26 个测试文件共 192 项通过、0 失败/跳过，其中包括 9 项展示生命周期测试；生产构建 18.64 秒完成。保留既有 LibreDWG `node:module` 浏览器外置和大于 500 kB 的包提示 |
| 原 CAD 回归 | 本轮 30 项通过；`cad-regression.log`。保留 POINT 隐藏及原圆/编号、线显示与原图层行为 |
| 原视频 AR 回归 | 本轮 19 项通过；`video-ar-regression.log`。此功能回归不等于实际工程配准精度验收 |
| 真实业务主流程 | 21 项检查通过，19 个必需状态全部采集；`acceptance-report.json` |
| 取点与编辑边界 | 12 项检查完成，pageerror/consoleerror 为 0，未留下新增对象或改写原保存对象；`edge-acceptance-report.json` |
| 世界动效 | 6 项实机检查通过，页面/控制台/渲染错误为 0、业务写入为 0；暂停与减少动态前后画面 SHA-256 分别完全一致，业务数据与原始航迹哈希前后相同；`motion-acceptance-report.json` |
| 取高/宽度热点回归 | 8 项 CPU 检查通过：失败取高最多三次、条件改变后重试、人工点不参与 CAD 调高，同一线宽保持原 ConstantProperty；`hotpath-regression-report.json`。此项不证明 GPU 帧率 |
| 页面与署名 | 隔离 UI 30 项通过。Geocoder/署名使用实际安装的 Cesium 类检查七种布局，署名可点击，坐标检索得到 114.25°/30.5°/125 m；此项没有渲染项目，也未以真实凭据连接 Ion |
| 最终实际布局/图层 | 5 项通过：三尺寸署名与状态栏重叠为 0、刷新数据保持、两类人工面顶视/旋转、3 轮隐藏/重显真实模型不抢近景、回总览正确；业务数据及矩阵不变、业务写入/页面/控制台错误均为 0；`final-runtime-report.json` |
| 反复切换 | 10 轮页面与配置切换后保持 1 Viewer、1 业务时钟监听、1 编辑拾取器、1 编辑 postRender 监听；业务显示源 1 个、实体 235 个，已存人工实体 3 个，前后数量相同；退出恢复原工作台及材质 |
| 原资料保护 | `baseline-data.json` 保存原记录/坐标/版本。原 `project-data` 的 25 份视图、记录及已删除标记元数据 SHA-256 前后完全相同；未逐字节重新哈希全部 GB 级媒体 |
| 错误与网络 | 真实场景 pageerror/consoleerror/失败请求为 0。主流程 pageerror 为 0，控制台两次 503 均为故意注入的空间/事件保存失败；16 次请求取消均为 `net::ERR_ABORTED`，与媒体/瓦片切换相关 |

场景专用运行首次业务数据就绪 **9.784 秒**，真实网格加载检查完成 **35.530 秒**；主业务运行首次数据就绪 **10.998 秒**。这些是不同独立运行的计时字段，不能把业务数据就绪等同全部瓦片与视频解码完成。

实际性能环境为 Windows、Edge 149、RTX 4080、1920×1080、DPR 1，单路 3840×2160 视频播放，按 `scene.postRender` 采样。以下都是实际场景运行结果：

| 运行条件 | 采样时长 | FPS | P95 帧间隔 | 视频帧数 / 掉帧 |
| --- | ---: | ---: | ---: | ---: |
| 完整业务操作及 10 轮切换后 | 30.538 秒 | 24.89 | 56.90 ms | 1089 / 0 |
| 最终复测，标准装饰动效 + 4K 视频 | 31.042 秒 | 28.83 | 50.40 ms | 929 / 0 |
| 最终复测，暂停装饰 + 4K 视频 | 31.019 秒 | 28.92 | 51.20 ms | 930 / 0 |

三组均未达到建议的 30 FPS。暂停装饰在本次样本中改善有限，不能宣称仅关闭动效即可解决帧率；仍需针对真实模型/视频与渲染负载继续专项优化。录像 24 FPS 是编码参数，不是平台帧率。资源计数稳定不等同 GPU 显存分析结果，本轮未宣称显存绝不增长。

## 实际项目截图与录像

以下均来自当前项目已有真实 `Production_2` 模型；最终图像在 `output/platform-v4/`，调试失败与中间校准截图不作为验收结果。

**证据版本说明：** 完整操作录像、19 个状态截图及主业务/边界/动效报告完成后，仅又调整了页脚状态栏的 CSS 位置和最大宽度，避免与 Cesium 署名重叠，未改业务逻辑。最终三尺寸页面以 `final-layout-*.png` 为准，最终主场景以 `v4-*.png` 和重新录制的 `04-real-project-viewer.mp4` 为准；三尺寸实际署名、刷新恢复、图层生命周期及两档 4K 性能均在该页脚微调后复验。早先业务录像用于证明功能操作，不冒称包含最后的页脚位置。

| 证据 | 文件 |
| --- | --- |
| 展示模式完整总览 | `v4-01-showcase-overview.png` |
| 同一镜头实景模式 | `v4-02-reality-same-camera.png` |
| 隐藏界面后的展示/实景 | `v4-03-showcase-scene-only.png`、`v4-04-reality-scene-only.png` |
| 旋转侧壁 | `v4-05-rotated-sidewall.png` |
| 人工范围上方展示、实景及旋转 | `boundary-01-overhead-showcase.png`、`boundary-02-overhead-reality.png`、`boundary-03-overhead-rotated.png` |
| 最终实际署名与页脚避让 | `final-layout-1920x1080.png`、`final-layout-2048x1017.png`、`final-layout-1366x768.png` |
| 已保存对象刷新恢复 | `refresh-restored.png` |
| 两种补充尺寸 | `v4-overview-2048x1017.png`、`v4-overview-1366x768.png` |
| 01–03：总览、空态、配置 | `01-home.png`、`02-empty.png`、`03-config.png` |
| 04–08：施工、铁路、风险、编辑、保存 | `04-draw-area.png`、`05-draw-rail.png`、`06-risk-create.png`、`07-shape-edit.png`、`08-saved.png` |
| 09–13：巡检、回放、事件列表/详情/处置 | `09-inspection.png`、`10-replay.png`、`11-risk-list.png`、`12-risk-detail.png`、`13-risk-handle.png` |
| 14–19：构件、详情、图纸、图层、设置、无效取点 | `14-components.png`、`15-component-detail.png`、`16-drawing.png`、`17-layers.png`、`18-settings.png`、`19-error.png` |
| 保存失败留稿 | `save-failed-draft-retained.png`、`event-save-failed-retained.png` |

- `01-manual-definition-workflow.mp4`，**98.744 秒**：在真实模型上创建三类对象，撤销、完成、命名保存、失败重试、编辑取消、软删除恢复及刷新恢复。
- `02-business-linkage-workflow.mp4`，**37.757 秒**：真实 4K 历史视频与共享时间轴、独立人工验收事件的定位/高亮/处置、构件资料与真实 CAD 图纸、图层与模式。
- `04-real-project-viewer.mp4`，**28.746 秒**：固定相机展示/实景、隐藏界面、真实外缘与旋转侧壁，共捕获 296 帧；编码为 24 FPS。
- `05-world-effects.mp4`，**27.047 秒**：实际世界坐标动效、绕项目旋转约 30°并缩近、真实暂停按钮、减少动态设置，暂停和减少动态各至少 3 秒稳定。镜头操作采用原 Viewer 的 Camera API，并非声称人工拖拽；原始画面像素与材质 uniform 均独立核验。

## 尚缺数据与独立问题

- 正式操作者身份、角色与业务权限接口尚未提供。空间数据支持 `createdBy`/`updatedBy`，只有真实 `actorId` 到位才填写；当前不能声称已完成实名操作审计，也不伪造用户身份。
- 实时视频源、设备在线遥测、正式巡检任务及监测告警接口未提供。已有录像和 3,467 个真实航迹点被保留使用；没有真实来源的页面保持空态。人工风险点与事件分别管理，待评估风险不表现为已确认告警。
- `Production_2` 约 1.106 GB、14,401 个 b3dm、3,791 个 JSON，没有独立构件 feature/BIM 语义。当前 CAD 的 19 组墩号和 146 个原文锚点不等于经测量确认的墩中心；仍需正式构件唯一编号、BIM 映射及构件专属图纸/照片索引。
- 正式施工/铁路范围必须由用户在真实模型表面手绘。显示外缘、CAD、包围盒和示例坐标未写为正式范围；既有 V3 临时记录保留，未按“示例”名称删除来源不明数据。
- CAD 使用原高斯投影参数，轨迹采用原经纬度，人工点保留模型双精度 ECEF。模型、CAD 和视频高程基准及控制点精度仍须独立工程核验。
- **模型纹理清晰度与无人机视频 AR 配准精度未因本轮主题改造而宣称解决。** 原模型尺寸、工程标高和配准参数未修改，显示验收不替代 LOD/纹理质量及配准残差测量。
- 性能建议值本次未达；Ion 有效凭据网络服务未测试。以上均不以合成场景或虚构数据补齐。

CPU 复验在 Node 24.21.0 下执行；`tools/test-module-loader.mjs` 仅给测试运行器解析既有 Vite 无扩展名 TS/JSON 引入，不修改生产模块。准确文件列表见 `output/platform-v4/test-files.txt`：

```powershell
$testFiles = Get-Content -LiteralPath output/platform-v4/test-files.txt
& 'F:\Node.js\node.exe' --experimental-strip-types --experimental-transform-types --import ./tools/test-module-loader.mjs --test $testFiles
& 'F:\Node.js\node.exe' tools/verify-platform-v4-hotpath.mjs
```

空间/事件数据格式与保留策略沿用 `docs/safety-spatial-v3-data.md`；本轮变化是显示接入与实际交互验证，原始持久化坐标及来源约束继续有效。
