# 第一阶段审计：管理业务、数据、权限及生命周期

审计对象：本次独立 worktree 的 `origin/codex/platform-management-v2`，提交 `4a5d7c7cdecc31846201d0cf2e0ba7b8d9fc3acc`（包含稳定基线 `24f79e0c2a62613417c61f61077949aee147c97e`）。已阅读根目录交接文件及 `docs/architecture-v2` 七份设计文档。本分报告仅记录源码检查，不启动应用、不打开正式 SQLite、不触发资料库请求、不导入业务模块执行初始化，不修改业务、部署或数据文件。下述“有测试”表示存在经检查的相关测试断言，**不代表本次已经运行通过，更不代表浏览器验收完成**；实际执行结果以总报告为准。证据采用仓库相对文件名及一基行号，行号对应审计代码而非未来实现。

## 1. 结论与设计修正

1. ManagementStudio 已有大量真实命令、表单、SQLite 持久化和权限校验，不能重新实现另一套任务/资料/资源台账。六个既有业务模块也不是 V2 六中心；其真实注册名称已变为“今日管控、工点与计划、施工任务、检查与处置、资源与档案、资料档案”。另有项目统筹导航和现场导航包装。
2. 业务对象共用 SQLite `records` 中 30 个 collection，而非 30 张独立实体表。机械权威对象是 `resources(kind=equipment).machinery`；`railSafety.definition.resourceId` 引用同一资源。普通资源表单、机械专业面板、现场对象业务弹窗是同库多入口，不应凭多个 UI 推断为多个机械数据库。
3. SQLite 支持按项目授权、成员、任务范围；旧资料库和空间模型仍限定 `safety:project`。新增项目不意味着模型/视频/原资料多项目已经接通。`ManagementWorkspace` 显式屏蔽非 `safety:project` 的模型和媒体上下文，是已有保护而不是自动迁移。
4. `management-files` 删除已有引用阻断、修订、持久化删除意图、重试；`projectLibrary` 删除有 tombstone 和文件回收，但没有查 SQLite 证据/报告/锚点等外部引用。两者不能共用一个无区分的“删除资源”按钮。
5. 项目资料原件（服务器文件）、管理附件（服务器文件）、临建方案（浏览器 IndexedDB）、个人显示偏好（localStorage）、视频融合缓存（OPFS）、机械过程历史（浏览器分块存储）是不同持久层；只备份 SQLite 或 `project-data` 不完整。
6. `monitoring` 集合有人工/命令录入、采样时刻、质量、有效时长和阈值版本；未见其与基坑专业存储的统一点位/设备接口。不能据此认定完整自动监测平台已实现。
7. 固定报告真实能力为冻结源修订、D/F 统计、发布、JSON 下载。现场记录另有浏览器打印；二者不等于结构化 Word/PDF 报告服务。功能目录隐藏 F19/F48，报告页签和更多菜单也过滤部分入口，但 F16 仍可发起 `report.freeze`，已有报告可从关联记录打开。

主要证据：`src/management/forms.ts:56`、`src/management/coordinationView.ts:6`、`src/managementStudio.ts:123,136,375,376,385`；`server/managementStore.ts:56,59,66,71,86,184`；`src/managementWorkspace.ts:501,515`。

## 2. 真实入口与六中心归属

| 既有入口/模块与全部注册页签 | 真实实现、对象与权威写入 | V2 目标归属 | 权限与适配边界 |
|---|---|---|---|
| overview：项目统筹、我的工作 | `managementStudio.ts:36,90,136,191,384`；tasks/actions/issues/metrics/bookmarks | 项目管理 / 驾驶舱、我的工作 | read；新增任务 plan；快照 confirm；书签 read+真实模型上下文 |
| plan：任务、周计划、甘特图、基线与变更 | `forms.ts:15` 起；WBS/tasks/commitments/baselines；`domain.ts:153` 起 | 项目管理 / 计划进度 | plan/confirm；不能以甘特拖动绕过任务修订与日历校验 |
| field：今日作业、检查与验收、问题整改、空间对象、协调事项 | progress/dailyLogs/checks/issues/actions；空间对象引用安全空间台账 | 项目管理 / 执行、质量、协调；安全类检查/问题→安全管控 | field/review/confirm；`purpose=safety`、`kind=safety` 分业务入口，保留同一记录与工作流 |
| inspection：巡检任务、录像与航迹、监测点、巡检成果 | inspections/evidence/monitoring；媒体调用已有 SafetyWorkspace、Video AR | 智能巡检 / 任务、媒体、取证；monitoring→智能监测 | inspect/field，媒体 media、模型 models、原件 files；禁止复制另一份巡检任务 |
| resources：任务准备、实际投入、人员班组、机械、物资、关键辅材、试验 | resources/resourceNeeds/allocations/resourceUsage/batches/tests/materialTransactions | 项目管理 / 资源保障；机械身份及专业配置→施工管理 | resource；机械几何再要 models；已有机械建档转到专业面板 |
| documents：工程资料、上传文件、报审办理、技术问题、变更、会议行动、报告归档 | documents/documentVersions/evidence/documentRequirements/technicalQueries/changes/meetings/actions/links/reports | 项目管理 / 资料协同、协调、报告 | document/publish/confirm；文件 bytes 另需 files；报告归档页签定义存在但当前导航过滤 |
| 项目统筹六项可见导航：今日管控、工点与计划、施工任务、现场三维、检查与处置、资源与档案 | `coordinationView.ts:6`；checks 指向 field/issues，resources 同时包 documents | V2 导航适配，不能等同六大中心 | 不修改底层 module/tab 合同；检查与巡检、资源与资料现有导航合并须展开 |
| 现场三入口：现场工作台、检查与整改、方案与资料；更多、移动端入口 | `fieldView.ts:6`；`managementStudio.ts:291` | 施工管理/安全管控/项目管理的上下文快捷入口 | 共享对象与 currentFieldTask，不复制档案；保留草稿保护 |
| 现场对象“资料/检查/信息”、培训证书、人员档案、同步记录预览/打印 | `railwayFieldOperations.ts:31,92,93,94,205` | 安全管控 / 人员防护；项目资料服务；施工机械引用 | 同一 command/upload API；objectRefs 冻结身份版本；不会创建第二浏览器业务库 |
| 施工/安全监督计划 Excel 导入、示例表、字段映射、异常行/重复检查、重试 | `railwayPlanImport.ts:165,186,246,254` | 项目管理 / 计划导入；安全中心快捷调用 | plan+files；保存原表证据后逐行 task.create，始终待核验草稿；“虚构示例表”是显式用户选项，不能当正式数据 |
| 项目设置、成员、登录/退出；全局搜索；功能目录；报告详情/JSON | `managementStudio.ts:370,371,373,375,385` | 公共项目/身份、搜索；项目管理 / 报告 | 搜索仅当前授权快照，非跨中心服务端搜索；权限须服务端复核 |

