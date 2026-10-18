import {
  Cartesian2, Cartesian3, HeadingPitchRoll, Matrix3, Matrix4, Quaternion,
  ScreenSpaceEventHandler, ScreenSpaceEventType, Transforms,
  type Model, type Viewer,
} from "cesium";

export type ModelPlacementBounds = { minimum: Cartesian3; maximum: Cartesian3 };

const validWorldPosition = (value: Cartesian3 | undefined): value is Cartesian3 => !!value
  && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)
  && Cartesian3.magnitude(value) > 1_000_000;

/** Pick existing model/terrain first, then the globe. Sky clicks never become (0, 0, 0). */
export function pickModelPlacementPosition(viewer: Viewer, position: Cartesian2): Cartesian3 | undefined {
  if (viewer.isDestroyed()) return undefined;
  const scene = viewer.scene;
  if (scene.pickPositionSupported) {
    try {
      const picked = scene.pickPosition(position);
      if (validWorldPosition(picked)) return Cartesian3.clone(picked);
    } catch { /* A missing depth buffer is normal on the first frame. */ }
  }
  const ray = viewer.camera.getPickRay(position);
  const ground = ray ? scene.globe?.pick(ray, scene) : undefined;
  if (validWorldPosition(ground)) return Cartesian3.clone(ground);
  const ellipsoid = viewer.camera.pickEllipsoid(position, scene.globe?.ellipsoid);
  return validWorldPosition(ellipsoid) ? Cartesian3.clone(ellipsoid) : undefined;
}

