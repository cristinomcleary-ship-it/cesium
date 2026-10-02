import * as THREE from 'three';
import { FixedSceneRenderer, type FrameImage, type Pose } from './renderer';
import { opticalCamera } from './camera';

/** GPU tests use independent analytic planes and image colors, never telemetry or old AR math. */
export async function rendererRegression() {
  const checks: Array<{ name: string; passed: boolean; details?: unknown }> = [];
  const check = (name: string, passed: boolean, details?: unknown) => { checks.push({ name, passed, details }); };
  const plane = (width: number, height: number, z: number, color: number) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    mesh.position.z = z; mesh.updateMatrixWorld(true); return mesh;
  };
  const renderer = new FixedSceneRenderer(document.createElement('canvas'));
  renderer.geometryVersion = 'synthetic-v1'; renderer.addMesh(plane(12, 10, 7.25, 0x204080));
  const pose: Pose = { width: 160, height: 120, K: [131, 0, 73.2, 0, 145, 57.1, 0, 0, 1],
    T_camera_from_scene: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    status: 'LOCALIZED', geometry_version: 'synthetic-v1', source_video_hash: 'synthetic-video', original_frame_id: 1,
    original_pts: 1001, time_base: '1/30000', camera_profile_id: 'synthetic-camera', calibration_version: '1' };
  const source = document.createElement('canvas'); source.width = pose.width; source.height = pose.height;
  const context = source.getContext('2d')!;
  const colors = [[220, 40, 30], [20, 190, 60], [30, 60, 220], [230, 180, 30]];
  for (let i = 0; i < 4; i++) { context.fillStyle = `rgb(${colors[i].join(',')})`; context.fillRect((i % 2) * 80, Math.floor(i / 2) * 60, 80, 60); }
  const frame: FrameImage = { ...pose, image: source };
  const observer = opticalCamera(pose.K, pose.width, pose.height, pose.T_camera_from_scene);
  const colorAt = (x: number, y: number) => {
    const gl = renderer.renderer.getContext(), rgba = new Uint8Array(4);
    gl.readPixels(Math.round(x), pose.height - 1 - Math.round(y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    return [...rgba].slice(0, 3);
  };
  const closeColor = (actual: number[], expected: number[]) => actual.every((value, i) => Math.abs(value - expected[i]) <= 2);
  const accepted = await renderer.commit(frame, pose);
  renderer.render(observer, pose.width, pose.height);
  check('accept-valid-frame', accepted);
  for (const [index, [x, y]] of [[40, 30], [120, 30], [40, 90], [120, 90]].entries()) {
    const actual = colorAt(x, y); check(`image-direction-and-linear-color-${index}`, closeColor(actual, colors[index]), { actual, expected: colors[index] });
  }
  // A source canvas mutation must not update the already committed frame.
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, 160, 120);
  renderer.render(observer, 160, 120); check('snapshot-does-not-follow-live-source', closeColor(colorAt(40, 30), colors[0]));
  const shifted = [...pose.T_camera_from_scene]; shifted[3] = -1.5;
  const observer2 = opticalCamera(pose.K, 160, 120, shifted);
  renderer.render(observer2, 160, 120);
  const world = new THREE.Vector3((40 - pose.K[2]) * 7.25 / pose.K[0], (30 - pose.K[5]) * 7.25 / pose.K[4], 7.25);
  const ndc = world.project(observer2);
  check('source-projection-independent-of-observer', closeColor(colorAt((ndc.x + 1) * 80 - .5, (1 - ndc.y) * 60 - .5), colors[0]));
  const rejected = await renderer.commit(frame, { ...pose, status: 'LOST' });
  renderer.render(observer, 160, 120);
  check('lost-restores-original-texture', !rejected && closeColor(colorAt(40, 30), [32, 64, 128]));
  let identityError = false;
  try { await renderer.commit({ ...frame, original_pts: 2002 }, pose); } catch { identityError = true; }
  check('mismatched-pts-rejected', identityError && renderer.committed === null);
  const pending = renderer.commit(frame, pose); renderer.cancel();
  check('seek-cancels-pending-frame', !(await pending) && renderer.committed === null);
  renderer.dispose();

  const slope = new FixedSceneRenderer(document.createElement('canvas'));
  const slopedMesh = plane(14, 10, 15, 0x204080); slopedMesh.rotation.y = .82; slopedMesh.updateMatrixWorld(true); slope.addMesh(slopedMesh);
  const spec = { ...pose, width: 160, height: 120 };
  const reference = slope.reference(spec);
  const normal = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), .82);
  const errors: number[] = [];
  for (let y = 2; y < 118; y += 3) for (let x = 2; x < 158; x += 3) {
    const measured = reference.depth[y * 160 + x]; if (!(measured > 0)) continue;
    const ray = new THREE.Vector3((x - pose.K[2]) / pose.K[0], (y - pose.K[5]) / pose.K[4], 1);
    const expected = normal.z * 15 / normal.dot(ray); errors.push(Math.abs(expected - measured));
  }
  check('sloped-plane-depth-at-pixel-center', errors.length > 100 && Math.max(...errors) < .001, { samples: errors.length, maximum_m: Math.max(...errors) });
  slope.geometryVersion = pose.geometry_version;
  await slope.commit(frame, pose); slope.render(observer, 160, 120);
  const slopePixels = new Uint8Array(160 * 120 * 4), gl = slope.renderer.getContext();
  gl.readPixels(0, 0, 160, 120, gl.RGBA, gl.UNSIGNED_BYTE, slopePixels);
  const validCount = Array.from(reference.depth).filter(z => z > 0).length;
  let projectedCount = 0;
  for (let i = 0; i < slopePixels.length; i += 4) if (slopePixels[i] > 250 && slopePixels[i + 1] > 250 && slopePixels[i + 2] > 250) projectedCount++;
  check('slope-plane-correction-and-coplanar-triangle-seams', projectedCount / validCount > .9, { projectedCount, validCount });
  slope.dispose();
  const idsProbe = new FixedSceneRenderer(document.createElement('canvas'));
  idsProbe.triangleCount = 23057;
  idsProbe.addMesh(plane(12, 10, 7.25, 0x204080));
  const idsResult = idsProbe.reference(pose);
  const positions = idsProbe.entries[0].mesh.geometry.getAttribute('position');
  let idMisses = 0, idSamples = 0;
  const raycaster = new THREE.Raycaster(); raycaster.near = 0; raycaster.far = 3000;
  for (let y = 8; y < 112; y += 7) for (let x = 8; x < 152; x += 7) {
    const direction = new THREE.Vector3((x - pose.K[2]) / pose.K[0], (y - pose.K[5]) / pose.K[4], 1).normalize();
    const ray = new THREE.Ray(new THREE.Vector3(), direction), hit = new THREE.Vector3();
    let expected = -1;
    for (let triangle = 0; triangle < 2; triangle++) {
      const a = new THREE.Vector3().fromBufferAttribute(positions, triangle * 3);
      const b = new THREE.Vector3().fromBufferAttribute(positions, triangle * 3 + 1);
      const c = new THREE.Vector3().fromBufferAttribute(positions, triangle * 3 + 2);
      if (ray.intersectTriangle(a, b, c, false, hit)) { expected = 23057 + triangle; break; }
    }
    if (expected >= 0) { idSamples++; if (idsResult.ids[y * 160 + x] !== expected) idMisses++; }
  }
  check('large-triangle-id-survives-perspective-interpolation', idSamples > 100 && idMisses === 0, { samples: idSamples, mismatches: idMisses });
  idsProbe.dispose();
  const occlusion = new FixedSceneRenderer(document.createElement('canvas'));
  occlusion.geometryVersion = pose.geometry_version;
  occlusion.addMesh(plane(14, 12, 7.25, 0x204080));
  occlusion.addMesh(plane(1, 4, 4, 0x209040));
  await occlusion.commit(frame, pose);
  const sideT = [...pose.T_camera_from_scene]; sideT[3] = -3;
  const sideCamera = opticalCamera(pose.K, 160, 120, sideT);
  occlusion.render(sideCamera, 160, 120);
  const readWorld = (worldPoint: THREE.Vector3) => {
    const ndc = worldPoint.project(sideCamera), rgba = new Uint8Array(4), gl = occlusion.renderer.getContext();
    gl.readPixels(Math.round((ndc.x + 1) * 80 - .5), Math.round((ndc.y + 1) * 60 - .5), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    return Array.from(rgba).slice(0, 3);
  };
  check('occluded-back-surface-keeps-original-texture', closeColor(readWorld(new THREE.Vector3(0, 0, 7.25)), [32, 64, 128]));
  check('source-visible-back-surface-receives-video', closeColor(readWorld(new THREE.Vector3(2, 0, 7.25)), [255, 255, 255]));
  const maskCanvas = document.createElement('canvas'); maskCanvas.width = 160; maskCanvas.height = 120;
  const maskContext = maskCanvas.getContext('2d')!; maskContext.fillStyle = 'white'; maskContext.fillRect(0, 0, 160, 120);
  maskContext.fillStyle = 'black'; maskContext.fillRect(100, 45, 20, 25);
  await occlusion.commit({ ...frame, validMask: maskCanvas }, pose); occlusion.render(sideCamera, 160, 120);
  check('invalid-rectification-mask-keeps-original-texture', closeColor(readWorld(new THREE.Vector3(2, 0, 7.25)), [32, 64, 128]));
  for (const key of ['geometry_version', 'camera_profile_id', 'calibration_version'] as const) {
    let rejected = false;
    try { await occlusion.commit(frame, { ...pose, [key]: 'wrong-identity' }); } catch { rejected = true; }
    check(`reject-${key}`, rejected && occlusion.committed === null);
  }
  occlusion.dispose();
  return { status: checks.every(check => check.passed) ? 'PASSED' : 'FAILED', checks };
}
