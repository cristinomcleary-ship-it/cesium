# C 批实际主平台验收

本批使用用户实际主路由 `/?screen=safety`、现有 `main.ts → VideoArFusion → VideoArModelProjector` 和唯一 Cesium Viewer。实际运行发现旧主工作区仅播放原片，未启用 Fusion；现已通过“画质与配准 → 模型融合试算”显式接入同一引擎，并持续显示未通过配准验收的状态。旧 AR 入口和独立 `ar_v2` 契约保留，未以独立页面的结果冒充主平台改善。

本批结论分开记录：输入档案、画质档、同步守卫、模型加载状态和实际主路由接线已实施；实际整片性能尚未达到 24 fps 目标；工程配准精度因真实校准及独立检查点缺失而未测。不能将 C 批整体写为通过。

## 验收矩阵

| 编号 | 已实施与实际结果 | 证据 | 限制 / 结论 |
| --- | --- | --- | --- |
| C1 | 视频/PTS/轨迹/坐标/高程/K/D/安装关系/模型变换逐项绑定来源，区分核验事实、估计、缺失；主页面区分原片、航迹跟随和验证融合 | `C/input-audit/`、`C/runtime/report.json`；[输入与质量说明](platform-revision-c-inputs-quality.md) | 档案工具通过；可靠高程与独立相机标定未提供。实际跟随按钮明确禁用，没有用估计高程假充可靠条件 |
| C2 | 同一真实 4K 帧的三档 GPU 纹理实际分配 1024×576 / 1920×1080 / 3840×2160；同 PTS、K 同约定缩放、旧纹理销毁 | `C/runtime/report.json` 的 `qualityCases` 和 `04-quality-*.png` | 尺寸、身份和释放通过；RGBA 显存为估算，整机/GPU 实测显存保持 null；不代表模型配准通过 |
| C3 | 模型深度路径拆离 CPU 几何 4 fps 节流；按媒体时间提交，保持相机/图像/深度同帧及 0.35 m 首表面校验；实际暂停、seek、倍速、换源、关闭播放器通过 | `C/runtime/report.json`、两段实际录像；`C/video-frame-state.log`；`C/projection-lifecycle.json` | 整片 24 fps 性能目标未通过；实际深度就绪率低于相机/纹理配对率，详见下表 |
| C4 | SSE 12/4/1 沿用；首屏/细节/当前视角目标就绪/瓦片失败区分，首屏之后继续追踪；铁路、桥面、建筑实际书签两轮截图 | `C/runtime/02-*.png`、报告 `bookmarks`；11 项输入/状态测试 | 实际工程网格可见，目标 SSE1 就绪；源网格和源纹理缺陷没有因 UI 或加载就绪被标记为修复 |
| C5 | 原片/轨迹/完整模型树/模型矩阵锁定 SHA；五时刻精确包 PTS；独立检查点观测包和验证工具可运行 | [输入盘点与补采方法](platform-revision-c-inputs-checkpoints.md)、`C/input-audit/checkpoint-validation.json` | `NOT_EVALUATED`。缺可靠垂直基准、独立 K/D/安装关系及至少 6 个未参与拟合调参的真实检查点；所有精度/覆盖/失定位测值为 null |

最终完整主路由交互检查运行了 16 项断言，补充交互另有 13 项，全部通过，零未处理页面脚本异常。这里的断言通过只适用于报告列出的运行事实，不包含未达标帧率或尚未测量的精度。CPU 生命周期回归另外覆盖绘制/编辑、模型预览、测量/资料取点、账号撤权、项目和录像切换时关闭试算；10 组通过，不冒充实际 GPU 交互。

## 实际设备、素材和测量方法