全部页签定义见 `src/management/forms.ts:58`。`managementStudio.ts:294` 对 equipment 的 `resource.create` 转到 `openMachineryScene`；因此“新增机械”已有集中入口，不应重复建设。

## 3. F01–F48 功能逐项核验

以下逐项基于 UI 调用 + 命令/场景执行链，而非 `features.ts` 的文字承诺。表中对象均写入 SQLite 同名 collection，另标“空间/资料库/浏览器”的除外。权限简写与第 5 节对应；测试编号在表后给出真实断言位置。共同入口：功能目录 `managementStudio.ts:375–376`、对应模块/详情动作及 `forms.ts`；F19/F48 为隐藏目录项。

| 编号与功能 | 已核验实现与限制（源文件:行） | 对象 / 权限 | 实现状态 | 测试证据 |
|---|---|---|---|---|
| F01 项目关键指标 | D/F 历史指标、钻取，`managementStore.ts:173,288`、`managementStudio.ts:384` | 多台账聚合 / read | 已实现并有测试 | T1:91、T2 |
| F02 我的工作与项目待办 | 当前用户与日期筛选，`managementStudio.ts:291,376`；`workflows.ts` | tasks/actions/issues / read | 已实现并有测试 | T3、T4 |
| F03 近期作业与里程碑 | 本周/下周和已登记里程碑，`managementStudio.ts:191,376` | tasks / read | 已实现并有测试 | T3、T4 |
| F04 施工准备状态 | 真实资源准备和条件结果，`domain.ts:257`、`taskConditions.ts` | resourceNeeds / read、resource | 已实现并有测试 | T1:119、T5 |
| F05 统一搜索与对象详情 | 对当前授权快照按名称/编号/说明搜索，`managementStudio.ts:373`；未形成全平台搜索 API | 当前项目可见 collections / read | 部分实现 | T4；全中心覆盖待补 |
| F06 三维专题展示 | `managementWorkspace.ts:942` 对用户空间对象按任务状态染色，未知保留灰色 | 空间台账+业务只读投影 / models | 已实现但缺少测试 | `tools/verify-management-ui-dom.cjs:34` 覆盖图例；专题业务染色完整端到端断言未确认 |
| F07 重点事项与趋势 | 重点项、里程碑和固定报告列表；无历史快照不虚构趋势，`managementStudio.ts:191,376` | issues/tasks/reports/actions / read、document | 部分实现 | T2；自动趋势分析未实现 |
| F08 展示与汇报视图 | 镜头、筛选、图层、选择恢复，模型版本核验，`managementStudio.ts:202`、`domain.ts:344` | bookmarks / read、models | 已实现并有测试 | T6:49、T7:90 |
| F09 工作分解与空间关联 | WBS 新建/修订、层级、任务区域关联，`forms.ts:15`、`domain.ts:153`；未见通用 WBS 文件导入 | wbs/tasks+空间引用 / plan、models | 部分实现 | T1:24,108 |
| F10 计划基准与节点 | 不可变批准基线，`domain.ts:172`；甘特基线比较 | baselines/tasks / plan、confirm | 已实现并有测试 | T1:36、T8 |
| F11 周计划与日作业 | 周承诺原分母、增量/累计、改期，批量计划独立修订/重试，`domain.ts:176`、`managementStudio.ts:291` | commitments/tasks / plan、confirm | 已实现并有测试 | T1:56、T3 |
| F12 前置关系与开工条件 | DAG/日期、八类条件、开完工重新核验，`domain.ts:104,158`、`taskConditions.ts` | tasks/checks/needs/docs / plan、field、confirm | 已实现并有测试 | T5、T9 |
| F13 任务指派与执行反馈 | 发布/开始/暂停/恢复/申请完工/确认/取消；明确负责人，`domain.ts:157` | tasks / plan、field、confirm | 已实现并有测试 | T9:76,121,195 |
| F14 实际完成量与审核 | 同计量键防重复、修订替代、提交/退回/确认/撤销，`domain.ts:179` | progress / field、confirm | 已实现并有测试 | T1:43,51 |
| F15 预测与计划调整 | 人工预测日、理由及计划修订，`domain.ts:171`、`forms.ts:21`；不自动预测 | tasks/changes / plan、document、confirm | 已实现并有测试 | T7:8,44；预测持久化专项覆盖待补 |
| F16 偏差分析与进度报告 | 甘特与冻结统计，F16 可发起 report.freeze，`managementStudio.ts:376`、`domain.ts:349` | reports/baselines/progress / read、confirm | 已实现并有测试 | T1:91、T8 |
| F17 施工前核验 | 待检查清单→逐项结果→复核；不能以文件已上传代替通过，`domain.ts:195` | checks/evidence / field、review | 已实现并有测试 | T1:61、T5:39 |
| F18 施工日志与执行记录 | 日志引用实绩不重复计量，`domain.ts:194` | dailyLogs/progress / field | 已实现并有测试 | T1:51 |
| F19 质量检查与验收记录 | 功能目录隐藏，但 checks 页签/检查详情仍执行，`forms.ts:27`、`managementStudio.ts:375` | checks / field、review | 已实现并有测试 | T1:61,114、T5:39 |
| F20 质量问题与整改 | 发现/核实/指派/整改/复核，`domain.ts:202` | issues(kind=quality) / field、review | 已实现并有测试 | T1:61、T5:69、T10 |
| F21 安全检查与风险事件 | checks safety + issues safety；地图事件桥共用 issue，`eventBridge.ts:18` | checks/issues+历史事件只读 / field、review | 已实现并有测试 | T1:68、T10 |
| F22 手工空间对象管理 | 调用已有空间工具，不以边界推测业务区域，`managementWorkspace.ts:796` | safety-spatial.json / models、field | 已实现并有测试 | T6:44,45、T1:108,137 |
| F23 整改复核与过程追溯 | 多轮提交、复核退回、关闭、误报/重复归档，`domain.ts:208` | issues/rounds/audit / field、review | 已实现并有测试 | T1:61、T10 |
| F24 现场协调与工序衔接 | 行动项/会议、期限/负责人/完成，`domain.ts:338`；非通用施工动画编排 | actions/meetings/tasks / document（部分现场办理允许field） | 已实现并有测试 | T7:47；工序中心未实现 |
| F25 巡检任务与覆盖 | 安排、记录、证据及确认，`domain.ts:214`；有效确认才计入 | inspections / inspect | 已实现并有测试 | T1:73、T2 |
| F26 录像照片管理 | 资料库导入、受控附件及已有媒体调用，`managementStudio.ts:376`、`managementStore.ts:225` | library/evidence / admin导入、files/media读取 | 已实现并有测试 | T11、T12 |
| F27 航迹关联与校准 | 转到原 Video AR 校准和航迹工作区，`managementWorkspace.ts:92`、`managementStudio.ts:376` | 原视频/航迹资料 / media、models | 已实现并有测试 | T12；专业算法见专业分报告 |
| F28 同步播放与三维漫游 | 共享媒体时间轴、倍速/跟随、关闭停止，`managementStudio.ts:47,291` | 场景会话/媒体 / media、models | 已实现并有测试 | T12 |
| F29 现场取证与问题转交 | 捕获→上传→来源登记→问题，`managementWorkspace.ts:900`、`managementStudio.ts:389` | evidence/issues / field、files、media、models | 已实现并有测试 | T10:116、T13:136 |
| F30 监测点与阈值管理 | 集合、读数、质量/时间/来源、阈值版本均真实；没有通用自动设备适配和基坑点 ID 对接，`domain.ts:346` | monitoring / inspect | 部分实现 | T7:49–51；端到端自动数据链待补 |
| F31 实时状态与断连提示 | 根据最后一次读数有效期展示；不是通用实时监测订阅，`managementStudio.ts:360` | monitoring.samples / read、inspect | 部分实现 | T7；持续时钟刷新/断连端到端待确认 |
| F32 成果对比与归档 | 两张真实证据人工对比、标注转问题，`managementStudio.ts:380` | evidence/issues / files、field | 已实现并有测试 | `tools/verify-platform-b4-ui.cjs:16` 起；无自动识别结论 |
| F33 作业资源需求 | 需求 CRUD/确认、复用清单，`domain.ts:257`、`managementStudio.ts:376` | resourceNeeds / resource | 已实现并有测试 | T1:119、T3 |
| F34 人员与班组安排 | 计划分配与人工实际投入分别记录，`domain.ts:267,273` | allocations/resourceUsage/resources / resource | 已实现并有测试 | T14 |
| F35 机械设备安排 | 同资源 ID 时段冲突；机械引用与实际投入，`domain.ts:267` | resources/allocations/resourceUsage / resource、models几何 | 已实现并有测试 | T1:78、T14、T15 |
| F36 物资到货与领用 | 到货/验收/检验分开、领用/退还/纠正流水，`domain.ts:285` | batches/tests/materialTransactions / resource | 已实现并有测试 | T1:78,119 |
| F37 关键辅材管理 | resource.kind=auxiliary 同套需求/批次链，`forms.ts:32`、`domain.ts:257,285` | resources/resourceNeeds/batches / resource | 已实现并有测试 | T1:78；辅材专项 UI 覆盖待补 |
| F38 试验与检验关联 | 批次或任务，证据/有效期，失败使准备重新核验，`domain.ts:290` | tests/batches/needs / resource | 已实现并有测试 | T1:119、T5:59 |
| F39 短缺与协调处理 | 需求未满足/过期显式状态、负责人/协调说明，`domain.ts:257` | resourceNeeds/actions / resource、document | 已实现并有测试 | T1:119、T5:59 |
| F40 台账汇总与使用追溯 | 当前授权资源导出、实际投入、物料流水，`managementStudio.ts:376` | resources/resourceUsage/materialTransactions / read、resource | 已实现并有测试 | T14、T4 CSV |
| F41 资料分类与检索 | 类别独立于中文标题，快照查询，`metricsState.ts`、`managementStudio.ts:373` | documents/evidence / read、files bytes | 已实现并有测试 | T16 |
| F42 版本与有效发布 | 原件稳定、版本生成、有效版指针及替代，`domain.ts:302` | documents/documentVersions/evidence / document、publish | 已实现并有测试 | T1:85、T13 |
| F43 资料审核与报审 | 提交/退回/发布/作废/交付要求，`domain.ts:306` | documentVersions/documentRequirements / document、publish | 已实现并有测试 | T1:85、T5:59 |
| F44 技术问题与正式答复 | 讨论/答复草稿/正式发布，`domain.ts:332` | technicalQueries / document、publish（部分允许field） | 已实现并有测试 | T1:85、T7:41 |
| F45 变更影响与处理 | 影响/来源/任务/批准依据，`domain.ts:336`；不自动改动原任务 | changes / document、confirm | 已实现并有测试 | T7:44,91；完整流转专项覆盖待补 |
| F46 会议行动项 | 纪要、任务/问题关联、完成证据，`domain.ts:338` | meetings/actions / document | 已实现并有测试 | T7:47,91；全链 UI 覆盖待补 |
| F47 构件与空间资料关联 | 严格模型表面锚点、版本/变换校验、关联既有对象，`managementStore.ts:132`、`domain.ts:315,341` | anchors/links/空间引用 / document或field、models、files | 已实现并有测试 | T1:127,137、T6:48、T13:165 |
| F48 汇报与项目归档 | 真实冻结/发布/JSON；目录项和报告 tab 隐藏，无 PDF/Word 排版和整项目归档，`managementStudio.ts:123,375,385` | reports / confirm | 部分实现 | T1:91、T7:52 |

