import { Dwg_File_Type, LibreDwg, type DwgDatabase, type DwgEntity } from "@mlightcad/libredwg-web";

export type CadPoint = { x: number; y: number; z?: number };

export type CadImportEntity = {
  type: "POLYLINE" | "3DFACE" | "POINT" | "TEXT";
  sourceType: string;
  layer: string;
  vertices: CadPoint[];
  closed?: boolean;
  text?: string;
  textHeight?: number;
  color?: string;
  lineweightMm?: number;
};

export type CadImportPackage = {
  format: "cesium-cad-import";
  version: 1 | 2;
  source: {
    name: string;
    format: "DWG";
    generatedAt: string;
  };
  statistics: {
    sourceEntities: number;
    displayEntities: number;
    skippedEntities: number;
    hiddenEntities?: number;
    unknownEntities: number;
    layers: string[];
  };
  entities: CadImportEntity[];
  warnings: string[];
};

type AnyEntity = DwgEntity & Record<string, unknown>;
type PointTransform = (point: CadPoint) => CadPoint;
type CadStyle = { color?: string; lineweightMm?: number };
type CadLayer = CadStyle & { visible: boolean };
type PolylineVertex = CadPoint & { bulge?: number; flag?: number };

const identity: PointTransform = (point) => ({ x: point.x, y: point.y, z: point.z ?? 0 });

const LINEWEIGHT_MM = [0, 0.05, 0.09, 0.13, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.53, 0.6, 0.7, 0.8, 0.9, 1, 1.06, 1.2, 1.4, 1.58, 2, 2.11];

function rgbHex(value: number): string {
  return `#${(value & 0xffffff).toString(16).padStart(6, "0").toUpperCase()}`;
}

function hsvHex(hue: number, saturation: number, value: number): string {
  const chroma = value * saturation;
  const section = hue / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  let red = 0; let green = 0; let blue = 0;
  if (section < 1) [red, green] = [chroma, x];
  else if (section < 2) [red, green] = [x, chroma];
  else if (section < 3) [green, blue] = [chroma, x];
  else if (section < 4) [green, blue] = [x, chroma];
  else if (section < 5) [red, blue] = [x, chroma];
  else [red, blue] = [chroma, x];
  const match = value - chroma;
  return rgbHex((Math.round((red + match) * 255) << 16) | (Math.round((green + match) * 255) << 8) | Math.round((blue + match) * 255));
}

function aciColor(index: number): string | undefined {
  const basics = [undefined, "#FF0000", "#FFFF00", "#00FF00", "#00FFFF", "#0000FF", "#FF00FF", "#FFFFFF", "#808080", "#C0C0C0"];
  if (index >= 1 && index <= 9) return basics[index];
  if (index >= 10 && index <= 249) {
    const shade = (index - 10) % 10;
    const values = [1, 1, 0.65, 0.65, 0.5, 0.5, 0.3, 0.3, 0.15, 0.15];
    return hsvHex(Math.floor((index - 10) / 10) * 15, shade % 2 === 0 ? 1 : 0.5, values[shade]);
  }
  const grays = [0x333333, 0x505050, 0x696969, 0x828282, 0xBEBEBE, 0xFFFFFF];
  if (index >= 250 && index <= 255) return rgbHex(grays[index - 250]);
  return undefined;
}

function directColor(value: Record<string, unknown>): string | undefined {
  if (Number.isFinite(value.color) && Number(value.color) >= 0) return rgbHex(Number(value.color));
  const index = Number(value.colorIndex);
  return index > 0 && index < 256 ? aciColor(index) : undefined;
}

function directLineweight(value: Record<string, unknown>): number | undefined {
  const index = Number(value.lineweight);
  return index >= 0 && index < LINEWEIGHT_MM.length ? LINEWEIGHT_MM[index] : undefined;
}

function entityStyle(entity: AnyEntity, layerStyle: CadStyle, blockStyle?: CadStyle): CadStyle {
  const colorIndex = Number(entity.colorIndex);
  const lineweight = Number(entity.lineweight);
  return {
    color: colorIndex === 0 ? blockStyle?.color ?? layerStyle.color : colorIndex === 256 || !Number.isFinite(colorIndex) ? layerStyle.color : directColor(entity) ?? layerStyle.color,
    lineweightMm: lineweight === 29 ? blockStyle?.lineweightMm ?? layerStyle.lineweightMm : lineweight === 28 || lineweight >= 30 || !Number.isFinite(lineweight) ? layerStyle.lineweightMm : directLineweight(entity) ?? layerStyle.lineweightMm,
  };
}

