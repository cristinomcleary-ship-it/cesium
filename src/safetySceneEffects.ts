import {
  ArcType, BoundingSphere, CallbackPositionProperty, Cartesian2,
  Cartesian3, Cartographic, Cesium3DTileFeature, Color, ColorMaterialProperty, ConstantProperty, ConstantPositionProperty,
  CustomDataSource, DistanceDisplayCondition, Entity, HeadingPitchRange, SceneTransforms,
  HeightReference, ImageMaterialProperty, LabelStyle, Math as CesiumMath,
  Rectangle, SceneMode, ScreenSpaceEventHandler, ScreenSpaceEventType,
  type Viewer,
} from "cesium";
import { interpolateDevicePosition } from "./safetyStore";
import { splitActualTrackRuns, selectDecorativeTrackRun, selectionOutlinePositions } from "./safetyWorldEffectGeometry";
import { safetyHeatWeights, spatialNodeLayerVisible, type SafetySpatialLayerVisibility } from "./safetySceneVisibility";
import tokens from "./safetyDesignTokens.json";
import { SafetyScenePresentation, type SafetyPresentationOptions } from "./safetyScenePresentation";
export type SafetySceneEffectsOptions = SafetyPresentationOptions;
import type {
  SafetyDataset, SafetyDevice, SafetyNode, SafetyPosition, SafetySelection,
  SafetyState, SafetyView,
} from "./safetyTypes";

const CYAN = Color.fromCssColorString(tokens.colors.cyan)!;
const GOLD = Color.fromCssColorString(tokens.colors.attention)!;
const SEVERITY = {
  high: Color.fromCssColorString(tokens.colors.alert)!,
  medium: Color.fromCssColorString(tokens.colors.attention)!,
  low: Color.fromCssColorString(tokens.colors.cyan)!,
};
const MAX_LABELS = tokens.scene.overviewMaxLabels;
const FEATURE_KEYS = ["elementId", "componentId", "ElementId", "id", "ID"];

type NodeVisual = { node: SafetyNode; marker: Entity };
type DeviceVisual = {
  device: SafetyDevice; marker: Entity; tracks: Entity[]; trackRuns: Cartesian3[][];
  position: Cartesian3;
  hasPosition: boolean; trackKey: string;
};
type TaggedPick = {
  id?: Entity | { entityIndex?: number; safetySourceRecordId?: string };
  primitive?: { safetySourceRecordId?: string };
};

function constantValue(target: object, key: string, value: unknown): void {
  const owner = target as Record<string, unknown>;
  const property = owner[key];
  if (property instanceof ConstantProperty) property.setValue(value);
  else owner[key] = new ConstantProperty(value);
}

function validPosition(position: SafetyPosition): boolean {
  return Number.isFinite(position.longitude) && Math.abs(position.longitude) <= 180
    && Number.isFinite(position.latitude) && Math.abs(position.latitude) <= 90
    && Number.isFinite(position.height);
}

function cartesian(position: SafetyPosition, heightOffset = 0, result?: Cartesian3): Cartesian3 {
  return Cartesian3.fromDegrees(position.longitude, position.latitude, position.height + heightOffset, undefined, result);
}

function nodeRadius(node: SafetyNode): number {
  return Math.max(node.kind === "project" ? 100 : node.kind === "section" ? 35 : 3, node.radius ?? 12);
}

/** Presentation overlays only. It never modifies engineering coordinates, AR calibration or model quality. */
export class SafetySceneEffects {
  private readonly source = new CustomDataSource("施工安全大屏 · 展示覆盖层");
  private readonly handler: ScreenSpaceEventHandler;
  private readonly presentation: SafetyScenePresentation;
  private pickingEnabled = true;
  private earthMode = false;
  private authoring = false;
  private spatialLayers: Required<SafetySpatialLayerVisibility> = { constructionAreas: true, railwayAreas: true, riskPoints: true };
  private readonly labelCandidates: string[] = [];
  private readonly labelMeasure = document.createElement("canvas").getContext("2d");
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private lastLabelTime = -Infinity;
  private lastAnchorSample = -Infinity;
  private anchorCursor = 0;
  private readonly anchorCamera = new Cartesian3();
  private readonly anchorDirection = new Cartesian3();
  private readonly anchorSamples = new Map<string, number>();
  private anchorSurfaceReady = false;
  private decorativeTime = 0;
  private readonly nodeVisuals = new Map<string, NodeVisual>();
  private readonly deviceVisuals = new Map<string, DeviceVisual>();
  private readonly visibleDeviceIds = new Set<string>();
  private readonly pickTargets = new Map<string, SafetySelection>();
  private readonly heatCanvas = document.createElement("canvas");
  private readonly haloCanvas = document.createElement("canvas");
  private readonly selectedRing: Entity;
  private selectionVisible = false;
  private decoratedRouteDeviceId?: string;
  private decoratedRouteVertexCount = 0;
  private readonly heat: Entity;
  private readonly selectedRingPositions = new ConstantProperty([]);
  private readonly selectedPosition = new Cartesian3();
  private readonly heatImage: ImageMaterialProperty;
  private dataset?: SafetyDataset;
  private state?: SafetyState;
  private view?: SafetyView;
  private active = false;
  private disposed = false;
  private elapsed = 0;
  private heatKey = "";
  private heatGeneration = 0;
  private heatHasValues = false;
  private selectedNodeId = "";
  private lastFocus?: { nodeId: string; sourceHeight: number; surfaceHeight: number; heightSource: string; range: number };
  private selectedFeature?: { feature: Cesium3DTileFeature; color: Color; nodeId: string };