测试证据索引（存在、已检查内容；执行状态独立记录）：

- T1 `server/managementStore.test.ts`：24 身份/关联/并发；36 基线；43 实绩；51 日志；56 周承诺；61 检查整改；68 事件快照；73 巡检证据；78 物料与安排；85 资料版本/答复；91 历史快照；96 会话；108 跨项目空间；119 失败试验；127/137 锚点与空间来源。
- T2 `server/management/dashboardMetrics.test.ts:16,34`：四卡片与十公式、历史 F、授权范围与钻取。
- T3 `src/management/workflows.test.ts:6` 起：周范围、待办、批量修订、需求复制。
- T4 `src/management/coordinationView.test.ts:24,40,59,81,95,110,119,148,177`：真实导航/窗口、未知状态、计数、CSV；`src/management/fieldView.test.ts:7` 起：现场入口、明确 ID 和当前任务。
- T5 `server/management/reliabilityHttp.test.ts:28,39,45,53,59,69,74`：真实 HTTP 授权、清单、准入、文件、执行人。
- T6 `tools/verify-management-spatial-tools.cjs:44` 起：真实表面对象、测量、锚点、书签；脚本有保存操作，本次未向正式服务运行。
- T7 `tools/verify-management-form-contracts.mjs:8,33,41,44,47,49,52,90,91`：表单字段/权限合同；仅合同测试不足以证明所有业务和浏览器流程通过。
- T8 `src/management/ganttView.test.ts:12` 起：日期、基线轨道、转义和只读控制。
- T9 `server/management/railwayTask.test.ts:39,76,121,157,179,195`：时窗、暂停恢复、实时条件、历史值与 HTTP 权限。
- T10 `server/management/eventBridge.http.test.ts:45,116`：地图与管理同一 issue、旧事件保留、视频/检查来源核验。
- T11 `server/projectLibrary.test.ts:28,51,60,79,89,106,121,140,159,173,192,205`：上传、复制、损坏、路径/Origin、并发、物理删除恢复、缓存归属；`server/management/libraryPermissions.test.ts:10` 分类授权。
- T12 `tools/verify-management-media-scene.cjs:41` 起：真实模型/视频共享时间轴和管理场景；同样不能直接在正式实例运行。
- T13 `server/management/railwayWorkflow.http.test.ts:39,62,82,101,125,136,150,165,198`；`src/management/railwayPlanImport.test.ts:17` 起：原表、来源行、严格对象引用、证书、实时权限。
- T14 `server/management/resourceUsage.test.ts:21,41,53`：人工实际投入独立于安排、修订/幂等/重启、权限。
- T15 `server/management/machineryHttp.test.ts:16,55,95,159,386,414`；`server/management/taskResources.test.ts:45,79,105`：同资源身份、删除、权限和明确关联。
- T16 `src/management/metricsState.test.ts:7,16,22`：统计上下文、异步过期防护、资料分类。

