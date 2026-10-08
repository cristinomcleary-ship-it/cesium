# 本机项目统筹 API v1

持久层：Node 24 内置 SQLite，`CESIUM_MANAGEMENT_DATA_DIR || CESIUM_DATA_DIR || project-data` 下 `management.sqlite`，`PRAGMA user_version=1` 为首次增量迁移。记录、修订、审计、幂等回执同事务保存；原资料库、三类空间、模型和录像文件均不迁移、不生成样例。附件放独立 `management-files/`。生产备份应停止服务后一起备份 SQLite 与附件；不能只复制正在写入的主库而遗漏 WAL。

所有请求同源。非 GET 使用 `X-Cesium-Library: 1`。命令 Content-Type application/json。

- `GET /__management/session?projectId=safety:project`：服务端身份与权限。
- `POST /__management/session`：`{username,password,projectId}`；HttpOnly、SameSite=Strict 会话 cookie，8小时。
- `DELETE /__management/session`：退出。客户端 role/header 永不赋权。
- `GET /__management/state?projectId=...`：ManagementSnapshot，所有 collections 始终存在，无记录为空数组。
- `GET /__management/records/:collection/:id?projectId=...`：校验项目和任务授权。
- `GET /__management/metrics?projectId=...&D=YYYY-MM-DD&F=带时区ISO`：同口径统计；`taskId/areaId`可重复，ownerId/status/query可选。
- `POST /__management/commands`：`{projectId,type,id?,expectedRevision?,idempotencyKey,payload}`；返回最新完整snapshot。新建expectedRevision为0或省略，已有记录必须给当前revision。幂等键每个逻辑操作只生成一次，失败重试复用；变更payload必须换新键。409返回code/current/details，UI保留草稿。
- `POST /__management/upload?projectId=...&name=...`（`uploads`别名）：raw File/Blob，Content-Type实际类型，最大100MiB。返回evidence记录（不是snapshot）：id,name,status ready,url,sha256,size,mime。没有真正落盘的附件不能提交。
- `GET /__management/files/:evidenceId/original?projectId=...`，`preview`同权限。原文件、预览、旧模型API及子瓦片均经过前置accessMiddleware。

无账号时，仅loopback socket + localhost/127.0.0.1 Host允许明确“本机所有者”初始化。首个member.save必须roles包含owner，用户名英文数字._@-，密码至少10字符，成功后自动登录。此后无cookie、换hostname、删除cookie都需重新登录；过期或受限cookie不会回退owner。远程从不允许无身份owner。这是本机账号系统，不是企业认证。服务器拒绝从 `/project-data`、`/@fs/` 等路径绕过受控附件服务。

## 命令最小字段

所有记录id由服务端生成，客户端也可在命令顶层给稳定UUID。payload中的id/status/revision不能覆盖服务器属性。字段名如下，必填写在前。

