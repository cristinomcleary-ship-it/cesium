# 视频 AR 后端

这是从参考 `backend_v1.zip` 整理出的独立 Python 服务。它不会替代或阻塞 Vite/Cesium：

- MQTT 接收飞行器位置、机身姿态和云台姿态；
- OpenCV/FFmpeg 拉取已经存在的 RTMP/RTSP 视频流；
- `ws://127.0.0.1:8765` 输出组合状态，`ws://127.0.0.1:8766` 输出 JPEG 视频帧；
- 航次结束或按 `Ctrl+C` 时保存 `trajectory_*.json + video_frames/`。

> 该服务不会向 DJI 机场或 Pilot 2 下发 `live_start_push`。启动后端前，必须由现有 DJI Cloud API 平台或 Pilot 2 先开始推流，并确保 `.env` 中的 URL 能被本机 OpenCV 拉取。

## 一次性安装

在 PowerShell 中执行：

```powershell
cd F:\codex\cesium\video_ar_backend
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
```

如果电脑没有 `py -3.12`，可换成已经安装的 Python 3.10 及以上版本。

打开 `.env`，至少填写：

```dotenv
DRONE_DEVICE_SN=飞行器SN
DRONE_MQTT_HOST=MQTT服务器IP或域名
DRONE_RTMP_URL_TEMPLATE=rtmp://流媒体服务器/live/{device_sn}-81-0-0
```

有鉴权时还需填写 `DRONE_MQTT_USERNAME`、`DRONE_MQTT_PASSWORD`；生产 MQTT 建议启用 TLS。`{device_sn}-81-0-0` 必须与实际推流 key 完全一致。

先进行不联网检查：

```powershell
.\.venv\Scripts\python.exe start.py --check
```

检查通过后启动：

```powershell
.\.venv\Scripts\python.exe start.py
```

Cesium 页面保持原来的启动方式。进入“视频 AR”标签，实时地址保持默认的 `ws://localhost:8765` 和 `ws://localhost:8766`，点击“连接实时流”。

## 数据输出

默认保存到：

```text
video_ar_backend/data/
├─ logs/drone_backend.log
├─ video_cache/
└─ trajectory/
   └─ flight_设备SN_开始时间/
      ├─ trajectory_开始时间.json
      └─ video_frames/
```

轨迹每 30 秒原子写入一次检查点；按 `Ctrl+C` 会先停止 MQTT 和视频线程，再完成最终 JSON。视频缓存有数量上限，正式航次引用的帧会立即复制到航次目录，不依赖缓存长期保留。

把最新航次打包成页面可直接选择的 ZIP：

```powershell
.\.venv\Scripts\python.exe start.py --package-latest
```

也可在 `.env` 设置 `DRONE_AUTO_ZIP=true`，让每个航次结束时自动打包。ZIP 会与航次目录一起保存在 `data/trajectory/`。

## DJI SRT 依赖、检测与导出（先做这一步）

精确视频 AR 不一定要求“外置 SRT 文件”，但一定要求与原视频同一时间轴的 DJI 逐帧遥测。当前程序按以下来源使用：

1. 拍摄时由 DJI 同步生成的、与视频严格同名的外置 SRT；
2. MP4/MOV 容器中真实存在的标准内嵌字幕流；
3. 不把普通对白字幕或未知二进制数据当成遥测。

因此，“从视频提取 SRT”准确含义是：检测并导出视频中已经存在的标准字幕流。若录制时没有开启“视频字幕”、SD 卡上的外置 SRT 已丢失，而且视频容器里也没有字幕流，就不能从画面凭空恢复原始经纬度、高程、云台姿态和焦距。仅检测到 `djmd` 等 DJI 专有二进制数据流时，程序会报告流号并停止；在没有对应机型可靠解码器前不会伪造成 SRT。

### 第一步：从存储卡准备原始文件

