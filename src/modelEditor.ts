import type { LibrarySettings } from "./projectLibrary";
import {
  Cartesian2,
  Cartesian3,
  Color,
  IntersectionTests,
  Matrix3,
  Matrix4,
  Model,
  Plane,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Transforms,
  type Viewer,
} from "cesium";

export type EditMode = "horizontal" | "vertical" | "rotate";
export type ModelTransformAdjustment = { east?: number; north?: number; up?: number; heading?: number };

export type EditableModel = {
  id: string;
  name: string;
  model: Model;
  baseMatrix: Matrix4;
  center: Cartesian3;
  east: number;
  north: number;
  up: number;
  heading: number;
};

type ChangeCallback = (model: EditableModel | null, mode: EditMode) => void;

export class ModelEditor {
  private viewer: Viewer;
  private handler: ScreenSpaceEventHandler;
  private selected: EditableModel | null = null;
  private mode: EditMode = "horizontal";
  private dragging = false;
  private dragCameraInputs: boolean | null = null;
  private dragPlane: Plane | null = null;
  private destroyed = false;
  private last = new Cartesian2();
  private models = new Map<string, EditableModel>();
  private onChange: ChangeCallback;
  private suspensionDepth = 0;
  private suspendedSelectionId: string | null = null;
  private releasePointer = () => this.finishDrag();

  constructor(viewer: Viewer, onChange: ChangeCallback) {
    this.viewer = viewer;
    this.onChange = onChange;
    this.handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    this.bindMouse();
    window.addEventListener("mouseup", this.releasePointer);
    window.addEventListener("pointerup", this.releasePointer);
    window.addEventListener("blur", this.releasePointer);
  }

  add(id: string, name: string, model: Model, saved?: LibrarySettings["editor"]) {
    const editable: EditableModel = {
      id,
      name,
      model,
      baseMatrix: saved ? Matrix4.fromArray(saved.baseMatrix) : Matrix4.clone(model.modelMatrix),
      center: saved ? Cartesian3.fromArray(saved.center) : Cartesian3.clone(model.boundingSphere.center),
      east: saved?.east ?? 0,
      north: saved?.north ?? 0,
      up: saved?.up ?? 0,
      heading: saved?.heading ?? 0,
    };
    model.id = { engineeringModelId: id };
    this.models.set(id, editable);
    this.select(id);
  }

  remove(id: string) {
    if (this.selected?.id === id) this.finishDrag();
    this.models.delete(id);
    if (this.selected?.id === id) this.select(null);
  }

  /** Drops references to models already destroyed outside the editor. */
  pruneDestroyed() {
    let removed = 0;
    for (const [id, item] of this.models) {
      if (!item.model.isDestroyed()) continue;
      this.models.delete(id);
      if (this.selected?.id === id) { this.finishDrag(); this.selected = null; }
      removed += 1;
    }
    if (removed) this.onChange(this.selected, this.mode);
    return removed;
  }

  select(id: string | null) {
    if (this.selected?.id !== id) this.finishDrag();
    if (this.selected && !this.selected.model.isDestroyed()) this.selected.model.silhouetteSize = 0;
    this.selected = id ? this.models.get(id) ?? null : null;
    if (this.selected && !this.selected.model.isDestroyed()) {
      this.selected.model.silhouetteSize = this.suspensionDepth > 0 ? 0 : 2;
      this.selected.model.silhouetteColor = Color.fromCssColorString("#3bd8f4");
      if (this.suspensionDepth > 0) this.suspendedSelectionId = this.selected.id;
    } else if (this.selected?.model.isDestroyed()) {
      this.models.delete(this.selected.id);
      this.selected = null;
    }
    this.onChange(this.selected, this.mode);
  }

  setMode(mode: EditMode) {
    this.finishDrag();
    this.mode = mode;
    this.onChange(this.selected, this.mode);
  }

  reset() {
    this.setTransform({ east: 0, north: 0, up: 0, heading: 0 });
  }

