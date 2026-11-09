# 第一阶段：风险、设计差异与后续实施准入

本文件是对既有7份设计文档的审计补充与修正建议，不改写原设计，不实施第二阶段。风险基于静态代码路径和本机只读检查；“可能/待复现”不等于已发生数据损失。

## 1. 主要风险清单

P1=后续设计/实施应优先处理，涉及原件、业务隔离、权限、草稿或错误成功反馈；P2=整合及回归前需解决；P3=可记录后逐步改善。所有项本阶段仅报告。

| ID | 级别 | 发现/触发条件与影响 | 代码证据 | 建议与验证条件 |
|---|---|---|---|---|
| R01 | P1 | 场景图层“移除”在已保存对象上走资料库删除；直接换统一删除按钮会删除原件而非卸载 | main:1056,3338；SceneLibrary.delete；ProjectLibrary.remove | 统一操作前先明确hide/unload/remove-instance/archive/delete-asset，增加引用影响展示；覆盖原件仍存在/证据可读 |
| R02 | P1 | ProjectLibrary原件删除缺少与管理evidence跨库引用检查；管理员也可能删掉已引用文件 | server/projectLibrary.ts删除链；04报告对应证据；management-files另有assertEvidenceUnreferenced | 在独立数据副本中复现“引用后删原件”；不能先实施导航中的批量删除 |
| R03 | P1 | SQLite多项目不等于空间、资料、机械等全平台多项目；旧资源接口固定safety:project | managementStore:184 / libraryEvidence:14；managementWorkspace:501-526,675-693 | 逐模块声明支持的项目范围，统一projectId前保留旧默认项目；跨项目读取/撤权测试 |
| R04 | P1 | 标绘、基坑、沙盘、汇报、隐蔽档案等固定浏览器键或无projectId，切项目显示同数据的风险 | markupTools:69；foundationPitMonitoring:482-488；main:1494,1559；subsurfaceTools:116 | 第2阶段不得宣称已隔离；先加能力限制/兼容适配设计，正式数据迁移留第5阶段审批 |
| R05 | P1 | 临建close直接取消草稿/预览，setProject也清状态；机械/安全则有guard，统一切中心可能无提示丢草稿 | temporaryWorksPanel:617-624,642-678；main:2667,3192 | 面板生命周期按dirty/picking/saving拆分；验证切中心、切项目、Esc、异步保存中的取消 |
| R06 | P1 | 基坑saveState捕获localStorage失败后调用方仍提示日报/CSV成功，刷新可能丢掉内存新增记录 | foundationPitMonitoring:885-890,1343-1352,2263-2270 | 后续独立修复存储失败回执；以QuotaExceededError/禁止存储模拟验证，不能在正式浏览器制造失败 |
| R07 | P1 | 基坑目录限制有历史点删除，但专业面板删除基坑会显式确认后硬删坑与相关读数，非默认归档 | foundationPitMonitoring:446-467,1071-1080 | 统一目录不得放宽原限制；归档与原始读数保留需专门迁移合同 |
| R08 | P1 | 新导航如果复制面板DOM或重建Viewer，会形成重复监听、多个选中状态、共享裁剪/视频资源提前释放 | main:359,2649,3165；panelCategories:11；sceneDisplayPanel:99 | 保留单Viewer、单实例、原ID和回调；面板切换前后Viewer identity相同、监听器/Worker数量不增长 |
| R09 | P1 | 本机未提交启动脚本决定5289真实数据来源；直接套用5173标准启动/新目录会出现“数据消失” | 本机tools/start-cesium.ps1 → output/current-version/start.ps1；README环境记录 | 保留当前原点、数据目录、浏览器配置；本阶段未改文件/端口/服务 |
| R10 | P2 | 当前桌面运行包装仍带acceptanceOnly/candidate并禁止POST /__models/import，源码功能与磁盘部署行为不同 | 本机output/current-version/server.mjs guard；05报告 | 如后续获部署授权，单独核准包装/转换器行为；本次不解除限制 |
| R11 | P2 | 机械遥测/定位Gateway只有有界内存缓存，浏览器姿态记录也不等于长期服务端历史 | machineryTelemetryGateway / positioningGateway；machineryPoseRecorder | 标注重启/跨浏览器数据边界；长期持久化另列任务，验证过期/断连/质量不得显示正常 |
| R12 | P2 | 临建内部visible保存到plan，场景visible仅个人override；普通图层也有record.visible与override双层 | temporaryWorksPanel:729-756；main:1071,3364 | 明确effectiveVisible优先级，不允许个人偏好改变业务状态；双入口往返回归 |
| R13 | P2 | 沙盘任务/风险/场布与管理任务/安全/专业临建有独立数据源，没有统一稳定ID映射 | sandTableProjectControl、sandTableFacilities、main:1559 | 先标来源并建立关系；禁按同名合并，保留导出与旧读路径 |
| R14 | P2 | 外部资料引用证据的“查看原件”候选路径不一致：注册有library URL但无storageName，UI仍拼管理文件URL | managementStudio:358；managementStore:157,297；04报告 | 静态候选缺陷，需隔离HTTP+浏览器复现；根据证据来源选择正确原件服务 |
| R15 | P2 | 管理前置权限覆盖模型/瓦片/影像等，但diagnostics路由不在同一匹配范围 | managementStore:177-200；vite.config:458-486 | 统一服务边界盘点时单列诊断读取/写入权限；先确定本地端口访问策略，不声称现有全API同权限 |
| R16 | P2 | 同commit两锁文件锁定不同版本；pnpm启动与npm AR部署得不同依赖树 | pnpm-lock.yaml/package-lock.json：proj4 2.21.0 vs2.22.0、vite7.3.6 vs7.3.7、@types/node24.13.3 vs24.19.2 | 保留锁文件；未来单独选定工具链并验冻结安装，不能当前顺手升级 |
| R17 | P2 | package无test脚本，浏览器脚本依赖未声明Playwright/本机路径，历史通过记录不能作为本次通过 | package.json；05报告和test-inventory.tsv | 准备隔离回归运行清单；逐脚本查副作用和数据根，不能直接运行所有脚本 |
| R18 | P2 | AR V2独立服务5199与允许origin列表、原5173/5198路径，对当前5289的嵌入/接入要单独核验 | ar_v2/server.py；ar_v2/web/viewer.ts；05报告 | 保留原URL；真实浏览器验证CORS/会话/流/坐标，不直接嵌入假定可用 |
| R19 | P2 | 三维汇报导出JSON不包含本地视频字节，视频ObjectURL只会话有效；名称像“汇报导出”易产生误解 | threeDReport:772-783,1134 | 在未来UI说明导出格式/外部媒体依赖；验证重开JSON的可恢复边界 |
| R20 | P2 | 地下管线筛查已兼容primitive线特征与Entity，但仅分析可见CAD/GIS线条；关键词过滤和线段高差判定不是完整实体管线拓扑 | subsurfaceTools:872-939；cadPrimitiveLoader:473,533-535 | 保留primitive兼容路径；验证隐藏线/非线对象/关键词/高程数据的分析边界，不能承诺所有CAD实体都参与碰撞 |
| R21 | P3 | main集中处理DOM、权限适配、加载、显示、错误恢复和各模块依赖，改动影响面大 | main.ts 3,470行；dependency-edges.tsv | 小步抽适配器，保留原函数/事件合同；不要一开始重写专业算法 |
| R22 | P2 | UI层有入口隐藏或“未接入”保护分支；不能依据feature目录计数宣称每项完整实现 | managementStudio:375隐藏F19/F48；managementWorkspace:642,858默认拒绝 | 对具体叶子操作标状态；覆盖拒绝与空状态，详04 |

