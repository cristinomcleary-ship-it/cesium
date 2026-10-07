import {
  ArcType, BoundingSphere, CallbackPositionProperty, CallbackProperty, Cartesian2,
  Cartesian3, Cartographic, Cesium3DTileFeature, Color, ColorMaterialProperty, ConstantProperty,
  CustomDataSource, DistanceDisplayCondition, Entity, HeadingPitchRange,
  HeightReference, ImageMaterialProperty, LabelStyle, Math as CesiumMath, Matrix4,
  PolygonHierarchy, PolylineDashMaterialProperty, PolylineGlowMaterialProperty,
  Rectangle, SceneMode, ScreenSpaceEventHandler, ScreenSpaceEventType, Transforms,
  type Viewer,
} from "cesium";
import { interpolateDevicePosition } from "./safetyStore";
import type {
  SafetyDataset, SafetyDevice, SafetyNode, SafetyPosition, SafetySelection,
  SafetyState, SafetyView,
} from "./safetyTypes";

const CYAN = Color.fromCssColorString("#39e5ff")!;
const GOLD = Color.fromCssColorString("#ffd478")!;
const SEVERITY = {
  high: Color.fromCssColorString("#ff657c")!,
  medium: Color.fromCssColorString("#ffc06a")!,
  low: Color.fromCssColorString("#45dec1")!,
};
const MAX_LABELS = 60;
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

/** Presentation overlays only. It never modifies engineering coordinates, AR calibration or model quality. */
export class SafetySceneEffects {
  private readonly source = new CustomDataSource("施工安全大屏 · 展示覆盖层");
  private readonly handler: ScreenSpaceEventHandler;
  private readonly nodeVisuals = new Map<string, NodeVisual>();
  private readonly deviceVisuals = new Map<string, DeviceVisual>();
  private readonly visibleDeviceIds = new Set<string>();
  private readonly pickTargets = new Map<string, SafetySelection>();
  private readonly heatCanvas = document.createElement("canvas");
  private readonly scanCanvas = document.createElement("canvas");
  private readonly haloCanvas = document.createElement("canvas");
  private readonly pulseColor = CYAN.clone();
  private readonly beamColor = CYAN.withAlpha(0.16);
  private readonly selectedRing: Entity;
  private readonly scanner: Entity;
  private readonly heat: Entity;
  private readonly selectedRingPositions = new ConstantProperty([]);
  private readonly selectedPosition = new Cartesian3();
  private readonly selectedRadius = new ConstantProperty(10);
  private readonly heatImage: ImageMaterialProperty;
  private dataset?: SafetyDataset;
  private state?: SafetyState;
  private view?: SafetyView;
  private active = false;
  private disposed = false;
  private elapsed = 0;
  private scanRotation = 0;
  private dashPattern = 0xff00;
  private heatKey = "";
  private heatGeneration = 0;
  private heatHasValues = false;
  private selectedNodeId = "";
  private lastFocus?: { nodeId: string; sourceHeight: number; surfaceHeight: number; heightSource: string; range: number };
  private selectedFeature?: { feature: Cesium3DTileFeature; color: Color; nodeId: string };
  private readonly beamMaterial = new ColorMaterialProperty(new CallbackProperty(() => this.beamColor, false));

