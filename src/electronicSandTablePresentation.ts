import {
  Cartesian2,
  Cartesian3,
  Cartesian4,
  Cartographic,
  ClassificationType,
  Color,
  CustomShader,
  CustomShaderMode,
  CustomShaderTranslucencyMode,
  CustomDataSource,
  Ellipsoid,
  EllipsoidTerrainProvider,
  HeightReference,
  LabelStyle,
  Material,
  Math as CesiumMath,
  Matrix4,
  PolygonHierarchy,
  SceneMode,
  UniformType,
  VerticalOrigin,
  type Cesium3DTileset,
  type Viewer,
} from "cesium";

export type SandTableProjectArea = Readonly<{
  longitude: number;
  latitude: number;
  radiusMeters: number;
}>;

export type SandTablePresentationMetrics = Readonly<{
  projectName: string;
  totalLayers: number;
  visibleLayers: number;
  overallProgress: number;
  activeRisks: number;
  delayedTasks: number;
}>;

export type SandTableContourTileset = Readonly<{
  id: string;
  name: string;
  visible: boolean;
  tileset: Cesium3DTileset;
}>;

export type ElectronicSandTablePresentationOptions = {
  getProjectArea: () => SandTableProjectArea | undefined;
  getMetrics: () => SandTablePresentationMetrics;
  focusProject: () => void | Promise<void>;
  root?: ParentNode;
  canEnterImmersive?: () => boolean;
  getContourTilesets?: () => readonly SandTableContourTileset[];
};

export const electronicSandTablePresentationControlsHtml = `
  <div class="sand-table-section sand-presentation-controls">
    <div class="sand-table-section-heading">
      <strong>地形融合展示</strong><span id="sandPresentationTerrainState">读取当前地形</span>
    </div>
    <div class="sand-presentation-switches">
      <label><input id="sandPresentationFootprint" type="checkbox" checked /> 贴地项目范围</label>
      <label><input id="sandPresentationHud" type="checkbox" checked /> 场景数据看板</label>
      <label><input id="sandPresentationContours" type="checkbox" /> 地形等高线</label>
      <label><input id="sandPresentationModelContours" type="checkbox" /> 倾斜摄影等高线</label>
    </div>
    <label class="sand-presentation-spacing">等高线间距
      <select id="sandPresentationContourSpacing"><option value="2">2 米</option><option value="5">5 米</option><option value="10" selected>10 米</option><option value="20">20 米</option><option value="50">50 米</option><option value="100">100 米</option></select>
    </label>
    <div class="sand-presentation-actions">
      <button id="sandPresentationRefresh" type="button">刷新项目范围</button>
      <button id="sandPresentationFocus" type="button">聚焦项目</button>
      <button id="sandPresentationImmersive" type="button">进入沉浸展示</button>
    </div>
    <p class="sand-presentation-hint" id="sandPresentationStatus">项目范围将贴合当前地形，不改变工程模型坐标。</p>
  </div>
`;

export const electronicSandTableStageHtml = `
  <div id="sandTableStage" class="sand-table-stage" hidden aria-hidden="true">
    <section class="sand-table-stage__title">
      <small>DIGITAL TWIN · TERRAIN SANDBOX</small>
      <strong id="sandStageProjectName">当前工程数字孪生项目</strong>
      <span id="sandStageTerrainBadge">地形检测中</span>
    </section>
    <section class="sand-table-stage__metrics" aria-label="电子沙盘核心指标">
      <article><span>项目进度</span><strong id="sandStageProgress">0%</strong><i><b id="sandStageProgressBar"></b></i></article>
      <article><span>活动风险</span><strong id="sandStageRisks">0</strong><small>风险管控台账</small></article>
      <article><span>延期任务</span><strong id="sandStageDelayed">0</strong><small>自动进度识别</small></article>
      <article><span>场景图层</span><strong id="sandStageLayers">0/0</strong><small>显示 / 总数</small></article>
    </section>
    <section class="sand-table-stage__navigation">
      <div class="sand-table-stage__compass"><i id="sandStageCompassNeedle">N</i><span id="sandStageHeading">000°</span></div>
      <div class="sand-table-stage__camera"><span id="sandStageCameraPosition">经度 -- · 纬度 --</span><strong id="sandStageCameraHeight">镜头高程 --</strong></div>
    </section>
    <section class="sand-table-stage__legend">
      <span><i class="terrain"></i>地形融合范围</span><span><i class="model"></i>工程模型</span><span><i class="risk"></i>风险预警</span>
    </section>
    <button id="sandStageExitImmersive" class="sand-table-stage__exit" type="button" hidden>退出沉浸展示</button>
  </div>
`;

