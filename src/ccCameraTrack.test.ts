import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ccGeodeticToEcef, ccSlerp, ccYawPitchRollToWorldToCamera,
  createCcCameraTrack, mapCcPhotoTimes, parseCcCameraDocument, validateCcIntrinsics, validateCcRotation,
  type CcCameraDataset, type CcPhoto, type CcTrackOptions, type CcVector3,
} from './ccCameraTrack.ts';

function close(actual: number, expected: number, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);
}
function vectorClose(actual: CcVector3, expected: CcVector3, tolerance = 1e-9) {
  close(actual.x, expected.x, tolerance); close(actual.y, expected.y, tolerance); close(actual.z, expected.z, tolerance);
}
function photo(number: number, patch: Partial<CcPhoto> = {}): CcPhoto {
  return { id: String(number), imagePath: `frame_${number}.jpg`, filename: `frame_${number}.jpg`, filenameNumber: number, photogroupId: '0', longitude: 0, latitude: 0, height: 100, worldToCamera: ccYawPitchRollToWorldToCamera(0, 0, 0), ...patch };
}
function dataset(photos: readonly CcPhoto[]): CcCameraDataset {
  return {
    name: 'Synthetic camera path', photos, warnings: [], photogroups: [{ id: '0', name: 'Synthetic camera',
      referenceSystem: { id: '0', name: 'WGS84', definition: 'EPSG:4326', epsg: 4326, heightReference: 'unspecified' },
      intrinsics: { width: 1920, height: 1080, fx: 1000, fy: 1000, cx: 959.5, cy: 539.5, skew: 0 },
      distortion: { k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 },
    }],
  };
}
const options: CcTrackOptions = { firstTimeSeconds: 2, intervalSeconds: 1, mode: 'filename-number', filenameStep: 60, heightReference: 'ellipsoid' };

// A minimal document tree exercises the pure reader without pretending Node has
// DOMParser. Actual string/XML syntax is exercised by the browser integration.
function element(localName: string, content: string | Element[]): Element {
  return { localName, children: typeof content === 'string' ? [] : content, textContent: typeof content === 'string' ? content : content.map(node => node.textContent).join('') } as unknown as Element;
}
function documentFixture(patch: { omitRotation?: boolean; srs?: string; cameraModel?: string; orientation?: string; focalPixels?: string } = {}): Document {
  const e = element;
  const rotation = (pitch: number) => e('Rotation', [e('Yaw', '0'), e('Pitch', String(pitch)), e('Roll', '0')]);
  const center = (z: number) => e('Center', [e('x', '0'), e('y', '0'), e('z', String(z))]);
  const metadata = e('Metadata', [rotation(-90), center(999)]);
  const camera = e('Photogroup', [
    e('Name', 'Synthetic'), e('ImageDimensions', [e('Width', '2000'), e('Height', '1000')]),
    e('CameraModelType', patch.cameraModel ?? 'Perspective'), e('CameraOrientation', patch.orientation ?? 'XRightYDown'),
    e('FocalLength', '10'), e('SensorSize', '20'), ...(patch.focalPixels ? [e('FocalLengthPixels', patch.focalPixels)] : []),
    e('AspectRatio', '1.2'), e('Skew', '0.1'), e('PrincipalPoint', [e('x', '990'), e('y', '490')]),
    e('Distortion', [e('K1', '.01'), e('K2', '.02'), e('K3', '.03'), e('P1', '.04'), e('P2', '.05')]),
    e('Photo', [e('Id', '0'), e('ImagePath', 'C:\\synthetic\\frame_000060.jpg'), e('Pose', [
      ...(!patch.omitRotation ? [rotation(0)] : []), center(100), metadata,
    ])]),
  ]);
  return { documentElement: e('BlocksExchange', [
    e('SpatialReferenceSystems', [e('SRS', [e('Id', '0'), e('Name', 'Synthetic SRS'), e('Definition', patch.srs ?? 'EPSG:4326')])]),
    e('Block', [e('Name', 'Synthetic block'), e('SRSId', '0'), e('Photogroups', [camera])]),
  ]) } as unknown as Document;
}

