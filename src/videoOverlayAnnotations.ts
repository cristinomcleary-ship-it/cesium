/** Video annotations are screen-space overlays, timed only by video mediaTime.
 * Coordinates are fractions of the source video, never CSS pixels. Styles use
 * 1080p reference pixels, so preview and exported frames have identical layout.
 */
export type VideoOverlayAnnotationType = 'text' | 'arrow' | 'rectangle' | 'circle';
export type VideoOverlayAnnotationEffect = 'none' | 'fade' | 'pop';
export type VideoOverlayAnnotation = {
  id: string;
  type: VideoOverlayAnnotationType;
  /** Start/end points; circle uses centre/perimeter, text uses top-left/wrap edge. */
  x: number; y: number; x2: number; y2: number;
  text: string;
  color: string;
  /** Pixels at 1080p; scaled by output height / 1080. */
  lineWidth: number; fontSize: number;
  /** Seconds; start inclusive and end exclusive. */
  start: number; end: number;
  effect: VideoOverlayAnnotationEffect;
  /** Seconds. If their sum exceeds the interval, both are scaled proportionally. */
  fadeIn: number; fadeOut: number;
};
export type VideoOverlayAnnotationState = { visible: boolean; opacity: number; scale: number };
export type VideoOverlayAnnotationDrawOptions = {
  width: number; height: number; mediaTime: number;
  /** Omit for export. The decoration is never part of an annotation's style. */
  editorOnly?: { selectedId?: string };
};
type DrawingContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const VIDEO_OVERLAY_ANNOTATION_DEFAULTS = Object.freeze({
  x: 0.2, y: 0.2, x2: 0.45, y2: 0.35,
  text: '请输入标注内容', color: '#ffcc33', lineWidth: 4, fontSize: 36,
  start: 0, end: 5, effect: 'fade' as const, fadeIn: 0.35, fadeOut: 0.35,
});
const TYPES = new Set<VideoOverlayAnnotationType>(['text', 'arrow', 'rectangle', 'circle']);
const EFFECTS = new Set<VideoOverlayAnnotationEffect>(['none', 'fade', 'pop']);
const COLOR = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;
let nextAnnotationId = 0;

/** Reject malformed saved data before it reaches Canvas; returns an independent copy. */
export function validateVideoOverlayAnnotation(value: unknown): VideoOverlayAnnotation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('标注数据必须为对象');
  const source = value as Record<string, unknown>;
  const number = (key: string, minimum: number, maximum: number): number => {
    const result = source[key];
    if (typeof result !== 'number' || !Number.isFinite(result) || result < minimum || result > maximum) {
      throw new Error(`标注 ${key} 必须是 ${minimum} 到 ${maximum} 之间的有限数值`);
    }
    return result;
  };
  if (typeof source.id !== 'string' || !source.id.trim() || source.id.length > 160) throw new Error('标注 ID 无效');
  if (!TYPES.has(source.type as VideoOverlayAnnotationType)) throw new Error('标注类型无效');
  if (!EFFECTS.has(source.effect as VideoOverlayAnnotationEffect)) throw new Error('标注展示效果无效');
  if (typeof source.text !== 'string' || source.text.length > 2000) throw new Error('标注文字不能超过 2000 个字符');
  if (typeof source.color !== 'string' || !COLOR.test(source.color)) throw new Error('标注颜色必须为十六进制颜色');
  const start = number('start', 0, 86_400_000), end = number('end', 0, 86_400_000);
  if (end <= start) throw new Error('标注结束时间必须晚于开始时间');
  return {
    id: source.id, type: source.type as VideoOverlayAnnotationType,
    x: number('x', 0, 1), y: number('y', 0, 1), x2: number('x2', 0, 1), y2: number('y2', 0, 1),
    text: source.text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''),
    color: source.color.toLowerCase(), lineWidth: number('lineWidth', 0.5, 40), fontSize: number('fontSize', 8, 160),
    start, end, effect: source.effect as VideoOverlayAnnotationEffect,
    fadeIn: number('fadeIn', 0, 3600), fadeOut: number('fadeOut', 0, 3600),
  };
}

export function createVideoOverlayAnnotation(
  type: VideoOverlayAnnotationType,
  overrides: Partial<Omit<VideoOverlayAnnotation, 'type'>> = {},
): VideoOverlayAnnotation {
  const start = overrides.start ?? VIDEO_OVERLAY_ANNOTATION_DEFAULTS.start;
  return validateVideoOverlayAnnotation({
    ...VIDEO_OVERLAY_ANNOTATION_DEFAULTS,
    id: globalThis.crypto?.randomUUID?.() ?? `annotation-${++nextAnnotationId}`,
    ...overrides, type, end: overrides.end ?? start + 5,
  });
}

/** Pure and seekable: no wall clock, animation state, timeout or requestAnimationFrame. */
export function videoOverlayAnnotationState(annotation: VideoOverlayAnnotation, mediaTime: number): VideoOverlayAnnotationState {
  if (!Number.isFinite(mediaTime) || mediaTime < annotation.start || mediaTime >= annotation.end) {
    return { visible: false, opacity: 0, scale: 1 };
  }
  if (annotation.effect === 'none') return { visible: true, opacity: 1, scale: 1 };
  const duration = annotation.end - annotation.start;
  const total = annotation.fadeIn + annotation.fadeOut;
  const factor = total > duration ? duration / total : 1;
  const fadeIn = annotation.fadeIn * factor, fadeOut = annotation.fadeOut * factor;
  const age = mediaTime - annotation.start, remaining = annotation.end - mediaTime;
  const progress = fadeIn > 0 ? Math.min(1, age / fadeIn) : 1;
  const opacity = Math.max(0, Math.min(progress, fadeOut > 0 ? remaining / fadeOut : 1));
  const scale = annotation.effect === 'pop' ? 0.75 + 0.25 * (1 - Math.pow(1 - progress, 3)) : 1;
  return { visible: opacity > 0, opacity, scale };
}