1. 优先直接读取无人机/遥控器存储卡，不要先用剪辑软件转码视频。
2. 把同一次拍摄的 `MP4/MOV` 和 `SRT` 一起复制到电脑的同一目录。
3. 外置 SRT 的推荐文件名必须与视频主文件名完全相同，仅扩展名不同，例如：

   ```text
   D:\航拍\DJI_0001.MP4
   D:\航拍\DJI_0001.SRT
   ```

4. 不要把别的航次 SRT 改名后使用；GPS 看似接近也可能导致整段错位。程序已取消危险的“文件名前缀相似就自动匹配”，切换视频时也会立即清空上一个视频的 SRT。

### 第二步：双击运行 SRT 工具

1. 打开 `F:\codex\cesium\video_ar_backend`。
2. 双击 [`提取大疆视频SRT.cmd`](./提取大疆视频SRT.cmd)。黑色诊断窗口会保留，不会一闪而过。
3. 若中文入口被安全软件拦截，改为双击 [`DJI_SRT_Extractor_Launcher.cmd`](./DJI_SRT_Extractor_Launcher.cmd)。
4. 启动器依次检查项目 Python、Tk 图形组件、内置 `ffmpeg.exe`、内置 `ffprobe.exe` 和提取器模块。任一步失败都会留在窗口中，完整日志位于 `dji_srt_extractor_launcher.log`。

### 第三步：填写界面

1. “DJI 视频”：选择未经剪辑/转码的原始 `MP4/MOV`。
2. “外置 SRT（可空）”：
   - 同目录存在唯一、严格同名 SRT 时会自动填入；
   - 没有时保持空白，程序会检查内嵌字幕；
   - 也可手动选择拍摄时配套但文件名不同的 SRT。
3. “输出目录”：默认是视频旁的 `视频名_SRT提取结果`，一般无需修改。
4. “字幕流号（可空）”：第一次必须留空；只有报告提示“多个满足 AR 条件的流”时，才填写报告中的 `stream index` 后重新运行。
5. 点击“检测并获取 SRT”。工作在后台线程执行，大文件检查不会冻结窗口；需要停止时点击“取消”。

### 第四步：根据结果处理

| 界面/报告状态 | 含义 | 下一步 |
|---|---|---|
| `existing_sidecar` | 已找到外置 SRT，字段与内部 PTS 连续性通过 | 直接进入“航拍视频信息提取器” |
| `extracted_embedded` | 已从唯一标准内嵌字幕流导出，AR 必需字段通过 | 使用输出的 `*_内嵌遥测.srt` |
| `ambiguous_streams` | 有多个可能的 DJI 遥测流 | 查看报告的候选流号，在“字幕流号”中指定后重试 |
| `extracted_not_ar_ready` | 只是普通字幕，或缺经纬度/高程/云台/焦距 | 不可用于精确 AR；找回原配套 SRT/航飞日志 |
| `invalid_timeline` | PTS 乱序、重复、过稀或与容器时长不一致 | 检查是否选错 SRT、视频是否被剪辑/变速/转码 |
| `no_subtitle` | 无外置 SRT，视频也没有标准字幕流 | 无法从该视频恢复原始 DJI 遥测；找回 SD 卡 SRT |
| `unsupported_proprietary_metadata` | 只有未支持的 `djmd`/专有数据轨 | 保留原视频并提供无人机型号/固件；不要生成猜测 SRT |
| `tool_missing` / `probe_failed` | 内置工具缺失、损坏或视频容器不可读 | 查看诊断窗口和日志，重新放回完整工具目录或换原始文件 |

每次都会生成 `*_SRT提取报告.json`，包含视频采样指纹、候选流、编码、样本数、字段覆盖率、首尾 PTS、最大间隔、视频时长和失败原因。只有 `ar_ready: true` 才会发布内嵌 SRT；普通字幕和不完整遥测不会落成一个“看似成功”的 AR SRT。已有导出文件默认不覆盖，而是使用带序号的新文件名。

AR 完整性校验要求每条样本同时具备：

