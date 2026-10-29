# 机械传感器接口与测试

适用于吊机、桩机、挖机的现有参数化模型。传感器接口默认关闭。先在“施工机械”中设置并保存初始位置、尺寸和姿态，再选择需要与回传关联的参数。

## 页面测试（不需要传感器）

1. 启动项目 `npm run dev`，打开平台，选择已有机械；新机械须先“保存到资源”。
2. 展开机械编辑面板中的“传感器参数关联”。需要按新角度约定初始化时，先用其中的“按接口角度设置初始姿态”入口输入整机方位和吊臂相对回转角，应用后保存到资源。然后勾选需要更新的参数，例如吊机的臂长、仰角、吊臂回转角。测试来源填 `browser-sim`，源字段使用对应默认名称，倍率为 1、偏移为 0。
3. 启用关联，点击“开始模拟”。模拟器通过真实 HTTP POST 接口发送数据，页面再通过 GET 接口接收，模型按回传更新。
4. 打开机械倾覆分析，确认范围随姿态变化。若正在播放旧姿态的倾覆演示，新姿态到达会停止旧演示；暂停模拟后重新播放，使用最后一次有效姿态。
5. 停止模拟，超过 5 秒检查字段状态变为过期，机械保留最后有效姿态。连接仍成功不代表每个参数都有新数据。
6. 停用关联，最后姿态转为可保存的人工草稿；需要保留时点击“保存到资源”。

测试数据均标记为“模拟”，不作为现场实测记录。参数关联配置按账号、项目和机械保存在当前浏览器；换浏览器需重新配置。机械的初始模型仍保存于现有资源台账，遥测流不自动写入台账。

## 参数与角度

参数按 `换算值 = 回传值 × 倍率 + 偏移` 转换。例如 mm 转 m 的倍率为 0.001；弧度转角度为 `180 / Math.PI`；传感器方向相反可使用负倍率并设置零偏。源字段可使用自定义名称，映射到下列模型字段。

| 字段 | 含义与单位 | 支持机械 |
|---|---|---|
| `longitude` | WGS84 经度，° | 全部 |
| `latitude` | WGS84 纬度，° | 全部 |
| `height` | 模型底部站位的 WGS84 椭球高，m | 全部 |
| `heading` | 整机方位角，正北 0°、俯视顺时针为正；通过模型前向校准换算到原模型轴 | 全部 |
| `boom_length_m` | 吊臂长度，m | 吊机 |
| `boom_elevation_deg` | 吊臂仰角，水平 0°、竖直 90° | 吊机 |
| `boom_rotation_deg` | 吊臂相对回转角，背离车头且与车身纵轴共线为 0°，俯视顺时针为正 | 吊机 |
| `outrigger_lateral_m` | 横向支腿跨度，m | 吊机 |
| `outrigger_longitudinal_m` | 纵向支腿跨度，m | 吊机 |
| `total_height_m` | 桩机总高，m | 桩机 |
| `overall_height_m` | 整机高度，按现有挖机模型作整体尺寸调整，m | 挖机 |

吊机角度验收：整机 0°、吊臂 0°时，车头朝北、吊臂朝南；整机 90°、吊臂 0°时，车头朝东、吊臂朝西；整机 0°、吊臂 180°时，吊臂朝向车头。吊臂绝对方位角为 `wrap360(heading + 180 + boom_rotation_deg)`。

当前吊机资产驾驶室位于源模型 +X 端，前向校准默认为 0°。原始吊臂方向由资产 `boom.axis` 计算，约为 119.20°，因此接口 0°对应原存储回转角约 60.80°。转换层保留历史模型的原始存储语义。其他机械接入真实方位传感器前，应核对前向轴与传感器安装零偏；不要把模型参考轴未经校核当成实测车头朝向。

绑定后仅更新勾选字段；未绑定字段保留人工值，报文缺失字段保留上次值。0 是有效数值，null、字符串、非有限数、越界值不作为有效数据。吊机总高由臂长和姿态计算，不能再作为独立遥测量同时驱动。挖机沿用现有模型自由度，本接口不增加动臂、斗杆、铲斗的独立关节。

位置必须事先转换到 WGS84，经纬度不是工程 XY；`height` 不是桩机高度。GNSS天线位置应由现场适配器换算到模型站位锚点，1985高程等工程高程需先完成相应基准转换。

## 外部程序回传

接收地址：`POST http://127.0.0.1:5173/__management/machinery-telemetry`。现场网关将厂商协议转换成此 JSON 即可；此版本提供 HTTP 入口，不内置厂商 MQTT、串口或 Modbus 驱动。

