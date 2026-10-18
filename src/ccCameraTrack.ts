/**
 * ContextCapture BlocksExchange camera import and video-time sampling.
 *
 * References: Bentley ContextCapture Help v18, BlocksExchange XML/XMLZ format,
 * GUID-59E6CC36-F349-4DE0-A563-FFC47296A624; Perspective camera model,
 * GUID-2D452A8A-A4FE-450D-A0CA-9336DCF1238A (including the YPR/Brown formulas).
 * R maps world axes to optical camera axes (right, down, forward). For supported
 * geographic SRS, attitude axes are the local east/north/up frame at the photo.
 * No video timestamp is inferred from a filename. For the supported geographic
 * systems, heights follow CC's documented ellipsoidal-height export convention;
 * this does not mean EPSG:4326 itself defines a vertical coordinate system.
 */
export type CcVector3 = Readonly<{ x: number; y: number; z: number }>;
export type CcQuaternion = Readonly<{ x: number; y: number; z: number; w: number }>;
export type CcIntrinsics = Readonly<{
  width: number; height: number; fx: number; fy: number; cx: number; cy: number;
  /** Focal matrix upper-right entry, in pixels. */
  skew: number;
}>;
/** Brown coefficients normalized to OpenCV convention, NOT the raw CC P1/P2. */
export type CcDistortion = Readonly<{ k1: number; k2: number; k3: number; p1: number; p2: number }>;
export type CcReferenceSystem = Readonly<{
  id: string; name: string; definition: string; epsg: 4326 | 4979;
  /** CC export convention; EPSG:4326 by itself remains a two-dimensional CRS. */
  heightReference: 'ellipsoid';
}>;
export type CcPhotogroup = Readonly<{
  id: string; name: string; referenceSystem: CcReferenceSystem;
  intrinsics: CcIntrinsics; distortion: CcDistortion;
}>;
export type CcPhoto = Readonly<{
  id: string; imagePath: string; filename: string; filenameNumber: number | null;
  photogroupId: string; longitude: number; latitude: number; height: number;
  /** Row-major, world ENU to canonical optical camera. */
  worldToCamera: readonly number[];
}>;
export type CcCameraDataset = Readonly<{
  name: string; photogroups: readonly CcPhotogroup[]; photos: readonly CcPhoto[];
  warnings: readonly string[];
}>;
export type CcTrackOptions = Readonly<{
  firstTimeSeconds: number;
  /** Time per XML photo (ordinal), or per filenameStep (filename-number). */
  intervalSeconds: number;
  mode: 'ordinal' | 'filename-number';
  /** Required in filename-number mode; provided by the operator, never inferred. */
  filenameStep?: number;
  heightReference: 'ellipsoid' | 'offset-to-ellipsoid';
  /** h_ellipsoid = z_XML + offset, in metres. Required for offset-to-ellipsoid. */
  heightOffsetMeters?: number;
}>;
export type CcCameraKeyframe = Readonly<{
  time: number; photoId: string; filename: string;
  position: CcVector3; orientation: CcQuaternion;
}>;
export type CcCameraSample = Readonly<{
  time: number; position: CcVector3; direction: CcVector3; up: CcVector3;
  orientation: CcQuaternion; intrinsics: CcIntrinsics; distortion: CcDistortion;
  fromPhotoId: string; toPhotoId: string; interpolation: number;
}>;
export type CcCameraTrack = Readonly<{
  startTime: number; endTime: number; keyframes: readonly CcCameraKeyframe[];
  intrinsics: CcIntrinsics; distortion: CcDistortion; warnings: readonly string[];
  /** No extrapolation: outside the solved time span the overlay must be hidden. */
  sample(time: number): CcCameraSample | null;
}>;

const radians = (degrees: number) => degrees * Math.PI / 180;
const finite = (value: number, label: string) => {
  if (!Number.isFinite(value)) throw new Error(`${label}必须是有限数值`);
  return value;
};
const positive = (value: number, label: string) => {
  finite(value, label);
  if (value <= 0) throw new Error(`${label}必须大于 0`);
  return value;
};

