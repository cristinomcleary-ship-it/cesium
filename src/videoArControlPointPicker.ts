import {
  Cartesian2, Cartesian3, Cesium3DTileFeature, Cesium3DTileset, Matrix4,
  Model, ScreenSpaceEventHandler, ScreenSpaceEventType, Transforms, type Viewer,
} from "cesium";
import { refineCameraPose, type ControlPointMatch } from "./videoArControlPoints";
import type { CameraAttitude, CameraIntrinsics, CameraVector3, LensDistortion } from "./videoArCamera";
import "./videoArControlPointPicker.css";

export type ControlPointFrame = Readonly<{
  image: CanvasImageSource;
  width: number;
  height: number;
  origin: Cartesian3;
  attitude: CameraAttitude;
  intrinsics: CameraIntrinsics;
  distortion?: LensDistortion;
  frameTime: number;
  /** A load generation or media URL, to distinguish sources at identical PTS. */
  sourceKey?: string | number;
}>;

export type PickedControlPoint = ControlPointMatch & Readonly<{ worldEcef: CameraVector3 }>;

export type ControlPointPickerResult = Readonly<{
  positionDeltaENU: CameraVector3;
  attitudeDelta: CameraAttitude;
  rmsePx: number;
  maxErrorPx: number;
  points: readonly PickedControlPoint[];
  frameTime: number;
}>;

export type ControlPointPickerCallbacks = Readonly<{
  getFrame: () => ControlPointFrame | undefined;
  /** Pause playback and hide AR geometry; called after the image is copied. */
  onStart: () => void;
  onEnd: () => void;
  onApply: (result: ControlPointPickerResult) => void | Promise<void>;
}>;

/** A local, non-persistent two-view control-point editor owned by its host. */
export class VideoArControlPointPicker {
  private readonly root = document.createElement("section");
  private readonly abort = new AbortController();
  private readonly startButton: HTMLButtonElement;
  private readonly solveButton: HTMLButtonElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly body: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly status: HTMLElement;
  private readonly list: HTMLElement;
  private readonly count: HTMLElement;
  private readonly zoom: HTMLSelectElement;
  private handler?: ScreenSpaceEventHandler;
  private frozen?: ControlPointFrame;
  private frozenImage?: HTMLCanvasElement;
  private worldToLocal?: Matrix4;
  private points: PickedControlPoint[] = [];
  private pending?: { pixelX: number; pixelY: number };
  private active = false;
  private solving = false;
  private destroyed = false;

  constructor(
    private readonly viewer: Viewer,
    host: HTMLElement,
    private readonly callbacks: ControlPointPickerCallbacks,
  ) {
    this.root.className = "video-ar-control-picker";
    this.root.innerHTML = `
      <div class="vacp-title"><strong>视频与模型同名点配准</strong><button type="button" data-action="start">冻结当前帧，开始选点</button></div>
      <p class="vacp-status" role="status" aria-live="polite">至少 4 对点，建议 6～10 对分布在画面不同区域的清晰地物。</p>
      <div class="vacp-body" hidden>
        <p class="vacp-guide">先在视频选一个清晰点，再在三维场景点击同一个位置。选择路面标线、屋角等固定地物；屋顶点必须对应屋顶。</p>
        <div class="vacp-toolbar"><span data-role="count">已配对 0 个点</span><label>图像缩放 <select data-role="zoom"><option value="1">适应</option><option value="2">2×</option><option value="4">4×</option></select></label></div>
        <div class="vacp-image-scroll"><canvas aria-label="冻结的视频画面，点击选择同名点"></canvas></div>
        <ol class="vacp-point-list" aria-label="已配对控制点"></ol>
        <div class="vacp-actions"><button type="button" data-action="undo">撤销上一点</button><button type="button" data-action="solve">求解并应用校准</button><button type="button" data-action="cancel">取消选点</button></div>
      </div>`;
    host.append(this.root);
    const find = <T extends Element>(selector: string) => {
      const element = this.root.querySelector<T>(selector);
      if (!element) throw new Error("Control-point editor element is missing: " + selector);
      return element;
    };
    this.startButton = find('[data-action="start"]');
    this.solveButton = find('[data-action="solve"]');
    this.undoButton = find('[data-action="undo"]');
    this.cancelButton = find('[data-action="cancel"]');
    this.body = find(".vacp-body");
    this.canvas = find("canvas");
    this.status = find(".vacp-status");
    this.list = find(".vacp-point-list");
    this.count = find('[data-role="count"]');
    this.zoom = find('[data-role="zoom"]');
    const options = { signal: this.abort.signal };
    this.startButton.addEventListener("click", () => this.start(), options);
    this.cancelButton.addEventListener("click", () => this.cancel(), options);
    this.undoButton.addEventListener("click", () => this.undo(), options);
    this.solveButton.addEventListener("click", () => { void this.solve(); }, options);
    this.canvas.addEventListener("click", (event) => this.pickImage(event), options);
    this.zoom.addEventListener("change", () => { this.canvas.style.width = String(Number(this.zoom.value) * 100) + "%"; }, options);
    this.render();
  }