```json
{
  "schemaVersion": 1,
  "projectId": "safety:project",
  "resourceId": "这里替换成页面中的机械资源ID",
  "sourceId": "sensor-01",
  "timestamp": "发送时生成的UTC时间，例如2026-10-28T12:00:00.000Z",
  "mode": "measured",
  "values": {
    "longitude": 116.391,
    "latitude": 39.907,
    "height": 0,
    "heading": 90,
    "boom_length_m": 20,
    "boom_elevation_deg": 55,
    "boom_rotation_deg": 0
  }
}
```

示例位置与尺寸仅用于协议说明，请用已初始化机械的有效参数。每次发送必须生成当前 UTC 时间（JavaScript `new Date().toISOString()`）。请求头为 `Content-Type: application/json` 和 `Authorization: Bearer <设备令牌>`。

设备令牌限定到一个项目、机械和来源。未配置令牌时外部接入关闭，页面模拟仍可用。私有配置错误只关闭外部设备入口并返回清晰错误，不阻止整个平台启动、手工机械编辑或页面模拟。浏览器模拟沿用平台会话、机械编辑及模型权限，且只能提交 `mode: simulated`。GET 接收沿用平台项目与对象可见权限。

### Windows PowerShell：配置和测试

在项目目录运行，先从页面复制实际项目 ID 和机械资源 ID。以下脚本不会覆盖已有配置。

```powershell
$projectId = 'safety:project'
$resourceId = '替换为实际机械资源ID'
$privateDir = Join-Path $env:USERPROFILE 'cesium-sensor-private'
$configFile = Join-Path $privateDir 'machinery-telemetry.json'

node tools/simulate-machinery-telemetry.mjs --init-config $configFile --project $projectId --resource $resourceId --source sensor-01
$env:CESIUM_MACHINERY_TELEMETRY_CONFIG_FILE = $configFile
npm run dev
```

配置文件须在项目目录之外。如果原开发服务已启动，先停止原服务，再在设置环境变量的终端中启动，避免误连到另一端口。

第二个 PowerShell 终端进入同一项目目录：

```powershell
$projectId = 'safety:project'
$resourceId = '替换为实际机械资源ID'
$configFile = Join-Path $env:USERPROFILE 'cesium-sensor-private/machinery-telemetry.json'
$env:CESIUM_MACHINERY_TELEMETRY_TOKEN = (Get-Content -Raw ($configFile + '.token')).Trim()

node tools/simulate-machinery-telemetry.mjs --project $projectId --resource $resourceId --source sensor-01 --values '{"boom_length_m":20,"boom_elevation_deg":55,"boom_rotation_deg":0}' --once
```

页面中的相关字段来源也须填 `sensor-01` 并启用。然后连续发送约 30 秒：

```powershell
node tools/simulate-machinery-telemetry.mjs --project $projectId --resource $resourceId --source sensor-01 --values '{"boom_length_m":20,"boom_elevation_deg":55,"boom_rotation_deg":0}' --wave '{"boom_length_m":2,"boom_elevation_deg":10,"boom_rotation_deg":30}' --hz 2 --duration 30
```

如所用 PowerShell/Node 组合改变了命令行 JSON 引号，改用页面单帧测试，或在 PowerShell 中直接构造 JSON 发送：

```powershell
$frame = @{
  schemaVersion = 1; projectId = $projectId; resourceId = $resourceId
  sourceId = 'sensor-01'; timestamp = [DateTime]::UtcNow.ToString('o')
  mode = 'simulated'; values = @{ boom_length_m = 20; boom_elevation_deg = 55; boom_rotation_deg = 0 }
}
# 接口时间支持毫秒精度，明确使用三位小数。
$frame.timestamp = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
Invoke-RestMethod -Uri 'http://127.0.0.1:5173/__management/machinery-telemetry' -Method Post -ContentType 'application/json' -Headers @{ Authorization = "Bearer $env:CESIUM_MACHINERY_TELEMETRY_TOKEN" } -Body ($frame | ConvertTo-Json -Depth 5)
```

`--once` 只发一帧；`--duration 0` 持续发送直到 Ctrl+C；`--url` 可指定实际平台服务地址。工具始终发送模拟数据，真实设备另用 `mode: measured` 和独立来源编号。不要让相同 sourceId 混用模拟与实测。

### 响应和容错

