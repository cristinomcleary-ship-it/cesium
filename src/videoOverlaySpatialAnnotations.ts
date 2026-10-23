import { wrapVideoOverlayAnnotationText } from './videoOverlayAnnotations.ts';

/** Points belong to one imported object's local frame, never to the video image. */
export type SpatialPoint = { x: number; y: number; z: number };
export type SpatialAnnotationKind = 'label' | 'route' | 'area';
export type SpatialAnnotation = {
  id: string; kind: SpatialAnnotationKind; targetId: string; targetName: string;
  points: SpatialPoint[]; text: string; color: string; lineWidth: number; fontSize: number;
  start: number; end: number; fadeIn: number; fadeOut: number; visible: boolean;
  /** Label offset in 1080p reference pixels, applied after world projection. */
  offsetX: number; offsetY: number; fillOpacity: number; flow: boolean;
};
export type SpatialProjection = { x: number; y: number; depth: number };
export type SpatialAnnotationDrawOptions = {
  width: number; height: number; mediaTime: number;
  /** Normalized, lens-correct source-video coordinates; absent behind the camera. */
  project: (targetId: string, localPoint: SpatialPoint) => SpatialProjection | undefined;
  targetVisible?: (targetId: string) => boolean;
};
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Point2 = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };
type Caption = { mark: SpatialAnnotation; anchor: Point2; opacity: number };
const kinds = new Set<SpatialAnnotationKind>(['label', 'route', 'area']);
const hexColor = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
let counter = 0;

export function validateSpatialAnnotation(value: unknown): SpatialAnnotation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('结构标绘必须为对象');
  const source = value as Record<string, unknown>;
  const number = (key: string, min: number, max: number) => {
    const result = source[key];
    if (typeof result !== 'number' || !Number.isFinite(result) || result < min || result > max) throw new Error(`结构标绘 ${key} 必须为 ${min} 到 ${max} 之间的有限数值`);
    return result;
  };
  const string = (key: string, length: number, required = false) => {
    const result = source[key];
    if (typeof result !== 'string' || result.length > length || (required && !result.trim())) throw new Error(`结构标绘 ${key} 无效`);
    const clean = result.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    if (required && !clean.trim()) throw new Error(`结构标绘 ${key} 无效`);
    return clean;
  };
  if (!kinds.has(source.kind as SpatialAnnotationKind)) throw new Error('结构标绘类型无效');
  const kind = source.kind as SpatialAnnotationKind;
  if (!Array.isArray(source.points) || source.points.length > 256) throw new Error('结构标绘最多支持 256 个顶点');
  const minimum = kind === 'label' ? 1 : kind === 'route' ? 2 : 3;
  if (source.points.length < minimum || (kind === 'label' && source.points.length !== 1)) throw new Error(kind === 'label' ? '引线标签需要 1 个锚点' : `该标绘至少需要 ${minimum} 个顶点`);
  const points: SpatialPoint[] = source.points.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('结构标绘顶点无效');
    const point = value as Record<string, unknown>;
    const result = {} as SpatialPoint;
    for (const key of ['x', 'y', 'z'] as const) {
      const coordinate = point[key];
      if (typeof coordinate !== 'number' || !Number.isFinite(coordinate) || Math.abs(coordinate) > 1e9) throw new Error('结构标绘顶点必须为有效局部坐标');
      result[key] = coordinate;
    }
    return result;
  });
  if (new Set(points.map(point => `${point.x}/${point.y}/${point.z}`)).size < minimum) throw new Error('结构标绘顶点不能重合');
  if (kind === 'area') {
    const origin = points[0], second = points.find(point => point.x !== origin.x || point.y !== origin.y || point.z !== origin.z)!;
    const a = { x: second.x - origin.x, y: second.y - origin.y, z: second.z - origin.z };
    const noncollinear = points.some(point => {
      const b = { x: point.x - origin.x, y: point.y - origin.y, z: point.z - origin.z };
      const cross = Math.hypot(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
      return cross > Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z) * 1e-10;
    });
    if (!noncollinear) throw new Error('区域顶点不能全部位于同一直线');
  }
  if (typeof source.color !== 'string' || !hexColor.test(source.color)) throw new Error('结构标绘颜色必须为十六进制颜色');
  if (typeof source.visible !== 'boolean' || typeof source.flow !== 'boolean') throw new Error('结构标绘显示状态无效');
  const start = number('start', 0, 86_400_000), end = number('end', 0, 86_400_000);
  if (end <= start) throw new Error('结构标绘结束时间必须晚于开始时间');
  return {
    id: string('id', 160, true), kind, targetId: string('targetId', 240, true), targetName: string('targetName', 500), points,
    text: string('text', 2000), color: source.color.toLowerCase(), lineWidth: number('lineWidth', .5, 40), fontSize: number('fontSize', 8, 160),
    start, end, fadeIn: number('fadeIn', 0, 3600), fadeOut: number('fadeOut', 0, 3600), visible: source.visible,
    offsetX: number('offsetX', -4000, 4000), offsetY: number('offsetY', -4000, 4000), fillOpacity: number('fillOpacity', 0, 1), flow: source.flow,
  };
}

