import * as THREE from 'three';
import { rendererRegression } from './regression';
import { FixedSceneRenderer, type CameraSpec } from './renderer';
import { opticalCamera } from './camera';

const canvas = document.querySelector('canvas')!;
let renderer: FixedSceneRenderer;
const bytes64 = (buffer: ArrayBufferLike) => {
  const bytes = new Uint8Array(buffer); let text = '';
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
};
const api = {
  regression: rendererRegression,
  async init(url: string) {
    const response = await fetch(url); if (!response.ok) throw new Error(`Scene manifest ${response.status}`);
    renderer = new FixedSceneRenderer(canvas);
    await renderer.load(await response.json(), new URL('.', url).href);
    return { triangles: renderer.triangleCount, geometry_version: renderer.geometryVersion };
  },
  render(spec: CameraSpec) {
    const result = renderer.reference(spec);
    const valid = Uint8Array.from(result.depth, z => z > 0 ? 255 : 0);
    return { rgb: result.rgb.split(',')[1], depth: bytes64(result.depth.buffer), ids: bytes64(result.ids.buffer), mask: bytes64(valid.buffer) };
  },
  probe() {
    const probe = new FixedSceneRenderer(document.createElement('canvas'));
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(8, 6), new THREE.MeshBasicMaterial({ color: 0x3080d0, side: THREE.DoubleSide }));
    mesh.position.z = 7.25; mesh.updateMatrixWorld(true); probe.addMesh(mesh); probe.geometryVersion = 'probe';
    const spec = { width: 80, height: 60, K: [67, 0, 36.2, 0, 73, 27.1, 0, 0, 1], T_camera_from_scene: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
    const data = probe.reference(spec), errors = Array.from(data.depth).filter(z => z > 0).map(z => Math.abs(z - 7.25));
    const gl = probe.renderer.getContext(), info = gl.getExtension('WEBGL_debug_renderer_info');
    const result = { framebuffer: 'R32F', expected_camera_z: 7.25, valid_pixels: errors.length,
      maximum_depth_error_m: Math.max(...errors), renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      vendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR), gl_error: gl.getError() };
    const camera = opticalCamera(spec.K, spec.width, spec.height, spec.T_camera_from_scene);
    const point = new THREE.Vector3(1, .5, 7.25).project(camera);
    const pixel = [(point.x + 1) * spec.width / 2 - .5, (1 - point.y) * spec.height / 2 - .5];
    const expected = [67 / 7.25 + 36.2, 73 * .5 / 7.25 + 27.1];
    const projection_error = Math.hypot(pixel[0] - expected[0], pixel[1] - expected[1]);
    probe.dispose();
    if (!errors.length || result.maximum_depth_error_m > 1e-4 || result.gl_error !== 0 || projection_error > 1e-8) throw new Error(JSON.stringify({ ...result, projection_error }));
    return { ...result, projection_error, status: 'PASSED' };
  },
};
Object.assign(window, { arV2Reference: api });
