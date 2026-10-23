import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createVideoOverlayAnnotation, drawVideoOverlayAnnotations,
  validateVideoOverlayAnnotation, videoOverlayAnnotationGeometry,
  videoOverlayAnnotationState, wrapVideoOverlayAnnotationText,
} from './videoOverlayAnnotations.ts';

type Call = { method: string; args: unknown[]; alpha: number; lineWidth: number };
/** Canvas spy without browser/WebGL dependencies; implements save/restore semantics. */
function canvasSpy() {
  const calls: Call[] = [];
  const states: Array<Record<string, unknown>> = [];
  const attributes = ['globalAlpha', 'globalCompositeOperation', 'strokeStyle', 'fillStyle', 'lineWidth', 'lineCap', 'lineJoin', 'font', 'textBaseline', 'textAlign'];
  const target: Record<string, unknown> = {
    globalAlpha: 1, globalCompositeOperation: 'multiply', lineWidth: 7, font: '12px serif',
    save() { states.push(Object.fromEntries(attributes.map(key => [key, target[key]]))); },
    restore() { Object.assign(target, states.pop()); },
    measureText(text: string) {
      const size = Number(String(target.font).match(/([\d.]+)px/)?.[1] ?? 12);
      return { width: Array.from(text).length * size * 0.6 };
    },
  };
  for (const method of ['beginPath', 'rect', 'clip', 'moveTo', 'lineTo', 'stroke', 'fill', 'closePath', 'arc', 'strokeRect', 'strokeText', 'fillText', 'translate', 'scale', 'setLineDash']) {
    target[method] = (...args: unknown[]) => calls.push({ method, args, alpha: Number(target.globalAlpha), lineWidth: Number(target.lineWidth) });
  }
  return { context: target as unknown as CanvasRenderingContext2D, calls, states, target };
}
function close(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} differs from ${expected}`); }

test('direct appearance has precise inclusive start / exclusive end and is seekable', () => {
  const annotation = createVideoOverlayAnnotation('rectangle', { start: 2, end: 5, effect: 'none' });
  assert.deepEqual(videoOverlayAnnotationState(annotation, 1.999), { visible: false, opacity: 0, scale: 1 });
  assert.deepEqual(videoOverlayAnnotationState(annotation, 2), { visible: true, opacity: 1, scale: 1 });
  assert.equal(videoOverlayAnnotationState(annotation, 4.999).visible, true);
  assert.equal(videoOverlayAnnotationState(annotation, 5).visible, false);
  assert.equal(videoOverlayAnnotationState(annotation, Number.NaN).visible, false);
  videoOverlayAnnotationState(annotation, 100);
  assert.deepEqual(videoOverlayAnnotationState(annotation, 2), { visible: true, opacity: 1, scale: 1 });
});

test('fade durations are proportionally fitted to a short interval without an opacity jump', () => {
  const annotation = createVideoOverlayAnnotation('arrow', { start: 10, end: 10.2, fadeIn: 1, fadeOut: 1 });
  close(videoOverlayAnnotationState(annotation, 10).opacity, 0);
  close(videoOverlayAnnotationState(annotation, 10.05).opacity, 0.5);
  close(videoOverlayAnnotationState(annotation, 10.1).opacity, 1);
  close(videoOverlayAnnotationState(annotation, 10.15).opacity, 0.5);
  assert.equal(videoOverlayAnnotationState(annotation, 10.2).visible, false);
  const hardIn = createVideoOverlayAnnotation('text', { fadeIn: 0, fadeOut: 0 });
  assert.equal(videoOverlayAnnotationState(hardIn, 0).opacity, 1);
});

test('pop is deterministic across pause, rewind and offline export time order', () => {
  const annotation = createVideoOverlayAnnotation('text', { effect: 'pop', start: 1, end: 3, fadeIn: 0.5 });
  const first = videoOverlayAnnotationState(annotation, 1.1);
  assert.ok(first.scale > 0.75 && first.scale < 1);
  videoOverlayAnnotationState(annotation, 2.8);
  videoOverlayAnnotationState(annotation, 0.5);
  assert.deepEqual(videoOverlayAnnotationState(annotation, 1.1), first);
  assert.deepEqual(videoOverlayAnnotationState(annotation, 1.1), first);
  assert.equal(videoOverlayAnnotationState(annotation, 2).scale, 1);
});

test('saved data validation rejects invalid shapes, unsafe color and non-finite or out-of-range geometry', () => {
  const valid = createVideoOverlayAnnotation('circle');
  for (const change of [
    { x: Number.NaN }, { y: -0.1 }, { x2: 1.01 }, { lineWidth: 0 }, { fontSize: Number.POSITIVE_INFINITY },
    { start: -1 }, { end: valid.start }, { fadeIn: -1 }, { effect: 'javascript' }, { type: 'html' },
    { color: 'url(https://example.test)' }, { text: 'a'.repeat(2001) }, { id: '' },
  ]) assert.throws(() => validateVideoOverlayAnnotation({ ...valid, ...change }));
  assert.throws(() => validateVideoOverlayAnnotation(null));
  assert.throws(() => validateVideoOverlayAnnotation([]));
  const input = { ...valid, text: '施工\r\n区域\u0000', color: '#FF00AA88' };
  const checked = validateVideoOverlayAnnotation(input);
  assert.equal(checked.text, '施工\n区域');
  assert.equal(checked.color, '#ff00aa88');
  assert.equal(input.text, '施工\r\n区域\u0000');
  assert.notEqual(checked, input);
  assert.equal(createVideoOverlayAnnotation('text', { start: 13 }).end, 18);
});

test('normalized placement and 1080p style scale preserve the full-resolution composition', () => {
  const annotation = createVideoOverlayAnnotation('rectangle', { x: 0.1, y: 0.2, x2: 0.4, y2: 0.6, effect: 'none' });
  const small = canvasSpy(), full = canvasSpy();
  drawVideoOverlayAnnotations(small.context, [annotation], { width: 960, height: 540, mediaTime: 1 });
  drawVideoOverlayAnnotations(full.context, [annotation], { width: 3840, height: 2160, mediaTime: 1 });
  const smallRect = small.calls.find(call => call.method === 'strokeRect')!;
  const fullRect = full.calls.find(call => call.method === 'strokeRect')!;
  smallRect.args.forEach((value, index) => close(Number(fullRect.args[index]), Number(value) * 4));
  close(fullRect.lineWidth, smallRect.lineWidth * 4);
  assert.equal(full.context.globalCompositeOperation, 'multiply');
  assert.equal(full.context.lineWidth, 7);
  assert.equal(full.states.length, 0);
  const geometry = videoOverlayAnnotationGeometry(annotation, 3840, 2160);
  assert.equal(geometry.x, 384);
  assert.equal(geometry.y, 432);
  assert.equal(geometry.styleScale, 2);
});

test('Chinese text, explicit newlines and emoji wrap without truncation or broken surrogate pairs', () => {
  const spy = canvasSpy();
  spy.context.font = '20px sans-serif';
  assert.deepEqual(wrapVideoOverlayAnnotationText(spy.context, '施工区域\n安全🚧巡检', 25), ['施工', '区域', '安全', '🚧巡', '检']);
  assert.deepEqual(wrapVideoOverlayAnnotationText(spy.context, 'A\n\nB', 25), ['A', '', 'B']);
  const annotation = createVideoOverlayAnnotation('text', { x: 0.1, y: 0.2, x2: 0.3, text: '施工区域安全巡检', effect: 'none' });
  const preview = canvasSpy(), output = canvasSpy();
  drawVideoOverlayAnnotations(preview.context, [annotation], { width: 960, height: 540, mediaTime: 2 });
  drawVideoOverlayAnnotations(output.context, [annotation], { width: 3840, height: 2160, mediaTime: 2 });
  const previewLines = preview.calls.filter(call => call.method === 'fillText');
  const outputLines = output.calls.filter(call => call.method === 'fillText');
  assert.deepEqual(outputLines.map(call => call.args[0]), previewLines.map(call => call.args[0]));
  previewLines.forEach((call, index) => {
    close(Number(outputLines[index].args[1]), Number(call.args[1]) * 4);
    close(Number(outputLines[index].args[2]), Number(call.args[2]) * 4);
  });
});

test('selection decoration is explicit editor-only and absent from exported pixels', () => {
  const annotation = createVideoOverlayAnnotation('rectangle', { effect: 'none' });
  const editor = canvasSpy(), exported = canvasSpy();
  drawVideoOverlayAnnotations(editor.context, [annotation], { width: 1920, height: 1080, mediaTime: 1, editorOnly: { selectedId: annotation.id } });
  drawVideoOverlayAnnotations(exported.context, [annotation], { width: 1920, height: 1080, mediaTime: 1 });
  assert.equal(editor.calls.filter(call => call.method === 'strokeRect').length, 2);
  assert.equal(exported.calls.filter(call => call.method === 'strokeRect').length, 1);
  assert.equal(exported.calls.some(call => call.method === 'setLineDash' && (call.args[0] as number[]).length > 0), false);
});

test('all four shapes draw through the same timeline; inactive marks never reach the canvas', () => {
  const spy = canvasSpy();
  const annotations = (['text', 'rectangle', 'arrow', 'circle'] as const).map(type => createVideoOverlayAnnotation(type, { effect: 'none', start: 1, end: 3 }));
  assert.equal(drawVideoOverlayAnnotations(spy.context, annotations, { width: 1920, height: 1080, mediaTime: 1 }), 4);
  assert.equal(spy.calls.filter(call => call.method === 'arc').length, 1);
  assert.ok(spy.calls.some(call => call.method === 'lineTo'));
  assert.ok(spy.calls.some(call => call.method === 'fillText'));
  assert.equal(drawVideoOverlayAnnotations(spy.context, annotations, { width: 1920, height: 1080, mediaTime: 3 }), 0);
  assert.throws(() => drawVideoOverlayAnnotations(spy.context, annotations, { width: 0, height: 1080, mediaTime: 1 }));
});

test('draw restores every canvas save even when a text renderer fails', () => {
  const spy = canvasSpy();
  spy.target.fillText = () => { throw new Error('context lost'); };
  assert.throws(() => drawVideoOverlayAnnotations(spy.context, [createVideoOverlayAnnotation('text', { effect: 'none' })], { width: 1920, height: 1080, mediaTime: 1 }), /context lost/);
  assert.equal(spy.states.length, 0);
  assert.equal(spy.context.globalCompositeOperation, 'multiply');
});