- WGS84 纬度、经度；
- 绝对/GPS/相对高度至少一种（进入精确网格前仍需确认垂直基准）；
- 云台 `yaw / pitch / roll`；
- 35 mm 等效焦距；
- 严格递增的 SRT PTS，采样中位间隔不大于 250 ms；
- 内嵌字幕还要与视频首尾时长一致。

命令行用法：

```powershell
cd F:\codex\cesium\video_ar_backend
.\.venv\Scripts\python.exe dji_srt_extractor.py `
  "D:\航拍\DJI_0001.MP4" `
  --output-dir "D:\航拍\DJI_0001_SRT提取结果"
```

有外置文件时加 `--srt "D:\航拍\DJI_0001.SRT"`；报告提示多个流时加 `--stream-index 3`。成功返回码为 `0`；检测完成但没有可用于 AR 的 SRT 返回码为 `3`；程序错误返回码为 `2`。

项目已内置固定版本的 Windows x64 LGPL FFmpeg/FFprobe 到 `tools/FFmpeg/`，不要求修改系统 `PATH`。下载压缩包保存在 `tools/ffmpeg-n9.0.1-11-ge47273f4d9-win64-lgpl-shared-9.0.zip`，SHA256 为 `E452726C9282E9D8B640DD29F012DB91BF6133B490B5490A37E8B0A4D3EC7AE9`，与发布方 `tools/ffmpeg-checksums.sha256` 一致；许可证随工具保存在 `tools/FFmpeg/LICENSE.txt`。

## DJI 航拍视频信息提取器

双击 [`提取大疆航拍视频信息.cmd`](./提取大疆航拍视频信息.cmd) 可打开独立的本地图形界面；它不启动 MQTT、直播服务或 Cesium，也不会占用 8765/8766 端口。入口和实际启动器都只使用 ASCII，并由外层 `cmd /k` 强制保留诊断窗口，避免 Windows 系统代码页、中文路径或脚本解析错误造成“一闪而过”。启动器会先检查本地 Python、Tk 图形组件和提取器依赖。关闭图形界面后，输入 `exit` 才会关闭诊断窗口。

若中文文件名被安全软件或文件关联拦截，也可以直接双击 [`DJI_Extractor_Launcher.cmd`](./DJI_Extractor_Launcher.cmd)；失败时它会停在“按任意键关闭”，不会闪退。项目虚拟环境的 Tcl/Tk 位于含中文用户名的目录时，启动器只为本次提取器进程使用 `.venv/tcl_runtime` 的 ASCII 路径，不修改系统 Python，也不影响其他模块。启动与异常 traceback 会以 UTF-8 写入同目录的 `dji_extractor_launcher.log`；若仍无法打开，把该日志发给开发人员即可定位，无需再从 PowerShell 启动。

依次选择 DJI MP4/MOV、配套 SRT 和输出目录后点击“开始提取”。程序会优先读取严格同名 SRT；SRT 留空时使用项目内置 FFmpeg/FFprobe 检查视频容器标签和标准内嵌字幕。若工具链确实不可用，才使用 OpenCV 读取分辨率、FPS、帧数和时长；OpenCV 不能提取字幕或恢复遥测。

2.2 版提供两级结果：默认的快速遥测/相机审计不会解码整段视频；勾选“生成真实表面三维投影网格（SfM/MVS）”后，才会在独立后台线程中调用 COLMAP 解码抽帧并做离线摄影测量。内置 CUDA 版入口为 `tools/COLMAP/COLMAP.bat`，点击“检查环境”即可验证，不需要单独配置系统 PATH。重建是耗时任务，但不会启动 Cesium、MQTT 或直播服务；点击“取消”会终止当前外部进程，已完成的普通遥测文件仍然保留。2.2.1 起，重建帧先在内存中编码，再通过 Windows Unicode 安全路径原子写入。2.2.2 起，Windows 原生 COLMAP 的全部中间文件自动放到输出磁盘的纯 ASCII 工作区，解决 COLMAP 无法读取中文完整路径的问题；最终 JSON 和报告仍写回用户选择的中文输出目录。

