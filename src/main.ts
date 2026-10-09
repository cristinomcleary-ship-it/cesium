import { SceneLibrary } from "./sceneLibrary";
import { ModelQualityTracker, type ModelQualityState } from "./modelQualityState";
import type { SafetyWorkspace } from "./safetyWorkspace";
import type { ManagementWorkspace } from "./managementWorkspace";
import "cesium/Build/Cesium/Widgets/widgets.css";
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Cesium3DTileset,
  Color,
  CzmlDataSource,
  GeoJsonDataSource,
  HeadingPitchRoll,
  HeadingPitchRange,
  Ion,
  CartographicGeocoderService,
  IonResource,
  type ImageryLayer,
  type ImageryProvider,
  KmlDataSource,
  Math as CesiumMath,
  Matrix4,
  Model,
  type PrimitiveCollection,
  RequestScheduler,
  SceneMode,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Transforms,
  UrlTemplateImageryProvider,
  Viewer,
} from "cesium";
import { cadImportFileName, readCadImport, type CadImportPackage } from "./cadImport";
import { createCadImportFromDwgInWorker } from "./cadImportWorkerClient";
import { clampCadToScene, getCadBoundingSphere, loadCadImport, useSampledCadHeights } from "./dxfLoader";
import { loadCadPrimitiveCollection } from "./cadPrimitiveLoader";
import { loadLocalImagery, type LocalImageryResult } from "./localImagery";
import { UnavailableMapTileDiscardPolicy } from "./imageryOverzoom";
import { ModelEditor, type EditMode, type EditableModel } from "./modelEditor";
import { gaussKrugerToWgs84, inferredZoneNumber, parseLongitude, type GaussAxisOrder, type GaussEllipsoid } from "./coordinateUtils";
import { SubsurfaceTools, subsurfacePanelHtml } from "./subsurfaceTools";
import { FoundationPitMonitoring, foundationPitMonitoringPanelHtml } from "./foundationPitMonitoring";
import { ThreeDReport, threeDReportPanelHtml, threeDReportStageHtml } from "./threeDReport";
import { MarkupTools, markupPanelHtml } from "./markupTools";
import {
  ElectronicSandTable,
  electronicSandTablePanelHtml,
  type SandTableFocusMode,
} from "./electronicSandTable";
import {
  ElectronicSandTablePresentation,
  electronicSandTableStageHtml,
} from "./electronicSandTablePresentation";
import { SandTableFacilities } from "./sandTableFacilities";
import { SandTableProjectControl } from "./sandTableProjectControl";
import {
  DigitalTwinDataCenter,
  dataResourceFromImport,
  type BusinessRecordInput,
  type DataResourceInput,
  type DigitalTwinBusinessRecord,
  type DigitalTwinDataResource,
  type DigitalTwinProject,
  type ProjectStatus,
  type ProjectType,
} from "./digitalTwinDataCenter";
import {
  DigitalTwinOverview,
  type DigitalTwinOverviewSnapshot,
  type DigitalTwinResourceRecord,
} from "./digitalTwinOverview";
import { VideoArFusion, videoArFusionPanelHtml } from "./videoArFusion";
import type { CadCoordinateOptions, CadDisplayMode, ImportRecord, TilesetOptions } from "./types";
import "./style.css";