- Windows / Microsoft Edge 149，ANGLE Direct3D11，NVIDIA GeForce RTX 4080；1920×1080、DPR1、实际 drawing buffer 1920×1080；WebGL 最大纹理边长 16384。
- 真实原片 `DJI_20260819162016_0001_V_航点1.mp4`，3840×2160，30000/1001 fps，115.682233 秒，630,987,789 字节。实际选中资料 ID `34e037f1-a0cd-4388-9904-0ff9dc0a9a9b`。
- 真实 Production_2 倾斜摄影，资产 `8bc58629-cf26-45de-986e-086479db11a0`，18,193 个文件，共 1,105,851,552 字节；本次保留原 SSE1 档和单位模型矩阵。原片与完整模型树的身份见 `C/input-audit/input-lock.json`。
- 原保存表面为 terrain、FPS12；进入主页面试算临时使用 model / FPS24，关闭或换源恢复原值。临时试算不写回录像档案。没有改高差、K/D、工程坐标或深度阈值。
- 验收 Vite 服务在 5243，使用隔离业务目录和正式资料只读守卫。实际原片与模型来自正式资料库，只读使用。正常用户启动仍为 `npm run dev -- --port 5173 --strictPort`。
- 整段测量从 0 秒播放至 ended；关闭诊断刷新和屏幕录制以避免其额外开销。最终实际活动播放 115.722 秒，测量总时长 117.044 秒。录像帧率是编码参数，不作为 Cesium 或投影帧率。

## 整段实测性能

最终完整运行（`runLabel=source-camera-bookkeeping-final`）证据：`output/platform-revision-20261009/C/runtime/report.json` 的 `fullClip.snapshot.diagnostics.performance`。

| 通道 | 活动帧数 | 平均 fps | P95 间隔 ms | 最长间隔 ms |
| --- | ---: | ---: | ---: | ---: |
| 视频 RVFC 可用帧回调 | 1919 | 16.583 | 106.2 | 293.7 |
| 同身份相机 / 纹理配对提交 | 1904 | 16.453 | 105.5 | 304.1 |
| 当前源深度就绪的投影帧 | 1121 | 9.687 | 131.8 | 7705.0 |
| Cesium 渲染 | 1922 | 16.609 | 105.7 | 299.5 |

浏览器原生媒体计数 3467 帧，droppedVideoFrames=1；RVFC 漏回调计数 1546，不能混称为视频解码丢帧。配对组装阶段等待新纹理触发 1904 次 `camera-image-mismatch` 守卫，源深度未就绪计数 785；这些是拒绝计数，不能直接推断画面已显示错误帧。深度就绪计数也不是已量测的有效投影像素数或表面覆盖率。

五个固定时刻在寻址后约 600 ms 的快照均存在源视角瓦片请求/解析未收敛，投影安全保持未就绪：10.01/30/60/90/114 秒的待请求数分别为 521/320/347/200/14，处理中数量为 30/30/30/9/20。它们的媒体、相机和当前 Cesium 深度修订匹配，且不是视锥外错误。这支持进一步检查源 LOD 收敛，但整段统计没有逐帧加载序列，不能反推最长 7.705 秒间隔的精确起止或认定唯一原因。保留首表面阈值、当前帧守卫和既有请求上限，不以放宽正确性规则使统计变好。

补充静止采样确认独立源相机没有像主相机那样维护移动量与静止计时。已在每次源瓦片遍历前调用当前 Cesium 的原生 `_updateCameraChanged`，只作用于源相机；私有 API 经过版本核对和可用性检查，缺失时保留既有保守加载判定，诊断显示不可用。6 组真实生产方法/native Camera CPU 回归通过，包括历史 B 提交复现、静止/移动每帧更新、主相机不受影响、API 缺失及原深度/请求守卫。当前实测模型 `skipLevelOfDetail=false`、`deferredUnloaded=0`，因此没有把这处遗漏称为已证明的加载延迟根因。修复后的实际运行已完整复测。本次深度就绪投影从前一轮 2.983 fps / 最长 26.565 秒间隔变为 9.687 fps / 7.705 秒；前一轮保存在 `C/runtime-before-camera-bookkeeping/`。两轮设备、素材和目标档位相同，但浏览器/系统缓存及运行状态没有完全受控，不能把全部数值变化归因于这处修复，更不能据此宣布 24 fps 已达标。

