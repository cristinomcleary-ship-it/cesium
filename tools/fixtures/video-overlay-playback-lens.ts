import * as Cesium from 'cesium';
import { undistortPixel } from '../../src/videoArCamera';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { Viewer, PostProcessStage, PostProcessStageComposite, Cartesian2, Cartesian3, Cartesian4 } from 'cesium';
import { createVideoOverlayLensStage, videoOverlayLensStageStats, OVERLAY_LENS_SHADER, overlayLensBounds, overlayTransparencyUniforms } from '../../src/videoOverlayLens';
const viewer = new Viewer('viewer', { baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false, animation: false, timeline: false, fullscreenButton: false, navigationHelpButton: false, infoBox: false, selectionIndicator: false, useDefaultRenderLoop: false, contextOptions: { webgl: { alpha: true, preserveDrawingBuffer: true } }, showRenderLoopErrors: false, useBrowserRecommendedResolution: false });
viewer.scene.renderError.addEventListener((_scene,error)=>{ throw new Error(String(error)+String(error.stack)); });
viewer.scene.globe.show = false; viewer.scene.skyBox.show = false; viewer.scene.skyAtmosphere.show = false; viewer.scene.sun.show = false; viewer.scene.moon.show = false; viewer.scene.highDynamicRange = false; viewer.scene.fog.enabled = false; viewer.scene.postProcessStages.fxaa.enabled = false; viewer.resolutionScale = 1;
const k = { width: 1920, height: 1080, fx: 1500, fy: 1500, cx: 959.5, cy: 539.5 }, lens = { k1: -.24, k2: .08, k3: .015, p1: .002, p2: -.003 };
const gl = viewer.canvas.getContext('webgl2')!;
const gradient = () => new PostProcessStage({ name: crypto.randomUUID(), fragmentShader: 'uniform sampler2D colorTexture; in vec2 v_textureCoordinates; void main(){out_FragColor=vec4(v_textureCoordinates,0.25,1.0);}' });
function render() { viewer.render(); gl.finish(); }
function pixels() { const data = new Uint8Array(viewer.canvas.width * viewer.canvas.height * 4); gl.readPixels(0, 0, viewer.canvas.width, viewer.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data); return data; }
function dims(width: number, height: number) { Object.assign(document.getElementById('viewer')!.style, { width: `${width}px`, height: `${height}px` }); viewer.resize(); }
function measure(frames = 8) { const start = performance.now(); for (let i = 0; i < frames; i++) render(); return (performance.now() - start) / frames; }
(window as unknown as { __lens: unknown }).__lens = { async verify(width = 1920, height = 1080) {
  dims(width, height);
  const bounds = overlayLensBounds(k, lens);
  const values = { ...overlayTransparencyUniforms(viewer.scene), cameraK: new Cartesian4(k.fx, k.fy, k.cx, k.cy), imageSize: new Cartesian2(k.width, k.height), opticalBounds: new Cartesian4(bounds.left, bounds.right, bounds.top, bounds.bottom), radialLens: new Cartesian3(lens.k1, lens.k2, lens.k3), tangentLens: new Cartesian2(lens.p1, lens.p2), overlayOpacity: 1 };
  const referenceShader = OVERLAY_LENS_SHADER.replace('if(max(abs(err.x),abs(err.y))<=0.0000001) break;', '');
  const reference = new PostProcessStage({ name: 'lens-reference', fragmentShader: referenceShader, uniforms: values });
  const baseline = new PostProcessStageComposite({ stages: [gradient(), reference] }); viewer.scene.postProcessStages.add(baseline); render(); render(); const expected = pixels(), oldMs = measure(); viewer.scene.postProcessStages.remove(baseline);
  const accelerated = createVideoOverlayLensStage(viewer.scene, k, lens, { ...overlayTransparencyUniforms(viewer.scene), overlayOpacity: 1 });
  const composite = new PostProcessStageComposite({ stages: [gradient(), accelerated] }); viewer.scene.postProcessStages.add(composite); render(); render(); const actual = pixels(), acceleratedMs = measure(); let maxDelta = 0, changed = 0;
  for (let i = 0; i < expected.length; i++) { const delta = Math.abs(expected[i] - actual[i]); maxDelta = Math.max(maxDelta, delta); if (delta > 1) changed++; }
  const context = (viewer.scene as any).context;
  const framebuffer = new (Cesium as any).Framebuffer({ context, colorTextures: [(accelerated as any)._uniformMap.lensMap()], destroyAttachments: false });
  const lookup = context.readPixels({ width: Math.ceil(width / 2), height, framebuffer }) as Float32Array; framebuffer.destroy();
  let maxGeometryErrorPx = 0;
  for (const y of [0, 1, Math.floor(height * .23), Math.floor(height / 2), height - 2, height - 1]) for (const x of [0, 1, 2, Math.floor(width * .29), Math.floor(width / 2), width - 2, width - 1]) {
    const ray = undistortPixel(k, (x + .5) / width * k.width - .5, (1 - (y + .5) / height) * k.height - .5, lens);
    const u = (ray.x - bounds.left) / (bounds.right - bounds.left), v = 1 - (ray.y - bounds.top) / (bounds.bottom - bounds.top);
    const offset = (y * Math.ceil(width / 2) + Math.floor(x / 2)) * 4 + x % 2 * 2;
    maxGeometryErrorPx = Math.max(maxGeometryErrorPx, Math.hypot((lookup[offset] - u) * width, (lookup[offset + 1] - v) * height));
  }
  const stats = videoOverlayLensStageStats(accelerated); render(); const repeated = videoOverlayLensStageStats(accelerated);
  dims(1280, 720); render(); render(); const resized = videoOverlayLensStageStats(accelerated);
  accelerated.enabled = false; render(); const disabled = videoOverlayLensStageStats(accelerated); viewer.scene.postProcessStages.remove(composite); const destroyed = videoOverlayLensStageStats(accelerated);
  const zero = createVideoOverlayLensStage(viewer.scene, k, {}, { ...overlayTransparencyUniforms(viewer.scene), overlayOpacity: 1 }); viewer.scene.postProcessStages.add(zero); render(); render(); const analytic = videoOverlayLensStageStats(zero); viewer.scene.postProcessStages.remove(zero);
  return { oldMs, acceleratedMs, maxDelta, changed, maxGeometryErrorPx, stats, repeated, resized, disabled, destroyed, analytic, dimensions: [viewer.canvas.width, viewer.canvas.height], renderer: gl.getParameter(gl.RENDERER), contextError: gl.getError() };
}, destroy() { viewer.destroy(); } };
