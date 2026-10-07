# V3 人工定义、模型注册与事件数据契约

本契约对应 V3 实际数据模块，替代 V2 文档中“风险点自动生成告警”的旧行为。V2 磁盘数据可以继续读取；启动、渲染或切换外观不执行迁移写入，不新建正式施工区域、铁路范围、风险点或事件。

## 数据集合及迁移

| 集合 | 文件 | 行为 |
| --- | --- | --- |
| 人工定义 | `safety-spatial.json` | 施工区域、铁路范围和风险点；保留稳定对象 ID、几何、逐点来源与显式关联 |
| 业务事件 | `safety-events.json` | 独立的人工记录或经已有业务适配器核验的导入事件；事件可引用定义 ID，不能创建或修改定义 |
| 原工程资料 | 原 `records/`、`view.json` 和模型/视频文件 | 数据适配与模型注册只读访问，不改原 schema、显示配置、模型矩阵或源文件 |

两个新增文件各有 `version: 1`、整数 `revision`、`updatedAt` 与自己的数组及内部幂等回执。版本号不需要相等。文件不存在时返回空集合，不写默认示例。

原有全部有效 V2 对象继续保留：`Corridor` 铁路、逐点 `pickKind/sourceHeight`、`risk.severity/status/description/observedAt/observationSource/videoId/mediaSeconds` 等字段不删除、不改成另一种来源。旧对象没有 `creationSource` 或模型版本时，不伪造本次模型拾取证据。

V2 原位置与来源不变时允许编辑名称等属性。重绘需要重新取得所有顶点的有效模型表面锚点，显式保存为 V3；旧铁路 Corridor 必须经过用户重新绘制 Polygon，不能通过宽度推算后静默改写。旧 `risk.status` 仅作为历史属性保留，不能进入事件处置流程。`mergeSpatialDataset` 清除历史派生 `spatial-alert:*`，只增加人工节点，不增加事件、不扩展事件时间范围。

新 V3 对象以 `creationSource: "user_drawn_model_surface"` 区分，沿用 `kind: construction-area | railway | risk-point`。施工区域与新铁路范围只允许 Polygon；风险点只允许 Point。名称必填，其他业务字段可选；风险点 `level` 默认为 `unassessed`，允许 `low | medium | high`，不要求填写说明或关联媒体。新增顶层字段包括 `description`、`responsiblePerson`、`lineName`、`riskType`、`createdBy`、`updatedBy`。无现有身份时不补造操作者账号。

`confirmation` 为兼容既有格式保留，界面可以在用户明确点击保存时自动构造 `user-confirmed / geometry-and-description`，无需增加核对复选框。它不代表审批、工程测量或业务验收。

## 模型表面锚点

V3 的每个 `source.vertices[i]` 必须保留：

```ts
{
  pickKind: "model-depth",
  sourceHeight: number,
  sourceRecordId: string,
  anchor: {
    position: { space: "ecef-meters", x: number, y: number, z: number },
    model: { assetId: string, assetVersion: string, coordinateTransformVersion: string },
    provenance: "verified-project-photogrammetry-surface",
    pickedAt: string // 带时区的 ISO 时间
  }
}
```

`geometry` 仍保存原始双精度经纬度与逐点高度；锚点同时保存同一次拾取的真实 ECEF。服务校验两个坐标表达在 WGS84 场景中的差值不超过 0.02 m，并核对来源高度一致。这个阈值用于发现错误字段或坐标表达不一致，不是工程精度承诺。源垂直基准继续记为 `unknown`，不会因使用 EPSG:4979/ECEF 自动变成已验收的高程基准。

模型表面命中由前端严格拾取流程核验；后端核验注册的项目资产、资产版本、变换版本、来源类型、记录编号与坐标一致性。后端不重新进行像素深度拾取，也不能仅凭字符串证明客户端确实点击了模型。地形、椭球、装饰表面或固定高程不能进入新的 V3 定义。旧来源可读，但不升级为已核验模型锚点。