const token = import.meta.env.VITE_CESIUM_ION_TOKEN?.trim();
if (token) Ion.defaultAccessToken = token;

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div class="shell">
    <header class="app-header">
      <div class="brand">
        <span class="brand-mark">C</span>
        <div><strong>工程数据浏览器</strong><small>CESIUM · CAD · 3D TILES</small></div>
      </div>
      <nav class="tabs" aria-label="功能菜单">
        <button class="tab" data-tab="overview" data-label="平台总览" data-menu-icon="◫">平台总览</button>
        <button class="tab" data-tab="sandtable" data-label="电子沙盘" data-menu-icon="◈">电子沙盘</button>
        <button class="tab active" data-tab="cad" data-label="CAD 图纸" data-menu-icon="⌁" aria-current="page">CAD 图纸</button>
        <button class="tab" data-tab="models" data-label="工程模型" data-menu-icon="◆">工程模型</button>
        <button class="tab" data-tab="tiles" data-label="倾斜摄影" data-menu-icon="▦">倾斜摄影</button>
        <button class="tab" data-tab="gis" data-label="GIS 数据" data-menu-icon="◎">GIS 数据</button>
        <button class="tab" data-tab="videoar" data-label="视频 AR" data-menu-icon="◉">视频 AR</button>
        <button class="tab" data-tab="markup" data-label="标绘" data-menu-icon="✎">标绘</button>
        <button class="tab" data-tab="monitoring" data-label="基坑监测" data-menu-icon="▥">基坑监测</button>
        <button class="tab" data-tab="report" data-label="3维汇报" data-menu-icon="▣">3维汇报</button>
      </nav>
      <button id="openSafetyWorkspace" class="text-button safety-entry-button" type="button">项目统筹平台</button>
      <a href="/ar-v2.html" class="text-button" title="独立视觉定位与融合">AR V2</a>
      <div class="workspace-mode"><span class="workspace-pulse"></span><span>数字孪生工作台</span></div>
    </header>
    <aside class="sidebar">
      <section class="layers-section scene-explorer" aria-labelledby="sceneExplorerTitle">
        <div class="section-title">
          <div class="scene-explorer-title"><small>SCENE CONTENT</small><span id="sceneExplorerTitle">图层与标绘</span></div>
          <button id="clearAll" class="text-button" title="删除全部保存资料，退出软件不需要清空">删除全部资料</button>
        </div>
        <div id="layers" class="layers-empty">尚未加载工程数据</div>
        <details class="saved-library">
          <summary>本机资料库 <span id="libraryStatus">正在读取资料…</span></summary>
          <div id="savedLibrary"></div>
        </details>
        <button id="openMarkupWorkspace" class="scene-markup-overview" type="button">
          <span><small>MARKUPS</small><strong>标绘对象</strong></span>
          <span><b id="sceneMarkupCount">0</b><small id="sceneMarkupOverview">尚未创建</small></span>
        </button>
        <p class="scene-explorer-hint">工程图层与标绘分别管理，互不影响</p>
      </section>
      <div class="active-tool-heading">
        <div><small>当前功能</small><strong id="activeToolTitle">CAD 图纸</strong></div>
        <span>参数与对象信息</span>
      </div>
      <main class="panel-scroll">
        ${electronicSandTablePanelHtml}
        <section class="panel digital-twin-sidebar" data-panel="overview">
          <div class="digital-twin-sidebar__heading">
            <small>DIGITAL TWIN DATA CENTER</small>
            <strong>项目总览与统一数据中心</strong>
            <p>汇总工程图层、标绘、基坑监测、隐蔽档案和3维汇报；原业务数据仍由各自模块安全管理。</p>
          </div>
          <details open>
            <summary>项目资料</summary>
            <label>项目名称<input id="digitalTwinProjectName" maxlength="160" value="当前工程数字孪生项目" /></label>
            <div class="field-grid details-grid">
              <label>项目类型<select id="digitalTwinProjectType"><option value="infrastructure">基础设施</option><option value="municipal">市政工程</option><option value="building">房建工程</option><option value="survey">测绘项目</option><option value="other">其他</option></select></label>
              <label>项目状态<select id="digitalTwinProjectStatus"><option value="active">建设中</option><option value="planned">筹备中</option><option value="paused">暂停</option><option value="completed">已完成</option><option value="archived">已归档</option></select></label>
              <label>项目负责人<input id="digitalTwinProjectOwner" maxlength="160" placeholder="可选" /></label>
              <label>项目位置<input id="digitalTwinProjectLocation" maxlength="160" placeholder="城市、标段或工点" /></label>
            </div>
            <label>项目说明<textarea id="digitalTwinProjectDescription" rows="3" maxlength="2000" placeholder="项目范围、建设阶段或数据说明"></textarea></label>
            <button class="primary" id="saveDigitalTwinProject">保存项目资料</button>
          </details>
          <div class="digital-twin-sidebar__stats" aria-label="统一数据统计">
            <article><strong id="digitalTwinLayerCount">0</strong><span>工程图层</span></article>
            <article><strong id="digitalTwinVisibleCount">0</strong><span>当前显示</span></article>
            <article><strong id="digitalTwinMarkupCount">0</strong><span>标绘对象</span></article>
            <article><strong id="digitalTwinPitCount">0</strong><span>基坑模型</span></article>
            <article class="warning"><strong id="digitalTwinAlertCount">0</strong><span>活动预警</span></article>
            <article><strong id="digitalTwinArchiveCount">0</strong><span>隐蔽档案</span></article>
          </div>
          <button class="primary digital-twin-open-overview" id="openDigitalTwinOverview">打开全屏项目总览</button>
          <button class="secondary" id="exportDigitalTwinCatalog">导出数据目录</button>
          <p class="hint" id="digitalTwinStorageStatus">数据目录元数据保存在本机浏览器；模型、视频和照片不会重复写入目录。</p>
        </section>
        <section class="panel active" data-panel="cad">
          <div class="dropzone" id="cadDropzone">
            <input id="cadFile" type="file" accept=".dwg,.cadimport" hidden />
            <span class="drop-icon">⌁</span><strong>选择 DWG 或 CAD 导入文件</strong>
            <small>DWG 在浏览器本地生成 .cadimport，不调用 AutoCAD</small>
          </div>
          <label>坐标定位方式<select id="cadMode"><option value="local">本地工程坐标（指定锚点）</option><option value="gaussKruger">高斯-克吕格（中央子午线/分带）</option><option value="crs">已有 EPSG / Proj4 坐标</option></select></label>
          <label>显示模式<select id="cadDisplayMode"><option value="absolute">保持图纸高程</option><option value="terrain">紧贴地表</option><option value="model">依附倾斜摄影/三维模型</option></select></label>
          <p class="hint" id="cadDisplayHint">保持 CAD 原始 Z 坐标和设置的高程。</p>
          <div id="localFields" class="field-grid">
            <label>锚点经度<input id="anchorLon" type="number" step="any" value="116.3913" /></label>
            <label>锚点纬度<input id="anchorLat" type="number" step="any" value="39.9075" /></label>
            <label>锚点高程（米）<input id="anchorAlt" type="number" step="any" value="0" /></label>
            <label>CAD 基准 X<input id="referenceX" type="number" step="any" value="0" /></label>
            <label>CAD 基准 Y<input id="referenceY" type="number" step="any" value="0" /></label>
            <label>顺时针旋转（度）<input id="cadRotation" type="number" step="any" value="0" /></label>
            <label>缩放比例<input id="cadScale" type="number" step="any" value="1" /></label>
          </div>
          <div id="crsFields" class="hidden">
            <label>源坐标系<input id="sourceCrs" value="EPSG:4326" placeholder="EPSG:3857 或完整 Proj4 定义" /></label>
            <label>高程偏移（米）<input id="cadHeight" type="number" step="any" value="0" /></label>
            <p class="hint">常用 EPSG:4326、EPSG:3857；其他坐标系可粘贴完整 Proj4 定义。</p>
          </div>
          <div id="gaussFields" class="hidden">
            <div class="field-grid">
              <label>中央子午线（任意经度）<input id="centralMeridian" type="text" value="117" placeholder="120.783333 或 120°47′" /></label>
              <label>带号推算方法<select id="zoneWidth"><option value="3">3° 分带（仅推算带号）</option><option value="6">6° 分带（仅推算带号）</option></select></label>
              <label>参考椭球<select id="gaussEllipsoid"><option value="GRS80">CGCS2000（GRS80）</option><option value="WGS84">WGS84</option><option value="IAU76">西安80（IAG75近似）</option><option value="krass">北京54（Krassovsky）</option></select></label>
              <label>CAD 坐标顺序<select id="gaussAxis"><option value="northEast">X=北坐标，Y=东坐标</option><option value="eastNorth">X=东坐标，Y=北坐标</option></select></label>
              <label class="check-label"><input id="zonePrefix" type="checkbox" /> 东坐标含带号前缀</label>
              <label>带号（可修改）<input id="zoneNumber" type="number" value="39" /></label>
              <label>高程偏移（米）<input id="gaussHeight" type="number" step="any" value="0" /></label>
            </div>
            <p class="hint">中央子午线可输入任意值，如 120.783333 或 120°47′；不会按3°/6°取整。分带方法仅用于推算东坐标中的带号前缀。</p>
          </div>
          <button class="primary" id="loadCad">生成导入文件并加载</button>
          <button class="secondary hidden" id="downloadCadImport">下载生成的 .cadimport</button>
          <div id="dwgStatus" class="converter-status"><span class="available">独立 DWG 解析</span><span>浏览器本地处理</span><span>无需 AutoCAD 初始化</span></div>
          <div class="notice"><strong>处理方式</strong><p>首次选择 DWG 时，页面会在本机内存中展开图层和块参照，并生成专用 .cadimport。可下载保存；以后直接选择该文件即可快速加载，坐标参数仍可随时修改。</p></div>
        </section>
        <section class="panel" data-panel="models">
          <div class="dropzone" id="modelDropzone">
            <input id="modelFile" type="file" accept=".dwg,.rvt,.skp,.glb" hidden />
            <span class="drop-icon">⬡</span><strong>选择或拖入三维模型</strong>
            <small>DWG · RVT · SKP · GLB</small>
          </div>
          <div id="converterStatus" class="converter-status">正在检测本机转换能力…</div>
          <label>初始放置方式<select id="modelPlacement"><option value="customGeo">自定义经纬度放置</option><option value="customGauss">自定义高斯-克吕格坐标</option><option value="coordinates">使用模型坐标</option></select></label>
          <div id="modelCustomFields" class="field-grid">
            <label>经度<input id="modelLon" type="number" step="any" value="116.3913" /></label>
            <label>纬度<input id="modelLat" type="number" step="any" value="39.9075" /></label>
            <label>高程（米）<input id="modelHeight" type="number" step="any" value="0" /></label>
            <label>初始旋转（度）<input id="modelHeading" type="number" step="any" value="0" /></label>
            <label>模型比例<input id="modelScale" type="number" step="any" min="0.000001" value="1" /></label>
          </div>
          <div id="modelGaussFields" class="hidden">
            <div class="field-grid">
              <label>模型北坐标 X<input id="modelNorthing" type="number" step="any" placeholder="例如 3378123.45" /></label>
              <label>模型东坐标 Y<input id="modelEasting" type="number" step="any" placeholder="例如 512345.67" /></label>
              <label>中央子午线（任意经度）<input id="modelCentralMeridian" type="text" value="117" placeholder="120.783333 或 120°47′" /></label>
              <label>带号推算方法<select id="modelZoneWidth"><option value="3">3° 分带（仅推算带号）</option><option value="6">6° 分带（仅推算带号）</option></select></label>
              <label>参考椭球<select id="modelGaussEllipsoid"><option value="GRS80">CGCS2000（GRS80）</option><option value="WGS84">WGS84</option><option value="IAU76">西安80</option><option value="krass">北京54</option></select></label>
              <label class="check-label"><input id="modelZonePrefix" type="checkbox" /> 东坐标含带号前缀</label>
              <label>带号<input id="modelZoneNumber" type="number" value="39" /></label>
              <label>高程（米）<input id="modelGaussHeight" type="number" step="any" value="0" /></label>
              <label>初始旋转（度）<input id="modelGaussHeading" type="number" step="any" value="0" /></label>
              <label>模型比例<input id="modelGaussScale" type="number" step="any" min="0.000001" value="1" /></label>
            </div>
            <p class="hint">模型的落点按北坐标、东坐标换算；中央子午线支持任意十进制度或度分秒。</p>
          </div>
          <div id="modelCoordinateHint" class="notice hidden"><strong>模型坐标要求</strong><p>仅适用于转换结果已经使用 WGS84 地心地固（ECEF）世界坐标的模型。普通建筑局部坐标请选择自定义放置。</p></div>
          <div class="model-load-actions">
            <button class="primary" id="loadModel">转换并加载模型</button>
            <button class="secondary hidden" id="cancelModelLoad" type="button">取消当前任务</button>
          </div>
          <p id="modelLoadStatus" class="hint" aria-live="polite">选择文件后会先检查本机转换能力，不可用时不会上传文件。</p>
          <div class="notice"><strong>源格式说明</strong><p>GLB 可直接加载。DWG、RVT、SKP 会调用本机合法转换器自动生成 GLB；转换器状态显示为“未配置”时，请先按项目示例文件配置。</p></div>
        </section>
        <section class="panel" data-panel="tiles">
          <div class="dropzone compact" id="ccFolderZone">
            <span class="drop-icon">▱</span><strong>加载本机 CC 生产目录</strong>
            <small>粘贴 Data 文件夹或其上级生产目录的完整路径</small>
          </div>
          <label>CC 目录路径<input id="ccFolderPath" type="text" placeholder="例如 D:\\CC项目\\Production_1\\Data" /></label>
          <button class="secondary" id="loadCcFolder">检测目录并加载</button>
          <div id="ccScanStatus" class="converter-status hidden"></div>
          <div class="or"><span>或加载网络服务</span></div>
          <label>tileset.json 地址<input id="tilesUrl" type="url" placeholder="https://server/model/tileset.json" /></label>
          <div class="or"><span>或者</span></div>
          <label>Cesium ion Asset ID<input id="ionAssetId" type="number" min="1" placeholder="需要在 .env.local 配置 Token" /></label>
          <label>显示清晰度<select id="tilesQuality"><option value="high" selected>高清（推荐）</option><option value="ultra">超清（显存占用较高）</option><option value="balanced">流畅</option><option value="custom">自定义</option></select></label>
          <p class="hint">高清会请求更精细的瓦片并按屏幕实际像素渲染；超清适合近距离检查，数据量和显存占用会明显增加。</p>
          <div id="tilesQualityStatus" class="notice" aria-live="polite">尚未加载倾斜摄影。</div>
          <details>
            <summary>位置校正与显示质量</summary>
            <div class="field-grid details-grid">
              <label>经度偏移（度）<input id="tilesLon" type="number" step="any" value="0" /></label>
              <label>纬度偏移（度）<input id="tilesLat" type="number" step="any" value="0" /></label>
              <label>高程偏移（米）<input id="tilesHeight" type="number" step="any" value="0" /></label>
              <label>细节误差（越小越清晰）<input id="tilesSse" type="number" min="0.5" max="64" step="0.5" value="4" /></label>
            </div>
          </details>
          <button class="primary" id="loadTiles">加载倾斜摄影</button>
          <div class="notice"><strong>CC 格式判断</strong><p>目录中有 3D Tiles 入口 JSON 才能直接加载。只有 OSGB、3MX/3MXB 时，请在 CC 中新建 Production，输出格式选择 Cesium 3D Tiles 后再加载。</p></div>
        </section>
        <section class="panel" data-panel="gis">
          <div class="dropzone" id="gisDropzone">
            <input id="gisFile" type="file" accept=".geojson,.json,.czml,.kml,.kmz" hidden />
            <span class="drop-icon">◇</span><strong>选择或拖入 GIS 文件</strong>
            <small>GeoJSON · TopoJSON · CZML · KML · KMZ</small>
          </div>
          <button class="primary" id="loadGis">加载 GIS 数据</button>
        </section>
        ${videoArFusionPanelHtml}
        ${markupPanelHtml}
        ${foundationPitMonitoringPanelHtml}
        ${threeDReportPanelHtml}
      </main>
      <footer><span class="status-dot"></span><span id="status">Cesium 已就绪</span></footer>
    </aside>
    <section class="viewport">
      <div id="cesiumContainer"></div>
      <div id="digitalTwinOverviewHost"></div>
    <div id="safetyWorkspaceHost"></div>
      ${electronicSandTableStageHtml}
      <div class="topbar">
        <span id="coords">经度 -- · 纬度 -- · 高程 --</span>
        <div class="map-controls"><label>底图<select id="basemap"><option value="street">街道图</option><option value="satellite">Esri 卫星影像</option><option value="custom">自定义卫星底图</option><option value="local">本地影像文件</option><option value="none">无底图</option></select></label><button id="openSubsurfacePanel" title="地下工程">⛏</button><button id="configureBasemap" title="设置底图">⚙</button><button id="homeView" title="返回初始视角">⌂</button></div>
      </div>
      <div id="customBasemapPanel" class="basemap-panel hidden">
        <div class="basemap-panel-title"><strong>自定义卫星底图</strong><button id="closeBasemapPanel" title="关闭">×</button></div>
        <label>服务类型<select id="customBasemapType"><option value="xyz">XYZ 瓦片</option><option value="tms">TMS 瓦片</option><option value="arcgis">ArcGIS MapServer</option></select></label>
        <label>影像服务地址<input id="customBasemapUrl" type="url" placeholder="https://example.com/tiles/{z}/{x}/{y}.jpg" /></label>
        <div class="field-grid basemap-fields"><label>最大层级<input id="customBasemapMaxLevel" type="number" min="0" max="30" value="19" /></label><label>影像署名<input id="customBasemapCredit" type="text" placeholder="影像提供单位" /></label></div>
        <p class="hint" id="customBasemapHint">XYZ 地址需包含 {z}、{x}、{y}；ArcGIS 可直接填写以 MapServer 结尾的服务地址。</p>
        <button class="primary" id="applyCustomBasemap">保存并应用</button>
      </div>
      <div id="localBasemapPanel" class="basemap-panel hidden">
        <div class="basemap-panel-title"><strong>选择已下载的卫星影像</strong><button id="closeLocalBasemapPanel" title="关闭">×</button></div>
        <label class="local-file-button">选择影像文件<input id="localBasemapFile" type="file" accept=".png,.jpg,.jpeg,.webp,.tif,.tiff,.mbtiles,.lyr,.lyrx" hidden /></label>
        <div id="localBasemapSelection" class="local-file-name">支持 PNG/JPG/WEBP、GeoTIFF、MBTiles、LYR/LYRX</div>
        <label id="lyrHistoryField" class="hidden">历史影像版本<select id="lyrHistoryChoice"></select></label>
        <div id="localImageBounds">
          <p class="hint">普通图片没有地理坐标，请填写图片覆盖范围（WGS84 经纬度）。GeoTIFF 和 MBTiles 会自动读取。</p>
          <div class="field-grid basemap-bounds"><label>西边界<input id="localWest" type="number" step="any" value="73" /></label><label>南边界<input id="localSouth" type="number" step="any" value="18" /></label><label>东边界<input id="localEast" type="number" step="any" value="135" /></label><label>北边界<input id="localNorth" type="number" step="any" value="54" /></label></div>
        </div>
        <button class="primary" id="applyLocalBasemap">读取并应用</button>
        <p class="hint">文件只在当前页面本地读取，不上传。关闭或刷新页面后需重新选择。</p>
      </div>
      ${subsurfacePanelHtml}
      <div id="modelTools" class="model-tools hidden">
        <div class="tool-title"><span>模型位置调整</span><small id="editingModelName"></small></div>
        <div class="tool-buttons">
          <button data-edit-mode="horizontal" class="active">↔ 水平拖动</button>
          <button data-edit-mode="vertical">↕ 上下移动</button>
          <button data-edit-mode="rotate">↻ 旋转方向</button>
          <button id="resetModelTransform">重置</button>
        </div>
        <div id="modelTransformReadout">东 0.00m · 北 0.00m · 高 0.00m · 旋转 0.00°</div>
        <div class="tool-hint">在地图中按住模型并拖动；单击其他模型可切换选择</div>
      </div>
      ${threeDReportStageHtml}
      <div id="toast" role="status"></div>
    </section>
  </div>`;

const viewer = new Viewer("cesiumContainer", {
  baseLayer: false,
  baseLayerPicker: false,
  // Local projects need no Ion service. Coordinate search remains available without a token.
  geocoder: token ? true : [new CartographicGeocoderService()],
  homeButton: false,
  sceneModePicker: true,
  navigationHelpButton: false,
  animation: false,
  timeline: false,
  fullscreenButton: false,
  infoBox: true,
  selectionIndicator: true,
  terrainProvider: undefined,
  useBrowserRecommendedResolution: false,
  showRenderLoopErrors: false,
  contextOptions: { webgl: { alpha: true } },
});
// Leave enough headroom for 3D Tiles/CAD interaction while online imagery is
// filling. Excessive tile fan-out was causing large release bursts on switches.
RequestScheduler.maximumRequests = 40;
RequestScheduler.maximumRequestsPerServer = 10;
viewer.resolutionScale = 1;
type CustomBasemap = { type: "xyz" | "tms" | "arcgis"; url: string; maximumLevel: number; credit: string };
const CUSTOM_BASEMAP_KEY = "cesium-custom-basemap-v1";
let localImagery: LocalImageryResult | null = null;
let selectedLocalImageryFile: File | null = null;
let lyrTileChoices: Array<{ id: string; label: string; url: string }> = [];
const basemapLayers = new Map<string, ImageryLayer>();
let activeBasemapKey = "";
let customBasemapSignature = "";
let lastBasemapErrorNotice = 0;
let tileImageryReleasePatched = false;
let digitalTwinSyncReady = false;
let electronicSandTable: ElectronicSandTable | null = null;
let sandTableProjectControl: SandTableProjectControl | null = null;
let sandTablePresentation: ElectronicSandTablePresentation | null = null;
let sandTableFacilities: SandTableFacilities | null = null;
let electronicSandTableRefreshFrame = 0;

function scheduleElectronicSandTableRefresh() {
  if (!electronicSandTable || electronicSandTableRefreshFrame) return;
  electronicSandTableRefreshFrame = window.requestAnimationFrame(() => {
    electronicSandTableRefreshFrame = 0;
    electronicSandTable?.refreshLayers();
    sandTableProjectControl?.refreshLayers();
    sandTablePresentation?.refresh();
  });
}

type InternalImagery = { releaseReference: () => number; isDestroyed?: () => boolean };
type InternalTileImagery = { readyImagery?: InternalImagery; loadingImagery?: InternalImagery; freeResources: () => void };
type InternalGlobe = { _surface?: { _levelZeroTiles?: Array<{ data?: { imagery?: InternalTileImagery[] } }> } };

function applyBasemapVisibility() {
  for (const [key, layer] of basemapLayers) {
    if (layer.isDestroyed()) continue;
    const active = activeBasemapKey !== "none" && key === activeBasemapKey;
    const targetAlpha = active ? 1 : 0;
    if (layer.alpha !== targetAlpha) layer.alpha = targetAlpha;
    // Until the idempotent release guard is installed, alpha switching keeps
    // startup safe. Afterwards show=false prevents invisible layers from
    // consuming the same request pool as 3D Tiles.
    if (tileImageryReleasePatched && layer.show !== active) layer.show = active;
  }
}

const removeTileImageryPatchListener = viewer.scene.postRender.addEventListener(() => {
  if (tileImageryReleasePatched) return;
  const levelZeroTiles = (viewer.scene.globe as unknown as InternalGlobe)._surface?._levelZeroTiles;
  const sample = levelZeroTiles?.flatMap((tile) => tile.data?.imagery ?? [])[0];
  if (!sample) return;
  const prototype = Object.getPrototypeOf(sample) as InternalTileImagery & { __idempotentReleaseInstalled?: boolean };
  if (!prototype.__idempotentReleaseInstalled) {
    prototype.freeResources = function safeFreeResources(this: InternalTileImagery) {
      const ready = this.readyImagery;
      const loading = this.loadingImagery;
      // Clear first so a repeated cleanup from the replacement queue is a no-op.
      this.readyImagery = undefined;
      this.loadingImagery = undefined;
      for (const imagery of ready === loading ? [ready] : [ready, loading]) {
        if (!imagery) continue;
        try {
          if (!imagery.isDestroyed?.()) imagery.releaseReference();
        } catch (error) {
          if (!/object was destroyed|destroy\(\) was called/i.test(String(error))) throw error;
        }
      }
    };
    prototype.__idempotentReleaseInstalled = true;
  }
  tileImageryReleasePatched = true;
  removeTileImageryPatchListener();
  applyBasemapVisibility();
});

function savedCustomBasemap(): CustomBasemap | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_BASEMAP_KEY) || "null") as Partial<CustomBasemap> | null;
    if (!parsed || !["xyz", "tms", "arcgis"].includes(parsed.type || "") || typeof parsed.url !== "string") return null;
    return { type: parsed.type as CustomBasemap["type"], url: parsed.url, maximumLevel: Number(parsed.maximumLevel) || 19, credit: parsed.credit || "自定义影像" };
  } catch { return null; }
}

function customBasemapTemplate(config: CustomBasemap): string {
  let url = config.url.trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("影像地址必须以 http:// 或 https:// 开头");
  if (config.type === "arcgis") {
    url = url.replace(/\/$/, "");
    if (!/\/tile\/\{z\}\/\{y\}\/\{x\}/i.test(url)) url += "/tile/{z}/{y}/{x}";
  } else {
    if (!url.includes("{z}") || !url.includes("{x}") || (!url.includes("{y}") && !url.includes("{reverseY}"))) {
      throw new Error("瓦片地址必须包含 {z}、{x}、{y} 占位符");
    }
    if (config.type === "tms" && !url.includes("{reverseY}")) url = url.replace("{y}", "{reverseY}");
  }
  return url;
}

function monitorBasemap(provider: ImageryProvider, label: string) {
  provider.errorEvent.addEventListener(() => {
    const now = Date.now();
    if (now - lastBasemapErrorNotice < 5000) return;
    lastBasemapErrorNotice = now;
    toast(`${label}瓦片暂时无法取得，系统会保留已加载的上一级影像`, true);
  });
  return provider;
}

function retireBasemapLayer(layer: ImageryLayer, onRetired?: () => void) {
  if (!layer.isDestroyed()) {
    layer.alpha = 0;
    if (tileImageryReleasePatched) layer.show = false;
  }

  // Removing an imagery layer while the globe is traversing its tiles can
  // release the same TileImagery twice. Retire it just after a completed frame;
  // the timeout is only a background-tab fallback.
  let finished = false;
  let removePostRender: (() => void) | undefined;
  let fallbackTimer = 0;
  const finish = () => {
    if (finished) return;
    finished = true;
    removePostRender?.();
    window.clearTimeout(fallbackTimer);
    try {
      if (!layer.isDestroyed() && viewer.imageryLayers.contains(layer)) viewer.imageryLayers.remove(layer, true);
    } catch (error) {
      if (!/object was destroyed|destroy\(\) was called/i.test(String(error))) console.warn("[Basemap] Layer retirement failed", error);
    } finally {
      if (onRetired) window.setTimeout(onRetired, 0);
    }
  };
  removePostRender = viewer.scene.postRender.addEventListener(finish);
  fallbackTimer = window.setTimeout(finish, 750);
  viewer.scene.requestRender();
}

function activateBasemap(key: string, create: () => ImageryProvider, replace = false, onRetired?: () => void) {
  let existing = basemapLayers.get(key);
  if (existing?.isDestroyed()) {
    basemapLayers.delete(key);
    existing = undefined;
  }
  if (!replace && existing) {
    activeBasemapKey = key;
    applyBasemapVisibility();
    viewer.scene.requestRender();
    if (digitalTwinSyncReady) scheduleDigitalTwinSync();
    return existing;
  }

  const nextLayer = viewer.imageryLayers.addImageryProvider(create());
  basemapLayers.set(key, nextLayer);
  activeBasemapKey = key;
  applyBasemapVisibility();
  if (existing) retireBasemapLayer(existing, onRetired);
  else if (onRetired) queueMicrotask(onRetired);
  viewer.scene.requestRender();
  if (digitalTwinSyncReady) scheduleDigitalTwinSync();
  return nextLayer;
}

function activateDynamicBasemap(key: "custom" | "local", provider: ImageryProvider, onRetired?: () => void) {
  const existing = basemapLayers.get(key);
  const sameProvider = existing && !existing.isDestroyed() && existing.imageryProvider === provider;
  return activateBasemap(key, () => provider, Boolean(existing && !sameProvider), onRetired);
}

function replaceLocalImagery(result: LocalImageryResult) {
  const previous = localImagery;
  try {
    activateDynamicBasemap("local", result.provider, previous && previous !== result ? previous.dispose : undefined);
    localImagery = result;
    if (digitalTwinSyncReady) scheduleDigitalTwinSync();
  } catch (error) {
    result.dispose();
    throw error;
  }
}

function setBasemap(kind: string) {
  if (kind === "street") {
    activateBasemap("street", () => monitorBasemap(new UrlTemplateImageryProvider({
      url: "/__basemap/osm/{z}/{y}/{x}",
      credit: "Tiles © Esri; © OpenStreetMap contributors",
      maximumLevel: 19,
    }), "街道底图"));
  } else if (kind === "satellite") {
    activateBasemap("satellite", () => monitorBasemap(new UrlTemplateImageryProvider({
      url: "/__basemap/esri/{z}/{y}/{x}",
      credit: "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
      maximumLevel: 19,
      tileDiscardPolicy: new UnavailableMapTileDiscardPolicy(),
    }), "卫星底图"));
  } else if (kind === "custom") {
    const config = savedCustomBasemap();
    if (!config) return;
    const signature = JSON.stringify(config);
    const existing = basemapLayers.get("custom");
    if (signature === customBasemapSignature && existing && !existing.isDestroyed()) {
      activateBasemap("custom", () => existing.imageryProvider);
      return;
    }
    const provider = monitorBasemap(new UrlTemplateImageryProvider({
      url: customBasemapTemplate(config),
      credit: config.credit,
      maximumLevel: Math.max(0, Math.min(30, config.maximumLevel)),
    }), "自定义底图");
    activateDynamicBasemap("custom", provider);
    customBasemapSignature = signature;
  } else if (kind === "local" && localImagery) {
    activateDynamicBasemap("local", localImagery.provider);
  } else if (kind === "none") {
    activeBasemapKey = "none";
    applyBasemapVisibility();
    viewer.scene.requestRender();
  }
  if (digitalTwinSyncReady) scheduleDigitalTwinSync();
}
setBasemap("street");
viewer.scene.globe.baseColor = Color.fromCssColorString("#17243a");
viewer.scene.globe.depthTestAgainstTerrain = true;
// Request the next globe/imagery level sooner than Cesium's default. This is
// especially visible on high-DPI screens and prevents satellite tiles from
// looking soft while the camera is already close to the ground.
viewer.scene.globe.maximumScreenSpaceError = 1.5;
viewer.scene.globe.tileCacheSize = 160;
viewer.scene.fog.enabled = true;
viewer.camera.setView({ destination: Cartesian3.fromDegrees(105, 35, 18_000_000) });

const imports: ImportRecord[] = [];
let safetyWorkspace: SafetyWorkspace | undefined;
let safetyWorkspaceLoading: Promise<SafetyWorkspace> | undefined;
let managementWorkspace: ManagementWorkspace | undefined;
let managementWorkspaceLoading: Promise<ManagementWorkspace> | undefined;
let projectLibrary: SceneLibrary | undefined;
const tilesetSourceIds = new Map<string, string>();
const modelQualityTrackers = new Map<string, ModelQualityTracker>();
const modelQualityResources = new Map<Cesium3DTileset, ModelQualityTracker>();
const modelQualitySubscribers = new Set<() => void>();
let modelQualityNotifyTimer: ReturnType<typeof setTimeout> | undefined;
function getModelQualityStates(): ModelQualityState[] { return [...modelQualityTrackers.values()].map(tracker => tracker.getState()); }
function subscribeModelQuality(listener: () => void): () => void { modelQualitySubscribers.add(listener); return () => { modelQualitySubscribers.delete(listener); }; }
function updateModelQualityIndicators(): void {
  const states = getModelQualityStates();
  const summary = document.querySelector<HTMLElement>("#tilesQualityStatus");
  if (summary) summary.textContent = states.length ? states.map(state => `${state.name}：${state.label}；目标 SSE ${state.targetScreenSpaceError}，网络 ${state.pendingRequests} / 解析 ${state.processingTiles}${state.failedTileCount ? `；失败 ${state.failedTileCount}` : ""}`).join("\n") : "尚未加载倾斜摄影。";
  for (const row of document.querySelectorAll<HTMLElement>("#layers .layer-row")) {
    const status = row.querySelector<HTMLElement>(".layer-quality-status"), state = states.find(entry => entry.modelId === row.dataset.id);
    if (status && state) { status.textContent = state.label; status.title = `${state.label}；目标 SSE ${state.targetScreenSpaceError}；${state.limitation}`; }
  }
  for (const listener of modelQualitySubscribers) listener();
}
function scheduleModelQualityIndicators(): void {
  if (modelQualityNotifyTimer !== undefined) return;
  modelQualityNotifyTimer = setTimeout(() => { modelQualityNotifyTimer = undefined; updateModelQualityIndicators(); }, 150);
}
function trackModelQuality(id: string, name: string, tileset: Cesium3DTileset, initialCoarse = false): ModelQualityTracker {
  const existing = modelQualityResources.get(tileset); if (existing) return existing;
  const saved = projectLibrary?.records.get(id)?.settings;
  const target = initialCoarse ? Math.max(.5, numeric("#tilesSse", 4)) : saved?.tiles?.maximumScreenSpaceError ?? tileset.maximumScreenSpaceError;
  const quality = saved?.quality ?? (initialCoarse ? selectedTilesQuality() : target === 12 ? "balanced" : target === 4 ? "high" : target === 1 ? "ultra" : "custom");
  const tracker = new ModelQualityTracker({ modelId: id, name, tileset, scene: viewer.scene, camera: viewer.camera,
    quality, targetScreenSpaceError: target, initialCoarse, onInitialReady: () => {
      configureTilesetQuality(tileset); toast("倾斜摄影首屏已加载，正在继续追踪当前视角细节");
    }, onChange: scheduleModelQualityIndicators });
  modelQualityTrackers.set(id, tracker); modelQualityResources.set(tileset, tracker); return tracker;
}
function disposeModelQuality(id: string, tileset: Cesium3DTileset): void {
  modelQualityTrackers.get(id)?.dispose(); modelQualityTrackers.delete(id); modelQualityResources.delete(tileset);
  scheduleModelQualityIndicators();
}
let selectedCad: File | null = null;
let selectedGis: File | null = null;
let selectedModelFile: File | null = null;
let generatedCadImport: { name: string; blob: Blob } | null = null;
let cadLoadBusy = false;
let cadLoadController: AbortController | null = null;

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const value = (selector: string) => $<HTMLInputElement>(selector).value;
const numeric = (selector: string, fallback = 0) => {
  const parsed = Number(value(selector));
  return Number.isFinite(parsed) ? parsed : fallback;
};

function setStatus(message: string) { $("#status").textContent = message; }
function toast(message: string, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = error ? "show error" : "show";
  window.setTimeout(() => { element.className = ""; }, 3600);
}

const videoArFusion = new VideoArFusion(viewer, toast, setStatus);
videoArFusion.onGetProjectionModels = () => imports.filter(item => item.kind === "3D Tiles").map(item => {
  const tileset = item.resource as Cesium3DTileset;
  return { id: item.id, name: item.name, visible: item.visible, runtimeVisible: tileset.show,
    modelMatrix: Matrix4.toArray(tileset.modelMatrix), maximumScreenSpaceError: tileset.maximumScreenSpaceError,
    savedRecord: projectLibrary?.projectionModelRecord(item.id) ?? null,
    quality: modelQualityTrackers.get(item.id)?.getState() ?? null,
    versionEvidence: "local record revision and current transform; model content hash not verified" };
});
videoArFusion.onShowProjectionModels = () => {
  const models = imports.filter(item => item.kind === "3D Tiles");
  for (const item of models) if (!item.visible) setImportVisibility(item, true, { silent: true, deferRender: true });
  renderLayers(); viewer.scene.requestRender();
  return models.length;
};

function updateModelTools(item: EditableModel | null, mode: EditMode) {
  $("#modelTools").classList.toggle("hidden", !item);
  document.querySelectorAll<HTMLButtonElement>("[data-edit-mode]").forEach((button) => button.classList.toggle("active", button.dataset.editMode === mode));
  if (!item) return;
  videoArFusion.invalidateProjection("model-transform-changed");
  projectLibrary?.queueUpdate(item.id, { settings: {
    matrix: Matrix4.toArray(item.model.modelMatrix), scale: item.model.scale,
    editor: { baseMatrix: Matrix4.toArray(item.baseMatrix), center: [item.center.x, item.center.y, item.center.z],
      east: item.east, north: item.north, up: item.up, heading: item.heading },
  } });
  $("#editingModelName").textContent = item.name;
  $("#modelTransformReadout").textContent = `东 ${item.east.toFixed(2)}m · 北 ${item.north.toFixed(2)}m · 高 ${item.up.toFixed(2)}m · 旋转 ${CesiumMath.toDegrees(item.heading).toFixed(2)}°`;
}

const modelEditor = new ModelEditor(viewer, updateModelTools);
projectLibrary = new SceneLibrary({
  viewer, getImports: () => imports, addImport, removeImport, modelEditor,
  waitForModelReady, cacheGisBoundingSphere, replaceImagery: replaceLocalImagery,
  setBasemap, getBasemap: () => activeBasemapKey, notify: toast,
  restoreVideo: (files, settings) => videoArFusion.restoreReplay(files, settings), clearVideo: () => videoArFusion.clear(), layersChanged: renderLayers,
});
videoArFusion.onReplaySettingsChanged = (controls, sessions, requireSaved) => projectLibrary?.updateVideoControls(controls, sessions, requireSaved);
videoArFusion.onReplayLoaded = async snapshot => {
  await projectLibrary!.ready;
  const files = Object.fromEntries(Object.entries(snapshot.files).map(([slot, file]) => [slot, { name: file.name, blob: file }]));
  const saved = await projectLibrary!.save(crypto.randomUUID(), snapshot.name, "Drone Video",
    { video: snapshot.settings as unknown as Record<string, unknown> }, files);
  projectLibrary!.markVideo(saved.id);
};
function showCustomBasemapPanel() {
  const config = savedCustomBasemap();
  if (config) {
    $<HTMLSelectElement>("#customBasemapType").value = config.type;
    $<HTMLInputElement>("#customBasemapUrl").value = config.url;
    $<HTMLInputElement>("#customBasemapMaxLevel").value = String(config.maximumLevel);
    $<HTMLInputElement>("#customBasemapCredit").value = config.credit;
  }
  $("#customBasemapPanel").classList.remove("hidden");
}

function showLocalBasemapPanel() {
  $("#customBasemapPanel").classList.add("hidden");
  $("#localBasemapPanel").classList.remove("hidden");
}

$("#basemap").addEventListener("change", () => {
  const kind = value("#basemap");
  if (kind === "custom" && !savedCustomBasemap()) {
    showCustomBasemapPanel();
    return;
  }
  if (kind === "local" && !localImagery) {
    showLocalBasemapPanel();
    return;
  }
  try { setBasemap(kind); }
  catch (error) { toast(error instanceof Error ? error.message : "底图加载失败", true); }
});
$("#configureBasemap").addEventListener("click", () => value("#basemap") === "local" ? showLocalBasemapPanel() : showCustomBasemapPanel());
$("#closeBasemapPanel").addEventListener("click", () => $("#customBasemapPanel").classList.add("hidden"));
$("#closeLocalBasemapPanel").addEventListener("click", () => $("#localBasemapPanel").classList.add("hidden"));
$("#customBasemapType").addEventListener("change", () => {
  const type = value("#customBasemapType");
  $("#customBasemapHint").textContent = type === "arcgis" ? "填写以 MapServer 结尾的服务地址，页面会自动补全瓦片路径。" : type === "tms" ? "TMS 地址填写 {z}/{x}/{y}，页面会自动反转 Y。" : "XYZ 地址需包含 {z}、{x}、{y}；也支持 {s} 子域占位符。";
});
$("#applyCustomBasemap").addEventListener("click", () => {
  const config: CustomBasemap = {
    type: value("#customBasemapType") as CustomBasemap["type"],
    url: value("#customBasemapUrl").trim(),
    maximumLevel: numeric("#customBasemapMaxLevel", 19),
    credit: value("#customBasemapCredit").trim() || "自定义影像",
  };
  try {
    customBasemapTemplate(config);
    localStorage.setItem(CUSTOM_BASEMAP_KEY, JSON.stringify(config));
    $<HTMLSelectElement>("#basemap").value = "custom";
    setBasemap("custom");
    $("#customBasemapPanel").classList.add("hidden");
    toast("自定义卫星底图已保存并应用");
  } catch (error) { toast(error instanceof Error ? error.message : "卫星底图配置无效", true); }
});
$("#localBasemapFile").addEventListener("change", () => {
  selectedLocalImageryFile = $<HTMLInputElement>("#localBasemapFile").files?.[0] ?? null;
  if (!selectedLocalImageryFile) return;
  lyrTileChoices = [];
  $("#lyrHistoryField").classList.add("hidden");
  $("#localBasemapSelection").textContent = `${selectedLocalImageryFile.name} · ${(selectedLocalImageryFile.size / 1024 / 1024).toFixed(2)} MB`;
  $("#localImageBounds").classList.toggle("hidden", /\.(mbtiles|tiff?|lyrx?)$/i.test(selectedLocalImageryFile.name));
});
$("#applyLocalBasemap").addEventListener("click", async () => {
  await projectLibrary?.ready;
  if (!selectedLocalImageryFile) return toast("请先选择已下载的影像文件", true);
  try {
    setStatus("正在读取本地卫星影像…");
    let sourceFile = selectedLocalImageryFile;
    let sourceBounds = {
      west: numeric("#localWest"), south: numeric("#localSouth"), east: numeric("#localEast"), north: numeric("#localNorth"),
    };
    if (/\.lyrx?$/i.test(sourceFile.name)) {
      if (sourceFile.name.toLowerCase().endsWith(".lyrx")) throw new Error("LYRX 需要解析其引用路径；请另存为旧版 LYR，或直接选择其引用的 GeoTIFF/影像文件");
      if (!lyrTileChoices.length) {
        const response = await fetch(`/__local_imagery/lyr?name=${encodeURIComponent(sourceFile.name)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: sourceFile });
        const inspected = await response.json() as { error?: string; kind?: string; name?: string; url?: string; extension?: string; bounds?: typeof sourceBounds; choices?: typeof lyrTileChoices };
        if (!response.ok) throw new Error(inspected.error || "LYR 解析失败");
        if (inspected.kind === "tiles" && inspected.choices?.length) {
          lyrTileChoices = inspected.choices;
          $<HTMLSelectElement>("#lyrHistoryChoice").innerHTML = lyrTileChoices.map((choice) => `<option value="${choice.id}">${choice.label}</option>`).join("");
          $("#lyrHistoryField").classList.remove("hidden");
          setStatus("Cesium 已就绪");
          toast(`已识别 ${lyrTileChoices.length} 个历史卫星影像版本，请选择版本后再次点击“读取并应用”`);
          return;
        }
        if (!inspected.url || !inspected.bounds) throw new Error(inspected.error || "LYR 没有可加载的栅格影像");
        sourceBounds = inspected.bounds;
        sourceFile = new File([await fetch(inspected.url).then((item) => item.blob())], `${inspected.name || sourceFile.name}${inspected.extension || ""}`, { type: "application/octet-stream" });
      } else {
        const selected = lyrTileChoices.find((choice) => choice.id === value("#lyrHistoryChoice")) ?? lyrTileChoices[0];
        const provider = new UrlTemplateImageryProvider({
          url: selected.url,
          maximumLevel: 23,
          credit: "Esri World Imagery Wayback",
          tileDiscardPolicy: new UnavailableMapTileDiscardPolicy(),
        });
        const result: LocalImageryResult = { provider, name: selected.label, rectangle: provider.rectangle, details: "LYR 历史影像瓦片", dispose: () => undefined };
        const saved = await projectLibrary!.save(crypto.randomUUID(), selected.label, "Imagery", { imageryUrl: selected.url },
          { source: { name: sourceFile.name, blob: sourceFile } });
        replaceLocalImagery(result);
        projectLibrary!.markImagery(saved.id);
        $<HTMLSelectElement>("#basemap").value = "local";
        $("#localBasemapPanel").classList.add("hidden");
        toast(`历史卫星底图已加载：${selected.label}`);
        return;
      }
    }
    const result = await loadLocalImagery(sourceFile, sourceBounds);
    let saved;
    try {
      saved = await projectLibrary!.save(crypto.randomUUID(), result.name, "Imagery", { bounds: sourceBounds },
        { source: { name: sourceFile.name, blob: sourceFile } });
    } catch (error) { result.dispose(); throw error; }
    replaceLocalImagery(result);
    projectLibrary!.markImagery(saved.id);
    $<HTMLSelectElement>("#basemap").value = "local";
    $("#localBasemapPanel").classList.add("hidden");
    viewer.camera.flyTo({ destination: result.rectangle, duration: 1.2 });
    toast(`本地底图已加载：${result.name}（${result.details}）`);
  } catch (error) { toast(error instanceof Error ? error.message : "本地影像读取失败", true); }
  finally { setStatus("Cesium 已就绪"); }
});
document.querySelectorAll<HTMLButtonElement>("[data-edit-mode]").forEach((button) => button.addEventListener("click", () => modelEditor.setMode(button.dataset.editMode as EditMode)));
$("#resetModelTransform").addEventListener("click", () => modelEditor.reset());

