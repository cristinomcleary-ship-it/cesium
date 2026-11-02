import proj4 from 'proj4';
import { joinPlanningCadFeatures } from './temporaryWorksCadChains.ts';
import type { CadImportEntity } from './cadImport.ts';
import { CAD_IMPORT_WORKER_MIN_BYTES, createCadImportFromDwgInWorker, readCadImportInWorker } from './cadImportWorkerClient.ts';
import { createGaussKrugerProjection, type GaussAxisOrder } from './coordinateUtils.ts';
import { readPlanningDxf } from './temporaryWorksDxf.ts';

export type PlanningPoint = { x: number; y: number };
export type PlanningGeo = { longitude: number; latitude: number };
export type PlanningCadUnit = 'm' | 'cm' | 'mm';
export type PlanningCadCoordinates =
  | { mode: 'local'; referenceX: number; referenceY: number; longitude: number; latitude: number;
      rotation: number; unit: PlanningCadUnit; axisOrder: GaussAxisOrder }
  | { mode: 'gaussKruger'; centralMeridian: number; hasZonePrefix: boolean; zoneNumber: number; bandWidth?: 3 | 6;
      unit: PlanningCadUnit; axisOrder: GaussAxisOrder; modelOffset?: {east:number; north:number} }
  | { mode: 'geographic'; axisOrder: GaussAxisOrder };
export type PlanningProjectedCoordinates = Extract<PlanningCadCoordinates,{mode:'gaussKruger'}>;

export type PlanningCadFeature = { id: string; layer: string; sourceType: string; closed: boolean; points: PlanningPoint[]; stationFactors?: number[] };
export type PlanningCadDrawing = { features: PlanningCadFeature[]; warnings: string[] };

function checkedPoint(point: PlanningPoint): PlanningPoint {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('CAD 平面坐标无效');
  return point;
}
function checkedGeo(point: PlanningGeo): PlanningGeo {
  if (!Number.isFinite(point.longitude) || !Number.isFinite(point.latitude) ||
      Math.abs(point.longitude) > 180 || Math.abs(point.latitude) >= 90) throw new Error('坐标转换失败，请检查经纬度、图纸单位与坐标顺序');
  return point;
}
function metres(unit: PlanningCadUnit): number {
  const scale = { m: 1, cm: .01, mm: .001 }[unit];
  if (!scale) throw new Error('请选择 CAD 单位');
  return scale;
}
function metricFrame(origin: PlanningGeo) {
  checkedGeo(origin);
  const converter = proj4('EPSG:4326', `+proj=aeqd +lat_0=${origin.latitude} +lon_0=${origin.longitude} +datum=WGS84 +units=m +no_defs`);
  return {
    geoToLocal(point: PlanningGeo) {
      checkedGeo(point);
      const [x, y] = converter.forward([point.longitude, point.latitude]);
      return checkedPoint({ x, y });
    },
    localToGeo(point: PlanningPoint) {
      checkedPoint(point);
      const [longitude, latitude] = converter.inverse([point.x, point.y]);
      return checkedGeo({ longitude, latitude });
    },
  };
}

/** Bind the source drawing grid to WGS84 once. Geometry and heights use independent datums. */
function bindCadGrid(options: Exclude<PlanningCadCoordinates, { mode: 'geographic' }>) {
  const scale = metres(options.unit);
  const order = (x: number, y: number) => options.axisOrder === 'eastNorth' ? { x, y } : { x: y, y: x };
  if (options.mode === 'local') {
    const frame = metricFrame({ longitude: options.longitude, latitude: options.latitude });
    checkedPoint({ x: options.referenceX, y: options.referenceY });
    if (!Number.isFinite(options.rotation)) throw new Error('请输入局部坐标旋转角');
    const radians = options.rotation * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
    return {
      ...frame,
      cadToGrid(point: PlanningPoint) {
        checkedPoint(point);
        const p = order(point.x - options.referenceX, point.y - options.referenceY);
        return { x: scale * (p.x * cos - p.y * sin), y: scale * (p.x * sin + p.y * cos) };
      },
    };
  }
  if (!Number.isFinite(options.centralMeridian) || Math.abs(options.centralMeridian) > 180) throw new Error('请输入有效的中央子午线经度');
  if (options.hasZonePrefix && (!Number.isInteger(options.zoneNumber) || options.zoneNumber < 1 || options.zoneNumber > 60)) throw new Error('含带号坐标需要填写正确的带号');
  const projection = createGaussKrugerProjection({ ...options, ellipsoid: 'GRS80' });
  const prefix = options.hasZonePrefix ? options.zoneNumber * 1e6 : 0;
  const {east, north} = options.modelOffset ?? {east:0, north:0};
  if (![east,north].every(Number.isFinite)) throw new Error('摄影模型平面偏移须为有效的东、北向米数');
  return {
    cadToGrid(point: PlanningPoint) {
      checkedPoint(point);
      const p = order(point.x * scale, point.y * scale);
      const easting = p.x - prefix;
      if (!(easting > 0 && easting < 1e6 && Math.abs(p.y) < 1e7)) throw new Error('高斯坐标超出投影带范围，请检查 XY 顺序、长度单位和带号前缀');
      return { x: easting, y: p.y };
    },
    localToGeo(point: PlanningPoint) {
      checkedPoint(point);
      const [longitude, latitude] = projection.forward([point.x + east, point.y + north]);
      return checkedGeo({ longitude, latitude });
    },
    geoToLocal(point: PlanningGeo) {
      checkedGeo(point);
      const [x, y] = projection.inverse([point.longitude, point.latitude]);
      return checkedPoint({ x:x-east, y:y-north });
    },
  };
}