  /** Begin a new frozen-frame session; existing pairings are discarded. */
  start() {
    if (this.destroyed || this.active || this.solving) return;
    let started = false;
    try {
      const frame = this.callbacks.getFrame();
      if (!frame) throw new Error("请先加载并暂停 DJI 视频，在需要校准的一帧开始选点。");
      if (!Number.isFinite(frame.frameTime) || !Number.isInteger(frame.width) || !Number.isInteger(frame.height)
        || frame.width <= 0 || frame.height <= 0 || frame.intrinsics.width !== frame.width || frame.intrinsics.height !== frame.height) {
        throw new Error("视频帧尺寸、时间或相机内参尚未就绪。");
      }
      const snapshot = document.createElement("canvas");
      const ratio = Math.min(1, 1920 / frame.width, 1080 / frame.height);
      snapshot.width = Math.max(1, Math.round(frame.width * ratio));
      snapshot.height = Math.max(1, Math.round(frame.height * ratio));
      const context = snapshot.getContext("2d", { alpha: false });
      if (!context) throw new Error("无法创建冻结视频画面。");
      context.drawImage(frame.image, 0, 0, snapshot.width, snapshot.height);
      this.frozenImage = snapshot;
      this.frozen = {
        ...frame, origin: Cartesian3.clone(frame.origin),
        attitude: { ...frame.attitude }, intrinsics: { ...frame.intrinsics }, distortion: { ...frame.distortion },
      };
      this.worldToLocal = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(this.frozen.origin), new Matrix4());
      this.points = [];
      this.pending = undefined;
      this.zoom.value = "1";
      this.canvas.style.width = "100%";
      this.canvas.width = snapshot.width;
      this.canvas.height = snapshot.height;
      this.active = true;
      started = true;
      this.callbacks.onStart();
      this.handler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);
      this.handler.setInputAction((event: { position: Cartesian2 }) => this.pickScene(event.position), ScreenSpaceEventType.LEFT_CLICK);
      this.message("画面已冻结。请先在视频上选择第 1 个地物点，再到三维场景选同名点。");
      this.render();
    } catch (error) {
      if (started) this.finish();
      else { this.frozen = undefined; this.frozenImage = undefined; this.worldToLocal = undefined; }
      this.message(error instanceof Error ? error.message : String(error), true);
    }
  }

  cancel() {
    if (this.destroyed) return;
    const wasActive = this.active;
    this.finish();
    if (wasActive) this.message("选点已取消，当前校准参数未改变。");
  }

  destroy() {
    if (this.destroyed) return;
    this.finish();
    this.destroyed = true;
    this.abort.abort();
    this.root.remove();
  }

  private finish() {
    const wasActive = this.active;
    this.active = false;
    this.solving = false;
    if (this.handler && !this.handler.isDestroyed()) this.handler.destroy();
    this.handler = undefined;
    this.frozen = undefined;
    this.frozenImage = undefined;
    this.worldToLocal = undefined;
    this.points = [];
    this.pending = undefined;
    // Release the large image buffer and leave no stale snapshot visible.
    this.canvas.width = 1; this.canvas.height = 1;
    this.render();
    if (wasActive) {
      try { this.callbacks.onEnd(); } catch (error) { console.warn("[Video AR] Unable to restore the projection after control-point editing", error); }
    }
  }

  private frameIsCurrent() {
    const frozen = this.frozen;
    const current = this.callbacks.getFrame();
    if (!frozen || !current) return false;
    const same = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(a), Math.abs(b));
    return frozen.sourceKey === current.sourceKey
      && frozen.width === current.width && frozen.height === current.height
      && Math.abs(frozen.frameTime - current.frameTime) <= 0.001
      && Cartesian3.distance(frozen.origin, current.origin) <= 0.001
      && (["yaw", "pitch", "roll"] as const).every((key) => same(frozen.attitude[key], current.attitude[key]))
      && (["width", "height", "fx", "fy", "cx", "cy"] as const).every((key) => same(frozen.intrinsics[key], current.intrinsics[key]))
      && (["k1", "k2", "k3", "p1", "p2"] as const).every((key) => same(frozen.distortion?.[key] ?? 0, current.distortion?.[key] ?? 0));
  }

  private requireCurrentFrame() {
    if (this.frameIsCurrent()) return true;
    this.finish();
    this.message("视频帧、数据源或相机参数已改变，已取消本次选点。请冻结新的画面后重新配对。", true);
    return false;
  }

  private pickImage(event: MouseEvent) {
    if (!this.active || this.solving || !this.requireCurrentFrame() || !this.frozen) return;
    if (this.points.length >= 30) { this.message("最多支持 30 对控制点，请求解或撤销已有点。", true); return; }
    const bounds = this.canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const u = (event.clientX - bounds.left) / bounds.width;
    const v = (event.clientY - bounds.top) / bounds.height;
    if (u < 0 || u > 1 || v < 0 || v > 1) return;
    this.pending = { pixelX: u * this.frozen.width, pixelY: v * this.frozen.height };
    this.message("视频点 " + (this.points.length + 1) + " 已选。请在三维场景点击同一地物位置。");
    this.render();
  }

  private pickScene(position: Cartesian2) {
    if (!this.active || this.solving || !this.pending || !this.requireCurrentFrame() || !this.worldToLocal) return;
    try {
      const scene = this.viewer.scene;
      const picked = scene.pick(position) as { primitive?: unknown; tileset?: unknown } | undefined;
      const modelSurface = picked instanceof Cesium3DTileFeature || picked?.primitive instanceof Cesium3DTileset
        || picked?.primitive instanceof Model || picked?.tileset instanceof Cesium3DTileset;
      let world: Cartesian3 | undefined;
      let surfaceLabel: string;
      if (modelSurface) {
        if (!scene.pickPositionSupported) throw new Error("当前设备不支持模型深度拾取，无法可靠确认这个模型点。");
        world = scene.pickPosition(position);
        if (!world) throw new Error("这个模型点没有可用深度，请稍微调整视角后重试。");
        surfaceLabel = "模型表面";
      } else {
        const ray = this.viewer.camera.getPickRay(position);
        world = ray ? scene.globe.pick(ray, scene) : undefined;
        if (!world) throw new Error("没有选中可定位的地面或模型表面，请重新点击。");
        surfaceLabel = "地面";
      }
      if (![world.x, world.y, world.z].every(Number.isFinite)) throw new Error("选中点的空间坐标无效。");
      const local = Matrix4.multiplyByPoint(this.worldToLocal, world, new Cartesian3());
      if (Cartesian3.magnitude(local) > 50_000) throw new Error("选中点距离相机超过 50 公里，请检查是否选到了错误位置。");
      this.points.push({
        ...this.pending,
        world: { x: local.x, y: local.y, z: local.z },
        worldEcef: { x: world.x, y: world.y, z: world.z },
      });
      this.pending = undefined;
      this.message("第 " + this.points.length + " 对点已匹配（" + surfaceLabel + "）。"
        + (this.points.length >= 6 ? "可继续加点，或求解并应用校准。" : "请继续选择分布在不同区域的同名点。"));
      this.render();
    } catch (error) {
      this.message(error instanceof Error ? error.message : String(error), true);
    }
  }

  private undo() {
    if (!this.active || this.solving) return;
    if (this.pending) this.pending = undefined;
    else this.points.pop();
    this.message("已撤销。请在视频上选择第 " + (this.points.length + 1) + " 个点。");
    this.render();
  }

  private async solve() {
    if (!this.active || this.solving || this.pending || this.points.length < 4 || !this.requireCurrentFrame() || !this.frozen) return;
    this.solving = true;
    this.render();
    try {
      const frozen = this.frozen;
      const result = refineCameraPose({
        initialPosition: { x: 0, y: 0, z: 0 },
        initialAttitude: frozen.attitude,
        intrinsics: frozen.intrinsics,
        distortion: frozen.distortion,
        controls: this.points,
      });
      if (!this.requireCurrentFrame()) return;
      const output: ControlPointPickerResult = {
        positionDeltaENU: { ...result.position },
        attitudeDelta: {
          yaw: result.attitude.yaw - frozen.attitude.yaw,
          pitch: result.attitude.pitch - frozen.attitude.pitch,
          roll: result.attitude.roll - frozen.attitude.roll,
        },
        rmsePx: result.rmsePx,
        maxErrorPx: result.maxErrorPx,
        points: this.points.map((point) => ({ ...point, world: { ...point.world }, worldEcef: { ...point.worldEcef } })),
        frameTime: frozen.frameTime,
      };
      await this.callbacks.onApply(output);
      if (this.destroyed) return;
      this.finish();
      this.message("校准已应用：" + output.points.length + " 对点，重投影 RMS " + output.rmsePx.toFixed(2)
        + " 像素，最大误差 " + output.maxErrorPx.toFixed(2) + " 像素。");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = /collinear|clustered|coincident/.test(detail)
        ? "控制点过于集中或接近一条直线，请在画面四周补充点。"
        : /behind|visibility/.test(detail)
          ? "控制点与当前相机方向不符，请检查模型同名点及初始相机位置。"
          : /fit failed/.test(detail)
            ? "控制点未达到可用精度。请撤销错误匹配，核对屋顶与地面高度后重试。 " + detail
            : "校准未应用：" + detail;
      this.message(message, true);
      this.solving = false;
      this.render();
    }
  }

  private message(text: string, error = false) {
    this.status.textContent = text;
    this.status.classList.toggle("vacp-error", error);
  }

  private render() {
    this.body.hidden = !this.active;
    this.startButton.disabled = this.active || this.solving || this.destroyed;
    this.solveButton.disabled = !this.active || this.solving || this.points.length < 4 || Boolean(this.pending);
    this.undoButton.disabled = !this.active || this.solving || (!this.points.length && !this.pending);
    this.cancelButton.disabled = this.solving;
    this.zoom.disabled = this.solving;
    this.count.textContent = "已配对 " + this.points.length + " 个点" + (this.pending ? " · 等待地图对应点" : "");
    this.list.replaceChildren();
    for (let index = 0; index < this.points.length; index += 1) {
      const point = this.points[index];
      const item = document.createElement("li");
      item.textContent = (index + 1) + "：视频 (" + point.pixelX.toFixed(0) + ", " + point.pixelY.toFixed(0)
        + ") → 场景 E " + point.world.x.toFixed(1) + " / N " + point.world.y.toFixed(1) + " / U " + point.world.z.toFixed(1) + " m";
      this.list.append(item);
    }
    if (!this.active || !this.frozen || !this.frozenImage) return;
    const context = this.canvas.getContext("2d");
    if (!context) return;
    context.drawImage(this.frozenImage, 0, 0);
    const draw = (point: { pixelX: number; pixelY: number }, number: number, pending: boolean) => {
      const x = point.pixelX / this.frozen!.width * this.canvas.width;
      const y = point.pixelY / this.frozen!.height * this.canvas.height;
      const radius = Math.max(5, this.canvas.width / 160);
      context.beginPath(); context.arc(x, y, radius, 0, 2 * Math.PI);
      context.fillStyle = pending ? "#ffcc3d" : "#28dfb1"; context.fill();
      context.lineWidth = Math.max(1, radius / 4); context.strokeStyle = "#13202e"; context.stroke();
      context.font = "bold " + Math.max(13, radius * 1.8) + "px sans-serif";
      context.lineWidth = 3; context.strokeStyle = "#13202e"; context.fillStyle = "#ffffff";
      context.strokeText(String(number), x + radius + 3, y - radius - 2);
      context.fillText(String(number), x + radius + 3, y - radius - 2);
    };
    this.points.forEach((point, index) => draw(point, index + 1, false));
    if (this.pending) draw(this.pending, this.points.length + 1, true);
  }
}
