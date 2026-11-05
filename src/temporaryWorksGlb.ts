import { Cartesian3, Cartographic, Math as CesiumMath, Matrix3, Matrix4, Transforms } from 'cesium';

export type TemporaryWorksGlbResourceId = 'camp' | 'steel' | 'wall';
export type TemporaryWorksGlbDimensions = { length: number; width: number; height: number };
export type TemporaryWorksGlbPlacement = {
  longitude: number; latitude: number; height: number;
  /** Plan rotation in degrees, counterclockwise from east towards north. */
  headingDeg: number; scaleMode: 'uniform' | 'xyz'; dimensions: TemporaryWorksGlbDimensions;
};
export type TemporaryWorksGlbConfig = {
  resourceId: TemporaryWorksGlbResourceId;
  placement: TemporaryWorksGlbPlacement;
  clippingEnabled: boolean;
  branding?: { text?: string; logoUrl?: string; visible?: boolean };
};
export type TemporaryWorksGlbResource = {
  id: TemporaryWorksGlbResourceId; name: string; url: string; upAxis: 'Y' | 'Z';
  bounds: { min: [number, number, number]; max: [number, number, number] };
  anchor: [number, number, number]; dimensions: TemporaryWorksGlbDimensions;
  /** Source scene coordinates: [x,z] for Y-up, [x,y] for Z-up. */
  footprints: { outer: [number, number][]; holes?: [number, number][][] }[];
  sourceSha256?: string;
  [key: string]: unknown;
};
export type TemporaryWorksGlbManifest = { schemaVersion: 1; assets: TemporaryWorksGlbResource[] };
export type GlbWorldPoint = { longitude: number; latitude: number; height: number };

function positiveDimensions(d: TemporaryWorksGlbDimensions) {
  return d && [d.length, d.width, d.height].every(v => Number.isFinite(v) && v > 0 && v < 100000);
}

export function validateTemporaryWorksGlbResource(asset: TemporaryWorksGlbResource) {
  if (!asset || !['camp', 'steel', 'wall'].includes(asset.id) || !['Y','Z'].includes(asset.upAxis)
    || !positiveDimensions(asset.dimensions) || !asset.url || !asset.anchor?.every(Number.isFinite)
    || asset.anchor.length !== 3 || !asset.bounds?.min?.every(Number.isFinite)
    || !asset.bounds?.max?.every(Number.isFinite) || asset.bounds.min.length !== 3 || asset.bounds.max.length !== 3
    || !asset.bounds.max.every((v,i) => v > asset.bounds.min[i]))
    throw new Error('临建资源尺寸或坐标基准无效，请检查已核验的资源清单。');
  if (!asset.footprints?.length || asset.footprints.some(p =>
    [p.outer, ...(p.holes ?? [])].some(r => r.length < 3 || r.some(v => v.length !== 2 || !v.every(Number.isFinite)))))
    throw new Error('临建资源缺少有效建筑底面轮廓，不能使用包围盒代替摄影遮挡。');
  return asset;
}

let manifestPromise: Promise<TemporaryWorksGlbManifest> | undefined;
export function loadTemporaryWorksGlbManifest(): Promise<TemporaryWorksGlbManifest> {
  if (!manifestPromise) {
    const base = import.meta.env?.BASE_URL ?? '/';
    manifestPromise = fetch(`${base}models/temporary-works/manifest.json`).then(async response => {
      if (!response.ok) throw new Error(`临建资源清单加载失败（HTTP ${response.status}）。`);
      const result = await response.json() as TemporaryWorksGlbManifest;
      if (result.schemaVersion !== 1 || !Array.isArray(result.assets)) throw new Error('不支持的临建资源清单版本。');
      result.assets.forEach(validateTemporaryWorksGlbResource);
      if (new Set(result.assets.map(a => a.id)).size !== result.assets.length) throw new Error('临建资源标识重复。');
      return result;
    }).catch(error => { manifestPromise = undefined; throw error; });
  }
  return manifestPromise;
}