function locateImport(item: ImportRecord) {
  if (item.kind === "Model") viewer.camera.flyToBoundingSphere((item.resource as Model).boundingSphere, { duration: 1.2 });
  else if (item.kind === "CAD" && item.representation === "primitive" && item.boundingSphere) viewer.camera.flyToBoundingSphere(item.boundingSphere, { duration: 1.2 });
  else void viewer.flyTo(item.resource as never);
}

function renderLayers() {
  projectLibrary?.render();
  safetyWorkspace?.layersChanged();
  if (digitalTwinSyncReady) scheduleDigitalTwinSync();
  scheduleElectronicSandTableRefresh();
  const root = $("#layers");
  if (!imports.length) { root.className = "layers-empty"; root.textContent = "尚未加载工程数据"; return; }
  root.className = "layers-list";
  root.innerHTML = imports.map((item) => `<div class="layer-row${item.visible ? "" : " layer-hidden"}" data-id="${item.id}" data-visible="${item.visible}"><span class="layer-badge">${item.kind === "CAD" ? "CAD" : item.kind === "GIS" ? "GIS" : item.kind === "Model" ? "MOD" : "3D"}</span><span class="layer-name"></span><button class="visibility" title="${item.visible ? "隐藏图层" : "显示图层"}" aria-label="${item.visible ? "隐藏图层" : "显示图层"}" aria-pressed="${item.visible}">${item.visible ? "◉" : "○"}</button><button class="fly" title="${item.visible ? "定位" : "请先显示图层"}" ${item.visible ? "" : "disabled"}>◎</button><button class="remove" title="移除">×</button></div>`).join("");
  root.querySelectorAll<HTMLElement>(".layer-row").forEach((row) => {
    const item = imports.find((candidate) => candidate.id === row.dataset.id)!;
    const name = row.querySelector<HTMLElement>(".layer-name")!;
    name.textContent = item.name;
    name.title = item.name;
    if (item.kind === "3D Tiles") {
      const status = document.createElement("small"); status.className = "layer-quality-status";
      status.style.display = "block"; status.style.fontSize = "12px";
      status.textContent = modelQualityTrackers.get(item.id)?.getState().label ?? "首屏加载中";
      name.append(status);
    }
    row.querySelector(".visibility")?.addEventListener("click", () => setImportVisibility(item, !item.visible));
    row.querySelector(".fly")?.addEventListener("click", () => locateImport(item));
    name.addEventListener("click", () => item.kind === "Model" && item.visible && modelEditor.select(item.id));
    row.querySelector(".remove")?.addEventListener("click", () => {
      if (projectLibrary?.records.has(item.id)) void projectLibrary.delete(item.id);
      else removeImport(item);
    });
  });
}

function setImportVisibility(item: ImportRecord, visible: boolean, options: { silent?: boolean; deferRender?: boolean } = {}) {
  item.visible = visible;
  projectLibrary?.queueUpdate(item.id, { visible });
  if (item.kind === "3D Tiles") {
    (item.resource as Cesium3DTileset).show = visible;
    modelQualityTrackers.get(item.id)?.invalidateView();
    videoArFusion.invalidateProjection("model-visibility-changed");
  }
  else if (item.kind === "Model") {
    (item.resource as Model).show = visible;
    if (!visible) modelEditor.select(null);
  } else {
    (item.resource as { show: boolean }).show = visible;
  }
  viewer.scene.requestRender();
  if (!options.deferRender) renderLayers();
  if (!options.silent) toast(`${item.name} 已${visible ? "显示" : "隐藏"}`);
}

