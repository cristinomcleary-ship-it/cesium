# 第一阶段：真实入口与工程场景功能清单

审计基准：`4a5d7c7cdecc31846201d0cf2e0ba7b8d9fc3acc`。本文件与 03 专业模块、04 管理与数据报告合起来构成完整功能清单；不能只看顶部标签判断平台能力。

## 1. 入口清单与六中心映射

| ID | 旧入口 / URL / 控件 | 实际实现与证据 | 目标中心 / 二级位置 | 审计结论 |
|---|---|---|---|---|
| N01 | `/`、`index.html` | `src/main.ts:101` shell；`main.ts:359` Viewer | 公共宿主；默认中心待用户选定 | 已实现并有测试；`tests/full-app-five-scope-smoke.mjs` 是脚本证据，本次未运行 |
| N02 | `data-tab=overview` 平台总览 | `main.ts:1559`、`digitalTwinDataCenter.ts:318`、`digitalTwinOverview.ts` | 项目管理 / 项目概况；工程数据统计可引用 | 已实现并有测试；浏览器目录与 SQLite 项目驾驶舱不是一套数据 |
| N03 | `data-tab=sandtable` 电子沙盘 | `main.ts:1421`、`electronicSandTable.ts:232` | 工程场景 / 电子沙盘 | 已实现并有测试；视点删除/存储失败保护及表现子模块有测试，完整巡游回归待补 |
| N04 | `data-tab=cad`（初始 active） | `main.ts:186`、`:2730` | 工程场景 / CAD 图纸 | 已实现并有测试；当前主入口是 DWG / .cadimport |
| N05 | `data-tab=models` | `main.ts:226`、`:2519`、`modelEditor.ts` | 工程场景 / 工程模型 | 已实现并有测试；转换器可用性依赖本机，格式不可一概承诺 |
| N06 | `data-tab=temporary-works` | `main.ts:1456`、`:2694` | 施工管理 / 临建设施 | 已实现并有测试；复用 TemporaryWorksPanel |
| N07 | `data-tab=machinery`；`openWorkbenchMachinery` | `main.ts:2650`、`:3431` → ManagementWorkspace.openWorkbenchMachinery | 施工管理 / 施工机械 | 已实现并有测试；不是第二套机械台账 |
| N08 | `data-tab=rail-safety`；`reopenRailSafety` | `main.ts:2657`、`:3432` → openWorkbenchRailSafety | 安全管控 / 营业线安全 | 已实现并有测试；复用 RailSafetyPanel |
| N09 | `data-tab=tiles` | `main.ts:265`、`:3003`、`:3078`、`:3091` | 工程场景 / 倾斜摄影 | 已实现并有测试；质量状态测试不等于所有外部数据验收 |
| N10 | `data-tab=gis` | `main.ts:292`、`:3114` | 工程场景 / GIS 数据 | 已实现但缺少测试；有数据加载与保存链，缺格式逐项测试 |
| N11 | `data-tab=videoar` | `main.ts:301`、`:741`、`:2685` → VideoModelOverlay | 智能巡检 / CC 视频融合 | 已实现并有测试；原 VideoArFusion 面板被改名 legacyvideoar 隐藏 |
| N12 | 隐藏 `data-panel=legacyvideoar` | `main.ts:301`、`:705`、`:3182` | 智能巡检 / 兼容回放与投影 | 历史兼容；实例仍被 SafetyWorkspace 使用，不可按隐藏 DOM 删除 |
| N13 | `data-tab=markup`；`openMarkupWorkspace` | `main.ts:1224`、`markupTools.ts:664`、`main.ts:3438` | 工程场景 / 空间标绘 | 已实现并有测试 |
| N14 | `data-tab=monitoring` | `main.ts:1221`、`foundationPitMonitoring.ts` | 智能监测 / 基坑管理 | 已实现并有测试；端到端监测服务联动另列待实现 |
| N15 | `data-tab=report` | `main.ts:1269`、`threeDReport.ts:357` | 工程场景 / 三维汇报 | 已实现并有测试；删除持久化/媒体释放有测试，导出为 .3dreport.json |
| N16 | `openSafetyWorkspace` 现场工作台 | `main.ts:3422`；ensureManagementWorkspace `:3165` | 项目管理默认入口，其他中心提供专业路由 | 已实现并有测试；默认打开 ManagementWorkspace |
| N17 | `?screen=management` | `main.ts:3464` | 项目管理 / 兼容 URL | 历史兼容；无独立 HTML / Viewer |
| N18 | `?screen=safety` | 同上调用 openSafetyWorkspace | 安全管控 / 兼容 URL，当前实际仍进管理宿主 | 历史兼容；不能仅按 query 名认定安全中心首页 |
| N19 | 上述 screen 配 `&interface=legacy`，或 `?interface=legacy` 后点现场入口 | `main.ts:3427` → SafetyWorkspace.open | 保留旧安全现场工作台 | 历史兼容；仅 interface 参数不会自动打开工作台 |
| N20 | 管理工作台六业务模块 | `management/features.ts`、`managementStudio.ts`、`managementWorkspace.ts` | 按具体功能分配项目/安全/监测/巡检/施工 | 已实现并有测试；原六业务模块不等于目标六中心，详见04 |
| N21 | 管理“业务 / 三维现场”模式与现场快捷按钮 | `managementWorkspace.ts:738`、`:820` | 公共场景宿主 + 当前中心业务面板 | 已实现并有测试；不能替换成第二 Viewer |
| N22 | `data-dock=display/editor` | `main.ts:126`、`:3290`、`:3441` | 公共场景目录 / 当前业务面板 | 已实现并有测试；已有同一列切换及目录 mount 复用 |
| N23 | 图层列表可见/定位/移除、模型名字点击 | `main.ts:1036` | 工程场景与公共目录的快捷操作 | 已实现并有测试；移除已保存图层会调用资料库删除 |
| N24 | 本机资料库、clearAll、CC方案列表 | `main.ts:136`、`:863`、`:3136`；`sceneLibrary.ts` | 公共资源入口 + 巡检方案入口 | 已实现并有测试；必须分开资源删除与实例卸载 |
| N25 | 图层目录/场景选中后的编辑、机械双击 | `main.ts:3300`、`managementWorkspace.ts:460` | 公共场景目录 → 对象权威中心 | 已实现并有测试；现已通过回调调用原编辑器 |
| N26 | 地下工程浮层 `openSubsurfacePanel`；地下查看/碰撞预警/隐蔽档案 | `subsurfaceTools.ts:26`、`:481` | 工程场景 / 地下工具；碰撞分析属安全，档案属项目资料 | 部分实现；工具实现完整度和业务闭环不同，见E15-E17 |
| N27 | 底图选择、自定义/本地底图弹层、homeView、坐标状态 | `main.ts:400`、`:911`、`:3140`、`:3150` | 公共场景工具 / 工程场景 | 已实现并有测试（坐标与性能子项） |
| N28 | 管理图层配置弹窗的两点空间测量 | `managementWorkspace.ts:860`、`:865` | 工程场景 / 空间测量（公共快捷工具） | 已实现并有测试；verify-management-spatial-tools覆盖两点测量及Esc释放，仅模型表面两点直线距离 |
| N29 | `/ar-v2.html`；启动 AR V2.cmd | `main.ts:122`、`ar-v2.html`、`ar_v2/web/viewer.ts` | 智能巡检 / 定位与融合高级工具 | 已实现并有测试；独立 Three.js 页面，保留 URL |
| N30 | AR内部参考页面 `/ar_v2/reference.html`（临时Vite 5198） | `tools/ar-v2-render.mjs:23,31`、`ar_v2/web/reference.ts` | 智能巡检 / 定位参考维护 | 已实现并有测试；参考渲染内部入口，Python计算服务不提供/reference路由，详见03/05 |
| N31 | 根启动/停止/更新、开发环境脚本，tools 调试/验收 HTML | `repository-file-inventory.tsv`、05报告 | 运维兼容与测试入口，非业务中心 | 历史兼容；不删除、不运行。测试夹具不计为正式入口 |
| N32 | 开发态 `window.__managementWorkspace/__safetyWorkspace` | `main.ts:3215`、`:3255`，由 import.meta.env.DEV 控制 | 开发诊断 | 历史兼容；非用户可见业务导航 |

