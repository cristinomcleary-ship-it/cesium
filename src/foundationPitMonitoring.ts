import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ColorGeometryInstanceAttribute,
  ComponentDatatype,
  CustomDataSource,
  DistanceDisplayCondition,
  Geometry,
  GeometryAttribute,
  GeometryAttributes,
  GeometryInstance,
  HeadingPitchRoll,
  HorizontalOrigin,
  IntersectionTests,
  LabelStyle,
  Math as CesiumMath,
  Matrix4,
  Plane,
  PerInstanceColorAppearance,
  Primitive,
  PrimitiveCollection,
  PrimitiveType,
  PolygonHierarchy,
  PolylineArrowMaterialProperty,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Transforms,
  VerticalOrigin,
  Viewer,
} from "cesium";

type EnclosureType = "sheetPile" | "secantPile" | "diaphragmWall";
type WalerType = "steel" | "concrete" | "combined";
type StrutType = "steelPipe" | "hSteel" | "concrete";
type StrutLayout = "transverse" | "longitudinal" | "cross";
type PitEdge = "A" | "B" | "C" | "D";
type PointPlacement = "enclosure" | "settlement" | "free";
export type FoundationPitMonitoringStatus = "unmeasured" | "normal" | "warning" | "alarm";
type MonitoringStatus = FoundationPitMonitoringStatus;
type PickMode = "center" | "monitoring" | "support";

interface CustomSupport {
  id: string;
  name: string;
  depth: number;
  type: StrutType;
  width: number;
  height: number;
  start: LocalPoint;
  end: LocalPoint;
}

interface FoundationPit {
  id: string;
  name: string;
  longitude: number;
  latitude: number;
  groundHeight: number;
  heading: number;
  length: number;
  width: number;
  depth: number;
  exposure: number;
  supportDepth: number;
  displayOffset: number;
  displayScale: number;
  visible: boolean;
  enclosureType: EnclosureType;
  hasWaler: boolean;
  walerType: WalerType;
  walerWidth: number;
  walerHeight: number;
  hasStrut: boolean;
  strutType: StrutType;
  strutLayout: StrutLayout;
  strutWidth: number;
  strutHeight: number;
  supportDepths: number[];
  customSupports: CustomSupport[];
}

interface MonitoringRecord {
  id: string;
  pointId: string;
  timestamp: string;
  x: number;
  y: number;
  z: number;
  note: string;
}

interface MonitoringPoint {
  id: string;
  name: string;
  pitId: string | null;
  placement: PointPlacement;
  edge: PitEdge;
  along: number;
  depth: number;
  offset: number;
  longitude: number;
  latitude: number;
  height: number;
  speedThreshold: number;
  cumulativeThreshold: number;
  records: MonitoringRecord[];
}

interface SupportMonitoringRecord {
  id: string;
  timestamp: string;
  axialForce: number;
  deformation: number;
  note: string;
}

interface SupportMonitor {
  id: string;
  pitId: string;
  name: string;
  targetType: "level" | "custom";
  targetId: string;
  depth: number;
  axialForceThreshold: number;
  deformationThreshold: number;
  records: SupportMonitoringRecord[];
}

interface MonitoringState {
  version: 3;
  pits: FoundationPit[];
  points: MonitoringPoint[];
  supportMonitors: SupportMonitor[];
}

interface SupportMetrics {
  latest?: SupportMonitoringRecord;
  status: MonitoringStatus;
  reasons: string[];
}

interface MovementMetrics {
  latest?: MonitoringRecord;
  cumulative: number;
  speed: number;
  status: MonitoringStatus;
  reasons: string[];
}

interface LocalPoint {
  x: number;
  y: number;
  z: number;
}

export type FoundationPitOverviewItem = {
  id: string;
  name: string;
  visible: boolean;
  enclosureType: string;
  monitoringCount: number;
  normalCount: number;
  warningCount: number;
  alarmCount: number;
  unmeasuredCount: number;
  updatedAt?: string;
};

export type FoundationPitOverviewSnapshot = {
  pits: number;
  points: number;
  supportMonitors: number;
  totalMonitoringItems: number;
  normal: number;
  warning: number;
  alarm: number;
  unmeasured: number;
  items: readonly FoundationPitOverviewItem[];
};

export type FoundationPitOverviewListener = (snapshot: FoundationPitOverviewSnapshot) => void;

const STORAGE_KEY = "cesium-foundation-pit-monitoring-v1";
const DAY_MS = 86_400_000;
const EDGES: PitEdge[] = ["A", "B", "C", "D"];
const ENCLOSURE_LABEL: Record<EnclosureType, string> = {
  sheetPile: "拉森钢板桩围护",
  secantPile: "咬合桩围护",
  diaphragmWall: "地连墙围护",
};
const WALER_LABEL: Record<WalerType, string> = { steel: "型钢围檩", concrete: "钢筋混凝土围檩", combined: "组合围檩" };
const STRUT_LABEL: Record<StrutType, string> = { steelPipe: "钢管对撑", hSteel: "H 型钢对撑", concrete: "钢筋混凝土对撑" };
const STRUT_LAYOUT_LABEL: Record<StrutLayout, string> = { transverse: "横向对撑", longitudinal: "纵向对撑", cross: "十字对撑" };
const EDGE_LABEL: Record<PitEdge, string> = { A: "A 边（长边 1）", B: "B 边（短边 1）", C: "C 边（长边 2）", D: "D 边（短边 2）" };
const STATUS_LABEL: Record<MonitoringStatus, string> = { unmeasured: "未监测", normal: "正常", warning: "接近预警", alarm: "超限预警" };
const STATUS_COLOR: Record<MonitoringStatus, Color> = {
  unmeasured: Color.fromCssColorString("#65a8d1"),
  normal: Color.fromCssColorString("#48d6a0"),
  warning: Color.fromCssColorString("#ffd166"),
  alarm: Color.fromCssColorString("#ff334f"),
};
const LARSSEN_IV = { effectiveWidth: 0.4, sectionHeight: 0.17, thickness: 0.0155 } as const;

export const foundationPitMonitoringPanelHtml = `
  <section class="panel monitoring-panel" data-panel="monitoring">
    <div class="monitoring-heading">
      <div><strong>基坑监测</strong><small>参数化建模 · 三维布点 · 位移预警</small></div>
      <label class="monitoring-map-toggle"><input id="pitMonitoringVisible" type="checkbox" checked />地图显示</label>
    </div>
    <div class="monitoring-summary" aria-label="监测概况">
      <div><span id="pitSummaryTotal">0</span><small>监测项</small></div>
      <div class="normal"><span id="pitSummaryNormal">0</span><small>正常</small></div>
      <div class="warning"><span id="pitSummaryWarning">0</span><small>接近预警</small></div>
      <div class="alarm"><span id="pitSummaryAlarm">0</span><small>超限</small></div>
    </div>

    <details open>
      <summary>第一步：创建基坑与围护结构</summary>
      <div class="monitoring-existing-row">
        <label>当前基坑<select id="pitActivePit"><option value="">新建基坑</option></select></label>
        <button id="pitNewModel" type="button">新建</button>
      </div>
      <div id="pitManagementList" class="pit-management-list"></div>
      <label>基坑名称<input id="pitName" type="text" placeholder="例如：1# 主基坑" /></label>
      <label>围护形式<select id="pitEnclosureType">
        <option value="sheetPile">拉森钢板桩围护</option>
        <option value="secantPile">咬合桩围护</option>
        <option value="diaphragmWall">地连墙围护</option>
      </select></label>
      <div class="field-grid">
        <label>中心经度<input id="pitCenterLon" type="number" step="any" placeholder="地图选点" /></label>
        <label>中心纬度<input id="pitCenterLat" type="number" step="any" placeholder="地图选点" /></label>
        <label>地面高程（m）<input id="pitGroundHeight" type="number" step="any" value="0" /></label>
        <label>长边方位角（°）<input id="pitHeading" type="number" step="any" value="0" /></label>
      </div>
      <button id="pitPickCenter" type="button" class="secondary monitoring-pick-button">⌖ 在倾斜摄影模型上选择基坑中心</button>
      <p id="pitCenterStatus" class="hint">方位角以正北为 0°，顺时针为正。</p>
      <div class="field-grid">
        <label>基坑长（m）<input id="pitLength" type="number" min="0.1" step="any" value="40" /></label>
        <label>基坑宽（m）<input id="pitWidth" type="number" min="0.1" step="any" value="25" /></label>
        <label>基坑深度（m）<input id="pitDepth" type="number" min="0.1" step="any" value="10" /></label>
        <label>围护露出地面（m）<input id="pitExposure" type="number" min="0" step="any" value="0.5" /></label>
        <label><span id="pitSupportDepthLabel">拉森钢板桩长度（m）</span><input id="pitSupportDepth" type="number" min="0.1" step="any" value="15" /></label>
        <label>模型展示抬高（m）<input id="pitDisplayOffset" type="number" min="0" step="any" value="17" /></label>
        <label>模型显示比例<input id="pitDisplayScale" type="number" min="0.05" max="5" step="0.05" value="1" /></label>
      </div>
      <label class="check-label pit-single-visible"><input id="pitModelVisible" type="checkbox" checked />显示当前基坑模型与监测标记</label>
      <p class="hint">模型会自动抬至倾斜摄影上方；显示比例仅缩放展示模型，不改变真实尺寸、坐标和监测值。</p>
    </details>

    <details open>
      <summary>第二步：围檩与对撑</summary>
      <div class="monitoring-check-grid">
        <label class="check-label"><input id="pitHasWaler" type="checkbox" />设置围檩</label>
        <label class="check-label"><input id="pitHasStrut" type="checkbox" />设置对撑</label>
      </div>
      <div id="pitWalerFields" class="hidden">
        <label>围檩形式<select id="pitWalerType"><option value="steel">型钢围檩</option><option value="concrete">钢筋混凝土围檩</option><option value="combined">组合围檩</option></select></label>
        <div class="field-grid"><label>围檩宽度（m）<input id="pitWalerWidth" type="number" min="0.01" step="any" value="0.4" /></label><label>围檩高度（m）<input id="pitWalerHeight" type="number" min="0.01" step="any" value="0.6" /></label></div>
      </div>
      <div id="pitStrutFields" class="hidden">
        <div class="field-grid">
          <label>对撑形式<select id="pitStrutType"><option value="steelPipe">钢管对撑</option><option value="hSteel">H 型钢对撑</option><option value="concrete">钢筋混凝土对撑</option></select></label>
          <label>平面布置<select id="pitStrutLayout"><option value="transverse">横向对撑</option><option value="longitudinal">纵向对撑</option><option value="cross">十字对撑</option></select></label>
          <label>对撑宽/直径（m）<input id="pitStrutWidth" type="number" min="0.01" step="any" value="0.6" /></label>
          <label>对撑高度（m）<input id="pitStrutHeight" type="number" min="0.01" step="any" value="0.6" /></label>
        </div>
      </div>
      <div id="pitSupportLevelFields" class="hidden">
        <div id="pitSupportRows" class="pit-support-levels"></div>
        <button id="pitAddSupportLevel" type="button" class="monitoring-inline-button">＋ 增加一道支撑</button>
        <p class="hint">每道支撑按其独立深度布置；需要第二道或更多支撑时逐道增加。</p>
      </div>
      <div class="pit-custom-support-panel">
        <strong>用户自绘支撑</strong>
        <div class="field-grid">
          <label>支撑名称<input id="pitCustomSupportName" type="text" placeholder="例如：斜撑 1" /></label>
          <label>支撑深度（m）<input id="pitCustomSupportDepth" type="number" min="0.01" step="any" value="3" /></label>
          <label>支撑形式<select id="pitCustomSupportType"><option value="steelPipe">钢管支撑</option><option value="hSteel">H 型钢支撑</option><option value="concrete">钢筋混凝土支撑</option></select></label>
          <label>宽/直径（m）<input id="pitCustomSupportWidth" type="number" min="0.01" step="any" value="0.6" /></label>
          <label>高度（m）<input id="pitCustomSupportHeight" type="number" min="0.01" step="any" value="0.6" /></label>
        </div>
        <button id="pitDrawCustomSupport" type="button" class="secondary monitoring-pick-button">✎ 在基坑模型上依次点击支撑两端</button>
        <p id="pitCustomSupportStatus" class="hint">先保存基坑，再在坑内自由绘制横撑、纵撑或斜撑。</p>
        <div id="pitCustomSupportList" class="pit-custom-support-list"></div>
      </div>
      <div class="monitoring-actions three">
        <button id="pitDeleteModel" type="button" class="danger">删除当前</button>
        <button id="pitCreateModel" type="button" class="accent">创建/更新基坑模型</button>
      </div>
      <div class="monitoring-deformation-control">
        <label>变形显示放大倍数<input id="pitDeformationScale" type="number" min="1" max="1000" step="1" value="50" /></label>
        <small>报警按真实毫米值判断；放大倍数仅用于看清模型变形。</small>
      </div>
    </details>

    <details open>
      <summary>第三步：在基坑模型上布置监测点</summary>
      <label>所属基坑<select id="pitPointPit"><option value="">请先创建基坑</option></select></label>
      <div class="pit-edge-diagram" aria-label="基坑边编号示意"><span class="edge-a">A 长边 1</span><span class="edge-b">B<br/>短边 1</span><span class="edge-c">C 长边 2</span><span class="edge-d">D<br/>短边 2</span><i>基坑内部</i></div>
      <label>监测点类型<select id="pitPointPlacement"><option value="enclosure">围护结构变形监测点</option><option value="settlement">地表沉降观测点</option></select></label>
      <label>监测点名称<input id="pitPointName" type="text" placeholder="例如：ZQT-A-01" /></label>
      <div class="field-grid">
        <label>所在边<select id="pitPointEdge"><option value="A">A 边（长边 1）</option><option value="B">B 边（短边 1）</option><option value="C">C 边（长边 2）</option><option value="D">D 边（短边 2）</option></select></label>
        <label>距该边起点（m）<input id="pitPointAlong" type="number" min="0" step="any" value="5" /></label>
        <label id="pitPointDepthField">监测深度（m）<input id="pitPointDepth" type="number" min="0" step="any" value="2" /></label>
        <label id="pitPointOffsetField" class="hidden">距基坑边（m）<input id="pitPointOffset" type="number" min="0" step="any" value="5" /></label>
      </div>
      <p id="pitEdgeHint" class="hint">A 边长度 40.00 m，沿边位置应在 0～40.00 m。</p>
      <button id="pitPickMonitoringPoint" type="button" class="secondary monitoring-pick-button">⌖ 在基坑模型上选取并自动识别边、位置和深度</button>
      <div class="field-grid">
        <label>变形速度预警值（mm/d）<input id="pitSpeedThreshold" type="number" min="0.0001" step="any" value="2" /></label>
        <label>累计位移预警值（mm）<input id="pitCumulativeThreshold" type="number" min="0.0001" step="any" value="20" /></label>
      </div>
      <button id="pitAddPoint" type="button" class="primary monitoring-primary">新增监测点</button>
      <p id="pitPointPickStatus" class="hint">围护点按所在边、沿边距离和深度定位；沉降点按距坑边距离定位。</p>
    </details>

    <details open>
      <summary>第四步：录入每日 X、Y、Z 累计位移</summary>
      <label>监测点<select id="pitRecordPoint"><option value="">请先新增监测点</option></select></label>
      <div class="field-grid monitoring-threshold-edit">
        <label>速度预警值（mm/d）<input id="pitEditSpeedThreshold" type="number" min="0.0001" step="any" /></label>
        <label>累计预警值（mm）<input id="pitEditCumulativeThreshold" type="number" min="0.0001" step="any" /></label>
      </div>
      <button id="pitUpdateThresholds" type="button" class="monitoring-inline-button">更新当前点预警值</button>
      <label>监测日期<input id="pitRecordTime" type="datetime-local" /></label>
      <div class="field-grid monitoring-vector-inputs">
        <label id="pitRecordXField">X 累计位移（mm）<input id="pitRecordX" type="number" step="any" value="0" /></label>
        <label id="pitRecordYField">Y 累计位移（mm）<input id="pitRecordY" type="number" step="any" value="0" /></label>
        <label>Z 累计位移（mm）<input id="pitRecordZ" type="number" step="any" value="0" /></label>
      </div>
      <p id="pitRecordAxisHint" class="hint">X 为基坑长边方向、Y 为短边方向、Z 为竖向；数据按相对初始值的累计位移录入。</p>
      <label>备注<input id="pitRecordNote" type="text" placeholder="可填写天气、工况、仪器或异常说明" /></label>
      <button id="pitAddRecord" type="button" class="primary monitoring-primary">保存日报并更新模型</button>
      <div class="monitoring-file-actions">
        <label class="monitoring-file-button">导入每日 CSV<input id="pitCsvFile" type="file" accept=".csv,text/csv" hidden /></label>
        <button id="pitExportCsv" type="button">导出 CSV</button>
        <button id="pitExportJson" type="button">备份 JSON</button>
      </div>
      <p class="hint">CSV 列：监测点、监测时间、X、Y、Z、备注。沉降点的 X、Y 可留空。</p>
    </details>

    <details open>
      <summary>第五步：支撑轴力与变形监测</summary>
      <label>所属基坑<select id="pitSupportMonitorPit"><option value="">请先创建基坑</option></select></label>
      <label>监测支撑<select id="pitSupportMonitorTarget"><option value="">请先设置支撑</option></select></label>
      <label>监测项名称<input id="pitSupportMonitorName" type="text" placeholder="例如：ZL-01" /></label>
      <div class="field-grid">
        <label>轴力预警值（kN）<input id="pitAxialForceThreshold" type="number" min="0.0001" step="any" value="1500" /></label>
        <label>变形预警值（mm）<input id="pitSupportDeformationThreshold" type="number" min="0.0001" step="any" value="10" /></label>
      </div>
      <button id="pitAddSupportMonitor" type="button" class="primary monitoring-primary">新增支撑监测项</button>
      <label>录入监测项<select id="pitSupportRecordMonitor"><option value="">请先新增支撑监测项</option></select></label>
      <label>监测日期<input id="pitSupportRecordTime" type="datetime-local" /></label>
      <div class="field-grid">
        <label>支撑轴力（kN）<input id="pitSupportAxialForce" type="number" step="any" value="0" /></label>
        <label>支撑变形（mm）<input id="pitSupportDeformation" type="number" step="any" value="0" /></label>
      </div>
      <label>备注<input id="pitSupportRecordNote" type="text" placeholder="可填写工况、测点或仪器说明" /></label>
      <button id="pitAddSupportRecord" type="button" class="primary monitoring-primary">保存支撑监测数据</button>
      <div id="pitSupportMonitorList" class="monitoring-point-list"></div>
    </details>

    <details open>
      <summary>第六步：趋势、真实模型变形与超限预警</summary>
      <label>查看监测点<select id="pitTrendPoint"><option value="">暂无监测点</option></select></label>
      <div class="monitoring-legend"><span class="cumulative">累计位移（mm）</span><span class="speed">变形速度（mm/d）</span></div>
      <div id="pitTrendChart" class="monitoring-chart"><div class="monitoring-empty">录入监测数据后显示趋势图</div></div>
      <div id="pitAlertList" class="monitoring-alert-list"></div>
    </details>

    <details>
      <summary>监测点台账</summary>
      <div id="pitPointList" class="monitoring-point-list"></div>
    </details>
  </section>`;