  getSelected() { return this.selected; }

  /** Numeric controls and dragging use exactly the same persisted transform. */
  setTransform(values: ModelTransformAdjustment): boolean {
    if (!this.selected || this.selected.model.isDestroyed()) return false;
    const fields = ["east", "north", "up", "heading"] as const;
    if (fields.some((key) => values[key] !== undefined && !Number.isFinite(values[key]))) return false;
    this.finishDrag();
    for (const key of fields) if (values[key] !== undefined) this.selected[key] = values[key]!;
    this.apply(this.selected);
    return true;
  }

  adjustTransform(values: ModelTransformAdjustment): boolean {
    if (!this.selected) return false;
    const next: ModelTransformAdjustment = {};
    for (const key of ["east", "north", "up", "heading"] as const) if (values[key] !== undefined) next[key] = this.selected[key] + values[key]!;
    return this.setTransform(next);
  }

  /** Start a new adjustment origin after the user places an existing model again. */
  relocate(id: string, matrix: Matrix4, center: Cartesian3): boolean {
    const item = this.models.get(id);
    if (!item || item.model.isDestroyed()) return false;
    this.finishDrag();
    item.baseMatrix = Matrix4.clone(matrix);
    item.center = Cartesian3.clone(center);
    item.east = item.north = item.up = item.heading = 0;
    item.model.modelMatrix = Matrix4.clone(matrix);
    this.select(id);
    this.viewer.scene.requestRender();
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.finishDrag();
    this.destroyed = true;
    if (this.selected && !this.selected.model.isDestroyed()) this.selected.model.silhouetteSize = 0;
    if (!this.handler.isDestroyed()) this.handler.destroy();
    window.removeEventListener("mouseup", this.releasePointer);
    window.removeEventListener("pointerup", this.releasePointer);
    window.removeEventListener("blur", this.releasePointer);
    this.models.clear();
    this.selected = null;
  }

