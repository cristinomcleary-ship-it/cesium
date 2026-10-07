# 统一视觉实施包 V2：实装与验收记录

本轮在已验证的大屏基线 `08bc091` 上增量实施，开发分支为 `codex/visual-kit-v2`。沿用原有 Vite、TypeScript、Cesium 1.144.0 / engine 26.2.0、ECharts 6.1.0，使用同一个 Viewer、原资料库和原视频解码器。原 CAD POINT 隐藏、线条显示修复及视频 AR 算法保留。

## 附件核验

已解压并完整阅读 `00-CODEX-START.md`，同时阅读视觉验收、Cesium 实施、资源说明和参数文件；实际查看概念图、布局图、动效规格、三种状态参考图和 GIF 多帧。实际打开 `motion/interactive-reference.html`，操作播放/暂停、告警/构件、效果开关及主题切换，并播放 20 秒的 MP4。

- ZIP：`Cesium_Visual_Implementation_Kit_v2 .zip`
- SHA-256：`8a3a3a9cdb7946071bdd018a90afa73119a1c3992dacfca766792a2f057eeed6`
- 解压：`tmp/visual-kit-v2/Cesium_Visual_Implementation_Kit_v2/`
- 参考播放证据：`output/visual-kit-v2/reference-inspection.json` 及 `reference-*.png`
- 参数唯一来源：`src/safetyDesignTokens.json`，由附件原样复制。界面与 Cesium 特效均引用此文件。

附件图片、HTML 和视频只用于对照，不作为本项目实现或性能证据。

## 启动与使用

```powershell
cd F:\codex\cesium
pnpm install --store-dir .pnpm-store
pnpm dev --host 127.0.0.1
```

打开 `http://127.0.0.1:5173/?screen=safety`，或双击仓库的 `启动安全巡检大屏.cmd`。原工作台仍可从右上角进入；原资料库、模型、CAD 图层和视频 AR 设置继续使用原入口。

标绘流程：点击“区域与风险标绘”→选择施工区域、铁路范围或风险点→在真实场景单击取点→右键或“完成取点”→填写名称、关联信息和风险描述→核对并勾选确认→保存。支持撤点、取消、编辑、重新绘制、显隐和删除。进入取点会切到现场巡检模式，防止展示底座被当作工程表面。铁路中心线宽度表示两侧合计总宽度。保存成功后可刷新页面恢复。

风险可关联用户绘制的施工区域和铁路范围、真实 CAD 点、项目资料。新风险区分现场人工登记与当前原片回放复核；后者从同一次原片时刻计算观察时间。没有可核对时标的关联资料不会自动跳到历史视频某一帧。

## 主要实现

- `safetyScenePresentation.ts`：真实倾斜摄影纹理深蓝重映射、shader 片元范围裁剪、独立展示底面/侧壁/上下沿（顶部为真实模型，不用实体顶板遮盖）、沿工程走廊计算相机；不改变工程模型矩阵、尺寸或标高。切换巡检、地球或退出时恢复原材质与地球显示。原有裁剪不改动；范围裁剪不等于瓦片加载裁剪。已有其它 shader/style 的模型跳过汇报调色。
- `safetySceneEffects.ts`：总览最多 8 个标签、聚焦最多 5 个，屏幕避碰与面板避让；CAD 工程文字默认隐藏，可只显示当前对象。公共时钟管理波纹、扫描、流线和底座光弧，装饰暂停与实录航迹分开。
- `safetyDashboard.ts/css`：居中标题、左右各三卡、统一字号和主题、三种视口适配；原视频 DOM 节点持续复用。
- `safetySpatialEditor.ts`：真实场景拾取、草稿与业务对象渲染、确认和保存恢复；逐点保存模型/地形/椭球来源，高程基准仍标未知。
- `safetySpatialData.ts` 与 `server/safetySpatialStore.ts`：独立空间对象适配与原子存储、版本冲突及幂等写入。数据契约见 [safety-spatial-data.md](safety-spatial-data.md)。