  constructor(private readonly viewer: Viewer, private readonly onSelect: (selection: SafetySelection) => void, private readonly options: SafetySceneEffectsOptions = {}) {
    this.source.show = false;
    this.presentation = new SafetyScenePresentation(viewer, options, () => [...this.source.entities.values]);
    this.heatCanvas.width = this.heatCanvas.height = 384;
    this.paintHalo();
    this.selectedRing = this.source.entities.add({
      id: "safety-selection-ring",
      show: false,
      polyline: {
        positions: this.selectedRingPositions, width: 4,
        material: CYAN, arcType: ArcType.NONE, clampToGround: false,
      },
    });
    this.heatImage = new ImageMaterialProperty({ image: this.heatCanvas, transparent: true, color: Color.WHITE.withAlpha(0.55) });
    this.heat = this.source.entities.add({
      id: "safety-alert-heat", name: "筛选告警事件密度（条，含已披露演示记录）", show: false,
      rectangle: { coordinates: Rectangle.fromDegrees(0, 0, 0.001, 0.001), material: this.heatImage },
    });
    // DataSourceCollection.add is async. Remove the late-added source if disposal wins the race.
    void this.viewer.dataSources.add(this.source).then(() => {
      if (this.disposed) this.viewer.dataSources.remove(this.source, true);
    }).catch((error: unknown) => console.warn("安全大屏覆盖层暂不可用", error));
    this.handler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this.handler.setInputAction((event: { position: Cartesian2 }) => this.pick(event.position), ScreenSpaceEventType.LEFT_CLICK);
  }

  setDataset(dataset: SafetyDataset): void {
    if (this.disposed) return;
    this.restoreFeature();
    this.presentation.removeWorldEffect("actual-flight-route"); this.presentation.removeWorldEffect("selected-outline");
    this.decoratedRouteDeviceId = undefined; this.decoratedRouteVertexCount = 0; this.selectionVisible = false;
    this.presentation.restore();
    for (const entity of [...this.source.entities.values]) {
      if (entity !== this.selectedRing && entity !== this.heat) this.source.entities.remove(entity);
    }
    this.nodeVisuals.clear();
    this.anchorSamples.clear(); this.anchorCursor = 0;
    this.deviceVisuals.clear();
    this.visibleDeviceIds.clear();
    this.pickTargets.clear();
    this.dataset = dataset;
    this.state = undefined;
    this.view = undefined;
    this.heatKey = this.selectedNodeId = "";
    this.heatHasValues = false;
    this.source.entities.suspendEvents();
    try {
      for (const node of dataset.nodes) {
        if (!validPosition(node.position) || node.sceneAvailable === false) continue;
        try { this.addNode(node); } catch (error) { console.warn(`安全大屏点位 ${node.id} 无法显示`, error); }
      }
      for (const device of dataset.devices) {
        try { this.addDevice(device); } catch (error) { console.warn(`安全大屏设备 ${device.id} 无法显示`, error); }
      }
      if (dataset.railway && dataset.railway.positions.length > 1 && dataset.railway.positions.every(validPosition)) {
        this.source.entities.add({
          id: "safety-railway", name: "营业线（来源见项目说明）",
          polyline: { positions: dataset.railway.positions.map((p) => cartesian(p)), width: 3, material: GOLD, arcType: ArcType.NONE },
        });
      }
    } finally { this.source.entities.resumeEvents(); }
    this.viewer.scene.requestRender();
  }