`entry-control-references.tsv` 补充所有扫描到的 HTML 控件、路由/query 读取及动态模板位置，包括弹窗、隐藏按钮、数据行委托操作。它是词法索引，不意味着每行对应一个独立功能，也不保证正则能展开所有运行期控件。

## 2. 工程场景与横向工具的细项状态

权限缩写：A=管理前置中间件对旧工程路径检查 `safety:project`，模型/影像/瓦片读取 `models`、写入 `admin`；L=资料库按文件种类检查 `files/models/media`，写入另有管理员限制，详见04；B=浏览器本地功能，模块自身没有完整的服务端鉴权与按用户业务隔离。B不能等同于安全的全角色编辑授权。

| ID | 真实功能与源文件证据 | 目标中心/菜单 | 对象、存储、依赖 | 权限与测试依据 | 状态与限制 |
|---|---|---|---|---|---|
| E01 | 本地 CC 目录扫描、组合 tileset；`main.ts:2970`，`vite.config.ts:236,343` | 工程场景/倾斜摄影 | 目录挂载 Map + LibraryRecord；外部原目录不复制 | A/L；`modelQualityState.test.ts`仅质量子项、目录链需浏览器验证 | 已实现并有测试；OSGB/3MX 不能由此直接变成3D Tiles |
| E02 | 网络 tileset / ion、定位、偏移、高程、SSE/质量；`main.ts:2905,3003` | 工程场景/倾斜摄影 | Cesium3DTileset + 资料库 settings；ion依赖外部令牌 | A/L；质量/性能测试 | 已实现并有测试；外部资源可用性待实测 |
| E03 | 街道/卫星/空白底图；XYZ/TMS/ArcGIS配置；`main.ts:400,587,911` | 工程场景/地形影像 | ImageryLayer、本机偏好 `cesium-custom-basemap-v1`、view.json、.basemap-cache | A用于本地影像；远程源自身授权；无完整底图专测 | 已实现但缺少测试 |
| E04 | 本地GeoTIFF/图片+范围；LYR引用解析；`localImagery.ts:205`，`main.ts:955` | 工程场景/地形影像 | GeoTIFF / canvas / ObjectURL；.local-imagery-cache；LYR依赖ArcPy | A；缺格式全链测试；LYRX在main拒绝 | 部分实现；本地文件及影像重启恢复能力需另验 |
| E05 | 高程地形数据源管理 | 工程场景/地形影像 | `main.ts:372` terrainProvider未指定；沙盘可识别外部已提供terrain | 无自主数据源注册/切换实现证据 | 未实现；“地形等高线效果/取高”不能当成地形服务管理 |
| E06 | DWG解析到.cadimport、Worker取消、下载、图层/块/文字；`main.ts:2730`，`cadImport.ts`、`cadImportWorkerClient.ts` | 工程场景/CAD | DWG/.cadimport资源；Worker；CadLoadRegistry；资料库 | L；cadImport/WorkerClient/LoadRegistry等测试 | 已实现并有测试 |
| E07 | CAD坐标local/EPSG/高斯、保持Z/贴地/贴模型、primitive批次；`main.ts:187,2703`，`dxfLoader.ts`、`cadPrimitiveLoader.ts` | 工程场景/CAD | 坐标参数、导入几何、primitive或DataSource | L；dxfLoader/cadSpatialBatcher/cadGeometryScheduler等测试 | 已实现并有测试；文件名dxfLoader不证明主入口接受DXF |
| E08 | 独立DXF文件作为顶部CAD主入口 | 工程场景/CAD | 当前accept仅.dwg,.cadimport（`main.ts:188`）；其他专业模块可用DXF | main.ts:2736显式拒绝DXF；临建temporaryWorksCad.ts:200支持DXF并有测试 | 未实现；仅指顶部入口，临建专业DXF导入已实现并有测试 |
| E09 | GLB / SKP / DWG / RVT上传转换；`main.ts:228,2519`，`server/modelMiddleware.ts` | 工程场景/工程模型 | 原文件/转换GLB、.model-cache；SketchUp/ODA/Navisworks等外部链 | A/L；model-middleware-headless/sketchup-headless等测试 | 部分实现；格式探测与失败反馈存在，本机SDK/转换器可用性待确认；当前部署包装禁用导入 |
| E10 | 点选/经纬度/高斯放置、拖动/升降/旋转、重设/重新点选；`main.ts:2406,2451`，`modelEditor.ts`、`modelPlacement.ts` | 工程场景/工程模型 | 模型矩阵、sourceModelMatrix、资源ID和运行对象 | A/L；model-placement-regression、verify-model-placement | 已实现并有测试；当前资源/实例身份尚未分成独立权威实体 |
| E11 | GeoJSON/TopoJSON/CZML/KML/KMZ加载及保存；`main.ts:3114` | 工程场景/GIS | JSON交给GeoJsonDataSource，KML/KMZ/CZML专用分支；原件进资料库 | L；缺5种格式独立回归 | 已实现但缺少测试；TopoJSON通过Cesium加载器分支，未单独验收 |
| E12 | 指针经纬高程、坐标搜索、回到初始视角；`main.ts:363,3140,3150`，`cursorCoordinates.ts` | 公共场景工具 | 相机/地球拾取，仅运行态 | B；cursorCoordinates与cameraNavigationPerformance测试 | 已实现并有测试；取高来源与工程高程基准仍需说明 |
| E13 | 模型两点距离；`managementWorkspace.ts:865` | 公共场景工具/测量 | 两个模型表面点、临时Entity，Cartesian3.distance | models；tools/verify-management-spatial-tools.cjs:41,46覆盖拾取/距离/Esc | 已实现并有测试；非通用面积/体积/道路里程测量 |
| E14 | 9类标绘、样式、流动线/呼吸/箭头、立面贴图、重绘、撤销重做、GeoJSON导入导出；`markupTools.ts:28,664,1254,1656` | 工程场景/空间标绘 | localStorage `cesium-global-markups-v1`、recovery备份、IndexedDB `cesium-markup-textures-v1` | B；markupDisplay、scene目录与删除回归只覆盖部分路径 | 已实现并有测试；缺跨项目业务隔离 |
| E15 | 地面透明/地下相机/剖切/开挖裁剪；`subsurfaceTools.ts:596,692,816` | 工程场景/地下工具 | 共享Viewer globe、ClippingPlane/Polygon、导入模型 | B；subsurfacePicking、destroyed-clipping-recovery、section-clipping-scheduling | 已实现并有测试；裁剪资源释放必须保留 |
| E16 | 开挖范围与CAD/GIS管线碰撞筛查；`subsurfaceTools.ts:872,896` | 安全管控/地下施工风险；场景工具快捷打开 | 运行态几何；智能管线按名称关键词识别，未知高程可平面预警 | B；几何拾取相关测试，缺独立闭环测试 | 部分实现；没有安全风险事件权威库闭环，不能等同现场安全判定 |
| E17 | 隐蔽工程位置、前后照片、备注、查改删、JSON导出；`subsurfaceTools.ts:139,944,1024,1069` | 项目管理/资料协同；工程场景位置入口 | IndexedDB `cesium-digital-twin/hidden-works`；照片内嵌记录 | B；tests/local-data-deletion.test.mjs:59覆盖IDB提交/late-abort及失败保留 | 已实现并有测试；缺角色/项目隔离，且不是management-files文件/版本记录 |
| E18 | 视角保存、定位、删除、巡游开始/暂停/继续/停止、图层控制；`electronicSandTable.ts:247,362,393,752` | 工程场景/电子沙盘 | localStorage `cesium-electronic-sand-table-viewpoints-v1`；共享相机 | B；tests/local-data-deletion.test.mjs:139覆盖视点删除原子性，表现另有测试 | 已实现并有测试；创建/编辑/完整巡游回归待补 |
| E19 | 沙盘项目范围、地形等高线/材质、雾等表现、状态概览；`electronicSandTablePresentation.ts:446,806` | 工程场景/电子沙盘 | 当前terrain/scene材质及可恢复状态 | B；electronicSandTablePresentation.test.ts | 已实现并有测试；椭球基面停用等高线，不生成真实高程数据 |
| E20 | 沙盘围栏/硬化/车辆路径/临时建筑、动态车辆；`sandTableFacilities.ts:24,650,771,875` | 施工管理/施工布置；电子沙盘只作展示/快捷入口 | localStorage `cesium-electronic-sand-table-facilities-v1`；固定projectId；Entity | B；未发现直接专属测试 | 已实现但缺少测试；与TemporaryWorks是独立方案数据，不可自动合并或删除 |
| E21 | 沙盘进度任务/百分比/风险等级/处置字段/图层关联；`sandTableProjectControl.ts:245,346,626` | 项目管理/计划进度；安全风险按语义归属安全 | localStorage `cesium-sand-table-project-control-v1`；独立task/risk UUID | B；未发现直接专属测试 | 已实现但缺少测试；与SQLite tasks/issues/events重复维护，无自动同步 |
| E22 | 数字孪生项目资料、工程/标绘/监测/档案/汇报目录、统计和JSON导出；`main.ts:1559,1617,2116,2142` | 项目管理/概况，公共只读数据目录 | `cesium.digital-twin-data-center.v1`；`current-project`；仅目录投影不复制原件 | B；digitalTwinDataCenter.test.ts | 已实现并有测试；不是SQLite Project上下文 |
| E23 | 三维汇报页增删复制排序、镜头绑定、版式/转场/播放、画面编排/空间注记/热点；`threeDReport.ts:460,618,700,803,937`，`reportComposer.ts` | 工程场景/三维汇报 | localStorage `cesium-three-d-report-v2`（兼容v1）；共享Viewer | B；tests/local-data-deletion.test.mjs:99覆盖页/标注/媒体/Composer删除与延迟持久化 | 已实现并有测试；完整编排/播放仍待端到端覆盖 |
| E24 | 汇报图片/视频、.3dreport.json导入导出；`threeDReport.ts:754,772,1134` | 工程场景/三维汇报 | 图片dataURL；本地视频ObjectURL仅会话有效，导出不携带视频 | B；已有删除持久化/媒体释放测试，缺完整媒体恢复/导出测试 | 部分实现；无PPT/PDF/自包含视频打包承诺 |
| E25 | 场景目录搜索、类型/自定义分组、筛选多选/批量显隐/标签/定位/编辑；`sceneDisplayPanel.ts:51,99,143` | 公共/场景对象目录 | SceneDisplayStore仅偏好，按[projectId,actorId]；main聚合对象 | 回调交给各权威模块；sceneDisplayPanel/Store/Resources与性能回归 | 已实现并有测试；目标“六中心业务视图”和通用引用影响分析未完成 |
| E26 | 场景移除与加载取消；`main.ts:1056,1094,3338`，`sceneDisplayPanel.ts:4` | 公共/生命周期 | 未保存对象移除实例；已保存图层可删除资料；机械移除模型保留资源另有语义 | 服务端/客户端双重边界按04；delete/lifecycle系列测试 | 部分实现；不能将所有remove统一解释为卸载 |
| E27 | 模型质量状态/渲染异常捕获/裁剪恢复/轻量导航；`main.ts:648,2208,2254`，`modelQualityState.ts` | 工程场景/模型诊断（公共工具） | 质量状态、.render-errors诊断、运行态资源 | 质量/恢复/导航测试；诊断路由单列权限风险 | 已实现并有测试；不能等同缺洞自动修复任务中心 |
| E28 | 缺洞检测、质量修复任务审批与修复结果闭环 | 工程场景/场景质量 | 已有优化/诊断能力见03，未见完整目标中心 | 无完整中心/任务闭环测试 | 未实现；不能删除或重写已有modelOptimization来“重做诊断” |