API 同时检查本机安装版本的类型与源码，并核对 [Cesium CustomShader 官方文档](https://cesium.com/learn/cesiumjs/ref-doc/CustomShader.html)、[ClippingPolygonCollection 官方文档](https://cesium.com/learn/cesiumjs/ref-doc/ClippingPolygonCollection.html)、[ECharts 容器与销毁说明](https://echarts.apache.org/handbook/en/concepts/chart-size/)。最终实现使用 shader 片元裁剪，没有新增 ClippingPolygonCollection。材质、事件、图表和自有几何均有恢复或释放路径。关闭大屏隐藏并复用自有对象，dispose 时释放；不恢复进入前的相机姿态。巡检模式仍遵循大屏 CAD 标注策略，退出才恢复原标签显隐。

## 数据与工程边界

当前实际模型是 `Production_2.json` 的倾斜摄影 3D Tiles，约 1.106 GB、14,401 个 b3dm。逐文件检查的特征表 `BATCH_LENGTH` 全部为 0，没有可用的构件属性表；不能把图中概念桥梁当作本项目已有 BIM。真实 CAD 有 146 个文字锚点、19 个推定墩组、4 个推定区段；盖梁、墩柱、承台只有逻辑节点，未绑定 BIM 的入口禁用并显示原因。实际航迹保留 3,467 个有效原始坐标。

用户绘制对象标为“用户标绘”；既有演示事件、任务仍标“演示数据”且可从筛选中排除。人工确认只覆盖输入的几何与描述，不代表已批准施工红线、正式铁路限界或已核实的事故结论。正式铁路边界、BIM 构件 ID、现场告警/任务/整改接口、对象照片和专属视频尚需接入。

模型精度、CAD/无人机高程基准以及视频配准精度仍需控制点独立验证。本次视觉变化不作为上述精度问题已解决的证据。

## 验收产物与复测

完整记录由 `tools/verify-visual-kit-v2.cjs` 生成到 `output/visual-kit-v2/`，报告包含实际运行环境、交互检查、原工程元数据前后哈希、实际渲染帧率和运行异常。原图、参考演示与本项目实机产物分名保存。

补测脚本 `node tools/verify-visual-kit-v2-edges.cjs` 在主脚本结束后的同一隔离服务运行；验证时间过滤、真实 4K 原片播放、已提交但响应丢失恢复、显隐及两步删除，5 项通过且无页面/控制台错误。额外测试对象最终删除，原三个验收对象逐字段不变。

空间绘制验收必须每次使用新的空隔离数据目录，继续只读加载原工程资料：

```powershell
$env:CESIUM_SAFETY_DATA_DIR = Join-Path 'F:/codex/cesium/tmp' ('visual-v2-acceptance-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
pnpm dev --host 127.0.0.1 --port 5195 --strictPort
# 另开终端；PLAYWRIGHT_MODULE 指向本机 Playwright 包，VISUAL_URL 可改端口
node tools/verify-visual-kit-v2.cjs
```

脚本拦截原资料库写请求，保存测试对象仅写隔离目录；验收示例不写进用户原工程。录像为浏览器实际操作帧，编码 24 fps 与场景性能无关；性能另用 Cesium `scene.postRender` 在稳定场景测量至少 30 秒。

常规检查：`pnpm build`；`node --experimental-transform-types --test src/*.test.ts server/*.test.ts tools/*.test.cjs`。浏览器验证需要本机真实工程文件、Edge/Chromium、Playwright 和 FFmpeg；场景渲染使用目标设备 GPU，视频解码加速路径未单独核验。运行结果详见同目录验收 JSON 与日志，不用附件的 `validation.json` 替代实机结论。

## 本机实际验收结果（2026-10-07）

| 项目 | 实测结果与范围 |
| --- | --- |
| P0 静态主景 | 同一真实区段、暂停装饰、居中标题、深蓝模型、有限底座与侧壁、左右各三卡；总览初始 6 个标签（上限 8），近景上限 5 |
| P1 动态 | 统一参数与时钟；波纹、雷达、设备示意流线和底座流弧；装饰暂停/恢复独立于回放 |
| P2 联动 | 区段→墩组→真实 CAD 锚点；人工风险→定位/高亮/详情/关联图纸；三类标绘保存后刷新逐字段恢复 |
| P3 界面 | 1920×1080、2048×958 实机截图；1366 折叠面板验证见 UI 报告 |
| 首次载入 | 首批业务数据 7.521 秒，之后模型稳定等待 17.232 秒；为本机本轮记录，非网络首访 SLA |
| 场景性能 | Edge 149、RTX 4080、1920×1080、DPR 1；30.523 秒 / 1,008 个 postRender，平均 33.02 FPS，p95 帧耗时 43 ms；该段视频暂停 |
| 原片播放性能 | 真实 3840×2160 原片从 1.05 秒持续播放至 32.04 秒；30.526 秒采样平均 33.05 FPS；视频累计 964 帧、0 丢帧。未据此推断硬件解码路径 |
| 自动化与构建 | 全量 143 项单元测试通过；TypeScript 检查及 Vite 生产构建通过（保留原有大包体积提示） |
| 稳定性 | 主 E2E 13 项通过，0 页面错误、0 控制台错误；10 次模式切换实体/底座/图表/时钟数量稳定，退出再进入保持单 Viewer、单时钟 |
| 资料保护 | 9 个原工程元数据文件前后 SHA-256 相同；测试标绘存于隔离目录 |
| 原功能回归 | CAD 显示 30 项通过（DPR 1/2、缩放、遮挡、POINT 隐藏及圆/编号保留）；视频 AR 19 项通过（投影、解码、校准隔离、保存恢复） |

载入切换中取消的瓦片/旧 blob 请求记录为 `ERR_ABORTED`，未观察到持续运行错误。上述资源计数不代替长期内存/显存压力测试。

实际交付文件（均在本机应用运行中生成）：

- [1920×1080 总览](../output/visual-kit-v2/after-overview-1920.png)、[2048×958 总览](../output/visual-kit-v2/after-overview-2048.png)、[现场巡检](../output/visual-kit-v2/after-inspection-1920.png)、[恢复后的风险联动](../output/visual-kit-v2/restored-risk-linkage.png)。
- 同相机对照：[改造前 1920](../output/visual-kit-v2/before-1920.png) / [改造后 1920](../output/visual-kit-v2/after-same-camera-1920.png)，[改造前 2048](../output/visual-kit-v2/before-2048.png) / [改造后 2048](../output/visual-kit-v2/after-same-camera-2048.png)。
- [标绘与保存恢复录像，41.50 秒](../output/visual-kit-v2/spatial-workflow.mp4)：施工区多边形→撤点→铁路中心线与总宽度→人工风险与图纸关联→刷新→再次选中风险。
- [动态与业务联动录像，37.21 秒](../output/visual-kit-v2/motion-and-linkage.mp4)：总览→区段→墩组→巡检/展示切换→人工风险定位→装饰暂停/恢复。
- [主验收 JSON](../output/visual-kit-v2/acceptance-report.json)、[边界与原片播放补测](../output/visual-kit-v2/edge-acceptance-report.json)、[布局验证](../output/safety-dashboard/ui-v2-real-report.json)、[单元测试日志](../output/visual-kit-v2/unit-tests.log)、[构建日志](../output/visual-kit-v2/build.log)。

录像为实际浏览器操作，带步骤字幕与鼠标位置提示，已经抽取多时刻画面逐段核看；不是附件示意动画。24 FPS 为编码参数。

尚未实现或尚待验证：设备光柱未启用，云雾转场未实现；当前无具备唯一构件 ID 的 BIM mesh，不能验收盖梁/墩柱实体高亮。舞台包络、侧壁厚度及深度估计标签高度仅作展示，不能作施工测量。热力表达筛选事件条数的相对空间密度，不是风险概率。正式铁路红线与高程控制点仍需用户工程资料。

## 回退

保留基线提交 `08bc091`。需要整体回到改造前版本时，在保存当前未提交工作后使用该提交建立独立分支/工作区。新对象默认存于 `project-data/safety-spatial.json`；回退程序不删除该文件或任何原工程资料。若恢复空间数据，请按数据契约文档备份并恢复整个快照文件，避免仅恢复对象而遗漏版本与幂等回执。