- POST 成功返回 HTTP 202 与 `accepted:true`，表示网关接受。前端是否应用还需看绑定、参数有效性和页面状态；未绑定数据不会改变模型。
- `GET /__management/machinery-telemetry?projectId=...&after=0` 返回 `frames / cursor / streamId / reset / serverTime`；后续使用返回游标。浏览器每秒轮询，不把每个传感器包都立刻重建成模型。
- 网关保留最多 2048 帧、最近 60 秒数据；服务重启清空瞬时帧，不改变初始机械台账。数据超前超过 5 秒、过旧、重复或倒序会被拒绝。
- 时序按项目、机械、来源、模式及源字段隔离；不同传感器的不同参数不会因为整机单一时间戳相互排斥。
- 超时保留最后状态并显示过期，不自动归零。无效尺寸/姿态不会覆盖上一有效状态。缺帧提示须与参数新鲜度一并观察。
- 令牌及配置放在工程目录外，不上传仓库；修改配置后重启服务。发布到实际网络时复用已部署服务的 HTTPS 和访问控制。

## 保持现有功能与性能

原机械尺寸解析器、原模型资产、铁路限界与倾覆几何算法继续使用。新增实时姿态单独保存于运行时，编辑预览、实时值和台账值有明确优先级。关闭接入不新增轮询、动画循环或数据库写入；同值不重复重建，仅失效变化机械的包络。多帧回传合并更新，收到新姿态使旧倾覆演示失效。

启用实时接入期间的筛查结果统一标为临时结果。需要“登记处置”时，先停用关联并保存当前机械姿态，使登记结果与台账快照一致。

新接入改变的是几何输入。倾覆影响范围和动画仍为既有几何演示，不新增稳定性或倾覆概率判定。

## 本地代码更新

本功能使用独立分支 `codex/machinery-sensors-20261028`，草稿 PR 目标为 `codex/fix-render-stability-20261025`，基于提交 `87adcb34c2badc091328a27d40867b5d4b787763`。发布分支和草稿 PR 不会自动更新用户电脑上的平台。用户电脑可能包含未推送改动，应先在本地检查工作区，再把本功能提交合并到当前使用分支，保留已有改动；不要直接覆盖整个项目目录。补丁应用方式：在项目目录先运行 `git apply --check /实际路径/machinery-sensor-interface.patch`，无冲突后运行 `git apply /实际路径/machinery-sensor-interface.patch`。检查失败时应在当前代码基础上合并，不使用强制覆盖。更新后重启开发服务。

## 自动验证

```bash
npm run build
node --experimental-transform-types --import ./tools/test-module-loader.mjs --test --test-concurrency=2 src/machinery/machinery.test.ts src/machineryIntegration.test.ts src/machineryTelemetry.test.ts src/machineryTelemetryController.test.ts src/railSafety*.test.ts server/management/machineryHttp.test.ts server/management/machineryTelemetryGateway.test.ts server/management/positioningGateway.test.ts server/managementStore.test.ts
```

浏览器验收脚本 `tools/verify-machinery-telemetry.mjs` 使用隔离测试数据。可通过 `PLAYWRIGHT_MODULE` 指向已安装的 Playwright，`BROWSER_EXECUTABLE` 指定 Chromium；运行结果写入 `output/machinery-telemetry`。不得把隔离数据验收等同于用户现场模型或实际传感器验收。

技术依据：[Cesium HeadingPitchRoll](https://cesium.com/learn/cesiumjs/ref-doc/HeadingPitchRoll.html)、[Cesium Scene.requestRender](https://cesium.com/learn/cesiumjs/ref-doc/Scene.html#requestRender)。模型轴到地理方向的适配以本仓库实际几何为准。

## 验证结果

- 最终相关自动化测试：**200 项通过，0 失败**。包括原有机械几何/台账持久化、倾覆范围/动画/显示、人员定位及其网关、管理存储，新传感器核心、生命周期与HTTP接口。
- `npm run build` 通过。原有构建仍提示大文件块及 CAD WASM 的 Node 模块外部化；本功能没有引入新依赖。
- 原平台真实 Chromium + WebGL 浏览器验收：**8 项通过**，无 pageerror 或 console.error。核验实际场景 GLB 参数与铁路范围计算所用姿态，而非只检查UI数字。
- 核验内容：默认零遥测流量；原创建/缩放/保存/旋转取消；规范初始角应用/保存/取消；只绑定臂长后人工修改方向不改变机身/倍率；部分报文保持未更新参数；页面单帧与连续模拟经真实HTTP；超时保留姿态；关闭面板持续更新；新姿态使旧倾覆演示失效；桩机高度与多机械隔离；停用后网络请求停止、最后姿态可保存。
- 浏览器结束时保持一个原有 Viewer、一个机械数据源，无遗留模型加载任务和实时状态。测试使用隔离台账和自带模型，未读取或修改用户电脑的数据。
- 尚未在用户电脑上的实际工程场景、真实传感器、特定网络时延和大量机械负载下验收；此处不提供未经测量的现场帧率承诺。默认每秒合并应用一批数据，不是硬实时控制接口。