/** A safe temporary transform while Cesium prepares a newly converted local model. */
export function getPlacementPreviewPosition(viewer: Viewer): Cartesian3 {
  const canvas = viewer.scene.canvas;
  const center = pickModelPlacementPosition(viewer, new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
  if (center) return center;
  const camera = viewer.camera.positionCartographic;
  return Cartesian3.fromRadians(camera.longitude, camera.latitude, 0, viewer.scene.globe?.ellipsoid);
}

export function beginPickPlacement(viewer: Viewer, options: {
  signal?: AbortSignal;
  onInvalidPick?: () => void;
} = {}): Promise<Cartesian3> {
  return new Promise((resolve, reject) => {
    const abortError = () => new DOMException("模型放置已取消", "AbortError");
    if (options.signal?.aborted || viewer.isDestroyed()) { reject(abortError()); return; }
    const canvas = viewer.scene.canvas;
    const previousCursor = canvas.style.cursor;
    const handler = new ScreenSpaceEventHandler(canvas);
    let settled = false;
    const cleanup = () => {
      if (!handler.isDestroyed()) handler.destroy();
      canvas.style.cursor = previousCursor;
      options.signal?.removeEventListener("abort", abort);
      window.removeEventListener("keydown", keydown, true);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      abort();
    };
    handler.setInputAction((event: { position: Cartesian2 }) => {
      if (settled) return;
      const position = pickModelPlacementPosition(viewer, event.position);
      if (!position) { options.onInvalidPick?.(); return; }
      settled = true;
      cleanup();
      resolve(position);
    }, ScreenSpaceEventType.LEFT_CLICK);
    canvas.style.cursor = "crosshair";
    window.addEventListener("keydown", keydown, true);
    options.signal?.addEventListener("abort", abort, { once: true });
  });
}

type GltfNode = { children?: number[]; mesh?: number; skin?: number; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; extensions?: Record<string, unknown> };
type GltfAccessor = { min?: number[]; max?: number[]; componentType?: number; normalized?: boolean };
type GltfJson = {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { primitives?: { attributes?: { POSITION?: number }; targets?: unknown[] }[] }[];
  accessors?: GltfAccessor[];
  extensions?: { CESIUM_RTC?: { center?: number[] } };
};

function finiteArray(value: unknown, count: number): value is number[] {
  return Array.isArray(value) && value.length === count && value.every(Number.isFinite);
}

function accessorValue(value: number, accessor: GltfAccessor) {
  if (!accessor.normalized) return value;
  if (accessor.componentType === 5120) return Math.max(-1, value / 127);
  if (accessor.componentType === 5121) return value / 255;
  if (accessor.componentType === 5122) return Math.max(-1, value / 32767);
  if (accessor.componentType === 5123) return value / 65535;
  return value;
}

/** glTF Y-up/Z-forward -> Cesium Z-up/X-forward, matching Model's default axes. */
const gltfAxisCorrection = Matrix4.multiply(
  Matrix4.fromRotationTranslation(Matrix3.fromArray([1, 0, 0, 0, 0, 1, 0, -1, 0])),
  Matrix4.fromRotationTranslation(Matrix3.fromArray([0, 0, -1, 0, 1, 0, 1, 0, 0])),
  new Matrix4(),
);

/**
 * Read static GLB bounds without loading textures or decoding geometry. Accessor bounds,
 * nested node transforms and Cesium's axis conversion all participate. Unsupported or
 * incomplete bounds return null so callers can use the loaded model's sphere instead.
 */
function parseGlbPlacementBounds(buffer: ArrayBuffer, complete: boolean): ModelPlacementBounds | null {
  try {
    if (buffer.byteLength < 20) return null;
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || (complete && view.getUint32(8, true) !== buffer.byteLength)) return null;
    const jsonLength = view.getUint32(12, true);
    if (view.getUint32(16, true) !== 0x4e4f534a || jsonLength > 16 * 1024 * 1024 || jsonLength + 20 > buffer.byteLength || view.getUint32(8, true) < jsonLength + 20) return null;
    const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)).replace(/\0+$/, "")) as GltfJson;
    // Legacy RTC translations are outside the model's uniform scale. Let Cesium
    // evaluate their world-space sphere instead of treating them as mesh vertices.
    if (gltf.extensions?.CESIUM_RTC) return null;
    const nodes = gltf.nodes ?? [];
    const scene = gltf.scenes?.[gltf.scene ?? 0];
    if (!scene?.nodes?.length) return null;
    const minimum = new Cartesian3(Infinity, Infinity, Infinity);
    const maximum = new Cartesian3(-Infinity, -Infinity, -Infinity);
    let vertices = 0;
    let nodeVisits = 0;
    const visit = (index: number, parent: Matrix4, ancestors: Set<number>) => {
      if (++nodeVisits > 100_000 || ancestors.has(index)) throw new Error("Invalid scene graph");
      const node = nodes[index];
      if (!node || node.skin !== undefined || node.extensions?.EXT_mesh_gpu_instancing) throw new Error("Unsupported bounds");
      let local: Matrix4;
      if (node.matrix !== undefined) {
        if (!finiteArray(node.matrix, 16)) throw new Error("Invalid matrix");
        local = Matrix4.fromArray(node.matrix);
      } else {
        const t = node.translation ?? [0, 0, 0], r = node.rotation ?? [0, 0, 0, 1], s = node.scale ?? [1, 1, 1];
        if (!finiteArray(t, 3) || !finiteArray(r, 4) || !finiteArray(s, 3)) throw new Error("Invalid transform");
        local = Matrix4.fromTranslationQuaternionRotationScale(Cartesian3.fromArray(t), new Quaternion(r[0], r[1], r[2], r[3]), Cartesian3.fromArray(s));
      }
      const transform = Matrix4.multiply(parent, local, new Matrix4());
      if (node.mesh !== undefined) {
        const mesh = gltf.meshes?.[node.mesh];
        if (!mesh?.primitives?.length) throw new Error("Missing mesh");
        for (const primitive of mesh.primitives) {
          if (primitive.targets?.length) throw new Error("Animated bounds");
          const attribute = primitive.attributes?.POSITION;
          const accessor = attribute === undefined ? undefined : gltf.accessors?.[attribute];
          if (!accessor || !finiteArray(accessor.min, 3) || !finiteArray(accessor.max, 3)) throw new Error("Missing bounds");
          if (accessor.min.some((value, axis) => value > accessor.max![axis]!)) throw new Error("Invalid bounds");
          for (let mask = 0; mask < 8; mask++) {
            const coordinate = [0, 1, 2].map((axis) => accessorValue((mask & (1 << axis) ? accessor.max! : accessor.min!)[axis]!, accessor));
            const point = Matrix4.multiplyByPoint(transform, Cartesian3.fromArray(coordinate), new Cartesian3());
            if (![point.x, point.y, point.z].every(Number.isFinite)) throw new Error("Invalid bounds");
            Cartesian3.minimumByComponent(minimum, point, minimum);
            Cartesian3.maximumByComponent(maximum, point, maximum);
            vertices++;
          }
        }
      }
      const path = new Set(ancestors); path.add(index);
      for (const child of node.children ?? []) visit(child, transform, path);
    };
    for (const index of scene.nodes) visit(index, gltfAxisCorrection, new Set());
    return vertices ? { minimum, maximum } : null;
  } catch { return null; }
}