function drawingFrame(options: PlanningCadCoordinates, reference: PlanningPoint, retainCadMetres: boolean) {
  checkedPoint(reference);
  if (options.axisOrder !== 'eastNorth' && options.axisOrder !== 'northEast') throw new Error('请选择 CAD 坐标顺序');
  if (options.mode === 'geographic') {
    const toGeo = (p: PlanningPoint) => checkedGeo(options.axisOrder === 'eastNorth'
      ? { longitude: p.x, latitude: p.y } : { longitude: p.y, latitude: p.x });
    const origin = toGeo(reference), frame = metricFrame(origin);
    return { origin, ...frame, cadToLocal: (p: PlanningPoint) => frame.geoToLocal(toGeo(p)) };
  }
  const grid = bindCadGrid(options);
  const first = grid.cadToGrid(reference), origin = grid.localToGeo(first);
  if (retainCadMetres) {
    // Design chainage and offsets are measured in the original engineering grid.
    // Reproject only for photogrammetry sampling and screen display.
    const relative = (p: PlanningPoint) => ({ x: p.x - first.x, y: p.y - first.y });
    return {
      origin,
      cadToLocal: (p: PlanningPoint) => relative(grid.cadToGrid(p)),
      geoToLocal: (p: PlanningGeo) => relative(grid.geoToLocal(p)),
      localToGeo: (p: PlanningPoint) => grid.localToGeo({ x: first.x + p.x, y: first.y + p.y }),
    };
  }
  // Existing hardstands retain their first-point azimuthal map plane.
  if (options.mode === 'gaussKruger' && options.modelOffset && (options.modelOffset.east || options.modelOffset.north)) {
    // Quantities use exactly the uncorrected survey plane. Apply photogrammetry
    // registration only at the boundary between that plane and the displayed model.
    const survey = bindCadGrid({...options, modelOffset:undefined});
    const design = metricFrame(survey.localToGeo(first));
    return {origin,
      cadToLocal:(p:PlanningPoint)=>design.geoToLocal(survey.localToGeo(survey.cadToGrid(p))),
      localToGeo:(p:PlanningPoint)=>grid.localToGeo(survey.geoToLocal(design.localToGeo(p))),
      geoToLocal:(p:PlanningGeo)=>design.geoToLocal(survey.localToGeo(grid.geoToLocal(p))),
    };
  }
  const frame = metricFrame(origin);
  return { origin, ...frame, cadToLocal: (p: PlanningPoint) => frame.geoToLocal(grid.localToGeo(grid.cadToGrid(p))) };
}

export const createPlanCoordinateFrame = (options: PlanningCadCoordinates, reference: PlanningPoint) => drawingFrame(options, reference, false);
export const createRoadCoordinateFrame = (options: PlanningCadCoordinates, reference: PlanningPoint) => drawingFrame(options, reference, true);

/** Absolute correction from the original projected control to its observed
 * position on the selected model, in grid metres. Rechecking never accumulates offsets. */
export function checkProjectedControl(coordinates:PlanningProjectedCoordinates, cad:PlanningPoint, geo:PlanningGeo) {
  const source = createRoadCoordinateFrame({...coordinates,modelOffset:undefined}, cad);
  const {x:east, y:north} = source.geoToLocal(geo);
  return {east,north,distance:Math.hypot(east,north)};
}

function key(p: PlanningPoint) { return `${p.x},${p.y}`; }