function isPoint(value: unknown): value is CadPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<CadPoint>;
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function point(value: unknown, fallbackZ = 0): CadPoint | null {
  if (!isPoint(value)) return null;
  return { x: value.x, y: value.y, z: Number.isFinite(value.z) ? value.z : fallbackZ };
}

function polylineVertex(value: unknown, fallbackZ = 0): PolylineVertex | null {
  const location = point(value, fallbackZ);
  if (!location) return null;
  const record = value as Record<string, unknown>;
  return {
    ...location,
    bulge: Number.isFinite(record.bulge) ? Number(record.bulge) : 0,
    flag: Number.isFinite(record.flag) ? Number(record.flag) : 0,
  };
}

function validPolylineVertices(values: unknown, fallbackZ = 0): PolylineVertex[] {
  if (!Array.isArray(values)) return [];
  const converted = values.map((value) => polylineVertex(value, fallbackZ));
  // Never remove a bad middle vertex and then join its two neighbours. A
  // corrupt run is safer to reject than to invent a line that is not in CAD.
  return converted.every((value): value is PolylineVertex => value !== null) ? converted : [];
}

function bulgeArcPoints(from: PolylineVertex, to: PolylineVertex): CadPoint[] {
  const bulge = Number(from.bulge) || 0;
  if (Math.abs(bulge) < 1e-12) return [];
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const chord = Math.hypot(dx, dy);
  if (!Number.isFinite(chord) || chord < 1e-12) return [];
  const sweep = 4 * Math.atan(bulge);
  const centerOffset = chord * (1 - bulge * bulge) / (4 * bulge);
  const midpointX = (from.x + to.x) / 2;
  const midpointY = (from.y + to.y) / 2;
  const centerX = midpointX - dy / chord * centerOffset;
  const centerY = midpointY + dx / chord * centerOffset;
  const radius = Math.hypot(from.x - centerX, from.y - centerY);
  if (!Number.isFinite(radius) || radius < 1e-12 || !Number.isFinite(sweep)) return [];
  const start = Math.atan2(from.y - centerY, from.x - centerX);
  // Match LibreDWG's own 5-degree interpolation while keeping a firm cap for
  // hostile/corrupt values. Non-uniform INSERT scaling remains correct because
  // interpolation happens before the block transform.
  const segments = Math.max(1, Math.min(144, Math.ceil(Math.abs(sweep) / (Math.PI / 36))));
  const output: CadPoint[] = [];
  for (let index = 1; index < segments; index += 1) {
    const fraction = index / segments;
    const angle = start + sweep * fraction;
    output.push({
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      z: (from.z ?? 0) + ((to.z ?? 0) - (from.z ?? 0)) * fraction,
    });
  }
  return output;
}

function interpolatePolyline(vertices: PolylineVertex[], closed: boolean): CadPoint[] {
  if (vertices.length < 2) return [];
  const output: CadPoint[] = [];
  const segmentCount = closed ? vertices.length : vertices.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const from = vertices[index];
    const to = vertices[(index + 1) % vertices.length];
    output.push({ x: from.x, y: from.y, z: from.z ?? 0 });
    output.push(...bulgeArcPoints(from, to));
  }
  if (!closed) {
    const last = vertices[vertices.length - 1];
    output.push({ x: last.x, y: last.y, z: last.z ?? 0 });
  }
  return output;
}

function polyline2dDisplayVertices(entity: AnyEntity): PolylineVertex[] {
  const vertices = validPolylineVertices(entity.vertices, Number(entity.elevation) || 0);
  if (vertices.length < 2) return vertices;
  const splineFit = vertices.filter((vertex) => ((vertex.flag ?? 0) & 8) !== 0 && ((vertex.flag ?? 0) & (4 | 16)) === 0);
  if (splineFit.length >= 2) return splineFit;
  const curveFit = vertices.filter((vertex) => ((vertex.flag ?? 0) & 1) !== 0 && ((vertex.flag ?? 0) & 4) === 0);
  if (curveFit.length >= 2) return curveFit;
  const ordinary = vertices.filter((vertex) => ((vertex.flag ?? 0) & (4 | 16 | 64 | 128)) === 0);
  return ordinary.length >= 2 ? ordinary : [];
}

