# 平台管理架构 V2.0：第一阶段全量静态代码审计报告

**交付范围：第一阶段审计报告；第二阶段未开始。** 基于 `4a5d7c7cdecc31846201d0cf2e0ba7b8d9fc3acc`（2026-11-09），覆盖仓库全部1,090个受控文件的目录/文件清单及文本扫描，并对功能入口、专业模块、数据写入/权限/删除调用链作定点语义审查。不是逐行安全证明，也不是本次浏览器或现场验收。

仓库：[cristinomcleary-ship-it/cesium](https://github.com/cristinomcleary-ship-it/cesium)。开发分支：`codex/platform-management-v2`。稳定祖先：`24f79e0c2a62613417c61f61077949aee147c97e`。独立worktree：`F:\codex\cesium-platform-management-v2-audit-20261109`。原正式工作区、4个既有worktree、未提交定制和项目数据保留。

## 核心结论

1. **保留专业模块、通过适配统一入口是可行方向。** 主页面Cesium Viewer仅由main创建一次，管理/安全/施工等借用；场景目录已有单实例跨宿主挂载。AR V2是独立Three.js高级工具，应保留原URL。当前尚无目标六中心的统一module/navigation/panel registry。
2. **入口重复与数据重复必须分开处理。** 机械、安全面板、资料表单已有很多同一记录的多入口；沙盘进度/风险/场布、基坑与管理monitoring、隐蔽档案与资料库则存在真实独立存储，不能按名称直接合并或删除。
3. **多项目、权限与存储尚未全平台统一。** 管理SQLite有项目/角色/任务范围控制；旧资源服务固定safety:project，多项浏览器业务用固定键。SceneDisplay的个人偏好隔离不能证明业务数据已隔离。
4. **生命周期是后续整合的首要风险。** 保存图层“移除”可能删除原件；ProjectLibrary删除缺跨管理库引用保护；机械解除模型与台账软删不同；临建切面板草稿行为和基坑保存失败反馈需重点验证。共22项总风险及专业补充详见06。
5. **设计中部分能力仍是目标。** 自动监测/外部基坑系统联动、通用施工工序、完整无人机任务执行、共享原始相机标定、完整质量修复流水线、PDF/Word报告及整项目归档不能标为已完成。原有模型检查/显示对照、视频融合、手工监测、JSON报告等已实现能力应保留。
6. **本机是既有24f79e0磁盘部署，不是V2部署。** index指纹与现有启动记录匹配；当前桌面入口为5289包装，带模型导入限制；检查时相关服务端口未监听。正式工作区7个受保护文件的SHA256、字节数、修改时间和Git状态一致。

## 阅读导航

| 报告 | 内容 |
|---|---|
| [00 本机环境与保护证据](00-environment-and-preservation.md) | Git/5个worktree、稳定基线、未提交修改保护、磁盘部署/运行观察、真实数据目录 |
| [01 全入口与工程场景](01-entrypoints-engineering.md) | 32类入口映射、28项工程/公共能力；顶部13入口、query、隐藏入口、浮层、Dock、独立URL |
| [02 权威归属、重复与依赖](02-ownership-duplicates-dependencies.md) | 六中心真实对象归属矩阵、22组重复/重叠项、Viewer所有权证明、依赖图、生命周期表 |
| [03 专业模块功能清单](03-professional-modules.md) | 机械/安全/临建/基坑/旧安全/视频/AR的细功能、源代码、存储、权限、测试、状态和风险 |
| [04 管理业务、数据与权限](04-data-permissions-management.md) | 48项管理功能、实际导航、全部命令/API、9张SQLite表/30集合、存储关系、RBAC、引用与删除 |
| [05 测试、依赖与部署](05-tests-dependencies-deployment.md) | 全仓覆盖口径、双锁差异、构建/启动服务拓扑、测试分层、脚本副作用、部署边界 |
| [06 风险、设计勘误与准入](06-risks-design-corrections.md) | 22项总风险、对原7份设计逐份修正建议、待用户确认的后续顺序 |

逐项功能状态只采用交接要求的7类：**已实现并有测试、已实现但缺少测试、部分实现、仅有 UI、历史兼容、未实现、待确认**。表格中的限定说明用于区分子功能和环境依赖；有相关测试不代表该功能全部路径已覆盖。

## 可机读审计附件

| 附件 | 记录数 | 解释 |
|---|---:|---|
| [repository-file-inventory.tsv](repository-file-inventory.tsv) | 1,090 | 全受控文件，一文件一行；路径/分类/字节数/文本行数/SHA256/审查方法。951文本全文机器扫描，139二进制仅元信息/hash |
| [test-inventory.tsv](test-inventory.tsv) | 328 | 测试、验收、诊断及嵌入自检文件；184 Node test、11 Python unittest、96浏览器/集成、33其他、4嵌入辅助；均未执行 |
| [dependency-edges.tsv](dependency-edges.tsv) | 2,484 | 669个代码/HTML文件扫描到的TS/JS import引用，包含类型/CSS/测试，非完整运行期依赖图 |
| [entry-control-references.tsv](entry-control-references.tsv) | 1,103 | 控件/动态HTML/URL与路由读取的词法位置；一行可含多个按钮，不能当功能数量 |
| [event-references.tsv](event-references.tsv) | 744 | 注册/解除/派发/订阅词法引用；包含测试与注释，不等于独立事件数 |
| [storage-references.tsv](storage-references.tsv) | 166 | SQLite/IndexedDB/localStorage/数据目录等词法位置；存储结论以04语义检查为准 |
| [workspace-preservation-proof.json](workspace-preservation-proof.json) | 7个保护文件 | 原工作区分支/HEAD/状态/空暂存区、前后文件哈希/长度/时间 |
| [audit-validation.json](audit-validation.json) | 报告检查记录 | 附件行数/哈希、源文件与基线一致、引用与报告范围的验证结果；不是业务测试结果 |

各附件是基准提交的源码快照证据，**不包含**本次新增报告自身，也不收录未跟踪私有模型/业务库内容。表中的文件分类提示不是权威业务归属。代码证据使用仓库相对路径和一基行号；原代码可固定在[审计源提交](https://github.com/cristinomcleary-ship-it/cesium/tree/4a5d7c7cdecc31846201d0cf2e0ba7b8d9fc3acc)查看。

## 验证与边界

已阅读根 `CODEX_PLATFORM_MANAGEMENT_V2_HANDOFF.md` 和architecture-v2全部7份设计文档；已核对祖先关系、源提交仅文档差异、全仓文件覆盖与SHA256、关键入口/写入/鉴权/删除/测试调用链，并通过独立交叉复核修正初步判断。只新增本目录报告与索引；原设计、业务代码、部署脚本、依赖和锁文件均未修改。

本阶段**没有**运行依赖安装、构建、业务测试、真实浏览器验收、设备连接、数据库操作或部署。没有把历史验收记录计为本次通过；没有访问可能触发删除清理的业务GET接口。报告中的静态候选缺陷与环境可用性待确认项已明确标记。

提交后停止，等待用户审核本报告。第二阶段导航/面板实现、任何数据迁移、修复和正式部署都没有开始。
