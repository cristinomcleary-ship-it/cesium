# Cesium CAD / 倾斜摄影浏览器

一个基于 CesiumJS + Vite + TypeScript 的工程数据浏览器，支持：

- CAD：直接导入 ASCII DXF，支持 LINE、LWPOLYLINE、POLYLINE、ARC、CIRCLE、POINT、TEXT/MTEXT、3DFACE 等常见实体。
- CAD 定位：支持 EPSG/Proj4 坐标转换，或把本地工程坐标通过经纬度锚点放置到地球上。
- 倾斜摄影：加载标准 3D Tiles 的 `tileset.json`，或加载 Cesium ion Asset ID。
- GIS：导入 GeoJSON、TopoJSON、CZML、KML、KMZ。
- 视频 AR：读取飞行轨迹 ZIP/JSON、逐帧图片或本地视频，按无人机与云台姿态把画面投影到 Cesium 地形，并支持参考后端的实时 WebSocket 数据。
- 工程辅助：图层列表、定位、移除、经纬度拾取和模型高程/经纬度偏移。

## 自动保存与重新打开

导入成功后，资料会写入项目目录的 `project-data/`。界面显示“已保存到本机”后，可以正常刷新、关闭浏览器或退出服务；下次启动自动恢复，不依赖浏览器缓存或原来的端口。

- CAD：保存上传原文件、解析后的导入数据、坐标参数和贴附方式。
- 本地倾斜摄影：复制完整成果到资料库，重启使用保存副本；原始目录移动后仍可恢复。首次保存大模型需要时间和相应磁盘空间。
- 网址／Cesium ion 倾斜摄影：保存入口、偏移和清晰度参数；读取瓦片仍需原服务可访问。
- 工程模型：保存原文件和转换后的 GLB，以及平移、旋转、缩放和隐藏状态。
- GIS、本地影像：保存文件和影像范围。视频 AR 保存已经加载的轨迹、ZIP、独立视频、逐帧图片及配准文件；启动恢复上次使用的回放并保持暂停。实时直播不会自动录制，也不会自动重连。
- 保存图层显隐、上次视角和当前使用的影像／回放；其他历史资料仍可从“本机资料库”切换使用。

左侧展开“本机资料库”可下载原文件、重新加载或删除。图层的删除按钮会同步删除保存副本，外部原文件不受影响；“删除全部资料”会要求确认，正常退出不需要清空。视频 AR 的“关闭回放”只关闭当前显示，永久删除请使用资料库。

读不到外部服务、保存文件暂时被占用或恢复失败时，保留资料并显示重试入口。保存未完成时请不要强制关闭；写入中断不会用不完整索引覆盖已保存资料。重试可核实此前已经成功写入的记录，避免重复导入。

`project-data/` 是用户资料，不是缓存，不会自动清理。该目录不提交到 GitHub 源码仓库，备份／换电脑时请单独复制整个目录。可在启动服务前通过环境变量 `CESIUM_DATA_DIR` 指定其他资料目录。新增持久化仅能保存本次升级后成功导入的文件，之前只存在内存且已退出的图层需要重新导入一次。

开发服务与 `pnpm preview` 均提供资料库接口；单独把 `dist/` 放入纯静态服务器不具备本机文件保存能力。

### 持久化验证

~~~powershell
node --experimental-transform-types --test server/projectLibrary.test.ts src/videoArProjection.test.ts src/videoArGeoreference.test.ts src/digitalTwinDataCenter.test.ts
~~~

`tools/verify-persistence.cjs` 使用 Playwright 和隔离的临时资料目录，验证导入、服务重启、新浏览器会话、删除、丢失保存响应及失败重试。需要可用的 Playwright 和 Chromium/Edge；可用 `PLAYWRIGHT_MODULE`、`BROWSER_EXECUTABLE` 指定本机安装。不会加载或删除正式 `project-data/` 中的资料。

## 启动

Windows 上直接双击 `启动Cesium.cmd`，它会启动服务并自动打开浏览器。请在使用期间保留最小化的服务窗口。

也可以在终端执行：

```powershell
pnpm install
pnpm dev
```

浏览器打开终端显示的地址（通常为 `http://localhost:5173`）。生产构建：