export function validateSpatialAnnotations(value: unknown): SpatialAnnotation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500) throw new Error('结构标绘列表无效，最多支持 500 项');
  const result = value.map(validateSpatialAnnotation);
  if (new Set(result.map(mark => mark.id)).size !== result.length) throw new Error('结构标绘 ID 重复');
  return result;
}

/** The editor supplies targetId and completed local points before creating a mark. */
export function createSpatialAnnotation(kind: SpatialAnnotationKind, overrides: Partial<Omit<SpatialAnnotation, 'kind'>> = {}): SpatialAnnotation {
  const start = overrides.start ?? 0;
  return validateSpatialAnnotation({
    id: globalThis.crypto?.randomUUID?.() ?? `spatial-${++counter}`, kind,
    targetId: '', targetName: '', points: [], text: kind === 'label' ? '结构说明' : kind === 'route' ? '线路走向' : '施工区域',
    color: kind === 'area' ? '#ffba4a' : '#44d9f5', lineWidth: 4, fontSize: 28,
    start, end: start + 5, fadeIn: .25, fadeOut: .25, visible: true,
    offsetX: 80, offsetY: -80, fillOpacity: .2, flow: kind === 'route', ...overrides,
  });
}

/** Deterministic for seeking, preview, native-frame caching and export. */
export function spatialAnnotationOpacity(mark: SpatialAnnotation, time: number): number {
  if (!mark.visible || !Number.isFinite(time) || time < mark.start || time >= mark.end) return 0;
  const duration = mark.end - mark.start, total = mark.fadeIn + mark.fadeOut;
  const factor = total > duration ? duration / total : 1;
  const incoming = mark.fadeIn * factor, outgoing = mark.fadeOut * factor;
  return clamp(Math.min(incoming > 0 ? (time - mark.start) / incoming : 1, outgoing > 0 ? (mark.end - time) / outgoing : 1), 0, 1);
}

function validProjection(point: SpatialProjection | undefined): point is SpatialProjection {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.depth)
    && point.depth > 0 && Math.abs(point.x) <= 1e6 && Math.abs(point.y) <= 1e6;
}
function inside(point: Point2, width: number, height: number) { return point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height; }

/** Liang–Barsky clipping prevents offscreen coordinates from creating huge paths. */
function clipSegment(a: Point2, b: Point2, width: number, height: number): [Point2, Point2] | undefined {
  const dx = b.x - a.x, dy = b.y - a.y;
  let low = 0, high = 1;
  for (const [p, q] of [[-dx, a.x], [dx, width - a.x], [-dy, a.y], [dy, height - a.y]]) {
    if (p === 0) { if (q < 0) return; continue; }
    const ratio = q / p;
    if (p < 0) low = Math.max(low, ratio); else high = Math.min(high, ratio);
    if (low > high) return;
  }
  return [{ x: a.x + low * dx, y: a.y + low * dy }, { x: a.x + high * dx, y: a.y + high * dy }];
}
function clipPolygon(points: Point2[], width: number, height: number): Point2[] {
  let result = points;
  for (const [axis, edge, sign] of [['x', 0, 1], ['x', width, -1], ['y', 0, 1], ['y', height, -1]] as const) {
    const output: Point2[] = [];
    if (!result.length) return output;
    let previous = result[result.length - 1], previousInside = (previous[axis] - edge) * sign >= 0;
    for (const current of result) {
      const currentInside = (current[axis] - edge) * sign >= 0;
      if (currentInside !== previousInside) {
        const fraction = (edge - previous[axis]) / (current[axis] - previous[axis]);
        output.push({ x: previous.x + fraction * (current.x - previous.x), y: previous.y + fraction * (current.y - previous.y) });
      }
      if (currentInside) output.push(current);
      previous = current; previousInside = currentInside;
    }
    result = output;
  }
  return result;
}
function path(context: Context, points: Point2[], closed: boolean) {
  context.beginPath(); context.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  if (closed) context.closePath();
}
function arrow(context: Context, a: Point2, b: Point2, progress: number, size: number) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < size * 2) return;
  const x = a.x + (b.x - a.x) * progress, y = a.y + (b.y - a.y) * progress;
  const dx = (b.x - a.x) / length, dy = (b.y - a.y) / length;
  context.beginPath(); context.moveTo(x + dx * size, y + dy * size);
  context.lineTo(x - dx * size + dy * size * .65, y - dy * size - dx * size * .65);
  context.lineTo(x - dx * size - dy * size * .65, y - dy * size + dx * size * .65);
  context.closePath(); context.fill();
}
function overlaps(a: Rect, b: Rect, padding: number) { return a.x < b.x + b.width + padding && a.x + a.width + padding > b.x && a.y < b.y + b.height + padding && a.y + a.height + padding > b.y; }

