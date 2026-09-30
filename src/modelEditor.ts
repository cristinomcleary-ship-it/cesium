import type { LibrarySettings } from "./projectLibrary";
import {
  Cartesian2,
  Cartesian3,
  Color,
  Matrix3,
  Matrix4,
  Model,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Transforms,
  type Viewer,
} from "cesium";

export type EditMode = "horizontal" | "vertical" | "rotate";

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
  private last = new Cartesian2();
  private models = new Map<string, EditableModel>();
  private onChange: ChangeCallback;
  private suspensionDepth = 0;
  private suspendedSelectionId: string | null = null;

  constructor(viewer: Viewer, onChange: ChangeCallback) {
    this.viewer = viewer;
    this.onChange = onChange;
    this.handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    this.bindMouse();
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
    this.models.delete(id);
    if (this.selected?.id === id) this.select(null);
  }

  /** Drops references to models already destroyed outside the editor. */
  pruneDestroyed() {
    let removed = 0;
    for (const [id, item] of this.models) {
      if (!item.model.isDestroyed()) continue;
      this.models.delete(id);
      if (this.selected?.id === id) this.selected = null;
      removed += 1;
    }
    if (removed) this.onChange(this.selected, this.mode);
    return removed;
  }

  select(id: string | null) {
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
    this.mode = mode;
    this.onChange(this.selected, this.mode);
  }

  reset() {
    if (!this.selected) return;
    this.selected.east = 0;
    this.selected.north = 0;
    this.selected.up = 0;
    this.selected.heading = 0;
    this.apply(this.selected);
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
    if (!this.viewer.isDestroyed()) this.viewer.scene.screenSpaceCameraController.enableInputs = true;
  }

  private apply(item: EditableModel) {
    const enu = Transforms.eastNorthUpToFixedFrame(item.center);
    const inverseEnu = Matrix4.inverseTransformation(enu, new Matrix4());
    const translation = Matrix4.fromTranslation(new Cartesian3(item.east, item.north, item.up));
    const rotation = Matrix4.fromRotationTranslation(Matrix3.fromRotationZ(item.heading));
    const localAdjustment = Matrix4.multiply(translation, rotation, new Matrix4());
    const worldAdjustment = Matrix4.multiply(enu, localAdjustment, new Matrix4());
    Matrix4.multiply(worldAdjustment, inverseEnu, worldAdjustment);
    item.model.modelMatrix = Matrix4.multiply(worldAdjustment, item.baseMatrix, new Matrix4());
    this.onChange(item, this.mode);
  }

  private metersPerPixel() {
    const height = Math.max(10, this.viewer.camera.positionCartographic.height);
    return Math.max(0.01, (height * 1.2) / Math.max(300, this.viewer.canvas.clientHeight));
  }

  private bindMouse() {
    this.handler.setInputAction((event: { position: Cartesian2 }) => {
      if (this.suspensionDepth > 0) return;
      const picked = this.viewer.scene.pick(event.position) as { id?: { engineeringModelId?: string }; primitive?: Model } | undefined;
      const pickedId = picked?.id?.engineeringModelId;
      if (pickedId && this.models.has(pickedId)) this.select(pickedId);
      if (!this.selected || (pickedId !== this.selected.id && picked?.primitive !== this.selected.model)) return;
      this.dragging = true;
      Cartesian2.clone(event.position, this.last);
      this.viewer.scene.screenSpaceCameraController.enableInputs = false;
    }, ScreenSpaceEventType.LEFT_DOWN);

    this.handler.setInputAction((event: { endPosition: Cartesian2 }) => {
      if (this.suspensionDepth > 0) return;
      if (!this.dragging || !this.selected) return;
      const dx = event.endPosition.x - this.last.x;
      const dy = event.endPosition.y - this.last.y;
      Cartesian2.clone(event.endPosition, this.last);
      const factor = this.metersPerPixel();
      if (this.mode === "horizontal") {
        this.selected.east += dx * factor;
        this.selected.north -= dy * factor;
      } else if (this.mode === "vertical") {
        this.selected.up -= dy * factor;
      } else {
        this.selected.heading -= (dx * Math.PI) / 360;
      }
      this.apply(this.selected);
    }, ScreenSpaceEventType.MOUSE_MOVE);

    this.handler.setInputAction(() => {
      this.finishDrag();
    }, ScreenSpaceEventType.LEFT_UP);
  }
}