## 4. 全部管理命令与表单边界

`ManagementCommandType` 定义于 `src/managementTypes.ts:28` 起；表单注册是 partial 后类型断言为全表，**不是每个命令都有通用表单**。机械和限界等使用专业面板。所有命令真实进入 `managementStore.command → execute → applyDomain`（`managementStore.ts:121,171`、`domain.ts:48`），项目/成员/证据登记由 store 特殊处理。

| 命令族（实际操作） | 主写 collection/位置 | 入口/来源及权限 | 实现状态 |
|---|---|---|---|
| project.create/update；member.save | projects/members/users；`managementStore.ts:144` | 设置，admin；首账号必须 owner，最后 owner 不可停用 | 已实现并有测试 |
| wbs.create/update；task.create/update/publish/start/pause/resume/request-completion/confirm-completion/cancel/forecast/conditions.configure | wbs/tasks；`domain.ts:153` | forms:15–21、Excel importer、详情；plan/field/confirm | 已实现并有测试 |
| baseline.create/approve；commitment.create/publish/change | baselines/commitments；`domain.ts:172` | forms:22–23；plan/confirm | 已实现并有测试 |
| progress.create/revise/submit/return/confirm/revoke；dailyLog.create | progress/dailyLogs；`domain.ts:179` | forms:24–26；field/confirm | 已实现并有测试 |
| check.create/copy/record/confirm | checks；`domain.ts:195` | 通用表单、现场对象检查；field/review | 已实现并有测试 |
| issue.create/assign/start/submit/review/dismiss/reschedule | issues；`domain.ts:202` | 现场、视频、地图、风险详情；field/review，执行人限制 | 已实现并有测试 |
| inspection.create/record/confirm | inspections；`domain.ts:214` | 巡检表单；inspect | 已实现并有测试 |
| resource.create/update；need.create/update/confirm；allocation.create/cancel；usage.create/confirm | resources/resourceNeeds/allocations/resourceUsage；`domain.ts:217,257,267,273` | 资源保障、实际投入；resource | 已实现并有测试 |
| machinery.create/save/remove/delete | resources；`domain.ts:222` | MachineryPanel/Workspace；resource+models；remove 解除几何，delete 软删资源及当前机械安全配置 | 已实现并有测试 |
| railSafety.save/remove/reportRisk/personnel | railSafety/issues；`domain.ts:119` | RailSafetyPanel、现场人员弹窗；save/remove resource+models，personnel再要files，reportRisk field+models | 已实现并有测试 |
| batch.create/receive/accept；test.create/confirm；material.issue/return/correct | batches/tests/materialTransactions；`domain.ts:285` | 物资/试验/流水；resource | 已实现并有测试 |
| document.create/version/submit/return/publish/void/requirement/fulfill；link.create/remove | documents/documentVersions/documentRequirements/links；`domain.ts:302` | 资料、现场对象；document/publish；部分创建允许field；对象关联再要models+files | 已实现并有测试 |
| technical.create/comment/answer/publish；change.create/confirm；meeting.create；action.create/complete | technicalQueries/changes/meetings/actions；`domain.ts:332` | 资料/协调；document/publish/confirm，部分现场操作field | 已实现并有测试 |
| anchor.create/update；bookmark.create/update | anchors/bookmarks；`domain.ts:341` | 严格取点、工作视图；document或field / read；模型版本输入必需 | 已实现并有测试 |
| monitoring.create/record/threshold | monitoring；`domain.ts:346` | 人工表单/命令；inspect；无通用设备自动 ingestion | 部分实现 |
| report.freeze/publish | reports；`domain.ts:349` | F16/已有报告详情；confirm；JSON下载独立于打印 | 已实现并有测试 |
| evidence.register | evidence；`managementStore.ts:130,156` | 已核验资料库原件或视频截图；field/document/inspect/resource 之一及原资源类别权限 | 已实现并有测试 |

权限不是按统一 prefix 简单决定：`domain.ts:110–117` 对确认/复核/发布及部分 field 替代有显式分支；V2 菜单声明应从真实合同适配，不能只沿用 `FormSpec.permission` 或统一给所有“安全中心”操作一个权限。

## 5. 身份、RBAC、任务范围与调用链