const EARTH_RADIUS_METERS = 6_378_137;
const MIN_RADIUS_METERS = 20;
const MAX_RADIUS_METERS = 250_000;
const FOOTPRINT_SEGMENTS = 48;
const MAX_CONTOUR_TILESETS = 4;
const MAX_CONTOUR_TILESET_RADIUS_METERS = 250_000;
const MODEL_CONTOUR_FRAGMENT_SHADER = `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material)
{
  float spacing = max(u_contourSpacing, 0.25);
  float localHeight = u_contourAnchorHeight
    + dot(fsInput.attributes.positionEC - u_contourAnchorEC, u_contourUpEC);
  float contourLevel = localHeight / spacing;
  float footprint = max(fwidth(contourLevel), 0.00001);
  float distanceToLine = abs(fract(contourLevel - 0.5) - 0.5);
  float halfWidth = max(footprint * max(u_contourPixelWidth, 0.5) * 0.5, 0.001);
  float line = 1.0 - smoothstep(halfWidth, halfWidth + footprint, distanceToLine);
  float densityFade = 1.0 - smoothstep(0.32, 0.72, footprint);
  float blend = line * densityFade * u_contourColor.a;
  material.diffuse = mix(material.diffuse, u_contourColor.rgb, blend);
  material.emissive += u_contourColor.rgb * blend * 0.12;
}
`;

type AppliedTilesetContour = {
  id: string;
  name: string;
  tileset: Cesium3DTileset;
  previousCustomShader: CustomShader | undefined;
  shader: CustomShader;
  anchorWC: Cartesian3;
  upWC: Cartesian3;
  anchorEC: Cartesian3;
  upEC: Cartesian3;
  cartographic: Cartographic;
  radiusMeters: number;
  requestedSpacing: number;
  effectiveSpacing: number;
};

type TilesetContourSummary = {
  applied: number;
  skippedStyle: number;
  skippedShader: number;
  skippedLimit: number;
  skippedInvalid: number;
  minimumSpacing: number;
  maximumSpacing: number;
  message?: string;
  error?: boolean;
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function cleanText(value: unknown, maximum: number, fallback: string) {
  return typeof value === "string" ? value.trim().slice(0, maximum) || fallback : fallback;
}

function safeMetrics(value: SandTablePresentationMetrics): SandTablePresentationMetrics {
  return {
    projectName: cleanText(value?.projectName, 160, "当前工程数字孪生项目"),
    totalLayers: Math.max(0, Math.min(10_000, Math.round(finite(value?.totalLayers) ? value.totalLayers : 0))),
    visibleLayers: Math.max(0, Math.min(10_000, Math.round(finite(value?.visibleLayers) ? value.visibleLayers : 0))),
    overallProgress: Math.max(0, Math.min(100, Math.round(finite(value?.overallProgress) ? value.overallProgress : 0))),
    activeRisks: Math.max(0, Math.min(10_000, Math.round(finite(value?.activeRisks) ? value.activeRisks : 0))),
    delayedTasks: Math.max(0, Math.min(10_000, Math.round(finite(value?.delayedTasks) ? value.delayedTasks : 0))),
  };
}

function destination(longitude: number, latitude: number, bearing: number, distance: number) {
  const angularDistance = distance / EARTH_RADIUS_METERS;
  const latitudeRadians = CesiumMath.toRadians(latitude);
  const longitudeRadians = CesiumMath.toRadians(longitude);
  const nextLatitude = Math.asin(
    Math.sin(latitudeRadians) * Math.cos(angularDistance)
    + Math.cos(latitudeRadians) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const nextLongitude = longitudeRadians + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitudeRadians),
    Math.cos(angularDistance) - Math.sin(latitudeRadians) * Math.sin(nextLatitude),
  );
  return Cartesian3.fromRadians(CesiumMath.negativePiToPi(nextLongitude), nextLatitude, 0);
}

export class ElectronicSandTablePresentation {
  private readonly viewer: Viewer;
  private readonly options: ElectronicSandTablePresentationOptions;
  private readonly root: ParentNode;
  private readonly dataSource = new CustomDataSource("电子沙盘贴地范围");
  private readonly cleanups: Array<() => void> = [];
  private contourMaterial: Material | undefined;
  private previousGlobeMaterial: Material | undefined;
  private materialCaptured = false;
  private readonly tilesetContours = new Map<Cesium3DTileset, AppliedTilesetContour>();
  private removeContourPreRender: (() => void) | undefined;
  private footprintSignature = "";
  private active = false;
  private immersive = false;
  private disposed = false;

  constructor(viewer: Viewer, options: ElectronicSandTablePresentationOptions) {
    this.viewer = viewer;
    this.options = options;
    this.root = options.root ?? document;
    this.dataSource.show = false;
    void viewer.dataSources.add(this.dataSource).then(() => {
      if (this.disposed) {
        this.removeOwnDataSource();
        return;
      }
      this.viewer.scene.requestRender();
    }).catch((error) => this.report("创建贴地范围图层", error));
    this.bindUi();
    this.bindCamera();
    this.updateTerrainState();
  }

