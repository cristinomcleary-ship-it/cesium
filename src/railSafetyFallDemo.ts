import {
  ArcType, Cartesian2, Cartesian3, ClassificationType, Color, ColorBlendMode, ConstantPositionProperty, ConstantProperty,
  CustomDataSource, HeightReference, LabelStyle, Matrix4, PolygonGraphics, PolygonHierarchy,
  VerticalOrigin, type Entity, type Viewer,
} from 'cesium';
import { createMachineryGlb, type LoadedMachineryAsset } from './machinery/index';
import type { MachineryMetadata } from './machineryTypes';
import type { FallSupportRectangle } from './railSafetyGeometry';
import {
  computeRailSafetyFallDemoPose, prepareRailSafetyFallDemo, type PreparedRailSafetyFallDemo,
} from './railSafetyFallDemoGeometry';
import { DEFAULT_RAIL_SAFETY_DISPLAY, type RailSafetyAreaDisplay, type RailSafetyRangeEffect } from './railSafetyDisplay';
import {
  createRailSafetyFallProjectionClient, type RailSafetyFallProjectionClient, type RailSafetyFallProjectionResult,
} from './railSafetyFallProjectionClient';
import { colorRailSafetyFallProjection } from './railSafetyFallProjectionTexture';
import { createRailSafetyEffectMaterial, isRailSafetyEffectMaterialAnimated, RailSafetyEffectRenderLoop } from './railSafetyEffects';

export type RailSafetyFallDemoSnapshot = {
  active: boolean; loading: boolean; resourceId?: string; resourceName?: string;
  direction: number; actualDirection?: number; angle: number; playing: boolean; maxAngle: 90;
  error?: string; modelCreated: boolean; sourcePartCount: number; sourceTriangleCount: number; entityIds: string[];
  projectionReady: boolean; projectionBusy: boolean; projectionError?: string;
  projectionAngle?: number; projectionDirection?: number; projectionCellSizeMeters?: number; projectionAreaMeters2?: number;
  firstContactAngle?: number; belowGround?: boolean;
};
export type RailSafetyFallDemoPatch = { direction?: number; angle?: number; playing?: boolean };
export type RailSafetyFallDemoDisplay = { footprintVisible: boolean; modelVisible?: boolean; area: RailSafetyAreaDisplay; color: string; effect?: RailSafetyRangeEffect };
type Input = { resourceId: string; resourceName: string; state: MachineryMetadata; support?: FallSupportRectangle };
type Options = {
  loadAsset: (id: MachineryMetadata['assetId']) => Promise<LoadedMachineryAsset>;
  onChange?: (snapshot: RailSafetyFallDemoSnapshot) => void;
  /** Shared scene font loader; creating the copy never waits on font availability. */
  labelFont?: (text: string) => string;
  /** Injectable animation clock for deterministic lifecycle tests. */
  schedule?: (callback: (time: number) => void) => number;
  cancel?: (handle: number) => void;
  /** Injection points for lifecycle tests; production uses a dedicated mesh worker and one canvas texture. */
  createProjectionClient?: (prepared: PreparedRailSafetyFallDemo['projection']) => RailSafetyFallProjectionClient;
  createCanvas?: () => HTMLCanvasElement;
};
const fresh = (): RailSafetyFallDemoSnapshot => ({ active: false, loading: false, direction: 90, angle: 0,
  playing: false, maxAngle: 90, modelCreated: false, sourcePartCount: 0, sourceTriangleCount: 0, entityIds: [],
  projectionReady: false, projectionBusy: false });
const direction = (value: number) => ((value % 360) + 360) % 360;
const FALL_SPEED_DEGREES_PER_SECOND = 12;