function removeImport(item: ImportRecord) {
  subsurfaceTools.detachImport(item);
  if (item.kind === "3D Tiles") {
    disposeModelQuality(item.id, item.resource as Cesium3DTileset);
    videoArFusion.invalidateProjection("model-removed");
    for (const [source, id] of tilesetSourceIds) if (id === item.id) tilesetSourceIds.delete(source);
    viewer.scene.primitives.remove(item.resource as Cesium3DTileset);
  }
  else if (item.kind === "Model") { modelEditor.remove(item.id); viewer.scene.primitives.remove(item.resource as Model); }
  else if (item.kind === "CAD" && item.representation === "primitive") {
    viewer.scene.primitives.remove(item.resource as PrimitiveCollection);
  }
  else {
    viewer.dataSources.remove(item.resource as never, true);
  }
  const removeIndex = imports.indexOf(item);
  if (removeIndex >= 0) imports.splice(removeIndex, 1);
  subsurfaceTools.refreshClipping();
  renderLayers();
  toast(`已移除 ${item.name}`);
}

function addImport(
  name: string,
  kind: ImportRecord["kind"],
  resource: unknown,
  id: string = crypto.randomUUID(),
  metadata: Pick<ImportRecord, "representation" | "boundingSphere"> = {},
) {
  imports.push({ id, name, kind, resource, visible: true, adjustable: kind === "Model", ...metadata });
  if (kind === "3D Tiles") { trackModelQuality(id, name, resource as Cesium3DTileset); videoArFusion.invalidateProjection("model-added-or-restored"); }
  subsurfaceTools?.refreshClipping();
  renderLayers();
  return id;
}

async function cacheGisBoundingSphere(
  importId: string,
  dataSource: GeoJsonDataSource | KmlDataSource | CzmlDataSource,
) {
  try {
    viewer.scene.requestRender();
    const entities = dataSource.entities.values;
    const display = viewer.dataSourceDisplay as unknown as {
      getBoundingSphere?: (entity: unknown, allowPartial: boolean, result: BoundingSphere) => number;
    };
    if (!display.getBoundingSphere) return;
    const stride = Math.max(1, Math.ceil(entities.length / 1_500));
    const spheres: BoundingSphere[] = [];
    for (let attempt = 0; attempt < 2 && !spheres.length; attempt += 1) {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      for (let index = 0; index < entities.length; index += stride) {
        const result = new BoundingSphere();
        try {
          if (display.getBoundingSphere(entities[index], true, result) === 0) {
            spheres.push(result);
          }
        } catch {
          // Unsupported or time-dynamic entities remain available in the GIS layer.
        }
        if (index > 0 && index % (stride * 300) === 0) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
      }
    }
    let cachedSphere = spheres.length ? BoundingSphere.fromBoundingSpheres(spheres) : undefined;
    if (!cachedSphere) {
      const time = viewer.clock.currentTime;
      const positions: Cartesian3[] = [];
      const appendPositions = (values: readonly Cartesian3[] | undefined) => {
        if (!values) return;
        for (const position of values) {
          if (positions.length >= 12_000) return;
          if (position && Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z)) positions.push(position);
        }
      };
      for (let index = 0; index < entities.length && positions.length < 12_000; index += stride) {
        const entity = entities[index];
        const point = entity.position?.getValue(time);
        if (point) appendPositions([point]);
        appendPositions(entity.polyline?.positions?.getValue(time));
        appendPositions(entity.wall?.positions?.getValue(time));
        appendPositions(entity.corridor?.positions?.getValue(time));
        appendPositions(entity.polylineVolume?.positions?.getValue(time));
        const hierarchy = entity.polygon?.hierarchy?.getValue(time);
        if (hierarchy) {
          const pending = [hierarchy];
          while (pending.length && positions.length < 12_000) {
            const current = pending.pop();
            if (!current) continue;
            appendPositions(current.positions);
            pending.push(...current.holes);
          }
        }
        const rectangle = entity.rectangle?.coordinates?.getValue(time);
        if (rectangle) {
          appendPositions([
            Cartesian3.fromRadians(rectangle.west, rectangle.south),
            Cartesian3.fromRadians(rectangle.east, rectangle.south),
            Cartesian3.fromRadians(rectangle.east, rectangle.north),
            Cartesian3.fromRadians(rectangle.west, rectangle.north),
          ]);
        }
      }
      if (positions.length) cachedSphere = BoundingSphere.fromPoints(positions);
    }
    if (!cachedSphere) return;
    const item = imports.find((candidate) => candidate.id === importId && candidate.resource === dataSource);
    if (!item) return;
    item.boundingSphere = cachedSphere;
    scheduleElectronicSandTableRefresh();
  } catch (error) {
    console.warn("[Electronic sand table] GIS range cache skipped", error);
  }
}

const subsurfaceTools = new SubsurfaceTools(viewer, () => imports, toast);
const foundationPitMonitoring = new FoundationPitMonitoring(viewer, toast);
let markupTools: MarkupTools | null = null;
try {
  markupTools = new MarkupTools(viewer, toast, {
    prepareForDrawing: () => {
      let resumeModelEditing: () => void = () => undefined;
      let resumeSubsurfaceInteraction: () => void = () => undefined;
      let resumeFoundationPitInteraction: () => void = () => undefined;
      const subsurfacePanel = $("#subsurfacePanel");
      const subsurfacePanelWasHidden = subsurfacePanel.classList.contains("hidden");
      let restored = false;
      const restoreAll = () => {
        if (restored) return;
        restored = true;
        if (!subsurfacePanelWasHidden) subsurfacePanel.classList.remove("hidden");
        try { resumeFoundationPitInteraction(); } catch (error) { console.warn("[Markup] Unable to restore pit interaction", error); }
        try { resumeSubsurfaceInteraction(); } catch (error) { console.warn("[Markup] Unable to restore subsurface interaction", error); }
        try { resumeModelEditing(); } catch (error) { console.warn("[Markup] Unable to restore model interaction", error); }
      };
      try {
        resumeModelEditing = modelEditor.suspendInteractions();
        resumeSubsurfaceInteraction = subsurfaceTools.suspendInteractions();
        resumeFoundationPitInteraction = foundationPitMonitoring.suspendInteractions();
        subsurfacePanel.classList.add("hidden");
      } catch (error) {
        restoreAll();
        throw error;
      }
      return restoreAll;
    },
  });
} catch (error) {
  console.error("[Markup] Module initialization failed without affecting the engineering scene", error);
  const markupTab = document.querySelector<HTMLButtonElement>('.tab[data-tab="markup"]');
  if (markupTab) {
    markupTab.disabled = true;
    markupTab.title = "标绘模块初始化失败，请刷新页面后重试";
  }
  const markupWorkspaceButton = document.querySelector<HTMLButtonElement>("#openMarkupWorkspace");
  if (markupWorkspaceButton) {
    markupWorkspaceButton.disabled = true;
    markupWorkspaceButton.title = "标绘模块初始化失败，请刷新页面后重试";
  }
  const status = document.getElementById("markupStatus");
  if (status) status.textContent = "标绘模块初始化失败；其他现有功能不受影响。";
}
let threeDReport: ThreeDReport | null = null;
try {
  threeDReport = new ThreeDReport(viewer, toast, {
  capture: () => ({
    basemap: $<HTMLSelectElement>("#basemap").value,
    layers: imports.map((item) => ({ id: item.id, name: item.name, kind: item.kind, visible: item.visible })),
  }),
  apply: (snapshot) => {
    let layerListChanged = false;
    for (const saved of snapshot.layers) {
      const item = imports.find((candidate) => candidate.id === saved.id)
        ?? imports.find((candidate) => candidate.name === saved.name && candidate.kind === saved.kind);
      if (!item || item.visible === saved.visible) continue;
      const resource = item.resource as { isDestroyed?: () => boolean };
      if (resource.isDestroyed?.()) continue;
      try {
        setImportVisibility(item, saved.visible, { silent: true, deferRender: true });
        layerListChanged = true;
      } catch (error) {
        console.warn("[3D report] Skipped an unavailable layer while restoring a scene", item.name, error);
      }
    }
    if (layerListChanged) renderLayers();
    if (snapshot.basemap) {
      const select = $<HTMLSelectElement>("#basemap");
      const available = Array.from(select.options).some((option) => option.value === snapshot.basemap);
      const usable = snapshot.basemap !== "local" || localImagery !== null;
      const configured = snapshot.basemap !== "custom" || savedCustomBasemap() !== null;
      if (available && usable && configured && select.value !== snapshot.basemap) {
        select.value = snapshot.basemap;
        setBasemap(snapshot.basemap);
      }
    }
  },
    prepareForPicking: () => {
      subsurfaceTools.cancelActiveInteraction();
      modelEditor.select(null);
      $("#subsurfacePanel").classList.add("hidden");
    },
    beginSession: () => {
      const resumeModelEditing = modelEditor.suspendInteractions();
      const resumeSubsurfaceInteraction = subsurfaceTools.suspendInteractions();
      return () => {
        resumeSubsurfaceInteraction();
        resumeModelEditing();
      };
    },
  });
} catch (error) {
  console.error("[3D report] Module initialization failed without affecting the engineering scene", error);
  const reportTab = document.querySelector<HTMLButtonElement>('.tab[data-tab="report"]');
  if (reportTab) {
    reportTab.disabled = true;
    reportTab.title = "3维汇报模块初始化失败，请刷新页面后重试";
  }
  const status = document.getElementById("reportStatus");
  if (status) {
    status.textContent = "3维汇报模块初始化失败；CAD、倾斜摄影、底图、基坑等现有功能不受影响。";
    status.classList.add("error");
  }
}

function sandTableBoundingSphere() {
  const spheres: BoundingSphere[] = [];
  for (const item of imports) {
    if (!item.visible) continue;
    const resource = item.resource as { isDestroyed?: () => boolean; boundingSphere?: BoundingSphere };
    try {
      if (resource.isDestroyed?.()) continue;
      const sphere = item.boundingSphere
        ?? (item.kind === "3D Tiles" || item.kind === "Model" ? resource.boundingSphere : undefined);
      if (
        !sphere
        || !Number.isFinite(sphere.center.x)
        || !Number.isFinite(sphere.center.y)
        || !Number.isFinite(sphere.center.z)
        || !Number.isFinite(sphere.radius)
        || sphere.radius < 0
      ) continue;
      spheres.push(sphere);
    } catch {
      // A resource can finish disposal between the visibility check and this read.
    }
  }
  return spheres.length ? BoundingSphere.fromBoundingSpheres(spheres) : undefined;
}

function sandTableProjectArea() {
  const sphere = sandTableBoundingSphere();
  if (!sphere) return undefined;
  const center = Cartographic.fromCartesian(sphere.center);
  if (
    !center
    || !Number.isFinite(center.longitude)
    || !Number.isFinite(center.latitude)
    || !Number.isFinite(sphere.radius)
  ) return undefined;
  const radiusMeters = sphere.radius * 1.2;
  return {
    longitude: CesiumMath.toDegrees(center.longitude),
    latitude: CesiumMath.toDegrees(center.latitude),
    radiusMeters: Math.max(20, radiusMeters),
  };
}

function focusSandTableScene(mode: SandTableFocusMode) {
  if (document.body.classList.contains("report-presentation-mode")) {
    toast("请先退出3维汇报演示，再切换电子沙盘视角", true);
    return;
  }
  if (viewer.scene.mode !== SceneMode.SCENE3D || viewer.scene.morphTime !== 1) {
    toast("电子沙盘快捷视角仅在三维模式可用，请先切换到三维地球", true);
    return;
  }
  viewer.camera.cancelFlight();
  if (mode === "home") {
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(105, 35, 18_000_000),
      orientation: { heading: 0, pitch: -CesiumMath.PI_OVER_TWO, roll: 0 },
      duration: 1.3,
    });
    return;
  }
  const sphere = sandTableBoundingSphere();
  if (!sphere) {
    const fallback = [...imports].reverse().find((item) => item.visible);
    if (fallback) locateImport(fallback);
    else focusSandTableScene("home");
    return;
  }
  if (mode === "fit") {
    viewer.camera.flyToBoundingSphere(sphere, { duration: 1.3 });
    return;
  }
  const centerCartographic = Cartographic.fromCartesian(sphere.center);
  const terrainHeight = centerCartographic ? viewer.scene.globe.getHeight(centerCartographic) : undefined;
  const focusSphere = centerCartographic
    ? new BoundingSphere(
      Cartesian3.fromRadians(
        centerCartographic.longitude,
        centerCartographic.latitude,
        Number.isFinite(terrainHeight) ? terrainHeight as number : 0,
      ),
      sphere.radius,
    )
    : sphere;
  const radius = Math.max(25, sphere.radius);
  const offset = mode === "top"
    ? new HeadingPitchRange(0, -CesiumMath.PI_OVER_TWO + 0.001, radius * 2.35)
    : new HeadingPitchRange(CesiumMath.toRadians(42), CesiumMath.toRadians(-38), radius * 2.75);
  viewer.camera.flyToBoundingSphere(focusSphere, { duration: 1.3, offset });
}

try {
  electronicSandTable = new ElectronicSandTable(viewer, {
    getLayers: () => imports.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      visible: item.visible,
    })),
    setLayerVisibility: (id, visible) => {
      const item = imports.find((candidate) => candidate.id === id);
      if (!item) throw new Error("图层已从当前场景移除");
      const resource = item.resource as { isDestroyed?: () => boolean };
      if (resource.isDestroyed?.()) throw new Error("图层资源已释放");
      if (item.visible !== visible) setImportVisibility(item, visible, { silent: true });
    },
    locateLayer: (id) => {
      const item = imports.find((candidate) => candidate.id === id);
      if (!item) throw new Error("图层已从当前场景移除");
      const resource = item.resource as { isDestroyed?: () => boolean };
      if (resource.isDestroyed?.()) throw new Error("图层资源已释放");
      if (!item.visible) setImportVisibility(item, true, { silent: true });
      locateImport(item);
    },
    focusScene: focusSandTableScene,
  });
} catch (error) {
  console.error("[Electronic sand table] Module initialization failed without affecting the scene", error);
  const tab = document.querySelector<HTMLButtonElement>('.tab[data-tab="sandtable"]');
  if (tab) {
    tab.disabled = true;
    tab.title = "电子沙盘初始化失败，请刷新页面后重试";
  }
  const status = document.getElementById("sandTableStatus");
  if (status) status.textContent = "电子沙盘初始化失败；其他现有功能不受影响。";
}

try {
  sandTableFacilities = new SandTableFacilities(viewer, {
    projectId: "current-digital-twin-project",
    beginInteractionSession: () => {
      const resumes: Array<() => void> = [];
      let restored = false;
      const restoreAll = () => {
        if (restored) return;
        restored = true;
        for (let index = resumes.length - 1; index >= 0; index -= 1) {
          try { resumes[index](); }
          catch (error) { console.warn("[Sand facilities] Unable to restore an interaction owner", error); }
        }
      };
      try {
        resumes.push(modelEditor.suspendInteractions());
        resumes.push(subsurfaceTools.suspendInteractions());
        resumes.push(foundationPitMonitoring.suspendInteractions());
        const resumeMarkup = markupTools?.suspendInteractions();
        if (resumeMarkup) resumes.push(resumeMarkup);
      } catch (error) {
        restoreAll();
        throw error;
      }
      return restoreAll;
    },
    stopCameraMotion: () => {
      electronicSandTable?.stopTour();
      try { viewer.camera.cancelFlight(); } catch { /* No active camera flight. */ }
    },
    toast,
  });
} catch (error) {
  console.error("[Sand facilities] Module initialization failed without affecting the scene", error);
  const status = document.getElementById("sandFacilityStatus");
  if (status) {
    status.textContent = "施工场布初始化失败；电子沙盘和其他模块仍可继续使用。";
    status.classList.add("error");
  }
}

try {
  sandTableProjectControl = new SandTableProjectControl({
    getLayers: () => imports.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      visible: item.visible,
    })),
    locateLayer: (id) => {
      const item = imports.find((candidate) => candidate.id === id);
      if (!item) throw new Error("关联图层已从当前场景移除");
      const resource = item.resource as { isDestroyed?: () => boolean };
      if (resource.isDestroyed?.()) throw new Error("关联图层资源已释放");
      if (!item.visible) setImportVisibility(item, true, { silent: true });
      locateImport(item);
    },
  });
} catch (error) {
  console.error("[Sand table project control] Module initialization failed without affecting the scene", error);
  const status = document.getElementById("sandProjectControlStatus");
  if (status) {
    status.textContent = "项目管控初始化失败；电子沙盘和其他现有功能不受影响。";
    status.classList.add("error");
  }
}

const DIGITAL_TWIN_PROJECT_ID = "current-project";
const DIGITAL_TWIN_BASEMAP_ID = "platform:basemap";
const digitalTwinDataCenter = new DigitalTwinDataCenter();
const digitalTwinUnsubscribers: Array<() => void> = [];
let digitalTwinOverview: DigitalTwinOverview;
let digitalTwinSyncTimer = 0;

const DIGITAL_TWIN_RESOURCE_LABELS: Readonly<Record<DigitalTwinDataResource["type"], string>> = {
  CAD: "CAD 图纸",
  "3D Tiles": "倾斜摄影",
  GIS: "GIS 数据",
  Model: "工程模型",
  "Drone Video": "历史视频记录",
  Imagery: "底图影像",
  Document: "工程文档",
  Other: "其他数据",
};

const DIGITAL_TWIN_MARKUP_LABELS: Readonly<Record<string, string>> = {
  point: "点标绘",
  text: "文字标绘",
  label: "标签",
  polyline: "线标绘",
  polygon: "面标绘",
  rectangle: "矩形标绘",
  circle: "圆形标绘",
  facade: "立面标绘",
  volume: "体标绘",
};

function activeBasemapName() {
  const select = $<HTMLSelectElement>("#basemap");
  return select.selectedOptions[0]?.textContent?.trim() || (activeBasemapKey === "none" ? "无底图" : "当前底图");
}

