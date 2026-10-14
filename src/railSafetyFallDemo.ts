import {
  Cartesian2, Cartesian3, Color, ColorBlendMode, ConstantPositionProperty, ConstantProperty,
  CustomDataSource, HeightReference, LabelStyle, VerticalOrigin, type Entity, type Viewer,
} from 'cesium';
import { createMachineryGlb, type LoadedMachineryAsset } from './machinery/index';
import type { MachineryMetadata } from './machineryTypes';
import type { FallSupportRectangle } from './railSafetyGeometry';
import {
  computeRailSafetyFallDemoPose, prepareRailSafetyFallDemo, type PreparedRailSafetyFallDemo,
} from './railSafetyFallDemoGeometry';

export type RailSafetyFallDemoSnapshot = {
  active: boolean; loading: boolean; resourceId?: string; resourceName?: string;
  direction: number; actualDirection?: number; angle: number; playing: boolean; maxAngle: 90;
  error?: string; modelCreated: boolean; sourcePartCount: number; sourceTriangleCount: number; entityIds: string[];
};
export type RailSafetyFallDemoPatch = { direction?: number; angle?: number; playing?: boolean };
type Input = { resourceId: string; resourceName: string; state: MachineryMetadata; support?: FallSupportRectangle };
type Options = {
  loadAsset: (id: MachineryMetadata['assetId']) => Promise<LoadedMachineryAsset>;
  onChange?: (snapshot: RailSafetyFallDemoSnapshot) => void;
  /** Shared scene font loader; creating the copy never waits on font availability. */
  labelFont?: (text: string) => string;
  /** Injectable animation clock for deterministic lifecycle tests. */
  schedule?: (callback: (time: number) => void) => number;
  cancel?: (handle: number) => void;
};
const fresh = (): RailSafetyFallDemoSnapshot => ({ active: false, loading: false, direction: 90, angle: 0,
  playing: false, maxAngle: 90, modelCreated: false, sourcePartCount: 0, sourceTriangleCount: 0, entityIds: [] });
const direction = (value: number) => ((value % 360) + 360) % 360;
const FALL_SPEED_DEGREES_PER_SECOND = 12;

/** A disposable, read-only visual copy. It does not own or update the original machinery scene. */
export class RailSafetyFallDemo {
  private snapshot = fresh();
  private source?: CustomDataSource;
  private prepared?: PreparedRailSafetyFallDemo;
  private model?: Entity;
  private pivot?: Entity;
  private objectUrl?: string;
  private generation = 0;
  private disposed = false;
  private frame?: number;
  private previousTime?: number;
  private lastNotificationTime = -Infinity;

  constructor(private readonly viewer: Viewer, private readonly options: Options) {}

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
      this.applyPose(); this.publish();
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
    this.cancelFrame(); this.applyPose(); this.publish();
    if (this.snapshot.playing) this.scheduleFrame();
  }

  reset(): void { this.set({ angle: 0, playing: false }); }

  refreshLabelFont(): void {
    const label = this.model?.label;
    if (!label || !this.options.labelFont || !this.snapshot.resourceName) return;
    const font = this.options.labelFont(`运动演示副本 · ${this.snapshot.resourceName}\n非动力学预测`);
    if (label.font?.getValue() !== font) { label.font = new ConstantProperty(font); this.requestRender(); }
  }

  stop(notify = true): void {
    this.generation++; this.cancelFrame();
    if (this.source && !this.viewer.isDestroyed()) this.viewer.dataSources.remove(this.source, true);
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.source = undefined; this.objectUrl = undefined; this.model = undefined; this.pivot = undefined; this.prepared = undefined;
    this.snapshot = fresh(); this.requestRender();
    if (notify) this.publish();
  }

  reject(message: string): void { this.stop(false); this.snapshot.error = message; this.publish(); }

  dispose(): void { if (!this.disposed) { this.disposed = true; this.stop(false); } }

  private applyPose(): void {
    if (!this.prepared || !this.model || !this.pivot?.polyline) return;
    const pose = computeRailSafetyFallDemoPose(this.prepared, this.snapshot.direction, this.snapshot.angle);
    this.model.position = new ConstantPositionProperty(pose.position);
    this.model.orientation = new ConstantProperty(pose.orientation);
    this.pivot.polyline.positions = new ConstantProperty(pose.pivot.map(p => Cartesian3.clone(p)));
    this.snapshot.actualDirection = pose.actualDirectionDegrees;
    this.requestRender();
  }

  private scheduleFrame(): void {
    const generation = this.generation;
    const schedule = this.options.schedule ?? ((callback: (time: number) => void) => requestAnimationFrame(callback));
    this.frame = schedule(time => {
      this.frame = undefined;
      if (this.disposed || generation !== this.generation || !this.snapshot.playing) return;
      const elapsed = this.previousTime === undefined ? 0 : Math.min(250, Math.max(0, time - this.previousTime));
      this.previousTime = time;
      this.snapshot.angle = Math.min(90, this.snapshot.angle + elapsed / 1000 * FALL_SPEED_DEGREES_PER_SECOND);
      if (this.snapshot.angle >= 90) this.snapshot.playing = false;
      this.applyPose();
      if (!this.snapshot.playing || time - this.lastNotificationTime >= 100) { this.lastNotificationTime = time; this.publish(); }
      if (this.snapshot.playing) this.scheduleFrame();
    });
  }

  private cancelFrame(): void {
    if (this.frame !== undefined) (this.options.cancel ?? cancelAnimationFrame)(this.frame);
    this.frame = undefined; this.previousTime = undefined;
  }

  private publish(): void { try { this.options.onChange?.(this.getSnapshot()); } catch { /* A panel refresh cannot mutate a running demo. */ } }
  private requestRender(): void { if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender(); }
}