```powershell
pnpm build
pnpm preview
```

## Cesium ion（可选）

默认使用 OpenStreetMap，无需 Token。若要通过 Asset ID 加载 ion 中的地形或 3D Tiles：

1. 复制 `.env.example` 为 `.env.local`。
2. 在 `.env.local` 中填写 `VITE_CESIUM_ION_TOKEN=你的Token`。
3. 重启开发服务器。

不要提交 `.env.local`。

## 视频 AR 融合

打开“视频 AR”标签即可使用。最简单的方式是直接选择包含 `trajectory_*.json` 与 `video_frames` 的飞行数据 ZIP；页面只索引 ZIP 中央目录，并按播放进度解压当前帧，不会把整个压缩包一次性展开到内存。ZIP 内有多条飞行记录时，可在下拉框中切换。

也支持以下组合：

- 轨迹 JSON + 本地 MP4/WebM 视频：普通轨迹按播放进度同步；新版 DJI 提取器轨迹通过身份、尺寸、帧数和 PTS 校验后按逐帧 SRT PTS 精确绑定，不按整段时长拉伸。
- 轨迹 JSON + 图片目录：选择包含轨迹中 `video_frame` 文件名的目录。
- 实时 WebSocket：默认兼容参考后端的状态端口 `8765` 与视频端口 `8766`，支持 `coordinates`、`gimbal_attitude`、`drone_status` 和 `video_frame` 消息。

### 真实经纬度投影

高楼、立面和起伏地形必须使用逐帧可见表面三维控制网格。页面投影优先级为 `EPSG:4979 三维网格 > WGS84 四角 > DJI SRT 姿态地面估算`。网格按精确 `video_sample_index`、帧名或 50ms 内 PTS 绑定；所有同时声明的样本号、帧名、PTS 和绝对时间必须一致，并且同一网格不会分配给相邻两帧。播放只接受 50ms 内的网格，不在不同拓扑之间插值。缺失或不匹配时停止该帧精确投影，不会静默套用另一航次的数据。

推荐的单帧网格格式如下。顶点固定为 `[u,v,longitude,latitude,ellipsoidHeight]`，UV 对应浏览器解码后的完整画面、左上原点、范围 `[0,1]`：

```json
{
  "source_video": {
    "file_name": "DJI_20260819162016_0001_V.mp4",
    "size_bytes": 123456789,
    "duration_ms": 115600
  },
  "video_sample_index": 120,
  "video_time_ms": 4000,
  "projection_mesh_wgs84": {
    "source_crs": "EPSG:4979",
    "height_reference": "WGS84_ELLIPSOID",
    "uv_origin": "top_left",
    "uv_units": "normalized",
    "image_space": "browser_display",
    "visibility": "first_surface_hit",
    "image_width_px": 3840,
    "image_height_px": 2160,
    "vertices": [
      [0.0, 0.0, 108.752790, 34.021220, 42.35],
      [1.0, 0.0, 108.753190, 34.021220, 44.10],
      [0.0, 1.0, 108.752790, 34.020980, 29.80]
    ],
    "triangles": [0, 2, 1],
    "quality": { "valid": true, "method": "sfm_mvs", "reprojection_rmse_px": 1.2 }
  }
}
```

`triangles` 必须显式提供。在楼顶—地面、立面—背景等深度断层处应断开三角形或留孔，不能用规则网格跨接，否则仍会产生拉伸。`visibility: first_surface_hit`、显示空间尺寸和 `image_space: browser_display` 都是必填项；这表示 UV 已应用视频旋转、clean aperture 与像素宽高比，恰好对应浏览器的 `videoWidth/videoHeight`。独立视频还必须提供源文件名、字节数和时长，选择错误航次会被拒绝。密集网格请放在单独 sidecar 中，由 Worker 解析；不要嵌入轨迹 JSON。网格应逐帧生成，且必须保证首尾覆盖视频、相邻 PTS 不超过 100ms（任意解码时刻距网格不超过 50ms）；不完整的稀疏关键帧数据会在加载时直接拒绝。播放中遇到孤立的解码/PTS 间隙时，会完整保持上一幅“纹理+网格”，不会降级到四角平面或提交错帧。单帧限制为 4096 顶点、8192 三角，文件总计限制为 200 万顶点和 200 万三角；更大的成果应按时间分块或使用二进制 sidecar。