export function validateCcIntrinsics(value: CcIntrinsics): CcIntrinsics {
  for (const key of ['width', 'height', 'fx', 'fy', 'cx', 'cy', 'skew'] as const) finite(value[key], `相机参数 ${key}`);
  if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)) {
    throw new Error('影像宽高必须是整数');
  }
  positive(value.width, '影像宽度'); positive(value.height, '影像高度');
  positive(value.fx, 'fx'); positive(value.fy, 'fy');
  return value;
}

export function validateCcRotation(matrix: readonly number[]): readonly number[] {
  if (matrix.length !== 9 || !matrix.every(Number.isFinite)) throw new Error('相机旋转矩阵必须包含 9 个有限数值');
  for (let row = 0; row < 3; row++) {
    for (let other = 0; other < 3; other++) {
      let dot = 0;
      for (let column = 0; column < 3; column++) dot += matrix[row * 3 + column] * matrix[other * 3 + column];
      if (Math.abs(dot - (row === other ? 1 : 0)) > 1e-5) throw new Error('相机旋转矩阵不正交');
    }
  }
  const m = matrix;
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (Math.abs(det - 1) > 1e-5) throw new Error('相机旋转矩阵包含镜像或无效旋转');
  return matrix;
}

/** Bentley's explicit Yaw/Pitch/Roll formula, degrees, XRightYDown. */
export function ccYawPitchRollToWorldToCamera(yaw: number, pitch: number, roll: number): readonly number[] {
  const y = radians(finite(yaw, 'Yaw')), p = radians(finite(pitch, 'Pitch')), r = radians(finite(roll, 'Roll'));
  const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p), cr = Math.cos(r), sr = Math.sin(r);
  return [
    cr * cy - sr * sp * sy, -cr * sy - cy * sr * sp, cp * sr,
    cy * sr + cr * sp * sy, cr * cy * sp - sr * sy, -cr * cp,
    cp * sy, cp * cy, sp,
  ];
}

function children(parent: Element, name: string): Element[] {
  return Array.from(parent.children).filter(child => child.localName === name);
}
function child(parent: Element, name: string, required = false): Element | undefined {
  const matches = children(parent, name);
  if (matches.length > 1) throw new Error(`${parent.localName}/${name}重复，无法确定有效参数`);
  if (required && !matches.length) throw new Error(`缺少 ${parent.localName}/${name}`);
  return matches[0];
}
function value(parent: Element, name: string, required = false): string | undefined {
  const text = child(parent, name, required)?.textContent?.trim();
  if (required && !text) throw new Error(`${parent.localName}/${name}为空`);
  return text || undefined;
}
function numberValue(parent: Element, name: string, fallback?: number): number {
  const raw = value(parent, name, fallback === undefined);
  return raw === undefined ? fallback! : finite(Number(raw), `${parent.localName}/${name}`);
}

export function parseCcCameraXml(xml: string): CcCameraDataset {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('不支持含 DTD 或外部实体的 XML');
  if (typeof DOMParser === 'undefined') throw new Error('XML 解析需要浏览器 DOMParser');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.getElementsByTagName('parsererror').length || document.documentElement.localName === 'parsererror') {
    throw new Error('CC XML 格式错误，无法读取');
  }
  return parseCcCameraDocument(document);
}