export function getTemporaryWorksGlbScale(asset: TemporaryWorksGlbResource, placement: TemporaryWorksGlbPlacement) {
  validateTemporaryWorksGlbResource(asset);
  if (!placement || !Number.isFinite(placement.longitude) || Math.abs(placement.longitude) > 180
    || !Number.isFinite(placement.latitude) || Math.abs(placement.latitude) >= 89.9
    || !Number.isFinite(placement.height) || !Number.isFinite(placement.headingDeg)
    || !['uniform','xyz'].includes(placement.scaleMode) || !positiveDimensions(placement.dimensions))
    throw new Error('请填写有效底面基准点经纬度、高程、旋转角和实际长宽高。');
  const s = {
    x: placement.dimensions.length / asset.dimensions.length,
    y: placement.dimensions.width / asset.dimensions.width,
    z: placement.dimensions.height / asset.dimensions.height,
  };
  if (placement.scaleMode === 'uniform' && (Math.abs(s.x - s.y) > 1e-5 * s.x || Math.abs(s.x - s.z) > 1e-5 * s.x))
    throw new Error('等比例模式的长宽高比例不一致，请选择一个尺寸同比缩放，或启用 XYZ 独立缩放。');
  return s;
}

/** Explicit axis conversion. Pass upAxis:Z, forwardAxis:X to Cesium.Model to avoid a second conversion. */
export function getTemporaryWorksGlbModelMatrix(asset: TemporaryWorksGlbResource, placement: TemporaryWorksGlbPlacement) {
  const s = getTemporaryWorksGlbScale(asset, placement);
  const axis = asset.upAxis === 'Y'
    ? Matrix4.fromRotationTranslation(Matrix3.fromRotationX(Math.PI / 2))
    : Matrix4.clone(Matrix4.IDENTITY);
  const a = Matrix4.multiplyByPoint(axis, Cartesian3.fromArray(asset.anchor), new Cartesian3());
  const centered = Matrix4.multiply(Matrix4.fromTranslation(Cartesian3.negate(a, new Cartesian3())), axis, new Matrix4());
  const scaled = Matrix4.multiply(Matrix4.fromScale(new Cartesian3(s.x, s.y, s.z)), centered, new Matrix4());
  const rotated = Matrix4.multiply(Matrix4.fromRotationTranslation(Matrix3.fromRotationZ(CesiumMath.toRadians(placement.headingDeg))), scaled, new Matrix4());
  const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(placement.longitude, placement.latitude, placement.height));
  return Matrix4.multiply(frame, rotated, new Matrix4());
}

export function getTemporaryWorksGlbFootprints(asset: TemporaryWorksGlbResource, placement: TemporaryWorksGlbPlacement) {
  const matrix = getTemporaryWorksGlbModelMatrix(asset, placement);
  const convert = (point: [number,number]): GlbWorldPoint => {
    const local = asset.upAxis === 'Y' ? new Cartesian3(point[0],asset.anchor[1],point[1]) : new Cartesian3(point[0],point[1],asset.anchor[2]);
    const geo = Cartographic.fromCartesian(Matrix4.multiplyByPoint(matrix, local, new Cartesian3()));
    return {longitude: CesiumMath.toDegrees(geo.longitude), latitude: CesiumMath.toDegrees(geo.latitude), height:geo.height};
  };
  return asset.footprints.map(p => ({outer:p.outer.map(convert), holes:(p.holes ?? []).map(r => r.map(convert))}));
}

export function uniformTemporaryWorksGlbDimensions(asset: TemporaryWorksGlbResource, dimension: keyof TemporaryWorksGlbDimensions, value: number) {
  if (!Number.isFinite(value) || value <= 0) throw new Error('目标尺寸必须大于 0 米。');
  const scale = value / asset.dimensions[dimension];
  return {length:asset.dimensions.length * scale, width:asset.dimensions.width * scale, height:asset.dimensions.height * scale};
}