兼容的四角格式如下，含义固定为视频画面的左上、右上、右下、左下：

```json
{
  "source_video": {
    "file_name": "DJI_20260819162016_0001_V.mp4",
    "size_bytes": 123456789,
    "duration_ms": 115600
  },
  "video_frame": "frame_000123.jpg",
  "video_frame_timestamp_ms": 1754179600000,
  "footprint_timestamp_ms": 1754179600000,
  "source_crs": "EPSG:4326",
  "ground_footprint_wgs84": {
    "top_left": { "longitude": 108.752790, "latitude": 34.021220 },
    "top_right": { "longitude": 108.753190, "latitude": 34.021220 },
    "bottom_right": { "longitude": 108.753190, "latitude": 34.020980 },
    "bottom_left": { "longitude": 108.752790, "latitude": 34.020980 }
  }
}
```

多帧文件可把这些对象放入 `frame_footprints` 数组，或直接放在每条 `trajectory_points` 中。每个角点可选填椭球高 `height`。目前只接受 WGS84/EPSG:4326、EPSG:4979 或可直接按同一坐标解释的 CGCS2000/EPSG:4490；GCJ-02、BD-09 和未声明的工程坐标会被拒绝。`canvas_corners_gps.json` 一类只有整张拼接图范围、没有帧名或时间戳的静态数据不能作为逐帧视频定位依据。

四角模式直接把当前纹理映射到对应经纬度，方位、画幅比例和东移/北移校正不会参与计算。四角只是单平面透视近似；把四角做密集插值仍然是同一平面，不能修复高楼视差。输入角点带有高程时会保留该高程，不再在无地形时强制归零。

DJI MP4/SRT 本身不包含场景逐像素深度，不能直接提取楼顶、立面和地面的真实三维交点。真实网格需由已标定相机与 DSM/3D Tiles/摄影测量模型求交，或通过 SfM/MVS + GPS/RTK/GCP 地理配准生成。只有二维卫星底图时，建筑像素应在上游掩膜成孔；不能把它们伪装成可靠地面点。

轨迹采用 WGS84 经纬度和高度，姿态按 NED 坐标系解释。默认把云台 yaw 当作绝对方位角；若设备上报的是相对机身偏航，请取消“云台偏航为绝对方位角”。页面优先读取 `ground_altitude_m` / `relative_altitude`，旧数据则以轨迹低位高程估算数据地表基准：无 DEM 时按 AGL 映射到椭球底图，有 DEM 时按 `terrainHeight + AGL` 渲染。估算不准时可填写“数据地表高程”。视锥不能完整落地时不会再生成悬空的固定距离画面；可选择按俯视姿态校准，或只保留诊断视锥。

没有同帧地理四角时，轨迹图片回放仍可使用相机位置、机身/云台姿态、FOV 与地形射线进行普通估算；界面会明确标注为“姿态射线估算”，它不等同于真实配准。通过认证的 DJI 独立视频模式会锁定源文件尺寸/大小、逐帧 PTS、GPS、相对高度、三轴云台及逐帧内参，忽略界面中遗留的默认 FOV、画幅缩放、方位、俯仰和东/北平移，避免旧人工参数再次造成错位。四条角射线必须全部向下并在安全跨度内落地；越过地平线的帧会停止投影，绝不自动改成正下方。

ZIP 被视为一个原子数据源，始终使用 ZIP 内自己的同步帧，独立视频不能跨航次覆盖它。只要一个回放数据源出现过真实地理四角，后续缺少匹配四角的帧也不会静默降级为姿态估算。DJI 独立视频还会核对提取时记录的文件名、字节数、分辨率、帧数、时长和连续 PTS；任一不一致即关闭投影。实时状态与视频继续核对 `device_sn`，设备不一致、视频设备变化或经纬度四角未与视频帧原子同步时立即停止投影。