几何沿用边界自交、相邻重复点、至少三个不同顶点、非零面积、经纬度范围及有限数值校验。多边形隐式闭合，不重复存首点。当前容量上限为 500 个定义、每个 1024 个顶点、合计 10000 个顶点、4 MiB 快照与 1 MiB 单次请求；最近删除记录也计入容量。局部平面几何校验用于 100 km 内单个项目，不替代工程测量算法。

## 项目模型注册

`GET /__safety/models` 返回 `ModelRegistryEntry[]`：

```ts
{
  assetId, projectId, name, url,
  kind: "photogrammetry",
  assetVersion, coordinateTransformVersion,
  matrix: number[16],
  coordinateOffsets: { longitude, latitude, height },
  capabilitySource: "project-verified" | "test-registry"
}
```

生产默认白名单只包含当前已核验的 Production_2 记录 `8bc58629-cf26-45de-986e-086479db11a0`。不会把任意 `3D Tiles`，尤其未来 BIM，自动认作倾斜摄影。管理员明确核验后可通过 `CESIUM_SAFETY_PHOTOGRAMMETRY_IDS` 配置逗号或空白分隔的资产 ID。该配置只扩大已核验资产登记，不从模型自动生成人工范围。

注册从 `CESIUM_DATA_DIR` 或默认 `project-data` 内真实项目记录及其本地 `tiles/` 层级读取。已删除记录、缺失记录或没有合规本地模型地址的记录不能注册。读取不扫描用户其他目录、账号配置或访问凭据；模型目录越界或符号链接不作为可靠版本来源。

资产版本由根 tileset JSON 内容与瓦片文件相对路径、大小、mtime 清单计算 SHA-256；变换版本由保存的矩阵和有效坐标偏移计算 SHA-256。显隐、LOD 和 `record.updatedAt` 不参与资产版本。此方式是本地资产变更指纹，未对每个大型二进制瓦片做全内容哈希；不能宣称它是资产防篡改签名。

2026-10-07 只读核验实际 Production_2 时，返回单位模型矩阵和零坐标偏移；一次完整版本计算约 1.29 秒。该耗时是本机样本，不是性能保证。服务每次新建/编辑 V3 定义前重新核对版本，前端还需核对当前真实加载对象及其生效矩阵。

模型缺失返回 `MODEL_UNAVAILABLE`；版本或变换不同返回 `MODEL_VERSION_CHANGED`，原文件、位置与草稿保持。重新定位必须由用户明确操作；不能用新变换重投影旧记录后报告保存成功。软删除和恢复仅改变存续状态，保留原锚点；恢复出的旧版本位置仍须显示为待核对，不自动迁移。

## 人工定义 API 与恢复

`SafetySpatialRepository`：

```ts
load(): Promise<SpatialSnapshot>
loadModels(): Promise<ModelRegistryEntry[]>
upsert(object, expectedRevision): Promise<SpatialSnapshot>
delete(id, expectedRevision): Promise<SpatialSnapshot>  // 可恢复删除
restore(id, expectedRevision): Promise<SpatialSnapshot>
```

`GET /__safety/spatial` 返回包括已删除项的快照。界面用 `deletedAt` 分成当前对象与“最近删除”；场景合并只读取当前项目中 `visible && !deletedAt` 的对象。

`POST /__safety/spatial` 请求仍为 `operation + expectedRevision + mutationId`，操作为 `upsert`、`delete`、`restore`。删除写入服务端 `deletedAt`，恢复去除删除标记，ID、几何、来源和原创建时间保持。删除状态不能通过 upsert 绕过，必须显式 restore。重复旧保存不能复活已删除对象。

编辑保留全快照版本冲突保护；旧来源/位置不变的 V2 属性编辑不伪造模型版本。新建或重绘必须使用 V3 来源。已有对象不能换项目、换类型或降级去掉 V3 来源来绕过校验。成功返回后才更新正式场景；错误保留草稿。

## 独立事件 API