| 命令 | payload |
|---|---|
| project.create | id,name；可选isTest,horizontalCrs,verticalDatum |
| project.update | name/horizontalCrs/verticalDatum/workingDays（0日…6六） |
| member.save | username,displayName,roles[]；首建password；可选active,resourceAccess:{models,files,media},taskIds[]（省略为完整项目，空数组为无任务） |
| wbs.create/update | name；parentId,areaIds,description |
| task.create | name；ownerId,wbsId,planStart,planEnd,areaIds[],predecessorIds[],targetQuantity,unit,weight,milestone,description |
| task.update | 修改字段；已发布任务必填reason（计划版本递增，基线不变） |
| task.publish/start/request-completion/confirm-completion | 无额外字段；publish校验owner及日期 |
| task.cancel | reason |
| task.forecast | forecastEnd,reason |
| baseline.create | name,taskIds[]；reason可选；保存当前已发布任务的固定计划、量与权重 |
| baseline.approve | 无；批准后不可覆盖 |
| commitment.create | taskId,weekStart,originalDueDate,targetQuantity,unit,basis:'incremental'或'cumulative',criterion；name可选 |
| commitment.publish | 无；冻结原分母 |
| commitment.change | action:'reschedule'或'cancel',reason；改期dueDate，原期限/目标不变 |
| progress.create | taskId,quantity,unit,businessDate,shift,crew,measurementKey；explanation,evidenceIds[] |
| progress.revise | 同create计量字段（task由原条目固定），reason；新revision待确认时旧确认值仍有效 |
| progress.submit/confirm | 无 |
| progress.return/revoke | reason |
| dailyLog.create | taskId,businessDate,progressEntryIds[]；description,evidenceIds[]（只引用，不再次记账） |
| check.create | name,taskId,businessDate,items:[{id,name,required}]；purpose:preconstruction/quality/safety/acceptance（默认preconstruction）,shift,inspectionObjectId,templateVersion |
| check.copy | sourceId,businessDate；name,taskId,shift可选；不继承结论证据签认 |
| check.record | items:[{id,result:'pending'/'pass'/'fail'/'not-applicable',basis,evidenceIds}]；不适用必填basis |
| check.confirm | 无；所有项目非pending才确认，不通过仍已检但satisfied=false |
| issue.create | name,kind:'quality'/'safety'/'coordination'；taskId,taskIds,checkId,riskPointId,evidenceIds |
| issue.assign | ownerId,dueDate；仅首次赋originalDueDate |
| issue.start | 无 |
| issue.submit | description,evidenceIds[] |
| issue.review | passed:boolean,reason；evidenceIds可选；退回保留全部rounds |
| issue.dismiss | disposition:'false-positive'/'duplicate',reason；重复时duplicateOf |
| issue.reschedule | dueDate,reason；原期限不变 |
| inspection.create | name,ownerId,dueDate；scheduledDate,taskId,taskIds,areaIds,planId |
| inspection.record | result,evidenceIds[] |
| inspection.confirm | 无；已保存结果及有效证据缺一不可，上传不自动完成 |
| resource.create/update | name,kind:'crew'/'equipment'/'material'/'auxiliary'/'test'；specification,unit,quantity,ownerId,locationDescription,qualificationEvidenceIds[],validUntil,availability；update另reason |
| need.create/update | taskId,name,kind,dueDate；quantity,unit,resourceId,ownerId,required,coordinationNote；update另reason |
| need.confirm | basis；材料/辅材batchId，其他resourceId；evidenceIds[]；服务端核验验收/检验/数量/有效期，不接受直接ready |
| allocation.create | resourceId,taskId,startsAt,endsAt（带时区）；ownerId；冲突409返回已占用任务 |
| allocation.cancel | reason |
| batch.create | name,batchNumber,unit；resourceId,locationDescription |
| batch.receive | quantity,businessDate；evidenceIds[]；重新进入待验收，可用量不会随到货直接增加 |
| batch.accept | passed:boolean,basis；evidenceIds[]；验收与试验分开 |
| test.create | name,businessDate,batchId或taskId；result:'pending'/'pass'/'fail',validUntil,evidenceIds[] |
| test.confirm | result:'pass'/'fail',evidenceIds[]（至少一份真实报告） |
| material.issue/return/correct | batchId,taskId,quantity,businessDate；reason（correct必填）,evidenceIds[]；独立可审计流水 |
| document.create | name,category；code,taskIds[] |
| document.version | documentId,evidenceId（已上传附件）,revisionNote；taskIds[] |
| document.submit | reviewerId,dueDate；命令id为documentVersion id |
| document.return | reason；id为version id |
| document.publish | basis；id为version id；发布后旧版保留为superseded |
| document.void | reason；id为version id |
| document.requirement | name,dueDate；taskId,ownerId,category |
| document.fulfill | versionId；id为requirement id，仅published版 |
| link.create | taskId或anchorId,targetKind:'documents'/'documentVersions'/'evidence'/'technicalQueries'/'issues'/'actions'/'anchors',targetId |
| link.remove | 无；id为link id，移除关联不删原文件 |
| technical.create | name,ownerId,dueDate；taskId,taskIds[],documentVersionId,evidenceIds[] |
| technical.comment | text；evidenceIds[]，不形成正式答复 |
| technical.answer | answer；evidenceIds[]，此时仍待发布 |
| technical.publish | 无；正式答复不改计划或基线 |
| change.create | name,reason,taskIds[]；technicalQueryId,impacts,evidenceIds[] |
| change.confirm | basis；批准变更也不直接覆盖其他台账，应分别办理计划和资源调整 |
| meeting.create | name,businessDate,minutes；taskIds[],evidenceIds[] |
| action.create | name,ownerId,dueDate；taskId,meetingId,issueId |
| action.complete | result；evidenceIds[] |
| evidence.register | 原资料引用：recordId,fileKey；taskId,mediaSeconds。截图取证：fileId（已上传PNG）,sourceRecordId,mediaSeconds；mediaId必须匹配video:sourceRecordId |
| anchor.create/update | name,purpose:'document'/'quality',anchor:现有ModelSurfaceAnchor,position:{longitude,latitude,height}；taskId；服务器复核模型三版本和ECEF/LLH，不写三类空间表 |
| bookmark.create/update | name,camera:{position:[x,y,z],direction:[x,y,z],up:[x,y,z],models:[{assetId,assetVersion,coordinateTransformVersion}]}；layers,filters,selection,viewMode |
| monitoring.create | name,unit,sourceDescription,validForSeconds；taskId；初始未接入 |
| monitoring.record | value,sampledAt,quality:'valid'/'invalid'/'disconnected',source；receivedAt服务器给出 |
| monitoring.threshold | low或high,basis；evidenceIds[]；确认版本递增 |
| report.freeze | name,D,F（带时区）；filters:{taskIds,areaIds,ownerId,status,query},template（weekly/plan/quality-safety/resource/documents） |
| report.publish | managerComment可选；id为冻结报告，原D/F/结果/引用修订不可覆盖 |