  constructor(private readonly viewer: Viewer, private readonly onSelect: (selection: SafetySelection) => void) {
    this.source.show = false;
    this.heatCanvas.width = this.heatCanvas.height = 384;
    this.scanCanvas.width = this.scanCanvas.height = 128;
    this.paintScanner();
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
    this.scanner = this.source.entities.add({
      id: "safety-selection-scan", show: false,
      position: new CallbackPositionProperty((_time, result) => Cartesian3.clone(this.selectedPosition, result), false),
      ellipse: {
        semiMajorAxis: this.selectedRadius, semiMinorAxis: this.selectedRadius,
        stRotation: new CallbackProperty(() => this.scanRotation, false),
        material: new ImageMaterialProperty({ image: this.scanCanvas, transparent: true }),
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
    for (const entity of [...this.source.entities.values]) {
      if (entity !== this.selectedRing && entity !== this.scanner && entity !== this.heat) this.source.entities.remove(entity);
    }
    this.nodeVisuals.clear();
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
        if (!validPosition(node.position)) continue;
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
      point: { pixelSize: node.kind === "pier" ? 9 : 6, color: CYAN, outlineColor: Color.fromCssColorString("#081f3a"), outlineWidth: 2, heightReference: HeightReference.CLAMP_TO_GROUND },
      label: {
        text: node.name, font: "13px sans-serif", fillColor: Color.fromCssColorString("#ddfaff"),
        outlineColor: Color.fromCssColorString("#061426"), outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(0, -21), showBackground: true, backgroundColor: Color.fromCssColorString("#061a2e")!.withAlpha(0.8),
        backgroundPadding: new Cartesian2(7, 4), heightReference: HeightReference.CLAMP_TO_GROUND,
        distanceDisplayCondition: new DistanceDisplayCondition(0, node.kind === "project" ? 2_000_000 : 30_000),
      },
    });
    this.pickTargets.set(id, { nodeId: node.id, fly: true });
    const visual: NodeVisual = { node, marker };
    const points = node.boundary?.filter(validPosition);
    if (points && points.length >= 3) {
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
          material: Color.fromCssColorString("#0d68ab")!.withAlpha(0.12),
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
      billboard: { image: this.haloCanvas, width: 70, height: 70, color: new CallbackProperty(() => this.pulseColor, false), distanceDisplayCondition: new DistanceDisplayCondition(0, 30_000) },
      point: { pixelSize: 11, color: GOLD, outlineColor: Color.fromCssColorString("#142534"), outlineWidth: 2 },
      label: { text: `${device.name} · 轨迹回放`, font: "12px sans-serif", fillColor: GOLD, outlineColor: Color.BLACK, outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cartesian2(0, -22), distanceDisplayCondition: new DistanceDisplayCondition(0, 30_000) },
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
        positions: new CallbackProperty(() => linkPositions, false), width: 2,
        arcType: ArcType.NONE,
        material: new PolylineDashMaterialProperty({ color: CYAN.withAlpha(0.7), gapColor: Color.TRANSPARENT, dashLength: 28, dashPattern: new CallbackProperty(() => this.dashPattern, false) }),
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
      && previous.mode === state.mode && previous.severity === state.severity && previous.includeDemo === state.includeDemo
      && previous.heatOpacity === state.heatOpacity && previous.timeRange[0] === state.timeRange[0] && previous.timeRange[1] === state.timeRange[1]
      && (Object.keys(state.layers) as Array<keyof SafetyState["layers"]>).every((key) => previous.layers[key] === state.layers[key])) {
      this.tick(this.elapsed, state.time);
      return;
    }
    if (this.selectedNodeId !== view.selected.id) {
      if (this.selectedFeature?.nodeId !== view.selected.id) this.restoreFeature();
      this.selectedNodeId = view.selected.id;
      cartesian(view.selected.position, 0.5, this.selectedPosition);
      const radius = Math.min(120, Math.max(5, nodeRadius(view.selected) * (view.selected.kind === "project" || view.selected.kind === "section" ? 0.22 : 1.3)));
      this.selectedRadius.setValue(radius);
      this.selectedRingPositions.setValue(circlePositions(view.selected, radius));
    }
    const alertNodeIds = new Set(view.alerts.map((alert) => alert.nodeId));
    const candidates = view.nodes.filter((node) => node.kind !== "component" || node.parentId === view.selected.id || node.id === view.selected.id || alertNodeIds.has(node.id));
    const ordered = [...candidates].sort((a, b) => Number(b.id === view.selected.id) * 2 + Number(alertNodeIds.has(b.id)) - Number(a.id === view.selected.id) * 2 - Number(alertNodeIds.has(a.id)));
    const deviceLabelIds = new Set(view.devices.slice(0, 8).map((device) => device.id));
    const labelIds = new Set(ordered.slice(0, MAX_LABELS - deviceLabelIds.size).map((node) => node.id));
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
      marker.point!.disableDepthTestDistance = new ConstantProperty(node.id === view.selected.id ? Number.POSITIVE_INFINITY : 0);
      marker.label!.disableDepthTestDistance = new ConstantProperty(node.id === view.selected.id ? Number.POSITIVE_INFINITY : 0);
      this.pickTargets.set(marker.id, { nodeId: node.id, alertId: alert?.id, fly: true });
      if (boundary) boundary.show = state.layers.boundary && visibleIds.has(node.id)
        && (node.id === view.selected.id || node.parentId === view.selected.id);
      if (plate) plate.show = state.mode === "presentation" && state.layers.boundary && node.id === view.selected.id;
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
    this.tick(this.elapsed, state.time);
    this.viewer.scene.requestRender();
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
    const nodeMap = new Map(this.dataset.nodes.map((node) => [node.id, node]));
    const weights = new Map<string, { position: SafetyPosition; count: number }>();
    for (const alert of view.alerts) {
      const node = nodeMap.get(alert.nodeId);
      if (!node || !validPosition(node.position)) continue;
      const entry = weights.get(node.id) ?? { position: node.position, count: 0 };
      entry.count += 1;
      weights.set(node.id, entry);
    }
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
      gradient.addColorStop(0, `rgba(255,91,88,${0.55 + count / maximum * 0.4})`);
      gradient.addColorStop(0.3, "rgba(255,178,72,0.65)");
      gradient.addColorStop(0.64, "rgba(39,221,197,0.35)");
      gradient.addColorStop(1, "rgba(17,131,237,0)");
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
    context.strokeStyle = "#42e4ff"; context.lineWidth = 2; context.stroke();
    context.beginPath(); context.arc(40, 40, 35, 0, Math.PI * 2);
    context.strokeStyle = "rgba(66,228,255,.4)"; context.lineWidth = 1; context.setLineDash([4, 7]); context.stroke();
  }

  private paintScanner(): void {
    const context = this.scanCanvas.getContext("2d");
    if (!context) return;
    const center = 64;
    for (let step = 0; step < 45; step += 1) {
      context.beginPath(); context.moveTo(center, center);
      context.arc(center, center, 63, step / 45 * Math.PI * 0.7, (step + 1) / 45 * Math.PI * 0.7);
      context.closePath(); context.fillStyle = `rgba(45,225,255,${step / 45 * 0.22})`; context.fill();
    }
    context.beginPath(); context.arc(center, center, 61, 0, Math.PI * 2);
    context.strokeStyle = "rgba(63,227,255,0.38)"; context.lineWidth = 1; context.stroke();
  }

  setActive(active: boolean): void {
    if (this.disposed) return;
    this.active = active;
    this.source.show = active;
    if (!active) { this.viewer.camera.cancelFlight(); this.restoreFeature(); }
    this.viewer.scene.requestRender();
  }

  private applyVisibility(): void {
    if (!this.state || !this.view) return;
    const { state } = this;
    this.selectedRing.show = state.layers.markers;
    this.scanner.show = state.mode === "presentation" && state.layers.effects;
    this.heat.show = state.layers.heat && this.heatHasValues;
  }

  /** Called by the host's single animation clock; this module registers no clock listeners or RAF loop. */
  tick(elapsedSeconds: number, timeMs: number): void {
    if (this.disposed || !this.active || !this.state || !this.view) return;
    this.elapsed = elapsedSeconds;
    const animated = this.state.mode === "presentation" && this.state.layers.effects;
    this.scanRotation = animated ? -elapsedSeconds * 0.55 : 0;
    this.pulseColor.alpha = animated ? 0.58 + Math.sin(elapsedSeconds * 2.3) * 0.22 : 0.92;
    this.beamColor.alpha = animated ? 0.11 + (Math.sin(elapsedSeconds * 2) + 1) * 0.04 : 0;
    const shift = animated ? Math.floor(elapsedSeconds * 14) % 16 : 0;
    this.dashPattern = ((0xff00 << shift) | (0xff00 >>> (16 - shift))) & 0xffff;
    for (const visual of this.deviceVisuals.values()) {
      const sample = this.visibleDeviceIds.has(visual.device.id) ? interpolateDevicePosition(visual.device, timeMs) : undefined;
      visual.hasPosition = !!sample;
      if (sample) { cartesian(sample, 0, visual.position); cartesian(sample, 16, visual.beamPosition); }
      visual.marker.show = visual.hasPosition && this.state.layers.markers;
      visual.beam.show = visual.hasPosition && animated;
      visual.link.show = visual.hasPosition && this.state.mode === "presentation" && this.state.layers.links;
    }
  }

  focus(node: SafetyNode, duration = 1.2): void {
    if (this.disposed || !validPosition(node.position)) return;
    const sphere = node.boundary?.length
      ? BoundingSphere.fromPoints(node.boundary.filter(validPosition).map((p) => cartesian(p)))
      : new BoundingSphere(cartesian(node.position), nodeRadius(node));
    sphere.radius = Math.max(sphere.radius, nodeRadius(node));
    // CAD text often has a drawing-plane Z=0 while photogrammetry sits tens of metres above it.
    // Sample only the display surface for camera framing; keep node and engineering coordinates intact.
    const location = Cartographic.fromDegrees(node.position.longitude, node.position.latitude, node.position.height);
    let surfaceHeight: number | undefined;
    let heightSource = "node";
    if (this.viewer.scene.mode === SceneMode.SCENE3D && this.viewer.scene.sampleHeightSupported) {
      try {
        surfaceHeight = this.viewer.scene.sampleHeight(location, [...this.source.entities.values]);
        if (typeof surfaceHeight === "number" && Number.isFinite(surfaceHeight)) heightSource = "loaded-surface";
      } catch { /* Unavailable depth sampling falls back to the loaded terrain, then source height. */ }
    }
    if (typeof surfaceHeight !== "number" || !Number.isFinite(surfaceHeight)) {
      surfaceHeight = this.viewer.scene.globe.getHeight(location);
      if (typeof surfaceHeight === "number" && Number.isFinite(surfaceHeight)) heightSource = "terrain";
    }
    if (typeof surfaceHeight !== "number" || !Number.isFinite(surfaceHeight)) surfaceHeight = node.position.height;
    const center = Cartographic.fromCartesian(sphere.center);
    Cartesian3.fromRadians(center.longitude, center.latitude, surfaceHeight + 2, undefined, sphere.center);
    if (this.selectedNodeId === node.id) cartesian({ ...node.position, height: surfaceHeight }, 0.5, this.selectedPosition);
    const range = Math.max(100, sphere.radius * 3.3);
    this.lastFocus = { nodeId: node.id, sourceHeight: node.position.height, surfaceHeight, heightSource, range };
    this.viewer.camera.cancelFlight();
    this.viewer.camera.flyToBoundingSphere(sphere, {
      duration,
      offset: new HeadingPitchRange(CesiumMath.toRadians(10), CesiumMath.toRadians(node.kind === "project" ? -58 : -48), range),
    });
  }

  earth(): void {
    if (this.disposed) return;
    const node = this.dataset?.nodes.find((candidate) => candidate.id === this.dataset?.projectId);
    this.viewer.camera.cancelFlight();
    this.viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(node?.position.longitude ?? 120, node?.position.latitude ?? 30, 22_000_000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 }, duration: 1.8 });
  }

  private pick(position: Cartesian2): void {
    if (!this.active || this.disposed || !this.dataset) return;
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
      visibleLabels: [...this.nodeVisuals.values()].filter((visual) => visual.marker.show).length,
      visibleNodeIds: [...this.nodeVisuals.values()].filter((visual) => visual.marker.show).map((visual) => visual.node.id),
      heatVisible: this.active && this.heat.show, visibleBoundaries: [...this.nodeVisuals.values()].filter((visual) => visual.boundary?.show).length,
      visibleDeviceIds: [...this.deviceVisuals.values()].filter((visual) => visual.marker.show).map((visual) => visual.device.id),
      actualTrackSegments: [...this.deviceVisuals.values()].reduce((sum, visual) => sum + visual.tracks.length, 0),
      deviceVisuals: this.deviceVisuals.size, actualTrackVertices: [...this.deviceVisuals.values()].reduce((sum, visual) => sum + visual.device.track.length, 0),
      ownClockListeners: 0, pickHandlers: this.disposed ? 0 : 1, heatGeneration: this.heatGeneration,
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
    this.viewer.dataSources.remove(this.source, true);
    this.source.entities.removeAll();
    this.nodeVisuals.clear(); this.deviceVisuals.clear(); this.pickTargets.clear(); this.visibleDeviceIds.clear();
    this.heatCanvas.width = this.scanCanvas.width = this.haloCanvas.width = 0;
    this.viewer.scene.requestRender();
  }
}