function initializeDigitalTwinProject(): DigitalTwinProject {
  const restored = digitalTwinDataCenter.getProject(DIGITAL_TWIN_PROJECT_ID);
  if (restored) return restored;
  return digitalTwinDataCenter.upsertProject({
    id: DIGITAL_TWIN_PROJECT_ID,
    name: "当前工程数字孪生项目",
    type: "infrastructure",
    status: "active",
    description: "统一管理当前工作区中的工程图层、标绘、监测、档案和3维汇报元数据。",
    tags: ["数字孪生", "工程项目"],
  });
}

function fillDigitalTwinProjectForm(project: DigitalTwinProject) {
  $<HTMLInputElement>("#digitalTwinProjectName").value = project.name;
  $<HTMLSelectElement>("#digitalTwinProjectType").value = project.type;
  $<HTMLSelectElement>("#digitalTwinProjectStatus").value = project.status;
  $<HTMLInputElement>("#digitalTwinProjectOwner").value = project.owner;
  $<HTMLInputElement>("#digitalTwinProjectLocation").value = typeof project.metadata.location === "string" ? project.metadata.location : "";
  $<HTMLTextAreaElement>("#digitalTwinProjectDescription").value = project.description;
}

function digitalTwinResourceInputs(): DataResourceInput[] {
  const resources = imports.map((item) => dataResourceFromImport(item, DIGITAL_TWIN_PROJECT_ID));
  const basemapVisible = activeBasemapKey !== "none";
  resources.push({
    id: DIGITAL_TWIN_BASEMAP_ID,
    name: activeBasemapName(),
    type: "Imagery",
    status: basemapVisible ? "ready" : "hidden",
    visible: basemapVisible,
    projectId: DIGITAL_TWIN_PROJECT_ID,
    description: basemapVisible ? "当前数字地球底图" : "当前已关闭底图显示",
    tags: ["底图", activeBasemapKey || "street"],
    metadata: {
      sourceType: activeBasemapKey || "street",
      localFile: activeBasemapKey === "local",
    },
  });
  return resources;
}

function digitalTwinBusinessInputs(): BusinessRecordInput[] {
  const records: BusinessRecordInput[] = [];
  const markupSnapshot = markupTools?.getOverviewSnapshot();
  for (const item of markupSnapshot?.items ?? []) {
    records.push({
      id: `markup:${item.id}`,
      name: item.name,
      type: "other",
      status: "open",
      projectId: DIGITAL_TWIN_PROJECT_ID,
      recordedAt: item.updatedAt,
      updatedAt: item.updatedAt,
      tags: ["标绘", DIGITAL_TWIN_MARKUP_LABELS[item.kind] ?? item.kind],
      metadata: { module: "markup", kind: item.kind, visible: item.visible },
    });
  }

  const pitSnapshot = foundationPitMonitoring.getOverviewSnapshot();
  for (const item of pitSnapshot.items) {
    records.push({
      id: `pit:${item.id}`,
      name: item.name,
      type: "monitoring",
      status: item.alarmCount > 0 ? "open" : "in-progress",
      projectId: DIGITAL_TWIN_PROJECT_ID,
      ...(item.updatedAt ? { recordedAt: item.updatedAt, updatedAt: item.updatedAt } : {}),
      tags: ["基坑监测", item.enclosureType],
      metadata: {
        module: "foundationPit",
        visible: item.visible,
        enclosureType: item.enclosureType,
        monitoringCount: item.monitoringCount,
        normalCount: item.normalCount,
        warningCount: item.warningCount,
        alarmCount: item.alarmCount,
        unmeasuredCount: item.unmeasuredCount,
      },
    });
  }

  const archiveSnapshot = subsurfaceTools.getArchiveOverviewSnapshot();
  for (const item of archiveSnapshot.items) {
    records.push({
      id: `archive:${item.id}`,
      name: item.name,
      type: "inspection",
      status: "closed",
      projectId: DIGITAL_TWIN_PROJECT_ID,
      recordedAt: item.updatedAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      tags: ["隐蔽工程", "坐标档案"],
      metadata: {
        module: "hiddenWorkArchive",
        location: item.location,
        longitude: item.longitude,
        latitude: item.latitude,
        altitude: item.altitude,
        beforePhotoCount: item.beforePhotoCount,
        afterPhotoCount: item.afterPhotoCount,
      },
    });
  }

  const reportSnapshot = threeDReport?.getOverviewSnapshot();
  for (const page of reportSnapshot?.pages ?? []) {
    records.push({
      id: `report:${page.id}`,
      name: page.title || `第 ${page.index} 页`,
      type: "report",
      status: page.hasScene ? "in-progress" : "open",
      projectId: DIGITAL_TWIN_PROJECT_ID,
      tags: ["3维汇报", page.hasScene ? "已绑定场景" : "未绑定场景"],
      metadata: {
        module: "threeDReport",
        pageIndex: page.index,
        hasScene: page.hasScene,
        annotationCount: page.annotationCount,
      },
    });
  }

  const sandTableSnapshot = electronicSandTable?.getOverviewSnapshot();
  for (const viewpoint of sandTableSnapshot?.viewpoints ?? []) {
    records.push({
      id: `sandtable:${viewpoint.id}`,
      name: viewpoint.name,
      type: "other",
      status: "open",
      projectId: DIGITAL_TWIN_PROJECT_ID,
      recordedAt: viewpoint.createdAt,
      createdAt: viewpoint.createdAt,
      updatedAt: viewpoint.createdAt,
      tags: ["电子沙盘", "收藏视点"],
      metadata: {
        module: "electronicSandTable",
        tourState: sandTableSnapshot?.tourState ?? "stopped",
      },
    });
  }

  const projectControlSnapshot = sandTableProjectControl?.getOverviewSnapshot();
  const today = currentLocalDateKey();
  for (const task of projectControlSnapshot?.tasks ?? []) {
    const delayed = task.status !== "completed" && task.progress < 100 && task.planEnd < today;
    records.push({
      id: `progress:${task.id}`,
      name: task.name,
      type: "other",
      status: task.status === "completed" ? "closed" : task.status === "in-progress" ? "in-progress" : "open",
      projectId: DIGITAL_TWIN_PROJECT_ID,
      ...(task.layerId ? { resourceId: task.layerId } : {}),
      recordedAt: task.updatedAt,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      description: task.notes,
      tags: ["电子沙盘", "项目进度", delayed ? "已延期" : task.status],
      metadata: {
        module: "sandTableProjectControl",
        recordKind: "progress",
        progress: task.progress,
        weight: task.weight,
        planStart: task.planStart,
        planEnd: task.planEnd,
        taskStatus: task.status,
        owner: task.owner,
        layerId: task.layerId,
        delayed,
      },
    });
  }
  for (const risk of projectControlSnapshot?.risks ?? []) {
    const active = risk.status === "open" || risk.status === "handling";
    const overdue = active && risk.dueDate < today;
    records.push({
      id: `risk:${risk.id}`,
      name: risk.name,
      type: "issue",
      status: risk.status === "handling" ? "in-progress" : risk.status,
      projectId: DIGITAL_TWIN_PROJECT_ID,
      ...(risk.layerId ? { resourceId: risk.layerId } : {}),
      recordedAt: risk.updatedAt,
      createdAt: risk.createdAt,
      updatedAt: risk.updatedAt,
      description: risk.description,
      tags: ["电子沙盘", "风险管控", risk.category, risk.level],
      metadata: {
        module: "sandTableProjectControl",
        recordKind: "risk",
        riskLevel: risk.level,
        riskStatus: risk.status,
        category: risk.category,
        owner: risk.owner,
        dueDate: risk.dueDate,
        layerId: risk.layerId,
        overdue,
        active,
        hasMeasure: Boolean(risk.measure),
      },
    });
  }
  return records;
}