角色标签及类型见 `src/managementTypes.ts`。权限不是表单字段；会话实时读取数据库成员职责。旧资源接口仅绑定当前真实工程项目；跨项目的新任务可以建立，未接入的模型/区域不自动复制。配置资源受限或任务范围受限的身份，其模型、原文件和预览必须按服务器结果展示受限空态。


## 空间对象修订与历史来源绑定

原 `SpatialSnapshot.revision` 继续作为整个空间台账的并发锁；每个 `SpatialObject` 另有可选 `revision`。新建对象由服务器赋 1，每次成功 upsert、明确删除、明确恢复各递增一次（包括仅修改名称/描述的保存）。同一 `mutationId` 重试、失败、冲突和读取均不递增。客户端传入的对象修订号被忽略，不能指定、跳号或回退；持久文件中存在的修订号必须为正安全整数。

历史对象不批量补号或改写。无 `revision` 的对象在界面标为“历史未编号”，首次有效变更才设为 1；其他未编辑对象保持原字段、坐标及来源。编号表示对象记录及其几何/来源组合的保存修订，不表示每次都改变几何。

管理模块服务器解析空间关系时捕获 `reference`：`kind:'spatial'`、`id`、`projectId`、`revision`（历史未编号为 null）、`revisionStatus`、`ledgerVersion`、`ledgerRevision`、按键排序后计算的 `geometrySha256` 与 `sourceSha256`。直接读原台账时，台账版本与几何来自同一份读取内容；自定义服务器适配器未提供台账身份时保留 null，不捏造版本。关系记录的 `spatialReferences` 和问题的 `positionSnapshot.reference` 保留该绑定，后续移动风险点不改历史问题位置。

