import {
  ArcType, BoundingSphere, CallbackPositionProperty, CallbackProperty, Cartesian2,
  Cartesian3, Cartographic, Cesium3DTileFeature, Color, ColorMaterialProperty, ConstantProperty, ConstantPositionProperty,
  CustomDataSource, DistanceDisplayCondition, Entity, Event, Material, HeadingPitchRange, SceneTransforms,
  HeightReference, ImageMaterialProperty, LabelStyle, Math as CesiumMath, Matrix4,
  PolygonHierarchy, PolylineGlowMaterialProperty,
  Rectangle, SceneMode, ScreenSpaceEventHandler, ScreenSpaceEventType, Transforms,
  type Viewer, type MaterialProperty, type JulianDate,
} from "cesium";
import { interpolateDevicePosition } from "./safetyStore";
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

type NodeVisual = { node: SafetyNode; marker: Entity; boundary?: Entity; plate?: Entity };
type DeviceVisual = {
  device: SafetyDevice; marker: Entity; beam: Entity; link: Entity; tracks: Entity[];
  position: Cartesian3; beamPosition: Cartesian3; linkPositions: Cartesian3[];
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

function circlePositions(node: SafetyNode, radius: number): Cartesian3[] {
  const transform = Transforms.eastNorthUpToFixedFrame(cartesian(node.position, 0.6));
  return Array.from({ length: 65 }, (_, i) => Matrix4.multiplyByPoint(
    transform, new Cartesian3(Math.cos(i / 64 * Math.PI * 2) * radius, Math.sin(i / 64 * Math.PI * 2) * radius, 0), new Cartesian3(),
  ));
}

const FLOW_TYPE = "SafetySharedFlowV2";
let flowRegistered = false;
class SafetyFlowMaterialProperty implements MaterialProperty {
  readonly isConstant = false;
  readonly definitionChanged = new Event();
  phase = 0;
  constructor() {
    if (!flowRegistered) {
      // The documented Fabric constructor registers a reusable material type; no private cache mutation.
      const template = new Material({ fabric: { type: FLOW_TYPE,
        uniforms: { tint: CYAN.withAlpha(0.85), phase: 0, trail: tokens.motion.flow.trailFraction },
        source: `czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material m = czm_getDefaultMaterial(materialInput);
          float d = fract(phase - materialInput.st.s);
          float tail = (1.0 - smoothstep(0.0, trail, d)) * (1.0 - step(trail, d));
          m.diffuse = tint.rgb; m.emission = tint.rgb * tail * 0.3;
          m.alpha = tint.a * (0.13 + tail * 0.87); return m;
        }`,
      }, translucent: true });
      template.destroy(); flowRegistered = true;
    }
  }
  getType(_time: JulianDate): string { return FLOW_TYPE; }
  getValue(_time: JulianDate, result?: Record<string, unknown>): Record<string, unknown> {
    const value = result ?? {}; value.tint = CYAN.withAlpha(0.85, value.tint as Color | undefined);
    value.phase = this.phase; value.trail = tokens.motion.flow.trailFraction; return value;
  }
  equals(other?: MaterialProperty): boolean { return other === this; }
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
  private decorativeTime = 0;
  private readonly nodeVisuals = new Map<string, NodeVisual>();
  private readonly deviceVisuals = new Map<string, DeviceVisual>();
  private readonly visibleDeviceIds = new Set<string>();
  private readonly pickTargets = new Map<string, SafetySelection>();
  private readonly heatCanvas = document.createElement("canvas");
  private readonly haloCanvas = document.createElement("canvas");
  private readonly pulseColor = CYAN.clone();
  private readonly beamColor = CYAN.withAlpha(0.16);
  private readonly selectedRing: Entity;
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
  private readonly flowMaterial = new SafetyFlowMaterialProperty();
  private readonly beamMaterial = new ColorMaterialProperty(new CallbackProperty(() => this.beamColor, false));

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
        material: new PolylineGlowMaterialProperty({
          color: new CallbackProperty(() => this.pulseColor, false), glowPower: 0.2,
        }), clampToGround: true,
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
      point: { show: !node.eventId && !node.spatialObjectId, pixelSize: node.kind === "pier" ? 9 : 6, color: CYAN, outlineColor: Color.fromCssColorString(tokens.colors.panel), outlineWidth: 2, heightReference: HeightReference.CLAMP_TO_GROUND },
      label: {
        text: node.name, font: `${tokens.typographyPx.sceneLabel}px sans-serif`, fillColor: Color.fromCssColorString(tokens.colors.text),
        outlineColor: Color.fromCssColorString(tokens.colors.background), outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(0, -21), showBackground: true, backgroundColor: Color.fromCssColorString(tokens.colors.panel)!.withAlpha(0.8),
        backgroundPadding: new Cartesian2(7, 4), heightReference: HeightReference.CLAMP_TO_GROUND,
        distanceDisplayCondition: new DistanceDisplayCondition(0, node.kind === "project" ? 2_000_000 : 30_000),
      },
    });
    this.pickTargets.set(id, { nodeId: node.id, fly: true });
    const visual: NodeVisual = { node, marker };
    const points = node.boundary?.filter(validPosition);
    if (points && points.length >= 3 && !node.spatialObjectId) {
      const positions = points.map((p) => cartesian(p));
      visual.boundary = this.source.entities.add({
        id: `safety-boundary:${node.id}`, name: `${node.name} · CAD 推导展示范围`, show: false,
        polyline: { positions: [...positions, positions[0]], width: 3, clampToGround: true, material: new PolylineGlowMaterialProperty({ color: CYAN.withAlpha(0.86), glowPower: 0.18 }) },
      });
      this.pickTargets.set(visual.boundary.id, { nodeId: node.id, fly: true });
      const base = Math.min(...points.map((p) => p.height));
      visual.plate = this.source.entities.add({
        id: `safety-region:${node.id}`, name: `${node.name} · 展示性拉伸（非工程模型）`, show: false,
        polygon: {
          hierarchy: new PolygonHierarchy(positions), height: base - 4,
          extrudedHeight: base + Math.min(12, nodeRadius(node) * 0.015),
          material: Color.fromCssColorString(tokens.colors.blue)!.withAlpha(0.12),
          closeTop: true, closeBottom: false, outline: false,
        },
      });
      this.pickTargets.set(visual.plate.id, { nodeId: node.id, fly: true });
    }
    this.nodeVisuals.set(node.id, visual);
  }

  private addDevice(device: SafetyDevice): void {
    const node = this.dataset?.nodes.find((candidate) => candidate.id === device.nodeId);
    const first = device.track.find(validPosition);
    if (!node || !first) return; // A camera without coordinates is a list record, not an invented scene location.
    const position = cartesian(first);
    const beamPosition = cartesian(first, 16);
    const marker = this.source.entities.add({
      id: `safety-device:${device.id}`, name: device.name, show: false,
      position: new CallbackPositionProperty((_time, result) => Cartesian3.clone(position, result), false),
      billboard: { image: this.haloCanvas, width: 70, height: 70, color: CYAN, distanceDisplayCondition: new DistanceDisplayCondition(0, 30_000) },
      point: { pixelSize: 11, color: GOLD, outlineColor: Color.fromCssColorString(tokens.colors.panel), outlineWidth: 2 },
      label: { text: device.name, font: `${tokens.typographyPx.sceneLabel}px sans-serif`, fillColor: GOLD, outlineColor: Color.BLACK, outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cartesian2(0, -22), distanceDisplayCondition: new DistanceDisplayCondition(0, 30_000) },
    });
    this.pickTargets.set(marker.id, { nodeId: node.id, fly: true });
    const beam = this.source.entities.add({
      id: `safety-beam:${device.id}`, name: `${device.name} · 展示光柱`, show: false,
      position: new CallbackPositionProperty((_time, result) => Cartesian3.clone(beamPosition, result), false),
      cylinder: { length: 32, topRadius: 0.5, bottomRadius: 3.5, material: this.beamMaterial, numberOfVerticalLines: 0, slices: 24 },
    });
    const linkPositions = [cartesian(node.position), position];
    const link = this.source.entities.add({
      id: `safety-link:${device.id}`, name: `${device.name} · 示意联络线（非航迹）`, show: false,
      polyline: {
        positions: new CallbackProperty(() => linkPositions, false), width: tokens.motion.flow.headReferencePx,
        arcType: ArcType.NONE,
        material: this.flowMaterial,
      },
    });
    this.deviceVisuals.set(device.id, { device, marker, beam, link, tracks: [], position, beamPosition, linkPositions, hasPosition: false, trackKey: "" });
  }

  update(state: SafetyState, view: SafetyView): void {
    if (this.disposed || !this.dataset) return;
    const previous = this.state;
    this.state = state;
    this.view = view;
    // A playback cursor update only moves devices. It must not recreate point styles or chart-related textures.
    if (previous && previous.selectedId === state.selectedId && previous.selectedAlertId === state.selectedAlertId
      && previous.page === state.page && previous.eventStatus === state.eventStatus && previous.eventQuery === state.eventQuery
      && previous.mode === state.mode && previous.severity === state.severity && previous.includeDemo === state.includeDemo
      && previous.heatOpacity === state.heatOpacity && previous.animationPaused === state.animationPaused
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
      const radius = Math.min(120, Math.max(5, nodeRadius(view.selected) * (view.selected.kind === "project" || view.selected.kind === "section" ? 0.22 : 1.3)));
      this.selectedRingPositions.setValue(circlePositions(view.selected, radius));
    }
    const alertNodeIds = new Set(view.alerts.map((alert) => alert.nodeId));
    const candidates = view.nodes.filter((node) => spatialNodeLayerVisible(node, this.spatialLayers) && node.sceneAvailable !== false && !node.navigationDisabledReason && (node.kind !== "component" || node.parentId === view.selected.id || node.id === view.selected.id || !!node.spatialObjectId || !!node.eventId || alertNodeIds.has(node.id)));
    const ordered = [...candidates].sort((a, b) => Number(b.id === view.selected.id) * 2 + Number(alertNodeIds.has(b.id)) - Number(a.id === view.selected.id) * 2 - Number(alertNodeIds.has(a.id)));
    const overview = view.selected.kind === "project" || view.selected.kind === "section";
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
    const deviceLabelIds = new Set(view.devices.slice(0, 1).map((device) => device.id));
    this.labelCandidates.splice(0, this.labelCandidates.length, ...displayNodes.map((node) => node.id));
    const labelIds = new Set(displayNodes.map((node) => node.id));
    const visibleIds = new Set(view.nodes.map((node) => node.id));
    const alertByNode = new Map<string, SafetyView["alerts"][number]>();
    for (const alert of view.alerts) {
      const old = alertByNode.get(alert.nodeId);
      if (!old || alert.severity === "high" || (alert.severity === "medium" && old.severity === "low")) alertByNode.set(alert.nodeId, alert);
    }
    for (const { node, marker, boundary, plate } of this.nodeVisuals.values()) {
      marker.show = state.layers.markers && labelIds.has(node.id);
      const alert = alertByNode.get(node.id);
      marker.point!.color = new ConstantProperty(node.id === view.selected.id ? GOLD : alert ? SEVERITY[alert.severity] : CYAN);
      marker.point!.pixelSize = new ConstantProperty(node.id === view.selected.id ? 12 : alert ? 10 : 7);
      marker.point!.disableDepthTestDistance = new ConstantProperty(0);
      marker.label!.disableDepthTestDistance = new ConstantProperty(0);
      this.pickTargets.set(marker.id, { nodeId: node.id, alertId: alert?.id, fly: true });
      if (boundary) boundary.show = !!node.spatialObjectId && state.layers.boundary && visibleIds.has(node.id);
      if (plate) plate.show = false;
    }
    this.visibleDeviceIds.clear();
    for (const device of view.devices) this.visibleDeviceIds.add(device.id);
    for (const visual of this.deviceVisuals.values()) {
      this.updateTrack(visual, state.timeRange);
      const visible = this.visibleDeviceIds.has(visual.device.id);
      visual.marker.label!.show = new ConstantProperty(deviceLabelIds.has(visual.device.id));
      for (const track of visual.tracks) track.show = visible && state.layers.track;
      if (!visible) visual.hasPosition = false;
    }
    const heatKey = [view.selected.id, state.timeRange.join(":"), state.severity, state.includeDemo,
      ...view.alerts.map((alert) => `${alert.id}:${alert.nodeId}:${alert.timestamp}`)].join("|");
    if (heatKey !== this.heatKey) { this.heatKey = heatKey; this.updateHeat(view); }
    this.heatImage.color = new ConstantProperty(Color.WHITE.withAlpha(Math.min(0.9, Math.max(0, state.heatOpacity))));
    this.applyVisibility();
    this.layoutLabels();
    this.tick(this.elapsed, state.time);
    this.viewer.scene.requestRender();
  }

  private layoutLabels(): void {
    if (!this.state || !this.view) return;
    const canvas = this.viewer.canvas;
    const safe = this.options.getStageRect?.() ?? { left: 330, top: 100, width: Math.max(200, canvas.clientWidth - 690), height: Math.max(180, canvas.clientHeight - 210) };
    const used: Array<{ x: number; y: number; w: number; h: number }> = [];
    const limit = this.view.selected.kind === "project" || this.view.selected.kind === "section" ? MAX_LABELS : tokens.scene.focusMaxLabels;
    let deviceCount = 0;
    for (const visual of this.deviceVisuals.values()) {
      const label = visual.marker.label;
      if (!label) continue;
      let visible = false;
      if (!deviceCount && visual.marker.show) {
        const screen = SceneTransforms.worldToWindowCoordinates(this.viewer.scene, visual.position);
        const width = (this.labelMeasure?.measureText(visual.device.name).width ?? 220) + 16;
        if (screen && screen.x - width / 2 >= safe.left + 8 && screen.x + width / 2 <= safe.left + safe.width - 8
          && screen.y - 46 >= safe.top + 8 && screen.y <= safe.top + safe.height - 8) {
          used.push({ x: screen.x - width / 2, y: screen.y - 46, w: width, h: 31 }); visible = true; deviceCount++;
        }
      }
      constantValue(label, "show", visible);
    }
    let count = 0;
    if (this.labelMeasure) this.labelMeasure.font = `${tokens.typographyPx.sceneLabel}px sans-serif`;
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
    if (document.hidden || !this.presentation.isSurfaceReady()) return;
    if (Cartesian3.distanceSquared(this.anchorCamera, this.viewer.camera.positionWC) > 1 || Cartesian3.dot(this.anchorDirection, this.viewer.camera.directionWC) < 0.9999) {
      Cartesian3.clone(this.viewer.camera.positionWC, this.anchorCamera); Cartesian3.clone(this.viewer.camera.directionWC, this.anchorDirection);
      this.anchorSamples.clear(); return;
    }
    // Bounded warm-up sampling. Source engineering positions remain untouched; only our display anchors move.
    for (let count = 0; count < 3; count++) {
      const id = this.labelCandidates[this.anchorCursor++ % this.labelCandidates.length];
      const visual = this.nodeVisuals.get(id);
      if (!visual || (this.anchorSamples.get(id) ?? 0) >= 3) continue;
      const p = Cartographic.fromDegrees(visual.node.position.longitude, visual.node.position.latitude, visual.node.position.height);
      try {
        const height = this.presentation.displaySurfaceHeight(p);
        if (typeof height !== "number" || !Number.isFinite(height)) continue;
        this.anchorSamples.set(id, (this.anchorSamples.get(id) ?? 0) + 1);
        visual.marker.position = new ConstantPositionProperty(cartesian({ ...visual.node.position, height: height + 1.2 }));
        visual.marker.point!.heightReference = new ConstantProperty(HeightReference.NONE);
        visual.marker.label!.heightReference = new ConstantProperty(HeightReference.NONE);
        if (id === this.selectedNodeId) {
          cartesian({ ...visual.node.position, height: height + 1.2 }, 0, this.selectedPosition);
          this.presentation.setFocus(this.selectedPosition, this.selectedRing.show);
        }
      } catch { /* The real surface may not be loaded yet; retry without fabricating a height. */ }
    }
  }

  private updateTrack(visual: DeviceVisual, range: [number, number]): void {
    const key = range.join(":");
    if (visual.trackKey === key) return;
    visual.trackKey = key;
    for (const entity of visual.tracks) { this.source.entities.remove(entity); this.pickTargets.delete(entity.id); }
    visual.tracks = [];
    let run: Cartesian3[] = [];
    let previousTime: number | undefined;
    let previousSegment: number | undefined;
    const flush = () => {
      if (run.length > 1) {
        const entity = this.source.entities.add({
          id: `safety-track:${visual.device.id}:${visual.tracks.length}`,
          name: `${visual.device.name} · 实际采样航迹`, show: false,
          polyline: { positions: run, width: 2, arcType: ArcType.NONE, material: GOLD.withAlpha(0.8) },
        });
        this.pickTargets.set(entity.id, { nodeId: visual.device.nodeId, fly: true });
        visual.tracks.push(entity);
      }
      run = [];
    };
    // Preserve every real sample in the chosen interval; a missing-data gap must not become an invented flight segment.
    for (const point of visual.device.track) {
      if (point.time < range[0] || point.time > range[1] || !validPosition(point)) continue;
      if (previousTime !== undefined && (point.time - previousTime > 5_000 || point.time <= previousTime || point.segment !== previousSegment)) flush();
      run.push(cartesian(point));
      previousTime = point.time;
      previousSegment = point.segment;
    }
    flush();
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

  private applyVisibility(): void {
    if (!this.state || !this.view) return;
    const { state } = this;
    this.selectedRing.show = !this.authoring && spatialNodeLayerVisible(this.view.selected, this.spatialLayers) && !this.view.selected.navigationDisabledReason && this.view.selected.sceneAvailable !== false && state.layers.markers && this.view.selected.kind !== "project" && this.view.selected.kind !== "section";
    this.presentation.setFocus(this.selectedPosition, this.selectedRing.show);
    this.heat.show = state.layers.heat && this.heatHasValues;
  }

  /** Called by the host's single animation clock; this module registers no clock listeners or RAF loop. */
  tick(elapsedSeconds: number, timeMs: number): void {
    if (this.disposed || !this.active || !this.state || !this.view) return;
    const animated = this.state.mode === "presentation" && this.state.layers.effects && !this.state.animationPaused && !document.hidden && !this.reducedMotion.matches;
    if (animated && elapsedSeconds - this.elapsed < 1) this.decorativeTime += Math.max(0, elapsedSeconds - this.elapsed);
    this.elapsed = elapsedSeconds;
    this.presentation.tick(elapsedSeconds, this.decorativeTime, animated, this.reducedMotion.matches);
    if (elapsedSeconds - this.lastAnchorSample > 0.4) { this.lastAnchorSample = elapsedSeconds; this.sampleDisplayAnchors(); }
    if (elapsedSeconds - this.lastLabelTime > 0.18) { this.lastLabelTime = elapsedSeconds; this.layoutLabels(); }
    const phase = this.decorativeTime;
    this.pulseColor.alpha = animated ? 0.64 + Math.sin(phase * Math.PI * 2 / tokens.motion.alertBreathingSeconds) * 0.2 : 0.92;
    this.beamColor.alpha = animated ? 0.11 + (Math.sin(phase * Math.PI * 2 / tokens.motion.pulse.periodSeconds) + 1) * 0.04 : 0;
    this.flowMaterial.phase = (phase / tokens.motion.flow.periodSeconds) % 1;
    for (const visual of this.deviceVisuals.values()) {
      const sample = this.visibleDeviceIds.has(visual.device.id) ? interpolateDevicePosition(visual.device, timeMs) : undefined;
      visual.hasPosition = !!sample;
      if (sample) { cartesian(sample, 0, visual.position); cartesian(sample, 16, visual.beamPosition); }
      visual.marker.show = visual.hasPosition && this.state.layers.markers;
      visual.beam.show = false; // Pulse/radar, base arc and one flow are the three permitted ornamental groups.
      visual.link.show = visual.hasPosition && this.state.mode === "presentation" && this.state.layers.links && visual.device.id === this.visibleDeviceIds.values().next().value;
    }
  }

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
    if (this.presentation.isSurfaceReady() && this.viewer.scene.mode === SceneMode.SCENE3D && this.viewer.scene.pickPositionSupported) {
      try {
        surfaceHeight = this.presentation.displaySurfaceHeight(location);
        if (typeof surfaceHeight === "number" && Number.isFinite(surfaceHeight)) heightSource = "loaded-depth-display-reference";
      } catch { /* Unavailable depth sampling falls back to the loaded terrain, then source height. */ }
    }
    if (typeof surfaceHeight !== "number" || !Number.isFinite(surfaceHeight)) {
      surfaceHeight = this.viewer.scene.globe.getHeight(location);
      if (typeof surfaceHeight === "number" && Number.isFinite(surfaceHeight)) heightSource = "terrain";
    }
    if (typeof surfaceHeight !== "number" || !Number.isFinite(surfaceHeight)) surfaceHeight = node.position.height;
    if (frame && (node.kind === "project" || node.kind === "section")) { Cartesian3.clone(frame.center, sphere.center); sphere.radius = frame.radius; }
    const center = Cartographic.fromCartesian(sphere.center) ?? location;
    Cartesian3.fromRadians(center.longitude, center.latitude, surfaceHeight + 2, undefined, sphere.center);
    if (this.selectedNodeId === node.id) { cartesian({ ...node.position, height: surfaceHeight }, 0.5, this.selectedPosition); this.presentation.setFocus(this.selectedPosition, this.selectedRing.show); }
    const range = frame && (node.kind === "project" || node.kind === "section") ? frame.range : Math.max(120, sphere.radius * 3.3);
    this.lastFocus = { nodeId: node.id, sourceHeight: node.position.height, surfaceHeight, heightSource, range };
    this.viewer.camera.cancelFlight();
    this.viewer.camera.flyToBoundingSphere(sphere, {
      duration: this.reducedMotion.matches ? 0 : duration,
      offset: new HeadingPitchRange(frame?.heading ?? CesiumMath.toRadians(10), frame?.pitch ?? CesiumMath.toRadians(-42.5), range),
    });
  }

  setAuthoring(active: boolean): void {
    this.authoring = active; this.presentation.setAuthoring(active);
    this.source.show = this.active && !this.earthMode && !active;
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
    return {
      active: this.active, disposed: this.disposed, dataSources: this.viewer.dataSources.contains(this.source) ? 1 : 0,
      entities: this.source.entities.values.length, nodeVisuals: this.nodeVisuals.size,
      visibleLabels: [...this.nodeVisuals.values()].filter((visual) => visual.marker.show && visual.marker.label?.show?.getValue(this.viewer.clock.currentTime)).length,
      presentation: this.presentation.debugStats(), decorativeTime: this.decorativeTime, reducedMotion: this.reducedMotion.matches,
      visibleNodeIds: [...this.nodeVisuals.values()].filter((visual) => visual.marker.show).map((visual) => visual.node.id),
      heatVisible: this.active && this.heat.show, visibleBoundaries: [...this.nodeVisuals.values()].filter((visual) => visual.boundary?.show).length,
      visibleDeviceIds: [...this.deviceVisuals.values()].filter((visual) => visual.marker.show).map((visual) => visual.device.id),
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
