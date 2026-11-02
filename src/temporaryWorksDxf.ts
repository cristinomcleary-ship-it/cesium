// The platform's LibreDWG WASM reads DWG only. Translate common model-space
// ASCII DXF records into the same database representation so that OCS, bulges
// and tessellation use the platform's tested CAD geometry routines.
import type { DwgDatabase } from '@mlightcad/libredwg-web';
import { expandCadDatabase } from './cadImport.ts';

type Pair = [number, string];
type Entity = Record<string, unknown>;
type DxfRecord = { kind: string; groups: Pair[] };
const get = (r: DxfRecord, code: number) => r.groups.find(([k]) => k === code)?.[1];
function num(r: DxfRecord, code: number, fallback?: number): number {
  const text = get(r, code);
  return text === undefined ? (fallback ?? NaN) : text.trim() === '' ? NaN : Number(text);
}
function point(r: DxfRecord, first = 10) {
  return { x: num(r, first), y: num(r, first + 10), z: num(r, first + 20, 0) };
}
function meta(r: DxfRecord) {
  const extrusionDirection = get(r, 230) !== undefined || get(r, 210) !== undefined || get(r, 220) !== undefined
    ? { x: num(r, 210, 0), y: num(r, 220, 0), z: num(r, 230, 1) } : undefined;
  return { type: r.kind, layer: get(r, 8) ?? '0', isInPaperSpace: num(r, 67, 0) === 1,
    isVisible: num(r, 60, 0) !== 1, extrusionDirection };
}
function convert(r: DxfRecord): Entity | undefined {
  const common = meta(r);
  if (r.kind === 'LINE') return { ...common, startPoint: point(r), endPoint: point(r, 11) };
  if (r.kind === 'ARC' || r.kind === 'CIRCLE') {
    const start = r.kind === 'CIRCLE' ? 0 : num(r, 50), end = r.kind === 'CIRCLE' ? 360 : num(r, 51);
    const angle = (n: number) => ((n % 360 + 360) % 360) * Math.PI / 180;
    if (Number.isFinite(start) && Number.isFinite(end)) return { ...common, center: point(r), radius: num(r, 40),
      startAngle: angle(start), endAngle: angle(end) };
  }
  if (r.kind === 'LWPOLYLINE') {
    const vertices: { x: number; y: number; bulge: number }[] = [];
    let vertex: typeof vertices[number] | undefined;
    for (const [code, text] of r.groups) {
      const n = text.trim() ? Number(text) : NaN;
      if (code === 10) { vertex = { x: n, y: NaN, bulge: 0 }; vertices.push(vertex); }
      else if (vertex && code === 20) vertex.y = n;
      else if (vertex && code === 42) vertex.bulge = n;
    }
    if (num(r, 90, vertices.length) !== vertices.length || !vertices.every(v => Number.isFinite(v.bulge))) return;
    return { ...common, flag: num(r, 70, 0) & 1 ? 512 : 0, elevation: num(r, 38, 0), vertices };
  }
  if (r.kind === '3DFACE') return { ...common, corner1: point(r), corner2: point(r, 11), corner3: point(r, 12), corner4: point(r, 13) };
  return undefined;
}

function* records(text: string): Generator<DxfRecord> {
  // Stream pairs from the string; avoid constructing a potentially huge array
  // of all text lines/group tuples for large CAD drawings.
  let cursor = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const line = () => {
    const end = text.indexOf('\n', cursor);
    const value = text.slice(cursor, end < 0 ? text.length : end).trim();
    cursor = end < 0 ? text.length : end + 1;
    return value;
  };
  let current: DxfRecord | undefined;
  while (cursor < text.length) {
    const code = line();
    if (!code && cursor === text.length) break;
    if (!/^\d+$/.test(code) || cursor >= text.length) throw new Error('DXF 组码无效，请另存为文本 DXF 或 DWG');
    const value = line(), n = Number(code);
    if (!n) {
      if (current) yield current;
      current = { kind: value.toUpperCase(), groups: [] };
    } else current?.groups.push([n, value]);
  }
  if (current) yield current;
}

export function parsePlanningDxf(text: string) {
  const raw: Entity[] = [], layers: Entity[] = [], unsupported = new Map<string, number>();
  let section = '', complete = false, polyline: (Entity & { vertices: Entity[] }) | undefined;
  const skip = (kind: string) => unsupported.set(kind, (unsupported.get(kind) || 0) + 1);
  for (const r of records(text)) {
    if (r.kind === 'SECTION') { section = (get(r, 2) || '').toUpperCase(); continue; }
    if (r.kind === 'ENDSEC') { if (section === 'ENTITIES') complete = true; section = ''; polyline = undefined; continue; }
    if (section === 'TABLES' && r.kind === 'LAYER') {
      const name = get(r, 2);
      if (name) layers.push({ name, frozen: Boolean(num(r, 70, 0) & 1), off: num(r, 62, 7) < 0 });
    }
    if (section !== 'ENTITIES') continue;
    if (r.kind === 'POLYLINE') {
      const flag = num(r, 70, 0);
      polyline = { ...meta(r), type: flag & 8 ? 'POLYLINE3D' : 'POLYLINE2D', flag, elevation: num(r, 30, 0), vertices: [] };
    } else if (r.kind === 'VERTEX' && polyline) {
      polyline.vertices.push({ ...point(r), flag: num(r, 70, 0), bulge: num(r, 42, 0) });
    } else if (r.kind === 'SEQEND' && polyline) {
      raw.push(polyline); polyline = undefined;
    } else {
      // Unterminated/corrupt polylines are never joined across records.
      if (polyline) { skip('POLYLINE'); polyline = undefined; }
      const source = convert(r);
      if (source) raw.push(source);
      else if (!['TEXT', 'MTEXT', 'POINT', 'DIMENSION', 'HATCH', 'VIEWPORT'].includes(r.kind)) skip(r.kind);
    }
  }
  if (!complete) throw new Error('未找到完整的 DXF ENTITIES 模型空间段，请检查图纸格式');
  const db = { entities: raw, tables: { LAYER: { entries: layers }, BLOCK_RECORD: { entries: [] } } } as unknown as DwgDatabase;
  const result = expandCadDatabase(db);
  const warnings = [...result.warnings];
  if (unsupported.size) warnings.push('未读取的 DXF 类型：' + [...unsupported].map(([type,n]) => `${type} × ${n}`).join('、') + '。请在 CAD 中将目标线转换为普通多段线后重新导入。');
  if (result.skipped) warnings.push(`有 ${result.skipped} 个空或无效图元已跳过。`);
  if (!result.entities.length && warnings.length) throw new Error('DXF 未找到可用几何。' + warnings.join(' '));
  return { entities: result.entities, warnings };
}

export async function readPlanningDxf(file: File, signal?: AbortSignal) {
  if (file.size > 40 * 1024 * 1024) throw new Error('文本 DXF 超过 40 MB，请单独另存规划图层或使用 DWG');
  signal?.throwIfAborted();
  const bytes = await file.arrayBuffer();
  signal?.throwIfAborted();
  if (new TextDecoder().decode(bytes.slice(0, 20)).startsWith('AutoCAD Binary DXF')) throw new Error('请将二进制 DXF 另存为文本 DXF，或导入 DWG');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { text = new TextDecoder('gb18030').decode(bytes); }
  return parsePlanningDxf(text);
}