报告冻结采用确认截止 F 对应管理记录内已捕获的空间绑定，另汇总在报告 `spatialReferences`；不得为历史 F 重新读取当前空间位置并冒充旧位置。功能上线前尚未捕获关系的旧管理记录不自动回填历史证据。读取与保存管理引用不写原空间 JSON。

兼容验证：`tools/verify-management-spatial-revisions.mjs` 使用隔离的真实 HTTP 与 SQLite，覆盖旧对象不迁移、客户端修订伪造、移动后事件隔离、D/F 旧绑定、删除恢复和幂等。证据为 `output/platform-management/spatial-revision-http.json`，不代表实际模型取点或 GPU 精度验收。


默认原资料适配器已接到 `server/management/libraryEvidence.ts`，`managementPlugin()` 不需要另传回调才能登记原片截图。它只读 `libraryRoot/records/{recordId}/record.json` 中已提交的准确文件槽位，核查所属项目、记录身份、未删除状态、视频类型、受控 URL、实际路径归属和字节大小；不会读取载荷中的任意 URL 或文件路径，也不会修改原片。未持有对应 files/media/models 授权的身份返回 403，适配器不授予权限。显式提供的服务器适配器仍优先用于其他已核验资料源。

截图的 HTTP 上传成功码为 201；随后 `evidence.register` 使用返回的 fileId、原 sourceRecordId 及媒体秒，完成登记返回 200。仅上传成功不等于登记已完成。


## 人员实际到场与设备实际投入

`resourceUsage` 独立记录用户填报的实际发生情况，不能从 `allocations` 计划安排、资源静态数量或 `need.confirm` 准备确认推导生成。新库此集合为空。

- `usage.create`：必填 `taskId,resourceId,quantity>0,unit,businessDate(YYYY-MM-DD),startAt,endAt`（均含时区 ISO）、`description`；选填 `name,allocationId,evidenceIds[]`。资源必须是 `crew` 或 `equipment`，服务器从该资源读取类别；实际结束须晚于开始且不晚于登记时间。可跨实际班次，业务日期由登记人明确填写。选填计划必须属于同任务、同资源，实际数量和起止时间独立录入，不继承计划。
- 保存生成 `status:'recorded'`、服务器 `recordedAt/recordedBy`、资源及计划来源修订，表示人工登记待确认，不表示已到位审核或质量验收。
- `usage.confirm`：使用记录 `id,expectedRevision`，必填 `basis`，选填补充 `evidenceIds[]`；服务器复核任务范围、关联和所有证据后改为 `confirmed`，记录可信 `confirmedAt/confirmedBy`。数量、时间、原说明不可通过确认载荷覆盖。
- 两命令均需服务器 `resource` 权限，沿用 SQLite 事务、修订、审计和幂等回执。确认不会更改计划、资源准备状态、材料数量或任务工程量；现有资源准备率不掺入这组独立实际记录。确认前后均保留原输入，正式报表冻结按 F 捕获对应记录修订。

这是一条用户实际登记与确认流程，未接入外部考勤、设备遥测或自动计量服务。


首页 `/__management/metrics` 的 `dashboard` 固定返回 `confirmed-progress`、`delayed-tasks`、`unready-resource-tasks`、`pending-coordination` 四项；原 `metrics` 十项专题口径保留。总体进度复用同请求的有效基线加权指标；其余依次为 D 之前计划到期且 F 时未完成的已发布任务、D 至 D+7 天及逾期必需需求未确认的未完成任务（按任务去重）、F 时仍开放的协调 `actions`。不把技术问题、事件和行动混合重复计数。任务筛选存在时，未关联任务的协调行动不计入。

这四项使用同一权限范围、任务筛选与 `record_versions` 的 F 历史版本；`detailIds` 精确列出被统计对象，延期/未齐对应 tasks，待协调对应 actions。D 是业务到期边界，F 决定当时已知状态；不会用当前未确认/已确认状态覆盖历史 F。未配置基线时总体百分比保持 null，其余无适用记录计 0。