/** Kept separate so XML parsing can be exercised with a real browser DOM. */
export function parseCcCameraDocument(document: Document): CcCameraDataset {
  const root = document.documentElement;
  if (root.localName !== 'BlocksExchange') throw new Error('请选择 CC 导出的 BlocksExchange XML');
  const blocks = children(root, 'Block');
  if (blocks.length !== 1) throw new Error('请从 CC 单独导出一个视频对应的 Block');
  const block = blocks[0], srsNodes = children(child(root, 'SpatialReferenceSystems', true)!, 'SRS');
  const systems = new Map<string, CcReferenceSystem>();
  for (const node of srsNodes) {
    const id = value(node, 'Id', true)!, definition = value(node, 'Definition', true)!;
    if (systems.has(id)) throw new Error(`空间参考系 Id ${id}重复`);
    const match = /^EPSG\s*:\s*(4326|4979)$/i.exec(definition);
    // Unsupported unused definitions are harmless; an active one is rejected below.
    if (!match) continue;
    const epsg = Number(match[1]) as 4326 | 4979;
    // Bentley CC's default for geographic/projected SRS is the datum's ellipsoid;
    // an overridden vertical coordinate system creates a new user-defined SRS.
    // This is a CC export convention, not an extra axis defined by EPSG:4326.
    // https://docs.bentley.com/LiveContent/web/ContextCapture%20Help-v18/en/GUID-B6BA56E7-6124-4D90-9D00-D8A2FE7ACE20.html
    systems.set(id, { id, name: value(node, 'Name') ?? definition, definition, epsg, heightReference: 'ellipsoid' });
  }
  const blockSrsId = value(block, 'SRSId');
  const groups = children(child(block, 'Photogroups', true)!, 'Photogroup');
  if (!groups.length) throw new Error('CC XML 没有 Photogroup');
  const photogroups: CcPhotogroup[] = [], photos: CcPhoto[] = [], warnings: string[] = [];
  const ids = new Set<string>(), filenames = new Set<string>();
  for (const [index, node] of groups.entries()) {
    const id = String(index), srsId = value(node, 'SRSId') ?? blockSrsId;
    const referenceSystem = srsId === undefined ? undefined : systems.get(srsId);
    if (!referenceSystem) throw new Error('当前支持 EPSG:4326 / EPSG:4979。请在 CC 导出时使用这两种参考系，并明确高程基准');
    if ((value(node, 'CameraModelType') ?? 'Perspective') !== 'Perspective') throw new Error('当前融合仅支持 Perspective 相机，不支持鱼眼相机');
    if ((value(node, 'CameraOrientation') ?? 'XRightYDown') !== 'XRightYDown') throw new Error('请在 CC 使用 XRightYDown 相机方向导出');
    const dimensions = child(node, 'ImageDimensions', true)!;
    const width = numberValue(dimensions, 'Width'), height = numberValue(dimensions, 'Height');
    const focalPixels = value(node, 'FocalLengthPixels');
    let f: number, pixelSize: number | undefined;
    if (value(node, 'PixelSize')) pixelSize = positive(numberValue(node, 'PixelSize'), '像元尺寸');
    else if (value(node, 'SensorSize')) pixelSize = positive(numberValue(node, 'SensorSize'), '传感器尺寸') / Math.max(width, height);
    if (focalPixels !== undefined) f = positive(Number(focalPixels), '像素焦距');
    else {
      if (pixelSize === undefined) throw new Error('缺少像素焦距，或用于换算的 SensorSize / PixelSize');
      f = positive(numberValue(node, 'FocalLength'), '焦距') / pixelSize;
    }
    const principal = child(node, 'PrincipalPoint');
    let cx = (width - 1) / 2, cy = (height - 1) / 2;
    if (principal) {
      if (value(principal, 'x') !== undefined || value(principal, 'y') !== undefined) {
        cx = numberValue(principal, 'x'); cy = numberValue(principal, 'y');
      } else {
        if (pixelSize === undefined) throw new Error('毫米主点参数需要 PixelSize 或 SensorSize');
        cx += numberValue(principal, 'xmm') / pixelSize; cy += numberValue(principal, 'ymm') / pixelSize;
      }
    }
    const intrinsics = validateCcIntrinsics({ width, height, fx: f, fy: f * positive(numberValue(node, 'AspectRatio', 1), '像素宽高比'), cx, cy, skew: numberValue(node, 'Skew', 0) });
    const lens = child(node, 'Distortion');
    // Bentley: Dx += 2*P2*x*y + P1*(r²+2*x²); OpenCV reverses P1/P2.
    const distortion: CcDistortion = lens ? {
      k1: numberValue(lens, 'K1', 0), k2: numberValue(lens, 'K2', 0), k3: numberValue(lens, 'K3', 0),
      p1: numberValue(lens, 'P2', 0), p2: numberValue(lens, 'P1', 0),
    } : { k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 };
    photogroups.push({ id, name: value(node, 'Name') ?? `相机组 ${index + 1}`, referenceSystem, intrinsics, distortion });
    for (const photo of children(node, 'Photo')) {
      const photoId = value(photo, 'Id', true)!, imagePath = value(photo, 'ImagePath', true)!;
      const filename = imagePath.split(/[\\/]/).pop()!;
      if (ids.has(photoId)) throw new Error(`影像 Id ${photoId}重复`);
      if (filenames.has(filename)) throw new Error(`影像文件名 ${filename}重复，无法对应视频时间`);
      ids.add(photoId); filenames.add(filename);
      if (value(photo, 'Component') !== undefined && numberValue(photo, 'Component') !== 1) throw new Error(`影像 ${filename}不属于空三主分量，请重新导出已连接且成功定向的照片`);
      // Intentionally direct-child traversal only: Pose/Metadata contains original
      // navigation values and must never replace optimized Pose/Center/Rotation.
      const pose = child(photo, 'Pose', true)!, center = child(pose, 'Center', true)!, rotation = child(pose, 'Rotation', true)!;
      const longitude = numberValue(center, 'x'), latitude = numberValue(center, 'y'), heightValue = numberValue(center, 'z');
      if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90) throw new Error(`影像 ${filename}经纬度超出范围`);
      let worldToCamera: readonly number[];
      if (value(rotation, 'M_00') !== undefined) {
        worldToCamera = Array.from({ length: 9 }, (_, i) => numberValue(rotation, `M_${Math.floor(i / 3)}${i % 3}`));
      } else if (value(rotation, 'Yaw') !== undefined) {
        worldToCamera = ccYawPitchRollToWorldToCamera(numberValue(rotation, 'Yaw'), numberValue(rotation, 'Pitch'), numberValue(rotation, 'Roll'));
      } else throw new Error(`影像 ${filename}缺少支持的旋转表示，请从 CC 导出 Yaw/Pitch/Roll 或 M_ij 矩阵`);
      validateCcRotation(worldToCamera);
      const numeric = /(?:^|[^\d])(\d+)(?=\.[^.]+$)/.exec(filename);
      const filenameNumber = numeric ? Number(numeric[1]) : null;
      if (filenameNumber !== null && !Number.isSafeInteger(filenameNumber)) throw new Error(`影像 ${filename}的编号过大`);
      photos.push({ id: photoId, imagePath, filename, filenameNumber, photogroupId: id, longitude, latitude, height: heightValue, worldToCamera });
    }
  }
  if (!photos.length) throw new Error('CC XML 没有包含完整空三位姿的照片');
  warnings.push('XML 不含可靠的视频时间；请按实际抽帧规则关联，轨迹范围以外不显示叠加。');
  return { name: value(block, 'Name') ?? 'CC 空三', photogroups, photos, warnings };
}