默认生成：

- `*_全部元数据_仅供审计.json`：容器信息、全部逐帧遥测、原始字段、字段来源和缺失字段；不要选择到 Cesium 的地面四角输入；
- `*_Cesium轨迹_请选择此文件.json`：选择到视频 AR 页面的“轨迹 JSON”；
- `*_逐帧遥测.csv`：带 UTF-8 BOM，可直接用 Excel 打开；
- `*_逐帧遥测.xlsx`：冻结表头并保留全部标准字段和 DJI 原始字段；
- `*_相机内参与镜头信息.json`：视频显示尺寸、旋转、逐段估算内参、焦距/变焦覆盖率和镜头畸变缺失状态；
- `*_AR投影数据准备.json`：逐样本 GPS、PTS、姿态、内参来源和重建前置条件审计；
- `*_提取报告.txt`：字段覆盖率、估算项、缺失项和警告。

勾选真实表面重建且质量检查全部通过时，另生成：

- `*_<视频指纹>_<生成批次>_三维投影网格_请选择此文件.json`：Cesium 使用的逐帧 EPSG:4979 稠密控制网格，包含显式 UV、经纬度、椭球高和断层三角形；
- `*_<视频指纹>_<生成批次>_AR投影质量报告.json`：重建状态、参数、配准误差、有效帧/顶点/三角形统计和失败原因；文件名同时绑定抽样视频内容、逐帧遥测、高程模式和重建参数，避免误载上一次航次或旧参数成果；
- 重建工作区：纯 ASCII 输出路径时位于结果目录内的 `_AR_reconstruction_workspaces/`；输出路径含中文时位于同一盘符根目录的 `CesiumARWorkspaces/`。失败或取消时保留抽帧、COLMAP 日志和中间模型用于诊断；网格原子发布成功后自动清理可重新生成的 `images/dense/sparse/database.db` 大文件，只保留日志、清单和文本模型。质量报告会记录本次工作区的完整路径。

真实表面网格使用步骤：

1. 选择原始视频及与它严格配套的 DJI SRT；
2. 勾选“生成真实表面三维投影网格”，点击“检查环境”；
3. 明确选择高程基准。若 SRT `abs_alt` 已是 WGS84 椭球高，选“绝对高度就是 WGS84 椭球高”；若为正高，选“正高 + 大地水准面差”并填写当地差值；若仅可信相对高度，选“相对高度 + 起飞点椭球高”并填写起飞点椭球高；
4. 保持默认 12 FPS / 1280 像素开始。同一次重建内焦距/数字变焦必须稳定；变焦航段请先分段。只有质量报告为 `success` 才会发布网格；失败、取消、轨迹配准退化、PTS 空洞、高程基准未确认、视频旋转/裁剪/像素宽高比无法验证时都不会伪造四角或平面网格；
5. Cesium 中仍选择原视频和 `*_Cesium轨迹_请选择此文件.json`，三维网格输入选择 `*_三维投影网格_请选择此文件.json`。

精确模式会要求首尾距视频端点不超过 50 ms、相邻网格 PTS 不超过 100 ms，并核对实际解码 PTS；VFR、转码后视频或错误 SRT 不能满足绑定时会安全失败。GPS 配准要求全部入选帧通过检查，稳健配准 RMSE 不超过 3 m、P95 不超过 5 m、最大误差不超过 8 m，稀疏重投影 RMSE 不超过 3 px。生产端最多写出 50 万顶点、75 万三角和 60 MB JSON，并在原子发布前再次检查单帧数量、索引、UV 绕序、重复/非流形三角、空间退化和过绘面积；这些限制用于避免错误成果拖垮浏览器。

也可以使用命令行：

```powershell
cd F:\codex\cesium\video_ar_backend
.\.venv\Scripts\python.exe dji_video_extractor.py `
  "D:\航拍\DJI_0001.MP4" `
  --srt "D:\航拍\DJI_0001.SRT" `
  --output-dir "D:\航拍\提取结果" `
  --timezone "+08:00" `
  --ar-mesh `
  --height-mode relative_plus_takeoff_ellipsoid `
  --height-offset-m 36.42