function caption(context: Context, item: Caption, width: number, height: number, occupied: Rect[]) {
  const { mark, anchor, opacity } = item, unit = height / 1080;
  const padding = Math.min(12 * unit, width * .04), margin = Math.min(8 * unit, width * .02, height * .02);
  // A narrow video still receives a contained card, not an oversized label.
  const fontSize = Math.min(mark.fontSize * unit, width / 8);
  context.font = `600 ${fontSize}px sans-serif`; context.textBaseline = 'top'; context.textAlign = 'left';
  const maxWidth = Math.max(fontSize, Math.min(420 * unit, width - margin * 2 - padding * 2));
  const lines = wrapVideoOverlayAnnotationText(context, mark.text || mark.targetName || '结构说明', maxWidth);
  const limit = Math.max(1, Math.min(8, Math.floor((height - margin * 2 - padding * 2) / (fontSize * 1.3))));
  if (lines.length > limit) { lines.length = limit; lines[limit - 1] = Array.from(lines[limit - 1]).slice(0, -1).join('') + '…'; }
  const cardWidth = Math.min(width - margin * 2, Math.max(fontSize * 2, ...lines.map(line => context.measureText(line).width)) + padding * 2);
  const cardHeight = Math.min(height - margin * 2, lines.length * fontSize * 1.3 + padding * 2);
  const preferredX = anchor.x + mark.offsetX * unit - (mark.offsetX < 0 ? cardWidth : 0);
  const preferredY = anchor.y + mark.offsetY * unit - (mark.offsetY < 0 ? cardHeight : 0);
  const bounded = (x: number, y: number): Rect => ({ x: clamp(x, margin, width - cardWidth - margin), y: clamp(y, margin, height - cardHeight - margin), width: cardWidth, height: cardHeight });
  const preferred = bounded(preferredX, preferredY), candidates = [preferred];
  for (let index = 1; index <= 6; index++) {
    candidates.push(bounded(preferred.x, preferred.y + index * (cardHeight + 8 * unit)), bounded(preferred.x, preferred.y - index * (cardHeight + 8 * unit)));
  }
  candidates.push(bounded(anchor.x - mark.offsetX * unit - cardWidth, preferredY));
  const rectangle = candidates.find(candidate => occupied.every(existing => !overlaps(candidate, existing, 6 * unit))) ?? candidates[0];
  occupied.push(rectangle);
  context.save();
  try {
    context.globalAlpha *= opacity; context.setLineDash([]); context.lineWidth = Math.max(1.5 * unit, mark.lineWidth * unit * .65);
    context.strokeStyle = mark.color; context.fillStyle = mark.color;
    const endX = anchor.x < rectangle.x + rectangle.width / 2 ? rectangle.x : rectangle.x + rectangle.width;
    const endY = clamp(anchor.y, rectangle.y + 8 * unit, rectangle.y + rectangle.height - 8 * unit);
    context.beginPath(); context.moveTo(anchor.x, anchor.y); context.lineTo(endX + (endX > anchor.x ? -18 : 18) * unit, endY); context.lineTo(endX, endY); context.stroke();
    context.beginPath(); context.arc(anchor.x, anchor.y, Math.max(4, mark.lineWidth) * unit, 0, Math.PI * 2); context.fill();
    context.fillStyle = '#0b1b2eea'; context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    context.strokeRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    context.fillStyle = mark.color; context.fillRect(rectangle.x, rectangle.y, 3 * unit, rectangle.height);
    context.fillStyle = '#f6fbff';
    lines.forEach((line, index) => context.fillText(line, rectangle.x + padding, rectangle.y + padding + index * fontSize * 1.3));
  } finally { context.restore(); }
}

