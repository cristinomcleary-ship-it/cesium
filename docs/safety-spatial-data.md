# V2 人工空间对象数据契约（历史记录）

> V3 当前契约见 [safety-spatial-v3-data.md](safety-spatial-v3-data.md)。下文保留 V2 实施记录；其中风险点自动派生告警、铁路中心线新建与删除语义已被 V3 替代。V3 读取旧对象并保留真实来源，不自动产生事件。

本模块为现有平台增加人工空间对象，使用同一个 Cesium Viewer 和原有资料库。入口为 `src/safetySpatialTypes.ts`、`src/safetySpatialValidation.ts`、`src/safetySpatialRepository.ts`、`src/safetySpatialData.ts` 与 `server/safetySpatialStore.ts`。既有 CAD、模型、视频、投影参数和 `records.json` / `view.json` 不写入本模块的保存操作。

## 对象及来源

| 对象 | 几何 | 业务含义 |
| --- | --- | --- |
| `construction-area` | `Polygon` | 用户绘制并确认的施工展示范围，尚不代表正式审批红线 |
| `railway` | `Corridor` 或 `Polygon` | 用户界定的铁路参考范围，尚不代表实测营业线边界或法定限界 |
| `risk-point` | `Point` | 用户选取的风险位置、风险等级与说明，尚不代表自动检测或现场验收结论 |

所有用户对象的来源为 `user`，不混写成 `real` 或 `demo`。用户确认 `geometry-and-description` 只确认当前几何和描述，不是审批签章，也不赋予测量精度。既有真实资料、推导分组与演示事件继续使用各自的来源标记。

每个对象保留独立 `id`、`projectId`、`createdAt`、`updatedAt`、`visible` 和用户确认时间。对象 ID 仅允许字母、数字、下划线、连字符；不使用文件名作为对象保存路径。后端每次修改只更新一个对象，不以客户端全量清单覆盖其他页面的修改。

`source.vertices` 与几何顶点一一对应，记录 `model-depth`、`terrain`、`ellipsoid` 或 `manual` 来源及 `sourceHeight`；能取得时保留原资料记录 ID、实体索引。经纬度采用十进制度，高程和铁路宽度以米计。场景坐标记为 EPSG:4979，但**源数据的高程基准仍为 unknown**；该声明不能替代垂直基准转换或工程测量验收。模型深度拾取不等同于已识别 BIM 构件。

多边形顶点数组不重复首点，渲染时闭合。铁路 `widthMeters` 是中心线两侧合计总宽度。几何校验拒绝无效数值、重复相邻点、自交、零面积及超过当前项目范围的几何。当前上限为每对象 1024 个顶点、500 个对象、合计 10000 个顶点、单次请求 1 MiB、公共快照约 4 MiB；100 km 范围检查用于本地平面校验的适用范围，不作为测量结果。

## 唯一编号和业务联动

`linkedNodeIds` 引用现有工程节点 ID；`linkedMediaIds` 引用现有媒体 ID。`areaId`、`railwayId` 引用人工空间对象的原始 ID，不添加 `spatial:` 前缀。关系按编号解析，不根据同名、距离或列表顺序猜测。

合并进业务数据时：

- 场景/导航节点 ID 为 `spatial:<对象ID>`，风险告警 ID 为 `spatial-alert:<对象ID>`。
- 施工区域和铁路参考范围位于项目下；风险点位于关联且显示中的施工区域下，否则位于项目下。
- 风险节点不设置 `componentType`，不会伪装成桩基、墩柱或 BIM 实体。
- 工程对象、施工区域、铁路关联的名称和唯一编号写入节点与告警详情。有效媒体仅来自显式关联的现有媒体 ID。
- 隐藏、删除或失效的关联在详情和 `sourceNotes` 中提示；不自动寻找替代对象。风险自身的位置和描述保留。
- 不同项目与隐藏对象不混入当前项目的业务列表、告警和统计。
- 人工铁路范围由独立空间渲染管理，不覆盖 `SafetyDataset.railway` 的正式数据来源。

`mergeSpatialDataset(base, snapshot)` 是纯合并入口。调用方应始终传入原始适配器快照 `base`，不能反复把上一版合并结果当成原始基线；这样删除/隐藏风险后，时间范围能够正确恢复。原始工程对象与数据集不会被修改。

## 事件时间与视频时间

风险 `observedAt` 为 epoch 毫秒，`mediaSeconds` 为视频文件内秒数，二者不能互相替代。`observationSource` 区分：

| 来源 | 时标与媒体处理 |
| --- | --- |
| `field-entry` | 现场人工录入时间。禁止附带 `risk.videoId` / `risk.mediaSeconds`，不自动跳转历史视频。可显式关联视频作为项目参考，但详情明确其未经事发画面核验。 |
| `replay-review` | 必须明确关联 `videoId` 与非负 `mediaSeconds`，该视频也须存在于 `linkedMediaIds`。仅在媒体存在且视频轨迹时间对应通过核对时，才向告警提供自动定位视频时间。 |

纯函数 `spatialReplayTimeAt(track, mediaSeconds)` 根据原始轨迹中 `time` 与 `mediaSeconds` 的对应关系做时间内插：要求双时间轴有限且严格递增，不外插；跨 `segment` 断段的中间时间不映射。该函数不生成坐标、不平滑飞行线，也不证明视频里已拍到选中对象。

事件时间必须与该映射结果相差不超过 `SPATIAL_REPLAY_TOLERANCE_MS = 50` 毫秒。此容差约为 30 fps 的 1–2 帧，仅用于识别绑定时标是否一致，不是相机同步或配准精度指标。保存回放风险时，调用方应从同一次采样的视频秒数计算事件时间，避免混用异步更新的界面时钟。超范围、时标倒退、断段、视频失效或事件时间不一致时，保留风险记录并明确提示，告警不提供自动视频跳转字段。