export function mapCcPhotoTimes(photos: readonly CcPhoto[], options: Pick<CcTrackOptions, 'firstTimeSeconds' | 'intervalSeconds' | 'mode' | 'filenameStep'>): readonly Readonly<{ photo: CcPhoto; time: number }>[] {
  finite(options.firstTimeSeconds, '首张照片视频时间');
  if (options.firstTimeSeconds < 0) throw new Error('首张照片视频时间不能小于 0');
  positive(options.intervalSeconds, '抽帧间隔');
  if (!photos.length) throw new Error('没有可关联的照片');
  if (options.mode === 'ordinal') return photos.map((photo, i) => ({ photo, time: finite(options.firstTimeSeconds + i * options.intervalSeconds, '照片时间') }));
  if (options.mode !== 'filename-number') throw new Error('请选择按导出顺序或按文件编号关联');
  const step = positive(options.filenameStep ?? NaN, '文件编号步长');
  if (!Number.isSafeInteger(step)) throw new Error('文件编号步长必须是正整数');
  if (photos.some(photo => photo.filenameNumber === null || !Number.isSafeInteger(photo.filenameNumber))) throw new Error('按编号关联需要每个文件名末尾都有数字编号');
  const sorted = [...photos].sort((a, b) => a.filenameNumber! - b.filenameNumber!);
  const first = sorted[0].filenameNumber!;
  const used = new Set<number>();
  return sorted.map(photo => {
    const number = photo.filenameNumber!;
    if (used.has(number)) throw new Error(`文件编号 ${number}重复，无法关联唯一时间`);
    used.add(number);
    if ((number - first) % step !== 0) throw new Error(`文件 ${photo.filename}的编号与所填步长不一致`);
    return { photo, time: finite(options.firstTimeSeconds + (number - first) / step * options.intervalSeconds, '照片时间') };
  });
}