| 能力 | 事实与证据 | 状态/限制 |
|---|---|---|
| 本机未初始化兼容身份 | 仅没有用户、localCompatibility 未禁用、loopback socket、Host 为 localhost/127.0.0.1/[::1] 时 local-owner；`managementStore.ts:81,88–89` | 历史兼容；不能把本机默认所有者当多人身份认证 |
| 账号会话 | scrypt+随机salt；随机token只存SHA256；8小时；HttpOnly/SameSite=Strict；密码变更清 session；`managementStore.ts:31,51,152,174–175,262` | 已实现并有测试；Cookie 未设 Secure，部署TLS代理和互联网安全不在此实现证明内 |
| 角色 | owner 全权限；manager 无admin；planner plan+confirm；quality field+review；inspector inspect+field；resource resource；document document+publish；worker field；viewer read。角色默认包含 models/files/media，但再受成员 resourceAccess 过滤；`domain.ts:15–21` | 已实现并有测试 |
| 项目授权 | 登录成员必须 active；用户 active；每次读取和命令重新推导角色；新建项目给创建者 owner；`managementStore.ts:85–86,120,146` | 已实现并有测试；不能把数据库支持多项目等同所有专业存储都支持 |
| 任务范围 | undefined=全项目，[]=无任务；记录正向关联及 evidence/resources/batches 的消费者引用共同推导，必须全部关联任务获授权；`authorization.ts:38` 起 | 已实现并有测试；复杂关联不会自动赋权；无任务证据仅本人+files 等明确例外 |
| 资源能力 | 任务受限账号移除 models；图层/媒体/原件独立授权；无models对嵌套machinery/definition/railSafetyRisk脱敏；`managementStore.ts:37,86,185` | 已实现并有测试 |
| 请求保护 | Origin校验（提供时）；写请求 X-Cesium-Library；JSON/大小/ID校验；服务端WeakMap actor，客户端不能通过header伪造身份；`managementStore.ts:45–50`、`actorContext.ts:4` | 已实现并有测试 |
| 撤权/UI清理 | workspace每10秒刷新（页面不可见时暂停）、会话到期timer；snapshot变更清草稿/选择/媒体、终止测量与模型权限；`managementWorkspace.ts:200,486`、`managementStudio.ts:63,89` | 部分实现；即时服务端命令权限已有，跨会话实时撤权推送未实现，UI最多待轮询/重新请求 |
| 并发与幂等 | expectedRevision，receipt(project,actor,key)+canonical命令hash；冲突409；每次检查实时权限；队列+BEGIN IMMEDIATE；`managementStore.ts:121–169`、`domain.ts:55` | 已实现并有测试；资料库JSON、IndexedDB不共享这套修订机制 |
| 草稿 | sessionStorage `cesium-management-draft:{project}:{user}`；保存文字/记录revision/文件名，不保存文件bytes；账号表单/批操作不缓存；`managementStudio.ts:228–232` | 已实现但缺少测试；真实浏览器关闭/权限撤销和文件重选需保留验收 |
| 设备身份 | positioning ingest 专用Bearer；机械设备Bearer绑定project/resource/source，浏览器模拟POST另需resource+models；`managementStore.ts:241–260` | 已实现并有测试；Gateway内存帧不等于持久监测历史 |

### 5.1 管理 HTTP 路由全集

共同前缀 `/__management`。除 session 登入及设备专用写入外，先 authenticate；写命令再做域权限/引用/修订检查。行号均 `server/managementStore.ts`。

| 方法 / 路由（兼容别名保留） | 校验和用途 | 源码 |
|---|---|---|
| GET/POST/DELETE /session | 读会话/登录/退出；写需marker；登录10次/5分钟限制 | 262–268 |
| POST /commands、/command | projectId以命令为准鉴权；幂等/修订/事务；首owner建号后自动登录 | 270–272 |
| GET /state、/snapshot | read；返回授权项目/成员/collections、最近200条audit及待清理附件 | 100–104,287 |
| GET /metrics | read；D/F、taskId/areaId/owner/status/query/period过滤 | 173,288–289 |
| POST /upload、/uploads | files + field/document/inspect/resource之一；planner仅施工/监督Excel计划原件例外；100MiB，校验objectRefs/task/category、SHA256 | 225–235,291 |
| DELETE /files/:id | files +业务写权限；expectedRevision、引用保护、物理清理/重试 | 208–223,292 |
| GET/HEAD /files/:id/original、/preview | files+任务范围；校验受控路径/bytes；两条路由均返回原件，preview不是转换服务 | 296–298 |
| GET /machinery/:id/documents | read+files+models，当前机械、四种附件类别、返回ready及pending删除 | 293 |
| GET /tasks/:id/conditions | task授权；实时计算准入条件、版本、证据 | 294 |
| GET /records/:collection/:id | 合法collection、任务授权、敏感几何脱敏 | 295 |
| POST /positioning/ingest | 仅设备Bearer，无cookie/local-owner回退；项目/设备绑定，16KiB | 241–247 |
| GET /positioning | read+models；授权railSafety对象的定位快照 | 282–285 |
| POST /machinery-telemetry | 设备Bearer绑定或会话模拟resource+models+marker；16KiB帧 | 249–260 |
| GET /machinery-telemetry | read+models；合法after整数、streamId重启识别，按可见资源过滤 | 275–280 |
| GET/POST /__safety/events（旧URL） | read合并只读旧JSON+SQLite issue；create/adopt-legacy/assign/start/submit/review/dismiss/reschedule转命令；拒绝旧complete跳过复核 | 172,238；`eventBridge.ts:18,31,69` |

### 5.2 工程资源路由的前置鉴权

`managementPlugin` enforce=pre，挂 `accessMiddleware` 再管理路由（`managementStore.ts:305`，`vite.config.ts:564`）。因此不得只看到下游 middleware 没有登录代码就断言匿名可访问。

| 资源族 | 前置实际权限 | 下游路由/证据 |
|---|---|---|
| /__local_tiles、/__models、/__safety/models、/__safety/model-optimization | GET/HEAD=models；写=admin | `managementStore.ts:190` |
| /__local_imagery | GET/HEAD=models；写=admin | `managementStore.ts:191` |
| /__safety 其余 | read=read；write=field；events另走桥；空间服务再做自身校验 | `managementStore.ts:192` |
| /__library/records GET、/:id GET | read，按保存的kind进一步筛选 | `managementStore.ts:195`；`projectLibrary.ts:358,387` |
| /__library/files/:id/:slot/path GET/HEAD | Model/Tiles/Imagery=models；Drone Video=media；CAD/GIS=files；未知要三者 | `managementStore.ts:194`；`projectLibrary.ts:379` |
| /__library/view PUT | read即可写全局view.json（不是按用户隔离） | `managementStore.ts:197`；`projectLibrary.ts:370` |
| /__library/records/:id PUT/PATCH/DELETE，/:id/files/:slot POST、/:id/copy POST、/:id/pos POST | admin，Origin和marker；已保存原件不可覆写，POS追加新版本指针 | `managementStore.ts:197`；`projectLibrary.ts:381–394` |
| 原始目录 /project-data /tmp /output /.local-backups /server /.git、非白名单/@fs | 禁止绕过受控接口 | `managementStore.ts:180–182` |
| /__diagnostics/render-error POST、/latest GET | 不在管理前置正则；自身无身份、Origin、marker校验 | `managementStore.ts:183`；`vite.config.ts:458–486`；详见风险D7 |

