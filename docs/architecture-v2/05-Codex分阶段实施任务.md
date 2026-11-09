# 05 Codex 分阶段实施任务

## 总目标
基于指定稳定基线，在 codex/platform-management-v2 分支完成统一管理架构设计与逐步实现。最终为六大中心 + 左侧导航 + 中央唯一 Cesium Viewer + 右侧统一业务面板 + 统一场景对象目录。

## 第一阶段：全量审计（当前只执行）
只读，不修改业务代码。扫描：
- 仓库完整目录和所有入口（HTML、query screen、独立页面、快捷按钮、隐藏入口）。
- src/main.ts 所有 tab、panel、事件监听、面板 host。
- ManagementWorkspace / ManagementStudio 六业务模块和三维模式。
- SceneDisplayPanel、SceneDisplayStore、场景对象资源适配。
- Machinery、RailSafety、TemporaryWorks、FoundationPitMonitoring、Video AR、CAD/GIS、电子沙盘、三维汇报。
- 服务端 API、SQLite、项目资料库、IndexedDB、本地偏好、文件存储。
- 权限、删除/归档、场景资源释放、项目切换、实时订阅。
- 测试文件和真实浏览器验收脚本。

输出：
1. 功能清单：每项有源文件、入口、状态、测试、存储、权限。
2. 旧入口到六大中心映射。
3. 重复入口/表单/数据维护清单。
4. 业务对象和场景对象真实存储映射。
5. 模块依赖图及 Viewer 所有权证明。
6. 风险清单和实施顺序。
7. 与本设计文档差异及修正建议。

状态只允许：已实现并有测试、已实现但缺少测试、部分实现、仅有 UI、历史兼容、未实现、待确认。不能仅凭命名推断状态。

第一阶段完成后停止等待用户审核，不得进入第二阶段。

## 第二阶段：导航和面板框架
前置条件：用户确认审计结果。
- 设计 module registry、navigation controller、panel registry、panel lifecycle adapter。
- 保留现有模块实例和事件合同。
- 左侧六大中心，右侧统一面板容器。
- 原始工作台与项目管理工作台统一入口。
- 保留 ?screen=management、?screen=safety、原启动脚本和 AR V2 URL 的兼容策略，未经验证不得删除。
- Viewer 由原场景宿主唯一持有，禁止新建第二 Viewer。
- 所有面板支持打开、隐藏、关闭、返回、草稿保护和项目切换。

验收：旧入口全覆盖；切换面板不重建 Viewer；项目切换不串数据；草稿保护；权限撤销生效。

## 第三阶段：统一场景目录
复用 SceneDisplayPanel / SceneDisplayStore。实现业务视图与场景视图、搜索过滤、分组、批量显隐、定位、属性、唯一权威编辑器入口。区分隐藏、卸载实例、删除实例、归档业务对象、删除原始资源。删除前显示引用影响。目录刷新不得无谓重建场景或打断视频。

验收：机械删除后模型同步移除；隐藏不删除台账；临建编辑不重复建档；跨项目不串对象；用户显示偏好隔离。

## 第四阶段：专业中心适配
按顺序接入：
1. 工程场景：Tileset、地形影像、CAD、模型、GIS、电子沙盘、标绘、三维汇报。
2. 项目管理：ManagementStudio 业务列表/表单/报表。
3. 安全管控：RailSafetyPanel 与风险事件。
4. 施工管理：MachineryPanel、MachineryDocumentsPanel、TemporaryWorksPanel。
5. 智能监测：FoundationPitMonitoring 和真实数据接口。
6. 智能巡检：VideoArFusion、VideoModelOverlay、AR V2、巡检证据。

只调整入口、面板布局和调用关系；专业几何算法、业务校验和持久化优先保留。

## 第五阶段：数据关系与权限
映射资源、业务对象、场景实例、关系、遥测绑定、样本、事件、证据的现状。新增表时提交 schema、migration、rollback、兼容读写和测试。统一项目上下文、稳定 ID、权限与审计。场景目录不能成为业务对象唯一数据源；删除模型实例不能删除机械台账、监测历史或证据。

## 第六阶段：回归与部署候选
测试安装/锁文件、TypeScript build、全量 Node tests、服务端 API/权限/文件生命周期/持久化、1920x1080/1366x768/窄屏浏览器。覆盖模型、CAD、GIS、临建四类生成与自动/手动取高、机械 CRUD/姿态、营业线限界/倾覆、视频 AR、基坑支护/监测、项目任务/资料、场景目录。保存关键截图、日志、录屏。

构建到独立暂存目录。本地正式部署由用户电脑 Codex 执行。未经用户确认不得覆盖运行目录或合并稳定分支。

## Git 约束
- 基线固定为 24f79e0c2a62613417c61f61077949aee147c97e。
- 分支 codex/platform-management-v2。
- 禁止 force push、reset --hard、clean -fd、覆盖用户工作区。
- 每阶段独立提交。
- 不更新依赖、包管理器或锁文件，除非先证明必要并单独审批。
- 发现未提交变更时先停下并保护。

## 本地 Codex 首条指令
Fetch 并检出 codex/platform-management-v2；检查 git status --short --branch、git worktree list，核对基线祖先关系，避免覆盖当前工作区。只执行第一阶段只读审计并输出报告。完成后停止，等待审核。禁止部署、禁止修改业务代码。