/** A disposable, read-only visual copy. It does not own or update the original machinery scene. */
export class RailSafetyFallDemo {
  private snapshot = fresh();
  private source?: CustomDataSource;
  private prepared?: PreparedRailSafetyFallDemo;
  private model?: Entity;
  private pivot?: Entity;
  private footprint?: Entity;
  private display: RailSafetyFallDemoDisplay = { footprintVisible: false, modelVisible: true,
    area: { ...DEFAULT_RAIL_SAFETY_DISPLAY.envelopes }, color: DEFAULT_RAIL_SAFETY_DISPLAY.colors.envelope };
  private projectionClient?: RailSafetyFallProjectionClient;
  private projectionTask?: Promise<void>;
  private projectionRevision = 0;
  private projectionResult?: RailSafetyFallProjectionResult;
  private canvas?: HTMLCanvasElement;
  private playbackElapsed = 0;
  private lastProjectionTime = -Infinity;
  private objectUrl?: string;
  private generation = 0;
  private disposed = false;
  private frame?: number;
  private previousTime?: number;
  private lastNotificationTime = -Infinity;
  private readonly effectRenderLoop: RailSafetyEffectRenderLoop;

  constructor(private readonly viewer: Viewer, private readonly options: Options) {
    this.effectRenderLoop = new RailSafetyEffectRenderLoop({ requestRender: () => this.requestRender(), schedule: options.schedule, cancel: options.cancel });
  }

  getSnapshot(): RailSafetyFallDemoSnapshot { return structuredClone(this.snapshot); }