function compose(parent: PointTransform, local: PointTransform): PointTransform {
  return (value) => parent(local(value));
}

function sampleArc(center: CadPoint, radius: number, start = 0, end = Math.PI * 2): CadPoint[] {
  let normalizedEnd = end;
  while (normalizedEnd <= start) normalizedEnd += Math.PI * 2;
  const sweep = normalizedEnd - start;
  const segments = Math.max(32, Math.ceil(sweep / (Math.PI / 36)));
  return Array.from({ length: segments + 1 }, (_, index) => {
    const angle = start + (sweep * index) / segments;
    return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius, z: center.z ?? 0 };
  });
}

function sampleEllipse(entity: AnyEntity): CadPoint[] {
  const center = point(entity.center);
  const major = point(entity.majorAxisEndPoint);
  const ratio = Number(entity.axisRatio);
  if (!center || !major || !Number.isFinite(ratio)) return [];
  const majorLength = Math.hypot(major.x, major.y);
  if (!majorLength) return [];
  const rotation = Math.atan2(major.y, major.x);
  const start = Number.isFinite(entity.startAngle) ? Number(entity.startAngle) : 0;
  let end = Number.isFinite(entity.endAngle) ? Number(entity.endAngle) : Math.PI * 2;
  while (end <= start) end += Math.PI * 2;
  const segments = Math.max(48, Math.ceil((end - start) / (Math.PI / 48)));
  return Array.from({ length: segments + 1 }, (_, index) => {
    const angle = start + ((end - start) * index) / segments;
    const localX = Math.cos(angle) * majorLength;
    const localY = Math.sin(angle) * majorLength * ratio;
    return {
      x: center.x + localX * Math.cos(rotation) - localY * Math.sin(rotation),
      y: center.y + localX * Math.sin(rotation) + localY * Math.cos(rotation),
      z: (center.z ?? 0) + (major.z ?? 0) * Math.cos(angle),
    };
  });
}

function transformed(points: CadPoint[], transform: PointTransform): CadPoint[] {
  const output = points.map(transform);
  return output.every((item) => [item.x, item.y, item.z ?? 0].every(Number.isFinite)) ? output : [];
}