export function planningCadDrawing(entities: CadImportEntity[], warnings: string[] = []): PlanningCadDrawing {
  const features: PlanningCadFeature[] = [];
  let splineCount = 0;
  for (const [index, entity] of entities.entries()) {
    // The display importer stores SPLINE fit/control points, not evaluated curve vertices.
    if (entity.sourceType?.toUpperCase() === 'SPLINE') { splineCount++; continue; }
    if (entity.type !== 'POLYLINE' && entity.type !== '3DFACE') continue;
    if (!entity.vertices.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))) continue;
    const points: PlanningPoint[] = [];
    for (const { x, y } of entity.vertices) {
      const last = points.at(-1);
      if (!last || x !== last.x || y !== last.y) points.push({ x, y });
    }
    const matches = points.length > 2 && key(points[0]) === key(points[points.length - 1]);
    const closed = entity.type === '3DFACE' || Boolean(entity.closed) || matches;
    if (matches) points.pop();
    // DWG arc tessellation may return an endpoint within floating point noise of the start.
    if (closed && points.length > 3 && Math.hypot(points[0].x - points.at(-1)!.x, points[0].y - points.at(-1)!.y) < 1e-10) points.pop();
    if (points.length < (closed ? 3 : 2)) continue;
    // Older CADIMPORTs contain chords only. Accept corrections only for the
    // supported circular primitives and the importer's at-most-five-degree arcs.
    const factors = entity.stationFactors;
    const circular = !closed && /^(ARC|LWPOLYLINE|POLYLINE2D)$/.test(entity.sourceType)
      && Array.isArray(factors) && factors.length === points.length - 1
      && points.length === entity.vertices.length && factors.every(f => Number.isFinite(f) && f >= 1 && f <= 1.00032);
    features.push({ id: 'cad-' + (index + 1), sourceType: entity.sourceType, layer: entity.layer || '0', closed, points,
      ...(circular ? { stationFactors: factors } : {}) });
  }
  const splineWarning = splineCount ? `已跳过 ${splineCount} 条 SPLINE 样条线。请在 CAD 中按设计精度将目标样条转换为普通多段线后重新导入。` : '';
  if (!features.length) throw new Error('未找到可用于规划的 CAD 边界或中心线。' + (splineWarning || '请检查模型空间图层，或将目标线转换为普通多段线。'));
  return { features: [...joinPlanningCadFeatures(features), ...features], warnings: splineWarning ? [splineWarning, ...warnings] : warnings };
}

function readDxf(file: File, signal?: AbortSignal): ReturnType<typeof readPlanningDxf> {
  if (file.size < CAD_IMPORT_WORKER_MIN_BYTES || typeof Worker === 'undefined') return readPlanningDxf(file, signal);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./temporaryWorksDxf.worker.ts', import.meta.url), { type: 'module', name: 'planning-dxf' });
    const cleanup = () => { worker.terminate(); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new DOMException('已取消 CAD 读取', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    worker.onmessage = ({ data }) => {
      cleanup();
      if (data.value) resolve(data.value); else reject(new Error(data.error || 'DXF 解析失败'));
    };
    worker.onerror = event => { cleanup(); reject(new Error(event.message || 'DXF 解析线程退出')); };
    worker.onmessageerror = () => { cleanup(); reject(new Error('无法读取 DXF 解析结果')); };
    try { worker.postMessage(file); } catch (error) { cleanup(); reject(error); }
  });
}

export async function readPlanningCad(file: File, signal?: AbortSignal): Promise<PlanningCadDrawing> {
  signal?.throwIfAborted();
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'dxf') {
    const { entities, warnings } = await readDxf(file, signal);
    signal?.throwIfAborted();
    return planningCadDrawing(entities, warnings);
  }
  const pkg = extension === 'dwg' ? (await createCadImportFromDwgInWorker(file, undefined, signal)).value
    : extension === 'cadimport' ? await readCadImportInWorker(file, undefined, signal) : undefined;
  if (!pkg) throw new Error('请选择 DWG、DXF 或平台 .cadimport 文件');
  const warnings = [...(pkg.warnings || [])];
  if (pkg.statistics?.skippedEntities) warnings.push(`有 ${pkg.statistics.skippedEntities} 个 CAD 图元未转换，请核对选中范围。`);
  return planningCadDrawing(pkg.entities, warnings);
}

/** X increases to the right of the forward road direction, section Y increases
 * upwards. Drawing origin is arbitrary: elevations are relative to mid-width. */
export function sectionProfile(feature: PlanningCadFeature, unit: PlanningCadUnit) {
  if (feature.closed || feature.points.length < 2) throw new Error('请选择一条从断面左缘连到右缘的未闭合硬化顶面线');
  const scale = metres(unit);
  const line = feature.points.slice();
  if (line[0].x > line.at(-1)!.x) line.reverse();
  for (let i = 0; i < line.length; i++) {
    checkedPoint(line[i]);
    if (i && line[i].x <= line[i - 1].x) throw new Error('断面顶面线沿图纸 X 方向应连续单调，不能折回或包含竖边');
  }
  const width = (line.at(-1)!.x - line[0].x) * scale;
  const centerX = line[0].x + width / scale / 2;
  const i = line.findIndex((point, index) => index > 0 && point.x >= centerX);
  const a = line[i - 1], b = line[i];
  const centerY = a.y + (centerX - a.x) / (b.x - a.x) * (b.y - a.y);
  return { width, points: line.map(p => ({ offset: (p.x - centerX) * scale, rise: (p.y - centerY) * scale })) };
}
