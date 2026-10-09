# 2026-10-09 数字孪生平台分批修订

执行依据：[原始任务书](platform-revision-taskbook.md)。审查及实际起点为 `ad92b1816e4a241f01d9fa3cf230037bed519cd0`；启动时工作区干净。独立开发分支 `codex/platform-reliability-20261009`。保持 Vite、TypeScript、Cesium 1.144.0、原 Viewer、原工程数据与原视频。

## 数据保护与启动

仍在项目目录运行 `npm run dev -- --port 5173 --strictPort`，打开 `http://127.0.0.1:5173/?screen=safety`。原双击启动器和旧工作台入口保留。Node.js 24；依赖不批量升级。

本轮开始时只读记录了正式库 3,822 个 JSON 文件 SHA-256，并用 SQLite 在线备份接口生成一致副本；记录位于 `output/platform-revision-20261009/baseline.json`，副本为同目录 `management-baseline.sqlite`。副本含真实业务与账号信息，仅本机保存、不纳入公开源码或媒体包。

测试分别使用 `tmp` 内独立目录；真实模型和原片只能作为只读来源。各测试证据区分实际主路由、隔离业务、合成逻辑夹具和实际工程，不把前两者计作地理精度验收。

## A 批：可靠性

A 批无数据库 schema 升级，不对正式记录批量回填或重写。历史任务没有条件规则时显示待配置；历史检查读取时计算清单版本，首次有效写入才固定版本；旧地图事件保留 JSON 历史，新事件写入单一 SQLite 问题台账。

| 编号 | 修复与验证内容 | 证据 / 结论 |
|---|---|---|
| A1 | 目标和关联对象共用授权，先授权后 revision；taskIds 未设与空数组不同；跨任务记录、关联、发布、报告和冲突响应 | [后端报告](platform-revision-a-backend.md)；7组202次实际 HTTP 请求通过 |
| A2 | 原清单 ID 完全集合、唯一性、定义不可伪造、版本绑定；已检与通过分开 | 后端 HTTP；实际表单验证独立记录 |
| A3 | 八类开工/完工条件、事务内重验、数量/里程碑/非计量、具体豁免签认、前端原因及跳转 | 后端 HTTP；条件配置操作录像 |
| A4 | 新地图事件和管理问题同一 ID/状态，整改复核回合，受控附件；旧事件只读或明确接管 | [事件说明](platform-revision-a-events.md)；`output/reliability-a/a4-before.json` 与 `a4-after.json` |
| A5 | 当前项目/D/F/筛选绑定统计请求；加载撤旧值、持久失败、重试与拒绝迟到；category 独立且保留中文搜索 | `output/platform-revision-20261009/A/a5-fixed/report.json`，7 项实际主路由检查通过，原行为有独立复现录像 |
| A6 | 任务附件按关联与明确资源权限开放，原件和预览同权，未绑定上传仅本人；全项目瓦片不因此开放 | 后端 HTTP；附件撤权复测 |

A 批验收：全 src/server 回归 278/278，TypeScript 与 Vite 生产构建通过（既有大分包提示保留）。条件/检查主路由 8 项、统计/筛选 7 项与成员范围 4 项实际浏览器交互通过，均零页面异常；录像在 `output/platform-revision-20261009/A/conditions-ui/a2-a3-actual-conditions-and-checklist.mp4` 与 `A/a5-fixed/a5-fixed-actual-interactions.mp4`。正式库 3,822 个 JSON 的 SHA-256 无变化，SQLite 只读逻辑导出与启动备份完全一致；未执行正式迁移。实际 UI 验收使用隔离业务台账，不计作工程精度验证。

### A 批主要接入位置

- `server/management/authorization.ts`、`checkIntegrity.ts`、`taskConditions.ts` 与 `managementStore.ts/domain.ts`：集中权限、清单和准入判断。
- `server/management/eventBridge.ts`、`eventDiscovery.ts` 与 `src/managementEventProjection.ts`：单一问题来源和历史事件适配。
- `src/management/metricsState.ts`、`taskConditionsView.ts` 与 `managementStudio.ts/forms.ts`：请求状态、条件配置/逐项结果、资料类别。
- `src/managementWorkspace.ts`、`safetyWorkspace.ts`、`managementSceneTypes.ts`：原 Viewer 的事件状态和选择同步，常规选择不飞行。

## 分批提交与回退

各批最终 SHA 记录在本轮交付的版本清单。回退代码使用 `git revert <对应批次SHA>` 创建反向提交，先停止服务并备份数据；不使用 hard reset，不删除 SQLite、工程文件或历史报告。回退 B/C 不需要回退 A。A 的新规则、清单版本、事件记录均为增量字段/既有集合，不做数据破坏性降级；回退 A 会恢复原有业务校验缺陷，需保留该限制并重新核验使用范围。

## B / C 验收

A 提交为 `4a2f4426d28209ef89035745e7c3c6d518eec034`。B 结果详见 [工作台验收](platform-revision-b-workbench.md) 与 [布局验收](platform-revision-b-layout.md)：工点全链28项、甘特/真实照片19项、CPU布局18项通过；源码287项通过。C 在 B 独立提交后实施，其精度缺项不由界面、构建或高播放帧率代替。