function normaliseEntity(entity: AnyEntity, transform: PointTransform, style: CadStyle, inheritedLayer?: string): CadImportEntity | null {
  const layer = entity.layer === "0" && inheritedLayer ? inheritedLayer : String(entity.layer || inheritedLayer || "0");
  const common = { sourceType: entity.type, layer, ...style };
  let points: CadPoint[] = [];
  let closed = false;

  if (entity.type === "LINE") {
    const start = point(entity.startPoint);
    const end = point(entity.endPoint);
    if (start && end) points = [start, end];
  } else if (entity.type === "LWPOLYLINE") {
    const elevation = Number.isFinite(entity.elevation) ? Number(entity.elevation) : 0;
    closed = (Number(entity.flag) & 512) === 512;
    points = interpolatePolyline(validPolylineVertices(entity.vertices, elevation), closed);
  } else if (entity.type === "POLYLINE2D") {
    const parentFlag = Number(entity.flag);
    if ((parentFlag & (16 | 64)) !== 0) return null;
    closed = (parentFlag & 1) === 1;
    points = interpolatePolyline(polyline2dDisplayVertices(entity), closed);
  } else if (entity.type === "POLYLINE3D") {
    const parentFlag = Number(entity.flag);
    // Mesh/polyface containers are not a single continuous path. Connecting
    // their storage-order vertices creates long diagonals across the drawing.
    if ((parentFlag & (16 | 64)) !== 0) return null;
    points = validPolylineVertices(entity.vertices, Number(entity.elevation) || 0)
      .filter((vertex) => ((vertex.flag ?? 0) & (4 | 64 | 128)) === 0);
    closed = (parentFlag & 1) === 1;
  } else if (entity.type === "ARC" || entity.type === "CIRCLE") {
    const center = point(entity.center);
    const radius = Number(entity.radius);
    if (center && Number.isFinite(radius) && radius > 0) {
      points = sampleArc(center, radius, entity.type === "CIRCLE" ? 0 : Number(entity.startAngle) || 0, entity.type === "CIRCLE" ? Math.PI * 2 : Number(entity.endAngle) || Math.PI * 2);
      closed = entity.type === "CIRCLE";
    }
  } else if (entity.type === "ELLIPSE") {
    points = sampleEllipse(entity);
    const start = Number(entity.startAngle) || 0;
    const end = Number(entity.endAngle) || Math.PI * 2;
    closed = Math.abs(end - start) >= Math.PI * 2 - 1e-6;
  } else if (entity.type === "SPLINE") {
    const values = Array.isArray(entity.fitPoints) && entity.fitPoints.length ? entity.fitPoints : entity.controlPoints;
    points = Array.isArray(values) ? values.map((item) => point(item)).filter((item): item is CadPoint => Boolean(item)) : [];
    closed = (Number(entity.flag) & 1) === 1;
  } else if (entity.type === "3DFACE") {
    points = [entity.corner1, entity.corner2, entity.corner3, entity.corner4].map((item) => point(item)).filter((item): item is CadPoint => Boolean(item));
    if (points.length >= 3) return { ...common, type: "3DFACE", vertices: transformed(points, transform), closed: true };
  } else if (entity.type === "SOLID" || entity.type === "TRACE") {
    // DWG stores the last two SOLID/TRACE corners in crossing order.
    points = [entity.corner1, entity.corner2, entity.corner4, entity.corner3].map((item) => point(item)).filter((item): item is CadPoint => Boolean(item));
    if (points.length >= 3) return { ...common, type: "3DFACE", vertices: transformed(points, transform), closed: true };
  } else if (entity.type === "POINT") {
    const position = point(entity.position);
    if (position) return { ...common, type: "POINT", vertices: [transform(position)] };
  } else if (["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(entity.type)) {
    const position = point(entity.insertionPoint) ?? point(entity.startPoint) ?? point(entity.position);
    if (position) {
      return {
        ...common,
        type: "TEXT",
        vertices: [transform(position)],
        text: String(entity.text ?? entity.textValue ?? ""),
        textHeight: Number(entity.textHeight) || 2.5,
      };
    }
  }

  if (points.length >= 2) return { ...common, type: "POLYLINE", vertices: transformed(points, transform), closed };
  return null;
}

function expandDatabase(database: DwgDatabase): { entities: CadImportEntity[]; skipped: number; hidden: number; warnings: string[] } {
  const output: CadImportEntity[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  let hidden = 0;
  const blocks = new Map(database.tables.BLOCK_RECORD.entries.map((entry) => [entry.name.toUpperCase(), entry]));
  const layers = new Map<string, CadLayer>(database.tables.LAYER.entries.map((entry) => [entry.name.toUpperCase(), {
    color: directColor(entry as unknown as Record<string, unknown>) ?? "#FFFFFF",
    lineweightMm: directLineweight(entry as unknown as Record<string, unknown>) ?? 0.25,
    visible: !(entry as unknown as { frozen?: boolean }).frozen && !(entry as unknown as { off?: boolean }).off,
  }]));

  function visit(entity: AnyEntity, transform: PointTransform, inheritedLayer: string | undefined, inheritedStyle: CadStyle | undefined, depth: number, stack: string[]) {
    if (entity.isVisible === false || entity.isInPaperSpace) return;
    const resolvedLayer = entity.layer === "0" && inheritedLayer ? inheritedLayer : String(entity.layer || inheritedLayer || "0");
    const layerDefinition = layers.get(resolvedLayer.toUpperCase());
    if (layerDefinition?.visible === false) {
      hidden += 1;
      return;
    }
    if (entity.type !== "INSERT") {
      const style = entityStyle(entity, layerDefinition ?? {}, inheritedStyle);
      const normalized = normaliseEntity(entity, transform, style, inheritedLayer);
      if (normalized && normalized.vertices.length) output.push(normalized);
      else if (!['VIEWPORT', 'SEQEND'].includes(entity.type)) skipped += 1;
      return;
    }

    const name = String(entity.name || "");
    const block = blocks.get(name.toUpperCase());
    if (!block) {
      skipped += 1;
      warnings.push(`找不到块定义：${name || "未命名块"}`);
      return;
    }
    if (depth >= 20 || stack.includes(name.toUpperCase())) {
      skipped += 1;
      warnings.push(`块参照递归过深或循环：${name}`);
      return;
    }

    const insertion = point(entity.insertionPoint) ?? { x: 0, y: 0, z: 0 };
    const base = point(block.basePoint) ?? { x: 0, y: 0, z: 0 };
    const sx = Number(entity.xScale) || 1;
    const sy = Number(entity.yScale) || 1;
    const sz = Number(entity.zScale) || 1;
    const rotation = Number(entity.rotation) || 0;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const rows = Math.max(1, Number(entity.rowCount) || 1);
    const columns = Math.max(1, Number(entity.columnCount) || 1);
    const layer = entity.layer === "0" ? inheritedLayer : String(entity.layer || inheritedLayer || "0");
    const insertStyle = entityStyle(entity, layerDefinition ?? {}, inheritedStyle);

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const columnOffset = column * (Number(entity.columnSpacing) || 0);
        const rowOffset = row * (Number(entity.rowSpacing) || 0);
        const local: PointTransform = (value) => {
          const x = (value.x - base.x + columnOffset) * sx;
          const y = (value.y - base.y + rowOffset) * sy;
          return {
            x: insertion.x + x * cos - y * sin,
            y: insertion.y + x * sin + y * cos,
            z: (insertion.z ?? 0) + ((value.z ?? 0) - (base.z ?? 0)) * sz,
          };
        };
        const nestedTransform = compose(transform, local);
        block.entities.forEach((child) => visit(child as AnyEntity, nestedTransform, layer, insertStyle, depth + 1, [...stack, name.toUpperCase()]));
      }
    }
  }

  database.entities.forEach((entity) => visit(entity as AnyEntity, identity, undefined, undefined, 0, []));
  return { entities: output, skipped, hidden, warnings: [...new Set(warnings)].slice(0, 50) };
}

