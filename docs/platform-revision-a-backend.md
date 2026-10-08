# A 批后端可靠性验收（2026-10-09）

本文件覆盖 A1、A2、A3、A6；A4 见 `platform-revision-a-events.md`。审查基线为 `ad92b1816e4a241f01d9fa3cf230037bed519cd0`。修改在当前源码基础上增量完成，未回退模型、坐标、视频、业务对象或冻结报告。

## 验证层级与证据

- `output/platform-revision-20261009/A/backend-http-report.json`：7 组实际 HTTP 服务测试，隔离 SQLite/真实磁盘附件、真实账号 Cookie 和服务端命令入口。业务内容是明确标记的测试夹具，不是生产项目成果。
- `output/platform-revision-20261009/A/backend-http.log`：各组通过结果。
- `output/platform-revision-20261009/A/backend-http-verified/*.json`：每次 HTTP 路径、方法、状态码及错误码；没有保存账号密码、Cookie 或正式业务正文。
- `output/platform-revision-20261009/A/source-tests.log`、`typecheck.log`：使用项目原有模块加载器的全部 `src/`、`server/` 测试和类型检查。
- 改前隔离 HTTP 复现：`tmp/a-reliability-before.json`。重复普通检查项替代必检项后返回 satisfied=true；受限 A 账号以错误 revision 操作 B 任务收到 409/current/SECRET B；受限账号的 files 权限被整体去掉。这些现已修复。
- 此处没有把 HTTP/CPU 验证当作真实模型画面、GPU 性能或工程精度验收。

## 验收矩阵

| 项目 | 验收输入与预期 | 实际 HTTP 结果 |
|---|---|---|
| A1 目标记录范围 | A 账号读取 B 的任务、资料、版本、技术问题、混合 A/B 记录和附件 | 全部 403，无正文/名称/current 泄漏 |
| A1 冲突顺序 | 已知 B ID + 错 revision，尝试任务修改、资料发布、技术讨论和变更确认 | 授权先于冲突；403，响应无 current |
| A1 关联对象 | A 记录关联 B 图纸、版本、会议、附件；创建 B 巡检 | 全部拒绝；事务无部分写入 |
| A1 查询/导出 | A 账号冻结、读取报告；空任务范围账号读取任务 | 冻结内容仅授权来源；空数组账号任务列表为空且单条读取 403 |
| A1 执行人与指派 | 仅 A 授权人员被指派 B；普通执行人代他人提交问题整改 | 指派范围拒绝；代提交 403/ISSUE_EXECUTOR_REQUIRED |
| A2 ID 完整性 | 两个普通项替代关键项、漏项、未知 ID、重复创建 ID | 400；原检查记录与 revision 不变 |
| A2 定义/版本 | 伪造 required/name/适用规则，错误 checklistVersion | 400 明确反馈；原服务器清单不变 |
| A2 顺序/结论 | 重排后关键项 fail、普通项 pass，再签认/复制 | 保存服务器原顺序；已签认但 satisfied=false；复制不继承结果和签名 |
| A3 历史缺规则 | 未配置 task.conditionPolicy 的任务直接开工 | 409/TASK_CONDITIONS_BLOCKED，逐项状态 configuration-required |
| A3 强制开工条件 | 前置未实际完工、开工检查 draft、资料未发布 | 分项 blocked；普通开工拒绝 |
| A3 当前有效性 | 曾确认资源过期、已发布图纸附件删除 | GET 条件与流转重新核验，均 blocked；恢复真实附件/资源后可处理 |
| A3 工序前置 | policy references 只列 A，但 task.predecessorIds 有 B | 使用并集，不能通过遗漏 B 放行 |
| A3 例外放行 | 普通执行账号提交 exception；有权人员明确签认豁免项 | 普通账号拒绝；有权放行保存规则版本、具体项、理由、依据、证据、签认人与同事务数据版本 |
| A3 完工 | 完工阻断问题未关闭；非计量任务全部适用条件满足 | 前者拒绝；非计量正常开工→申请完工→确认完工可完成，不要求数量字段 |
| A3 数量/质量 | 已确认未来业务日期计量；实际日期修订；数量达到100%但无验收 | 复用统计 effectiveProgress 的 D/F/撤销/替换口径；未来量不算当前完工；计量满足仍不能替代验收 |
| A6 授权附件 | A 执行人实际上传并关联照片/图纸，访问 original/preview | 正常 201/200；文件内容来自受控磁盘；未绑定上传仅上传者可见 |
| A6 越权链接/撤权 | B 账号直接读 A original/preview；A 文件权限撤销后再读旧链接 | 全部403；private/no-store + Vary:Cookie；每次重新核验当前成员权限 |
| A6 模型隔离 | 任务受限账号直接请求完整模型瓦片 | 403；任务附件授权没有打开完整工程目录或模型 |

## 接口与数据契约

### 统一授权

`server/management/authorization.ts` 统一任务范围与引用目标规则；`managementStore.ts` 在异步预核验前、事务执行前及连带保存时核验。`taskIds: undefined` 表示项目范围；`taskIds: []` 表示无任务授权。修改同时核查原对象和新关联。角色权限继续由服务端 Cookie/成员记录推导，客户端身份字段不生效。