```

命令行请求 `--ar-mesh` 时，若普通遥测已导出但真实网格质量未通过，进程返回码为 `3`；这不是伪成功，失败原因在对应的 `*_AR投影质量报告.json`。图形界面的取消会终止当前 ffprobe/ffmpeg/COLMAP 外部进程树；正常取消不会弹“提取失败”，已经原子写完的普通结果或成功网格不会被晚到的取消信号追溯删除。

为防止异常或超长字幕耗尽桌面内存，单段 SRT/内嵌字幕最多 64 MB、120,000 条；超过时请按原始视频文件分段。CSV 逐行写出、XLSX 使用只写模式、JSON 使用迭代编码，不会再为导出阶段额外复制整份行数据或整段 JSON 字符串。

当前 DJI SRT 支持提取视频样本序号、原始 `FrameCnt`、精确 SRT PTS、拍摄墙钟、WGS84 经纬度、绝对/相对高度、云台三轴、机身三轴（源文件确实提供时）、ISO、快门、光圈、曝光补偿、色彩/测光模式、35 mm 等效焦距、数字变焦和未识别的原始 DJI 字段。

`*_Cesium轨迹_请选择此文件.json` 的 `flight_info.ar_projection.readiness` 是机器可读的投影就绪合同。只有每个源样本都同时具备显式 WGS84 经纬度、绝对/GPS/相对高度之一、云台 yaw/pitch/roll、连续 `video_sample_index`、SRT `video_time_ms` 和根据等效焦距得到的有效估算内参，`ready` 才为 `true`；逐点还有 `ar_projection_ready` 和缺失项。就绪时，页面可使用“DJI SRT 姿态 + Cesium 地形求交（估算）”完成 AR 投影。报告和 GUI 会直接显示该状态。

视频绑定使用连续的 `video_sample_index + SRT PTS`。DJI 的 `FrameCnt` 可能跳号，只作为原始字段保留；无时区的拍摄墙钟也不作为逐帧键。图形界面默认使用本机时区，跨时区拍摄时应填写真实偏移。

程序不会伪造缺失信息：`gb_yaw/gb_pitch/gb_roll` 只作为云台姿态，不会复制成机身姿态；SRT 的 `focal_len` 按 35 mm 等效焦距保存，`fx/fy/FOV` 仅标记为估算值。可选 SfM/MVS 会用真实视频特征恢复并优化相机参数和场景深度，再用 DJI GPS 做 WGS84 配准；水面、反光、运动物体、弱纹理、遮挡或高楼边缘不可靠时会留孔并在深度突变处断开三角形，不会把高楼像素压到地面。发布前还会直接解析 MP4/MOV 的 `tkhd/stsd`，验证轨道旋转、1:1 像素和无 clean-aperture 隐式裁剪。`ready: true` 仍只表示普通“SRT 姿态 + 地形求交（估算）”输入完整；精确模式必须另外存在质量合格的三维网格。若需测绘级重合，仍须 RTK/GCP、可靠的椭球高和独立检查点。

在 Cesium 中加载时，“轨迹 JSON”选择 `*_Cesium轨迹_请选择此文件.json`，“本地视频”选择原始 MP4；有成功网格时选择 `*_三维投影网格_请选择此文件.json`，不要再选简单四角文件。`*_全部元数据_仅供审计.json`、`*_AR投影数据准备.json` 和质量报告都不能作为轨迹或网格文件。

内置 COLMAP 遵循其 BSD 许可证，启动批处理内保留了完整版权与免责声明。官方命令行工作流和格式说明见 [COLMAP CLI](https://colmap.github.io/cli.html) 与 [COLMAP Output Format](https://colmap.github.io/format.html)。

## 高程与时间同步

- DJI `height` 常是相对起飞点高度，而 Cesium 默认按地球/地形高程显示。先确认设备字段的高程基准，再通过 `DRONE_ALTITUDE_FIELD` 和 `DRONE_ALTITUDE_OFFSET_M` 校正。
- 若 `position.altitude` 已校正为绝对高程，可设置 `DRONE_GROUND_ALTITUDE_M` 为同一基准下的绝对地面高程。配置后，`flight_info` 会写入 `ground_altitude_m` 和 `altitude_reference: "absolute"`，每个轨迹点会额外写入 `position.relative_altitude = altitude - ground_altitude_m`；实时 WebSocket 的 `drone_status.data.coordinates` 与 `coordinates.data.coordinates` 也会输出同样的 `ground_altitude_m`、`relative_altitude`。留空时不会猜测地面高程，航次 JSON 和实时坐标均省略这些字段。
- 遥测使用 DJI MQTT 消息中的毫秒时间戳，视频帧使用服务器系统时间。设备、MQTT 服务器和采集电脑应同步 NTP。
- 默认只关联时间差不超过 1500 ms 的视频帧，可通过 `DRONE_FRAME_MATCH_MAX_AGE_MS` 调整。若轨迹有点但没有图片，优先检查两端系统时间。
- 每个轨迹点都包含可空的 `video_frame_timestamp_ms` 和 `video_frame_time_delta_ms`。成功关联帧时，前者是视频帧 Unix 毫秒时间戳，后者是“视频帧时间 - 遥测点时间”的有符号毫秒差；没有关联帧时二者均为 `null`。原有 `video_frame`、`timestamp`、`source_timestamp_ms` 和 `position.altitude` 保持不变。

### 可选的真实 WGS84 画面角点

若上游已完成相机标定与地面交会，可在 OSD 或 status 的 `data`（也可放在载荷子对象）中提供逐帧角点。后端只校验和透传，不会根据无人机位置猜测角点：

```json
{
  "ground_footprint_wgs84": {
    "top_left": {"latitude": 30.001, "longitude": 120.000},
    "top_right": {"latitude": 30.001, "longitude": 120.001},
    "bottom_right": {"latitude": 30.000, "longitude": 120.001},
    "bottom_left": {"latitude": 30.000, "longitude": 120.000}
  },
  "source_crs": "EPSG:4326",
  "footprint_timestamp_ms": 1700000000000
}
```

输入键也可写成 `footprint_wgs84`，角点可写成 `TL/TR/BR/BL`；输出统一为上例的完整名称。经纬度越界、非 WGS84 坐标系、缺角、重复/自交/退化四边形、超过 250 km 的异常范围以及设备不一致都会被拒绝。只有角点时间与当前视频帧相差不超过 1500 ms 且 `device_sn` 完全一致时，三个字段才会作为同一条 `video_frame.data` 消息原子附带；否则整组字段都不发送。匹配到保存帧的航次点也会保留同一组字段，供 ZIP 回放使用。

## 性能与安全默认值

- 源流持续读取，但默认只保存 2 FPS、向浏览器最多推送 10 FPS；不会每个源帧都落盘。
- 遥测和视频广播都只允许一个在途任务，处理不过来时丢弃旧状态/旧帧。
- 运行日志按 5 MB 轮转，保留 3 份。
- WebSocket 默认只监听 `127.0.0.1`。需要局域网访问时再改为 `0.0.0.0`，同时配置防火墙或带认证的 WSS 反向代理。

## 常用诊断

查看脱敏后的最终配置：

```powershell
.\.venv\Scripts\python.exe start.py --print-config
```

常见错误：

- `MQTT CONNACK 被拒绝`：检查账号、密码、TLS 和设备所在 Broker。
- `无法打开视频流`：确认 DJI 已开始直播、URL/key 正确、防火墙放行，并用 FFmpeg/VLC 验证同一地址。
- 有轨迹但 `video_frame` 为空：检查 RTMP 是否连通，以及无人机、服务器、采集电脑的时间差。
- 8765/8766 被占用：停止旧后端进程，或同时修改 `.env` 和 Cesium 实时流地址。