test('document reader consumes optimized direct Pose, largest sensor dimension and CC Brown coefficient order', () => {
  const source = parseCcCameraDocument(documentFixture());
  assert.equal(source.photos[0].height, 100, 'metadata height 999 must not be consumed');
  close(source.photos[0].worldToCamera[8], 0, 1e-12);
  assert.equal(source.photos[0].filename, 'frame_000060.jpg');
  assert.equal(source.photos[0].filenameNumber, 60);
  assert.deepEqual(source.photogroups[0].intrinsics, { width: 2000, height: 1000, fx: 1000, fy: 1200, cx: 990, cy: 490, skew: .1 });
  assert.deepEqual(source.photogroups[0].distortion, { k1: .01, k2: .02, k3: .03, p1: .05, p2: .04 });
  assert.equal(source.photogroups[0].referenceSystem.heightReference, 'unspecified');
  assert.equal(parseCcCameraDocument(documentFixture({ srs: 'EPSG:4979', focalPixels: '2000' })).photogroups[0].intrinsics.fx, 2000);
});

test('document reader cannot silently substitute nested Metadata or unsupported camera/reference frames', () => {
  assert.throws(() => parseCcCameraDocument(documentFixture({ omitRotation: true })), /缺少 Pose\/Rotation/);
  assert.throws(() => parseCcCameraDocument(documentFixture({ srs: 'EPSG:3857' })), /EPSG:4326/);
  assert.throws(() => parseCcCameraDocument(documentFixture({ cameraModel: 'Fisheye' })), /鱼眼/);
  assert.throws(() => parseCcCameraDocument(documentFixture({ orientation: 'XRightYUp' })), /XRightYDown/);
});

test('Bentley YPR zero, clockwise yaw, downward pitch and roll follow the documented world-to-camera matrix', () => {
  const north = ccYawPitchRollToWorldToCamera(0, 0, 0);
  [1, 0, 0, 0, 0, -1, 0, 1, 0].forEach((n, i) => close(north[i], n));
  const east = ccYawPitchRollToWorldToCamera(90, 0, 0);
  [0, -1, 0, 0, 0, -1, 1, 0, 0].forEach((n, i) => close(east[i], n));
  const down = ccYawPitchRollToWorldToCamera(0, -90, 0);
  [1, 0, 0, 0, -1, 0, 0, 0, -1].forEach((n, i) => close(down[i], n));
  const rolled = ccYawPitchRollToWorldToCamera(0, 0, 90);
  [0, 0, 1, 1, 0, 0, 0, 1, 0].forEach((n, i) => close(rolled[i], n));
  validateCcRotation(ccYawPitchRollToWorldToCamera(-28.7, -29, -0.3));
});

test('numeric filename timing preserves dropped-photo gaps and sorts by the explicit index', () => {
  const times = mapCcPhotoTimes([photo(180), photo(0), photo(60)], options);
  assert.deepEqual(times.map(frame => [frame.photo.filenameNumber, frame.time]), [[0, 2], [60, 3], [180, 5]]);
  const ordinal = mapCcPhotoTimes([photo(180), photo(0), photo(60)], { ...options, mode: 'ordinal' });
  assert.deepEqual(ordinal.map(frame => [frame.photo.filenameNumber, frame.time]), [[180, 2], [0, 3], [60, 4]]);
  assert.throws(() => mapCcPhotoTimes([photo(0), photo(60)], { ...options, filenameStep: undefined }), /编号步长/);
  assert.throws(() => mapCcPhotoTimes([photo(0), photo(70)], options), /步长不一致/);
  assert.throws(() => mapCcPhotoTimes([photo(0), photo(0)], options), /重复/);
  assert.throws(() => mapCcPhotoTimes([photo(0, { filenameNumber: null })], options), /数字编号/);
  assert.throws(() => mapCcPhotoTimes([photo(0)], { ...options, intervalSeconds: 0 }), /大于 0/);
  assert.throws(() => mapCcPhotoTimes([photo(0)], { ...options, firstTimeSeconds: -1 }), /不能小于 0/);
});

test('geodetic position conversion uses WGS84 ellipsoid metres, including polar and antimeridian cases', () => {
  vectorClose(ccGeodeticToEcef(0, 0, 100), { x: 6378237, y: 0, z: 0 });
  vectorClose(ccGeodeticToEcef(90, 0, 0), { x: 0, y: 6378137, z: 0 }, 1e-8);
  vectorClose(ccGeodeticToEcef(180, 0, 0), { x: -6378137, y: 0, z: 0 }, 1e-8);
  vectorClose(ccGeodeticToEcef(0, 90, 0), { x: 0, y: 0, z: 6356752.314245179 }, 1e-8);
});