为避免影响其他模块，纹理最长边固定为 1024 像素，离线视频默认最多更新 12 FPS；同一分辨率下复用画布和 GPU 纹理，不随地图缩放重新分配。连续视频几何最多更新 4 FPS；实时视频消息也会在主线程 `JSON.parse` 和网格校验前按 4 FPS 丢弃已过期帧，防止高频大消息堵塞页面。相机缩放/拖动期间暂停视频纹理和几何更新。新帧先暂存在 Canvas，旧几何和旧 GPU 纹理保持可见；候选 Primitive 就绪后才在同一提交点上传纹理并切换，分辨率变化也延迟到该提交点，因此不会再因节流或纹理重分配产生空白闪烁。取消候选时会强制重传当前解码帧，seek 期间不会把旧解码画面记作新 PTS。精确网格仅在渲染副本上沿相机方向偏移 8cm，避免与地形、屋顶或立面共面闪烁，不修改输入的真实 WGS84 坐标。队列只保留最新网格，Primitive 最多保留当前和一个候选。

参考 Python 后端已经隔离并整理到 `video_ar_backend/`。首次使用请复制其中的 `.env.example` 为 `.env`，填写飞行器 SN、MQTT 和 RTMP 参数，再运行：

```powershell
cd F:\codex\cesium\video_ar_backend
.\.venv\Scripts\python.exe start.py --check
.\.venv\Scripts\python.exe start.py
```

完整配置、数据目录和航次 ZIP 打包方式见 `video_ar_backend/README.md`。该后端只拉取已有视频流；DJI 端仍需由 Cloud API/Pilot 2 先发起直播。

先双击 `video_ar_backend/提取大疆视频SRT.cmd` 检查严格同名外置 SRT 或导出视频中真实存在的内嵌 DJI 字幕；它会校验经纬度、高程、云台三轴、焦距与 PTS，并拒绝把普通字幕或未支持的 `djmd` 数据伪装成 AR 遥测。确认 `ar_ready: true` 后，再双击 `video_ar_backend/提取大疆航拍视频信息.cmd`。2.2 版默认输出逐帧 WGS84 相机位置、高度、姿态、精确 PTS、曝光、相机/镜头审计、Cesium 轨迹 JSON、CSV 和 Excel；还可勾选内置 COLMAP CUDA 重建，以视频特征和 DJI GPS 生成逐帧可见表面的 EPSG:4979 稠密投影网格。只有高程基准、浏览器显示空间、PTS、SfM/MVS 和地理配准全部通过时才原子发布网格，失败不会退化成伪造四角或平面；成果文件按视频内容、遥测和重建参数生成独立指纹，避免误载旧航次。两个启动脚本都强制保留诊断窗口，完整用法见 `video_ar_backend/README.md`。

## CAD 数据准备

CAD 图纸页面接收 `.dwg` 和项目专用的 `.cadimport`：

- 选择 DWG 后，浏览器使用独立 WebAssembly 解析器在本机内存中读取图层、常见实体和块参照，不启动 AutoCAD，也不需要完成 AutoCAD 首次运行初始化。生成结果会保留实体/图层/块继承后的 CAD 颜色和线宽。
- 解析成功后可点击“下载生成的 .cadimport”。该文件保存已经展开的轻量几何，不是改名后的 DWG。
- 下次可直接选择 `.cadimport` 快速加载，并重新指定锚点、EPSG/Proj4 或任意中央子午线的高斯-克吕格坐标参数。
- `.cadimport` 是 JSON 交换格式，包含来源、统计、图层和几何；原始 DWG 不会上传到第三方服务。

当前可转换 LINE、LWPOLYLINE、POLYLINE2D/3D、ARC、CIRCLE、ELLIPSE、SPLINE、POINT、TEXT/MTEXT、3DFACE、SOLID，并递归展开普通 INSERT 块参照和块阵列。代理对象、部分参数化/行业自定义对象及 ACIS 三维实体可能被跳过；页面会在加载结果中提示跳过数量。

页面右上角“底图”可在 OpenStreetMap 街道图、Esri World Imagery 卫星影像、自定义卫星底图和无底图之间切换。点击齿轮可配置自己的 XYZ、TMS 或 ArcGIS MapServer 服务；地址、最大层级和影像署名会保存在当前浏览器。公网底图仅适合联网预览，正式项目请根据覆盖范围、授权和并发要求配置自己的影像服务。