/** All geometry is projected per frame. No canvas coordinates are persisted.
 * This presentation overlay intentionally remains readable over the scene; it
 * does not claim depth occlusion. The caller controls target availability.
 */
export function drawSpatialAnnotations(context: Context, marks: readonly SpatialAnnotation[], options: SpatialAnnotationDrawOptions): number {
  const { width, height, mediaTime } = options;
  if (![width, height].every(value => Number.isFinite(value) && value > 0)) throw new Error('结构标绘画布尺寸必须为正数');
  const unit = height / 1080, captions: Caption[] = [];
  let count = 0;
  context.save();
  try {
    context.beginPath(); context.rect(0, 0, width, height); context.clip(); context.globalCompositeOperation = 'source-over';
    for (const mark of marks) {
      const opacity = spatialAnnotationOpacity(mark, mediaTime);
      if (!opacity || options.targetVisible?.(mark.targetId) === false) continue;
      const points = mark.points.map(local => {
        const projected = options.project(mark.targetId, local);
        return validProjection(projected) ? { x: projected.x * width, y: projected.y * height } : undefined;
      });
      if (mark.kind === 'label') {
        const anchor = points[0];
        if (anchor && inside(anchor, width, height)) { captions.push({ mark, anchor, opacity }); count++; }
        continue;
      }
      context.save();
      try {
        context.globalAlpha *= opacity; context.strokeStyle = mark.color; context.fillStyle = mark.color;
        context.lineWidth = mark.lineWidth * unit; context.lineCap = 'round'; context.lineJoin = 'round'; context.setLineDash([]);
        if (mark.kind === 'area') {
          // Never connect across the camera near plane: that fabricates a region.
          if (points.some(point => !point)) continue;
          const complete = points as Point2[], visible = clipPolygon(complete, width, height);
          if (visible.length < 3) continue;
          path(context, visible, true);
          context.save(); try { context.globalAlpha *= mark.fillOpacity; context.fill('evenodd'); } finally { context.restore(); }
          // Stroke only real edges, not clipping edges at the viewport border.
          for (let index = 0; index < complete.length; index++) {
            const segment = clipSegment(complete[index], complete[(index + 1) % complete.length], width, height);
            if (segment) { path(context, segment, false); context.stroke(); }
          }
          const anchor = visible.reduce((sum, point) => ({ x: sum.x + point.x / visible.length, y: sum.y + point.y / visible.length }), { x: 0, y: 0 });
          if (mark.text) captions.push({ mark, anchor, opacity });
          count++;
        } else {
          let drawn = false, nameAnchor: Point2 | undefined, longest = 0;
          if (mark.flow) { context.setLineDash([16 * unit, 8 * unit]); context.lineDashOffset = -(mediaTime - mark.start) * 42 * unit; }
          for (let index = 1; index < points.length; index++) {
            const a = points[index - 1], b = points[index];
            if (!a || !b) continue;
            const segment = clipSegment(a, b, width, height);
            if (!segment) continue;
            const length = Math.hypot(segment[1].x - segment[0].x, segment[1].y - segment[0].y);
            if (length < .1 * unit) continue;
            path(context, segment, false); context.stroke();
            arrow(context, ...segment, mark.flow ? .2 + .6 * (((mediaTime - mark.start) * .35) % 1) : .6, 9 * unit);
            drawn = true;
            if (length > longest) { longest = length; nameAnchor = { x: (segment[0].x + segment[1].x) / 2, y: (segment[0].y + segment[1].y) / 2 }; }
          }
          if (drawn) { count++; if (mark.text && nameAnchor) captions.push({ mark, anchor: nameAnchor, opacity }); }
        }
      } finally { context.restore(); }
    }
    const occupied: Rect[] = [];
    for (const item of captions) caption(context, item, width, height, occupied);
  } finally { context.restore(); }
  return count;
}