  private addNode(node: SafetyNode): void {
    const id = `safety-node:${node.id}`;
    const marker = this.source.entities.add({
      id, name: node.name, show: false, position: cartesian(node.position),
      ...(node.eventId ? { billboard: { image: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><path d="M14 2L27 25H1Z" fill="#FF687D" stroke="#E5F7FF" stroke-width="2"/><text x="14" y="21" text-anchor="middle" font-size="20" fill="#030B18">!</text></svg>'), width: 22, height: 22 } } : {}),
      point: { show: !node.eventId && !node.spatialObjectId, pixelSize: node.kind === "pier" ? 9 : 6, color: CYAN, outlineColor: Color.fromCssColorString(tokens.colors.panel), outlineWidth: 2, heightReference: HeightReference.NONE },
      label: {
        text: node.name, font: `${tokens.typographyPx.sceneLabel}px sans-serif`, fillColor: Color.fromCssColorString(tokens.colors.text),
        outlineColor: Color.fromCssColorString(tokens.colors.background), outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(0, -21), showBackground: true, backgroundColor: Color.fromCssColorString(tokens.colors.panel)!.withAlpha(0.8),
        backgroundPadding: new Cartesian2(7, 4), heightReference: HeightReference.NONE,
        distanceDisplayCondition: new DistanceDisplayCondition(0, node.kind === "project" ? 2_000_000 : 30_000),
      },
    });
    this.pickTargets.set(id, { nodeId: node.id, fly: true });
    const visual: NodeVisual = { node, marker };
    this.nodeVisuals.set(node.id, visual);
  }

  private addDevice(device: SafetyDevice): void {
    const node = this.dataset?.nodes.find((candidate) => candidate.id === device.nodeId);
    const first = device.track.find(validPosition);
    if (!node || !first) return; // A camera without coordinates is a list record, not an invented scene location.
    const position = cartesian(first);
    const marker = this.source.entities.add({
      id: `safety-device:${device.id}`, name: device.name, show: false,
      position: new CallbackPositionProperty((_time, result) => Cartesian3.clone(position, result), false),
      billboard: { image: this.haloCanvas, width: 70, height: 70, color: CYAN, distanceDisplayCondition: new DistanceDisplayCondition(0, 30_000) },
      point: { pixelSize: 11, color: GOLD, outlineColor: Color.fromCssColorString(tokens.colors.panel), outlineWidth: 2 },
      label: { text: device.name, font: `${tokens.typographyPx.sceneLabel}px sans-serif`, fillColor: GOLD, outlineColor: Color.BLACK, outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cartesian2(0, -22), distanceDisplayCondition: new DistanceDisplayCondition(0, 30_000) },
    });
    this.pickTargets.set(marker.id, { nodeId: node.id, fly: true });
    this.deviceVisuals.set(device.id, { device, marker, tracks: [], trackRuns: [], position, hasPosition: false, trackKey: "" });
  }

  update(state: SafetyState, view: SafetyView): void {
    if (this.disposed || !this.dataset) return;
    const previous = this.state;
    if (previous && previous.mode !== state.mode) { this.anchorSamples.clear(); this.anchorSurfaceReady = false; }
    this.state = state;
    this.view = view;
    // A playback cursor update only moves devices. It must not recreate point styles or chart-related textures.
    if (previous && previous.selectedId === state.selectedId && previous.selectedAlertId === state.selectedAlertId
      && previous.page === state.page && previous.eventStatus === state.eventStatus && previous.eventQuery === state.eventQuery
      && previous.mode === state.mode && previous.severity === state.severity && previous.includeDemo === state.includeDemo
      && previous.heatOpacity === state.heatOpacity && previous.animationPaused === state.animationPaused && previous.reducedMotion === state.reducedMotion
      && previous.engineeringAnnotations === state.engineeringAnnotations && previous.timeRange[0] === state.timeRange[0] && previous.timeRange[1] === state.timeRange[1]
      && (Object.keys(state.layers) as Array<keyof SafetyState["layers"]>).every((key) => previous.layers[key] === state.layers[key])) {
      this.tick(this.elapsed, state.time);
      return;
    }
    this.presentation.update(this.dataset, state, view, this.active && !this.earthMode);
    this.presentation.setAuthoring(this.authoring);
    if (this.selectedNodeId !== view.selected.id) {
      if (this.selectedFeature?.nodeId !== view.selected.id) this.restoreFeature();
      this.selectedNodeId = view.selected.id;
      cartesian(view.selected.position, 0.5, this.selectedPosition);
      this.selectedRingPositions.setValue(selectionOutlinePositions(view.selected, this.selectedPosition));
    }
    const alertNodeIds = new Set(view.alerts.map((alert) => alert.nodeId));
    const candidates = view.nodes.filter((node) => spatialNodeLayerVisible(node, this.spatialLayers) && node.sceneAvailable !== false && !node.navigationDisabledReason && (node.kind !== "component" || node.parentId === view.selected.id || node.id === view.selected.id || !!node.spatialObjectId || !!node.eventId || alertNodeIds.has(node.id)));
    const ordered = [...candidates].sort((a, b) => Number(b.id === view.selected.id) * 2 + Number(alertNodeIds.has(b.id)) - Number(a.id === view.selected.id) * 2 - Number(alertNodeIds.has(a.id)));
    const overview = view.selected.kind === "project";
    const overviewNodes = ordered.filter((node) => node.kind === "section" || node.kind === "pier" || !!node.spatialObjectId || !!node.eventId);
    const overviewIds = new Set<string>();
    if (overview) {
      for (const node of overviewNodes.filter((node) => !!node.spatialObjectId || !!node.eventId || node.kind === "section" || alertNodeIds.has(node.id))) {
        if (overviewIds.size < MAX_LABELS - 1) overviewIds.add(node.id);
      }
      const piers = overviewNodes.filter((node) => node.kind === "pier");
      const slots = MAX_LABELS - 1 - overviewIds.size;
      for (let i = 0; i < slots; i++) {
        const node = piers[Math.floor(i * Math.max(0, piers.length - 1) / Math.max(1, slots - 1))];
        if (node) overviewIds.add(node.id);
      }
    }
    const displayNodes = overview ? ordered.filter((node) => overviewIds.has(node.id)) : ordered;
    this.labelCandidates.splice(0, this.labelCandidates.length, ...displayNodes.map((node) => node.id));
    const labelIds = new Set(displayNodes.map((node) => node.id));
    const alertByNode = new Map<string, SafetyView["alerts"][number]>();
    for (const alert of view.alerts) {
      const old = alertByNode.get(alert.nodeId);
      if (!old || alert.severity === "high" || (alert.severity === "medium" && old.severity === "low")) alertByNode.set(alert.nodeId, alert);
    }
    for (const { node, marker } of this.nodeVisuals.values()) {
      marker.show = state.layers.markers && labelIds.has(node.id);
      const alert = alertByNode.get(node.id);
      marker.point!.color = new ConstantProperty(node.id === view.selected.id ? GOLD : alert ? SEVERITY[alert.severity] : CYAN);
      marker.point!.pixelSize = new ConstantProperty(node.id === view.selected.id ? 12 : alert ? 10 : 7);
      marker.point!.disableDepthTestDistance = new ConstantProperty(0);
      marker.label!.disableDepthTestDistance = new ConstantProperty(0);
      this.pickTargets.set(marker.id, { nodeId: node.id, alertId: alert?.id, fly: true });
    }
    this.visibleDeviceIds.clear();
    for (const device of view.devices) this.visibleDeviceIds.add(device.id);
    for (const visual of this.deviceVisuals.values()) {
      this.updateTrack(visual, state.timeRange);
      const visible = this.visibleDeviceIds.has(visual.device.id);
      for (const track of visual.tracks) track.show = visible && state.layers.track;
      if (!visible) visual.hasPosition = false;
    }
    const heatKey = [view.selected.id, state.timeRange.join(":"), state.severity, state.includeDemo,
      ...view.alerts.map((alert) => `${alert.id}:${alert.nodeId}:${alert.timestamp}`)].join("|");
    if (heatKey !== this.heatKey) { this.heatKey = heatKey; this.updateHeat(view); }
    this.heatImage.color = new ConstantProperty(Color.WHITE.withAlpha(Math.min(0.9, Math.max(0, state.heatOpacity))));
    this.applyVisibility();
    this.tick(this.elapsed, state.time);
    this.layoutLabels();
    this.viewer.scene.requestRender();
  }

  private layoutLabels(): void {
    if (!this.state || !this.view) return;
    if (!this.active || this.authoring || this.earthMode || !this.source.show) {
      for (const { marker } of [...this.nodeVisuals.values(), ...this.deviceVisuals.values()]) if (marker.label) constantValue(marker.label, "show", false);
      return;
    }
    const canvas = this.viewer.canvas;
    const safe = this.options.getStageRect?.() ?? { left: 330, top: 100, width: Math.max(200, canvas.clientWidth - 690), height: Math.max(180, canvas.clientHeight - 210) };
    const used: Array<{ x: number; y: number; w: number; h: number }> = [];
    const limit = this.view.selected.kind === "project" ? MAX_LABELS : tokens.scene.focusMaxLabels;
    if (this.labelMeasure) this.labelMeasure.font = `${tokens.typographyPx.sceneLabel}px sans-serif`;
    let deviceCount = 0;
    for (const visual of this.deviceVisuals.values()) {
      const label = visual.marker.label;
      if (!label) continue;
      let visible = false;
      if (!deviceCount && visual.marker.show && visual.hasPosition) {
        const screen = SceneTransforms.worldToWindowCoordinates(this.viewer.scene, visual.position);
        const width = (this.labelMeasure?.measureText(visual.device.name).width ?? 220) + 16;
        if (screen && screen.x - width / 2 >= safe.left + 8 && screen.x + width / 2 <= safe.left + safe.width - 8
          && screen.y - 46 >= safe.top + 8 && screen.y <= safe.top + safe.height - 8 && !this.isAnchorOccluded(visual.position, screen)) {
          used.push({ x: screen.x - width / 2, y: screen.y - 46, w: width, h: 31 }); visible = true; deviceCount++;
        }
      }
      constantValue(label, "show", visible);
    }
    let count = 0;
    for (const visual of this.nodeVisuals.values()) if (visual.marker.label) constantValue(visual.marker.label, "show", false);
    for (const id of this.labelCandidates) {
      const visual = this.nodeVisuals.get(id);
      if (!visual?.marker.show || !visual.marker.label || count >= limit - deviceCount) continue;
      const world = visual.marker.position?.getValue(this.viewer.clock.currentTime);
      if (!world) continue;
      const screen = SceneTransforms.worldToWindowCoordinates(this.viewer.scene, world);
      if (!screen || screen.x < safe.left + 10 || screen.x > safe.left + safe.width - 10 || screen.y < safe.top + 30 || screen.y > safe.top + safe.height - 15) continue;
      const selected = id === this.view.selected.id;
      const characters = Array.from(visual.node.name);
      const shortName = characters.length > 15 ? `${characters.slice(0, 14).join("")}…` : visual.node.name;
      const name = selected && this.isAnchorOccluded(world, screen) ? `${shortName} · 遮挡定位` : shortName;
      const width = (this.labelMeasure?.measureText(name).width ?? name.length * 18) + 20, height = 31;
      let rectangle: { x: number; y: number; w: number; h: number } | undefined;
      let offset = -25;
      for (const yOffset of [-25, -63, 35]) {
        const candidate = { x: screen.x - width / 2, y: screen.y + yOffset - height / 2, w: width, h: height };
        if (candidate.x < safe.left + 8 || candidate.x + width > safe.left + safe.width - 8 || candidate.y < safe.top + 8 || candidate.y + height > safe.top + safe.height - 8) continue;
        if (!used.some((r) => candidate.x < r.x + r.w + 10 && candidate.x + width + 10 > r.x && candidate.y < r.y + r.h + 10 && candidate.y + height + 10 > r.y)) { rectangle = candidate; offset = yOffset; break; }
      }
      if (!rectangle || (!selected && this.isAnchorOccluded(world, screen))) continue;
      constantValue(visual.marker.label, "text", name);
      constantValue(visual.marker.label, "pixelOffset", new Cartesian2(0, offset));
      constantValue(visual.marker.label, "show", true);
      // Hide occluded ordinary anchors as a whole label; the selected occluded anchor has an explicit warning.
      constantValue(visual.marker.label, "disableDepthTestDistance", Number.POSITIVE_INFINITY);
      used.push(rectangle); count++;
    }
  }

  private isAnchorOccluded(world: Cartesian3, screen: Cartesian2): boolean {
    if (!this.viewer.scene.pickPositionSupported) return false;
    try {
      const surface = this.presentation.readOpaqueDepthPosition(screen);
      return !!surface && Cartesian3.distance(this.viewer.camera.positionWC, surface) + 3 < Cartesian3.distance(this.viewer.camera.positionWC, world);
    } catch { return false; }
  }

  private sampleDisplayAnchors(): void {
    if (!this.viewer.scene.pickPositionSupported || this.viewer.scene.mode !== SceneMode.SCENE3D || !this.labelCandidates.length) return;
    if (document.hidden || this.authoring) return;
    if (!this.presentation.isSurfaceReady()) { this.anchorSurfaceReady = false; return; }
    if (!this.anchorSurfaceReady) { this.anchorSamples.clear(); this.anchorSurfaceReady = true; }
    if (Cartesian3.distanceSquared(this.anchorCamera, this.viewer.camera.positionWC) > 1 || Cartesian3.dot(this.anchorDirection, this.viewer.camera.directionWC) < 0.9999) {
      Cartesian3.clone(this.viewer.camera.positionWC, this.anchorCamera); Cartesian3.clone(this.viewer.camera.directionWC, this.anchorDirection);
      this.anchorSamples.clear(); return;
    }
    // Bounded warm-up sampling. Source engineering positions remain untouched; only our display anchors move.
    for (let count = 0; count < 3; count++) {
      const id = this.labelCandidates[this.anchorCursor++ % this.labelCandidates.length];
      const visual = this.nodeVisuals.get(id);
      // User model anchors and event coordinates are already authoritative positions.
      // Only CAD-derived labels need display-height correction; never shift a saved risk onto a bridge overhead.
      if (!visual || visual.node.spatialObjectId || visual.node.eventId || (this.anchorSamples.get(id) ?? 0) >= 3) continue;
      const p = Cartographic.fromDegrees(visual.node.position.longitude, visual.node.position.latitude, visual.node.position.height);
      // Count failed/occluded samples too: a static view must not force unbounded GPU readbacks.
      this.anchorSamples.set(id, (this.anchorSamples.get(id) ?? 0) + 1);
      try {
        const height = this.presentation.displaySurfaceHeight(p);
        if (typeof height !== "number" || !Number.isFinite(height)) continue;
        visual.marker.position = new ConstantPositionProperty(cartesian({ ...visual.node.position, height: height + 1.2 }));
        visual.marker.point!.heightReference = new ConstantProperty(HeightReference.NONE);
        visual.marker.label!.heightReference = new ConstantProperty(HeightReference.NONE);
        if (id === this.selectedNodeId) {
          cartesian({ ...visual.node.position, height: height + 1.2 }, 0, this.selectedPosition);
          this.refreshSelectionOutline(); this.presentation.setFocus(this.selectedPosition, this.selectionVisible);
        }
      } catch { /* Retry only within this view's budget; readiness or view changes reopen sampling. */ }
    }
  }

  private updateTrack(visual: DeviceVisual, range: [number, number]): void {
    const key = range.join(":");
    if (visual.trackKey === key) return;
    visual.trackKey = key;
    for (const entity of visual.tracks) { this.source.entities.remove(entity); this.pickTargets.delete(entity.id); }
    visual.tracks = [];
    visual.trackRuns = splitActualTrackRuns(visual.device.track, range);
    // Actual geometry keeps every real sample in each continuous source segment.
    for (const run of visual.trackRuns) {
      const entity = this.source.entities.add({
        id: `safety-track:${visual.device.id}:${visual.tracks.length}`,
        name: `${visual.device.name} · 实际采样航迹`, show: false,
        polyline: { positions: run, width: 2, arcType: ArcType.NONE, material: GOLD.withAlpha(0.8) },
      });
      this.pickTargets.set(entity.id, { nodeId: visual.device.nodeId, fly: true }); visual.tracks.push(entity);
    }
  }

  private updateHeat(view: SafetyView): void {
    const context = this.heatCanvas.getContext("2d");
    if (!context || !this.dataset) return;
    context.clearRect(0, 0, 384, 384);
    const weights = safetyHeatWeights(this.dataset, view);
    this.heatHasValues = weights.size > 0;
    if (!this.heatHasValues) { this.heat.show = false; return; }
    const positions = [...weights.values()].map((entry) => entry.position);
    const boundary = view.selected.boundary?.filter(validPosition) ?? [];
    const extent = [...positions, ...boundary];
    const west = Math.min(...extent.map((p) => p.longitude));
    const east = Math.max(...extent.map((p) => p.longitude));
    const south = Math.min(...extent.map((p) => p.latitude));
    const north = Math.max(...extent.map((p) => p.latitude));
    const padX = Math.max(0.00015, (east - west) * 0.14);
    const padY = Math.max(0.00015, (north - south) * 0.14);
    this.heat.rectangle!.coordinates = new ConstantProperty(Rectangle.fromDegrees(west - padX, south - padY, east + padX, north + padY));
    const maximum = Math.max(...[...weights.values()].map((entry) => entry.count));
    for (const { position, count } of weights.values()) {
      const x = (position.longitude - west + padX) / (east - west + 2 * padX) * 384;
      const y = (north + padY - position.latitude) / (north - south + 2 * padY) * 384;
      const radius = 27 + Math.sqrt(count / maximum) * 24;
      const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, Color.fromCssColorString(tokens.colors.alert)!.withAlpha(0.55 + count / maximum * 0.4).toCssColorString());
      gradient.addColorStop(0.3, Color.fromCssColorString(tokens.colors.attention)!.withAlpha(0.65).toCssColorString());
      gradient.addColorStop(0.64, CYAN.withAlpha(0.35).toCssColorString());
      gradient.addColorStop(1, Color.fromCssColorString(tokens.colors.blue)!.withAlpha(0).toCssColorString());
      context.fillStyle = gradient;
      context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    // A new image URI notifies Cesium only when filters change, avoiding per-frame texture allocations.
    this.heatImage.image = new ConstantProperty(this.heatCanvas.toDataURL("image/png"));
    this.heatGeneration += 1;
  }

  private paintHalo(): void {
    this.haloCanvas.width = this.haloCanvas.height = 80;
    const context = this.haloCanvas.getContext("2d");
    if (!context) return;
    context.beginPath(); context.arc(40, 40, 28, 0, Math.PI * 2);
    context.strokeStyle = tokens.colors.cyan; context.lineWidth = 2; context.stroke();
    context.beginPath(); context.arc(40, 40, 35, 0, Math.PI * 2);
    context.strokeStyle = CYAN.withAlpha(0.4).toCssColorString(); context.lineWidth = 1; context.setLineDash([4, 7]); context.stroke();
  }

  setActive(active: boolean): void {
    if (this.disposed) return;
    this.active = active;
    this.source.show = active && !this.authoring;
    this.earthMode = false;
    if (active && this.dataset && this.state && this.view) this.presentation.update(this.dataset, this.state, this.view, true);
    if (!active) { this.presentation.restore(); this.viewer.camera.cancelFlight(); this.restoreFeature(); }
    this.viewer.scene.requestRender();
  }

  setSpatialLayers(patch: SafetySpatialLayerVisibility): void {
    this.spatialLayers = { ...this.spatialLayers, ...patch };
    if (this.state && this.view) {
      const state = this.state, view = this.view;
      this.state = undefined; // A layer toggle must bypass the playback-only update shortcut.
      this.update(state, view);
    }
  }

  private refreshSelectionOutline(): void {
    if (!this.view) return;
    const positions = selectionOutlinePositions(this.view.selected, this.selectedPosition);
    this.selectedRingPositions.setValue(positions);
    const color = this.view.selected.spatialKind === "railway" ? "#FFB957" : "#43D9FF";
    if (this.selectedRing.polyline) this.selectedRing.polyline.material = new ColorMaterialProperty(Color.fromCssColorString(color));
    if (this.selectionVisible) this.presentation.setWorldSelection("selected-outline", positions, color);
    else this.presentation.removeWorldEffect("selected-outline");
  }

  private syncWorldRoute(): void {
    const state = this.state;
    const eligible = this.active && !this.earthMode && !this.authoring && state?.layers.track && state.layers.links && state.layers.effects;
    const visual = eligible ? [...this.deviceVisuals.values()].find(v => this.visibleDeviceIds.has(v.device.id) && v.trackRuns.length) : undefined;
    const positions = visual && selectDecorativeTrackRun(visual.trackRuns);
    if (positions) {
      this.presentation.setWorldRoute("actual-flight-route", positions);
      this.decoratedRouteDeviceId = visual!.device.id; this.decoratedRouteVertexCount = positions.length;
    } else {
      this.presentation.removeWorldEffect("actual-flight-route"); this.decoratedRouteDeviceId = undefined; this.decoratedRouteVertexCount = 0;
    }
  }

  private applyVisibility(): void {
    if (!this.state || !this.view) return;
    const { state } = this, selected = this.view.selected;
    this.selectionVisible = this.active && !this.earthMode && !this.authoring && spatialNodeLayerVisible(selected, this.spatialLayers)
      && !selected.navigationDisabledReason && selected.sceneAvailable !== false && state.layers.markers
      && selected.kind !== "project" && (selected.kind !== "section" || !!selected.spatialObjectId);
    // Reality retains a simple independent line. Showcase uses the package world-outline material.
    this.selectedRing.show = this.selectionVisible && state.mode === "inspection";
    this.refreshSelectionOutline(); this.presentation.setFocus(this.selectedPosition, this.selectionVisible);
    this.syncWorldRoute(); this.heat.show = state.layers.heat && this.heatHasValues;
  }

  /** Called by the host's single animation clock; this module registers no clock listeners or RAF loop. */
  tick(elapsedSeconds: number, timeMs: number): void {
    if (this.disposed || !this.active || !this.state || !this.view) return;
    const reduced = this.state.reducedMotion === true || this.reducedMotion.matches;
    const animated = this.state.mode === "presentation" && this.state.layers.effects && !this.state.animationPaused && !document.hidden && !reduced;
    if (animated && elapsedSeconds - this.elapsed < 1) this.decorativeTime += Math.max(0, elapsedSeconds - this.elapsed);
    this.elapsed = elapsedSeconds;
    this.presentation.tick(elapsedSeconds, this.decorativeTime, animated, reduced);
    if (elapsedSeconds - this.lastAnchorSample > 0.4) { this.lastAnchorSample = elapsedSeconds; this.sampleDisplayAnchors(); }
    for (const visual of this.deviceVisuals.values()) {
      const sample = this.visibleDeviceIds.has(visual.device.id) ? interpolateDevicePosition(visual.device, timeMs) : undefined;
      visual.hasPosition = !!sample;
      if (sample) cartesian(sample, 0, visual.position);
      visual.marker.show = visual.hasPosition && this.state.layers.markers;
    }
    if (elapsedSeconds - this.lastLabelTime > 0.18) { this.lastLabelTime = elapsedSeconds; this.layoutLabels(); }
  }

  cancelPendingHome(): void { this.presentation.cancelHome(); }

  setPickingEnabled(enabled: boolean): void { this.pickingEnabled = enabled; }

  readOpaqueDepthPosition(screen: Cartesian2): Cartesian3 | undefined { return this.presentation.readOpaqueDepthPosition(screen); }

  suspendOverlaysForPicking(): () => void {
    const show = this.source.show;
    this.source.show = false;
    return () => {
      if (!this.disposed) this.source.show = show && this.active && !this.earthMode && !this.authoring;
      this.viewer.scene.requestRender();
    };
  }

  focus(node: SafetyNode, duration = tokens.motion.cameraFocusSeconds): void {
    if (node.sceneAvailable === false || node.navigationDisabledReason) return;
    if (this.disposed || !validPosition(node.position) || node.navigationDisabledReason) return;
    this.earthMode = false; this.source.show = this.active && !this.authoring;
    if (this.dataset && this.state && this.view) this.presentation.update(this.dataset, this.state, this.view, this.active);
    if (node.kind === "project") { this.presentation.home(duration); return; }
    this.presentation.cancelHome();
    const frame = this.presentation.frame();
    const sphere = node.boundary?.length
      ? BoundingSphere.fromPoints(node.boundary.filter(validPosition).map((p) => cartesian(p)))
      : new BoundingSphere(cartesian(node.position), nodeRadius(node));
    sphere.radius = Math.max(sphere.radius, nodeRadius(node));
    // CAD text often has a drawing-plane Z=0 while photogrammetry sits tens of metres above it.
    // Depth-derived height is only a camera/display reference; keep node and engineering coordinates intact.
    const location = Cartographic.fromDegrees(node.position.longitude, node.position.latitude, node.position.height);
    let surfaceHeight: number | undefined;
    let heightSource = "node";
    if (!node.spatialObjectId && !node.eventId && this.presentation.isSurfaceReady() && this.viewer.scene.mode === SceneMode.SCENE3D && this.viewer.scene.pickPositionSupported) {
      try {
        surfaceHeight = this.presentation.displaySurfaceHeight(location);
        if (typeof surfaceHeight === "number" && Number.isFinite(surfaceHeight)) heightSource = "loaded-depth-display-reference";
      } catch { /* Unavailable depth sampling falls back to the loaded terrain, then source height. */ }
    }
    if (!node.spatialObjectId && !node.eventId && (typeof surfaceHeight !== "number" || !Number.isFinite(surfaceHeight))) {
      surfaceHeight = this.viewer.scene.globe.getHeight(location);
      if (typeof surfaceHeight === "number" && Number.isFinite(surfaceHeight)) heightSource = "terrain";
    }
    if (typeof surfaceHeight !== "number" || !Number.isFinite(surfaceHeight)) surfaceHeight = node.position.height;
    if (frame && (node.kind === "section")) { Cartesian3.clone(frame.center, sphere.center); sphere.radius = frame.radius; }
    const center = Cartographic.fromCartesian(sphere.center) ?? location;
    Cartesian3.fromRadians(center.longitude, center.latitude, surfaceHeight + 2, undefined, sphere.center);
    if (this.selectedNodeId === node.id) { cartesian({ ...node.position, height: surfaceHeight }, 0.5, this.selectedPosition); this.refreshSelectionOutline(); this.presentation.setFocus(this.selectedPosition, this.selectionVisible); }
    const range = frame && (node.kind === "section") ? frame.range : Math.max(120, sphere.radius * 3.3);
    this.lastFocus = { nodeId: node.id, sourceHeight: node.position.height, surfaceHeight, heightSource, range };
    this.viewer.camera.cancelFlight();
    this.viewer.camera.flyToBoundingSphere(sphere, {
      duration: this.reducedMotion.matches ? 0 : duration,
      offset: new HeadingPitchRange(frame?.heading ?? CesiumMath.toRadians(10), frame?.pitch ?? CesiumMath.toRadians(-42.5), range),
    });
  }

  setAuthoring(active: boolean): void {
    if (this.authoring !== active) { this.anchorSamples.clear(); this.anchorSurfaceReady = false; }
    this.authoring = active; this.presentation.setAuthoring(active);
    this.source.show = this.active && !this.earthMode && !active;
    this.applyVisibility(); this.layoutLabels();
    this.viewer.scene.requestRender();
  }

  earth(): void {
    if (this.disposed) return;
    this.earthMode = true; this.restoreFeature(); this.presentation.restore(); this.source.show = false;
    const node = this.dataset?.nodes.find((candidate) => candidate.id === this.dataset?.projectId);
    this.viewer.camera.cancelFlight();
    this.viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(node?.position.longitude ?? 120, node?.position.latitude ?? 30, 22_000_000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 }, duration: this.reducedMotion.matches ? 0 : tokens.motion.cameraFocusSeconds });
  }

  private pick(position: Cartesian2): void {
    if (!this.active || this.disposed || this.earthMode || !this.pickingEnabled || !this.dataset) return;
    try {
      const picked = this.viewer.scene.pick(position) as TaggedPick | Cesium3DTileFeature | undefined;
      if (!picked) return;
      if (picked instanceof Cesium3DTileFeature) {
        const recordId = (picked.primitive as unknown as { safetySourceRecordId?: string }).safetySourceRecordId;
        const identifiers = FEATURE_KEYS.map((key) => picked.getProperty(key)).filter((value) => value !== undefined && value !== null).map(String);
        const matches = this.dataset.nodes.filter((node) => node.modelFeatureId && identifiers.includes(node.modelFeatureId)
          && (!node.sourceRecordId || node.sourceRecordId === recordId));
        if (matches.length !== 1 || !this.view?.nodes.some((node) => node.id === matches[0].id)) return;
        this.restoreFeature();
        this.selectedFeature = { feature: picked, color: picked.color.clone(), nodeId: matches[0].id };
        picked.color = GOLD;
        this.onSelect({ nodeId: matches[0].id, fly: false });
        return;
      }
      if (picked.id instanceof Entity) {
        const ownSelection = this.pickTargets.get(picked.id.id);
        if (ownSelection) { this.onSelect(ownSelection); return; }
      }
      const recordId = picked.primitive?.safetySourceRecordId
        ?? (picked.id as { safetySourceRecordId?: string } | undefined)?.safetySourceRecordId;
      const index = picked.id instanceof Entity
        ? Number(picked.id.id.match(/-(\d+)$/)?.[1])
        : picked.id?.entityIndex;
      if (!recordId || !Number.isInteger(index)) return;
      const matches = this.dataset.nodes.filter((node) => node.sourceRecordId === recordId && node.sourceEntityIndex === index);
      if (matches.length === 1 && this.view?.nodes.some((node) => node.id === matches[0].id)) this.onSelect({ nodeId: matches[0].id, fly: true });
    } catch (error) { console.warn("安全大屏对象拾取未完成", error); }
  }

  private restoreFeature(): void {
    if (!this.selectedFeature) return;
    try { this.selectedFeature.feature.color = this.selectedFeature.color; } catch { /* Tile may have been evicted during camera navigation. */ }
    this.selectedFeature = undefined;
  }

  debugStats(): Record<string, unknown> {
    const labelsVisible = this.active && !this.earthMode && !this.authoring && this.source.show;
    const visibleNodeLabels = labelsVisible ? [...this.nodeVisuals.values()].filter(v => v.marker.show && v.marker.label?.show?.getValue(this.viewer.clock.currentTime)).length : 0;
    const visibleDeviceLabels = labelsVisible ? [...this.deviceVisuals.values()].filter(v => v.marker.show && v.marker.label?.show?.getValue(this.viewer.clock.currentTime)).length : 0;
    return {
      active: this.active, disposed: this.disposed, dataSources: this.viewer.dataSources.contains(this.source) ? 1 : 0,
      entities: this.source.entities.values.length, nodeVisuals: this.nodeVisuals.size,
      visibleLabels: visibleNodeLabels + visibleDeviceLabels, visibleNodeLabels, visibleDeviceLabels, labelLimit: this.view?.selected.kind === "project" ? MAX_LABELS : tokens.scene.focusMaxLabels,
      presentation: this.presentation.debugStats(), decorativeTime: this.decorativeTime, reducedMotion: !!this.state?.reducedMotion || this.reducedMotion.matches,
      visibleNodeIds: [...this.nodeVisuals.values()].filter((visual) => visual.marker.show).map((visual) => visual.node.id),
      heatVisible: this.active && this.heat.show, visibleBoundaries: 0,
      visibleDeviceIds: [...this.deviceVisuals.values()].filter((visual) => visual.marker.show).map((visual) => visual.device.id),
      decoratedRouteDeviceId: this.decoratedRouteDeviceId, decoratedRouteVertexCount: this.decoratedRouteVertexCount, decorativeRouteSource: "one-existing-continuous-actual-track-run", schematicLinks: 0, selectionVisible: this.selectionVisible,
      actualTrackSegments: [...this.deviceVisuals.values()].reduce((sum, visual) => sum + visual.tracks.length, 0),
      deviceVisuals: this.deviceVisuals.size, actualTrackVertices: [...this.deviceVisuals.values()].reduce((sum, visual) => sum + visual.device.track.length, 0),
      motionPeriods: tokens.motion, animatedGroupsLimit: tokens.scene.maxDynamicHighlights, ownClockListeners: 0, pickHandlers: this.disposed ? 0 : 1, heatGeneration: this.heatGeneration,
      heatMetric: "筛选告警事件数量，单位：条；热斑表示位置邻域密度，不代表工程距离或风险概率",
      lastFocus: this.lastFocus,
      selectedNodeId: this.selectedNodeId, highlightedModelFeatureId: this.selectedFeature?.nodeId ?? null,
      presentationOnlyExtrusion: true,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.viewer.camera.cancelFlight();
    this.restoreFeature();
    this.handler.destroy();
    this.presentation.dispose();
    this.viewer.dataSources.remove(this.source, true);
    this.source.entities.removeAll();
    this.nodeVisuals.clear(); this.deviceVisuals.clear(); this.pickTargets.clear(); this.visibleDeviceIds.clear();
    this.heatCanvas.width = this.haloCanvas.width = 0;
    this.viewer.scene.requestRender();
  }
}