export function readGlbPlacementBounds(buffer: ArrayBuffer): ModelPlacementBounds | null {
  return parseGlbPlacementBounds(buffer, true);
}

function glbPrefixLength(header: ArrayBuffer): number | null {
  if (header.byteLength !== 20) return null;
  const view = new DataView(header);
  const length = view.getUint32(12, true);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(16, true) !== 0x4e4f534a
    || length > 16 * 1024 * 1024 || length + 20 > view.getUint32(8, true)) return null;
  return 20 + length;
}

/** Only read the GLB JSON prefix; never download a second copy of large mesh/texture data. */
export async function fetchGlbPlacementBounds(source: string | Blob, options: { signal?: AbortSignal } = {}): Promise<ModelPlacementBounds | null> {
  const checkAbort = () => { if (options.signal?.aborted) throw new DOMException("模型放置已取消", "AbortError"); };
  checkAbort();
  try {
    if (typeof source !== "string") {
      const header = await source.slice(0, 20).arrayBuffer();
      checkAbort();
      const length = glbPrefixLength(header);
      if (!length || length > source.size) return null;
      const prefix = await source.slice(0, length).arrayBuffer();
      checkAbort();
      return parseGlbPlacementBounds(prefix, false);
    }
    const response = await fetch(source, { signal: options.signal });
    checkAbort();
    // Non-streaming environments skip metadata rather than buffering an entire model.
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    try {
      let buffer = new Uint8Array(20);
      let offset = 0;
      let headerPending = true;
      while (true) {
        const { done, value } = await reader.read();
        checkAbort();
        if (done) return null;
        let cursor = 0;
        while (cursor < value.length) {
          const count = Math.min(buffer.length - offset, value.length - cursor);
          buffer.set(value.subarray(cursor, cursor + count), offset);
          offset += count;
          cursor += count;
          if (headerPending && offset === 20) {
            const length = glbPrefixLength(buffer.buffer);
            if (!length) return null;
            const prefix = new Uint8Array(length);
            prefix.set(buffer);
            buffer = prefix;
            headerPending = false;
          }
          if (!headerPending && offset === buffer.length) return parseGlbPlacementBounds(buffer.buffer, false);
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch (error) {
    checkAbort();
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return null;
  }
}

/** Place geometry's bottom center at the pick, cancelling arbitrary original CAD offsets. */
export function createAnchoredModelMatrix(
  model: Pick<Model, "modelMatrix" | "boundingSphere" | "scale">,
  position: Cartesian3,
  headingRadians = 0,
  bounds?: ModelPlacementBounds | null,
): Matrix4 {
  if (!validWorldPosition(position) || !Number.isFinite(headingRadians) || !Number.isFinite(model.scale) || model.scale <= 0) throw new Error("模型放置位置无效");
  let anchor: Cartesian3;
  if (bounds) {
    anchor = new Cartesian3((bounds.minimum.x + bounds.maximum.x) / 2, (bounds.minimum.y + bounds.maximum.y) / 2, bounds.minimum.z);
    Cartesian3.multiplyByScalar(anchor, model.scale, anchor);
  } else {
    // A valid ready model supplies a world-space sphere, even when its source origin
    // is many kilometres from its geometry. Centering it guarantees discoverability;
    // the editor's height input can refine models without usable static mesh bounds.
    anchor = Matrix4.multiplyByPoint(Matrix4.inverse(model.modelMatrix, new Matrix4()), model.boundingSphere.center, new Cartesian3());
  }
  if (![anchor.x, anchor.y, anchor.z].every(Number.isFinite)) throw new Error("模型几何范围无效");
  const frame = Transforms.headingPitchRollToFixedFrame(position, new HeadingPitchRoll(headingRadians, 0, 0));
  const shift = Matrix4.fromTranslation(Cartesian3.negate(anchor, new Cartesian3()));
  return Matrix4.multiply(frame, shift, new Matrix4());
}