export class FoundationPitMonitoring {
  private readonly dataSource = new CustomDataSource("基坑监测与模型");
  private readonly sheetPilePrimitives = new PrimitiveCollection();
  private state: MonitoringState;
  private pickHandler: ScreenSpaceEventHandler | null = null;
  private pickMode: PickMode | null = null;
  private customSupportStart: LocalPoint | null = null;
  private centerSelectionHandler: ScreenSpaceEventHandler | null = null;
  private interactionSuspensionDepth = 0;
  private readonly overviewListeners = new Set<FoundationPitOverviewListener>();

  constructor(private readonly viewer: Viewer, private readonly toast: (message: string, error?: boolean) => void) {
    this.state = this.loadState();
    this.viewer.scene.primitives.add(this.sheetPilePrimitives);
    void this.viewer.dataSources.add(this.dataSource);
    this.bindEvents();
    this.bindCenterSelection();
    this.input<HTMLInputElement>("#pitRecordTime").value = this.localDateTimeValue(new Date());
    this.input<HTMLInputElement>("#pitSupportRecordTime").value = this.localDateTimeValue(new Date());
    this.render();
    const firstPit = this.state.pits[0];
    if (firstPit) this.loadPitIntoForm(firstPit);
    else this.resetPitForm();
    this.syncConditionFields();
    this.syncPointPlacementFields();
    this.syncRecordPointFields();
    this.renderPitManagementList();
  }

  dispose() {
    this.stopPicking();
    if (this.centerSelectionHandler && !this.centerSelectionHandler.isDestroyed()) this.centerSelectionHandler.destroy();
    this.centerSelectionHandler = null;
    if (this.viewer.scene.primitives.contains(this.sheetPilePrimitives)) this.viewer.scene.primitives.remove(this.sheetPilePrimitives);
    if (this.viewer.dataSources.contains(this.dataSource)) this.viewer.dataSources.remove(this.dataSource, true);
    this.overviewListeners.clear();
  }

  /** A bounded, read-only catalog projection for the platform data center. */
  getOverviewSnapshot(): FoundationPitOverviewSnapshot {
    const counts: Record<MonitoringStatus, number> = { unmeasured: 0, normal: 0, warning: 0, alarm: 0 };
    this.state.points.forEach((point) => { counts[this.metrics(point).status] += 1; });
    this.state.supportMonitors.forEach((monitor) => { counts[this.supportMetrics(monitor).status] += 1; });
    const items = this.state.pits.slice(0, 100).map((pit): FoundationPitOverviewItem => {
      const pitCounts: Record<MonitoringStatus, number> = { unmeasured: 0, normal: 0, warning: 0, alarm: 0 };
      const timestamps: string[] = [];
      const points = this.state.points.filter((point) => point.pitId === pit.id);
      const monitors = this.state.supportMonitors.filter((monitor) => monitor.pitId === pit.id);
      points.forEach((point) => {
        pitCounts[this.metrics(point).status] += 1;
        const latest = point.records.at(-1)?.timestamp;
        if (latest) timestamps.push(latest);
      });
      monitors.forEach((monitor) => {
        pitCounts[this.supportMetrics(monitor).status] += 1;
        const latest = monitor.records.at(-1)?.timestamp;
        if (latest) timestamps.push(latest);
      });
      timestamps.sort();
      return Object.freeze({
        id: pit.id,
        name: pit.name,
        visible: pit.visible,
        enclosureType: ENCLOSURE_LABEL[pit.enclosureType],
        monitoringCount: points.length + monitors.length,
        normalCount: pitCounts.normal,
        warningCount: pitCounts.warning,
        alarmCount: pitCounts.alarm,
        unmeasuredCount: pitCounts.unmeasured,
        ...(timestamps.length ? { updatedAt: timestamps[timestamps.length - 1] } : {}),
      });
    });
    return Object.freeze({
      pits: this.state.pits.length,
      points: this.state.points.length,
      supportMonitors: this.state.supportMonitors.length,
      totalMonitoringItems: this.state.points.length + this.state.supportMonitors.length,
      normal: counts.normal,
      warning: counts.warning,
      alarm: counts.alarm,
      unmeasured: counts.unmeasured,
      items: Object.freeze(items),
    });
  }

  subscribeOverview(listener: FoundationPitOverviewListener) {
    this.overviewListeners.add(listener);
    return () => { this.overviewListeners.delete(listener); };
  }

  private notifyOverview() {
    if (!this.overviewListeners.size) return;
    const snapshot = this.getOverviewSnapshot();
    for (const listener of this.overviewListeners) {
      try { listener(snapshot); } catch { /* Overview observers cannot break monitoring. */ }
    }
  }