## 2. 对7份设计文档的逐份修正

| 原设计文档 | 应保留的结论 | 需要修正/收窄的内容 | 审计依据 |
|---|---|---|---|
| README | 单Viewer、先审计、保护数据与兼容URL | 原“ManagementStudio六业务模块”名称是概念分组，不是当前全部实际UI标签；1.2.0包版本与临建1.1.0称谓需并列 | 04功能目录、05环境说明、00总报告 |
| 01 功能总清单 | 6中心和既有专业模块适配方向 | 顶部CAD不直接接受DXF；模型顶部accept不含独立GLTF；地形数据源管理不能由影像/取高推断；基坑格构柱/放坡/分层施工动画/自动回传/外部监测投影未形成实现链；无人机全流程任务不能由视频回放代替 | 01 E05/E08/E09；03专业矩阵 |
| 02 功能归属矩阵 | 机械主参数施工权威、安全引用；任务/资料统一引用 | 当前已部分共用机械面板与resources，不能再复制；沙盘独立任务/风险/场布、隐蔽档案、旧安全JSON需补列；“默认软删”是目标不是所有存储现状 | 本报告02文件D01-D22、04删除链 |
| 03 统一架构与界面契约 | 中央Viewer借用，复用面板 | PlatformModuleDefinition/PanelContext仍为草案；SceneDisplay已有单实例跨host挂载，不能重建；全局草稿、项目隔离、撤权合同并未全部具备；AR V2是独立Three.js域 | main:359,3222,3441；03、04 |
| 04 数据对象与生命周期 | 概念模型不代表立刻建同名表 | 必须补充localStorage各业务、IndexedDB纹理/档案、OPFS视频缓存、safety JSON、Gateway内存；ResourceAsset与SceneInstance尚未独立；Library原件删与管理附件删保护不同 | 02真实对象矩阵，04完整存储图谱 |
| 05 分阶段实施任务 | 审计后等用户确认、每阶段独立提交 | 第2阶段只可承诺导航/适配，不得提前声称第5阶段多项目/身份/引用图已完成；第6阶段需先整理可安全运行的测试脚本和唯一锁文件口径 | R03-R08/R16-R17、05测试报告 |
| 06 本地部署交接清单 | 禁止覆盖正式目录、用户确认后部署 | “本机部署尚未执行”仅指V2：本机已有24f79e0磁盘部署；本次检查服务未监听，不能写已在线；本机入口实际是5289包装而非直接5173 | 00环境核验与05部署差异 |