## 3. 面板、事件与资源所有权

- 顶部13个标签属于原工作台；另有右Dock、独立浮层、管理全屏/三维模式、旧安全工作台、AR独立页面。统一导航不是把13个标签改名成6个。
- 当前原工作台模板和模块构造器大量直接引用固定DOM ID、`document.querySelector`、`data-tab`。`panelCategories.ts:11`通过移动原节点分组，保留监听器/表单值；V2适配器也应复用原节点，不能复制HTML再绑定第二套对象。
- main的tab切换（2649）包含异步机械/安全权限与草稿检查、临建关闭、沙盘停止巡游/动画、视频激活切换；这段语义必须被导航适配层保留。仅切CSS会遗漏它们。
- 全局事件并非统一EventBus：DOM点击/捕获、Cesium的camera/postRender/renderError、模块subscribeOverview回调、requestAnimationFrame目录刷新、Worker消息与服务端流并存。`event-references.tsv`列出744处词法引用，含注册、解除、派发及测试，不可当作744个独立业务事件。
- `onPageDispose`使用pagehide且跳过bfcache（main:390）；有专门释放坐标拾取、临建、目录等代码。面板隐藏、暂停交互、取消异步加载、页面销毁有不同语义，不能一律dispose。
- `SceneDisplayPanel.mount`（99）移动同一root；ManagementWorkspace经`onDisplayMount`切换普通Dock/三维现场宿主（main:3222，managementWorkspace:738）。这是可复用的现有接缝。
- 目录聚合当前包含临建、导入图层、待加载CAD、机械、安全几何、标绘、基坑；沙盘场布/隐蔽档案/汇报页/视频方案并未全部变成同一SceneDisplayItem。目录条目ID带`layer:/machine:/temporary-works:/markup:/pit:`等前缀，非统一持久化SceneInstance表。

Viewer所有权与依赖图见02。专业参数/传感器/基坑/AR细项见03；SQLite业务全表和权限见04。任何“已实现并有测试”仅表示本次阅读了实现和相关测试文件，不表示本次执行通过或现场验收。