let parserPromise: Promise<Awaited<ReturnType<typeof LibreDwg.create>>> | null = null;

async function parser() {
  parserPromise ??= LibreDwg.create("/libredwg");
  return parserPromise;
}

export async function createCadImportFromDwg(file: File): Promise<CadImportPackage> {
  if (!file.name.toLowerCase().endsWith(".dwg")) throw new Error("请选择 DWG 文件生成导入文件");
  const engine = await parser();
  const pointer = engine.dwg_read_data(await file.arrayBuffer(), Dwg_File_Type.DWG);
  if (!pointer) throw new Error("独立解析器无法读取这个 DWG；可能是文件损坏、受密码保护或包含未支持的版本/对象");

  try {
    const { database, stats } = engine.convertEx(pointer);
    const result = expandDatabase(database);
    if (!result.entities.length) throw new Error("DWG 已解析，但模型空间内没有可显示的线、圆弧、多段线、文字、点或三维面");
    const layers = [...new Set(result.entities.map((entity) => entity.layer))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    return {
      format: "cesium-cad-import",
      version: 2,
      source: { name: file.name, format: "DWG", generatedAt: new Date().toISOString() },
      statistics: {
        sourceEntities: database.entities.length,
        displayEntities: result.entities.length,
        skippedEntities: result.skipped,
        hiddenEntities: result.hidden,
        unknownEntities: stats.unknownEntityCount,
        layers,
      },
      entities: result.entities,
      warnings: result.warnings,
    };
  } finally {
    engine.dwg_free(pointer);
  }
}

export async function readCadImport(file: File): Promise<CadImportPackage> {
  let parsed: unknown;
  try { parsed = JSON.parse(await file.text()); }
  catch { throw new Error("导入文件不是有效的 .cadimport 文件"); }
  const value = parsed as Partial<CadImportPackage>;
  if (value.format !== "cesium-cad-import" || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.entities)) {
    throw new Error("不支持的 .cadimport 格式或版本");
  }
  if (!value.entities.every((entity) => entity && Array.isArray(entity.vertices))) throw new Error(".cadimport 中的几何数据不完整");
  return value as CadImportPackage;
}

export function cadImportBlob(value: CadImportPackage): Blob {
  return new Blob([JSON.stringify(value)], { type: "application/vnd.cesium.cadimport+json" });
}

export function cadImportFileName(sourceName: string): string {
  return sourceName.replace(/\.dwg$/i, "") + ".cadimport";
}
