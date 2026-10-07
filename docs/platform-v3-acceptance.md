# Cesium 平台 V3 实施与验收记录

2026-10-07。基于已验证提交 `4364e073b814d4cfe84ca42dad960f3fa00cd5cc`，在分支 `codex/platform-design-v3` 增量实施。现有真实资产范围内的主交互流程已通过实机验收；正式业务数据和工程精度的缺项单列如下。

## 实施内容

- 四个工作区：项目总览、现场巡检、风险处置、构件资料。深蓝主题、精简面板、临时配置抽屉与业务图层，沿用原前端和同一个 Cesium Viewer。
- 施工区域和铁路范围手绘多边形；风险点手动单点。三阶段操作，名称唯一必填，风险等级默认待评估，可选资料放入更多信息。
- 仅允许平台注册的倾斜摄影表面作为人工定义来源。同像素对象拾取与不透明深度核验，保留逐点双精度 ECEF、模型编号、资产和变换版本；不以地形、椭球或装饰物补点。
- 顶点拖动、边中点插入、删除、撤销；未保存离开的一次放弃确认；失败留稿与重试；软删除、撤销和最近删除恢复。旧 V2 记录保留，旧 Corridor 的几何编辑需要重新绘制。
- 人工风险点与告警事件独立持久化。事件只有保存处理结果成功后才完成；无事件明确空态，无坐标事件不生成原点标记或热力点。
- 复用原视频解码器和一条时间轴。有轨迹按绝对时间驱动，无轨迹以视频秒数独立播放，不制造无人机轨迹。真实录制日期取已验证轨迹时标，时长取视频元数据。
- 构件四类别与原 CAD 资料联动。尚无 BIM 绑定的类别可查看资料，属性标为未录入。CAD 默认对准当前墩位原编号区域，可切全图、缩放和平移；不改变源图元，不添加虚构构件。
- 展示着色、有限底座与装饰独立于工程位置；绘制时关闭展示裁切，退出恢复。标签受预算约束，原 CAD 辅助标注默认隐藏，原工作台入口保留。

## 启动

在已安装依赖的本机执行：

```powershell
Set-Location 'F:\codex\cesium'
& 'F:\Node.js\node.exe' node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort
```

打开 `http://127.0.0.1:5173/?screen=safety`。也可使用 `tools/start-safety-dashboard.ps1`。新的工作目录先按 `pnpm-lock.yaml` 执行 `pnpm install --frozen-lockfile`；本轮未升级依赖。实际安装版本：Cesium 1.144.0、ECharts 6.1.0、Vite 7.3.6、TypeScript 5.9.3。

重复验收时使用新的独立数据目录，并运行关闭热更新的配置：

```powershell
$env:CESIUM_SAFETY_DATA_DIR = Join-Path (Get-Location) ('tmp/platform-v3-test-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
& 'F:\Node.js\node.exe' node_modules/vite/bin/vite.js --config tools/vite.platform-acceptance.config.mjs --host 127.0.0.1 --port 5196 --strictPort
```

另开终端，设置 `PLAYWRIGHT_MODULE` 为本机 Playwright 包路径，再依次运行：

```powershell
node tools/verify-platform-v3.cjs
node tools/verify-platform-v3-edges.cjs
node tools/verify-platform-v3-media.cjs
```

主脚本要求空验收集合；边界和媒体脚本接着读取主脚本的已保存对象。日常运行请勿沿用验收数据目录环境变量。验收脚本拦截原资料库写请求，空间定义和事件只写入独立目录。

## 实际结果

| 检查 | 结果与证据 |
| --- | --- |
| TypeScript 与生产构建 | 通过；`output/platform-v3/build.log`。保留既有大型包提示，无构建错误 |
| 全项目单元测试 | 168项全部通过；`output/platform-v3/unit-tests.log` |
| 真实应用主流程 | 19项通过；`output/platform-v3/acceptance-report.json` |
| 严格取点与编辑边界 | 9项通过；`output/platform-v3/edge-acceptance-report.json`。天空、画布外、注册失配、前景遮挡、变换失配、无效拖动、窗口失焦均验证 |
| UI 与无轨迹控制逻辑 | 隔离DOM 20项、无轨迹夹具18项通过；夹具结果不等同真实无轨迹视频解码验收 |
| 原 CAD 回归 | 30项通过，DPR 1/2、四档缩放、遮挡、点隐藏与图层显隐；`output/cad-display-regression/` |
| 原视频 AR 回归 | 19项通过；`output/platform-v3/video-ar-regression-report.json`；不作为真实工程配准精度证明 |
| 分辨率 | 1920×1080、2048×1010、1366×768 实际截图与布局检查通过 |
| 生命周期 | 连续10轮四页面和配置切换后，1 Viewer、1业务时钟、1编辑拾取器、1编辑postRender监听、2图表、实体/底座数稳定；退出恢复原材质和播放器归属 |
| 原资料保护 | 原 `view.json` 与8个 `record.json` 共9份元数据 SHA-256 前后相同；原资料写请求在验收中拦截。未声称逐字节重算全部GB级模型和视频 |
| 页面错误 | 最终主流程和边界流程 pageerror 为0。主流程仅有2次刻意注入的503，用于验证保存失败留稿 |