录像寻址验收记录实际 RVFC PTS，不以请求秒伪造帧身份：最终 114 秒请求对应本次已提交帧 113.980533 秒，而输入盘点的近邻包示例为 114.013900 秒。后续检查点必须绑定实际冻结图像及精确 PTS；两者不能混用。

## 最终补充交互与静止帧

最终 `C/runtime-supplement/report.json` 为 13 项通过、零页面脚本异常，`runLabel` 与实际源码 SHA 均留存。新采 40.136 秒、42 个静止样本，没有复用修复前采样；原片保持 PTS10010，源相机坐标不变，静止计时从 35.302 秒增长到 75.320 秒，每个样本的原生维护帧均与源深度帧一致。计时是 Cesium 原生运行事实，不用作遥测时间或工程位置证明。

通过页面实际导出的 `texture-economy-pts10010.png`、`texture-clear-pts10010.png`、`texture-inspection-pts10010.png` 均来自已经同帧上传的 CPU canvas，并附 SHA、尺寸和帧身份。三档 GPU 分配分别核验，但这些 PNG 本身不是 GPU 帧缓冲回读；同一建筑立面细节的目视对照显示 1920 比 1024 保留更多线条，原始尺寸保留更多源细节，不据此宣称配准准确。

绘制实际操作自动关闭融合，取消绘制后可显式重开，台账 ID/修订不变且未发出空间保存或管理命令。绘制期间诊断入口位于配置浮层背后，补充守卫验证使用程序设焦后按 Enter 打开诊断，再实际点击试算开关；开关被拒绝并恢复未选中，原因可读。它验证运行时守卫，不声称该背景按钮在绘制期间可用鼠标访问。普通绘制取消、退出后打开诊断与主播放操作使用实际 UI。

本次补充录像为 `C/runtime-supplement/01-c-real-interactions.mp4`；无关的早期失败尝试与中间编码帧不纳入交付白名单。

## 真实网格的固定书签

从实际显示网格严格取点，只保存为本次只读显示观察书签，不写业务区域、不当作测量控制点。铁路、桥面、建筑两轮使用相同相机、同 SSE1；关闭浏览器网络缓存，但初始总览已加载部分瓦片，不能称为全冷缓存。第二轮为同 Viewer 瓦片缓存条件。

| 目标 | 首次书签定位到就绪 / ms | 同 Viewer 再次定位到就绪 / ms |
| --- | ---: | ---: |
| 铁路 | 3497 | 3828 |
| 桥面 | 2612 | 2188 |
| 建筑 | 12054 | 11741 |

这里记录自动化从相机定位动作至等待条件完成的总时间；追踪器内部的最后一次视角修订计时另存报告，不与该总时间混用。六张截图均显示实际工程网格、visibleTiles>0、目标 SSE1、无瓦片失败。不能据两轮样本推断长期性能或源模型纹理精度。

## 控制台与请求说明

“零页面脚本异常”不等于没有任何控制台网络记录。完整轮保留 6 条、补充轮保留 4 条只读保护产生的 409：验收服务拒绝对正式资料的写入，预期不持久化；不能据此声称正常部署发生业务冲突。另有单条 404，最后在同主路由独立 30 秒复测中通过 `console.location` 明确定位为 `/favicon.ico`，属于页签图标缺失；没有模型或视频必要资源 404。该次真实模型 734 个可见瓦片、SSE1、当前视角就绪、瓦片失败数 0、Viewer1、pageerror0。原始 blob 媒体请求的生命周期中止也保留，不当作已确认播放故障。证据为 `C/network-probe.json`；没有为了消除日志而忽略正常权限或只读保护。

## 代码、验证与证据位置

主要接入：

