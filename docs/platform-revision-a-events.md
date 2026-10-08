# A4 地图事件与管理问题一致性

实施基线：`ad92b1816e4a241f01d9fa3cf230037bed519cd0`。本文覆盖 A4 的后端与共享读模型，提交 SHA 由 A 批总验收记录填写。

## 权威记录与兼容范围

正式平台 Vite 的 management 插件截获 `/__safety/events`。新地图事件直接执行管理命令，只有 `management.sqlite` 中的 `issues` 记录、版本、审计和幂等回执发生同一事务提交。此路径不创建或更新 `safety-events.json`，不存在两次跨存储写入等待补偿的窗口。

地图与管理列表共享同一 issue ID、revision 和完整 `issueStatus`。地图旧三态 `pending/processing/completed` 仅作显示投影；只有 `closed/false-positive/duplicate` 对应结束显示，待复核绝不投影为完成。正常流程为待核实 → 指派整改 → 待复核 → 退回整改或通过关闭。

旧 JSON 作为历史来源只读保存。未接入的事件标记 `lifecycle=legacy-readonly`，保留原 ID、原状态、原处理记录及原来源，不能解释成已经历管理复核。已明确接入的历史事件使用原 ID 创建 issue，`discovery.legacySnapshot` 保存原事件完整快照，新 issue 从待核实开始，`rounds=[]`。地图按 ID 去重。普通任务受限账号不能枚举旧历史，也不能仅凭旧 ID 获取或接入来源未核验任务归属的旧事件。

独立旧事件存储模块保留旧单元测试和独立适配器兼容能力，但正式平台的该 HTTP 路径不再进入其写方法；旧存储也拒绝伪造 `management-issue` 来源。未配置管理插件的独立旧宿主不属于这次新流程接入范围。

## 来源与权限

- 模型来源必须引用服务器读取的用户空间对象；保存空间对象修订、引用摘要和几何来源快照。点对象位置从已保存几何取值，不接收客户端坐标冒充核验位置。获取完整模型几何需要独立 `models` 权限，任务受限账号不能借已知空间 ID 绕过模型授权。
- 录像来源引用已保存、已授权的 evidence，绑定录像源记录 ID、媒体时间和 evidence revision。传入不同媒体时间或不一致任务关联会被拒绝。本项记录媒体来源，**不证明视频像素配准精度**。
- `checkId` 自动保存检查发现快照及检查修订，即使客户端没有额外填写 discovery。检查或录像证据已有任务关联时，必须与问题任务关联相容。
- 附件由统一管理权限与存储核验处理；已上传原件校验真实文件、路径、大小和 SHA；外部资料依据真实清单、路径及保存的文件状态核验。创建后源文件丢失、失效或无权访问不能继续作为新问题证据引用。
- 整改提交与复核分别执行服务端角色规则。客户端传入身份、隐藏按钮或地图状态均不决定权限。

## HTTP 接口

所有写操作仍要求当前服务端会话、同源请求和 `X-Cesium-Library: 1`，JSON 请求体。

| 接口/操作 | 含义 |
| --- | --- |
| `GET /__safety/events` | 返回当前授权 issues 的地图读模型，以及有权查看的只读旧事件 |
| `POST /__safety/events`, `operation=create` | `event.id` 保持为 issue ID；`mutationId` 转成稳定幂等键；事件要求人工来源、初始待处理。可携带 taskId/taskIds/evidenceIds、正式空间对象 ID；录像需 payload.mediaEvidenceId |
| `operation=assign/start/submit/review/dismiss/reschedule` | 转同名 `issue.*` 命令；携带 `id`、`expectedIssueRevision`、`mutationId`、`payload`。使用单条 issue 修订，避免将全项目快照修订错当成对象版本 |
| `operation=complete` | 返回 `409 MANAGEMENT_REVIEW_REQUIRED`，不再允许旧处理按钮直接关闭 |
| `operation=adopt-legacy` | 全项目有复核权限人员明确接入旧 ID；可指定任务，保存完整旧历史并启动新流程。不会伪造旧复核或把旧附件字符串升级为新有效证据 |
| `POST /__management/commands`, `issue.*` | 原管理入口不变；同一权威记录、授权、修订、事务及幂等逻辑 |