  /** Temporarily prevents model picking and dragging without changing model data. */
  suspendInteractions() {
    if (this.suspensionDepth === 0) {
      this.suspendedSelectionId = this.selected?.id ?? null;
      if (this.selected && !this.selected.model.isDestroyed()) this.selected.model.silhouetteSize = 0;
    }
    this.suspensionDepth += 1;
    this.finishDrag();
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      this.suspensionDepth = Math.max(0, this.suspensionDepth - 1);
      if (this.suspensionDepth === 0) {
        if (this.selected?.id === this.suspendedSelectionId && !this.selected.model.isDestroyed()) {
          this.selected.model.silhouetteSize = 2;
          this.selected.model.silhouetteColor = Color.fromCssColorString("#3bd8f4");
        }
        this.suspendedSelectionId = null;
      }
    };
  }

  private finishDrag() {
    this.dragging = false;
    this.dragPlane = null;
    // A global LEFT_UP must never unlock another tool's camera interaction lock.
    if (this.dragCameraInputs !== null && !this.viewer.isDestroyed()) {
      this.viewer.scene.screenSpaceCameraController.enableInputs = this.dragCameraInputs;
    }
    this.dragCameraInputs = null;
  }

  private apply(item: EditableModel) {
    if (item.model.isDestroyed()) { this.pruneDestroyed(); return; }
    const enu = Transforms.eastNorthUpToFixedFrame(item.center);
    const inverseEnu = Matrix4.inverseTransformation(enu, new Matrix4());
    const translation = Matrix4.fromTranslation(new Cartesian3(item.east, item.north, item.up));
    const rotation = Matrix4.fromRotationTranslation(Matrix3.fromRotationZ(item.heading));
    const localAdjustment = Matrix4.multiply(translation, rotation, new Matrix4());
    const worldAdjustment = Matrix4.multiply(enu, localAdjustment, new Matrix4());
    Matrix4.multiply(worldAdjustment, inverseEnu, worldAdjustment);
    item.model.modelMatrix = Matrix4.multiply(worldAdjustment, item.baseMatrix, new Matrix4());
    this.viewer.scene.requestRender();
    this.onChange(item, this.mode);
  }

  private metersPerPixel() {
    const height = Math.max(10, this.viewer.camera.positionCartographic.height);
    return Math.max(0.01, (height * 1.2) / Math.max(300, this.viewer.canvas.clientHeight));
  }

  private horizontalDelta(start: Cartesian2, end: Cartesian2): Cartesian3 | undefined {
    if (!this.selected || !this.dragPlane) return undefined;
    const startRay = this.viewer.camera.getPickRay(start);
    const endRay = this.viewer.camera.getPickRay(end);
    if (!startRay || !endRay) return undefined;
    // Almost-horizontal rays can intersect kilometres away and make a tiny mouse
    // movement fling the model out of view. Wait for a clearer viewing angle.
    if (Math.abs(Cartesian3.dot(startRay.direction, this.dragPlane.normal)) < 0.02
      || Math.abs(Cartesian3.dot(endRay.direction, this.dragPlane.normal)) < 0.02) return undefined;
    const a = IntersectionTests.rayPlane(startRay, this.dragPlane, new Cartesian3());
    const b = IntersectionTests.rayPlane(endRay, this.dragPlane, new Cartesian3());
    if (!a || !b) return undefined;
    const delta = Cartesian3.subtract(b, a, new Cartesian3());
    const inverseEnu = Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(this.selected.center), new Matrix4());
    return Matrix4.multiplyByPointAsVector(inverseEnu, delta, new Cartesian3());
  }

  private bindMouse() {
    this.handler.setInputAction((event: { position: Cartesian2 }) => {
      if (this.destroyed || this.suspensionDepth > 0) return;
      if (!this.models.size) return;
      const picked = this.viewer.scene.pick(event.position) as { id?: { engineeringModelId?: string }; primitive?: Model } | undefined;
      const pickedId = picked?.id?.engineeringModelId;
      if (pickedId && this.models.has(pickedId)) this.select(pickedId);
      if (!this.selected || (pickedId !== this.selected.id && picked?.primitive !== this.selected.model)) return;
      if (this.selected.model.isDestroyed()) { this.pruneDestroyed(); return; }
      this.dragging = true;
      Cartesian2.clone(event.position, this.last);
      this.dragCameraInputs = this.viewer.scene.screenSpaceCameraController.enableInputs;
      this.viewer.scene.screenSpaceCameraController.enableInputs = false;
      const enu = Transforms.eastNorthUpToFixedFrame(this.selected.center);
      const normal = Matrix4.multiplyByPointAsVector(enu, Cartesian3.UNIT_Z, new Cartesian3());
      const origin = Matrix4.multiplyByPoint(enu, new Cartesian3(this.selected.east, this.selected.north, this.selected.up), new Cartesian3());
      this.dragPlane = Plane.fromPointNormal(origin, normal);
    }, ScreenSpaceEventType.LEFT_DOWN);

    this.handler.setInputAction((event: { endPosition: Cartesian2 }) => {
      if (this.suspensionDepth > 0) return;
      if (!this.dragging || !this.selected) return;
      const dx = event.endPosition.x - this.last.x;
      const dy = event.endPosition.y - this.last.y;
      const factor = this.metersPerPixel();
      if (this.mode === "horizontal") {
        const delta = this.horizontalDelta(this.last, event.endPosition);
        if (delta) {
          this.selected.east += delta.x;
          this.selected.north += delta.y;
        }
      } else if (this.mode === "vertical") {
        this.selected.up -= dy * factor;
      } else {
        this.selected.heading -= (dx * Math.PI) / 360;
      }
      Cartesian2.clone(event.endPosition, this.last);
      this.apply(this.selected);
    }, ScreenSpaceEventType.MOUSE_MOVE);

    this.handler.setInputAction(() => {
      this.finishDrag();
    }, ScreenSpaceEventType.LEFT_UP);
  }
}