也可选择已经下载到电脑的卫星影像文件：

- PNG/JPG/WEBP：选择文件后填写影像覆盖的西、南、东、北 WGS84 经纬度。
- GeoTIFF：支持 WGS84 或 Web Mercator，页面自动读取地理范围并生成显示影像；为控制浏览器内存，超大影像的显示分辨率会限制在最长边 8192 像素。
- MBTiles：支持使用 Web Mercator/TMS 编号的 PNG、JPG、WEBP 栅格瓦片包，自动读取范围和层级；不支持 PBF 矢量 MBTiles。
- LYR：支持旧版二进制栅格 LYR、TiledInternetLayer/WMTS 瓦片影像 LYR，以及包含多个 Esri Wayback 历史影像版本的 LYR。栅格 LYR 通过本机 ArcGIS Desktop/ArcPy 读取；瓦片服务 LYR 会提取服务模板并让用户选择。原始影像或在线服务仍须可访问。
- LYRX：文件选择器会识别该格式，但当前建议直接选择它引用的 GeoTIFF/影像，或在 ArcGIS 中另存为旧版 LYR。

本地影像读取成功后会保存到本机资料库，刷新或重启后可自动恢复，不会上传到第三方服务。非常大的 MBTiles 或 GeoTIFF 更适合由本地瓦片服务器发布后通过“自定义卫星底图”加载。

自定义地址示例：

- XYZ：`https://example.com/tiles/{z}/{x}/{y}.jpg`
- TMS：同样填写 `{z}/{x}/{y}`，选择 TMS 后页面会自动按反向 Y 请求。
- ArcGIS：`https://example.com/arcgis/rest/services/World_Imagery/MapServer`

影像服务器需允许浏览器跨域访问。带密钥的服务可把服务商允许的密钥查询参数直接写入 URL，但不要在对外发布的网页中嵌入具有高权限或无限额的私密密钥。

独立 DWG 解析使用 `@mlightcad/libredwg-web` / GNU LibreDWG，许可证为 GPL-3.0。若要把本项目作为闭源或商业产品分发，请先完成许可证评估，或改接有相应授权的 ODA/RealDWG 服务。

### DWG 已有坐标

选择“已有地理/投影坐标”，输入 `EPSG:4326`、`EPSG:3857`，或完整的 Proj4 定义。DXF 中的 X/Y 会转换为 WGS84 经纬度。

### DWG 是本地工程坐标

选择“本地工程坐标”，输入某个已知 CAD 点的 X/Y，以及这个点对应的锚点经纬度。DXF 的 X 为向东、Y 为向北，单位默认按米解释；还可设置旋转和缩放。若图纸原点就是锚点，CAD 基准 X/Y 保持为 0。

仓库中的 `public/examples/sample-site.dxf` 可用于快速验证：按默认锚点、CAD 基准 X/Y 为 0 直接加载即可。

带材质或大型三维 DWG 应从“工程模型”页导入；CAD 图纸页主要展示线划、文字、点和三维面。

## 倾斜摄影服务要求

1. 数据须为 Cesium 3D Tiles，入口为 `tileset.json`。
2. 使用 HTTP/HTTPS 静态服务发布整个数据目录，不能直接选择本机 `tileset.json`（浏览器无法访问它引用的相对瓦片文件）。
3. 跨域服务器需返回 `Access-Control-Allow-Origin`。
4. 若模型位置有小幅偏差，可使用面板中的经度、纬度和高程偏移。

例如数据目录放在其他静态服务器后，可填写：

```text
http://localhost:8080/oblique/tileset.json
```

### ContextCapture（CC）Data 文件夹

打开页面的“倾斜摄影”标签，把 CC 的 `Data` 文件夹或其上一级生产目录完整路径粘贴到“CC 目录路径”，点击“检测目录并加载”。项目服务会递归查找包含 3D Tiles `asset` 和 `root` 的入口 JSON，并保持其瓦片、模型和纹理相对路径。