以上作为审计勘误保留在新增文件中。原7份设计文件保持不变，避免第一阶段将尚未确认的设计裁决写成已批准要求。

## 3. 建议实施顺序及每一步准入（全部待审核）

1. **确认审计边界与功能权威**：确认六中心下哪些原功能只作快捷入口，特别是沙盘任务/风险/场布、隐蔽档案、旧安全工作台；列清楚本地数据来源和保留策略。
2. **第二阶段导航/面板适配**：先包裹原main宿主和ManagementWorkspace，建立registry与明确close/hide/canLeave合同，复用SceneDisplay.mount；不迁移原件/数据库、不扩大项目支持范围。
3. **第二阶段验收重点**：13顶部入口、query URL、legacy、独立AR链接、场景编辑快捷动作均可到达；同一Viewer不重建；草稿/拾取/异步保存可保护；撤权停止订阅；不把纯CSS显隐当取消/卸载。
4. **第三阶段目录**：先复用现有类型/分组/搜索/显隐，按真实对象能力逐项开放操作；原件删除/历史数据操作必须带影响范围，不能“全部remove”统一处理。
5. **第四阶段专业中心**：适配原几何/Worker/业务表单/权限和存储；先工程与项目，再安全/施工，再监测/巡检；保留高级工具独立URL。
6. **第五阶段数据与权限**：有迁移/回滚/备份/兼容读设计后再处理固定项目ID、浏览器业务库、跨库资源引用、遥测持久化；新关系只按稳定ID建立。
7. **第六阶段回归与候选**：先在独立目录和独立数据副本梳理冻结依赖、Node/Python/Playwright要求，再运行API/权限/文件/临建/视频/基坑/三尺寸浏览器回归；最后只产独立候选。正式部署仍需单独明确授权。

## 4. 本阶段完成与未执行边界

已完成的是全仓静态架构审计、入口/归属/数据/权限/测试/部署链盘点与可追溯报告。没有运行项目服务、安装依赖、构建、业务测试或浏览器验收；没有打开正式SQLite连接、操作浏览器业务存储或执行迁移。不能把现有测试文件和历史验收文档当成本次绿灯。

剩余待实证事项已列风险和各专业报告：在线服务健康、所有角色/所有项目运行效果、真实设备数据质量、外部SDK/数据源/AR后端可用性、候选缺陷复现、浏览器媒体恢复和响应式尺寸。本阶段不为这些事项修改业务代码或部署服务。