function metadataNumber(record: DigitalTwinBusinessRecord, key: string) {
  const value = record.metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function metadataBoolean(record: DigitalTwinBusinessRecord, key: string, fallback = true) {
  const value = record.metadata[key];
  return typeof value === "boolean" ? value : fallback;
}

function currentLocalDateKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function dataResourceOverviewRecord(resource: DigitalTwinDataResource): DigitalTwinResourceRecord {
  const type = resource.type === "3D Tiles" ? "tiles" : resource.type.toLocaleLowerCase();
  return {
    id: `catalog:resource:${resource.id}`,
    name: resource.name,
    type,
    typeLabel: DIGITAL_TWIN_RESOURCE_LABELS[resource.type],
    health: resource.status === "error" ? "alarm" : resource.status === "loading" ? "warning" : resource.status === "archived" ? "offline" : "healthy",
    description: resource.description || (resource.visible ? "已接入当前三维场景" : "当前已隐藏"),
    source: resource.id === DIGITAL_TWIN_BASEMAP_ID ? "数字地球底图" : "工程图层目录",
    updatedAt: resource.updatedAt,
    visible: resource.visible,
    tags: resource.tags,
  };
}

function businessOverviewRecord(record: DigitalTwinBusinessRecord): DigitalTwinResourceRecord {
  if (record.id.startsWith("markup:")) {
    const kind = typeof record.metadata.kind === "string" ? record.metadata.kind : "other";
    return {
      id: `catalog:business:${record.id}`,
      name: record.name,
      type: "markup",
      typeLabel: DIGITAL_TWIN_MARKUP_LABELS[kind] ?? "标绘对象",
      health: "healthy",
      description: "场景空间标绘",
      source: "标绘模块",
      updatedAt: record.updatedAt,
      visible: metadataBoolean(record, "visible"),
      tags: record.tags,
    };
  }
  if (record.id.startsWith("pit:")) {
    const alarmCount = metadataNumber(record, "alarmCount");
    const warningCount = metadataNumber(record, "warningCount");
    const enclosureType = typeof record.metadata.enclosureType === "string" ? record.metadata.enclosureType : "基坑围护";
    return {
      id: `catalog:business:${record.id}`,
      name: record.name,
      type: "monitoring",
      typeLabel: "基坑监测",
      health: alarmCount > 0 ? "alarm" : warningCount > 0 ? "warning" : "healthy",
      description: `${enclosureType} · ${metadataNumber(record, "monitoringCount")} 项监测`,
      source: "基坑监测模块",
      updatedAt: record.updatedAt,
      visible: metadataBoolean(record, "visible"),
      tags: record.tags,
    };
  }
  if (record.id.startsWith("archive:")) {
    const location = typeof record.metadata.location === "string" && record.metadata.location ? record.metadata.location : "未填写位置说明";
    return {
      id: `catalog:business:${record.id}`,
      name: record.name,
      type: "archive",
      typeLabel: "隐蔽工程档案",
      health: "healthy",
      description: `${location} · 前/后照片 ${metadataNumber(record, "beforePhotoCount")}/${metadataNumber(record, "afterPhotoCount")} 张`,
      source: "隐蔽工程档案",
      updatedAt: record.updatedAt,
      tags: record.tags,
    };
  }
  if (record.id.startsWith("progress:")) {
    const progress = metadataNumber(record, "progress");
    const delayed = metadataBoolean(record, "delayed", false);
    const owner = typeof record.metadata.owner === "string" && record.metadata.owner ? record.metadata.owner : "未指定责任人";
    const planEnd = typeof record.metadata.planEnd === "string" ? record.metadata.planEnd : "-";
    const taskStatus = typeof record.metadata.taskStatus === "string" ? record.metadata.taskStatus : "not-started";
    return {
      id: `catalog:business:${record.id}`,
      name: record.name,
      type: "progress",
      typeLabel: "项目进度",
      health: delayed ? "alarm" : taskStatus === "paused" ? "warning" : "healthy",
      description: `完成 ${progress}% · 计划完成 ${planEnd} · ${owner}`,
      source: "电子沙盘·项目进度",
      updatedAt: record.updatedAt,
      tags: record.tags,
    };
  }
  if (record.id.startsWith("risk:")) {
    const active = metadataBoolean(record, "active", false);
    const overdue = metadataBoolean(record, "overdue", false);
    const riskLevel = typeof record.metadata.riskLevel === "string" ? record.metadata.riskLevel : "medium";
    const category = typeof record.metadata.category === "string" ? record.metadata.category : "其他";
    const dueDate = typeof record.metadata.dueDate === "string" ? record.metadata.dueDate : "-";
    const health = !active ? "healthy" : riskLevel === "critical" || overdue ? "alarm" : "warning";
    return {
      id: `catalog:business:${record.id}`,
      name: record.name,
      type: "risk",
      typeLabel: "风险管控",
      health,
      description: `${category} · ${riskLevel === "critical" ? "重大" : riskLevel === "high" ? "高" : riskLevel === "medium" ? "一般" : "低"}风险 · 整改期限 ${dueDate}${overdue ? " · 已逾期" : ""}`,
      source: "电子沙盘·风险管控",
      updatedAt: record.updatedAt,
      tags: record.tags,
    };
  }
  if (record.id.startsWith("sandtable:")) {
    return {
      id: `catalog:business:${record.id}`,
      name: record.name,
      type: "sandtable",
      typeLabel: "电子沙盘视点",
      health: "healthy",
      description: "已收藏的工程展示视角，可直接定位或加入自动巡游",
      source: "电子沙盘模块",
      updatedAt: record.updatedAt,
      tags: record.tags,
    };
  }
  const pageIndex = metadataNumber(record, "pageIndex");
  return {
    id: `catalog:business:${record.id}`,
    name: record.name,
    type: record.id.startsWith("report:") ? "report" : "other",
    typeLabel: record.id.startsWith("report:") ? "3维汇报页" : "业务记录",
    health: record.status === "archived" ? "offline" : "healthy",
    description: record.id.startsWith("report:")
      ? `第 ${pageIndex || "-"} 页 · ${metadataBoolean(record, "hasScene", false) ? "已绑定三维场景" : "尚未绑定场景"} · ${metadataNumber(record, "annotationCount")} 个空间标注`
      : record.description,
    source: record.id.startsWith("report:") ? "3维汇报模块" : "统一数据中心",
    updatedAt: record.updatedAt,
    tags: record.tags,
  };
}

function buildDigitalTwinOverviewSnapshot(): DigitalTwinOverviewSnapshot {
  const project = digitalTwinDataCenter.getProject(DIGITAL_TWIN_PROJECT_ID);
  const resources = digitalTwinDataCenter
    .queryResources({ projectId: DIGITAL_TWIN_PROJECT_ID })
    .filter((resource) => resource.type !== "Drone Video")
    .map(dataResourceOverviewRecord);
  const businessRecords = digitalTwinDataCenter.queryBusinessRecords({ projectId: DIGITAL_TWIN_PROJECT_ID }).map(businessOverviewRecord);
  const pitSnapshot = foundationPitMonitoring.getOverviewSnapshot();
  const projectControlSnapshot = sandTableProjectControl?.getOverviewSnapshot();
  const activeControlRisks = projectControlSnapshot?.risks.filter((risk) => risk.status === "open" || risk.status === "handling") ?? [];
  const today = currentLocalDateKey();
  const controlRiskAlarms = activeControlRisks.filter((risk) => risk.level === "critical" || risk.dueDate < today).length;
  const controlRiskWarnings = activeControlRisks.length - controlRiskAlarms;
  const delayedTasks = projectControlSnapshot?.delayedTasks ?? 0;
  const criticalAlerts = pitSnapshot.alarm + controlRiskAlarms + delayedTasks;
  const warningAlerts = pitSnapshot.warning + controlRiskWarnings;
  const activeAlerts = criticalAlerts + warningAlerts;
  return {
    projectName: project?.name || "当前工程数字孪生项目",
    generatedAt: new Date().toISOString(),
    resources: [...resources, ...businessRecords],
    alerts: {
      active: activeAlerts,
      critical: criticalAlerts,
      warning: warningAlerts,
      message: activeAlerts
        ? `基坑监测 ${pitSnapshot.alarm + pitSnapshot.warning} 项、延期任务 ${delayedTasks} 项、活动风险 ${activeControlRisks.length} 项需要关注。`
        : "当前没有活动预警。",
    },
  };
}

function updateDigitalTwinSidebar() {
  const markupSnapshot = markupTools?.getOverviewSnapshot();
  const pitSnapshot = foundationPitMonitoring.getOverviewSnapshot();
  const archiveSnapshot = subsurfaceTools.getArchiveOverviewSnapshot();
  const projectControlSnapshot = sandTableProjectControl?.getOverviewSnapshot();
  $("#digitalTwinLayerCount").textContent = String(imports.length);
  $("#digitalTwinVisibleCount").textContent = String(imports.filter((item) => item.visible).length);
  $("#digitalTwinMarkupCount").textContent = String(markupSnapshot?.total ?? 0);
  $("#digitalTwinPitCount").textContent = String(pitSnapshot.pits);
  $("#digitalTwinAlertCount").textContent = String(
    pitSnapshot.warning + pitSnapshot.alarm + (projectControlSnapshot?.delayedTasks ?? 0) + (projectControlSnapshot?.activeRisks ?? 0),
  );
  $("#digitalTwinArchiveCount").textContent = String(archiveSnapshot.total);
  const persistence = digitalTwinDataCenter.getPersistenceStatus();
  $("#digitalTwinStorageStatus").textContent = persistence.lastWriteSucceeded
    ? "目录元数据已安全保存到本机浏览器；模型、视频和照片不会重复写入目录。"
    : "目录在当前会话中正常可用；本机元数据持久化暂不可用，模型、视频和照片不受影响。";
}

function syncDigitalTwinDataCenter() {
  if (!digitalTwinSyncReady) return;
  window.clearTimeout(digitalTwinSyncTimer);
  digitalTwinSyncTimer = 0;
  try {
    digitalTwinDataCenter.reconcile({
      resources: digitalTwinResourceInputs(),
      businessRecords: digitalTwinBusinessInputs(),
    });
    updateDigitalTwinSidebar();
    digitalTwinOverview.setSnapshot(buildDigitalTwinOverviewSnapshot());
  } catch (error) {
    console.warn("[Digital twin data center] Synchronization skipped without affecting the scene", error);
    $("#digitalTwinStorageStatus").textContent = "数据目录本次同步失败；当前三维场景和原业务数据不受影响。";
  }
}

function scheduleDigitalTwinSync() {
  if (!digitalTwinSyncReady) return;
  window.clearTimeout(digitalTwinSyncTimer);
  digitalTwinSyncTimer = window.setTimeout(syncDigitalTwinDataCenter, 180);
}

function activateDigitalTwinModule(tabName: "markup" | "monitoring" | "report") {
  const tab = document.querySelector<HTMLButtonElement>(`.tab[data-tab="${tabName}"]`);
  if (!tab || tab.disabled) return false;
  tab.click();
  return true;
}

function selectDigitalTwinOverviewResource(resource: DigitalTwinResourceRecord) {
  digitalTwinOverview.close();
  if (resource.id.startsWith("catalog:resource:")) {
    const resourceId = resource.id.slice("catalog:resource:".length);
    if (resourceId === DIGITAL_TWIN_BASEMAP_ID) {
      $<HTMLSelectElement>("#basemap").focus();
      toast(`当前底图：${activeBasemapName()}`);
      return;
    }
    const item = imports.find((candidate) => candidate.id === resourceId);
    if (!item) return toast("该图层已从场景移除，数据目录即将刷新", true);
    try {
      if (!item.visible) setImportVisibility(item, true, { silent: true });
      locateImport(item);
      toast(`已定位：${item.name}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "图层定位失败", true);
    }
    return;
  }
  if (!resource.id.startsWith("catalog:business:")) return;
  const recordId = resource.id.slice("catalog:business:".length);
  if (recordId.startsWith("markup:")) activateDigitalTwinModule("markup");
  else if (recordId.startsWith("pit:")) activateDigitalTwinModule("monitoring");
  else if (recordId.startsWith("report:")) activateDigitalTwinModule("report");
  else if (recordId.startsWith("sandtable:")) {
    const tab = document.querySelector<HTMLButtonElement>('.tab[data-tab="sandtable"]');
    tab?.click();
    electronicSandTable?.locateViewpoint(recordId.slice("sandtable:".length));
  }
  else if (recordId.startsWith("progress:")) {
    document.querySelector<HTMLButtonElement>('.tab[data-tab="sandtable"]')?.click();
    sandTableProjectControl?.locateTask(recordId.slice("progress:".length));
  }
  else if (recordId.startsWith("risk:")) {
    document.querySelector<HTMLButtonElement>('.tab[data-tab="sandtable"]')?.click();
    sandTableProjectControl?.locateRisk(recordId.slice("risk:".length));
  }
  else if (recordId.startsWith("archive:")) {
    $<HTMLButtonElement>("#openSubsurfacePanel").click();
    document.querySelector<HTMLButtonElement>('[data-subtab="archive"]')?.click();
  }
}

fillDigitalTwinProjectForm(initializeDigitalTwinProject());
digitalTwinOverview = new DigitalTwinOverview($("#digitalTwinOverviewHost"), {
  title: "数字孪生项目总览",
  initiallyOpen: false,
  onResourceSelect: selectDigitalTwinOverviewResource,
});

try {
  sandTablePresentation = new ElectronicSandTablePresentation(viewer, {
    getProjectArea: sandTableProjectArea,
    getMetrics: () => {
      const projectControl = sandTableProjectControl?.getOverviewSnapshot();
      return {
        projectName: digitalTwinDataCenter.getProject(DIGITAL_TWIN_PROJECT_ID)?.name || "当前工程数字孪生项目",
        totalLayers: imports.length,
        visibleLayers: imports.filter((item) => item.visible).length,
        overallProgress: projectControl?.overallProgress ?? 0,
        activeRisks: projectControl?.activeRisks ?? 0,
        delayedTasks: projectControl?.delayedTasks ?? 0,
      };
    },
    focusProject: () => focusSandTableScene("fit"),
    getContourTilesets: () => imports.flatMap((item) => {
      if (item.kind !== "3D Tiles") return [];
      const tileset = item.resource as Cesium3DTileset;
      try {
        if (tileset.isDestroyed()) return [];
      } catch {
        return [];
      }
      return [{ id: item.id, name: item.name, visible: item.visible && tileset.show, tileset }];
    }),
    canEnterImmersive: () => (
      viewer.scene.mode === SceneMode.SCENE3D
      && viewer.scene.morphTime === 1
      && !document.body.classList.contains("report-presentation-mode")
    ),
  });
} catch (error) {
  console.error("[Electronic sand table presentation] Module initialization failed without affecting the scene", error);
  const status = document.getElementById("sandPresentationStatus");
  if (status) {
    status.textContent = "地形融合展示初始化失败；电子沙盘原有功能和其他模块不受影响。";
    status.classList.add("error");
  }
}

$("#saveDigitalTwinProject").addEventListener("click", () => {
  try {
    const project = digitalTwinDataCenter.upsertProject({
      id: DIGITAL_TWIN_PROJECT_ID,
      name: value("#digitalTwinProjectName"),
      type: value("#digitalTwinProjectType") as ProjectType,
      status: value("#digitalTwinProjectStatus") as ProjectStatus,
      owner: value("#digitalTwinProjectOwner"),
      description: value("#digitalTwinProjectDescription"),
      tags: ["数字孪生", "工程项目"],
      metadata: { location: value("#digitalTwinProjectLocation") },
    });
    fillDigitalTwinProjectForm(project);
    syncDigitalTwinDataCenter();
    sandTablePresentation?.refresh();
    toast("项目资料已保存");
  } catch (error) {
    toast(error instanceof Error ? error.message : "项目资料保存失败", true);
  }
});

$("#openDigitalTwinOverview").addEventListener("click", () => {
  syncDigitalTwinDataCenter();
  digitalTwinOverview.open();
});

$("#exportDigitalTwinCatalog").addEventListener("click", () => {
  syncDigitalTwinDataCenter();
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    project: digitalTwinDataCenter.getProject(DIGITAL_TWIN_PROJECT_ID),
    resources: digitalTwinDataCenter.queryResources({ projectId: DIGITAL_TWIN_PROJECT_ID }),
    businessRecords: digitalTwinDataCenter.queryBusinessRecords({ projectId: DIGITAL_TWIN_PROJECT_ID }),
    summary: digitalTwinDataCenter.snapshot(),
  };
  const blob = new Blob([JSON.stringify(payload, (key, item) => key === "runtimeResource" ? undefined : item, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `数字孪生数据目录-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  toast("统一数据目录已导出（不包含模型、视频和照片原文件）");
});

digitalTwinUnsubscribers.push(
  foundationPitMonitoring.subscribeOverview(scheduleDigitalTwinSync),
  subsurfaceTools.subscribeArchiveOverview(scheduleDigitalTwinSync),
);
if (markupTools) digitalTwinUnsubscribers.push(markupTools.subscribeOverview(scheduleDigitalTwinSync));
if (threeDReport) digitalTwinUnsubscribers.push(threeDReport.subscribeOverview(scheduleDigitalTwinSync));
if (electronicSandTable) digitalTwinUnsubscribers.push(electronicSandTable.subscribeOverview(scheduleDigitalTwinSync));
if (sandTableProjectControl) {
  digitalTwinUnsubscribers.push(sandTableProjectControl.subscribeOverview(() => {
    scheduleDigitalTwinSync();
    sandTablePresentation?.refresh();
  }));
}
digitalTwinSyncReady = true;
syncDigitalTwinDataCenter();

window.addEventListener("beforeunload", () => {
  if (electronicSandTableRefreshFrame) window.cancelAnimationFrame(electronicSandTableRefreshFrame);
  electronicSandTableRefreshFrame = 0;
  sandTablePresentation?.dispose();
  sandTableFacilities?.dispose();
  electronicSandTable?.dispose();
  sandTableProjectControl?.dispose();
}, { once: true });
window.addEventListener("beforeunload", () => foundationPitMonitoring.dispose(), { once: true });
window.addEventListener("beforeunload", () => markupTools?.dispose(), { once: true });
window.addEventListener("beforeunload", () => threeDReport?.dispose(), { once: true });
window.addEventListener("beforeunload", () => videoArFusion.destroy(), { once: true });
window.addEventListener("beforeunload", () => {
  for (const tracker of modelQualityTrackers.values()) tracker.dispose();
  modelQualityTrackers.clear(); modelQualityResources.clear(); modelQualitySubscribers.clear();
  if (modelQualityNotifyTimer !== undefined) clearTimeout(modelQualityNotifyTimer);
}, { once: true });
window.addEventListener("beforeunload", () => modelLoadController?.abort(), { once: true });
window.addEventListener("beforeunload", () => {
  digitalTwinSyncReady = false;
  window.clearTimeout(digitalTwinSyncTimer);
  for (const unsubscribe of digitalTwinUnsubscribers.splice(0)) unsubscribe();
  digitalTwinOverview.dispose();
}, { once: true });

const recentDestroyedRenderErrors: number[] = [];
viewer.scene.renderError.addEventListener((_scene, error) => {
  const details = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
  console.error("[Cesium render error]", details);
  const camera = viewer.camera.positionCartographic;
  const report = {
    occurredAt: new Date().toISOString(),
    details,
    cesiumVersion: "1.144.0",
    camera: {
      longitude: CesiumMath.toDegrees(camera.longitude),
      latitude: CesiumMath.toDegrees(camera.latitude),
      height: camera.height,
    },
    layers: imports.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      visible: item.visible,
      destroyed: (() => {
        try { return Boolean((item.resource as { isDestroyed?: () => boolean }).isDestroyed?.()); }
        catch { return true; }
      })(),
    })),
    sectionEnabled: $<HTMLInputElement>("#sectionEnabled").checked,
    excavationClippingEnabled: $<HTMLInputElement>("#clipExcavationSurface").checked,
  };
  try { localStorage.setItem("cesium-last-render-error-v1", JSON.stringify(report)); } catch { /* Diagnostics are best effort. */ }
  (window as Window & { __CESIUM_LAST_RENDER_ERROR__?: typeof report }).__CESIUM_LAST_RENDER_ERROR__ = report;
  void fetch("/__diagnostics/render-error", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report),
    keepalive: true,
  }).catch(() => undefined);
  if (!/object was destroyed|destroy\(\) was called/i.test(details)) {
    viewer.cesiumWidget.showErrorPanel("三维场景渲染发生错误", "请展开详细信息并保留错误内容。", error);
    return;
  }

  const now = Date.now();
  recentDestroyedRenderErrors.push(now);
  while (recentDestroyedRenderErrors.length && recentDestroyedRenderErrors[0] < now - 5000) recentDestroyedRenderErrors.shift();
  viewer.camera.cancelFlight();
  viewer.scene.screenSpaceCameraController.enableInputs = true;
  const detachedClippingResources = subsurfaceTools.recoverFromDestroyedResources();
  const prunedEditorModels = modelEditor.pruneDestroyed();
  let prunedLayers = 0;
  for (let index = imports.length - 1; index >= 0; index -= 1) {
    const item = imports[index];
    let destroyed = false;
    try { destroyed = Boolean((item.resource as { isDestroyed?: () => boolean }).isDestroyed?.()); }
    catch { destroyed = true; }
    if (!destroyed) continue;
    if (item.kind === "3D Tiles") { disposeModelQuality(item.id, item.resource as Cesium3DTileset); videoArFusion.invalidateProjection("destroyed-model-pruned"); }
    subsurfaceTools.detachImport(item);
    imports.splice(index, 1);
    prunedLayers += 1;
  }
  for (let index = viewer.imageryLayers.length - 1; index >= 0; index -= 1) {
    const layer = viewer.imageryLayers.get(index);
    if (layer.isDestroyed()) viewer.imageryLayers.remove(layer, false);
  }
  if (prunedLayers) renderLayers();
  console.warn("[Cesium recovery]", { detachedClippingResources, prunedEditorModels, prunedLayers });
  if (recentDestroyedRenderErrors.length > 3) {
    const diagnosticError = new Error(`${details}\n\nRecovery: detachedClipping=${detachedClippingResources}, prunedEditorModels=${prunedEditorModels}, prunedLayers=${prunedLayers}`);
    viewer.cesiumWidget.showErrorPanel("三维场景连续恢复失败", "请展开详细信息；错误堆栈也已保存在浏览器本地诊断记录中。", diagnosticError.stack ?? diagnosticError.message);
    return;
  }

  setStatus("正在隔离失效的瓦片或裁剪资源…");
  toast(detachedClippingResources || prunedLayers ? "已隔离失效资源，正在恢复场景" : "正在重建缩放渲染帧");
  window.setTimeout(() => {
    if (viewer.isDestroyed()) return;
    viewer.useDefaultRenderLoop = true;
    viewer.scene.requestRender();
    setStatus("Cesium 已就绪");
  }, 180);
});