- `src/main.ts`：现有模型质量追踪、主工作区与原 Fusion 实例连接。
- `src/safetyWorkspace.ts`、`src/managementWorkspace.ts`、`src/managementStudio.ts`、`src/managementSceneTypes.ts`：主路由诊断、显式试算、状态提示、权限与工作区生命周期。
- `src/management/videoDiagnostics.ts/.css`：单个可关闭诊断窗，档位、目标帧率、来源/缺项、实际上传纹理与状态导出；不新建 Viewer、播放器或常驻动画循环。
- `src/videoArTextureQuality.ts`、`src/videoArPerformance.ts`、`src/videoArInputProfile.ts`、`src/modelQualityState.ts`：画质、测量、输入档案及瓦片状态模块。
- `src/videoArFusion.ts`、`src/videoArModelProjector.ts`：媒体帧调度与实际投影守卫。原始控制点、深度阈值与独立 V2 接口保留。
- `tools/verify-platform-c-runtime.cjs`、`verify-platform-projection-lifecycle.cjs`、`verify-platform-c-supplement.cjs`、`verify-source-camera-motion.cjs`、`inspect-platform-ar-inputs.mjs`、`validate-platform-ar-checkpoints.mjs`：实际运行、状态回归和输入核查工具。

源码回归本轮 307/307 通过；视频相关 86 项 CPU 回归、9 组真实方法状态回归、独立检查点逻辑 14 项、生命周期 10 组、源相机原生运动状态 6 组分别留有日志。它们存在覆盖重叠，不能简单相加冒充独立工程验收数量。最终 TypeScript 检查 exit 0，Vite 生产构建 exit 0（18.86 秒，既有大分包提示保留）；最终源码回归再次 307/307 通过。证据为 `C/typecheck.log`、`C/build.log`、`C/final-source-tests.log` 与根 `final-validation.json`。

实际证据：

- `C/runtime/01-real-overview.png`、`02-*.png`：真实模型总览及目标细节。
- `C/runtime/03-original-video.png`、`04-quality-*.png`、`05-main-model-preview.png`、`06-frame-*.png`、`07-full-clip-diagnostics.png`：原片与试算状态。
- `C/runtime/01-c-real-interactions.mp4`、`02-c-real-interactions.mp4`：真实浏览器的书签/视频操作。只纳入最终 `report.recordings` 白名单，不纳入早期失败尝试的同目录文件。
- 统一交付浏览页为 `output/platform-revision-20261009/delivery/index.html`；每项区分真实工程、隔离业务或 CPU 夹具，清单保存 SHA。

## 尚需补齐和回退

真实原片和生产模型已有；缺的是可靠垂直基准与转换依据、原片对应的实测 K/D、姿态轴/相机安装与时延关系、冻结校准之外的独立检查点。获取及观测包步骤详见 [C5 补采说明](platform-revision-c-inputs-checkpoints.md)。实际覆盖、失定位/恢复、地理/高程误差均未测，继续保持 null。生产模型目录存在，但没有核实本项目可编辑重建源工程或源网格修复服务，不能声称完成源网格修复。

24 fps 目标仍需在保留配对和遮挡正确性的条件下继续优化并重新整片测试。此次源视角瓦片加载长间隔必须明确保留，不能仅凭原视频流畅称为投影流畅。

C 无数据库 schema 迁移。已重新核对正式 3,822 个 JSON（无新增/变更）、SQLite 只读逻辑转储（与启动一致副本一致）、18,193 个模型文件及其清单（逐 SHA/size、无新增或丢失）、原 630,987,789 字节视频与轨迹以及模型矩阵。均与基线相同，证据为 `C/data-preservation.json`；这里只对列出的正式数据作保全结论，临时脚本和输出证据是本次新增文件。最终 C 提交可用 `git revert <C批SHA>` 单独反向提交；如业务持续产生新记录，不用启动时备份覆盖正式库。B/A 的反向提交规则见 [总说明](platform-revision-20261009.md)。