任务受限账号原则上不能访问全工程目录，仅对其已有授权 evidence 的精确原件 URL 有例外（`managementStore.ts:185–188`）。旧资源路由的 actor 恒由 legacyProjectId 求得；`projectId` query 不能切换资料库租户。

## 6. 存储及实体关联映射

### 6.1 SQLite schema 与写入者

路径优先级：`options.dataDir → CESIUM_MANAGEMENT_DATA_DIR → CESIUM_DATA_DIR → cwd/project-data`；文件 `management.sqlite`，WAL、foreign_keys=ON、busy_timeout=5000，user_version=1；未来版本>1拒绝打开（`managementStore.ts:56–76`）。启动会建表/建默认项目/尝试待删除附件清理，因此本审计没有调用 `createManagementStore` 访问正式目录。

| 表/文件 | 键/内容与权威写入者 | 关系、保留与限制 |
|---|---|---|
| projects | id→JSON 项目、calendar、CRS、verticalDatum、revision | project.create/update；无project.delete命令，也无整项目归档命令 |
| users / members / sessions | 全局username/password_hash；(project_id,user_id)成员JSON；token_hash及expires | 用户凭据跨项目、成员权限按项目；不可通过管理成员重置他人密码 |
| records | (project_id,collection,id)、revision、JSON | 唯一业务命令写入层；30个collection；实体关系主要应用校验，非独立SQL外键 |
| record_versions | (project,collection,id,revision)、recorded_at、整条JSON | D/F历史与报告来源；避免覆盖丢失旧版 |
| receipts | (project,actor,key)、signature、record_id | 重试幂等；不同内容相同key冲突 |
| audit | 自增id、project/actor/command/record/before/after/time/reason | 记录流转；快照只给最近200条，全项目/受限账号可见性不同 |
| meta | revision | 全数据库变化计数；不是各项目独立版本 |
| management-files/{UUID} | 原上传字节，无扩展名，以evidence.metadata描述 | 100MiB、SHA256、存储路径/符号链接检查；原件和preview当前均为同一字节 |

30 个 collection 全列：`wbs, tasks, baselines, commitments, progress, dailyLogs, checks, issues, inspections, resources, resourceNeeds, allocations, resourceUsage, batches, materialTransactions, tests, documents, documentVersions, documentRequirements, links, technicalQueries, changes, meetings, actions, evidence, anchors, bookmarks, monitoring, reports, railSafety`（`managementTypes.ts:10`）。

### 6.2 业务对象真实关系

| 关系 | 真实键及约束 | V2 处理 |
|---|---|---|
| WBS→任务→空间 | parentId/wbsId；task.areaIds；spatialReferences冻结project/revision/geometrySha256/sourceSha256 | WBS/任务属项目；空间几何维持原权威，不能依据任务名造区域 |
| 任务→资源 | task.resourceIds、resourceNeeds.resourceId、allocations.resourceId、resourceUsage.resourceId | 三种关系不同：引用、需求/计划安排、实际投入；不得合并为“已到位” |
| 机械→场景→安全 | resources.id+machinery参数/placement；railSafety.definition.resourceId；selectedLimitIds | 现存场景实例信息嵌入machinery，尚无统一独立SceneInstance表；V2先适配后讨论迁移 |
| 安全人员→设备/档案 | railSafety.guard workArea.deviceId、personnel/certificateEvidenceIds/resourceIds | 同项目设备绑定唯一；人员计划岗位不等于实际到岗；资料原件归统一evidence |
| 进度→日志/确认 | progress.entryId、revisions、confirmations；dailyLogs.progressEntryIds | 只计有效确认值，不重复把日志计量 |
| 检查→问题→复核 | checkId、issue.rounds、evidenceIds；discovery/positionSnapshot/railSafetyRisk保留来源 | 质量、安全入口按kind/purpose拆分，同源问题不复制 |
| 资料→版本→证据 | documents.effectiveVersionId；documentVersions.documentId/evidenceId；requirements.versionId | 上传、报审、发布、交付是不同状态；作废/替代触发重核 |
| 关联与锚点 | links.targetKind/targetId、sourceKind/sourceId、anchorId、objectRefs；anchor模型asset/version/transform | 稳定ID+服务器核验；不要用名称匹配 |
| 巡检/视频取证 | inspections.evidenceIds；evidence.recordId/sourceRecordId/fileKey/mediaId/mediaSeconds/fileId | 引用原资料及受控截图，保持媒体来源、时间、对象快照 |
| 监测→样本→阈值 | monitoring.samples[] / thresholds[]，sampledAt/receivedAt/quality/source、validForSeconds | 当前嵌入JSON数组；未接通基坑专业点位，未有独立采样表/通用设备历史服务 |
| 报告→冻结来源 | sourceRevisions[{kind,id,revision,data}]、spatialReferences、D/F/formulaVersion | 固定历史；原文件删除仍可能使证据bytes失效，不等于完整独立归档包 |

跨对象可见性与附件引用检查共用 `server/management/authorization.ts:5–36` 的 `recordReferences`。后续新增关系字段若不进入该枚举，会同时影响任务授权与删除保护，必须纳入合同测试。

### 6.3 服务器JSON、浏览器与实时数据