人工风险的时间会扩展项目 `timeExtent`，让列表、统计与时间筛选可以查看该记录；扩展时间范围不向已有无人机轨迹外插位置，也不将现场记录改写为历史飞行事件。媒体关联与时标校验不代替无人机配准、照片取证或正式整改验收。

## 同源 API

Vite 插件为 `safetySpatialPlugin({ dataDir? })`，开发和预览服务均注册 `/__safety/spatial`。

读取：

```http
GET /__safety/spatial
```

响应：

```json
{"version":1,"revision":0,"updatedAt":"1970-01-01T00:00:00.000Z","objects":[]}
```

保存或编辑单对象：

```ts
await repository.upsert(object, snapshot.revision);
// 请求体：{ operation: "upsert", object, expectedRevision, mutationId }
```

删除单对象：

```json
{"operation":"delete","id":"risk-example","expectedRevision":3,"mutationId":"2f792f2a-285e-4913-b722-8a4e2f41a108"}
```

修改使用 `POST`，携带 `Content-Type: application/json` 与 `X-Cesium-Library: 1`；拒绝跨站 Origin、不支持的方法及超限请求。服务定位为本机 Vite 开发/预览环境，尚未实现多人账户身份、审批权限或跨进程锁；同一数据目录应只由一个服务实例管理。

客户端 `SafetySpatialRepository` 提供 `load()`、`upsert(object, expectedRevision)`、`delete(id, expectedRevision)`。成功返回完整校验后的新快照；失败抛出 `SafetySpatialError`，可读取 `code`、HTTP `status`、`mutationId`，版本冲突时还可读取最新 `snapshot`。界面须在成功响应后才显示保存完成，网络错误时保留草稿。

| 状态/代码 | 含义 |
| --- | --- |
| `400 VALIDATION` | 对象、几何或快照格式不符合契约 |
| `409 REVISION_CONFLICT` | 其他页面已更新，应先读取新版本，不能直接覆盖 |
| `409 MUTATION_ID_REUSED` | 同一个请求编号被用于不同内容 |
| `404 OBJECT_NOT_FOUND` | 要删除的对象已不存在 |
| `500 STORAGE_CORRUPT` | 磁盘文件损坏或版本不兼容；保留原文件、拒绝覆盖 |
| `NETWORK` / `INVALID_RESPONSE` | 客户端尚无法确认保存结果，应读取恢复状态 |

## 保存、并发与幂等

数据目录优先级为插件 `dataDir` → 环境变量 `CESIUM_SAFETY_DATA_DIR` → 项目根目录下 `project-data`。文件名固定为 `safety-spatial.json`。文件不存在时返回空快照，不自动生成测试对象。

每个服务实例串行处理修改：读取当前快照，核对 `expectedRevision`，完成单对象修改，校验完整快照，然后写入随机 `.pending` 文件、flush、关闭并原子重命名。成功后 `revision` 增加 1。创建时间由服务器建立并在编辑时保留，更新时间由服务器记录。失败不会把不完整 JSON 当成正式快照。

客户端每次逻辑修改创建一个 `mutationId`；响应丢失时只重试同一编号和同一请求内容。磁盘文件另含最近 64 条请求编号与 SHA-256 签名回执。重放相同请求返回当前快照，不重复增加版本；相同编号但不同请求返回冲突。回执在服务重启后仍有效；超出回执窗口的旧请求仍受旧 `expectedRevision` 约束，不会静默覆盖新版。

并发页面中只有一个相同基线版本的修改能成功，另一个收到带最新快照的冲突响应。未实现自动合并审批；调用方保留草稿并让用户在最新状态上重新保存。恢复已删除对象必须是新的明确保存操作，不能靠重发旧请求复活。

## 隔离验收与回滚

自动化验收使用独立空间对象目录，例如：

```powershell
$env:CESIUM_SAFETY_DATA_DIR = 'F:\codex\cesium\tmp\safety-spatial-acceptance'
npm run dev -- --host 127.0.0.1
```

此变量只改变新增人工标绘数据的位置，不改变原资料库、模型与视频路径。测试可读取真实工程背景，同时把所有创建、编辑、删除写入隔离目录。重新启动正常服务前清除该进程环境变量；切换环境变量需要重启服务。单元/API 测试在 `tmp/safety-spatial-tests` 下建立独立实例与临时目录，不依赖用户已保存的空间对象。

针对性验证命令：

```powershell
node --experimental-transform-types --test src/safetySpatial.test.ts server/safetySpatialStore.test.ts
npx tsc --noEmit
```

覆盖几何与来源校验、真实数据不变、唯一编号关联、现场与回放时标区分、时标不一致不跳视频、保存后新实例恢复、并发冲突、重试幂等、删除后旧请求不复活、跨站请求拒绝、损坏文件保护及失败后队列继续可用。界面点击、录像、模型/视频性能及多分辨率结果以当次浏览器验收记录为准，不能仅凭这些数据层测试认定通过。

回滚前先停止使用该数据目录的服务，备份完整 `safety-spatial.json`；恢复时复制先前的完整磁盘文件，然后重新启动并读取确认。公共 API 快照不含内部 `mutations` 回执，不能直接用 GET 响应替换磁盘文件。回滚操作会改变人工标绘快照，应保留当前文件以便恢复。回退前端代码不会自动删除此文件，也不需要修改原资料库数据。

尚需正式接入的数据包括已审批施工红线、营业线实测中心线/范围及限界规则、正式 BIM 构件编号和源坐标/高程基准、风险业务编号与审批整改接口、已核验的事件照片/视频取证关系。人工绘制提供可追溯的输入通道，不冒充这些正式资料已经齐备。