/** WGS84 geodetic degrees + explicitly resolved ellipsoid metres -> ECEF metres. */
export function ccGeodeticToEcef(longitude: number, latitude: number, ellipsoidHeight: number): CcVector3 {
  finite(longitude, '经度'); finite(latitude, '纬度'); finite(ellipsoidHeight, '椭球高');
  if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90) throw new Error('经纬度超出范围');
  const lon = radians(longitude), lat = radians(latitude), sin = Math.sin(lat), cos = Math.cos(lat);
  const e2 = 6.6943799901413165e-3, n = 6378137 / Math.sqrt(1 - e2 * sin * sin);
  return { x: (n + ellipsoidHeight) * cos * Math.cos(lon), y: (n + ellipsoidHeight) * cos * Math.sin(lon), z: (n * (1 - e2) + ellipsoidHeight) * sin };
}

function enuToEcef(vector: CcVector3, longitude: number, latitude: number): CcVector3 {
  const lon = radians(longitude), lat = radians(latitude), sl = Math.sin(lon), cl = Math.cos(lon), sp = Math.sin(lat), cp = Math.cos(lat);
  return { x: -sl * vector.x - sp * cl * vector.y + cp * cl * vector.z, y: cl * vector.x - sp * sl * vector.y + cp * sl * vector.z, z: cp * vector.y + sp * vector.z };
}

function normalizeQuaternion(q: CcQuaternion): CcQuaternion {
  const magnitude = Math.hypot(q.x, q.y, q.z, q.w);
  if (!Number.isFinite(magnitude) || magnitude < 1e-12) throw new Error('相机四元数无效');
  return { x: q.x / magnitude, y: q.y / magnitude, z: q.z / magnitude, w: q.w / magnitude };
}

function quaternionFromColumns(x: CcVector3, y: CcVector3, z: CcVector3): CcQuaternion {
  const m = [x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z], trace = m[0] + m[4] + m[8];
  let q: CcQuaternion;
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1); q = { w: s / 4, x: (m[7] - m[5]) / s, y: (m[2] - m[6]) / s, z: (m[3] - m[1]) / s };
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = 2 * Math.sqrt(1 + m[0] - m[4] - m[8]); q = { w: (m[7] - m[5]) / s, x: s / 4, y: (m[1] + m[3]) / s, z: (m[2] + m[6]) / s };
  } else if (m[4] > m[8]) {
    const s = 2 * Math.sqrt(1 + m[4] - m[0] - m[8]); q = { w: (m[2] - m[6]) / s, x: (m[1] + m[3]) / s, y: s / 4, z: (m[5] + m[7]) / s };
  } else {
    const s = 2 * Math.sqrt(1 + m[8] - m[0] - m[4]); q = { w: (m[3] - m[1]) / s, x: (m[2] + m[6]) / s, y: (m[5] + m[7]) / s, z: s / 4 };
  }
  return normalizeQuaternion(q);
}

export function ccSlerp(a: CcQuaternion, b: CcQuaternion, t: number): CcQuaternion {
  finite(t, '插值比例');
  if (t < 0 || t > 1) throw new Error('插值比例必须在 0 到 1 之间');
  const start = normalizeQuaternion(a); let end = normalizeQuaternion(b);
  let dot = start.x * end.x + start.y * end.y + start.z * end.z + start.w * end.w;
  if (dot < 0) { end = { x: -end.x, y: -end.y, z: -end.z, w: -end.w }; dot = -dot; }
  let left = 1 - t, right = t;
  if (dot < 0.9995) {
    const angle = Math.acos(Math.min(1, dot)), sine = Math.sin(angle);
    left = Math.sin((1 - t) * angle) / sine; right = Math.sin(t * angle) / sine;
  }
  return normalizeQuaternion({ x: left * start.x + right * end.x, y: left * start.y + right * end.y, z: left * start.z + right * end.z, w: left * start.w + right * end.w });
}