| 存储 | 实际格式/范围 | 权威写入者、现状/风险 | 实现状态及测试 |
|---|---|---|---|
| projectLibrary | root/records/{id}/record.json+slots；root/deleted/{id}.json；root/view.json；kind CAD/Tiles/GIS/Model/Imagery/Drone Video；无projectId | `projectLibrary.ts:66,164,179,191`；记录混合原件、显隐、transform/editor参数；不是ResourceAsset与SceneInstance完全拆分 | 已实现并有测试；T11 |
| 资料库证据适配 | `libraryEvidence.ts:12–34` 只读核验manifest/slot/path/mtime/size，限定legacy project | 原文件不复制；默认resolver未返回sha256（类型虽可选），不可声称所有外部证据已做哈希保全 | 部分实现；libraryEvidence.test.ts:14,24,31 |
| 安全空间/历史事件 | safety-spatial.json；safety-events.json旧历史只读 | 空间对象沿用旧服务；新事件由SQLite issues写，eventBridge投影 | 历史兼容；T10、T1:137 |
| 临建方案 | IndexedDB cesium-temporary-works-v1 / plans，keyPath=[projectId,id]，projectId索引 | `temporaryWorksStore.ts:5,35`；put/updateExisting/remove，事务完成再resolve；无服务端RBAC/审计/版本；main.ts:3314依据管理权限注入project | 已实现但缺少测试（真实IndexedDB适配器专项）；专业Panel测试用fake store，不等同浏览器耐久性 |
| SceneDisplayStore | localStorage `scene-display:v1:${JSON.stringify([projectId,actorId??null])}` | 仅overrides/labels/groups/view/collapsed，最多5000对象/100组；removeItems支持异步旧scope；不是业务对象库 | 已实现并有测试；sceneDisplayStore.test.ts:26,48,84,102,127,144,160,216 |
| RailSafetyDisplay | localStorage `rail-safety-display:v1:[project,actor]` | `railSafetyDisplay.ts:122`；显示参数，与业务安全定义分开 | 已实现并有测试；对应display tests |
| 临建灯光与升级偏好 | localStorage project+user灯光键；upgrade project键 | `temporaryWorksLightingPreferences.ts:15`、`temporaryWorksPanel.ts:652,1058`；偏好不是临建原件 | 已实现并有测试；对应偏好测试 |
| 管理草稿 | sessionStorage project+user | `managementStudio.ts:228`；只保存文字/文件名，退出登录/撤权清理 | 已实现但缺少测试；附件需要重选 |
| 机械实时帧 | Gateway内存；机械帧60秒、最多2048条、streamId重启改变；定位为内存样本；初始模型/姿态在resources.machinery，管理选择在resources.manageSensors；传感器字段绑定和运行配置在Controller localStorage，外部凭据由Gateway私有配置负责 | `machineryTelemetryGateway.ts:20,78,93,113,116`；不写机械主参数；外部设备配置只存tokenHash | 已实现并有测试；gateway.test.ts:59,76,92,109,122 |
| 机械遥测与过程历史 | localStorage actor+project+resource键；记录器分块持久化，明确开始才记录 | `machineryTelemetryController.ts:48`；`machineryPoseRecorder.ts:203,254,333`；浏览器换用户/清站点/换origin影响历史 | 已实现并有测试；recorder.test.ts:109,121,154,164,182,196 |
| 视频融合电影缓存 | OPFS cesium-ar-fused-movies-v1，manifest+完整文件，输入哈希/方案ID | `videoOverlayCacheStore.ts:21,33,62`；不是SQLite或服务器project-data | 已实现并有测试；videoOverlayCacheStore.test.ts |
| 基坑专业数据 | localStorage cesium-foundation-pit-monitoring-v1 | `foundationPitMonitoring.ts:193,462,743,887`；不等于管理monitoring集合；项目隔离详见专业审计 | 部分实现（与统一数据/权限关系未接通） |
| 标绘/立面贴图/地下空间 | localStorage cesium-global-markups-v1；IndexedDB cesium-markup-textures-v1；cesium-digital-twin | `markupTools.ts:69,87,205`、`subsurfaceTools.ts:116,141`；工程工具另有独立本地存储 | 部分实现（统一项目/权限映射未完成）；详见工程场景分报告 |

## 7. 删除、显隐与归档：实际差异

| 操作 | 真实影响 | 需要保留的保护与待补项 |
|---|---|---|
| SceneDisplay显隐、分组删除 | 只改个人偏好，分组删除不改对象可见基值 | 不可映射为业务status；现有测试覆盖重叠组及scope |
| library PATCH visible/settings | 写共享record.json，settings浅合并、无expectedRevision | 与个人显隐/场景实例变换语义不同；现有并发测试仅证明不同字段合并，无跨客户端同字段冲突处理 |
| machinery.remove | 删除resources.machinery，保留资源 | 真正“解除三维机械模型”，目前常见删除按钮没有调用这一命令 |
| machinery.delete | status=deleted、deletedAt、停止sensor、去machinery；当前machine安全配置软删；历史tasks/guards/limits/versions保留；需求重新核验 | `domain.ts:239–251`；现有专业/目录删除实际是业务软删，不能文案称卸载实例 |
| railSafety.remove / 工作区删除 | railSafety软删；人员工作区删除仅删除definition.workArea后save | `managementWorkspace.ts:318–343`；责任区/影响区是派生表现不可独立删 |
| document.void、issue.dismiss、allocation.cancel | 业务状态变化，历史保留 | 文档作废清有效指针、触发要求复核；问题误报/重复并非文件删除 |
| 受控附件 DELETE | 引用检测→deleting持久意图→删除唯一storageName bytes→deleted；失败503可重试 | `managementStore.ts:202–223`、`fileLifecycle.ts:18`；报告冻结引用也阻止删除 |
| projectLibrary DELETE | tombstone先提交→清record目录→最后共享owner时清model-cache job；重启/list继续清理 | `projectLibrary.ts:83,147,191`；无SQLite外部业务引用保护，存在断链风险；GET list不是完全无副作用 |
| 临建remove | IndexedDB删除[projectId,id] | 无软归档/服务器审计；专业实例释放需分别走已有Panel流程 |
| 删除项目/跨存储完整归档 | 无对应命令/事务/归档包 | 未实现；不得在V2导航阶段顺带实现或通过删目录替代 |

## 8. 重复入口、配置及权威冲突清单