  async start(input: Input): Promise<boolean> {
    if (this.disposed) return false;
    this.stop(false);
    const generation = this.generation;
    const saved = structuredClone(input);
    this.snapshot = { ...fresh(), active: true, loading: true, resourceId: saved.resourceId,
      resourceName: saved.resourceName, direction: direction(saved.state.placement.heading + 90) };
    this.publish();
    const current = () => !this.disposed && generation === this.generation && this.snapshot.active;
    let stagedSource: CustomDataSource | undefined, stagedUrl: string | undefined;
    try {
      const asset = await this.options.loadAsset(saved.state.assetId);
      if (!current()) return false;
      if (asset.id !== saved.state.assetId || asset.version !== saved.state.assetVersion) throw new Error('机械模型版本不匹配，无法创建演示副本');
      const prepared = prepareRailSafetyFallDemo(asset, saved.state, saved.support);
      const buffer = createMachineryGlb(asset, saved.state.parameters, { proportional: saved.state.proportional });
      if (!current()) return false;
      stagedSource = new CustomDataSource('机械倾覆运动演示（只读副本）');
      await this.viewer.dataSources.add(stagedSource);
      if (!current()) return false;
      stagedUrl = URL.createObjectURL(new Blob([buffer], { type: 'model/gltf-binary' }));
      const prefix = `rail-safety:fall-demo:${saved.resourceId}`;
      const labelText = `运动演示副本 · ${saved.resourceName}\n非动力学预测`;
      const model = stagedSource.entities.add({ id: `${prefix}:model`, name: `倾覆运动演示副本 · ${saved.resourceName}`,
        model: { uri: stagedUrl, scale: 1, minimumPixelSize: 0, heightReference: HeightReference.NONE,
          runAnimations: false, color: Color.ORANGE.withAlpha(0.78), colorBlendMode: ColorBlendMode.MIX,
          colorBlendAmount: 0.3, silhouetteColor: Color.ORANGE, silhouetteSize: 2 },
        label: { text: labelText, font: this.options.labelFont?.(labelText) ?? '13px "Noto Sans SC", sans-serif',
          fillColor: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(0, -40), showBackground: true,
          backgroundColor: Color.fromCssColorString('#6b350a').withAlpha(0.85), disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
      const pivot = stagedSource.entities.add({ id: `${prefix}:pivot`, name: '运动演示转动支承边',
        polyline: { positions: [], width: 5, material: Color.ORANGE, clampToGround: false } });
      this.source = stagedSource; this.objectUrl = stagedUrl; this.model = model; this.pivot = pivot; this.prepared = prepared;
      stagedSource = undefined; stagedUrl = undefined;
      this.snapshot = { ...this.snapshot, loading: false, modelCreated: true,
        sourcePartCount: new Set(asset.partIds).size, sourceTriangleCount: asset.indices.length / 3,
        entityIds: this.source.entities.values.map(e => e.id) };
      this.requestPose(); this.publish();
      return true;
    } catch (error) {
      if (current()) {
        this.stop(false); this.snapshot.error = error instanceof Error ? error.message : '无法创建机械运动演示'; this.publish();
      }
      return false;
    } finally {
      if (stagedUrl) URL.revokeObjectURL(stagedUrl);
      if (stagedSource && !this.viewer.isDestroyed()) this.viewer.dataSources.remove(stagedSource, true);
    }
  }

  set(patch: RailSafetyFallDemoPatch): void {
    if (this.disposed || !this.snapshot.active || this.snapshot.loading) return;
    if (patch.direction !== undefined && Number.isFinite(patch.direction)) {
      this.snapshot.direction = direction(patch.direction); this.snapshot.playing = false;
    }
    if (patch.angle !== undefined && Number.isFinite(patch.angle)) {
      this.snapshot.angle = Math.max(0, Math.min(90, patch.angle)); this.snapshot.playing = false;
    }
    if (patch.playing !== undefined) {
      this.snapshot.playing = patch.playing;
      if (patch.playing && this.snapshot.angle >= 90) this.snapshot.angle = 0;
    }
    this.cancelFrame(); this.requestPose(); this.publish();
    if (this.snapshot.playing) this.scheduleFrame();
  }

  reset(): void { this.set({ angle: 0, playing: false }); }

  setDisplay(display: RailSafetyFallDemoDisplay): void {
    const wasVisible = this.display.footprintVisible;
    const appearanceChanged = JSON.stringify(this.display.area) !== JSON.stringify(display.area) || this.display.color !== display.color;
    const effectChanged = JSON.stringify(this.display.effect) !== JSON.stringify(display.effect);
    this.display = structuredClone({ ...display, modelVisible: display.modelVisible ?? true });
    if (wasVisible !== display.footprintVisible) this.requestPose();
    else if (appearanceChanged && this.projectionResult && display.footprintVisible && !this.snapshot.projectionError) {
      try { this.renderFootprint(this.projectionResult); }
      catch (error) { this.projectionFailed(error); }
    }
    if (effectChanged && !appearanceChanged && this.canvas && this.footprint?.polygon) {
      this.footprint.polygon.material = this.footprintMaterial(this.canvas);
    }
    this.syncVisibility(); this.requestRender();
  }

  refreshLabelFont(): void {
    const label = this.model?.label;
    if (!label || !this.options.labelFont || !this.snapshot.resourceName) return;
    const font = this.options.labelFont(`运动演示副本 · ${this.snapshot.resourceName}\n非动力学预测`);
    if (label.font?.getValue() !== font) { label.font = new ConstantProperty(font); this.requestRender(); }
  }

  stop(notify = true): void {
    this.generation++; this.cancelFrame(); this.effectRenderLoop.setActive(false);
    this.projectionRevision++; this.projectionClient?.dispose(); this.projectionClient = undefined;
    this.projectionTask = undefined; this.projectionResult = undefined;
    if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0; this.canvas = undefined; }
    if (this.source && !this.viewer.isDestroyed()) this.viewer.dataSources.remove(this.source, true);
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.source = undefined; this.objectUrl = undefined; this.model = undefined; this.pivot = undefined; this.footprint = undefined; this.prepared = undefined;
    this.snapshot = fresh(); this.requestRender();
    if (notify) this.publish();
  }

  reject(message: string): void { this.stop(false); this.snapshot.error = message; this.publish(); }

  dispose(): void { if (!this.disposed) { this.disposed = true; this.stop(false); this.effectRenderLoop.dispose(); } }

  private applyPose(directionDegrees = this.snapshot.direction, angleDegrees = this.snapshot.angle): void {
    if (!this.prepared || !this.model || !this.pivot?.polyline) return;
    const pose = computeRailSafetyFallDemoPose(this.prepared, directionDegrees, angleDegrees);
    this.model.position = new ConstantPositionProperty(pose.position);
    this.model.orientation = new ConstantProperty(pose.orientation);
    this.pivot.polyline.positions = new ConstantProperty(pose.pivot.map(p => Cartesian3.clone(p)));
    this.snapshot.actualDirection = pose.actualDirectionDegrees;
    this.requestRender();
  }

  private requestPose(): void {
    this.projectionRevision++;
    if (!this.prepared || !this.model) return;
    if (!this.display.footprintVisible) {
      this.snapshot.projectionBusy = false; this.applyPose(); this.syncVisibility(); return;
    }
    const result = this.projectionResult;
    if (result && result.direction === this.snapshot.direction && result.angle === this.snapshot.angle) {
      this.snapshot.projectionBusy = false; this.applyPose(result.direction, result.angle);
      try { this.renderFootprint(result); this.snapshot.projectionReady = true; this.snapshot.projectionError = undefined; }
      catch (error) { this.projectionFailed(error); }
      this.syncVisibility(); return;
    }
    this.snapshot.projectionBusy = true; this.snapshot.projectionError = undefined;
    this.syncVisibility(); this.queueProjection();
  }

  /** There is at most one computation in flight. Dragging replaces its pending target; no frame queue grows. */
  private queueProjection(): void {
    if (this.projectionTask || !this.prepared || !this.display.footprintVisible || !this.snapshot.active) return;
    const generation = this.generation, revision = this.projectionRevision;
    const requestedDirection = this.snapshot.direction, requestedAngle = this.snapshot.angle;
    try { this.projectionClient ??= (this.options.createProjectionClient ?? createRailSafetyFallProjectionClient)(this.prepared.projection); }
    catch (error) { this.projectionFailed(error); return; }
    const task = this.projectionClient.compute(requestedDirection, requestedAngle).then(result => {
      if (this.disposed || generation !== this.generation || revision !== this.projectionRevision || !this.display.footprintVisible) return;
      // Commit the geometry and the model pose together: the two never show different angles.
      this.renderFootprint(result);
      this.projectionResult = result;
      this.applyPose(result.direction, result.angle);
      this.snapshot.projectionReady = true; this.snapshot.projectionBusy = false;
      this.snapshot.projectionAngle = result.angle; this.snapshot.projectionDirection = result.direction;
      this.snapshot.projectionCellSizeMeters = result.cellSizeMeters; this.snapshot.projectionAreaMeters2 = result.areaMeters2;
      this.snapshot.firstContactAngle = result.firstContactAngle; this.snapshot.belowGround = result.belowGround;
      this.syncVisibility(); this.requestRender(); this.publish();
    }).catch(error => {
      if (generation === this.generation && revision === this.projectionRevision && !this.disposed) this.projectionFailed(error);
    }).finally(() => {
      if (this.projectionTask !== task) return;
      this.projectionTask = undefined;
      if (generation === this.generation && revision !== this.projectionRevision && this.display.footprintVisible && this.snapshot.projectionBusy) this.queueProjection();
    });
    this.projectionTask = task;
  }

  private projectionFailed(error: unknown): void {
    this.snapshot.projectionBusy = false; this.snapshot.projectionReady = false; this.snapshot.playing = false; this.cancelFrame();
    this.snapshot.projectionError = error instanceof Error ? error.message : '机械投影显示失败';
    this.applyPose();
    this.syncVisibility(); this.publish();
  }

  private renderFootprint(result: RailSafetyFallProjectionResult): void {
    if (!this.prepared || !this.source) return;
    const canvas = this.options.createCanvas?.() ?? (typeof document !== 'undefined' ? document.createElement('canvas') : undefined);
    if (!canvas) throw new Error('当前环境不支持机械投影画布');
    canvas.width = result.width; canvas.height = result.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('机械投影画布无法初始化');
    const pixels = context.createImageData(result.width, result.height);
    pixels.data.set(colorRailSafetyFallProjection(result, this.display.area, this.display.color));
    context.putImageData(pixels, 0, 0);
    const { xMin, xMax, yMin, yMax } = result.bounds;
    const draped = this.display.area.surface !== 'absolute';
    const positions = [[xMin, yMin], [xMax, yMin], [xMax, yMax], [xMin, yMax]].map(([x, y]) =>
      Matrix4.multiplyByPoint(this.prepared!.tangentToWorld, new Cartesian3(x, y, draped ? 0 : 0.06), new Cartesian3()));
    // Ground polygons derive UVs from the north/east bounds. Absolute polygons use explicit corresponding UVs.
    const hierarchy = new PolygonHierarchy(positions);
    const textureCoordinates = new PolygonHierarchy([new Cartesian2(0, 0), new Cartesian2(1, 0), new Cartesian2(1, 1), new Cartesian2(0, 1)] as unknown as Cartesian3[]);
    const polygon = { hierarchy, perPositionHeight: !draped, arcType: ArcType.GEODESIC,
      classificationType: this.display.area.surface === 'terrain' ? ClassificationType.TERRAIN : ClassificationType.BOTH,
      textureCoordinates: draped ? undefined : textureCoordinates,
      material: this.footprintMaterial(canvas), outline: false, zIndex: 15 };
    if (!this.footprint) this.footprint = this.source.entities.add({ id: `rail-safety:fall-demo:${this.snapshot.resourceId}:footprint`,
      name: '当前倾角机械三角面投影（显示栅格）', polygon });
    else this.footprint.polygon = new PolygonGraphics(polygon);
    // Replace canvas identity to trigger Cesium texture upload; older canvases are released with their materials.
    this.canvas = canvas;
    this.snapshot.entityIds = this.source.entities.values.map(entity => entity.id);
  }

  private footprintMaterial(canvas: HTMLCanvasElement) {
    return createRailSafetyEffectMaterial({ image: canvas, color: Color.WHITE,
      effect: this.display.effect ?? DEFAULT_RAIL_SAFETY_DISPLAY.effects.envelope });
  }

  private syncVisibility(): void {
    const poseReady = !this.display.footprintVisible || this.snapshot.projectionReady || !!this.snapshot.projectionError;
    if (this.model) this.model.show = this.display.modelVisible !== false && poseReady;
    if (this.pivot) this.pivot.show = this.display.modelVisible !== false && poseReady;
    if (this.footprint) this.footprint.show = this.display.footprintVisible && this.snapshot.projectionReady && !this.snapshot.projectionError;
    this.effectRenderLoop.setActive(!this.disposed && !!this.footprint?.show && !!this.footprint.polygon?.material && isRailSafetyEffectMaterialAnimated(this.footprint.polygon.material));
  }

  private scheduleFrame(): void {
    const generation = this.generation;
    const schedule = this.options.schedule ?? ((callback: (time: number) => void) => requestAnimationFrame(callback));
    this.frame = schedule(time => {
      this.frame = undefined;
      if (this.disposed || generation !== this.generation || !this.snapshot.playing) return;
      const elapsed = this.previousTime === undefined ? 0 : Math.min(250, Math.max(0, time - this.previousTime));
      this.previousTime = time;
      this.playbackElapsed += elapsed;
      if (!this.display.footprintVisible || (!this.projectionTask && time - this.lastProjectionTime >= 100)) {
        this.snapshot.angle = Math.min(90, this.snapshot.angle + this.playbackElapsed / 1000 * FALL_SPEED_DEGREES_PER_SECOND);
        this.playbackElapsed = 0; this.lastProjectionTime = time;
        if (this.snapshot.angle >= 90) this.snapshot.playing = false;
        this.requestPose();
      }
      if (!this.snapshot.playing || time - this.lastNotificationTime >= 100) { this.lastNotificationTime = time; this.publish(); }
      if (this.snapshot.playing) this.scheduleFrame();
    });
  }

  private cancelFrame(): void {
    if (this.frame !== undefined) (this.options.cancel ?? cancelAnimationFrame)(this.frame);
    this.frame = undefined; this.previousTime = undefined; this.playbackElapsed = 0; this.lastProjectionTime = -Infinity;
  }

  private publish(): void { try { this.options.onChange?.(this.getSnapshot()); } catch { /* A panel refresh cannot mutate a running demo. */ } }
  private requestRender(): void { if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender(); }
}