function rotate(q: CcQuaternion, v: CcVector3): CcVector3 {
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
  return { x: v.x + q.w * tx + q.y * tz - q.z * ty, y: v.y + q.w * ty + q.z * tx - q.x * tz, z: v.z + q.w * tz + q.x * ty - q.y * tx };
}

export function createCcCameraTrack(dataset: CcCameraDataset, options: CcTrackOptions): CcCameraTrack {
  if (dataset.photogroups.length !== 1) throw new Error('当前一次融合支持一个相机组，请从 CC 分组导出');
  const group = dataset.photogroups[0];
  validateCcIntrinsics(group.intrinsics);
  for (const coefficient of Object.values(group.distortion)) finite(coefficient, '畸变系数');
  if (options.heightReference !== 'ellipsoid' && options.heightReference !== 'offset-to-ellipsoid') throw new Error('请选择高度处理方式：使用 CC 原始椭球高，或经核实后添加高程改正量');
  const offset = options.heightReference === 'offset-to-ellipsoid' ? finite(options.heightOffsetMeters ?? NaN, '高程改正量') : 0;
  if (group.referenceSystem.epsg === 4979 && offset !== 0) throw new Error('EPSG:4979 已定义为椭球高，请勿重复添加垂直基准改正');
  if (group.referenceSystem.epsg !== 4326 && group.referenceSystem.epsg !== 4979) throw new Error('不支持该空间参考系');
  const keyframes = mapCcPhotoTimes(dataset.photos, options).map(({ photo, time }) => {
    if (photo.photogroupId !== group.id) throw new Error(`影像 ${photo.filename}引用了其他相机组`);
    const m = validateCcRotation(photo.worldToCamera);
    const right = enuToEcef({ x: m[0], y: m[1], z: m[2] }, photo.longitude, photo.latitude);
    const down = enuToEcef({ x: m[3], y: m[4], z: m[5] }, photo.longitude, photo.latitude);
    const forward = enuToEcef({ x: m[6], y: m[7], z: m[8] }, photo.longitude, photo.latitude);
    return { time, photoId: photo.id, filename: photo.filename, position: ccGeodeticToEcef(photo.longitude, photo.latitude, photo.height + offset), orientation: quaternionFromColumns(right, down, forward) };
  });
  const startTime = keyframes[0].time, endTime = keyframes[keyframes.length - 1].time;
  const warnings = [...dataset.warnings];
  if (options.mode === 'ordinal') warnings.push('按 XML 顺序分配等间隔时间：仅适用于照片未缺失且导出顺序与抽帧顺序一致的情况。');
  return {
    startTime, endTime, keyframes, intrinsics: group.intrinsics, distortion: group.distortion, warnings,
    sample(time: number): CcCameraSample | null {
      if (!Number.isFinite(time) || time < startTime || time > endTime) return null;
      let low = 0, high = keyframes.length - 1;
      while (low < high) { const mid = Math.floor((low + high) / 2); if (keyframes[mid].time < time) low = mid + 1; else high = mid; }
      const next = keyframes[low], previous = keyframes[Math.max(0, low - 1)];
      const t = next.time === previous.time ? 0 : (time - previous.time) / (next.time - previous.time);
      const orientation = ccSlerp(previous.orientation, next.orientation, t);
      const position = { x: previous.position.x + (next.position.x - previous.position.x) * t, y: previous.position.y + (next.position.y - previous.position.y) * t, z: previous.position.z + (next.position.z - previous.position.z) * t };
      return { time, position, orientation, direction: rotate(orientation, { x: 0, y: 0, z: 1 }), up: rotate(orientation, { x: 0, y: -1, z: 0 }), intrinsics: group.intrinsics, distortion: group.distortion, fromPhotoId: previous.photoId, toPhotoId: next.photoId, interpolation: t };
    },
  };
}