`SafetyEventRecord` 包括稳定 `id/projectId/title`、`severity`、`status: pending | processing | completed`、epoch 毫秒 `occurredAt`、可选说明与位置、可选 `nodeId/spatialObjectId`、`mediaIds`、明确 `source` 及创建/更新时间。不存在位置时保持缺失，不能用项目中心或风险定义位置补造事发坐标。

来源只允许 `manual-record` 或 `imported-event`。新人工事件必须经过明确创建操作，并从 `pending` 开始。导入事件必须有来源记录编号，服务默认拒绝未核验导入；接入已有业务时注入 `validateImportedEvent`，或者提供新的 `SafetyEventAdapter`。演示数据仅在隔离验收环境显式创建，不写正式事件库。

```ts
interface SafetyEventAdapter {
  load(): Promise<SafetyEventSnapshot>;
  create(event, expectedRevision): Promise<SafetyEventSnapshot>;
  complete(id, { description, attachmentIds?, handledBy? }, expectedRevision): Promise<SafetyEventSnapshot>;
}
```

路径为 `GET/POST /__safety/events`。创建请求使用 `operation: create`，保存处理结果使用 `operation: complete`；均含稳定 `mutationId` 与 `expectedRevision`。处理说明必填，附件和处理人可选。服务端保存 `handling.description/handledAt/handledBy/attachmentIds`，原子写入成功后才把状态设为 `completed`。失败保持已确认状态；已完成记录不被重复处理直接覆盖。

人工定义与事件分开计数。创建、修改、删除或恢复定义都不写事件文件；处理事件也不写定义文件。关联对象失效时保留事件历史，不能因此删除事件。无事件是“暂无待处理事件”，不能推断现场无风险。媒体仅通过真实存在的显式编号关联，不能把项目参考原片自动当成事发证据。

## 并发、幂等、隔离与回滚

两套服务都复用单实例串行队列、临时文件写入 + flush + 原子重命名的保存方式；同源请求须有 JSON 内容类型和 `X-Cesium-Library: 1`。各自保存最近 64 条 `mutationId + SHA-256 请求签名` 回执，重启后仍可确认丢失响应的重试。相同编号不同内容返回冲突；旧版本不能覆盖新版本。回执只保证对应保留窗口；窗口外旧请求继续受 expectedRevision 约束。

草稿的对象/事件 ID 在开始编辑时固定；客户端自动重试复用同一次 mutationId。持续断网或响应无法解析时，不提前报告成功，应重新读取确认；重新点击保存也不应生成另一个对象 ID。当前服务是本机单实例持久化，没有新增账户权限系统、跨进程锁或事件审批流程。同一数据目录限一个服务实例管理。

`CESIUM_SAFETY_DATA_DIR` 只隔离人工定义和事件两个文件，原模型库仍按 `CESIUM_DATA_DIR` 读取。验收可读取真实模型背景并把所有操作写到 `tmp/` 的专用目录；不要把验收 fixture 复制进正式库。单元测试通过 `createSafetySpatialStore({modelRegistry: [...]})` 注入明确的测试注册表，不修改正式模型记录。

回滚前停止相关服务，分别备份完整磁盘文件。需要恢复某一集合时使用相应的完整文件，并保留当前文件备份；公共 GET 响应不包含内部回执，不能直接替代磁盘文件。恢复代码、主题或相机不会自动清除人工数据。软删除恢复是日常操作，不要求整库回滚。

验证命令：

```powershell
node --experimental-transform-types --test src/safetySpatial.test.ts server/safetySpatialStore.test.ts server/safetyEventStore.test.ts
npx tsc --noEmit
```

测试覆盖旧格式无损读取、V3 默认待评估和可选说明、模型 ECEF/高度一致性、自交与来源校验、真实模型版本指纹、过期版本拒绝、软删恢复、事件与定义独立、处理失败不变、并发冲突、重试幂等、跨站拒绝和损坏文件保护。这里只说明数据层验证；实际模型拾取、19 状态界面、视频播放、交互录像与 GPU 性能由完整应用验收提供证据。