function bindDropzone(zoneSelector: string, inputSelector: string, assign: (file: File) => void) {
  const zone = $(zoneSelector);
  const input = $<HTMLInputElement>(inputSelector);
  zone.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) assign(file);
    input.value = "";
  });
  ["dragenter", "dragover"].forEach((event) => zone.addEventListener(event, (e: Event) => { e.preventDefault(); zone.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach((event) => zone.addEventListener(event, (e: Event) => { e.preventDefault(); zone.classList.remove("dragging"); }));
  zone.addEventListener("drop", (event: DragEvent) => event.dataTransfer?.files[0] && assign(event.dataTransfer.files[0]));
}

function showSelected(zone: HTMLElement, file: File) {
  zone.querySelector("strong")!.textContent = file.name;
  zone.querySelector("small")!.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB · 已选择`;
  zone.classList.add("selected");
}

bindDropzone("#cadDropzone", "#cadFile", (file) => {
  selectedCad = file;
  generatedCadImport = null;
  $("#downloadCadImport").classList.add("hidden");
  $("#loadCad").textContent = file.name.toLowerCase().endsWith(".cadimport") ? "加载 CAD 导入文件" : "生成导入文件并加载";
  showSelected($("#cadDropzone"), file);
});
bindDropzone("#gisDropzone", "#gisFile", (file) => { selectedGis = file; showSelected($("#gisDropzone"), file); });
bindDropzone("#modelDropzone", "#modelFile", (file) => {
  if (modelLoadBusy) return toast("模型正在上传或转换，请先取消当前任务或等待完成", true);
  selectedModelFile = file;
  showSelected($("#modelDropzone"), file);
  updateModelLoadUi(`${file.name} 已选择；加载前将先检查格式与本机转换器。`);
});
type ConverterFormat = "dwg" | "rvt" | "skp";
type ConverterStatusEntry = { available: boolean; reason: string; details?: string[] };
type ConverterStatus = {
  native: string[];
  converters: Record<ConverterFormat, boolean>;
  converterStatus?: Record<ConverterFormat, ConverterStatusEntry>;
  busy?: boolean;
  maxUploadBytes?: number;
};
let modelLoadController: AbortController | null = null;
let modelLoadBusy = false;

function updateModelLoadUi(message?: string, error = false) {
  const button = $<HTMLButtonElement>("#loadModel");
  const cancel = $<HTMLButtonElement>("#cancelModelLoad");
  const fileInput = $<HTMLInputElement>("#modelFile");
  button.disabled = modelLoadBusy;
  button.textContent = modelLoadBusy ? "正在处理模型…" : "转换并加载模型";
  cancel.classList.toggle("hidden", !modelLoadBusy);
  cancel.disabled = !modelLoadBusy;
  fileInput.disabled = modelLoadBusy;
  $("#modelDropzone").classList.toggle("busy", modelLoadBusy);
  if (message !== undefined) {
    const status = $("#modelLoadStatus");
    status.textContent = message;
    status.classList.toggle("error-text", error);
  }
}

function renderConverterStatus(status: ConverterStatus) {
  const root = $("#converterStatus");
  const nodes: HTMLElement[] = [];
  const native = document.createElement("span");
  native.className = "available";
  native.textContent = "GLB 原生";
  nodes.push(native);
  for (const format of ["dwg", "rvt", "skp"] as const) {
    const entry = status.converterStatus?.[format];
    const available = entry?.available ?? Boolean(status.converters[format]);
    const badge = document.createElement("span");
    badge.className = available ? "available" : "unavailable";
    badge.textContent = `${format.toUpperCase()} ${available ? "可用" : "不可用"}`;
    badge.title = entry ? [entry.reason, ...(entry.details ?? [])].filter(Boolean).join("；") : "本机转换器未配置或未验证";
    nodes.push(badge);
  }
  if (status.busy) {
    const busy = document.createElement("span");
    busy.className = "unavailable";
    busy.textContent = "转换器忙碌";
    nodes.push(busy);
  }
  root.replaceChildren(...nodes);
}

function waitForModelReady(model: Model, timeoutMs = 30_000, signal?: AbortSignal) {
  if (model.ready) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new DOMException("模型任务已取消", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error("模型加载超时，请检查文件是否完整")), timeoutMs);
    const removeReady = model.readyEvent.addEventListener(() => finish());
    const removeError = model.errorEvent.addEventListener((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
    const abort = () => finish(new DOMException("模型任务已取消", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      removeReady();
      removeError();
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    viewer.scene.requestRender();
  });
}
async function refreshConverterStatus(signal?: AbortSignal) {
  try {
    const response = await fetch("/__models/status", { cache: "no-store", signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const status = await response.json() as ConverterStatus;
    renderConverterStatus(status);
    return status;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    $("#converterStatus").textContent = "无法读取本机转换器状态";
    return null;
  }
}
void refreshConverterStatus();

$("#cancelModelLoad").addEventListener("click", () => {
  if (!modelLoadController) return;
  modelLoadController.abort();
  updateModelLoadUi("正在取消上传或转换任务…");
});

$("#modelPlacement").addEventListener("change", () => {
  const placement = value("#modelPlacement");
  $("#modelCustomFields").classList.toggle("hidden", placement !== "customGeo");
  $("#modelGaussFields").classList.toggle("hidden", placement !== "customGauss");
  $("#modelCoordinateHint").classList.toggle("hidden", placement !== "coordinates");
});

function updateModelZoneNumber() {
  try {
    const longitude = parseLongitude(value("#modelCentralMeridian"));
    $<HTMLInputElement>("#modelZoneNumber").value = String(inferredZoneNumber(longitude, numeric("#modelZoneWidth", 3) as 3 | 6));
  } catch { /* Keep the last valid zone until input is complete. */ }
}
$("#modelCentralMeridian").addEventListener("input", updateModelZoneNumber);
$("#modelZoneWidth").addEventListener("change", updateModelZoneNumber);

$("#loadModel").addEventListener("click", async () => {
  await projectLibrary?.ready;
  if (modelLoadBusy) return;
  if (!selectedModelFile) return toast("请先选择 DWG、RVT、SKP 或 GLB 文件", true);
  const extension = selectedModelFile.name.split(".").pop()?.toLowerCase() ?? "";
  if (!["dwg", "rvt", "skp", "glb"].includes(extension)) return toast("仅支持 DWG、RVT、SKP 和 GLB", true);
  const controller = new AbortController();
  modelLoadController = controller;
  modelLoadBusy = true;
  updateModelLoadUi("正在检查本机模型转换能力…");
  try {
    const converterStatus = await refreshConverterStatus(controller.signal);
    const maxUploadBytes = converterStatus?.maxUploadBytes ?? 1024 * 1024 * 1024;
    if (selectedModelFile.size > maxUploadBytes) {
      throw new Error(`模型文件超过 ${(maxUploadBytes / 1024 / 1024 / 1024).toFixed(0)}GB 限制，未开始上传`);
    }
    if (extension !== "glb") {
      const format = extension as ConverterFormat;
      const entry = converterStatus?.converterStatus?.[format];
      const available = entry?.available ?? Boolean(converterStatus?.converters?.[format]);
      if (!available) {
        const reason = entry?.reason || `${format.toUpperCase()} 本机转换器未配置或未验证`;
        const details = entry?.details?.length ? `（${entry.details.join("；")}）` : "";
        throw new Error(`${reason}${details}。文件未上传。`);
      }
      if (converterStatus?.busy) throw new Error("本机已有模型正在转换，请等待当前任务结束后再试");
    }
    if (controller.signal.aborted) throw new DOMException("模型任务已取消", "AbortError");
    setStatus(extension === "glb" ? "正在加载三维模型…" : `正在转换 ${extension.toUpperCase()}…`);
    updateModelLoadUi(extension === "glb" ? "正在校验并加载 GLB…" : `正在上传并转换 ${extension.toUpperCase()}；可随时取消。`);
    const response = await fetch(`/__models/import?extension=${encodeURIComponent(extension)}&name=${encodeURIComponent(selectedModelFile.name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: selectedModelFile,
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({ ok: false, error: `模型服务返回了无法识别的结果（HTTP ${response.status}）` })) as { ok: boolean; url?: string; converted?: boolean; error?: string };
    if (!result.ok || !result.url) throw new Error(result.error || "模型转换失败");
    if (controller.signal.aborted) throw new DOMException("模型任务已取消", "AbortError");
    const placement = value("#modelPlacement");
    let modelMatrix = Matrix4.clone(Matrix4.IDENTITY);
    let modelScale = numeric("#modelScale", 1);
    if (placement === "customGeo") {
      modelMatrix = Transforms.headingPitchRollToFixedFrame(Cartesian3.fromDegrees(numeric("#modelLon"), numeric("#modelLat"), numeric("#modelHeight")), new HeadingPitchRoll(CesiumMath.toRadians(numeric("#modelHeading")), 0, 0));
    } else if (placement === "customGauss") {
      const centralMeridian = parseLongitude(value("#modelCentralMeridian"));
      const [longitude, latitude] = gaussKrugerToWgs84(numeric("#modelNorthing"), numeric("#modelEasting"), {
        centralMeridian,
        ellipsoid: value("#modelGaussEllipsoid") as GaussEllipsoid,
        axisOrder: "northEast" as GaussAxisOrder,
        hasZonePrefix: $<HTMLInputElement>("#modelZonePrefix").checked,
        zoneNumber: numeric("#modelZoneNumber"),
      });
      modelMatrix = Transforms.headingPitchRollToFixedFrame(Cartesian3.fromDegrees(longitude, latitude, numeric("#modelGaussHeight")), new HeadingPitchRoll(CesiumMath.toRadians(numeric("#modelGaussHeading")), 0, 0));
      modelScale = numeric("#modelGaussScale", 1);
    }
    const id = crypto.randomUUID();
    const model = await Model.fromGltfAsync({ url: result.url, modelMatrix, scale: modelScale, minimumPixelSize: 0, id: { engineeringModelId: id } });
    viewer.scene.primitives.add(model);
    try { await waitForModelReady(model, 30_000, controller.signal); }
    catch (error) { viewer.scene.primitives.remove(model); throw error; }
    try {
      await projectLibrary!.save(id, selectedModelFile.name, "Model", {
        matrix: Matrix4.toArray(model.modelMatrix), scale: model.scale,
      }, { source: { name: selectedModelFile.name, blob: selectedModelFile } },
      extension === "glb" ? undefined : { type: "model", url: result.url });
    } catch (error) { viewer.scene.primitives.remove(model); throw error; }
    addImport(selectedModelFile.name, "Model", model, id);
    modelEditor.add(id, selectedModelFile.name, model);
    viewer.camera.flyToBoundingSphere(model.boundingSphere, { duration: 1.5 });
    updateModelLoadUi(`${selectedModelFile.name} 已成功加载。`);
    toast(result.converted ? `${extension.toUpperCase()} 已自动转换并加载` : "模型已加载，可用鼠标调整位置");
  } catch (error) {
    const cancelled = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
    const message = cancelled ? "模型上传或转换已取消，临时文件已清理" : error instanceof Error ? error.message : "模型加载失败";
    updateModelLoadUi(message, !cancelled);
    toast(message, !cancelled);
  }
  finally {
    if (modelLoadController === controller) modelLoadController = null;
    modelLoadBusy = false;
    updateModelLoadUi();
    setStatus("Cesium 已就绪");
    void refreshConverterStatus();
  }
});

document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => tab.addEventListener("click", () => {
  const previousTab = document.querySelector<HTMLButtonElement>(".tab.active")?.dataset.tab;
  const leavingSandTable = previousTab === "sandtable"
    && tab.dataset.tab !== "sandtable";
  if (tab.dataset.tab !== "sandtable") {
    electronicSandTable?.stopTour();
    if (leavingSandTable) {
      try { viewer.camera.cancelFlight(); } catch { /* A completed flight needs no cleanup. */ }
    }
    sandTablePresentation?.deactivate();
    sandTableFacilities?.deactivate();
  }
  else {
    electronicSandTable?.refreshLayers();
    sandTableProjectControl?.refreshLayers();
    sandTablePresentation?.activate();
    sandTableFacilities?.activate();
    sandTablePresentation?.refresh();
  }
  videoArFusion.setPanelActive(tab.dataset.tab === "videoar");
  document.querySelectorAll(".tab,.panel").forEach((element) => element.classList.remove("active"));
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((item) => item.removeAttribute("aria-current"));
  tab.classList.add("active");
  tab.setAttribute("aria-current", "page");
  $(`[data-panel="${tab.dataset.tab}"]`).classList.add("active");
  const activeToolTitle = document.querySelector<HTMLElement>("#activeToolTitle");
  if (activeToolTitle) activeToolTitle.textContent = tab.dataset.label ?? tab.textContent?.trim() ?? "当前功能";
  if (tab.dataset.tab === "overview") {
    syncDigitalTwinDataCenter();
    digitalTwinOverview.open();
  } else if (digitalTwinOverview.isOpen) {
    digitalTwinOverview.close();
  }
}));

$("#cadMode").addEventListener("change", () => {
  const mode = value("#cadMode");
  $("#localFields").classList.toggle("hidden", mode !== "local");
  $("#crsFields").classList.toggle("hidden", mode !== "crs");
  $("#gaussFields").classList.toggle("hidden", mode !== "gaussKruger");
});

$("#cadDisplayMode").addEventListener("change", () => {
  const mode = value("#cadDisplayMode") as CadDisplayMode;
  $("#cadDisplayHint").textContent = mode === "terrain"
    ? "忽略 CAD 原始 Z 值，将线、面和文字贴到地球或地形表面。"
    : mode === "model"
      ? "投影到已加载的倾斜摄影或三维模型表面；请先加载模型，再加载 CAD。"
      : "保持 CAD 原始 Z 坐标和设置的高程。";
});

function updateZoneNumber() {
  try {
    const longitude = parseLongitude(value("#centralMeridian"));
    $<HTMLInputElement>("#zoneNumber").value = String(inferredZoneNumber(longitude, numeric("#zoneWidth", 3) as 3 | 6));
  } catch { /* Keep the last valid zone until input is complete. */ }
}
$("#centralMeridian").addEventListener("input", updateZoneNumber);
$("#zoneWidth").addEventListener("change", updateZoneNumber);
updateZoneNumber();
updateModelZoneNumber();

$("#loadCad").addEventListener("click", async () => {
  await projectLibrary?.ready;
  if (cadLoadBusy) return;
  if (!selectedCad) return toast("请先选择 DWG 或 .cadimport 文件", true);
  const cadFile = selectedCad;
  const cadId = crypto.randomUUID();
  const lowerName = cadFile.name.toLowerCase();
  if (!lowerName.endsWith(".dwg") && !lowerName.endsWith(".cadimport")) return toast("CAD 图纸只接受 DWG 或 .cadimport 文件", true);
  const mode = value("#cadMode");
  let options: CadCoordinateOptions;
  if (mode === "local") {
    options = { mode: "local", longitude: numeric("#anchorLon"), latitude: numeric("#anchorLat"), altitude: numeric("#anchorAlt"), referenceX: numeric("#referenceX"), referenceY: numeric("#referenceY"), rotation: numeric("#cadRotation"), scale: numeric("#cadScale", 1) };
  } else if (mode === "gaussKruger") {
    let centralMeridian: number;
    try { centralMeridian = parseLongitude(value("#centralMeridian")); }
    catch (error) { return toast(error instanceof Error ? error.message : "中央子午线格式错误", true); }
    options = { mode: "gaussKruger", centralMeridian, ellipsoid: value("#gaussEllipsoid") as "GRS80" | "WGS84" | "IAU76" | "krass", axisOrder: value("#gaussAxis") as "eastNorth" | "northEast", hasZonePrefix: $<HTMLInputElement>("#zonePrefix").checked, zoneNumber: numeric("#zoneNumber"), heightOffset: numeric("#gaussHeight") };
  } else {
    options = { mode: "crs", sourceCrs: value("#sourceCrs"), heightOffset: numeric("#cadHeight") };
  }
  const loadButton = $<HTMLButtonElement>("#loadCad");
  let pendingCadDataSource: Awaited<ReturnType<typeof loadCadImport>> | null = null;
  let pendingCadPrimitive: PrimitiveCollection | null = null;
  const controller = new AbortController();
  cadLoadController = controller;
  cadLoadBusy = true;
  loadButton.disabled = true;
  try {
    let imported: CadImportPackage;
    if (lowerName.endsWith(".dwg")) {
      setStatus("正在本地解析 DWG 并生成导入文件…");
      const generated = await createCadImportFromDwgInWorker(cadFile, setStatus, controller.signal);
      imported = generated.value;
      generatedCadImport = { name: cadImportFileName(cadFile.name), blob: generated.blob };
      $("#downloadCadImport").classList.remove("hidden");
    } else {
      setStatus("正在读取 CAD 导入文件…");
      imported = await readCadImport(cadFile);
    }
    if (controller.signal.aborted) throw new DOMException("CAD 加载已取消", "AbortError");
    setStatus("正在将 CAD 放置到地球上…");
    const displayMode = value("#cadDisplayMode") as CadDisplayMode;
    if (displayMode === "model" && !imports.some((item) => item.kind === "3D Tiles" || item.kind === "Model")) {
      throw new Error("依附模型模式需要先加载倾斜摄影或三维模型");
    }
    await projectLibrary!.save(cadId, imported.source.name, "CAD", { coordinates: options, displayMode }, {
      source: { name: cadFile.name, blob: cadFile },
      data: { name: lowerName.endsWith(".cadimport") ? cadFile.name : cadImportFileName(cadFile.name), blob: lowerName.endsWith(".dwg") ? generatedCadImport!.blob : cadFile },
    });
    let clampedVertices = 0;
    let skippedClampVertices = 0;
    const hasTileset = imports.some((item) => item.kind === "3D Tiles");
    const hasOrdinaryModel = imports.some((item) => item.kind === "Model");
    const requiresOrdinaryModelSampling = displayMode === "model" && !hasTileset && hasOrdinaryModel;
    let cadBoundingSphere: ImportRecord["boundingSphere"];
    let featureCount = 0;
    let runtimeSkipped = 0;

    if (requiresOrdinaryModelSampling) {
      // Ordinary glTF/GLB models cannot classify GroundPrimitives. Keep the
      // existing sampled Entity path only for this compatibility case.
      const dataSource = await loadCadImport(
        imported,
        options,
        displayMode,
        (completed, total) => setStatus(`正在分批放置 CAD… ${Math.round(completed / total * 100)}%`),
        async (created) => {
          pendingCadDataSource = created;
          await viewer.dataSources.add(created);
        },
        controller.signal,
      );
      setStatus("正在分批将 CAD 依附到模型表面…");
      const clampResult = await clampCadToScene(dataSource, viewer.scene, 2000, controller.signal);
      clampedVertices = clampResult.clamped;
      skippedClampVertices = clampResult.skipped;
      useSampledCadHeights(dataSource);
      cadBoundingSphere = getCadBoundingSphere(dataSource);
      featureCount = dataSource.entities.values.length;
      addImport(imported.source.name, "CAD", dataSource, cadId, {
        representation: "dataSource",
        boundingSphere: cadBoundingSphere,
      });
      pendingCadDataSource = null;
    } else {
      const result = await loadCadPrimitiveCollection(imported, options, {
        displayMode,
        scene: viewer.scene,
        signal: controller.signal,
        batchSize: 2000,
        primitiveBatchSize: 1000,
        onProgress: (completed, total) => setStatus(`正在批量绘制 CAD… ${Math.round(completed / total * 100)}%`),
        beforePopulate: (created) => {
          pendingCadPrimitive = created;
          viewer.scene.primitives.add(created);
          viewer.scene.requestRender();
        },
      });
      cadBoundingSphere = result.boundingSphere;
      featureCount = result.featureCount;
      runtimeSkipped = result.skippedCount;
      addImport(imported.source.name, "CAD", result.collection, cadId, {
        representation: "primitive",
        boundingSphere: cadBoundingSphere,
      });
      pendingCadPrimitive = null;
    }
    if (cadBoundingSphere) viewer.camera.flyToBoundingSphere(cadBoundingSphere, { duration: 1.2 });
    const skipped = imported.statistics.skippedEntities + imported.statistics.unknownEntities + runtimeSkipped;
    const hidden = imported.statistics.hiddenEntities ?? 0;
    const legacyNotice = lowerName.endsWith(".cadimport") && imported.version === 1
      ? "；该文件由旧版生成，建议用原 DWG 重新生成以修正圆弧和隐藏图层"
      : "";
    const modeLabel = displayMode === "terrain"
      ? "，已紧贴地表"
      : displayMode === "model"
        ? hasTileset
          ? "，已启用倾斜摄影实时贴附"
          : `，已依附普通模型（采样 ${clampedVertices} 个顶点${skippedClampVertices ? `，为防止内存溢出跳过 ${skippedClampVertices} 个` : ""}）`
        : "";
    toast(`CAD 已加载：${featureCount} 个对象${modeLabel}${hidden ? `，已忽略 ${hidden} 个冻结/关闭图层对象` : ""}${skipped ? `，${skipped} 个复杂或无效对象未展开` : ""}${legacyNotice}`);
  } catch (error) {
    if (pendingCadDataSource) viewer.dataSources.remove(pendingCadDataSource, true);
    const orphanedCadPrimitive = pendingCadPrimitive as PrimitiveCollection | null;
    if (orphanedCadPrimitive) {
      const removed = viewer.scene.primitives.remove(orphanedCadPrimitive);
      if (!removed && !orphanedCadPrimitive.isDestroyed()) orphanedCadPrimitive.destroy();
    }
    if (!(error instanceof DOMException && error.name === "AbortError") && !controller.signal.aborted) {
      toast(error instanceof Error ? error.message : "CAD 加载失败", true);
    }
  }
  finally {
    if (cadLoadController === controller) cadLoadController = null;
    cadLoadBusy = false;
    loadButton.disabled = false;
    setStatus("Cesium 已就绪");
  }
});

$("#downloadCadImport").addEventListener("click", () => {
  if (!generatedCadImport) return toast("请先从 DWG 生成导入文件", true);
  const url = URL.createObjectURL(generatedCadImport.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = generatedCadImport.name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`已生成 ${generatedCadImport.name}`);
});

function tilesetOptions(): TilesetOptions {
  return { longitudeOffset: numeric("#tilesLon"), latitudeOffset: numeric("#tilesLat"), heightOffset: numeric("#tilesHeight"), maximumScreenSpaceError: numeric("#tilesSse", 4) };
}

type TilesQuality = "balanced" | "high" | "ultra" | "custom";
const tilesQualityPresets: Record<Exclude<TilesQuality, "custom">, number> = { balanced: 12, high: 4, ultra: 1 };

function selectedTilesQuality(): TilesQuality {
  return $<HTMLSelectElement>("#tilesQuality").value as TilesQuality;
}