幂等回执与 issue 一同提交。断线重试或重启后重发相同请求只返回已提交结果，不会再次生成 issue；同一幂等键变更内容会被拒绝。失败事务保持原 issue 状态。

## 实际验证矩阵

实际测试由 Node HTTP server 串接正式 `management.accessMiddleware → management.middleware → legacy.middleware`，调用真实 HTTP 入口。业务 SQLite、旧事件、上传文件、导入清单均位于 `tmp/reliability-a4-http/`，不修改正式项目台账。

| 项目 | 修复前 | 修复后 | 证据 |
| --- | --- | --- | --- |
| 地图直接关闭及不存在附件 | HTTP 200/completed；管理 issues 数为 0；不存在附件字符串被保存 | complete 返回 409；不存在附件返回 404；状态不变 | `output/reliability-a/a4-before.json`、`a4-after.json` |
| 单条权威记录/地图同步 | 地图与管理分别保存 | 地图创建后管理只有同 ID 的一条 issue；逐步比对两端完整状态一致 | `a4-after.json` |
| 指派、整改、退回、再提交、通过 | 旧处理直接结束 | 两轮真实 HTTP 操作保留两个整改轮次，首轮退回、次轮通过；执行账号尝试复核返回 403 | `a4-after.json` |
| 附件权限 | 旧接口只检查字符串 | 无权任务附件返回 403；已注册后删除上传原件或视频源文件均拒绝新引用 | `a4-after.json`、`a4-discovery-after.json` |
| 幂等与恢复 | 独立旧 JSON 回执 | SQLite 重开后同一请求仅保留一条 issue；变更请求内容返回幂等冲突 | `a4-after.json` |
| 旧事件 | 原状态可能被误解成管理复核完成 | 保留旧完成状态和处理记录；明确接入后同 ID、无虚构复核；旧 JSON 字节完全相同 | `a4-after.json` |
| 发现来源 | 缺少统一检查/录像/空间来源快照 | 保留空间修订、检查版本、录像 ID/时间；拒绝客户端坐标、伪造时间、错任务与无来源 | `a4-discovery-after.json` |

最近一次记录：A4 生命周期组 34 次真实 HTTP 请求，发现来源组 14 次请求，均通过。两组使用存储/空间逻辑夹具，录像源 fixture 只验证文件存储与关联路径，**不是可播放原片或真实 GPU 场景精度证据**。根任务负责另行录制实际平台工点交互，不能用本测试替代其录像。

运行命令：

```powershell
& 'F:/Node.js/node.exe' --experimental-transform-types --test server/management/eventBridge.http.test.ts server/safetyEventStore.test.ts
& 'F:/Node.js/node.exe' node_modules/typescript/bin/tsc --noEmit
```

本次上述事件测试 7/7 通过，类型检查通过；不据此宣称完整平台或三维精度验收已通过。

## 修改位置与数据回退

- `server/management/eventBridge.ts`：只读历史适配、地图命令转换、权威状态投影。
- `server/management/eventDiscovery.ts`：事务内来源、权限、任务关联与历史接入核验。
- `server/managementStore.ts`、`server/management/domain.ts`：接线、同事务执行、共享权限和真实附件核验。
- `src/managementEventProjection.ts`：前后端共享纯读模型。
- `src/safetyEventTypes.ts`、`src/safetyEventValidation.ts`：完整问题状态、版本、来源字段。
- `server/safetyEventStore.ts`：防止独立旧存储伪造管理来源。
- `src/managementWorkspace.ts`、`src/safetyWorkspace.ts`：授权快照投影、场景选择与管理详情联动，由根任务实施。
- `server/management/eventBridge.http.test.ts`：隔离实际 HTTP 验证。

无需重写旧 JSON 或迁移数据库结构。部署前按平台备份步骤关闭服务并备份完整管理数据库及附件目录；代码回退使用 A 批提交的反向提交，保留新增 issues 与历史版本。旧代码不能将新增 issue 自动恢复到旧地图 JSON，因此回退后不能把地图缺少新 issue 误判为数据删除，也不得用旧 JSON 覆盖管理数据库。需要恢复部署前业务快照时，应明确选择备份及期间新增数据的保留方案，并先在副本验证。