| 编号 | 真实重复/关系 | 判断与目标处理 |
|---|---|---|
| M1 | 资源equipment页、顶部机械、现场对象目录、三维点击机械、SceneDisplay编辑 | 同一个resources ID、多入口；施工管理保留唯一专业编辑器，项目资源保障引用。已有resource.create equipment转接可复用 |
| M2 | 管理通用issue/check、现场对象检查、地图事件、风险详情、视频取证 | 新业务已统一SQLite；按质量/安全/巡检来源分入口，不能迁到三份问题表；旧safety-events是只读兼容 |
| M3 | 工程资料、上传文件、现场对象资料、机械四类资料、人员证书 | 共用evidence/management-files及documents/version；多个上传入口是有不同metadata的服务适配，不能复制原件仓库 |
| M4 | 项目资料库与管理资料服务 | 两个真实原件存储/权限/删除域；需要显式asset↔evidence关系及反向引用保护，不能宣称已统一 |
| M5 | monitoring与基坑专业监测 | 两份不同业务模型/存储，没有稳定点位映射；属于真实待整合数据，非仅导航重复 |
| M6 | SceneDisplay偏好、library.visible、railSafetyDisplay、机械显示、bookmark.layers、library/view.json | 同时存在个人覆盖、共享基值、场景会话和书签；新目录必须定义优先级，不能把一个开关回写全部层 |
| M7 | 工作视图bookmarks、library view.json、电子沙盘视角、三维汇报镜头 | 意图相近但数据/作用不同；工程场景资源、工作上下文、汇报文稿分别保留，不靠同名合并 |
| M8 | 任务resourceIds、needs、allocations、resourceUsage | 不同关系不是重复记录：引用、需用、计划安排、实际投入。设计矩阵需明确各自权威 |
| M9 | 定位/机械Gateway、机械过程记录、monitoring.samples | 实时内存状态、人工启用过程日志、业务读数三类；不得拿任一“有数据”宣称全链持久监测 |
| M10 | 功能目录48项、真实显示46项、两套导航、隐藏报告页 | 不能用features.length当可见功能验收；保留深链/报告详情和F16冻结入口，统一注册时逐一映射 |

## 9. 发现、风险和下一阶段准入建议

以下是静态可追溯发现，不声称已对正式环境复现，也不在本阶段修复。

| 编号/优先级 | 发现与触发路径 | 影响、证据及应补验证 |
|---|---|---|
| D1 / P1 | 资料库原件删除未查管理库引用：admin调用library DELETE，remove只检查owned path/tombstone/cache共享 | 可能留下 evidence/sourceRecordId、视频证据、冻结报告/锚点引用而原件不可用。`projectLibrary.ts:191–202` vs `fileLifecycle.ts:18–31`。隔离测试应建立原件→evidence→report，再删除并要求引用影响/阻断；当前资料库测试覆盖自身生命周期而非跨库引用 |
| D2 / P1 | 多项目支持边界不一致 | `LibraryRecord`无projectId，accessMiddleware使用legacyProjectId，resolver拒绝其它project；Workspace显式锁safety:project。`src/projectLibrary.ts:13`、`managementStore.ts:59,184`、`libraryEvidence.ts:14`、`managementWorkspace.ts:515`。先定义统一上下文和适配边界，禁止通过把所有project映射成同一个默认ID“修复” |
| D3 / P1 | 浏览器业务存储没有服务器权限与统一备份 | 临建plans、基坑、标绘、过程历史、OPFS依赖浏览器profile/origin；SQL备份不包含它们。`temporaryWorksStore.ts:7`等。二阶段只做导航也须保护origin、key、projectId，不隐式迁移或清缓存 |
| D4 / P2 | 外部原件证据在通用详情预览可能被导向错误API | register外部evidence有library URL但无storageName（store:157）；`managementStudio.ts:358`一律用管理/files/id/original；server:297返回FILE_EXTERNAL。构造仅外部引用、未截图的证据后打开详情，需隔离浏览器复现；目前标记待确认行为，不修改代码 |
| D5 / P2 | 资料库settings更新无乐观修订、个人显隐与共享visible混用 | 同字段跨窗口后写覆盖，settings仅顶层浅合并；shared view PUT只要read即可修改。`projectLibrary.ts:179–188,370`、`managementStore.ts:197`。需要定义公共实例参数与个人视图的权限/并发合同，保持旧保存兼容 |
| D6 / P2 | 统一权限“立即生效”的UI侧只具轮询/到期失效，非服务端推送 | server重检已有；UI每10秒且document.hidden跳过，旧详情可能到下次请求才撤销。`managementWorkspace.ts:200,486`。验收撤权停止订阅、项目切换迟到响应，不能仅测按钮禁用 |
| D7 / P2 | diagnostics接口未被管理前置鉴权覆盖 | `vite.config.ts:460` POST写latest及时间戳JSON，481 GET读最近错误；`managementStore.ts:183`正则不含diagnostics。可访问服务者可能读诊断内容/写文件；实际局域网暴露范围待部署核查。未尝试发送请求；后续需隔离测试权限、请求标记、大小和限频 |
| D8 / P2 | 通用监测与专业基坑未统一；内存遥测不长期留存 | `domain.ts:346–348`与foundationPit localStorage；gateway 60秒/2048帧/重启streamId。需要稳定对象/点位映射和明确“人工录入/回传/模拟/过期”，不能将模拟帧误认实测历史 |
| D9 / P2 | 功能文档表述大于可见入口/输出能力 | F19/F48隐藏，reports tab和more freeze过滤，但F16仍能冻结；JSON报告≠PDF排版/完整项目归档。`managementStudio.ts:123,136,375,376,385`。在审核矩阵中分别列可见入口、可调用能力与规划项 |
| D10 / P2 | 外部资料证据hash未由默认resolver计算 | resolver返回size/mtime/permission但无sha256；store接受optional sha256。`libraryEvidence.ts:34`、store:157。当前来源核验有效但不能叫“已对每份原件做哈希证据”；以后若引入内容哈希需大型视频成本和兼容策略 |
| D11 / P2 | GET/list及构造器可能写数据 | createManagementStore建表/默认项目/清理deleting；projectLibrary.list创建records目录、恢复删除。`managementStore.ts:56,63,77,207`、`projectLibrary.ts:147–150`。只读审计不要以“GET请求”或“只启动后端”视为无副作用 |

建议顺序仅供用户审核：先冻结实际入口/对象/权限矩阵；第二阶段注册导航与面板时保持当前服务合同、Viewer和project隔离；随后再在获批阶段设计跨库引用保护和统一项目上下文；专业中心按引用适配；数据迁移、通用自动监测、长期遥测存储及项目归档均需独立方案、迁移/回滚和测试。**本次不执行任何第二阶段实现。**

## 10. 本分审计的验证边界

- 已逐项阅读管理表单/功能目录、Studio/Workspace调用链、域命令、HTTP分支、SQLite schema、鉴权、资料库、证据删除、临建存储和显示偏好代码，并核对列出的测试具体断言。
- 没有执行访问正式服务的业务GET/POST/DELETE，也没有运行会初始化正式数据库、恢复删除或生成演示数据的应用代码。
- 无新增业务测试、无业务修复、无依赖安装、无部署。浏览器逐入口可达性、真实IndexedDB持久化、跨库删除阻断缺失的完整复现、正式用户角色/设备配置与历史数据规模，仍需后续获批隔离验证；本报告未将这些待确认项写成已验收通过。