- 找到入口 JSON：页面会自动填入本地服务地址并加载。
- 只有 `.osgb`：这是 OSGB 生产结果，CesiumJS 不能直接读取。
- 只有 `.3mx` / `.3mxb`：这是 Bentley 3MX 生产结果，CesiumJS 不能直接读取。
- 没有合法入口时：在 ContextCapture 中新建 Production，输出格式选择 `Cesium 3D Tiles`（新版可能显示为 `3D Tiles`），重新生产后再加载整个输出目录。

不要只复制一个 JSON；它引用的 `Data` 子目录、瓦片和纹理必须保持原目录结构。

## 高斯-克吕格 CAD 坐标

CAD 导入的坐标定位方式可选择“高斯-克吕格（中央子午线/分带）”，然后设置：

- 中央子午线：允许任意十进制度或度分秒，例如 `120.783333` 或 `120°47′`。不会取整到3°或6°倍数。
- 分带方法：3°或6°仅用于辅助推算带号，不改变中央子午线；自动推算后的带号仍可手动修改。
- 参考椭球：CGCS2000、WGS84、西安80或北京54。
- 坐标顺序：国内 CAD 常见 `X=北坐标，Y=东坐标`，也支持相反顺序。
- 带号前缀：东坐标为 `20512345` 一类值时勾选；为 `512345` 一类值时不勾选。

CGCS2000 与 WGS84 在一般工程展示比例尺下可直接使用。北京54、西安80到现代底图的严格转换还依赖项目所在地的三参数或七参数；页面仅完成对应椭球的高斯反算，若出现数十至数百米系统偏移，需要取得当地转换参数后再作校正。

## 注意事项

- OpenStreetMap 公共瓦片仅适合开发和轻量使用；正式部署请换成有授权和 SLA 的底图服务。
- DXF 的块参照（INSERT）、复杂样条、填充和外部参照可能需要在 CAD 软件中炸开/转换后再导入。
- 倾斜摄影数据较大时，建议开启 HTTP/2、gzip/brotli，并正确设置缓存响应头。

## DWG、RVT、SKP 三维模型

页面新增“工程模型”标签，用户可直接选择 `.dwg`、`.rvt`、`.skp` 或 `.glb`。CesiumJS 的原生三维运行格式是 glTF/GLB，因此实际处理方式如下：

- GLB：页面直接读取和加载。
- DWG、RVT、SKP：源文件上传到本机项目服务，由配置的本机合法转换器自动转成 GLB，再由页面加载；用户操作上无需手工转换。

项目不会默认把工程模型上传到第三方云服务。当前电脑若没有转换引擎，页面会显示对应格式“未配置”。复制 `model-converters.example.json` 为 `model-converters.json`，为每种格式填写有权使用的转换程序路径和参数。例如转换器接受 `--input 源文件 --output 目标文件`：

```json
{
  "dwg": {
    "executable": "C:\\Program Files\\YourConverter\\converter.exe",
    "args": ["--input", "{input}", "--output", "{output}"]
  }
}
```

转换程序必须真正生成 GLB。ODA File Converter 只解决 DWG/DXF 互转，并不等同于三维 DWG 到 GLB；RVT 通常需要 Revit/Autodesk APS 或合规插件，SKP 通常需要 SketchUp SDK/桌面导出器。若使用 Autodesk APS，需要另外设计云端凭据、上传授权和隐私策略，本项目默认不启用。

### 模型放置方式

- 使用模型坐标：保留转换器输出的世界坐标，适合已经输出为 WGS84 地心地固（ECEF）坐标的 GLB。
- 用户自定义放置：填写经度、纬度、高程、初始旋转和比例，适合普通 RVT、SKP 和局部坐标 DWG。
- 自定义高斯-克吕格坐标：填写模型落点的北坐标、东坐标、任意中央子午线、参考椭球、带号前缀、高程和旋转。中央子午线同样接受 `120°47′` 等度分秒输入，不受3°或6°整数倍限制。

加载后模型会高亮并显示位置调整工具：

- 水平拖动：改变东西、南北位置。
- 上下移动：改变模型高程。
- 旋转方向：绕当地竖轴旋转。
- 重置：恢复到首次加载的位置。

位置调整只修改场景中的变换矩阵，不会改写源模型文件。