/** Maps to actual video pixels; do not pass the CSS display size as width/height. */
export function videoOverlayAnnotationGeometry(annotation: VideoOverlayAnnotation, width: number, height: number) {
  const x = annotation.x * width, y = annotation.y * height;
  const x2 = annotation.x2 * width, y2 = annotation.y2 * height;
  return { x, y, x2, y2, radius: Math.hypot(x2 - x, y2 - y), styleScale: height / 1080 };
}

/** Unicode-safe wrapping, including Chinese text and explicit line breaks. */
export function wrapVideoOverlayAnnotationText(context: Pick<DrawingContext, 'measureText'>, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = '';
    for (const character of Array.from(paragraph)) {
      if (line && context.measureText(line + character).width > maxWidth) {
        lines.push(line.trimEnd());
        line = character.trimStart();
      } else line += character;
    }
    lines.push(line);
  }
  return lines;
}

function drawArrow(context: DrawingContext, x: number, y: number, x2: number, y2: number, lineWidth: number, unit: number) {
  const length = Math.hypot(x2 - x, y2 - y);
  if (length < 0.001) return;
  const angle = Math.atan2(y2 - y, x2 - x);
  const head = Math.min(length * 0.45, Math.max(lineWidth * 3.2, 16 * unit));
  context.beginPath(); context.moveTo(x, y); context.lineTo(x2, y2); context.stroke();
  context.beginPath(); context.moveTo(x2, y2);
  context.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
  context.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
  context.closePath(); context.fill();
}

/** Draw after the video/model composition. Does not clear or resize the canvas.
 * Output is clipped to the video rectangle and never changes caller context state.
 */
export function drawVideoOverlayAnnotations(
  context: DrawingContext,
  annotations: readonly VideoOverlayAnnotation[],
  options: VideoOverlayAnnotationDrawOptions,
): number {
  const { width, height, mediaTime } = options;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('标注画布尺寸必须为正数');
  let drawn = 0;
  context.save();
  try {
    context.beginPath(); context.rect(0, 0, width, height); context.clip();
    for (const annotation of annotations) {
      const state = videoOverlayAnnotationState(annotation, mediaTime);
      if (!state.visible) continue;
      const { x, y, x2, y2, radius, styleScale: unit } = videoOverlayAnnotationGeometry(annotation, width, height);
      const lineWidth = annotation.lineWidth * unit, fontSize = annotation.fontSize * unit;
      let left = Math.min(x, x2), top = Math.min(y, y2), right = Math.max(x, x2), bottom = Math.max(y, y2);
      context.save();
      try {
        context.globalAlpha *= state.opacity;
        context.globalCompositeOperation = 'source-over';
        context.strokeStyle = annotation.color; context.fillStyle = annotation.color;
        context.lineWidth = lineWidth; context.lineCap = 'round'; context.lineJoin = 'round';
        context.setLineDash([]);
        let lines: string[] = [];
        if (annotation.type === 'text') {
          context.font = `600 ${fontSize}px sans-serif`; context.textBaseline = 'top'; context.textAlign = 'left';
          const wrapWidth = Math.max(fontSize, (x2 > x ? x2 : width) - x);
          lines = wrapVideoOverlayAnnotationText(context, annotation.text, wrapWidth);
          left = x; top = y;
          right = x + Math.max(0, ...lines.map(line => context.measureText(line).width));
          bottom = y + lines.length * fontSize * 1.3;
        } else if (annotation.type === 'circle') {
          left = x - radius; top = y - radius; right = x + radius; bottom = y + radius;
        }
        const pivotX = (left + right) / 2, pivotY = (top + bottom) / 2;
        context.translate(pivotX, pivotY); context.scale(state.scale, state.scale); context.translate(-pivotX, -pivotY);
        if (annotation.type === 'text') {
          // A thin dark outline keeps text legible against bright aerial footage.
          context.strokeStyle = '#101820'; context.lineWidth = Math.max(1, fontSize * 0.09);
          lines.forEach((line, index) => {
            const baseline = y + index * fontSize * 1.3;
            context.strokeText(line, x, baseline); context.fillText(line, x, baseline);
          });
        } else if (annotation.type === 'arrow') drawArrow(context, x, y, x2, y2, lineWidth, unit);
        else if (annotation.type === 'rectangle') context.strokeRect(left, top, right - left, bottom - top);
        else {
          context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.stroke();
        }
        if (options.editorOnly?.selectedId === annotation.id) {
          const padding = Math.max(6 * unit, lineWidth);
          context.strokeStyle = '#ffffff'; context.lineWidth = 2 * unit; context.setLineDash([6 * unit, 4 * unit]);
          context.strokeRect(left - padding, top - padding, right - left + padding * 2, bottom - top + padding * 2);
        }
        drawn += 1;
      } finally { context.restore(); }
    }
  } finally { context.restore(); }
  return drawn;
}