  /** Temporarily pauses scene picking without discarding an unfinished pit operation. */
  suspendInteractions() {
    this.interactionSuspensionDepth += 1;
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      this.interactionSuspensionDepth = Math.max(0, this.interactionSuspensionDepth - 1);
    };
  }

  private element<T extends HTMLElement>(selector: string) {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`基坑监测界面元素不存在：${selector}`);
    return element;
  }

  private input<T extends HTMLInputElement | HTMLSelectElement>(selector: string) {
    return this.element<T>(selector);
  }

  private bindEvents() {
    this.element<HTMLButtonElement>("#pitPickCenter").addEventListener("click", () => this.togglePicking("center"));
    this.element<HTMLButtonElement>("#pitPickMonitoringPoint").addEventListener("click", () => this.togglePicking("monitoring"));
    this.element<HTMLButtonElement>("#pitDrawCustomSupport").addEventListener("click", () => this.togglePicking("support"));
    this.element<HTMLButtonElement>("#pitAddSupportLevel").addEventListener("click", () => this.addSupportDepthRow());
    this.element("#pitSupportRows").addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-remove-support-level]");
      if (button) button.closest(".pit-support-level-row")?.remove();
    });
    this.element<HTMLButtonElement>("#pitNewModel").addEventListener("click", () => this.beginNewPit());
    this.element<HTMLButtonElement>("#pitCreateModel").addEventListener("click", () => this.createOrUpdatePit());
    this.element<HTMLButtonElement>("#pitDeleteModel").addEventListener("click", () => this.deleteActivePit());
    this.element<HTMLButtonElement>("#pitAddPoint").addEventListener("click", () => this.addPoint());
    this.element<HTMLButtonElement>("#pitAddRecord").addEventListener("click", () => this.addRecord());
    this.element<HTMLButtonElement>("#pitUpdateThresholds").addEventListener("click", () => this.updateThresholds());
    this.element<HTMLButtonElement>("#pitAddSupportMonitor").addEventListener("click", () => this.addSupportMonitor());
    this.element<HTMLButtonElement>("#pitAddSupportRecord").addEventListener("click", () => this.addSupportRecord());
    this.input<HTMLSelectElement>("#pitActivePit").addEventListener("change", () => {
      const pit = this.activePit();
      if (pit) {
        this.input<HTMLSelectElement>("#pitSupportMonitorPit").value = pit.id;
        this.loadPitIntoForm(pit);
      }
      else this.resetPitForm();
      this.renderCustomSupportList();
      this.renderSupportMonitoringSelectors();
      this.renderPitManagementList();
    });
    this.input<HTMLInputElement>("#pitHasWaler").addEventListener("change", () => this.syncConditionFields());
    this.input<HTMLInputElement>("#pitHasStrut").addEventListener("change", () => this.syncConditionFields());
    this.input<HTMLInputElement>("#pitModelVisible").addEventListener("change", () => this.updateActivePitVisibility());
    this.input<HTMLSelectElement>("#pitEnclosureType").addEventListener("change", () => this.syncEnclosureFields());
    this.input<HTMLSelectElement>("#pitPointPit").addEventListener("change", () => this.updateEdgeHint());
    this.input<HTMLSelectElement>("#pitSupportMonitorPit").addEventListener("change", () => this.renderSupportTargetOptions());
    this.input<HTMLSelectElement>("#pitPointPlacement").addEventListener("change", () => this.syncPointPlacementFields());
    this.input<HTMLSelectElement>("#pitPointEdge").addEventListener("change", () => this.updateEdgeHint());
    this.input<HTMLSelectElement>("#pitRecordPoint").addEventListener("change", (event) => {
      const pointId = (event.currentTarget as HTMLSelectElement).value;
      this.input<HTMLSelectElement>("#pitTrendPoint").value = pointId;
      this.syncRecordPointFields();
      this.renderTrend();
    });
    this.input<HTMLSelectElement>("#pitTrendPoint").addEventListener("change", () => this.renderTrend());
    this.input<HTMLInputElement>("#pitDeformationScale").addEventListener("input", () => this.renderScene());
    this.input<HTMLInputElement>("#pitMonitoringVisible").addEventListener("change", (event) => {
      this.dataSource.show = (event.currentTarget as HTMLInputElement).checked;
      this.sheetPilePrimitives.show = this.dataSource.show;
      this.viewer.scene.requestRender();
    });
    this.input<HTMLInputElement>("#pitCsvFile").addEventListener("change", (event) => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      if (file) void this.importCsv(file);
      input.value = "";
    });
    this.element<HTMLButtonElement>("#pitExportCsv").addEventListener("click", () => this.exportCsv());
    this.element<HTMLButtonElement>("#pitExportJson").addEventListener("click", () => this.exportJson());
    this.element("#pitPointList").addEventListener("click", (event) => this.handleListAction(event));
    this.element("#pitAlertList").addEventListener("click", (event) => { this.handleListAction(event); this.handleSupportMonitorAction(event); });
    this.element("#pitCustomSupportList").addEventListener("click", (event) => this.handleCustomSupportAction(event));
    this.element("#pitSupportMonitorList").addEventListener("click", (event) => this.handleSupportMonitorAction(event));
    this.element("#pitManagementList").addEventListener("click", (event) => this.handlePitManagementAction(event));
    document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => tab.addEventListener("click", () => {
      if (tab.dataset.tab !== "monitoring") this.stopPicking();
    }));
  }

  private bindCenterSelection() {
    this.centerSelectionHandler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this.centerSelectionHandler.setInputAction((movement: { position: Cartesian2 }) => {
      if (this.interactionSuspensionDepth > 0) return;
      if (this.pickMode) return;
      let picked: { id?: unknown } | undefined;
      try { picked = this.viewer.scene.pick(movement.position) as { id?: unknown } | undefined; } catch { return; }
      const candidate = picked?.id;
      const entityId = typeof candidate === "string"
        ? candidate
        : candidate && typeof candidate === "object" && "id" in candidate && typeof (candidate as { id?: unknown }).id === "string"
          ? String((candidate as { id: string }).id)
          : "";
      const prefix = "foundation-pit-anchor-";
      if (!entityId.startsWith(prefix)) return;
      const pit = this.state.pits.find((item) => item.id === entityId.slice(prefix.length));
      if (pit) this.selectPitForManagement(pit, true);
    }, ScreenSpaceEventType.LEFT_CLICK);
  }

  private selectPitForManagement(pit: FoundationPit, fromMap = false) {
    this.input<HTMLSelectElement>("#pitActivePit").value = pit.id;
    this.input<HTMLSelectElement>("#pitPointPit").value = pit.id;
    this.input<HTMLSelectElement>("#pitSupportMonitorPit").value = pit.id;
    this.loadPitIntoForm(pit);
    this.renderSupportTargetOptions();
    this.renderCustomSupportList();
    this.renderPitManagementList();
    const entity = this.dataSource.entities.getById(`foundation-pit-anchor-${pit.id}`);
    if (entity) this.viewer.selectedEntity = entity;
    if (fromMap) this.toast(`已选择基坑“${pit.name}”，可在面板中显示、隐藏或修改`);
  }

  private updateActivePitVisibility() {
    const pit = this.activePit();
    if (!pit) return;
    pit.visible = this.input<HTMLInputElement>("#pitModelVisible").checked;
    this.saveState();
    this.render(pit.id);
    this.loadPitIntoForm(pit);
    this.toast(`基坑“${pit.name}”已${pit.visible ? "显示" : "隐藏"}`);
  }

  private handlePitManagementAction(event: Event) {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-pit-manage-action]");
    const pit = this.state.pits.find((candidate) => candidate.id === button?.dataset.pitId);
    if (!button || !pit) return;
    const action = button.dataset.pitManageAction;
    if (action === "select") this.selectPitForManagement(pit);
    if (action === "locate") { this.selectPitForManagement(pit); this.locatePit(pit); }
    if (action === "toggle") {
      pit.visible = !pit.visible;
      this.saveState();
      this.render(pit.id);
      this.loadPitIntoForm(pit);
      this.toast(`基坑“${pit.name}”已${pit.visible ? "显示" : "隐藏"}`);
    }
  }

  private loadState(): MonitoringState {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Record<string, unknown> | null;
      if (!raw || !Array.isArray(raw.points)) return { version: 3, pits: [], points: [], supportMonitors: [] };
      const pits = Array.isArray(raw.pits) ? raw.pits.map((pit) => this.normalizePit(pit)).filter((pit): pit is FoundationPit => Boolean(pit)) : [];
      const points = raw.points.map((point) => this.normalizePoint(point)).filter((point): point is MonitoringPoint => Boolean(point));
      const supportMonitors = Array.isArray(raw.supportMonitors)
        ? raw.supportMonitors.map((monitor) => this.normalizeSupportMonitor(monitor)).filter((monitor): monitor is SupportMonitor => Boolean(monitor))
        : [];
      return { version: 3, pits, points, supportMonitors };
    } catch {
      return { version: 3, pits: [], points: [], supportMonitors: [] };
    }
  }

  private normalizePit(value: unknown): FoundationPit | null {
    if (!value || typeof value !== "object") return null;
    const pit = value as Partial<FoundationPit>;
    if (typeof pit.id !== "string" || typeof pit.name !== "string") return null;
    const numericFields = [pit.longitude, pit.latitude, pit.groundHeight, pit.length, pit.width, pit.depth];
    if (!numericFields.every(Number.isFinite)) return null;
    const depth = Number(pit.depth);
    const exposure = Number.isFinite(pit.exposure) ? Math.max(0, Number(pit.exposure)) : 0.5;
    const minimumSupportDepth = depth + exposure + Math.max(2, depth * 0.3);
    const supportDepth = Number.isFinite(pit.supportDepth) ? Math.max(minimumSupportDepth, Number(pit.supportDepth)) : minimumSupportDepth;
    const displayScale = Number.isFinite(pit.displayScale) ? Math.max(0.05, Math.min(5, Number(pit.displayScale))) : 1;
    const minimumDisplayOffset = (supportDepth - exposure) * displayScale + 2;
    const customSupports = Array.isArray(pit.customSupports) ? pit.customSupports.map((support) => this.normalizeCustomSupport(support)).filter((support): support is CustomSupport => Boolean(support)) : [];
    return {
      id: pit.id,
      name: pit.name,
      longitude: Number(pit.longitude),
      latitude: Number(pit.latitude),
      groundHeight: Number(pit.groundHeight),
      heading: Number.isFinite(pit.heading) ? Number(pit.heading) : 0,
      length: Number(pit.length),
      width: Number(pit.width),
      depth,
      exposure,
      supportDepth,
      displayOffset: Math.max(minimumDisplayOffset, Number.isFinite(pit.displayOffset) ? Math.max(0, Number(pit.displayOffset)) : minimumDisplayOffset),
      displayScale,
      visible: pit.visible !== false,
      enclosureType: pit.enclosureType && pit.enclosureType in ENCLOSURE_LABEL ? pit.enclosureType : "diaphragmWall",
      hasWaler: Boolean(pit.hasWaler),
      walerType: pit.walerType && pit.walerType in WALER_LABEL ? pit.walerType : "steel",
      walerWidth: Number.isFinite(pit.walerWidth) ? Number(pit.walerWidth) : 0.4,
      walerHeight: Number.isFinite(pit.walerHeight) ? Number(pit.walerHeight) : 0.6,
      hasStrut: Boolean(pit.hasStrut),
      strutType: pit.strutType && pit.strutType in STRUT_LABEL ? pit.strutType : "steelPipe",
      strutLayout: pit.strutLayout && pit.strutLayout in STRUT_LAYOUT_LABEL ? pit.strutLayout : "transverse",
      strutWidth: Number.isFinite(pit.strutWidth) ? Number(pit.strutWidth) : 0.6,
      strutHeight: Number.isFinite(pit.strutHeight) ? Number(pit.strutHeight) : 0.6,
      supportDepths: Array.isArray(pit.supportDepths) ? pit.supportDepths.map(Number).filter(Number.isFinite) : [],
      customSupports,
    };
  }

  private normalizeCustomSupport(value: unknown): CustomSupport | null {
    if (!value || typeof value !== "object") return null;
    const support = value as Partial<CustomSupport>;
    if (typeof support.id !== "string" || !support.start || !support.end) return null;
    const numbers = [support.depth, support.width, support.height, support.start.x, support.start.y, support.end.x, support.end.y];
    if (!numbers.every(Number.isFinite)) return null;
    return {
      id: support.id,
      name: typeof support.name === "string" && support.name.trim() ? support.name : "自绘支撑",
      depth: Math.max(0, Number(support.depth)),
      type: support.type && support.type in STRUT_LABEL ? support.type : "steelPipe",
      width: Math.max(0.01, Number(support.width)),
      height: Math.max(0.01, Number(support.height)),
      start: { x: Number(support.start.x), y: Number(support.start.y), z: -Math.max(0, Number(support.depth)) },
      end: { x: Number(support.end.x), y: Number(support.end.y), z: -Math.max(0, Number(support.depth)) },
    };
  }

  private normalizeSupportMonitor(value: unknown): SupportMonitor | null {
    if (!value || typeof value !== "object") return null;
    const monitor = value as Partial<SupportMonitor>;
    if (typeof monitor.id !== "string" || typeof monitor.pitId !== "string" || typeof monitor.name !== "string") return null;
    const records = Array.isArray(monitor.records) ? monitor.records.map((record) => {
      const item = record as Partial<SupportMonitoringRecord>;
      return {
        id: typeof item.id === "string" ? item.id : crypto.randomUUID(),
        timestamp: typeof item.timestamp === "string" ? item.timestamp : new Date().toISOString(),
        axialForce: Number.isFinite(item.axialForce) ? Number(item.axialForce) : 0,
        deformation: Number.isFinite(item.deformation) ? Number(item.deformation) : 0,
        note: typeof item.note === "string" ? item.note : "",
      };
    }).sort((a, b) => a.timestamp.localeCompare(b.timestamp)) : [];
    return {
      id: monitor.id,
      pitId: monitor.pitId,
      name: monitor.name,
      targetType: monitor.targetType === "custom" ? "custom" : "level",
      targetId: typeof monitor.targetId === "string" ? monitor.targetId : "",
      depth: Number.isFinite(monitor.depth) ? Math.max(0, Number(monitor.depth)) : 0,
      axialForceThreshold: Number.isFinite(monitor.axialForceThreshold) ? Math.max(0.0001, Number(monitor.axialForceThreshold)) : 1500,
      deformationThreshold: Number.isFinite(monitor.deformationThreshold) ? Math.max(0.0001, Number(monitor.deformationThreshold)) : 10,
      records,
    };
  }

  private normalizePoint(value: unknown): MonitoringPoint | null {
    if (!value || typeof value !== "object") return null;
    const point = value as Partial<MonitoringPoint> & { kind?: string; warningThreshold?: number; alarmThreshold?: number; records?: Array<Partial<MonitoringRecord> & { value?: number }> };
    if (typeof point.id !== "string" || typeof point.name !== "string") return null;
    const longitude = Number(point.longitude);
    const latitude = Number(point.latitude);
    const height = Number(point.height);
    if (![longitude, latitude, height].every(Number.isFinite)) return null;
    const placement: PointPlacement = point.placement && ["enclosure", "settlement", "free"].includes(point.placement)
      ? point.placement
      : "free";
    const records = Array.isArray(point.records) ? point.records.map((record) => {
      const legacyRecord = record as Partial<MonitoringRecord> & { value?: number };
      return {
        id: typeof legacyRecord.id === "string" ? legacyRecord.id : crypto.randomUUID(),
        pointId: point.id!,
        timestamp: typeof legacyRecord.timestamp === "string" ? legacyRecord.timestamp : new Date().toISOString(),
        x: Number.isFinite(Number(legacyRecord.x)) ? Number(legacyRecord.x) : 0,
        y: Number.isFinite(Number(legacyRecord.y)) ? Number(legacyRecord.y) : 0,
        z: Number.isFinite(Number(legacyRecord.z)) ? Number(legacyRecord.z) : Number(legacyRecord.value) || 0,
        note: typeof legacyRecord.note === "string" ? legacyRecord.note : "",
      };
    }).sort((a, b) => a.timestamp.localeCompare(b.timestamp)) : [];
    return {
      id: point.id,
      name: point.name,
      pitId: typeof point.pitId === "string" ? point.pitId : null,
      placement,
      edge: point.edge && EDGES.includes(point.edge) ? point.edge : "A",
      along: Number.isFinite(point.along) ? Number(point.along) : 0,
      depth: Number.isFinite(point.depth) ? Number(point.depth) : 0,
      offset: Number.isFinite(point.offset) ? Number(point.offset) : 0,
      longitude,
      latitude,
      height,
      speedThreshold: Number.isFinite(point.speedThreshold) ? Number(point.speedThreshold) : Math.max(0.001, Number(point.warningThreshold) || 2),
      cumulativeThreshold: Number.isFinite(point.cumulativeThreshold) ? Number(point.cumulativeThreshold) : Math.max(0.001, Number(point.alarmThreshold) || 20),
      records,
    };
  }

  private saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch (error) {
      this.toast(error instanceof Error ? `监测数据保存失败：${error.message}` : "监测数据保存失败", true);
    }
  }

  private beginNewPit() {
    this.input<HTMLSelectElement>("#pitActivePit").value = "";
    this.resetPitForm();
    this.stopPicking();
  }

  private resetPitForm() {
    this.input<HTMLInputElement>("#pitName").value = "";
    this.input<HTMLSelectElement>("#pitEnclosureType").value = "sheetPile";
    this.input<HTMLInputElement>("#pitCenterLon").value = "";
    this.input<HTMLInputElement>("#pitCenterLat").value = "";
    this.input<HTMLInputElement>("#pitGroundHeight").value = "0";
    this.input<HTMLInputElement>("#pitHeading").value = "0";
    this.input<HTMLInputElement>("#pitLength").value = "40";
    this.input<HTMLInputElement>("#pitWidth").value = "25";
    this.input<HTMLInputElement>("#pitDepth").value = "10";
    this.input<HTMLInputElement>("#pitExposure").value = "0.5";
    this.input<HTMLInputElement>("#pitSupportDepth").value = "15";
    this.input<HTMLInputElement>("#pitDisplayOffset").value = "17";
    this.input<HTMLInputElement>("#pitDisplayScale").value = "1";
    this.input<HTMLInputElement>("#pitModelVisible").checked = true;
    this.input<HTMLInputElement>("#pitHasWaler").checked = false;
    this.input<HTMLInputElement>("#pitHasStrut").checked = false;
    this.renderSupportDepthRows([2]);
    this.syncConditionFields();
    this.syncEnclosureFields();
    this.element("#pitCenterStatus").textContent = "方位角以正北为 0°，顺时针为正。";
  }

  private loadPitIntoForm(pit: FoundationPit) {
    this.input<HTMLSelectElement>("#pitActivePit").value = pit.id;
    this.input<HTMLInputElement>("#pitName").value = pit.name;
    this.input<HTMLSelectElement>("#pitEnclosureType").value = pit.enclosureType;
    this.input<HTMLInputElement>("#pitCenterLon").value = String(pit.longitude);
    this.input<HTMLInputElement>("#pitCenterLat").value = String(pit.latitude);
    this.input<HTMLInputElement>("#pitGroundHeight").value = String(pit.groundHeight);
    this.input<HTMLInputElement>("#pitHeading").value = String(pit.heading);
    this.input<HTMLInputElement>("#pitLength").value = String(pit.length);
    this.input<HTMLInputElement>("#pitWidth").value = String(pit.width);
    this.input<HTMLInputElement>("#pitDepth").value = String(pit.depth);
    this.input<HTMLInputElement>("#pitExposure").value = String(pit.exposure);
    this.input<HTMLInputElement>("#pitSupportDepth").value = String(pit.supportDepth);
    this.input<HTMLInputElement>("#pitDisplayOffset").value = String(pit.displayOffset);
    this.input<HTMLInputElement>("#pitDisplayScale").value = String(pit.displayScale);
    this.input<HTMLInputElement>("#pitModelVisible").checked = pit.visible;
    this.input<HTMLInputElement>("#pitHasWaler").checked = pit.hasWaler;
    this.input<HTMLSelectElement>("#pitWalerType").value = pit.walerType;
    this.input<HTMLInputElement>("#pitWalerWidth").value = String(pit.walerWidth);
    this.input<HTMLInputElement>("#pitWalerHeight").value = String(pit.walerHeight);
    this.input<HTMLInputElement>("#pitHasStrut").checked = pit.hasStrut;
    this.input<HTMLSelectElement>("#pitStrutType").value = pit.strutType;
    this.input<HTMLSelectElement>("#pitStrutLayout").value = pit.strutLayout;
    this.input<HTMLInputElement>("#pitStrutWidth").value = String(pit.strutWidth);
    this.input<HTMLInputElement>("#pitStrutHeight").value = String(pit.strutHeight);
    this.renderSupportDepthRows(pit.supportDepths.length ? pit.supportDepths : [2]);
    this.syncConditionFields();
    this.syncEnclosureFields();
    this.updateEdgeHint();
    this.renderCustomSupportList();
  }

  private renderSupportDepthRows(depths: number[]) {
    const target = this.element("#pitSupportRows");
    target.innerHTML = "";
    depths.forEach((depth) => this.addSupportDepthRow(depth));
  }

  private addSupportDepthRow(depth?: number) {
    const target = this.element("#pitSupportRows");
    const current = this.supportDepthValues();
    const suggested = depth ?? Math.min(Math.max(0.5, this.positiveValue("#pitDepth", 10) - 0.5), (current[current.length - 1] || 0) + 2);
    const row = document.createElement("div");
    row.className = "pit-support-level-row";
    row.innerHTML = `<span>第 ${target.children.length + 1} 道</span><label>深度（m）<input class="pit-support-depth" type="number" min="0.01" step="any" value="${Number(suggested).toFixed(2)}" /></label><button type="button" data-remove-support-level title="删除此道支撑">×</button>`;
    target.append(row);
  }

  private supportDepthValues() {
    return Array.from(document.querySelectorAll<HTMLInputElement>("#pitSupportRows .pit-support-depth"))
      .map((input) => Number(input.value)).filter(Number.isFinite);
  }

  private syncConditionFields() {
    const hasWaler = this.input<HTMLInputElement>("#pitHasWaler").checked;
    const hasStrut = this.input<HTMLInputElement>("#pitHasStrut").checked;
    this.element("#pitWalerFields").classList.toggle("hidden", !hasWaler);
    this.element("#pitStrutFields").classList.toggle("hidden", !hasStrut);
    this.element("#pitSupportLevelFields").classList.toggle("hidden", !hasWaler && !hasStrut);
  }

  private syncEnclosureFields() {
    const enclosureType = this.input<HTMLSelectElement>("#pitEnclosureType").value as EnclosureType;
    this.element("#pitSupportDepthLabel").textContent = enclosureType === "sheetPile"
      ? "拉森钢板桩长度（m）"
      : enclosureType === "secantPile"
        ? "咬合桩深度（m）"
        : "地连墙深度（m）";
  }

  private createOrUpdatePit() {
    const name = this.input<HTMLInputElement>("#pitName").value.trim();
    const longitude = Number(this.input<HTMLInputElement>("#pitCenterLon").value);
    const latitude = Number(this.input<HTMLInputElement>("#pitCenterLat").value);
    const groundHeight = Number(this.input<HTMLInputElement>("#pitGroundHeight").value);
    const heading = Number(this.input<HTMLInputElement>("#pitHeading").value);
    const length = Number(this.input<HTMLInputElement>("#pitLength").value);
    const width = Number(this.input<HTMLInputElement>("#pitWidth").value);
    const depth = Number(this.input<HTMLInputElement>("#pitDepth").value);
    const exposure = Number(this.input<HTMLInputElement>("#pitExposure").value);
    const supportDepth = Number(this.input<HTMLInputElement>("#pitSupportDepth").value);
    const requestedDisplayOffset = Number(this.input<HTMLInputElement>("#pitDisplayOffset").value);
    const displayScale = Number(this.input<HTMLInputElement>("#pitDisplayScale").value);
    if (!name) return this.toast("请填写基坑名称", true);
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) return this.toast("请先在倾斜摄影模型上选择基坑中心", true);
    if (![groundHeight, heading, length, width, depth, exposure, supportDepth, requestedDisplayOffset, displayScale].every(Number.isFinite) || length <= 0 || width <= 0 || depth <= 0 || exposure < 0 || requestedDisplayOffset < 0 || displayScale < 0.05 || displayScale > 5) return this.toast("基坑尺寸、深度、高程、展示抬高和显示比例必须是有效数字", true);
    if (supportDepth <= depth + exposure) return this.toast(`支护长度必须大于基坑深度与露出长度之和（当前至少应大于 ${(depth + exposure).toFixed(2)} m）`, true);
    const minimumDisplayOffset = (supportDepth - exposure) * displayScale + 2;
    const displayOffset = Math.max(requestedDisplayOffset, minimumDisplayOffset);
    const hasWaler = this.input<HTMLInputElement>("#pitHasWaler").checked;
    const hasStrut = this.input<HTMLInputElement>("#pitHasStrut").checked;
    let supportDepths: number[] = [];
    if (hasWaler || hasStrut) {
      supportDepths = [...new Set(this.supportDepthValues())].sort((a, b) => a - b);
      if (!supportDepths.length) return this.toast("请至少增加一道支撑并填写深度", true);
      if (supportDepths.some((value) => value <= 0 || value >= depth)) return this.toast("各道支撑深度必须大于 0 且小于基坑深度", true);
    }
    const activeId = this.input<HTMLSelectElement>("#pitActivePit").value;
    const existing = this.state.pits.find((pit) => pit.id === activeId);
    const pit: FoundationPit = {
      id: existing?.id || crypto.randomUUID(),
      name,
      longitude,
      latitude,
      groundHeight,
      heading,
      length,
      width,
      depth,
      exposure,
      supportDepth,
      displayOffset,
      displayScale,
      visible: this.input<HTMLInputElement>("#pitModelVisible").checked,
      enclosureType: this.input<HTMLSelectElement>("#pitEnclosureType").value as EnclosureType,
      hasWaler,
      walerType: this.input<HTMLSelectElement>("#pitWalerType").value as WalerType,
      walerWidth: this.positiveValue("#pitWalerWidth", 0.4),
      walerHeight: this.positiveValue("#pitWalerHeight", 0.6),
      hasStrut,
      strutType: this.input<HTMLSelectElement>("#pitStrutType").value as StrutType,
      strutLayout: this.input<HTMLSelectElement>("#pitStrutLayout").value as StrutLayout,
      strutWidth: this.positiveValue("#pitStrutWidth", 0.6),
      strutHeight: this.positiveValue("#pitStrutHeight", 0.6),
      supportDepths,
      customSupports: existing?.customSupports || [],
    };
    if (existing) Object.assign(existing, pit);
    else this.state.pits.push(pit);
    this.recalculatePitPoints(pit);
    this.saveState();
    this.render(pit.id);
    this.loadPitIntoForm(pit);
    this.locatePit(pit);
    const lifted = displayOffset > requestedDisplayOffset + 0.001 ? `；为避免与倾斜摄影交叉，已自动抬高到 ${displayOffset.toFixed(2)} m` : "";
    this.toast(`${existing ? `基坑模型“${pit.name}”已更新` : `基坑模型“${pit.name}”已创建`}${lifted}`);
  }

  private deleteActivePit() {
    const pit = this.activePit();
    if (!pit) return this.toast("当前没有可删除的基坑", true);
    const pointCount = this.state.points.filter((point) => point.pitId === pit.id).length;
    if (!window.confirm(`确定删除基坑“${pit.name}”及其 ${pointCount} 个监测点和全部日报吗？`)) return;
    this.state.pits = this.state.pits.filter((candidate) => candidate.id !== pit.id);
    this.state.points = this.state.points.filter((point) => point.pitId !== pit.id);
    this.state.supportMonitors = this.state.supportMonitors.filter((monitor) => monitor.pitId !== pit.id);
    this.saveState();
    this.render();
    const next = this.state.pits[0];
    if (next) this.loadPitIntoForm(next);
    else this.beginNewPit();
    this.toast(`基坑“${pit.name}”已删除`);
  }

  private togglePicking(mode: PickMode) {
    if (this.pickHandler && this.pickMode === mode) this.stopPicking();
    else this.startPicking(mode);
  }

  private startPicking(mode: PickMode) {
    this.stopPicking();
    if (mode === "monitoring" && !this.pointPit()) return this.toast("请先创建并选择所属基坑", true);
    if (mode === "support" && !this.activePit()) return this.toast("请先保存并选择当前基坑", true);
    if (mode === "support" && !this.activePit()?.visible) return this.toast("当前基坑已隐藏，请先显示后再绘制支撑", true);
    this.pickMode = mode;
    const button = this.element<HTMLButtonElement>(mode === "center" ? "#pitPickCenter" : mode === "monitoring" ? "#pitPickMonitoringPoint" : "#pitDrawCustomSupport");
    button.classList.add("active");
    button.textContent = "取消选点";
    const status = this.element(mode === "center" ? "#pitCenterStatus" : mode === "monitoring" ? "#pitPointPickStatus" : "#pitCustomSupportStatus");
    status.textContent = mode === "center" ? "请在倾斜摄影模型表面单击基坑中心。" : mode === "monitoring" ? "请在基坑围护模型或坑边地表上单击监测位置。" : "请点击自绘支撑的第一个端点。";
    this.viewer.canvas.style.cursor = "crosshair";
    this.pickHandler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this.pickHandler.setInputAction((movement: { position: Cartesian2 }) => {
      if (this.interactionSuspensionDepth > 0) return;
      const world = mode === "support" ? this.pickWalerPosition(movement.position) || this.pickSupportPlanePosition(movement.position) || this.pickWorldPosition(movement.position) : this.pickWorldPosition(movement.position);
      if (!world) return this.toast("该位置未拾取到倾斜摄影、模型或地表，请重试", true);
      if (mode === "center") this.acceptCenterPick(world);
      else if (mode === "monitoring") this.acceptMonitoringPick(world);
      else this.acceptCustomSupportPick(world);
    }, ScreenSpaceEventType.LEFT_CLICK);
  }

  private stopPicking(resetMessage = true) {
    if (this.pickHandler && !this.pickHandler.isDestroyed()) this.pickHandler.destroy();
    this.pickHandler = null;
    const previousMode = this.pickMode;
    this.pickMode = null;
    this.viewer.canvas.style.cursor = "";
    const centerButton = document.querySelector<HTMLButtonElement>("#pitPickCenter");
    const pointButton = document.querySelector<HTMLButtonElement>("#pitPickMonitoringPoint");
    const supportButton = document.querySelector<HTMLButtonElement>("#pitDrawCustomSupport");
    if (centerButton) { centerButton.classList.remove("active"); centerButton.textContent = "⌖ 在倾斜摄影模型上选择基坑中心"; }
    if (pointButton) { pointButton.classList.remove("active"); pointButton.textContent = "⌖ 在基坑模型上选取并自动识别边、位置和深度"; }
    if (supportButton) { supportButton.classList.remove("active"); supportButton.textContent = "✎ 在基坑模型上依次点击支撑两端"; }
    this.customSupportStart = null;
    this.dataSource.entities.removeById("foundation-pit-custom-support-draft");
    if (resetMessage && previousMode === "center") this.element("#pitCenterStatus").textContent = "方位角以正北为 0°，顺时针为正。";
    if (resetMessage && previousMode === "monitoring") this.element("#pitPointPickStatus").textContent = "围护点按所在边、沿边距离和深度定位；沉降点按距坑边距离定位。";
    if (resetMessage && previousMode === "support") this.element("#pitCustomSupportStatus").textContent = "先保存基坑，再在坑内自由绘制横撑、纵撑或斜撑。";
  }

  private pickWorldPosition(screenPosition: Cartesian2): Cartesian3 | undefined {
    const scene = this.viewer.scene;
    try {
      const pickedObject = scene.pick(screenPosition);
      if (pickedObject && scene.pickPositionSupported) {
        const position = scene.pickPosition(screenPosition);
        if (position && [position.x, position.y, position.z].every(Number.isFinite)) return position;
      }
    } catch {
      // Tile replacement can make one depth pick stale; globe picking remains safe.
    }
    const ray = this.viewer.camera.getPickRay(screenPosition);
    return ray ? scene.globe.pick(ray, scene) : undefined;
  }

  private pickSupportPlanePosition(screenPosition: Cartesian2): Cartesian3 | undefined {
    const pit = this.activePit();
    const depth = Number(this.input<HTMLInputElement>("#pitCustomSupportDepth").value);
    if (!pit || !Number.isFinite(depth) || depth <= 0 || depth >= pit.depth) return undefined;
    const planePoint = this.localToWorld(pit, { x: 0, y: 0, z: -depth });
    const planeNormal = Cartesian3.normalize(planePoint, new Cartesian3());
    const plane = Plane.fromPointNormal(planePoint, planeNormal);
    const ray = this.viewer.camera.getPickRay(screenPosition);
    return ray ? IntersectionTests.rayPlane(ray, plane) : undefined;
  }

  private pickWalerPosition(screenPosition: Cartesian2): Cartesian3 | undefined {
    const pit = this.activePit();
    if (!pit || !this.viewer.scene.pickPositionSupported) return undefined;
    try {
      const picked = this.viewer.scene.pick(screenPosition) as { id?: unknown } | undefined;
      const candidate = picked?.id;
      const entityId = typeof candidate === "string"
        ? candidate
        : candidate && typeof candidate === "object" && "id" in candidate && typeof (candidate as { id?: unknown }).id === "string"
          ? String((candidate as { id: string }).id)
          : "";
      if (!entityId.startsWith(`foundation-pit-model-${pit.id}-waler-`)) return undefined;
      const position = this.viewer.scene.pickPosition(screenPosition);
      if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return undefined;
      if (!this.customSupportStart) {
        const local = this.worldToPitLocal(pit, position);
        const depth = Math.max(0.01, Math.min(pit.depth - 0.01, -local.z));
        this.input<HTMLInputElement>("#pitCustomSupportDepth").value = depth.toFixed(3);
        this.element("#pitCustomSupportStatus").textContent = `已识别围檩，支撑深度自动设置为 ${depth.toFixed(2)} m。`;
      }
      return position;
    } catch {
      return undefined;
    }
  }

  private acceptCenterPick(world: Cartesian3) {
    const cartographic = Cartographic.fromCartesian(world);
    const longitude = CesiumMath.toDegrees(cartographic.longitude);
    const latitude = CesiumMath.toDegrees(cartographic.latitude);
    const height = cartographic.height;
    if (![longitude, latitude, height].every(Number.isFinite)) return this.toast("拾取坐标无效，请重新选点", true);
    this.input<HTMLInputElement>("#pitCenterLon").value = longitude.toFixed(8);
    this.input<HTMLInputElement>("#pitCenterLat").value = latitude.toFixed(8);
    this.input<HTMLInputElement>("#pitGroundHeight").value = height.toFixed(3);
    this.element("#pitCenterStatus").textContent = `已选基坑中心：${longitude.toFixed(7)}°, ${latitude.toFixed(7)}°，地面高程 ${height.toFixed(2)} m`;
    this.stopPicking(false);
    this.toast("已从三维模型表面获取基坑中心和地面高程");
  }

  private acceptMonitoringPick(world: Cartesian3) {
    const pit = this.pointPit();
    if (!pit) return;
    const local = this.worldToPitLocal(pit, world);
    const placement = this.input<HTMLSelectElement>("#pitPointPlacement").value as PointPlacement;
    const snapped = this.snapToPitEdge(pit, local);
    this.input<HTMLSelectElement>("#pitPointEdge").value = snapped.edge;
    this.input<HTMLInputElement>("#pitPointAlong").value = snapped.along.toFixed(3);
    if (placement === "enclosure") {
      const pickedDepth = Math.min(this.maximumMonitoringDepth(pit), Math.max(0, -local.z));
      this.input<HTMLInputElement>("#pitPointDepth").value = pickedDepth.toFixed(3);
      this.element("#pitPointPickStatus").textContent = `已识别 ${EDGE_LABEL[snapped.edge]}，沿边 ${snapped.along.toFixed(2)} m，深度 ${pickedDepth.toFixed(2)} m`;
    } else {
      this.input<HTMLInputElement>("#pitPointOffset").value = snapped.outwardDistance.toFixed(3);
      this.element("#pitPointPickStatus").textContent = `已识别 ${EDGE_LABEL[snapped.edge]}，沿边 ${snapped.along.toFixed(2)} m，距坑边 ${snapped.outwardDistance.toFixed(2)} m`;
    }
    this.updateEdgeHint();
    this.stopPicking(false);
    this.toast("监测点位置已吸附到基坑参数模型");
  }

  private acceptCustomSupportPick(world: Cartesian3) {
    const pit = this.activePit();
    if (!pit) return;
    const depth = Number(this.input<HTMLInputElement>("#pitCustomSupportDepth").value);
    if (!Number.isFinite(depth) || depth <= 0 || depth >= pit.depth) return this.toast(`自绘支撑深度必须大于 0 且小于 ${pit.depth.toFixed(2)} m`, true);
    const picked = this.worldToPitLocal(pit, world);
    const local: LocalPoint = {
      x: Math.max(-pit.length / 2, Math.min(pit.length / 2, picked.x)),
      y: Math.max(-pit.width / 2, Math.min(pit.width / 2, picked.y)),
      z: -depth,
    };
    if (!this.customSupportStart) {
      this.customSupportStart = local;
      this.dataSource.entities.add({
        id: "foundation-pit-custom-support-draft",
        position: this.localToWorld(pit, local),
        point: { pixelSize: 13, color: Color.fromCssColorString("#ffbf47"), outlineColor: Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
      this.element("#pitCustomSupportStatus").textContent = "第一个端点已确定，请点击第二个端点完成支撑。";
      return;
    }
    const start = this.customSupportStart;
    const length = Math.hypot(local.x - start.x, local.y - start.y);
    if (length < 0.2) return this.toast("两个端点距离过近，请重新点击第二个端点", true);
    const support: CustomSupport = {
      id: crypto.randomUUID(),
      name: this.input<HTMLInputElement>("#pitCustomSupportName").value.trim() || `自绘支撑 ${pit.customSupports.length + 1}`,
      depth,
      type: this.input<HTMLSelectElement>("#pitCustomSupportType").value as StrutType,
      width: this.positiveValue("#pitCustomSupportWidth", 0.6),
      height: this.positiveValue("#pitCustomSupportHeight", 0.6),
      start,
      end: local,
    };
    pit.customSupports.push(support);
    this.saveState();
    this.stopPicking(false);
    this.element("#pitCustomSupportStatus").textContent = `已绘制“${support.name}”，深度 ${depth.toFixed(2)} m。`;
    this.render(pit.id);
    this.loadPitIntoForm(pit);
    this.toast(`自绘支撑“${support.name}”已保存`);
  }

  private snapToPitEdge(pit: FoundationPit, local: LocalPoint) {
    const candidates = [
      { edge: "A" as PitEdge, distance: Math.abs(local.y - pit.width / 2), along: local.x + pit.length / 2, outwardDistance: Math.max(0, local.y - pit.width / 2) },
      { edge: "B" as PitEdge, distance: Math.abs(local.x - pit.length / 2), along: pit.width / 2 - local.y, outwardDistance: Math.max(0, local.x - pit.length / 2) },
      { edge: "C" as PitEdge, distance: Math.abs(local.y + pit.width / 2), along: pit.length / 2 - local.x, outwardDistance: Math.max(0, -pit.width / 2 - local.y) },
      { edge: "D" as PitEdge, distance: Math.abs(local.x + pit.length / 2), along: local.y + pit.width / 2, outwardDistance: Math.max(0, -pit.length / 2 - local.x) },
    ];
    candidates.sort((a, b) => a.distance - b.distance);
    const best = candidates[0];
    const maximum = this.edgeLength(pit, best.edge);
    best.along = Math.min(maximum, Math.max(0, best.along));
    if (best.outwardDistance === 0) best.outwardDistance = best.distance;
    return best;
  }

  private addPoint() {
    const pit = this.pointPit();
    if (!pit) return this.toast("请先创建并选择所属基坑", true);
    const name = this.input<HTMLInputElement>("#pitPointName").value.trim();
    const placement = this.input<HTMLSelectElement>("#pitPointPlacement").value as PointPlacement;
    const edge = this.input<HTMLSelectElement>("#pitPointEdge").value as PitEdge;
    const along = Number(this.input<HTMLInputElement>("#pitPointAlong").value);
    const depth = placement === "enclosure" ? Number(this.input<HTMLInputElement>("#pitPointDepth").value) : 0;
    const offset = placement === "settlement" ? Number(this.input<HTMLInputElement>("#pitPointOffset").value) : 0;
    const speedThreshold = Number(this.input<HTMLInputElement>("#pitSpeedThreshold").value);
    const cumulativeThreshold = Number(this.input<HTMLInputElement>("#pitCumulativeThreshold").value);
    if (!name) return this.toast("请填写监测点名称", true);
    if (this.state.points.some((point) => point.name === name)) return this.toast("监测点名称已存在，请使用唯一名称", true);
    const maximum = this.edgeLength(pit, edge);
    if (!Number.isFinite(along) || along < 0 || along > maximum) return this.toast(`${EDGE_LABEL[edge]}的沿边位置应在 0～${maximum.toFixed(2)} m`, true);
    if (placement === "enclosure" && (!Number.isFinite(depth) || depth < 0 || depth > this.maximumMonitoringDepth(pit))) return this.toast(`监测深度应在 0～${this.maximumMonitoringDepth(pit).toFixed(2)} m`, true);
    if (placement === "settlement" && (!Number.isFinite(offset) || offset < 0)) return this.toast("距基坑边距离必须大于或等于 0", true);
    if (![speedThreshold, cumulativeThreshold].every((value) => Number.isFinite(value) && value > 0)) return this.toast("速度和累计位移预警值必须大于 0", true);
    const point: MonitoringPoint = {
      id: crypto.randomUUID(), name, pitId: pit.id, placement, edge, along, depth, offset,
      longitude: pit.longitude, latitude: pit.latitude, height: pit.groundHeight,
      speedThreshold, cumulativeThreshold, records: [],
    };
    this.updateStoredPointCoordinate(point, pit);
    this.state.points.push(point);
    this.saveState();
    this.input<HTMLInputElement>("#pitPointName").value = "";
    this.render(pit.id, point.id);
    this.locatePoint(point);
    this.toast(`${placement === "settlement" ? "沉降观测点" : "围护监测点"}“${point.name}”已创建`);
  }

  private updateThresholds() {
    const point = this.selectedRecordPoint();
    if (!point) return this.toast("请先选择监测点", true);
    const speed = Number(this.input<HTMLInputElement>("#pitEditSpeedThreshold").value);
    const cumulative = Number(this.input<HTMLInputElement>("#pitEditCumulativeThreshold").value);
    if (![speed, cumulative].every((value) => Number.isFinite(value) && value > 0)) return this.toast("预警值必须大于 0", true);
    point.speedThreshold = speed;
    point.cumulativeThreshold = cumulative;
    this.saveState();
    this.render(undefined, point.id);
    this.toast(`${point.name} 的预警值已更新`);
  }

  private addRecord() {
    const point = this.selectedRecordPoint();
    if (!point) return this.toast("请先选择监测点", true);
    const localTime = this.input<HTMLInputElement>("#pitRecordTime").value;
    const date = new Date(localTime);
    if (!localTime || Number.isNaN(date.getTime())) return this.toast("请选择有效监测日期", true);
    const isSettlement = point.placement === "settlement";
    const x = isSettlement ? 0 : Number(this.input<HTMLInputElement>("#pitRecordX").value);
    const y = isSettlement ? 0 : Number(this.input<HTMLInputElement>("#pitRecordY").value);
    const z = Number(this.input<HTMLInputElement>("#pitRecordZ").value);
    if (![x, y, z].every(Number.isFinite)) return this.toast("X、Y、Z 位移必须是有效数字", true);
    const timestamp = date.toISOString();
    const existing = point.records.find((record) => record.timestamp === timestamp);
    const record: MonitoringRecord = {
      id: existing?.id || crypto.randomUUID(), pointId: point.id, timestamp, x, y, z,
      note: this.input<HTMLInputElement>("#pitRecordNote").value.trim(),
    };
    if (existing) Object.assign(existing, record);
    else point.records.push(record);
    point.records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    this.saveState();
    this.input<HTMLInputElement>("#pitRecordNote").value = "";
    this.input<HTMLInputElement>("#pitRecordTime").value = this.localDateTimeValue(new Date());
    this.render(undefined, point.id);
    const metrics = this.metrics(point);
    const suffix = metrics.reasons.length ? `：${metrics.reasons.join("、")}` : "";
    this.toast(`${point.name} 日报已保存，模型已更新，当前${STATUS_LABEL[metrics.status]}${suffix}`, metrics.status === "alarm");
  }

  private addSupportMonitor() {
    const pitId = this.input<HTMLSelectElement>("#pitSupportMonitorPit").value;
    const pit = this.state.pits.find((candidate) => candidate.id === pitId);
    const targetValue = this.input<HTMLSelectElement>("#pitSupportMonitorTarget").value;
    const name = this.input<HTMLInputElement>("#pitSupportMonitorName").value.trim();
    const axialForceThreshold = Number(this.input<HTMLInputElement>("#pitAxialForceThreshold").value);
    const deformationThreshold = Number(this.input<HTMLInputElement>("#pitSupportDeformationThreshold").value);
    if (!pit || !targetValue) return this.toast("请先选择所属基坑和被监测支撑", true);
    if (!name) return this.toast("请填写支撑监测项名称", true);
    if (this.state.supportMonitors.some((monitor) => monitor.name === name)) return this.toast("支撑监测项名称已存在", true);
    if (![axialForceThreshold, deformationThreshold].every((value) => Number.isFinite(value) && value > 0)) return this.toast("轴力和变形预警值必须大于 0", true);
    const [targetType, targetId] = targetValue.split(":", 2) as ["level" | "custom", string];
    const custom = targetType === "custom" ? pit.customSupports.find((support) => support.id === targetId) : undefined;
    const depth = custom?.depth ?? Number(targetId);
    if (!Number.isFinite(depth)) return this.toast("支撑深度无效，请重新选择", true);
    const monitor: SupportMonitor = {
      id: crypto.randomUUID(), pitId, name, targetType, targetId, depth,
      axialForceThreshold, deformationThreshold, records: [],
    };
    this.state.supportMonitors.push(monitor);
    this.saveState();
    this.input<HTMLInputElement>("#pitSupportMonitorName").value = "";
    this.render(pit.id);
    this.input<HTMLSelectElement>("#pitSupportRecordMonitor").value = monitor.id;
    this.toast(`支撑监测项“${monitor.name}”已创建`);
  }

  private addSupportRecord() {
    const monitor = this.selectedSupportMonitor();
    if (!monitor) return this.toast("请先选择支撑监测项", true);
    const localTime = this.input<HTMLInputElement>("#pitSupportRecordTime").value;
    const date = new Date(localTime);
    const axialForce = Number(this.input<HTMLInputElement>("#pitSupportAxialForce").value);
    const deformation = Number(this.input<HTMLInputElement>("#pitSupportDeformation").value);
    if (!localTime || Number.isNaN(date.getTime())) return this.toast("请选择有效监测日期", true);
    if (![axialForce, deformation].every(Number.isFinite)) return this.toast("支撑轴力和变形必须是有效数字", true);
    const timestamp = date.toISOString();
    const existing = monitor.records.find((record) => record.timestamp === timestamp);
    const record: SupportMonitoringRecord = {
      id: existing?.id || crypto.randomUUID(), timestamp, axialForce, deformation,
      note: this.input<HTMLInputElement>("#pitSupportRecordNote").value.trim(),
    };
    if (existing) Object.assign(existing, record);
    else monitor.records.push(record);
    monitor.records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    this.saveState();
    this.input<HTMLInputElement>("#pitSupportRecordNote").value = "";
    this.input<HTMLInputElement>("#pitSupportRecordTime").value = this.localDateTimeValue(new Date());
    this.render(monitor.pitId);
    this.input<HTMLSelectElement>("#pitSupportRecordMonitor").value = monitor.id;
    const metrics = this.supportMetrics(monitor);
    this.toast(`${monitor.name} 数据已保存，当前${STATUS_LABEL[metrics.status]}${metrics.reasons.length ? `：${metrics.reasons.join("、")}` : ""}`, metrics.status === "alarm");
  }

  private supportMetrics(monitor: SupportMonitor): SupportMetrics {
    const latest = monitor.records[monitor.records.length - 1];
    if (!latest) return { status: "unmeasured", reasons: [] };
    const reasons: string[] = [];
    if (Math.abs(latest.axialForce) >= monitor.axialForceThreshold) reasons.push("支撑轴力超限预警");
    if (Math.abs(latest.deformation) >= monitor.deformationThreshold) reasons.push("支撑变形超限预警");
    const ratio = Math.max(Math.abs(latest.axialForce) / monitor.axialForceThreshold, Math.abs(latest.deformation) / monitor.deformationThreshold);
    return { latest, reasons, status: reasons.length ? "alarm" : ratio >= 0.8 ? "warning" : "normal" };
  }

  private metrics(point: MonitoringPoint, recordIndex = point.records.length - 1): MovementMetrics {
    if (recordIndex < 0 || !point.records.length) return { cumulative: 0, speed: 0, status: "unmeasured", reasons: [] };
    const latest = point.records[recordIndex];
    const cumulative = point.placement === "settlement" ? Math.abs(latest.z) : Math.hypot(latest.x, latest.y, latest.z);
    let speed = 0;
    if (recordIndex > 0) {
      const previous = point.records[recordIndex - 1];
      const days = Math.abs(new Date(latest.timestamp).getTime() - new Date(previous.timestamp).getTime()) / DAY_MS;
      if (days > 0) speed = point.placement === "settlement"
        ? Math.abs(latest.z - previous.z) / days
        : Math.hypot(latest.x - previous.x, latest.y - previous.y, latest.z - previous.z) / days;
    }
    const reasons: string[] = [];
    if (speed >= point.speedThreshold) reasons.push("变形速度超限预警");
    if (cumulative >= point.cumulativeThreshold) reasons.push("累计位移超限预警");
    const ratio = Math.max(speed / point.speedThreshold, cumulative / point.cumulativeThreshold);
    const status: MonitoringStatus = reasons.length ? "alarm" : ratio >= 0.8 ? "warning" : "normal";
    return { latest, cumulative, speed, status, reasons };
  }

  private render(preferredPitId?: string, preferredPointId?: string) {
    this.renderPitSelectors(preferredPitId);
    this.renderPointSelectors(preferredPointId);
    this.renderSupportMonitoringSelectors(preferredPitId);
    this.renderPitManagementList();
    this.renderSummary();
    this.renderScene();
    this.renderPointList();
    this.renderAlerts();
    this.renderCustomSupportList();
    this.renderSupportMonitorList();
    this.syncRecordPointFields();
    this.renderTrend();
    this.updateEdgeHint();
    this.viewer.scene.requestRender();
    this.notifyOverview();
  }

  private renderPitSelectors(preferredPitId?: string) {
    const activeSelect = this.input<HTMLSelectElement>("#pitActivePit");
    const pointPitSelect = this.input<HTMLSelectElement>("#pitPointPit");
    const currentActive = preferredPitId || activeSelect.value;
    const currentPointPit = preferredPitId || pointPitSelect.value || currentActive;
    activeSelect.innerHTML = '<option value="">新建基坑</option>' + this.state.pits.map((pit) => `<option value="${this.escapeHtml(pit.id)}">${this.escapeHtml(pit.name)}</option>`).join("");
    pointPitSelect.innerHTML = this.state.pits.length
      ? this.state.pits.map((pit) => `<option value="${this.escapeHtml(pit.id)}">${this.escapeHtml(pit.name)} · ${ENCLOSURE_LABEL[pit.enclosureType]}</option>`).join("")
      : '<option value="">请先创建基坑</option>';
    if (this.state.pits.some((pit) => pit.id === currentActive)) activeSelect.value = currentActive;
    if (this.state.pits.some((pit) => pit.id === currentPointPit)) pointPitSelect.value = currentPointPit;
  }

  private renderSupportMonitoringSelectors(preferredPitId?: string) {
    const pitSelect = this.input<HTMLSelectElement>("#pitSupportMonitorPit");
    const currentPitId = preferredPitId || pitSelect.value || this.input<HTMLSelectElement>("#pitActivePit").value || this.state.pits[0]?.id || "";
    pitSelect.innerHTML = this.state.pits.length
      ? this.state.pits.map((pit) => `<option value="${this.escapeHtml(pit.id)}">${this.escapeHtml(pit.name)}</option>`).join("")
      : '<option value="">请先创建基坑</option>';
    if (this.state.pits.some((pit) => pit.id === currentPitId)) pitSelect.value = currentPitId;
    this.renderSupportTargetOptions();
    const recordSelect = this.input<HTMLSelectElement>("#pitSupportRecordMonitor");
    const currentMonitor = recordSelect.value;
    recordSelect.innerHTML = this.state.supportMonitors.length
      ? this.state.supportMonitors.map((monitor) => `<option value="${this.escapeHtml(monitor.id)}">${this.escapeHtml(monitor.name)}</option>`).join("")
      : '<option value="">请先新增支撑监测项</option>';
    if (this.state.supportMonitors.some((monitor) => monitor.id === currentMonitor)) recordSelect.value = currentMonitor;
  }

  private renderSupportTargetOptions() {
    const pit = this.state.pits.find((candidate) => candidate.id === this.input<HTMLSelectElement>("#pitSupportMonitorPit").value);
    const target = this.input<HTMLSelectElement>("#pitSupportMonitorTarget");
    if (!pit) { target.innerHTML = '<option value="">请先设置支撑</option>'; return; }
    const options = [
      ...pit.supportDepths.map((depth, index) => `<option value="level:${depth}">第 ${index + 1} 道自动支撑 · 深 ${depth.toFixed(2)} m</option>`),
      ...pit.customSupports.map((support) => `<option value="custom:${this.escapeHtml(support.id)}">${this.escapeHtml(support.name)} · 深 ${support.depth.toFixed(2)} m</option>`),
    ];
    target.innerHTML = options.length ? options.join("") : '<option value="">请先设置支撑</option>';
  }

  private renderPointSelectors(preferredPointId?: string) {
    const recordSelect = this.input<HTMLSelectElement>("#pitRecordPoint");
    const trendSelect = this.input<HTMLSelectElement>("#pitTrendPoint");
    const recordValue = preferredPointId || recordSelect.value;
    const trendValue = preferredPointId || trendSelect.value || recordValue;
    const options = this.state.points.length ? this.state.points.map((point) => {
      const pit = this.state.pits.find((candidate) => candidate.id === point.pitId);
      const type = point.placement === "settlement" ? "地表沉降" : point.placement === "enclosure" ? "围护变形" : "既有点";
      return `<option value="${this.escapeHtml(point.id)}">${this.escapeHtml(point.name)} · ${pit ? this.escapeHtml(pit.name) : "未关联基坑"} · ${type}</option>`;
    }).join("") : '<option value="">暂无监测点</option>';
    recordSelect.innerHTML = options;
    trendSelect.innerHTML = options;
    if (this.state.points.some((point) => point.id === recordValue)) recordSelect.value = recordValue;
    if (this.state.points.some((point) => point.id === trendValue)) trendSelect.value = trendValue;
  }

  private renderPitManagementList() {
    const target = this.element("#pitManagementList");
    const activeId = this.input<HTMLSelectElement>("#pitActivePit").value;
    if (!this.state.pits.length) { target.innerHTML = '<div class="monitoring-empty compact">暂无基坑；创建后可在地图中心标志或此处切换管理</div>'; return; }
    target.innerHTML = this.state.pits.map((pit) => `<div class="pit-management-row ${pit.id === activeId ? "active" : ""}">
      <span class="pit-visibility-dot ${pit.visible ? "visible" : "hidden-model"}"></span>
      <div><strong>${this.escapeHtml(pit.name)}</strong><small>${ENCLOSURE_LABEL[pit.enclosureType]} · ${pit.visible ? "模型显示中" : "仅保留中心标志"}</small></div>
      <button type="button" data-pit-manage-action="select" data-pit-id="${this.escapeHtml(pit.id)}">管理</button>
      <button type="button" data-pit-manage-action="toggle" data-pit-id="${this.escapeHtml(pit.id)}">${pit.visible ? "隐藏" : "显示"}</button>
      <button type="button" data-pit-manage-action="locate" data-pit-id="${this.escapeHtml(pit.id)}" title="定位">⌖</button>
    </div>`).join("");
  }

  private renderSummary() {
    const counts: Record<MonitoringStatus, number> = { unmeasured: 0, normal: 0, warning: 0, alarm: 0 };
    this.state.points.forEach((point) => { counts[this.metrics(point).status] += 1; });
    this.state.supportMonitors.forEach((monitor) => { counts[this.supportMetrics(monitor).status] += 1; });
    this.element("#pitSummaryTotal").textContent = String(this.state.points.length + this.state.supportMonitors.length);
    this.element("#pitSummaryNormal").textContent = String(counts.normal);
    this.element("#pitSummaryWarning").textContent = String(counts.warning);
    this.element("#pitSummaryAlarm").textContent = String(counts.alarm);
  }

  private renderScene() {
    if (String(this.viewer.selectedEntity?.id || "").startsWith("foundation-pit-")) this.viewer.selectedEntity = undefined;
    this.dataSource.entities.removeAll();
    this.sheetPilePrimitives.removeAll();
    for (const pit of this.state.pits) {
      this.renderPitIndicator(pit);
      if (pit.visible) this.renderPitModel(pit);
    }
    for (const point of this.state.points) {
      const pit = this.state.pits.find((candidate) => candidate.id === point.pitId);
      if (!pit || pit.visible) this.renderMonitoringPoint(point);
    }
    for (const monitor of this.state.supportMonitors) {
      const pit = this.state.pits.find((candidate) => candidate.id === monitor.pitId);
      if (pit?.visible) this.renderSupportMonitor(monitor);
    }
    this.viewer.scene.requestRender();
  }

  private renderPitModel(pit: FoundationPit) {
    const topRing = this.pitRing(pit, pit.exposure, true);
    const groundRing = this.pitRing(pit, 0);
    const bottomRing = this.pitRing(pit, -pit.depth);
    const supportBottomRing = this.pitRing(pit, this.supportBottomZ(pit), true);
    const enclosureColor = pit.enclosureType === "sheetPile" ? Color.fromCssColorString("#526875") : pit.enclosureType === "secantPile" ? Color.fromCssColorString("#a49b89") : Color.fromCssColorString("#8b9295");
    this.dataSource.entities.add({
      id: `foundation-pit-model-${pit.id}-excavation`, name: `${pit.name} · 开挖面`,
      wall: {
        positions: groundRing,
        minimumHeights: groundRing.map((position) => Cartographic.fromCartesian(position).height - pit.depth * pit.displayScale),
        maximumHeights: groundRing.map((position) => Cartographic.fromCartesian(position).height),
        material: Color.fromCssColorString("#70513a").withAlpha(0.38),
        outline: true, outlineColor: Color.fromCssColorString("#c78b55").withAlpha(0.9),
      },
      description: this.pitDescription(pit),
    });
    this.dataSource.entities.add({
      id: `foundation-pit-model-${pit.id}-bottom`, name: `${pit.name} · 坑底`,
      polygon: { hierarchy: new PolygonHierarchy(bottomRing.slice(0, 4)), perPositionHeight: true, material: Color.fromCssColorString("#73533b").withAlpha(0.9), outline: true, outlineColor: Color.fromCssColorString("#d39a62") },
      description: this.pitDescription(pit),
    });
    this.addPitPolyline(`foundation-pit-model-${pit.id}-top`, `${pit.name} · 围护顶`, topRing, enclosureColor, 3);
    this.addPitPolyline(`foundation-pit-model-${pit.id}-bottom-line`, `${pit.name} · 坑底轮廓`, bottomRing, Color.fromCssColorString("#e7a35d"), 2);
    this.addPitPolyline(`foundation-pit-model-${pit.id}-support-bottom`, `${pit.name} · 支护结构底`, supportBottomRing, enclosureColor.withAlpha(0.65), 1.5);
    if (pit.enclosureType === "sheetPile") this.renderSheetPileDetails(pit, enclosureColor);
    if (pit.enclosureType === "secantPile") this.renderSecantPileDetails(pit);
    if (pit.enclosureType === "diaphragmWall") this.renderDiaphragmWallDetails(pit, enclosureColor);
    this.renderSupports(pit);
  }

  private renderSheetPileDetails(pit: FoundationPit, color: Color) {
    const edges: Array<{ edge: PitEdge; length: number }> = [
      { edge: "A", length: pit.length }, { edge: "B", length: pit.width },
      { edge: "C", length: pit.length }, { edge: "D", length: pit.width },
    ];
    const depthSegments = Math.max(18, Math.min(52, Math.ceil(pit.supportDepth / 0.35)));
    const geometryInstances: GeometryInstance[] = [];
    for (const { edge, length } of edges) {
      const pileCount = Math.max(1, Math.ceil(length / LARSSEN_IV.effectiveWidth));
      const effectiveWidth = length / pileCount;
      const profile: LocalPoint[] = [];
      for (let pileIndex = 0; pileIndex < pileCount; pileIndex += 1) {
        const centerAlong = (pileIndex + 0.5) * effectiveWidth;
        const trough = (pileIndex % 2 ? -1 : 1) * LARSSEN_IV.sectionHeight;
        const vertices = [
          { along: centerAlong - effectiveWidth / 2, normal: 0 },
          { along: centerAlong - effectiveWidth * 0.22, normal: trough },
          { along: centerAlong + effectiveWidth * 0.22, normal: trough },
          { along: centerAlong + effectiveWidth / 2, normal: 0 },
        ];
        for (const vertex of vertices) profile.push(this.edgeLocalPosition(pit, edge, vertex.along, vertex.normal, 0));
      }
      const positionValues: number[] = [];
      for (let level = 0; level <= depthSegments; level += 1) {
        const z = pit.exposure - pit.supportDepth * level / depthSegments;
        for (const vertex of profile) {
          const world = this.localToWorld(pit, this.deformedLocal(pit, { ...vertex, z }));
          positionValues.push(world.x, world.y, world.z);
        }
      }
      const indices: number[] = [];
      const rowLength = profile.length;
      for (let level = 0; level < depthSegments; level += 1) {
        for (let column = 0; column < rowLength - 1; column += 1) {
          const upperLeft = level * rowLength + column;
          const upperRight = upperLeft + 1;
          const lowerLeft = (level + 1) * rowLength + column;
          const lowerRight = lowerLeft + 1;
          indices.push(upperLeft, lowerLeft, upperRight, upperRight, lowerLeft, lowerRight);
        }
      }
      const typedPositions = new Float64Array(positionValues);
      const attributes = new GeometryAttributes();
      attributes.position = new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: typedPositions });
      const geometry = new Geometry({
        attributes,
        indices: Uint32Array.from(indices),
        primitiveType: PrimitiveType.TRIANGLES,
        boundingSphere: BoundingSphere.fromVertices(positionValues),
      });
      const edgeShade = edge === "B" || edge === "D" ? color.darken(0.08, new Color()) : color;
      geometryInstances.push(new GeometryInstance({
        id: `foundation-pit-model-${pit.id}-spiv-${edge}`,
        geometry,
        attributes: { color: ColorGeometryInstanceAttribute.fromColor(edgeShade.withAlpha(1)) },
      }));
      const topProfile = profile.map((vertex) => this.localToWorld(pit, this.deformedLocal(pit, { ...vertex, z: pit.exposure })));
      this.addPitPolyline(`foundation-pit-model-${pit.id}-spiv-top-${edge}`, `${pit.name} · SP-IV 桩顶 U 型截面`, topProfile, Color.fromCssColorString("#d1d7da"), 2.2);
      for (let lock = 0; lock <= pileCount; lock += 1) {
        const lockPositions: Cartesian3[] = [];
        for (let level = 0; level <= depthSegments; level += 1) {
          const z = pit.exposure - pit.supportDepth * level / depthSegments;
          const local = this.edgeLocalPosition(pit, edge, Math.min(length, lock * effectiveWidth), 0, z);
          lockPositions.push(this.localToWorld(pit, this.deformedLocal(pit, local)));
        }
        this.addPitPolyline(
          `foundation-pit-model-${pit.id}-spiv-lock-${edge}-${lock}`,
          `${pit.name} · SP-IV 连续拉森锁口`, lockPositions,
          lock % 5 === 0 ? Color.fromCssColorString("#9b6848") : Color.fromCssColorString("#75838a"),
          Math.max(1, LARSSEN_IV.thickness * 70),
        );
      }
    }
    if (geometryInstances.length) {
      this.sheetPilePrimitives.add(new Primitive({
        geometryInstances,
        appearance: new PerInstanceColorAppearance({ flat: true, translucent: false, closed: false, renderState: { cull: { enabled: false } } }),
        asynchronous: false,
        allowPicking: true,
      }));
    }
  }

  private edgeLocalPosition(pit: FoundationPit, edge: PitEdge, along: number, normalOffset: number, z: number): LocalPoint {
    if (edge === "A") return { x: -pit.length / 2 + along, y: pit.width / 2 + normalOffset, z };
    if (edge === "B") return { x: pit.length / 2 + normalOffset, y: pit.width / 2 - along, z };
    if (edge === "C") return { x: pit.length / 2 - along, y: -pit.width / 2 - normalOffset, z };
    return { x: -pit.length / 2 - normalOffset, y: -pit.width / 2 + along, z };
  }

  private renderSecantPileDetails(pit: FoundationPit) {
    const perimeter = 2 * (pit.length + pit.width);
    const count = Math.max(12, Math.min(200, Math.ceil(perimeter / 0.72)));
    const spacing = perimeter / count;
    const radius = Math.min(0.65, Math.max(0.36, spacing * 0.57));
    for (let index = 0; index < count; index += 1) {
      const local = this.deformedLocal(pit, { ...this.pointOnPerimeter(pit, index * spacing), z: pit.exposure - pit.supportDepth / 2 });
      this.dataSource.entities.add({
        id: `foundation-pit-model-${pit.id}-pile-${index}`, name: `${pit.name} · 咬合桩 ${index + 1}`,
        position: this.localToWorld(pit, local),
        cylinder: { length: pit.supportDepth * pit.displayScale, topRadius: radius * pit.displayScale, bottomRadius: radius * pit.displayScale, material: (index % 2 ? Color.fromCssColorString("#777d7c") : Color.fromCssColorString("#b7afa0")).withAlpha(0.98), slices: 20, outline: true, outlineColor: Color.fromCssColorString("#d4cabb").withAlpha(0.85) },
        description: this.pitDescription(pit),
      });
    }
  }

  private renderDiaphragmWallDetails(pit: FoundationPit, color: Color) {
    const thickness = Math.min(1.2, Math.max(0.6, Math.min(pit.length, pit.width) / 35));
    const panelTarget = 5;
    const edges: Array<{ edge: PitEdge; length: number; alongX: boolean }> = [
      { edge: "A", length: pit.length, alongX: true }, { edge: "B", length: pit.width, alongX: false },
      { edge: "C", length: pit.length, alongX: true }, { edge: "D", length: pit.width, alongX: false },
    ];
    for (const edge of edges) {
      const count = Math.max(1, Math.ceil(edge.length / panelTarget));
      const panelLength = edge.length / count;
      for (let index = 0; index < count; index += 1) {
        const along = (index + 0.5) * panelLength;
        const local = edge.edge === "A" ? { x: -pit.length / 2 + along, y: pit.width / 2, z: 0 }
          : edge.edge === "B" ? { x: pit.length / 2, y: pit.width / 2 - along, z: 0 }
            : edge.edge === "C" ? { x: pit.length / 2 - along, y: -pit.width / 2, z: 0 }
              : { x: -pit.length / 2, y: -pit.width / 2 + along, z: 0 };
        this.addVerticalPanel(pit, `diaphragm-${edge.edge}-${index}`, `${pit.name} · ${EDGE_LABEL[edge.edge]}地连墙第 ${index + 1} 幅`, local.x, local.y, panelLength * 0.97, thickness, edge.alongX ? Math.PI / 2 : 0, index % 2 ? color.darken(0.08, new Color()) : color);
      }
    }
  }

  private addVerticalPanel(pit: FoundationPit, suffix: string, name: string, x: number, y: number, panelLength: number, thickness: number, headingOffset: number, color: Color) {
    const position = this.localToWorld(pit, this.deformedLocal(pit, { x, y, z: pit.exposure - pit.supportDepth / 2 }));
    this.dataSource.entities.add({
      id: `foundation-pit-model-${pit.id}-${suffix}`, name, position,
      orientation: Transforms.headingPitchRollQuaternion(position, new HeadingPitchRoll(CesiumMath.toRadians(pit.heading) + headingOffset, 0, 0)),
      box: { dimensions: new Cartesian3(panelLength * pit.displayScale, thickness * pit.displayScale, pit.supportDepth * pit.displayScale), material: color.withAlpha(0.98), outline: true, outlineColor: Color.fromCssColorString("#d4d0c8") },
      description: this.pitDescription(pit),
    });
  }

  private renderPitIndicator(pit: FoundationPit) {
    const anchor = this.localToWorld(pit, { x: 0, y: 0, z: 0 }, false);
    const displayedCenter = this.localToWorld(pit, { x: 0, y: 0, z: 0 });
    const labelPosition = this.localToWorld(pit, { x: 0, y: 0, z: pit.exposure + 2 });
    const indicatorColor = Color.fromCssColorString("#ffb020");
    this.dataSource.entities.add({
      id: `foundation-pit-anchor-${pit.id}`, name: `${pit.name} · 实际基坑中心`, position: anchor,
      point: { pixelSize: 14, color: indicatorColor, outlineColor: Color.WHITE, outlineWidth: 3, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text: `${pit.name}\n${pit.visible ? "点击管理" : "模型已隐藏 · 点击管理"}`, font: "bold 12px sans-serif", fillColor: pit.visible ? Color.WHITE : Color.fromCssColorString("#ffd166"), outlineColor: Color.BLACK, outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE, showBackground: true, backgroundColor: Color.fromCssColorString("#122333").withAlpha(0.78), pixelOffset: new Cartesian2(0, 20), disableDepthTestDistance: Number.POSITIVE_INFINITY },
      description: this.pitDescription(pit),
    });
    if (pit.visible && pit.displayOffset > 0.01) {
      this.dataSource.entities.add({
        id: `foundation-pit-indicator-${pit.id}`, name: `${pit.name} · 中心指示`,
        polyline: { positions: [displayedCenter, anchor], width: 6, material: new PolylineArrowMaterialProperty(indicatorColor), depthFailMaterial: indicatorColor.withAlpha(0.78) },
      });
      this.dataSource.entities.add({
        id: `foundation-pit-display-label-${pit.id}`, name: `${pit.name} · 独立展示模型`, position: labelPosition,
        label: { text: `${pit.name}\n独立展示 ↑ ${pit.displayOffset.toFixed(1)} m · 比例 ${pit.displayScale.toFixed(2)}`, font: "bold 13px sans-serif", fillColor: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE, showBackground: true, backgroundColor: Color.fromCssColorString("#26394c").withAlpha(0.85), pixelOffset: new Cartesian2(0, -12), horizontalOrigin: HorizontalOrigin.CENTER, verticalOrigin: VerticalOrigin.BOTTOM, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
    }
  }

  private renderSupports(pit: FoundationPit) {
    const walerColor = pit.walerType === "concrete" ? Color.fromCssColorString("#a8a69f") : Color.fromCssColorString("#4f5960");
    const strutColor = pit.strutType === "concrete" ? Color.fromCssColorString("#b8b5ad") : pit.strutType === "steelPipe" ? Color.fromCssColorString("#59646a") : Color.fromCssColorString("#4a5359");
    pit.supportDepths.forEach((depth, level) => {
      const z = -depth;
      const levelMonitor = this.state.supportMonitors.find((monitor) => monitor.pitId === pit.id && monitor.targetType === "level" && Math.abs(monitor.depth - depth) < 0.001);
      const levelMetrics = levelMonitor ? this.supportMetrics(levelMonitor) : undefined;
      const monitoredColor = levelMetrics && levelMetrics.status !== "unmeasured" && levelMetrics.status !== "normal" ? STATUS_COLOR[levelMetrics.status] : strutColor;
      const lengthAdjustment = levelMetrics?.latest ? levelMetrics.latest.deformation / 1000 * this.deformationScale() / Math.max(0.05, pit.displayScale) : 0;
      if (pit.hasWaler) {
        this.addBeam(pit, `waler-${level}-a`, `${WALER_LABEL[pit.walerType]} · 第 ${level + 1} 道`, 0, pit.width / 2 - pit.walerWidth / 2, z, pit.length, pit.walerWidth, pit.walerHeight, Math.PI / 2, walerColor);
        this.addBeam(pit, `waler-${level}-c`, `${WALER_LABEL[pit.walerType]} · 第 ${level + 1} 道`, 0, -pit.width / 2 + pit.walerWidth / 2, z, pit.length, pit.walerWidth, pit.walerHeight, Math.PI / 2, walerColor);
        this.addBeam(pit, `waler-${level}-b`, `${WALER_LABEL[pit.walerType]} · 第 ${level + 1} 道`, pit.length / 2 - pit.walerWidth / 2, 0, z, pit.width, pit.walerWidth, pit.walerHeight, 0, walerColor);
        this.addBeam(pit, `waler-${level}-d`, `${WALER_LABEL[pit.walerType]} · 第 ${level + 1} 道`, -pit.length / 2 + pit.walerWidth / 2, 0, z, pit.width, pit.walerWidth, pit.walerHeight, 0, walerColor);
      }
      if (pit.hasStrut) {
        if (pit.strutLayout === "transverse" || pit.strutLayout === "cross") this.addBeam(pit, `strut-${level}-transverse`, `${STRUT_LABEL[pit.strutType]} · 第 ${level + 1} 道`, 0, 0, z, Math.max(0.2, pit.width - 2 * pit.walerWidth + lengthAdjustment), pit.strutWidth, pit.strutHeight, 0, monitoredColor);
        if (pit.strutLayout === "longitudinal" || pit.strutLayout === "cross") this.addBeam(pit, `strut-${level}-longitudinal`, `${STRUT_LABEL[pit.strutType]} · 第 ${level + 1} 道`, 0, 0, z, Math.max(0.2, pit.length - 2 * pit.walerWidth + lengthAdjustment), pit.strutWidth, pit.strutHeight, Math.PI / 2, monitoredColor);
      }
    });
    for (const support of pit.customSupports) this.renderCustomSupport(pit, support);
  }

  private renderCustomSupport(pit: FoundationPit, support: CustomSupport) {
    const start = this.deformedLocal(pit, { ...support.start, z: -support.depth });
    const end = this.deformedLocal(pit, { ...support.end, z: -support.depth });
    const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2, z: (start.z + end.z) / 2 };
    const monitor = this.state.supportMonitors.find((candidate) => candidate.pitId === pit.id && candidate.targetType === "custom" && candidate.targetId === support.id);
    const metrics = monitor ? this.supportMetrics(monitor) : undefined;
    const adjustment = metrics?.latest ? metrics.latest.deformation / 1000 * this.deformationScale() / Math.max(0.05, pit.displayScale) : 0;
    const length = Math.max(0.2, Math.hypot(end.x - start.x, end.y - start.y) + adjustment);
    const headingOffset = Math.atan2(end.x - start.x, end.y - start.y);
    const baseColor = support.type === "concrete" ? Color.fromCssColorString("#b8b5ad") : support.type === "steelPipe" ? Color.fromCssColorString("#59646a") : Color.fromCssColorString("#454d52");
    const color = metrics && metrics.status !== "unmeasured" && metrics.status !== "normal" ? STATUS_COLOR[metrics.status] : baseColor;
    this.addBeam(pit, `custom-${support.id}`, `${support.name} · ${STRUT_LABEL[support.type]}`, midpoint.x, midpoint.y, midpoint.z, length, support.width, support.height, headingOffset, color, false);
  }

  private addBeam(pit: FoundationPit, suffix: string, name: string, x: number, y: number, z: number, length: number, width: number, height: number, headingOffset: number, color: Color, applyDeformation = true) {
    const local = applyDeformation ? this.deformedLocal(pit, { x, y, z }) : { x, y, z };
    const position = this.localToWorld(pit, local);
    this.dataSource.entities.add({
      id: `foundation-pit-model-${pit.id}-${suffix}`, name, position,
      orientation: Transforms.headingPitchRollQuaternion(position, new HeadingPitchRoll(CesiumMath.toRadians(pit.heading) + headingOffset, 0, 0)),
      box: { dimensions: new Cartesian3(length * pit.displayScale, width * pit.displayScale, height * pit.displayScale), material: color.withAlpha(0.98), outline: true, outlineColor: Color.fromCssColorString("#d6dadd").withAlpha(0.9) },
      description: this.pitDescription(pit),
    });
  }

  private addPitPolyline(id: string, name: string, positions: Cartesian3[], color: Color, width: number) {
    this.dataSource.entities.add({
      id, name,
      polyline: { positions, width, material: color, depthFailMaterial: color.withAlpha(0.72) },
    });
  }

  private renderMonitoringPoint(point: MonitoringPoint) {
    const metrics = this.metrics(point);
    const pit = this.state.pits.find((candidate) => candidate.id === point.pitId);
    const visualPosition = this.displacedWorldPosition(point, pit, this.deformationScale());
    const color = STATUS_COLOR[metrics.status];
    const alertText = metrics.reasons.length ? `\n⚠ ${metrics.reasons.join("\n⚠ ")}` : "";
    const readingText = metrics.latest ? `累计 ${metrics.cumulative.toFixed(2)} mm · ${metrics.speed.toFixed(2)} mm/d` : "未监测";
    this.dataSource.entities.add({
      id: `foundation-pit-point-${point.id}`, name: point.name, position: visualPosition,
      point: { pixelSize: metrics.status === "alarm" ? 19 : metrics.status === "warning" ? 15 : 12, color, outlineColor: Color.WHITE, outlineWidth: metrics.status === "alarm" ? 3 : 2, disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new DistanceDisplayCondition(0, 100_000) },
      label: {
        text: `${point.name}\n${readingText}${alertText}`, font: metrics.status === "alarm" ? "bold 13px sans-serif" : "12px sans-serif",
        fillColor: metrics.status === "alarm" ? Color.WHITE : Color.fromCssColorString("#e9f8ff"), outlineColor: Color.BLACK.withAlpha(0.9), outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE, showBackground: true,
        backgroundColor: metrics.status === "alarm" ? Color.fromCssColorString("#8d1024").withAlpha(0.92) : Color.fromCssColorString("#07121f").withAlpha(0.8),
        pixelOffset: new Cartesian2(0, -22), horizontalOrigin: HorizontalOrigin.CENTER, verticalOrigin: VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new DistanceDisplayCondition(0, 25_000),
      },
      description: this.pointDescription(point, metrics),
    });
  }

  private renderSupportMonitor(monitor: SupportMonitor) {
    const pit = this.state.pits.find((candidate) => candidate.id === monitor.pitId);
    if (!pit) return;
    const metrics = this.supportMetrics(monitor);
    const local = this.supportMonitorLocalPosition(monitor, pit);
    const position = this.localToWorld(pit, this.deformedLocal(pit, local));
    const color = STATUS_COLOR[metrics.status];
    const reading = metrics.latest ? `轴力 ${metrics.latest.axialForce.toFixed(1)} kN · 变形 ${metrics.latest.deformation.toFixed(2)} mm` : "未监测";
    this.dataSource.entities.add({
      id: `foundation-pit-support-monitor-${monitor.id}`, name: monitor.name, position,
      point: { pixelSize: metrics.status === "alarm" ? 19 : 13, color, outlineColor: Color.WHITE, outlineWidth: 3, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text: `${monitor.name}\n${reading}${metrics.reasons.length ? `\n⚠ ${metrics.reasons.join("\n⚠ ")}` : ""}`, font: metrics.status === "alarm" ? "bold 13px sans-serif" : "12px sans-serif", fillColor: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE, showBackground: true, backgroundColor: metrics.status === "alarm" ? Color.fromCssColorString("#8d1024").withAlpha(0.94) : Color.fromCssColorString("#07121f").withAlpha(0.84), pixelOffset: new Cartesian2(0, -22), verticalOrigin: VerticalOrigin.BOTTOM, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    });
  }

  private pitDescription(pit: FoundationPit) {
    const supportText = pit.supportDepths.length ? `${pit.supportDepths.length} 道：${pit.supportDepths.join("、")} m` : "无";
    return `<table class="cesium-infoBox-defaultTable"><tbody>
      <tr><th>基坑</th><td>${this.escapeHtml(pit.name)}</td></tr><tr><th>围护</th><td>${ENCLOSURE_LABEL[pit.enclosureType]}</td></tr>
      ${pit.enclosureType === "sheetPile" ? `<tr><th>钢板桩截面</th><td>JIS SP-IV · 有效宽 400 mm · 截面高 170 mm · 厚 15.5 mm</td></tr>` : ""}
      <tr><th>长×宽×深</th><td>${pit.length} × ${pit.width} × ${pit.depth} m</td></tr><tr><th>露出地面</th><td>${pit.exposure} m</td></tr>
      <tr><th>支护总长/深度</th><td>${pit.supportDepth} m（坑底以下 ${(pit.supportDepth - pit.exposure - pit.depth).toFixed(2)} m）</td></tr><tr><th>独立展示</th><td>抬高 ${pit.displayOffset} m · 比例 ${pit.displayScale.toFixed(2)}</td></tr>
      <tr><th>围檩</th><td>${pit.hasWaler ? `${WALER_LABEL[pit.walerType]} ${pit.walerWidth}×${pit.walerHeight} m` : "无"}</td></tr>
      <tr><th>对撑</th><td>${pit.hasStrut ? `${STRUT_LABEL[pit.strutType]} · ${STRUT_LAYOUT_LABEL[pit.strutLayout]}` : "无"}</td></tr><tr><th>支撑深度</th><td>${supportText}</td></tr><tr><th>自绘支撑</th><td>${pit.customSupports.length} 根</td></tr>
    </tbody></table>`;
  }

  private pointDescription(point: MonitoringPoint, metrics: MovementMetrics) {
    const pit = this.state.pits.find((candidate) => candidate.id === point.pitId);
    const positionText = point.placement === "free" ? "既有自由点" : `${EDGE_LABEL[point.edge]} · 沿边 ${point.along.toFixed(2)} m · ${point.placement === "settlement" ? `距坑边 ${point.offset.toFixed(2)} m` : `深度 ${point.depth.toFixed(2)} m`}`;
    return `<table class="cesium-infoBox-defaultTable"><tbody>
      <tr><th>监测点</th><td>${this.escapeHtml(point.name)}</td></tr><tr><th>所属基坑</th><td>${pit ? this.escapeHtml(pit.name) : "未关联"}</td></tr>
      <tr><th>位置</th><td>${positionText}</td></tr><tr><th>当前状态</th><td>${STATUS_LABEL[metrics.status]}</td></tr>
      <tr><th>累计位移</th><td>${metrics.cumulative.toFixed(3)} / ${point.cumulativeThreshold} mm</td></tr><tr><th>变形速度</th><td>${metrics.speed.toFixed(3)} / ${point.speedThreshold} mm/d</td></tr>
      <tr><th>预警原因</th><td>${metrics.reasons.length ? metrics.reasons.join("；") : "无"}</td></tr>
    </tbody></table>`;
  }

  private renderPointList() {
    const target = this.element("#pitPointList");
    if (!this.state.points.length) { target.innerHTML = '<div class="monitoring-empty">暂无监测点</div>'; return; }
    target.innerHTML = this.state.points.map((point) => {
      const metrics = this.metrics(point);
      const pit = this.state.pits.find((candidate) => candidate.id === point.pitId);
      const type = point.placement === "settlement" ? "地表沉降" : point.placement === "enclosure" ? `${EDGE_LABEL[point.edge]} · 深 ${point.depth.toFixed(2)}m` : "既有点";
      return `<div class="monitoring-point-row">
        <span class="monitoring-status ${metrics.status}" title="${STATUS_LABEL[metrics.status]}"></span>
        <div><strong>${this.escapeHtml(point.name)}</strong><small>${pit ? this.escapeHtml(pit.name) : "未关联"} · ${type} · ${metrics.latest ? `累计 ${metrics.cumulative.toFixed(2)}mm / ${metrics.speed.toFixed(2)}mm/d` : "未监测"}</small></div>
        <button type="button" data-pit-action="locate" data-point-id="${this.escapeHtml(point.id)}" title="定位">⌖</button><button type="button" data-pit-action="delete" data-point-id="${this.escapeHtml(point.id)}" title="删除">×</button>
      </div>`;
    }).join("");
  }

  private renderCustomSupportList() {
    const target = this.element("#pitCustomSupportList");
    const pit = this.activePit();
    if (!pit?.customSupports.length) { target.innerHTML = '<div class="monitoring-empty compact">暂无自绘支撑</div>'; return; }
    target.innerHTML = pit.customSupports.map((support) => `<div class="pit-custom-support-row">
      <div><strong>${this.escapeHtml(support.name)}</strong><small>${STRUT_LABEL[support.type]} · 深 ${support.depth.toFixed(2)} m · 长 ${Math.hypot(support.end.x - support.start.x, support.end.y - support.start.y).toFixed(2)} m</small></div>
      <button type="button" data-custom-support-action="delete" data-support-id="${this.escapeHtml(support.id)}" title="删除">×</button>
    </div>`).join("");
  }

  private handleCustomSupportAction(event: Event) {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-custom-support-action]");
    const pit = this.activePit();
    const support = pit?.customSupports.find((candidate) => candidate.id === button?.dataset.supportId);
    if (!button || !pit || !support) return;
    if (button.dataset.customSupportAction === "delete" && window.confirm(`确定删除自绘支撑“${support.name}”及其监测记录吗？`)) {
      pit.customSupports = pit.customSupports.filter((candidate) => candidate.id !== support.id);
      this.state.supportMonitors = this.state.supportMonitors.filter((monitor) => !(monitor.pitId === pit.id && monitor.targetType === "custom" && monitor.targetId === support.id));
      this.saveState();
      this.render(pit.id);
      this.loadPitIntoForm(pit);
      this.toast(`自绘支撑“${support.name}”已删除`);
    }
  }

  private renderSupportMonitorList() {
    const target = this.element("#pitSupportMonitorList");
    if (!this.state.supportMonitors.length) { target.innerHTML = '<div class="monitoring-empty compact">暂无支撑轴力或变形监测项</div>'; return; }
    target.innerHTML = this.state.supportMonitors.map((monitor) => {
      const pit = this.state.pits.find((candidate) => candidate.id === monitor.pitId);
      const metrics = this.supportMetrics(monitor);
      const latest = metrics.latest ? `轴力 ${metrics.latest.axialForce.toFixed(1)}kN · 变形 ${metrics.latest.deformation.toFixed(2)}mm` : "未监测";
      return `<div class="monitoring-point-row">
        <span class="monitoring-status ${metrics.status}" title="${STATUS_LABEL[metrics.status]}"></span>
        <div><strong>${this.escapeHtml(monitor.name)}</strong><small>${pit ? this.escapeHtml(pit.name) : "基坑已删除"} · 深 ${monitor.depth.toFixed(2)}m · ${latest}</small></div>
        <button type="button" data-support-monitor-action="locate" data-monitor-id="${this.escapeHtml(monitor.id)}" title="定位">⌖</button><button type="button" data-support-monitor-action="delete" data-monitor-id="${this.escapeHtml(monitor.id)}" title="删除">×</button>
      </div>`;
    }).join("");
  }

  private handleSupportMonitorAction(event: Event) {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-support-monitor-action]");
    const monitor = this.state.supportMonitors.find((candidate) => candidate.id === button?.dataset.monitorId);
    if (!button || !monitor) return;
    if (button.dataset.supportMonitorAction === "locate") { this.locateSupportMonitor(monitor); return; }
    if (button.dataset.supportMonitorAction === "delete" && window.confirm(`确定删除支撑监测项“${monitor.name}”及其全部记录吗？`)) {
      this.state.supportMonitors = this.state.supportMonitors.filter((candidate) => candidate.id !== monitor.id);
      this.saveState();
      this.render(monitor.pitId);
      this.toast(`支撑监测项“${monitor.name}”已删除`);
    }
  }

  private renderAlerts() {
    const target = this.element("#pitAlertList");
    const alerts = this.state.points.map((point) => ({ point, metrics: this.metrics(point) })).filter(({ metrics }) => metrics.status === "warning" || metrics.status === "alarm").sort((a, b) => this.statusRank(b.metrics.status) - this.statusRank(a.metrics.status));
    const supportAlerts = this.state.supportMonitors.map((monitor) => ({ monitor, metrics: this.supportMetrics(monitor) })).filter(({ metrics }) => metrics.status === "warning" || metrics.status === "alarm").sort((a, b) => this.statusRank(b.metrics.status) - this.statusRank(a.metrics.status));
    if (!alerts.length && !supportAlerts.length) {
      target.innerHTML = '<div class="monitoring-no-alert"><span>✓</span><div><strong>当前无超限预警</strong><small>达到预警值的监测点会在模型中红色高亮并在此显示原因</small></div></div>';
      return;
    }
    target.innerHTML = alerts.map(({ point, metrics }) => `<button type="button" class="monitoring-alert ${metrics.status}" data-pit-action="locate" data-point-id="${this.escapeHtml(point.id)}">
      <span>${STATUS_LABEL[metrics.status]}</span><div><strong>${this.escapeHtml(point.name)}</strong><small>${metrics.reasons.length ? metrics.reasons.join("；") : `已达到预警值的 80% · 累计 ${metrics.cumulative.toFixed(2)}mm · 速度 ${metrics.speed.toFixed(2)}mm/d`}</small></div><b>定位</b>
    </button>`).join("") + supportAlerts.map(({ monitor, metrics }) => `<button type="button" class="monitoring-alert ${metrics.status}" data-support-monitor-action="locate" data-monitor-id="${this.escapeHtml(monitor.id)}">
      <span>${STATUS_LABEL[metrics.status]}</span><div><strong>${this.escapeHtml(monitor.name)}</strong><small>${metrics.reasons.length ? metrics.reasons.join("；") : `已达到预警值的 80% · 轴力 ${metrics.latest?.axialForce.toFixed(1)}kN · 变形 ${metrics.latest?.deformation.toFixed(2)}mm`}</small></div><b>定位</b>
    </button>`).join("");
  }

  private renderTrend() {
    const pointId = this.input<HTMLSelectElement>("#pitTrendPoint").value;
    const point = this.state.points.find((candidate) => candidate.id === pointId);
    const target = this.element("#pitTrendChart");
    if (!point || !point.records.length) { target.innerHTML = '<div class="monitoring-empty">录入每日位移后显示累计位移与变形速度趋势</div>'; return; }
    const startIndex = Math.max(0, point.records.length - 30);
    const records = point.records.slice(startIndex);
    const series = records.map((_, index) => this.metrics(point, startIndex + index));
    const values = series.flatMap((item) => [item.cumulative, item.speed]);
    let minimum = 0;
    let maximum = Math.max(...values, point.cumulativeThreshold, point.speedThreshold, 1);
    maximum *= 1.12;
    const left = 38, right = 314, top = 15, bottom = 132;
    const x = (index: number) => records.length === 1 ? (left + right) / 2 : left + index / (records.length - 1) * (right - left);
    const y = (value: number) => bottom - (value - minimum) / (maximum - minimum) * (bottom - top);
    const pointsFor = (selector: (item: MovementMetrics) => number) => series.map((item, index) => `${x(index).toFixed(1)},${y(selector(item)).toFixed(1)}`).join(" ");
    const thresholdLine = (value: number, color: string, label: string) => `<line x1="${left}" y1="${y(value).toFixed(1)}" x2="${right}" y2="${y(value).toFixed(1)}" stroke="${color}" stroke-dasharray="4 3" opacity=".72"/><text x="${right - 2}" y="${(y(value) - 3).toFixed(1)}" text-anchor="end" fill="${color}" font-size="8">${label}</text>`;
    const latest = series[series.length - 1];
    target.innerHTML = `<div class="monitoring-chart-title"><span>${this.escapeHtml(point.name)}</span><strong class="${latest.status}">累计 ${latest.cumulative.toFixed(2)} mm · ${latest.speed.toFixed(2)} mm/d</strong></div>
      <svg viewBox="0 0 330 158" role="img" aria-label="${this.escapeHtml(point.name)}监测趋势">
        <line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="#3a526d"/><line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" stroke="#3a526d"/>
        <text x="${left - 5}" y="${top + 3}" text-anchor="end" fill="#718aa5" font-size="8">${maximum.toFixed(1)}</text><text x="${left - 5}" y="${bottom}" text-anchor="end" fill="#718aa5" font-size="8">0</text>
        ${thresholdLine(point.cumulativeThreshold, "#59d6f1", "累计预警")}${thresholdLine(point.speedThreshold, "#ffaf5f", "速度预警")}
        <polyline points="${pointsFor((item) => item.cumulative)}" fill="none" stroke="#59d6f1" stroke-width="2.3" stroke-linejoin="round"/>
        <polyline points="${pointsFor((item) => item.speed)}" fill="none" stroke="#ffaf5f" stroke-width="2" stroke-linejoin="round"/>
        ${series.map((item, index) => `<circle cx="${x(index).toFixed(1)}" cy="${y(item.cumulative).toFixed(1)}" r="2.5" fill="#dff8ff"><title>${this.formatTime(records[index].timestamp)}：累计 ${item.cumulative.toFixed(3)} mm</title></circle>`).join("")}
        <text x="${left}" y="149" fill="#718aa5" font-size="8">${this.formatShortDate(records[0].timestamp)}</text><text x="${right}" y="149" text-anchor="end" fill="#718aa5" font-size="8">${this.formatShortDate(records[records.length - 1].timestamp)}</text>
      </svg>`;
  }

  private syncPointPlacementFields() {
    const settlement = this.input<HTMLSelectElement>("#pitPointPlacement").value === "settlement";
    this.element("#pitPointDepthField").classList.toggle("hidden", settlement);
    this.element("#pitPointOffsetField").classList.toggle("hidden", !settlement);
    this.updateEdgeHint();
  }

  private syncRecordPointFields() {
    const point = this.selectedRecordPoint();
    const settlement = point?.placement === "settlement";
    this.element("#pitRecordXField").classList.toggle("hidden", settlement);
    this.element("#pitRecordYField").classList.toggle("hidden", settlement);
    this.input<HTMLInputElement>("#pitRecordX").disabled = settlement;
    this.input<HTMLInputElement>("#pitRecordY").disabled = settlement;
    if (settlement) { this.input<HTMLInputElement>("#pitRecordX").value = "0"; this.input<HTMLInputElement>("#pitRecordY").value = "0"; }
    this.element("#pitRecordAxisHint").textContent = settlement
      ? "地表沉降观测点只录入 Z 方向累计位移；系统根据相邻日期差自动计算沉降速度。"
      : "X 为基坑长边方向、Y 为短边方向、Z 为竖向；数据按相对初始值的累计位移录入。";
    this.input<HTMLInputElement>("#pitEditSpeedThreshold").value = point ? String(point.speedThreshold) : "";
    this.input<HTMLInputElement>("#pitEditCumulativeThreshold").value = point ? String(point.cumulativeThreshold) : "";
  }

  private updateEdgeHint() {
    const pit = this.pointPit();
    const edge = this.input<HTMLSelectElement>("#pitPointEdge").value as PitEdge;
    if (!pit) { this.element("#pitEdgeHint").textContent = "请先创建并选择所属基坑。"; return; }
    const length = this.edgeLength(pit, edge);
    this.input<HTMLInputElement>("#pitPointAlong").max = String(length);
    this.input<HTMLInputElement>("#pitPointDepth").max = String(this.maximumMonitoringDepth(pit));
    this.element("#pitEdgeHint").textContent = `${EDGE_LABEL[edge]}长度 ${length.toFixed(2)} m，沿边位置应在 0～${length.toFixed(2)} m；围护监测深度最大 ${this.maximumMonitoringDepth(pit).toFixed(2)} m。`;
  }

  private handleListAction(event: Event) {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-pit-action]");
    if (!button) return;
    const point = this.state.points.find((candidate) => candidate.id === button.dataset.pointId);
    if (!point) return;
    if (button.dataset.pitAction === "locate") { this.locatePoint(point); return; }
    if (button.dataset.pitAction === "delete" && window.confirm(`确定删除监测点“${point.name}”及其全部日报吗？`)) {
      this.state.points = this.state.points.filter((candidate) => candidate.id !== point.id);
      this.saveState();
      this.render();
      this.toast(`监测点“${point.name}”已删除`);
    }
  }

  private locatePit(pit: FoundationPit) {
    const altitude = pit.groundHeight + pit.displayOffset + Math.max(60, Math.hypot(pit.length, pit.width, pit.supportDepth) * pit.displayScale * 1.8);
    this.viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(pit.longitude, pit.latitude, altitude),
      orientation: { heading: CesiumMath.toRadians(pit.heading), pitch: CesiumMath.toRadians(-90), roll: 0 },
      duration: 1.4,
    });
  }

  private locatePoint(point: MonitoringPoint) {
    const pit = this.state.pits.find((candidate) => candidate.id === point.pitId);
    const position = this.displacedWorldPosition(point, pit, this.deformationScale());
    const cartographic = Cartographic.fromCartesian(position);
    this.viewer.camera.flyTo({
      destination: Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, cartographic.height + 60),
      orientation: { heading: CesiumMath.toRadians(pit?.heading || 0), pitch: CesiumMath.toRadians(-90), roll: 0 },
      duration: 1.2,
    });
    const entity = this.dataSource.entities.getById(`foundation-pit-point-${point.id}`);
    if (entity) this.viewer.selectedEntity = entity;
  }

  private locateSupportMonitor(monitor: SupportMonitor) {
    const pit = this.state.pits.find((candidate) => candidate.id === monitor.pitId);
    if (!pit) return;
    const position = this.localToWorld(pit, this.deformedLocal(pit, this.supportMonitorLocalPosition(monitor, pit)));
    const cartographic = Cartographic.fromCartesian(position);
    this.viewer.camera.flyTo({
      destination: Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, cartographic.height + Math.max(35, 60 * pit.displayScale)),
      orientation: { heading: CesiumMath.toRadians(pit.heading), pitch: CesiumMath.toRadians(-90), roll: 0 }, duration: 1.2,
    });
    const entity = this.dataSource.entities.getById(`foundation-pit-support-monitor-${monitor.id}`);
    if (entity) this.viewer.selectedEntity = entity;
  }

  private activePit() {
    const id = this.input<HTMLSelectElement>("#pitActivePit").value;
    return this.state.pits.find((pit) => pit.id === id);
  }

  private pointPit() {
    const id = this.input<HTMLSelectElement>("#pitPointPit").value;
    return this.state.pits.find((pit) => pit.id === id);
  }

  private selectedRecordPoint() {
    const id = this.input<HTMLSelectElement>("#pitRecordPoint").value;
    return this.state.points.find((point) => point.id === id);
  }

  private selectedSupportMonitor() {
    const id = this.input<HTMLSelectElement>("#pitSupportRecordMonitor").value;
    return this.state.supportMonitors.find((monitor) => monitor.id === id);
  }

  private supportMonitorLocalPosition(monitor: SupportMonitor, pit: FoundationPit): LocalPoint {
    if (monitor.targetType === "custom") {
      const support = pit.customSupports.find((candidate) => candidate.id === monitor.targetId);
      if (support) return { x: (support.start.x + support.end.x) / 2, y: (support.start.y + support.end.y) / 2, z: -support.depth };
    }
    return { x: 0, y: 0, z: -monitor.depth };
  }

  private edgeLength(pit: FoundationPit, edge: PitEdge) {
    return edge === "A" || edge === "C" ? pit.length : pit.width;
  }

  private maximumMonitoringDepth(pit: FoundationPit) {
    return Math.max(pit.depth, pit.supportDepth - pit.exposure);
  }

  private supportBottomZ(pit: FoundationPit) {
    return pit.exposure - pit.supportDepth;
  }

  private pointLocalPosition(point: MonitoringPoint, pit: FoundationPit): LocalPoint {
    const along = Math.min(this.edgeLength(pit, point.edge), Math.max(0, point.along));
    const outward = point.placement === "settlement" ? Math.max(0, point.offset) : 0;
    const z = point.placement === "enclosure" ? -Math.min(this.maximumMonitoringDepth(pit), Math.max(0, point.depth)) : 0;
    if (point.edge === "A") return { x: -pit.length / 2 + along, y: pit.width / 2 + outward, z };
    if (point.edge === "B") return { x: pit.length / 2 + outward, y: pit.width / 2 - along, z };
    if (point.edge === "C") return { x: pit.length / 2 - along, y: -pit.width / 2 - outward, z };
    return { x: -pit.length / 2 - outward, y: -pit.width / 2 + along, z };
  }

  private localToWorld(pit: FoundationPit, local: LocalPoint, useDisplayOffset = true, useDisplayScale = useDisplayOffset) {
    const visualScale = useDisplayScale ? pit.displayScale : 1;
    const heading = CesiumMath.toRadians(pit.heading);
    const east = (local.x * Math.sin(heading) + local.y * Math.cos(heading)) * visualScale;
    const north = (local.x * Math.cos(heading) - local.y * Math.sin(heading)) * visualScale;
    const baseHeight = pit.groundHeight + (useDisplayOffset ? pit.displayOffset : 0);
    const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(pit.longitude, pit.latitude, baseHeight));
    return Matrix4.multiplyByPoint(frame, new Cartesian3(east, north, local.z * visualScale), new Cartesian3());
  }

  private worldToPitLocal(pit: FoundationPit, world: Cartesian3): LocalPoint {
    const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(pit.longitude, pit.latitude, pit.groundHeight + pit.displayOffset));
    const inverse = Matrix4.inverseTransformation(frame, new Matrix4());
    const enu = Matrix4.multiplyByPoint(inverse, world, new Cartesian3());
    const heading = CesiumMath.toRadians(pit.heading);
    const scale = Math.max(0.05, pit.displayScale);
    return { x: (enu.x * Math.sin(heading) + enu.y * Math.cos(heading)) / scale, y: (enu.x * Math.cos(heading) - enu.y * Math.sin(heading)) / scale, z: enu.z / scale };
  }

  private deformationAt(pit: FoundationPit, local: LocalPoint) {
    const points = this.state.points.filter((point) => point.pitId === pit.id && point.placement === "enclosure" && point.records.length);
    if (!points.length) return { x: 0, y: 0, z: 0 };
    const target = this.snapToPitEdge(pit, local);
    const alongRadius = Math.max(2, Math.min(6, this.edgeLength(pit, target.edge) * 0.15));
    const depthRadius = Math.max(1.5, Math.min(4, pit.supportDepth * 0.22));
    const wallBand = Math.max(0.8, LARSSEN_IV.sectionHeight * 4);
    if (target.distance > wallBand) return { x: 0, y: 0, z: 0 };
    let x = 0, y = 0, z = 0;
    for (const point of points) {
      if (point.edge !== target.edge) continue;
      const latest = point.records[point.records.length - 1];
      const alongDistance = Math.abs(target.along - point.along);
      const depthDistance = Math.abs(Math.max(0, -local.z) - point.depth);
      if (alongDistance >= alongRadius || depthDistance >= depthRadius) continue;
      const alongWeight = Math.pow(1 - Math.pow(alongDistance / alongRadius, 2), 2);
      const depthWeight = Math.pow(1 - Math.pow(depthDistance / depthRadius, 2), 2);
      const wallWeight = Math.pow(1 - Math.min(1, target.distance / wallBand), 2);
      const influence = alongWeight * depthWeight * wallWeight;
      x += latest.x / 1000 * this.deformationScale() * influence;
      y += latest.y / 1000 * this.deformationScale() * influence;
      z += latest.z / 1000 * this.deformationScale() * influence;
    }
    const limit = Math.max(0.25, Math.min(pit.length, pit.width) * pit.displayScale * 0.2);
    const clamp = (value: number) => Math.max(-limit, Math.min(limit, value));
    return { x: clamp(x), y: clamp(y), z: clamp(z) };
  }

  private deformedLocal(pit: FoundationPit, local: LocalPoint): LocalPoint {
    const deformation = this.deformationAt(pit, local);
    const scale = Math.max(0.05, pit.displayScale);
    return { x: local.x + deformation.x / scale, y: local.y + deformation.y / scale, z: local.z + deformation.z / scale };
  }

  private displacedWorldPosition(point: MonitoringPoint, pit: FoundationPit | undefined, scale: number) {
    const latest = point.records[point.records.length - 1];
    const dx = (latest?.x || 0) / 1000 * scale;
    const dy = (latest?.y || 0) / 1000 * scale;
    const dz = (latest?.z || 0) / 1000 * scale;
    if (pit && point.placement !== "free") {
      const base = this.pointLocalPosition(point, pit);
      if (point.placement === "settlement") return this.localToWorld(pit, { x: base.x + dx, y: base.y + dy, z: base.z + dz }, false, false);
      const displayScale = Math.max(0.05, pit.displayScale);
      return this.localToWorld(pit, { x: base.x + dx / displayScale, y: base.y + dy / displayScale, z: base.z + dz / displayScale });
    }
    const base = Cartesian3.fromDegrees(point.longitude, point.latitude, point.height);
    const frame = Transforms.eastNorthUpToFixedFrame(base);
    return Matrix4.multiplyByPoint(frame, new Cartesian3(dx, dy, dz), new Cartesian3());
  }

  private updateStoredPointCoordinate(point: MonitoringPoint, pit: FoundationPit) {
    // Archive the engineering coordinate at its real elevation. The display
    // offset is a visualization aid and must never alter monitoring records.
    const world = this.localToWorld(pit, this.pointLocalPosition(point, pit), false);
    const cartographic = Cartographic.fromCartesian(world);
    point.longitude = CesiumMath.toDegrees(cartographic.longitude);
    point.latitude = CesiumMath.toDegrees(cartographic.latitude);
    point.height = cartographic.height;
  }

  private recalculatePitPoints(pit: FoundationPit) {
    this.state.points.filter((point) => point.pitId === pit.id && point.placement !== "free").forEach((point) => {
      point.along = Math.min(this.edgeLength(pit, point.edge), Math.max(0, point.along));
      point.depth = Math.min(this.maximumMonitoringDepth(pit), Math.max(0, point.depth));
      this.updateStoredPointCoordinate(point, pit);
    });
  }

  private pitRing(pit: FoundationPit, z: number, deformed = false) {
    const corners = [
      { x: -pit.length / 2, y: pit.width / 2, z }, { x: pit.length / 2, y: pit.width / 2, z },
      { x: pit.length / 2, y: -pit.width / 2, z }, { x: -pit.length / 2, y: -pit.width / 2, z },
      { x: -pit.length / 2, y: pit.width / 2, z },
    ];
    return corners.map((corner) => this.localToWorld(pit, deformed ? this.deformedLocal(pit, corner) : corner));
  }

  private pointOnPerimeter(pit: FoundationPit, distance: number): LocalPoint {
    const perimeter = 2 * (pit.length + pit.width);
    let value = ((distance % perimeter) + perimeter) % perimeter;
    if (value <= pit.length) return { x: -pit.length / 2 + value, y: pit.width / 2, z: 0 };
    value -= pit.length;
    if (value <= pit.width) return { x: pit.length / 2, y: pit.width / 2 - value, z: 0 };
    value -= pit.width;
    if (value <= pit.length) return { x: pit.length / 2 - value, y: -pit.width / 2, z: 0 };
    value -= pit.length;
    return { x: -pit.length / 2, y: -pit.width / 2 + value, z: 0 };
  }

  private deformationScale() {
    const value = Number(this.input<HTMLInputElement>("#pitDeformationScale").value);
    return Number.isFinite(value) ? Math.max(1, Math.min(1000, value)) : 50;
  }

  private statusRank(status: MonitoringStatus) {
    return { unmeasured: 0, normal: 1, warning: 2, alarm: 3 }[status];
  }

  private positiveValue(selector: string, fallback: number) {
    const value = Number(this.input<HTMLInputElement>(selector).value);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private async importCsv(file: File) {
    try {
      const rows = this.parseCsv((await file.text()).replace(/^\uFEFF/, ""));
      if (rows.length < 2) throw new Error("CSV 中没有可导入的日报");
      const headers = rows[0].map((header) => this.normalizeHeader(header));
      const column = (...aliases: string[]) => headers.findIndex((header) => aliases.includes(header));
      const indexes = {
        id: column("监测点编号", "点号", "pointid", "id"), name: column("监测点", "监测点名称", "点名", "point", "pointname", "name"),
        time: column("监测时间", "时间", "日期", "timestamp", "time", "date"),
        x: column("x", "x方向位移", "x累计位移", "displacementx"), y: column("y", "y方向位移", "y累计位移", "displacementy"),
        z: column("z", "z方向位移", "z累计位移", "沉降", "value", "displacementz"), note: column("备注", "note", "remark"),
      };
      if (indexes.name < 0 && indexes.id < 0) throw new Error("CSV 缺少“监测点”或“监测点编号”列");
      if (indexes.time < 0 || (indexes.x < 0 && indexes.y < 0 && indexes.z < 0)) throw new Error("CSV 需要“监测时间”和至少一个 X/Y/Z 位移列");
      let imported = 0, updated = 0, skipped = 0;
      for (const row of rows.slice(1)) {
        if (!row.some((cell) => cell.trim())) continue;
        const cell = (index: number) => index >= 0 ? (row[index] || "").trim() : "";
        const point = this.state.points.find((candidate) => (cell(indexes.id) && candidate.id === cell(indexes.id)) || (cell(indexes.name) && candidate.name === cell(indexes.name)));
        const date = new Date(cell(indexes.time));
        if (!point || Number.isNaN(date.getTime())) { skipped += 1; continue; }
        const settlement = point.placement === "settlement";
        const x = settlement ? 0 : Number(cell(indexes.x) || 0);
        const y = settlement ? 0 : Number(cell(indexes.y) || 0);
        const z = Number(cell(indexes.z) || 0);
        if (![x, y, z].every(Number.isFinite)) { skipped += 1; continue; }
        const timestamp = date.toISOString();
        const existing = point.records.find((record) => record.timestamp === timestamp);
        const record: MonitoringRecord = { id: existing?.id || crypto.randomUUID(), pointId: point.id, timestamp, x, y, z, note: cell(indexes.note) };
        if (existing) { Object.assign(existing, record); updated += 1; }
        else { point.records.push(record); imported += 1; }
      }
      this.state.points.forEach((point) => point.records.sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
      if (!imported && !updated) throw new Error(`没有匹配到有效日报${skipped ? `，已跳过 ${skipped} 行` : ""}`);
      this.saveState();
      this.render();
      this.toast(`CSV 导入完成：新增 ${imported} 条、更新 ${updated} 条${skipped ? `，跳过 ${skipped} 行` : ""}，基坑模型已刷新`);
    } catch (error) {
      this.toast(error instanceof Error ? error.message : "CSV 导入失败", true);
    }
  }

  private exportCsv() {
    if (!this.state.points.length) return this.toast("暂无监测数据可导出", true);
    const rows: string[][] = [["监测项编号", "监测项", "基坑", "类型", "所在边", "沿边位置(m)", "深度/距坑边(m)", "监测时间", "X(mm)", "Y(mm)", "Z(mm)", "支撑轴力(kN)", "支撑变形(mm)", "变形速度(mm/d)", "累计位移(mm)", "速度预警值(mm/d)", "累计预警值(mm)", "轴力预警值(kN)", "支撑变形预警值(mm)", "状态", "预警原因", "备注"]];
    for (const point of this.state.points) {
      const pit = this.state.pits.find((candidate) => candidate.id === point.pitId);
      const records: Array<MonitoringRecord | undefined> = point.records.length ? point.records : [undefined];
      records.forEach((record, index) => {
        const metrics = record ? this.metrics(point, index) : this.metrics(point);
        rows.push([
          point.id, point.name, pit?.name || "", point.placement === "settlement" ? "地表沉降" : point.placement === "enclosure" ? "围护变形" : "既有点",
          point.placement === "free" ? "" : point.edge, String(point.along), String(point.placement === "settlement" ? point.offset : point.depth),
          record?.timestamp || "", record ? String(record.x) : "", record ? String(record.y) : "", record ? String(record.z) : "", "", "",
          record ? metrics.speed.toFixed(6) : "", record ? metrics.cumulative.toFixed(6) : "", String(point.speedThreshold), String(point.cumulativeThreshold), "", "", STATUS_LABEL[metrics.status], metrics.reasons.join("；"), record?.note || "",
        ]);
      });
    }
    for (const monitor of this.state.supportMonitors) {
      const pit = this.state.pits.find((candidate) => candidate.id === monitor.pitId);
      const records: Array<SupportMonitoringRecord | undefined> = monitor.records.length ? monitor.records : [undefined];
      records.forEach((record) => {
        const metrics = this.supportMetrics(monitor);
        rows.push([
          monitor.id, monitor.name, pit?.name || "", "支撑轴力/变形", "", "", String(monitor.depth), record?.timestamp || "", "", "", "",
          record ? String(record.axialForce) : "", record ? String(record.deformation) : "", "", "", "", "", String(monitor.axialForceThreshold), String(monitor.deformationThreshold), STATUS_LABEL[metrics.status], metrics.reasons.join("；"), record?.note || "",
        ]);
      });
    }
    const csv = "\uFEFF" + rows.map((row) => row.map((cell) => this.csvCell(cell)).join(",")).join("\r\n");
    this.download(new Blob([csv], { type: "text/csv;charset=utf-8" }), `基坑监测日报_${this.fileDate()}.csv`);
    this.toast("基坑位移与支撑监测日报 CSV 已导出");
  }

  private exportJson() {
    if (!this.state.pits.length && !this.state.points.length) return this.toast("暂无基坑监测数据可备份", true);
    const json = JSON.stringify({ exportedAt: new Date().toISOString(), ...this.state }, null, 2);
    this.download(new Blob([json], { type: "application/json" }), `基坑监测模型备份_${this.fileDate()}.json`);
    this.toast("基坑模型、监测点、自绘支撑及轴力/变形记录 JSON 备份已导出");
  }

  private download(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = filename; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private parseCsv(text: string) {
    const rows: string[][] = [];
    let row: string[] = [], cell = "", quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (quoted) {
        if (character === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
        else if (character === '"') quoted = false;
        else cell += character;
      } else if (character === '"') quoted = true;
      else if (character === ",") { row.push(cell); cell = ""; }
      else if (character === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
      else cell += character;
    }
    if (cell.length || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
    return rows;
  }

  private normalizeHeader(value: string) { return value.trim().toLowerCase().replace(/[\s_\-()（）/]/g, ""); }
  private csvCell(value: string) { return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value; }
  private localDateTimeValue(date: Date) { return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }
  private formatTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false }); }
  private formatShortDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; }
  private fileDate() { const date = new Date(); return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`; }
  private escapeHtml(value: string) { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
}