test('sample provides an ECEF camera direction/up and interpolates position in world coordinates', () => {
  const track = createCcCameraTrack(dataset([photo(0), photo(60, { height: 120 })]), options);
  const first = track.sample(2)!;
  vectorClose(first.position, { x: 6378237, y: 0, z: 0 });
  vectorClose(first.direction, { x: 0, y: 0, z: 1 }); // north at lon=lat=0
  vectorClose(first.up, { x: 1, y: 0, z: 0 }); // geodetic up
  vectorClose(track.sample(2.5)!.position, { x: 6378247, y: 0, z: 0 });
  close(track.sample(2.5)!.interpolation, 0.5);
  close(track.sample(3)!.position.x, 6378257);
  assert.equal(track.sample(1.999), null); assert.equal(track.sample(3.001), null);
  assert.equal(track.sample(NaN), null); assert.equal(track.sample(Infinity), null);
});

test('ECEF linear interpolation crosses the antimeridian along the short world segment', () => {
  const track = createCcCameraTrack(dataset([photo(0, { longitude: 179.999 }), photo(60, { longitude: -179.999 })]), options);
  const midpoint = track.sample(2.5)!;
  assert.ok(midpoint.position.x < -6378000);
  close(midpoint.position.y, 0, 1e-8);
});

test('camera attitude SLERP crosses ±180 yaw via the shortest arc and stays orthonormal', () => {
  const track = createCcCameraTrack(dataset([
    photo(0, { worldToCamera: ccYawPitchRollToWorldToCamera(179, 0, 0) }),
    photo(60, { worldToCamera: ccYawPitchRollToWorldToCamera(-179, 0, 0) }),
  ]), options);
  const middle = track.sample(2.5)!;
  vectorClose(middle.direction, { x: 0, y: 0, z: -1 }); // south, not north
  close(Math.hypot(middle.direction.x, middle.direction.y, middle.direction.z), 1);
  close(middle.direction.x * middle.up.x + middle.direction.y * middle.up.y + middle.direction.z * middle.up.z, 0);
  const q = ccSlerp({ x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 0, w: -1 }, 0.5);
  close(Math.abs(q.w), 1);
});

test('unknown vertical datum requires an explicit choice; the explicit height offset is applied exactly once', () => {
  const source = dataset([photo(0), photo(60)]);
  assert.throws(() => createCcCameraTrack(source, { ...options, heightReference: undefined } as unknown as CcTrackOptions), /请选择 XML 高程基准/);
  assert.throws(() => createCcCameraTrack(source, { ...options, heightReference: 'offset-to-ellipsoid' }), /高程改正量/);
  const corrected = createCcCameraTrack(source, { ...options, heightReference: 'offset-to-ellipsoid', heightOffsetMeters: 12.5 });
  close(corrected.sample(2)!.position.x, 6378249.5);
  const ellipsoidal: CcCameraDataset = { ...source, photogroups: [{ ...source.photogroups[0], referenceSystem: { ...source.photogroups[0].referenceSystem, epsg: 4979, heightReference: 'ellipsoid' } }] };
  assert.throws(() => createCcCameraTrack(ellipsoidal, { ...options, heightReference: 'offset-to-ellipsoid', heightOffsetMeters: 12.5 }), /重复/);
});

test('invalid intrinsics, reflection matrices, incomplete rotations, and non-finite attitudes fail explicitly', () => {
  const intrinsics = dataset([photo(0)]).photogroups[0].intrinsics;
  assert.throws(() => validateCcIntrinsics({ ...intrinsics, fx: 0 }), /大于 0/);
  assert.throws(() => validateCcIntrinsics({ ...intrinsics, width: 1920.5 }), /整数/);
  assert.throws(() => validateCcIntrinsics({ ...intrinsics, cy: NaN }), /有限/);
  assert.throws(() => validateCcRotation([1, 0, 0, 0, 1, 0, 0, 0, -1]), /镜像/);
  assert.throws(() => validateCcRotation([1, 0, 0]), /9 个/);
  assert.throws(() => ccYawPitchRollToWorldToCamera(NaN, 0, 0), /有限/);
});