function configureTilesetQuality(tileset: Cesium3DTileset, initialLoad = false) {
  const quality = selectedTilesQuality();
  const highDetail = quality !== "balanced";
  const targetError = Math.max(0.5, numeric("#tilesSse", 4));
  tileset.maximumScreenSpaceError = initialLoad ? Math.max(20, targetError) : targetError;
  tileset.dynamicScreenSpaceError = quality === "balanced";
  tileset.foveatedScreenSpaceError = true;
  tileset.foveatedTimeDelay = 0.1;
  tileset.skipLevelOfDetail = true;
  tileset.preferLeaves = false;
  tileset.progressiveResolutionHeightFraction = 0.3;
  viewer.useBrowserRecommendedResolution = !highDetail;
  viewer.resolutionScale = quality === "ultra" ? 1.15 : 1;
  if (!initialLoad) modelQualityResources.get(tileset)?.setTarget(quality, targetError);
  videoArFusion.invalidateProjection("model-quality-changed");
  viewer.scene.requestRender();
}

function applyTilesQuality(updateLoaded = true) {
  const quality = selectedTilesQuality();
  if (quality !== "custom") $<HTMLInputElement>("#tilesSse").value = String(tilesQualityPresets[quality]);
  if (updateLoaded) {
    imports.filter((item) => item.kind === "3D Tiles").forEach((item) => {
      configureTilesetQuality(item.resource as Cesium3DTileset);
      projectLibrary?.queueUpdate(item.id, { settings: {
        quality, tiles: { ...(projectLibrary.records.get(item.id)?.settings.tiles ?? tilesetOptions()),
          maximumScreenSpaceError: numeric("#tilesSse", 4) },
      } });
    });
  }
}

$("#tilesQuality").addEventListener("change", () => {
  applyTilesQuality();
  toast(`倾斜摄影清晰度已切换为${$<HTMLSelectElement>("#tilesQuality").selectedOptions[0].text}`);
});
$("#tilesSse").addEventListener("input", () => {
  $<HTMLSelectElement>("#tilesQuality").value = "custom";
  applyTilesQuality();
});

type LocalTilesResponse = {
  ok: true;
  url: string;
  entry: string;
  candidateCount: number;
  topLevelCount: number;
  aggregate: boolean;
} | { ok: false; error: string; detected?: string[] };

const LOCAL_CC_PATH_KEY = "cesium-local-cc-folder-v1";
let tilesLoadBusy = false;
const ccFolderInput = $<HTMLInputElement>("#ccFolderPath");
try { ccFolderInput.value = localStorage.getItem(LOCAL_CC_PATH_KEY) ?? ""; } catch { /* Storage is optional. */ }
ccFolderInput.addEventListener("change", () => {
  try { localStorage.setItem(LOCAL_CC_PATH_KEY, ccFolderInput.value.trim()); } catch { /* Storage is optional. */ }
});

function setTilesLoadBusy(busy: boolean) {
  tilesLoadBusy = busy;
  $<HTMLButtonElement>("#loadCcFolder").disabled = busy;
  $<HTMLButtonElement>("#loadTiles").disabled = busy;
}

async function mountLocalTiles(folderPath: string) {
  setStatus("正在检测 CC 目录…");
  const response = await fetch("/__local_tiles/mount", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: folderPath }),
  });
  let result: LocalTilesResponse;
  try { result = await response.json() as LocalTilesResponse; }
  catch { throw new Error(`目录服务返回异常（HTTP ${response.status}），请重新启动 Cesium 后再试`); }
  if (!result.ok) {
    const scanStatus = $("#ccScanStatus");
    scanStatus.classList.remove("hidden");
    scanStatus.innerHTML = "";
    const message = document.createElement("span");
    message.className = "unavailable";
    message.textContent = result.error;
    scanStatus.append(message);
    throw new Error(result.error);
  }
  $<HTMLInputElement>("#tilesUrl").value = result.url;
  try { localStorage.setItem(LOCAL_CC_PATH_KEY, folderPath); } catch { /* Storage is optional. */ }
  const scanStatus = $("#ccScanStatus");
  scanStatus.classList.remove("hidden");
  scanStatus.innerHTML = result.aggregate
    ? `<span class="available">已自动汇总 ${result.topLevelCount} 个瓦片入口</span><span>共检查 ${result.candidateCount} 个有效 JSON</span>`
    : `<span class="available">已识别总入口</span><span>共检查 ${result.candidateCount} 个有效 JSON</span>`;
  return result;
}

function normalizedTilesSource(url: string, assetId: number, localFolderPath?: string) {
  if (localFolderPath) return `folder:${localFolderPath.replace(/[\\/]+$/, "").toLocaleLowerCase()}`;
  if (assetId) return `ion:${assetId}`;
  return `url:${url}`;
}

async function createAndLoadTileset(url: string, assetId: number, localFolderPath?: string, entry?: string) {
  if (!url && !assetId) throw new Error("请填写 tileset.json 地址或 ion Asset ID");
  if (assetId && !token) throw new Error("使用 ion Asset ID 前，请在 .env.local 中配置 VITE_CESIUM_ION_TOKEN");
  const sourceKey = normalizedTilesSource(url, assetId, localFolderPath);
  const existingId = tilesetSourceIds.get(sourceKey) ?? [...(projectLibrary?.records.values() ?? [])].find(record =>
    record.kind === "3D Tiles" && normalizedTilesSource(record.settings.url ?? "", record.settings.assetId ?? 0, record.settings.localPath) === sourceKey)?.id;
  const existing = existingId ? imports.find((item) => item.id === existingId && item.kind === "3D Tiles") : undefined;
  if (existing) {
    const existingTileset = existing.resource as Cesium3DTileset;
    if (!existingTileset.isDestroyed()) {
      setImportVisibility(existing, true);
      await viewer.zoomTo(existingTileset);
      toast("该倾斜摄影已经加载，已为你定位到模型");
      return;
    }
    tilesetSourceIds.delete(sourceKey);
  }

  setStatus("正在连接 3D Tiles…");
  const options = tilesetOptions();
  const resource = assetId ? await IonResource.fromAssetId(assetId) : url;
  const quality = selectedTilesQuality();
  const highDetail = quality !== "balanced";
  let tileset: Cesium3DTileset | undefined;
  let importId = "";
  try {
    tileset = await Cesium3DTileset.fromUrl(resource, {
      maximumScreenSpaceError: Math.max(20, options.maximumScreenSpaceError),
      dynamicScreenSpaceError: !highDetail,
      foveatedScreenSpaceError: true,
      foveatedTimeDelay: 0.1,
      skipLevelOfDetail: true,
      preferLeaves: false,
      progressiveResolutionHeightFraction: 0.3,
      preloadFlightDestinations: false,
      cacheBytes: 384 * 1024 * 1024,
      maximumCacheOverflowBytes: 192 * 1024 * 1024,
      enableCollision: true,
    });
    configureTilesetQuality(tileset, true);
    viewer.scene.primitives.add(tileset);
    if (options.longitudeOffset || options.latitudeOffset || options.heightOffset) {
      const center = tileset.boundingSphere.center;
      const cartographic = viewer.scene.globe.ellipsoid.cartesianToCartographic(center);
      const surface = Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, cartographic.height);
      const offset = Cartesian3.fromRadians(cartographic.longitude + CesiumMath.toRadians(options.longitudeOffset), cartographic.latitude + CesiumMath.toRadians(options.latitudeOffset), cartographic.height + options.heightOffset);
      tileset.modelMatrix = Matrix4.fromTranslation(Cartesian3.subtract(offset, surface, new Cartesian3()));
    }
    const label = assetId ? `ion 资产 ${assetId}` : entry?.split(/[\\/]/).pop() || new URL(url, location.href).pathname.split("/").pop() || "倾斜摄影";
    importId = crypto.randomUUID();
    trackModelQuality(importId, label, tileset, true);
    setStatus(localFolderPath ? "正在保存完整倾斜摄影成果，请稍候…" : "正在保存倾斜摄影图层…");
    await projectLibrary!.save(importId, label, "3D Tiles", {
      url: assetId ? undefined : url, assetId, localPath: localFolderPath, tiles: options, quality,
      matrix: Matrix4.toArray(tileset.modelMatrix),
    }, {}, localFolderPath ? { type: "tiles", path: localFolderPath } : undefined);
    addImport(label, "3D Tiles", tileset, importId);
    tilesetSourceIds.set(sourceKey, importId);
    await viewer.zoomTo(tileset);
    toast("倾斜摄影模型已加载");
  } catch (error) {
    if (importId && tileset) disposeModelQuality(importId, tileset);
    if (importId) {
      const failedImport = imports.find((item) => item.id === importId);
      if (failedImport) removeImport(failedImport);
      else if (tileset && !tileset.isDestroyed()) viewer.scene.primitives.remove(tileset);
    } else if (tileset && !tileset.isDestroyed()) {
      viewer.scene.primitives.remove(tileset);
    }
    throw error;
  }
}

$("#loadCcFolder").addEventListener("click", async () => {
  await projectLibrary?.ready;
  const folderPath = value("#ccFolderPath").trim().replace(/^['\"]|['\"]$/g, "");
  if (!folderPath) return toast("请粘贴 CC 的 Data 文件夹或生产目录完整路径", true);
  if (tilesLoadBusy) return toast("倾斜摄影正在加载，请稍候");
  setTilesLoadBusy(true);
  try {
    const result = await mountLocalTiles(folderPath);
    await createAndLoadTileset(result.url, 0, folderPath, result.entry);
  } catch (error) { toast(error instanceof Error ? error.message : "CC 目录检测失败", true); }
  finally { setTilesLoadBusy(false); setStatus("Cesium 已就绪"); }
});

$("#loadTiles").addEventListener("click", async () => {
  await projectLibrary?.ready;
  if (tilesLoadBusy) return toast("倾斜摄影正在加载，请稍候");
  setTilesLoadBusy(true);
  try {
    let url = value("#tilesUrl").trim();
    const assetId = numeric("#ionAssetId");
    let folderPath: string | undefined;
    let entry: string | undefined;
    // Local mount URLs live in server memory. Re-mount from the saved folder
    // whenever the user loads them, so a Vite restart cannot leave a stale URL.
    if (!assetId && /\/__local_tiles\/files\//.test(url)) {
      folderPath = value("#ccFolderPath").trim().replace(/^['\"]|['\"]$/g, "");
      if (!folderPath) throw new Error("本地目录挂载已失效，请重新填写 CC 目录路径");
      const result = await mountLocalTiles(folderPath);
      url = result.url;
      entry = result.entry;
    }
    await createAndLoadTileset(url, assetId, folderPath, entry);
  } catch (error) { toast(`加载失败：${error instanceof Error ? error.message : String(error)}`, true); }
  finally { setTilesLoadBusy(false); setStatus("Cesium 已就绪"); }
});

$("#loadGis").addEventListener("click", async () => {
  await projectLibrary?.ready;
  if (!selectedGis) return toast("请先选择 GIS 文件", true);
  const gisFile = selectedGis;
  const extension = gisFile.name.split(".").pop()?.toLowerCase();
  try {
    setStatus("正在读取 GIS 数据…");
    let dataSource;
    if (extension === "kml" || extension === "kmz") dataSource = await KmlDataSource.load(gisFile, { camera: viewer.scene.camera, canvas: viewer.scene.canvas, clampToGround: true });
    else if (extension === "czml") dataSource = await CzmlDataSource.load(JSON.parse(await gisFile.text()));
    else dataSource = await GeoJsonDataSource.load(JSON.parse(await gisFile.text()), { clampToGround: true, stroke: Color.fromCssColorString("#f9d65c"), fill: Color.fromCssColorString("#f9d65c").withAlpha(0.25), strokeWidth: 3 });
    const id = crypto.randomUUID();
    await projectLibrary!.save(id, gisFile.name, "GIS", {}, { source: { name: gisFile.name, blob: gisFile } });
    await viewer.dataSources.add(dataSource);
    const importId = addImport(gisFile.name, "GIS", dataSource, id);
    void cacheGisBoundingSphere(importId, dataSource);
    await viewer.flyTo(dataSource);
    toast("GIS 数据已加载");
  } catch (error) { toast(`GIS 加载失败：${error instanceof Error ? error.message : String(error)}`, true); }
  finally { setStatus("Cesium 已就绪"); }
});

$("#clearAll").addEventListener("click", async () => {
  await projectLibrary?.ready;
  await projectLibrary?.clear();
});
$("#homeView").addEventListener("click", () => viewer.camera.flyTo({
  destination: Cartesian3.fromDegrees(105, 35, 18_000_000),
  orientation: { heading: 0, pitch: CesiumMath.toRadians(-90), roll: 0 },
}));

const pointer = new ScreenSpaceEventHandler(viewer.scene.canvas);
pointer.setInputAction((movement: { endPosition: Cartesian2 }) => {
  const ray = viewer.camera.getPickRay(movement.endPosition);
  const point = ray && viewer.scene.globe.pick(ray, viewer.scene);
  if (!point) return;
  const position = viewer.scene.globe.ellipsoid.cartesianToCartographic(point);
  $("#coords").textContent = `经度 ${CesiumMath.toDegrees(position.longitude).toFixed(6)} · 纬度 ${CesiumMath.toDegrees(position.latitude).toFixed(6)} · 高程 ${position.height.toFixed(1)}m`;
}, ScreenSpaceEventType.MOUSE_MOVE);

async function openSafetyWorkspace(): Promise<void> {
  try {
    safetyWorkspaceLoading ??= import("./safetyWorkspace").then(({ SafetyWorkspace }) => {
      safetyWorkspace = new SafetyWorkspace({
        viewer, host: $("#safetyWorkspaceHost"), ready: () => projectLibrary!.ready,
        getImports: () => imports,
        getModelQualityStates, subscribeModelQuality,
        getVideoDiagnostics: () => { const diagnostics = videoArFusion.getDiagnostics(); return { ...diagnostics, media: { ...diagnostics.media, recordId: projectLibrary?.activeVideoRecordId || null } }; },
        setVideoTextureQuality: mode => videoArFusion.setTextureQuality(mode),
        setModelProjectionPreview: enabled => videoArFusion.setModelPreviewActive(enabled),
        setVideoProjectionFps: fps => videoArFusion.setProjectionFps(fps),
        captureVideoTexture: () => { const evidence = videoArFusion.captureTextureEvidence(); if (!evidence) throw new Error("请暂停视频并等待当前帧上传后再导出"); return evidence; },
        resetVideoPerformance: () => videoArFusion.resetPerformanceMetrics(),
        invalidateVideoProjection: reason => videoArFusion.invalidateProjection(reason),
        setLayerVisible: (id, visible) => {
          const item = imports.find(record => record.id === id);
          if (item) setImportVisibility(item, visible, { silent: true });
        },
        setVideoPanelActive: active => videoArFusion.setPanelActive(active),
        getPlaybackSource: () => ({ ...videoArFusion.getSharedPlaybackSource(), recordId: projectLibrary!.activeVideoRecordId }),
        syncVideoPlayback: () => videoArFusion.synchronizeSharedPlayback(),
        clearVideoSource: () => videoArFusion.clear(),
        loadVideoSource: async recordId => {
          await projectLibrary!.restore(recordId);
          if (projectLibrary!.activeVideoRecordId !== recordId) throw new Error("视频来源未能加载，请重试");
        },
        prepareOpen: () => {
          digitalTwinOverview.close();
          electronicSandTable?.stopTour();
          sandTablePresentation?.deactivate();
          sandTableFacilities?.deactivate();
          viewer.camera.cancelFlight();
          const resumes: Array<() => void> = [];
          const restore = () => {
            for (const resume of resumes.splice(0).reverse()) {
              try { resume(); } catch (error) { console.warn("[Safety dashboard] Interaction restore failed", error); }
            }
          };
          try {
            resumes.push(modelEditor.suspendInteractions(), subsurfaceTools.suspendInteractions(), foundationPitMonitoring.suspendInteractions());
            const resumeMarkup = markupTools?.suspendInteractions();
            if (resumeMarkup) resumes.push(resumeMarkup);
          } catch (error) { restore(); throw error; }
          return restore;
        },
        restoreWorkbench: () => document.querySelector<HTMLButtonElement>(".tab.active")?.click(),
        openVideoSettings: () => document.querySelector<HTMLButtonElement>('.tab[data-tab="videoar"]')?.click(),
      });
      if (import.meta.env.DEV) Object.assign(window, { __safetyWorkspace: safetyWorkspace });
      return safetyWorkspace;
    }).catch(error => { safetyWorkspaceLoading = undefined; throw error; });
    const sceneWorkspace = await safetyWorkspaceLoading;
    if (new URLSearchParams(window.location.search).get("interface") === "legacy") await sceneWorkspace.open();
    else {
      managementWorkspaceLoading ??= import("./managementWorkspace").then(({ ManagementWorkspace }) => {
        managementWorkspace = new ManagementWorkspace(sceneWorkspace, $("#safetyWorkspaceHost"));
        if (import.meta.env.DEV) Object.assign(window, { __managementWorkspace: managementWorkspace });
        return managementWorkspace;
      }).catch(error => { managementWorkspaceLoading = undefined; throw error; });
      await (await managementWorkspaceLoading).open();
    }
  } catch (error) { toast(`项目统筹平台打开失败：${error instanceof Error ? error.message : String(error)}`, true); }
}
$("#openSafetyWorkspace").addEventListener("click", () => void openSafetyWorkspace());
void projectLibrary.start().then(() => {
  renderLayers(); viewer.scene.requestRender();
  if (["safety", "management"].includes(new URLSearchParams(window.location.search).get("screen") || "")) void openSafetyWorkspace();
});
$("#basemap").addEventListener("change", () => projectLibrary?.saveView());

$("#videoArClear").textContent = "关闭回放";
$("#videoArClear").title = "关闭当前回放，已保存资料仍保留；永久删除请使用本机资料库";