全项目 3D Tiles 与附件分离：任务受限成员仍没有 models 权限，但 files/media 按成员明确授权保留。管理员上传而未关联任务的附件不会自动对执行人公开；管理员可以上传时附 `?taskId=...`，或通过授权资料版本/业务记录关联。资源台账也需先明确关联到授权任务后，受限资源人员才可引用。原资料目录不可遍历；外部原件仅对已登记且获授权的精确来源地址开放。

附件消费在事务内同步核查。受控上传检查真实路径、文件大小、SHA；外部资料检查清单地址、实际路径、大小、登记时修改时间及停用标记。显式注入的外部解析器属于可信适配器；测试中的合成解析器不能视作生产磁盘验证。

### 检查清单

- 新建/复制生成 `checklistVersion`，它绑定模板版本、服务器清单 ID、名称、必检属性和不适用规则。
- `check.record`、`check.confirm` 必须提交该 `checklistVersion`，并继续携带正常 `expectedRevision`。
- `check.record.items` 只允许 `id/result/basis/evidenceIds`。结果按服务器清单顺序保存。
- `allowNotApplicable: true` 才允许不适用，且依据必填；新清单默认不允许。
- 旧记录没有 hash 时，查询响应按原保存清单计算 hash，不写数据库、不更改历史。首次有效填报/签认才在新修订中固定 hash。原历史数据本身有重复 ID/无效结果时保留原件并拒绝继续签认，要求重新核实。

### 任务准入

`GET /__management/tasks/:id/conditions?projectId=...` 返回 `TaskConditionsResponse`：任务修订、当前数据版本、policy、start/completion 每项结论、原因和授权关联记录。业务日期按项目时区计算；确认截止使用服务器当前时间。

`task.conditions.configure` 使用正常任务 ID/revision/idempotencyKey，payload：

```json
{
  "taskType": "quantity | milestone | non-quantity",
  "reason": "配置或变更依据",
  "rules": [{
    "id": "稳定规则ID",
    "kind": "predecessors | preconstruction-checks | resources | documents | external-permit | acceptance | blocking-issues | quantity",
    "stage": "start | completion",
    "mode": "required | advisory | not-applicable",
    "referenceIds": [],
    "note": "不适用时必填",
    "basis": "许可依据（适用时）",
    "evidenceIds": [],
    "validUntil": "2026-12-31"
  }]
}
```

八类条件均须显式选择。开工五类、完工三类有固定阶段；非计量/里程碑的 quantity 必须显式标不适用。配置不会自动把缺项判为满足。

`task.start`、`task.confirm-completion` 在写入事务内再次计算条件，避免使用旧前端判断。强制条件未满足返回 `409/TASK_CONDITIONS_BLOCKED`，details 含逐项理由和 blockingIds。

有 `confirm` 权限的身份可在这两个流转命令中提交：

```json
{"exception":{"conditionIds":["明确豁免项"],"reason":"理由","basis":"依据","evidenceIds":[]}}
```

实际签认人取服务端身份，保存在 `task.conditionDecisions`。普通执行人不能自行豁免。规则版本及判断使用的记录修订、数据版本同时冻结；历史报告和原任务版本不会重写。

## 回归更新理由

旧回归中的检查填报/签认补传服务器 checklistVersion；原来依靠“没有准入规则也直接完工”的统计专用测试，改为显式、有依据的隔离例外。受限资源人员原来可引用 owner 未绑定附件的测试改为先显式 taskId 授权。这些修改反映新增安全契约，没有放宽新 guard。

## 数据保护、部署和回退

无需 SQLite schema 迁移：数据库仍为 schema 1；新增策略/hash/决策字段写在正常的新记录修订中。没有扫描写回历史记录，没有操作正式 project-data。测试服务仅使用系统临时目录或项目 tmp 的独立目录，完成后删除隔离库。

部署前按原启动说明停止服务并备份整个管理数据目录（SQLite、WAL/SHM 若存在、management-files），以及原空间/事件 JSON；复制到独立目录验证启动后再安排生产部署。不得覆盖工程模型、视频原件或稳定 ID。

代码回退由根任务在 A 独立提交后记录该 SHA，使用正常 `git revert <A提交>`；不执行 hard reset。新增 JSON 字段原旧版会忽略，但旧版没有本批权限和准入门槛，故回退服务不应继续对现场账号开放写入。若确须业务回退，停服后恢复部署前整套数据库/附件快照，并保留回退前副本供审计；不要仅恢复单个 SQLite 文件而丢失 WAL/附件。

## 尚未作为通过项

本批服务测试不证明真实施工资料内容正确、许可合法性、用户签认的工程判断正确，也不证明模型/视频配准精度。正式历史任务需要项目有权人员配置实际适用条件；系统不会虚构许可、验收或自动把历史数据改成通过。实际运行画面、操作录像、A5 UI 及 B/C 验收由总交付单独提供。