主流程首批业务资料就绪约 **8.9 秒**。在 Windows、Edge 149、RTX 4080、1920×1080、DPR 1 下，单路3840×2160视频播放，按 Cesium `scene.postRender` 采样 **30.5 秒**，平均 **60.1 FPS**、P95帧间隔 **23.1 ms**，视频掉帧 **0**。测试未录屏时采样，录像24 FPS是编码参数，不是场景帧率。最终媒体补测 30.5 秒、35.6 FPS，掉帧 0；见 `media-acceptance-report.json`。

资源计数稳定只代表已测对象/监听未重复积累；没有使用GPU内存分析器证明显存绝不增长。首次视频解码、全瓦片加载和相机飞行分别完成了实际操作检查，未把业务资料就绪时间当作所有资产首屏耗时。

## 截图和实际操作录像

全部应用证据位于 `output/platform-v3/`，不是设计原型截图。人工范围和事件名称均标“验收示例”，数据仅在测试目录。

| 状态 | 文件 |
| --- | --- |
| 总览、空态、配置 | `01-home.png`、`02-empty.png`、`03-config.png` |
| 施工区域、铁路、风险点、编辑、保存 | `04-draw-area.png` 至 `08-saved.png` |
| 实时来源空态、真实历史视频 | `09-inspection.png`、`10-replay.png` |
| 事件列表、详情、处理 | `11-risk-list.png` 至 `13-risk-handle.png` |
| 构件、详情、真实CAD图纸 | `14-components.png` 至 `16-drawing.png` |
| 图层、显示偏好、无效取点 | `17-tools.png`、`18-settings.png`、`19-error.png` |
| 两种外观同相机与纯中央场景 | `scene-presentation.png`、`scene-inspection-same-camera.png`、`scene-no-panels-paused.png` |

- `01-manual-definition-workflow.mp4`（43.8秒）：三类定义、撤点、失败重试、顶点编辑和取消、软删除撤销与最近删除、刷新恢复。
- `02-business-linkage-workflow.mp4`（29.2秒）：真实视频播放和时间轴，独立人工验收事件定位/高亮/资料/处理，构件和真实CAD图纸，图层与显示模式。
- `03-scene-and-media.mp4`：同相机实景/展示、真实视频日期和元数据时长、回放操作。

参考包已完整读取 `00-CODEX-START.md`，实际打开原型并执行20个操作、查看19个状态、播放两段视频，并抽查GIF 4个时间帧。过程记录 `reference-inspection.json`。原包 SHA-256：`8206ec4cce84ba5a14ac3a491d1b7a0c1cebf362927553731ced041978cadcc8`。

## 真实资产、数据接入与独立问题

- 当前模型为已有 `Production_2` 倾斜摄影：约1.106GB、14,401个b3dm、3,791个JSON。已核验资产可用于表面拾取，但没有独立构件feature/BIM语义。CAD提供19组推定墩号、146个原文字锚点；这些不等同经测量确认的墩中心。
- 原无人机视频与3,467个实际轨迹点已复用；实时视频流、设备在线状态、正式巡检任务和监测告警接口尚未提供，页面显示对应空态。
- 新增事件接口支持人工记录/经校验导入；本轮处置验收使用明确命名的独立人工样例。原工作台历史风险台账未自动迁移或赋予伪造坐标。
- 仍需正式铁路实测边界/限界、施工区域依据、构件唯一编号与BIM映射、构件专属图纸/照片索引、操作者身份与正式业务权限对接。现在展示的是项目CAD参考图。
- 源CAD采用现有高斯投影参数，轨迹经纬度来自原数据，人工点保存真实模型ECEF。模型、CAD和无人机高程基准及控制点精度仍待独立核验。
- **模型清晰度和无人机视频AR配准精度未作为本轮已解决事项。** 本轮未修改原工程模型尺寸、标高或配准参数；界面和播放验证不替代模型LOD/纹理质量与配准残差测量。

空间和事件数据格式、迁移及模型注册说明见 [safety-spatial-v3-data.md](safety-spatial-v3-data.md)。源代码交付包不包含原GB级摄影和无人机媒体，继续使用当前工程资料库。