  activate() {
    if (this.disposed || this.active) return;
    this.active = true;
    const stage = this.node<HTMLElement>("sandTableStage");
    if (stage) { stage.hidden = !this.checked("sandPresentationHud"); stage.setAttribute("aria-hidden", String(stage.hidden)); }
    this.refresh();
    this.applyContourState();
    this.viewer.scene.requestRender();
  }

  deactivate() {
    if (this.disposed || !this.active) return;
    this.active = false;
    this.setImmersive(false);
    this.dataSource.show = false;
    this.restoreGlobeMaterial();
    this.restoreTilesetContours();
    const stage = this.node<HTMLElement>("sandTableStage");
    if (stage) { stage.hidden = true; stage.setAttribute("aria-hidden", "true"); }
    this.viewer.scene.requestRender();
  }

  refresh() {
    if (this.disposed) return;
    this.refreshMetrics();
    this.updateTerrainState();
    this.updateCameraReadout();
    if (this.active) {
      this.refreshFootprint();
      this.applyContourState();
    }
  }

  dispose() {
    if (this.disposed) return;
    this.deactivate();
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) {
      try { cleanup(); } catch { /* isolated cleanup */ }
    }
    this.restoreGlobeMaterial();
    this.restoreTilesetContours();
    this.dataSource.entities.removeAll();
    this.footprintSignature = "";
    this.removeOwnDataSource();
    this.contourMaterial = undefined;
  }

  private bindUi() {
    this.listenNode("sandPresentationFootprint", "change", () => this.refreshFootprint());
    this.listenNode("sandPresentationHud", "change", () => {
      const stage = this.node<HTMLElement>("sandTableStage");
      if (!stage || !this.active) return;
      stage.hidden = !this.checked("sandPresentationHud");
      stage.setAttribute("aria-hidden", String(stage.hidden));
    });
    this.listenNode("sandPresentationContours", "change", () => this.applyContourState());
    this.listenNode("sandPresentationModelContours", "change", () => this.applyContourState());
    this.listenNode("sandPresentationContourSpacing", "change", () => this.applyContourState());
    this.listenNode("sandPresentationRefresh", "click", () => {
      this.refresh();
      this.setStatus("项目范围和展示指标已刷新");
    });
    this.listenNode("sandPresentationFocus", "click", () => {
      try {
        const result = this.options.focusProject();
        if (result && typeof (result as Promise<void>).catch === "function") (result as Promise<void>).catch((error) => this.handleActionError("聚焦项目", error));
        this.setStatus("正在聚焦项目范围");
      } catch (error) { this.handleActionError("聚焦项目", error); }
    });
    this.listenNode("sandPresentationImmersive", "click", () => this.setImmersive(!this.immersive));
    this.listenNode("sandStageExitImmersive", "click", () => this.setImmersive(false));
    const keyHandler = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key === "Escape" && this.immersive) this.setImmersive(false);
    };
    document.addEventListener("keydown", keyHandler);
    this.cleanups.push(() => document.removeEventListener("keydown", keyHandler));
  }

  private bindCamera() {
    const update = () => { if (this.active && !this.disposed) this.updateCameraReadout(); };
    const removeChanged = this.viewer.camera.changed.addEventListener(update);
    const removeMoveEnd = this.viewer.camera.moveEnd.addEventListener(update);
    this.cleanups.push(removeChanged, removeMoveEnd);
  }

  private refreshMetrics() {
    let metrics: SandTablePresentationMetrics;
    try { metrics = safeMetrics(this.options.getMetrics()); }
    catch (error) {
      this.report("读取展示指标", error);
      metrics = safeMetrics({ projectName: "当前工程数字孪生项目", totalLayers: 0, visibleLayers: 0, overallProgress: 0, activeRisks: 0, delayedTasks: 0 });
    }
    this.setText("sandStageProjectName", metrics.projectName);
    this.setText("sandStageProgress", `${metrics.overallProgress}%`);
    this.setText("sandStageRisks", metrics.activeRisks);
    this.setText("sandStageDelayed", metrics.delayedTasks);
    this.setText("sandStageLayers", `${metrics.visibleLayers}/${metrics.totalLayers}`);
    const progressBar = this.node<HTMLElement>("sandStageProgressBar");
    if (progressBar) progressBar.style.width = `${metrics.overallProgress}%`;
  }

  private refreshFootprint() {
    if (this.disposed) return;
    const enabled = this.active && this.checked("sandPresentationFootprint");
    this.dataSource.show = enabled;
    if (!enabled) { this.viewer.scene.requestRender(); return; }
    let area: SandTableProjectArea | undefined;
    try { area = this.options.getProjectArea(); }
    catch (error) { this.report("计算项目范围", error); }
    if (!area || !finite(area.longitude) || !finite(area.latitude) || !finite(area.radiusMeters)) {
      if (this.footprintSignature) {
        this.dataSource.entities.removeAll();
        this.footprintSignature = "";
      }
      this.setStatus("当前图层尚未形成有效项目范围；加载模型后可自动贴地显示", true);
      this.viewer.scene.requestRender();
      return;
    }
    if (area.radiusMeters > MAX_RADIUS_METERS) {
      if (this.footprintSignature) {
        this.dataSource.entities.removeAll();
        this.footprintSignature = "";
      }
      this.dataSource.show = false;
      this.setStatus("当前可见数据跨度超过 250 km，已停止绘制沙盘范围以保护渲染性能", true);
      this.viewer.scene.requestRender();
      return;
    }
    const longitude = Math.max(-180, Math.min(180, area.longitude));
    const latitude = Math.max(-89.9, Math.min(89.9, area.latitude));
    const radius = Math.max(MIN_RADIUS_METERS, area.radiusMeters);
    const signature = `${longitude.toFixed(7)}:${latitude.toFixed(7)}:${radius.toFixed(2)}`;
    if (signature === this.footprintSignature && this.dataSource.entities.values.length > 0) {
      this.setStatus(`项目范围已贴合地形 · 半径约 ${this.formatDistance(radius)}`);
      this.viewer.scene.requestRender();
      return;
    }
    this.dataSource.entities.removeAll();
    this.footprintSignature = signature;
    const positions: Cartesian3[] = [];
    for (let index = 0; index <= FOOTPRINT_SEGMENTS; index += 1) {
      positions.push(destination(longitude, latitude, index / FOOTPRINT_SEGMENTS * CesiumMath.TWO_PI, radius));
    }
    const fillPositions = positions.slice(0, -1);
    this.dataSource.entities.add({
      id: "sand-table-terrain-footprint",
      polygon: {
        hierarchy: new PolygonHierarchy(fillPositions),
        material: Color.fromCssColorString("#31d8e8").withAlpha(0.075),
        classificationType: ClassificationType.TERRAIN,
      },
      polyline: {
        positions,
        width: 2.5,
        material: Color.fromCssColorString("#5ce7f2").withAlpha(0.92),
        clampToGround: true,
        classificationType: ClassificationType.TERRAIN,
      },
    });
    this.dataSource.entities.add({
      id: "sand-table-terrain-anchor",
      position: Cartesian3.fromDegrees(longitude, latitude, 0),
      point: {
        pixelSize: 10,
        color: Color.fromCssColorString("#6ff5dc"),
        outlineColor: Color.fromCssColorString("#071521"),
        outlineWidth: 3,
        heightReference: HeightReference.CLAMP_TO_GROUND,
      },
      label: {
        text: "项目中心",
        font: '600 13px "Microsoft YaHei", sans-serif',
        fillColor: Color.fromCssColorString("#eaffff"),
        outlineColor: Color.fromCssColorString("#071521"),
        outlineWidth: 4,
        style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(0, -18),
        verticalOrigin: VerticalOrigin.BOTTOM,
        heightReference: HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Math.max(5_000, radius * 8),
      },
    });
    this.setStatus(`项目范围已贴合地形 · 半径约 ${this.formatDistance(radius)}`);
    this.viewer.scene.requestRender();
  }

  private applyContourState() {
    if (this.disposed) return;
    if (!this.active) {
      this.restoreGlobeMaterial();
      this.restoreTilesetContours();
      this.viewer.scene.requestRender();
      return;
    }

    const terrainRequested = this.checked("sandPresentationContours");
    const modelRequested = this.checked("sandPresentationModelContours");
    if (!terrainRequested && !modelRequested) {
      this.restoreGlobeMaterial();
      this.restoreTilesetContours();
      this.viewer.scene.requestRender();
      return;
    }

    if (this.viewer.scene.mode !== SceneMode.SCENE3D || this.viewer.scene.morphTime !== 1) {
      this.uncheck("sandPresentationContours");
      this.uncheck("sandPresentationModelContours");
      this.restoreGlobeMaterial();
      this.restoreTilesetContours();
      this.setStatus("等高线仅支持完整三维场景，请切换到三维模式后再开启", true);
      this.viewer.scene.requestRender();
      return;
    }

    const spacing = this.contourSpacing();
    const messages: string[] = [];
    let warning = false;

    if (terrainRequested) {
      try {
        const globe = this.viewer.scene.globe;
        if (this.viewer.terrainProvider instanceof EllipsoidTerrainProvider) {
          this.uncheck("sandPresentationContours");
          this.restoreGlobeMaterial();
          messages.push("当前为椭球基面，地形等高线已停用");
          warning = true;
        } else if (globe.translucency.enabled) {
          this.uncheck("sandPresentationContours");
          this.restoreGlobeMaterial();
          messages.push("地面透明或地下模式下不叠加地形等高线");
          warning = true;
        } else {
          if (!this.contourMaterial || this.contourMaterial.isDestroyed()) this.contourMaterial = Material.fromType("ElevationContour");
          if (!this.materialCaptured) {
            this.previousGlobeMaterial = globe.material;
            this.materialCaptured = true;
          }
          this.contourMaterial.uniforms.color = Color.fromCssColorString("#7ce9ef").withAlpha(0.72);
          this.contourMaterial.uniforms.spacing = spacing;
          this.contourMaterial.uniforms.width = 1.25;
          globe.material = this.contourMaterial;
          messages.push(`${spacing} 米地形等高线`);
        }
      } catch (error) {
        this.uncheck("sandPresentationContours");
        this.restoreGlobeMaterial();
        this.report("应用地形等高线", error);
        messages.push("地形等高线应用失败");
        warning = true;
      }
    } else {
      this.restoreGlobeMaterial();
    }

    if (modelRequested) {
      const summary = this.reconcileTilesetContours(spacing);
      messages.push(this.describeTilesetContourSummary(summary));
      warning ||= summary.error === true || (summary.applied === 0 && (
        summary.skippedStyle > 0
        || summary.skippedShader > 0
        || summary.skippedInvalid > 0
      ));
    } else {
      this.restoreTilesetContours();
    }

    if (messages.length > 0) this.setStatus(messages.join("；"), warning);
    this.viewer.scene.requestRender();
  }

  private contourSpacing() {
    return Math.max(2, Math.min(100, Number(this.value("sandPresentationContourSpacing")) || 10));
  }

  private reconcileTilesetContours(requestedSpacing: number): TilesetContourSummary {
    const summary: TilesetContourSummary = {
      applied: 0,
      skippedStyle: 0,
      skippedShader: 0,
      skippedLimit: 0,
      skippedInvalid: 0,
      minimumSpacing: Number.POSITIVE_INFINITY,
      maximumSpacing: 0,
    };
    const getTargets = this.options.getContourTilesets;
    if (!getTargets) {
      this.uncheck("sandPresentationModelContours");
      this.restoreTilesetContours();
      summary.message = "倾斜摄影等高线尚未接入模型列表";
      summary.error = true;
      return summary;
    }

    let targets: readonly SandTableContourTileset[];
    try {
      const result = getTargets();
      targets = Array.isArray(result) ? result : [];
    } catch (error) {
      this.uncheck("sandPresentationModelContours");
      this.restoreTilesetContours();
      this.report("读取倾斜摄影等高线目标", error);
      summary.message = "读取倾斜摄影模型失败";
      summary.error = true;
      return summary;
    }

    const selected = new Map<Cesium3DTileset, SandTableContourTileset>();
    const seen = new Set<Cesium3DTileset>();
    let visibleTargets = 0;
    for (const target of targets) {
      if (!target || target.visible !== true || !target.tileset) continue;
      const tileset = target.tileset;
      if (seen.has(tileset)) continue;
      seen.add(tileset);
      visibleTargets += 1;
      if (!this.tilesetIsAlive(tileset) || tileset.show === false || !this.tilesetSphereIsUsable(tileset)) {
        summary.skippedInvalid += 1;
        continue;
      }
      const current = this.tilesetContours.get(tileset);
      if (tileset.style !== undefined) {
        summary.skippedStyle += 1;
        continue;
      }
      if (current) {
        if (current.shader.isDestroyed() || tileset.customShader !== current.shader) {
          summary.skippedShader += 1;
          continue;
        }
      } else if (tileset.customShader !== undefined) {
        summary.skippedShader += 1;
        continue;
      }
      if (selected.size >= MAX_CONTOUR_TILESETS) {
        summary.skippedLimit += 1;
        continue;
      }
      selected.set(tileset, target);
    }

    for (const state of [...this.tilesetContours.values()]) {
      if (!selected.has(state.tileset)) this.releaseTilesetContour(state);
    }

    for (const [tileset, target] of selected) {
      const existing = this.tilesetContours.get(tileset);
      if (existing) {
        existing.id = cleanText(target.id, 120, existing.id);
        existing.name = cleanText(target.name, 160, existing.name);
        if (!this.updateTilesetContourAnchor(existing, requestedSpacing)) {
          summary.skippedInvalid += 1;
          this.releaseTilesetContour(existing);
        }
        continue;
      }
      try {
        const state = this.createTilesetContour(target, requestedSpacing);
        if (state) this.tilesetContours.set(tileset, state);
        else summary.skippedInvalid += 1;
      } catch (error) {
        summary.skippedInvalid += 1;
        this.report(`应用倾斜摄影等高线：${cleanText(target.name, 80, "未命名模型")}`, error);
      }
    }

    this.updateContourPreRenderState();
    summary.applied = this.tilesetContours.size;
    for (const state of this.tilesetContours.values()) {
      summary.minimumSpacing = Math.min(summary.minimumSpacing, state.effectiveSpacing);
      summary.maximumSpacing = Math.max(summary.maximumSpacing, state.effectiveSpacing);
    }
    if (visibleTargets === 0) summary.message = "尚无可见倾斜摄影模型，模型加载后将自动应用";
    return summary;
  }

  private createTilesetContour(target: SandTableContourTileset, requestedSpacing: number) {
    const tileset = target.tileset;
    const anchorWC = new Cartesian3();
    const upWC = new Cartesian3();
    const anchorEC = new Cartesian3();
    const upEC = new Cartesian3();
    const cartographic = new Cartographic();
    const geometry = this.readTilesetAnchor(tileset, anchorWC, upWC, cartographic);
    if (!geometry) return undefined;
    Matrix4.multiplyByPoint(this.viewer.camera.viewMatrix, anchorWC, anchorEC);
    Matrix4.multiplyByPointAsVector(this.viewer.camera.viewMatrix, upWC, upEC);
    Cartesian3.normalize(upEC, upEC);
    const effectiveSpacing = this.adaptiveContourSpacing(requestedSpacing, geometry.radiusMeters);
    const shader = new CustomShader({
      mode: CustomShaderMode.MODIFY_MATERIAL,
      translucencyMode: CustomShaderTranslucencyMode.INHERIT,
      uniforms: {
        u_contourAnchorEC: { type: UniformType.VEC3, value: anchorEC },
        u_contourUpEC: { type: UniformType.VEC3, value: upEC },
        u_contourAnchorHeight: { type: UniformType.FLOAT, value: cartographic.height },
        u_contourSpacing: { type: UniformType.FLOAT, value: effectiveSpacing },
        u_contourPixelWidth: { type: UniformType.FLOAT, value: 1.25 },
        u_contourColor: { type: UniformType.VEC4, value: new Cartesian4(0.486, 0.914, 0.937, 0.78) },
      },
      fragmentShaderText: MODEL_CONTOUR_FRAGMENT_SHADER,
    });
    const previousCustomShader = tileset.customShader;
    try {
      tileset.customShader = shader;
    } catch (error) {
      if (!shader.isDestroyed()) shader.destroy();
      throw error;
    }
    return {
      id: cleanText(target.id, 120, "tileset"),
      name: cleanText(target.name, 160, "倾斜摄影模型"),
      tileset,
      previousCustomShader,
      shader,
      anchorWC,
      upWC,
      anchorEC,
      upEC,
      cartographic,
      radiusMeters: geometry.radiusMeters,
      requestedSpacing,
      effectiveSpacing,
    } satisfies AppliedTilesetContour;
  }

  private updateTilesetContourAnchor(state: AppliedTilesetContour, requestedSpacing: number) {
    if (!this.tilesetIsAlive(state.tileset) || state.shader.isDestroyed() || state.tileset.customShader !== state.shader) return false;
    const sphere = state.tileset.boundingSphere;
    const moved = Cartesian3.distanceSquared(state.anchorWC, sphere.center) > 0.0001;
    const radiusChanged = Math.abs(state.radiusMeters - sphere.radius) > 0.01;
    if (moved || radiusChanged) {
      const geometry = this.readTilesetAnchor(state.tileset, state.anchorWC, state.upWC, state.cartographic);
      if (!geometry) return false;
      state.radiusMeters = geometry.radiusMeters;
      state.shader.setUniform("u_contourAnchorHeight", state.cartographic.height);
    }
    const effectiveSpacing = this.adaptiveContourSpacing(requestedSpacing, state.radiusMeters);
    if (state.effectiveSpacing !== effectiveSpacing) {
      state.effectiveSpacing = effectiveSpacing;
      state.shader.setUniform("u_contourSpacing", effectiveSpacing);
    }
    state.requestedSpacing = requestedSpacing;
    return true;
  }

  private readTilesetAnchor(
    tileset: Cesium3DTileset,
    anchorWC: Cartesian3,
    upWC: Cartesian3,
    cartographic: Cartographic,
  ) {
    if (!this.tilesetSphereIsUsable(tileset)) return undefined;
    const sphere = tileset.boundingSphere;
    Cartesian3.clone(sphere.center, anchorWC);
    const converted = Cartographic.fromCartesian(anchorWC, Ellipsoid.WGS84, cartographic);
    if (!converted || !finite(converted.height)) return undefined;
    Ellipsoid.WGS84.geodeticSurfaceNormal(anchorWC, upWC);
    if (Cartesian3.magnitudeSquared(upWC) < 0.5) return undefined;
    return { radiusMeters: sphere.radius };
  }

  private tilesetSphereIsUsable(tileset: Cesium3DTileset) {
    try {
      const sphere = tileset.boundingSphere;
      return !!sphere
        && finite(sphere.radius)
        && sphere.radius > 0
        && sphere.radius <= MAX_CONTOUR_TILESET_RADIUS_METERS
        && finite(sphere.center.x)
        && finite(sphere.center.y)
        && finite(sphere.center.z);
    } catch {
      return false;
    }
  }

  private tilesetIsAlive(tileset: Cesium3DTileset) {
    try { return !tileset.isDestroyed(); }
    catch { return false; }
  }

  private adaptiveContourSpacing(requestedSpacing: number, radiusMeters: number) {
    const minimum = radiusMeters <= 750 ? 2
      : radiusMeters <= 2_000 ? 5
        : radiusMeters <= 6_000 ? 10
          : radiusMeters <= 15_000 ? 20
            : radiusMeters <= 40_000 ? 50
              : 100;
    return Math.max(requestedSpacing, minimum);
  }

  private describeTilesetContourSummary(summary: TilesetContourSummary) {
    if (summary.message) return summary.message;
    const skipped = summary.skippedStyle + summary.skippedShader + summary.skippedLimit + summary.skippedInvalid;
    if (summary.applied === 0) {
      if (summary.skippedStyle > 0 || summary.skippedShader > 0) return "可见模型已有样式或自定义着色器，已安全跳过";
      if (summary.skippedInvalid > 0) return "可见模型范围无效或过大，未应用等高线";
      return "尚无可用的倾斜摄影模型";
    }
    const spacing = summary.minimumSpacing === summary.maximumSpacing
      ? `${summary.minimumSpacing} 米`
      : `${summary.minimumSpacing}–${summary.maximumSpacing} 米`;
    return `倾斜摄影等高线 ${summary.applied} 个 · 自适应 ${spacing}${skipped > 0 ? ` · 安全跳过 ${skipped} 个` : ""}`;
  }

  private updateContourPreRenderState() {
    const shouldUpdate = this.active
      && !this.disposed
      && this.checked("sandPresentationModelContours")
      && this.tilesetContours.size > 0;
    if (!shouldUpdate) {
      this.stopContourPreRender();
      return;
    }
    if (this.removeContourPreRender) return;
    const update = () => {
      if (!this.active || this.disposed || !this.checked("sandPresentationModelContours")) return;
      const viewMatrix = this.viewer.camera.viewMatrix;
      for (const state of this.tilesetContours.values()) {
        try {
          if (!this.updateTilesetContourAnchor(state, state.requestedSpacing)) continue;
          Matrix4.multiplyByPoint(viewMatrix, state.anchorWC, state.anchorEC);
          Matrix4.multiplyByPointAsVector(viewMatrix, state.upWC, state.upEC);
          if (Cartesian3.magnitudeSquared(state.upEC) < 0.5) continue;
          Cartesian3.normalize(state.upEC, state.upEC);
          state.shader.setUniform("u_contourAnchorEC", state.anchorEC);
          state.shader.setUniform("u_contourUpEC", state.upEC);
        } catch {
          // A target may be removed during the frame. Reconciliation releases it on refresh.
        }
      }
    };
    this.removeContourPreRender = this.viewer.scene.preRender.addEventListener(update);
  }

  private stopContourPreRender() {
    const remove = this.removeContourPreRender;
    this.removeContourPreRender = undefined;
    if (!remove) return;
    try { remove(); }
    catch (error) { this.report("移除倾斜摄影等高线帧更新", error); }
  }

  private releaseTilesetContour(state: AppliedTilesetContour) {
    this.tilesetContours.delete(state.tileset);
    try {
      if (this.tilesetIsAlive(state.tileset) && state.tileset.customShader === state.shader) {
        state.tileset.customShader = state.previousCustomShader;
      }
    } catch (error) {
      this.report(`恢复模型着色器：${state.name}`, error);
    }
    try {
      if (!state.shader.isDestroyed()) state.shader.destroy();
    } catch (error) {
      this.report(`销毁等高线着色器：${state.name}`, error);
    }
  }

  private restoreTilesetContours() {
    this.stopContourPreRender();
    for (const state of [...this.tilesetContours.values()]) this.releaseTilesetContour(state);
  }

  private restoreGlobeMaterial() {
    if (!this.materialCaptured) return;
    try {
      const globe = this.viewer.scene.globe;
      if (globe.material === this.contourMaterial) globe.material = this.previousGlobeMaterial;
    } catch (error) { this.report("恢复原地形材质", error); }
    this.previousGlobeMaterial = undefined;
    this.materialCaptured = false;
  }

  private uncheck(id: string) {
    const checkbox = this.node<HTMLInputElement>(id);
    if (checkbox) checkbox.checked = false;
  }

  private updateTerrainState() {
    try {
      const provider = this.viewer.terrainProvider;
      const terrainType = provider instanceof EllipsoidTerrainProvider ? "椭球基面" : "高程地形";
      const state = this.viewer.scene.globe.tilesLoaded ? `${terrainType}已就绪` : `${terrainType}加载中`;
      this.setText("sandPresentationTerrainState", state);
      this.setText("sandStageTerrainBadge", state);
    } catch (error) {
      this.setText("sandPresentationTerrainState", "地形状态未知");
      this.setText("sandStageTerrainBadge", "地形状态未知");
      this.report("读取地形状态", error);
    }
  }

  private updateCameraReadout() {
    try {
      const position = Cartographic.fromCartesian(this.viewer.camera.positionWC);
      if (!position) return;
      const longitude = CesiumMath.toDegrees(position.longitude);
      const latitude = CesiumMath.toDegrees(position.latitude);
      const height = Math.max(0, position.height);
      const heading = CesiumMath.zeroToTwoPi(this.viewer.camera.heading);
      const headingDegrees = CesiumMath.toDegrees(heading);
      this.setText("sandStageCameraPosition", `经度 ${longitude.toFixed(5)}° · 纬度 ${latitude.toFixed(5)}°`);
      this.setText("sandStageCameraHeight", `镜头高程 ${this.formatDistance(height)}`);
      this.setText("sandStageHeading", `${String(Math.round(headingDegrees) % 360).padStart(3, "0")}°`);
      const needle = this.node<HTMLElement>("sandStageCompassNeedle");
      if (needle) needle.style.transform = `rotate(${-headingDegrees}deg)`;
    } catch (error) { this.report("更新镜头看板", error); }
  }

  private setImmersive(enabled: boolean) {
    if (this.disposed && enabled) return;
    if (enabled && (!this.active || this.options.canEnterImmersive?.() === false)) {
      this.setStatus("当前场景正在使用其他演示模式，请退出后再进入沉浸展示", true);
      return;
    }
    if (this.immersive === enabled && document.body.classList.contains("sand-table-immersive") === enabled) return;
    this.immersive = enabled;
    document.body.classList.toggle("sand-table-immersive", enabled);
    const exit = this.node<HTMLButtonElement>("sandStageExitImmersive"); if (exit) exit.hidden = !enabled;
    const trigger = this.node<HTMLButtonElement>("sandPresentationImmersive"); if (trigger) trigger.textContent = enabled ? "退出沉浸展示" : "进入沉浸展示";
    const stage = this.node<HTMLElement>("sandTableStage");
    if (enabled) {
      if (stage) { stage.hidden = false; stage.setAttribute("aria-hidden", "false"); }
    } else if (stage) {
      stage.hidden = !this.active || !this.checked("sandPresentationHud");
      stage.setAttribute("aria-hidden", String(stage.hidden));
    }
    this.viewer.resize();
    this.viewer.scene.requestRender();
  }

  private removeOwnDataSource() {
    try {
      if (this.viewer.isDestroyed()) return;
      if (this.viewer.dataSources.contains(this.dataSource)) this.viewer.dataSources.remove(this.dataSource, false);
    } catch (error) { this.report("移除贴地范围图层", error); }
  }

  private formatDistance(value: number) {
    return value >= 1000 ? `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)} km` : `${Math.round(value)} m`;
  }

  private handleActionError(context: string, error: unknown) {
    this.setStatus(error instanceof Error ? error.message : `${context}失败`, true);
    this.report(context, error);
  }

  private setStatus(message: string, error = false) {
    const node = this.node<HTMLElement>("sandPresentationStatus"); if (!node) return;
    node.textContent = cleanText(message, 180, error ? "操作失败" : "电子沙盘已更新");
    node.classList.toggle("error", error);
  }

  private checked(id: string) { return this.node<HTMLInputElement>(id)?.checked === true; }
  private value(id: string) { return this.node<HTMLInputElement | HTMLSelectElement>(id)?.value ?? ""; }
  private setText(id: string, value: string | number) { const node = this.node<HTMLElement>(id); if (node) node.textContent = String(value); }
  private node<T extends Element>(id: string) { return this.root.querySelector<T>(`#${id}`); }
  private listenNode(id: string, type: string, listener: EventListener) { const node = this.node<HTMLElement>(id); if (node) { node.addEventListener(type, listener); this.cleanups.push(() => node.removeEventListener(type, listener)); } }
  private report(context: string, error: unknown) { console.warn(`[Electronic sand table presentation] ${context}`, error); }
}
