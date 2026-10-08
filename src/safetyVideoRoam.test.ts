import test from "node:test";
import assert from "node:assert/strict";
import * as C from "cesium";
import { createVideoRoam, type VideoRoamTrack } from "./presentationV5/video-roam.js";
import { adaptSafetyVideoRoam, loadSafetyVideoRoamSource, roamLibraryFile } from "./safetyVideoRoamData.ts";
import { SafetyVideoRoam, type SafetyVideoRoamState } from "./safetyVideoRoam.ts";
import type { LibraryRecord } from "./projectLibrary.ts";

/** CPU-only fixtures. None are persisted or injected into a real project. */
function fixture() {
  const record: LibraryRecord = { version: 1, id: "test-record", name: "CPU-only fixture", kind: "Drone Video", visible: true,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", settings: { video: { controls: { videoArHeightMode: "estimated", videoArTimeOffset: "0" } } },
    files: { source: { name: "source.json", url: "/__library/files/test-record/source/source.json" }, video: { name: "record.mp4", url: "/__library/files/test-record/video/record.mp4" } } };
  const raw = { schema_version: "cesium-dji-trajectory/v1", source_crs: "WGS84", flight_info: { generator: "DJI 航拍视频信息提取器 CPU fixture",
    video_file: "X:/CPU-fixture/record.mp4", timeline: "exact SRT PTS anchored to source timestamps", altitude_reference: "ellipsoidal",
    video: { size_bytes: 10000, width: 1920, height: 1080, duration_ms: 4000, frame_rate_fps: 10 } },
    trajectory_points: Array.from({ length: 41 }, (_, i) => ({ video_time_ms: i * 100, source_timestamp_ms: 1700000000000 + i * 100,
      position: { longitude: 120 + i * .000001, latitude: 30, altitude: 100 + i / 10, relative_altitude: 40 + i / 10 } })) };
  const decoded = { name: "record.mp4", sizeBytes: 10000, width: 1920, height: 1080, durationSeconds: 4 };
  return { record, raw, decoded };
}

class VideoStub extends EventTarget {
  tagName = "VIDEO"; src = "blob:record"; currentSrc = "blob:record"; srcObject = null;
  currentTime = 0; duration = 4; videoWidth = 1920; videoHeight = 1080; readyState = 4;
  paused = true; seeking = false; ended = false; error = null; playbackRate = 1;
  pending = new Map<number, VideoFrameRequestCallback>(); nextId = 0;
  requestVideoFrameCallback(callback: VideoFrameRequestCallback) { const id = ++this.nextId; this.pending.set(id, callback); return id; }
  cancelVideoFrameCallback(id: number) { this.pending.delete(id); }
  frame(mediaTime: number, now = 1000) {
    const first = this.pending.entries().next().value;
    if (!first) return false;
    const [id, callback] = first; this.pending.delete(id);
    callback(now, { mediaTime, expectedDisplayTime: now + 7, presentationTime: now - 2, presentedFrames: id,
      width: 1920, height: 1080, processingDuration: .003 }); return true;
  }
  fire(type: string) { this.dispatchEvent(new Event(type)); }
}

function harness() {
  const video = new VideoStub(), canvas = new EventTarget(), entities = new C.EntityCollection();
  const views: Array<{ destination: C.Cartesian3; orientation: { direction: C.Cartesian3; up: C.Cartesian3 } }> = [];
  const camera = { transform: C.Matrix4.clone(C.Matrix4.IDENTITY), positionWC: C.Cartesian3.fromDegrees(120, 30, 500),
    directionWC: new C.Cartesian3(0, 1, 0), upWC: new C.Cartesian3(0, 0, 1), cancelledFlights: 0,
    setView(value: { destination: C.Cartesian3; orientation: { direction: C.Cartesian3; up: C.Cartesian3 } }) {
      views.push({ destination: C.Cartesian3.clone(value.destination), orientation: { direction: C.Cartesian3.clone(value.orientation.direction), up: C.Cartesian3.clone(value.orientation.up) } });
      this.positionWC = C.Cartesian3.clone(value.destination);
    }, cancelFlight() { this.cancelledFlights++; } };
  const viewer = { scene: { mode: C.SceneMode.SCENE3D, canvas, requestRender() {} }, camera, entities, isDestroyed: () => false, trackedEntity: undefined as unknown };
  const { record, raw, decoded } = fixture();
  const data = adaptSafetyVideoRoam(record, raw, decoded);
  assert.ok(data.available && data.track);
  const start = (track: VideoRoamTrack = data.track!, options = {}) => {
    const result = createVideoRoam({ Cesium: C, viewer: viewer as unknown as C.Viewer, videoElement: video as unknown as HTMLVideoElement,
      videoId: "video:test-record", track, maxGapSeconds: .25, maxSegmentMeters: 250, showMarker: true, ...options });
    assert.ok(result.ok); return result.controller;
  };
  return { video, canvas, entities, camera, viewer, views, track: data.track!, start, record, raw, decoded };
}

test("adapter requires real metadata identity, explicit source timeline and a verified height reference", () => {
  const { record, raw, decoded } = fixture(); const original = JSON.stringify({ record, raw, decoded });
  assert.equal(adaptSafetyVideoRoam(record, raw, decoded).available, true);
  assert.equal(JSON.stringify({ record, raw, decoded }), original);
  assert.equal(adaptSafetyVideoRoam(record, raw, { ...decoded, sizeBytes: 9999 }).available, false);
  assert.equal(adaptSafetyVideoRoam(record, raw, { ...decoded, width: 3840 }).available, false);
  assert.equal(adaptSafetyVideoRoam(record, raw, { ...decoded, durationSeconds: 4.3 }).available, false);
  assert.equal(adaptSafetyVideoRoam(record, raw, decoded, "video:other").available, false);
  raw.flight_info.altitude_reference = "absolute";
  const blocked = adaptSafetyVideoRoam(record, raw, decoded);
  assert.equal(blocked.available, false); assert.equal(blocked.audit.timelineMatched, true); assert.equal(blocked.audit.recordingMatched, true);
  assert.match(blocked.audit.missing.join(" "), /高程基准未知/); assert.equal(blocked.track, undefined);
  record.settings.video!.controls = { videoArHeightMode: "source", videoArSourceHeightOffset: "0" };
  assert.equal(adaptSafetyVideoRoam(record, raw, decoded).available, false, "unproven numerical offsets cannot fabricate a verified datum");
});

test("verified height conversion is bound to the record/evidence and never overwrites raw altitude", () => {
  const { record, raw, decoded } = fixture(); raw.flight_info.altitude_reference = "absolute";
  record.settings.video!.roamVerticalReference = { status: "verified", recordId: record.id, targetReference: "EPSG:4979",
    sourceReference: "CPU test datum", evidence: "CPU test control point", method: "source-offset", sourceToEllipsoidOffsetMeters: 12 };
  const before = JSON.stringify(raw), data = adaptSafetyVideoRoam(record, raw, decoded);
  assert.equal(data.available, true); assert.ok(Math.abs(C.Cartographic.fromCartesian(C.Cartesian3.fromElements(data.track!.samples[0].position.x, data.track!.samples[0].position.y, data.track!.samples[0].position.z)).height - 112) < 1e-6);
  assert.equal(JSON.stringify(raw), before);
  (record.settings.video!.roamVerticalReference as Record<string, unknown>).recordId = "another-record";
  assert.equal(adaptSafetyVideoRoam(record, raw, decoded).available, false);
});

test("media PTS offset is explicit, UTC is checked and no filename supplies missing time", () => {
  const { record, raw, decoded } = fixture(); record.settings.video!.controls = { videoArTimeOffset: "0.5" };
  const data = adaptSafetyVideoRoam(record, raw, decoded);
  assert.equal(data.audit.telemetryEpochAtMediaZeroMs, 1700000000500);
  assert.equal(data.track!.samples[0].timeSeconds, 0);
  assert.deepEqual(data.track!.samples[0].position, C.Cartesian3.fromDegrees(raw.trajectory_points[5].position.longitude, 30, 100.5));
  raw.trajectory_points[20].source_timestamp_ms += 10;
  assert.equal(adaptSafetyVideoRoam(record, raw, decoded).available, false);
  raw.trajectory_points[20].source_timestamp_ms = NaN;
  assert.equal(adaptSafetyVideoRoam(record, raw, decoded).available, false);
  raw.trajectory_points[20].source_timestamp_ms = 1700000002000;
  record.settings.video!.controls = { videoArTimeOffset: "120" };
  const outside = adaptSafetyVideoRoam(record, raw, decoded);
  assert.equal(outside.available, false); assert.match(outside.audit.missing.join(" "), /视频偏移后/);
});

test("a malformed/nonmonotonic position is not silently removed to bridge a telemetry gap", () => {
  const { record, raw, decoded } = fixture();
  raw.trajectory_points[10].position.latitude = NaN;
  assert.equal(adaptSafetyVideoRoam(record, raw, decoded).available, false);
  raw.trajectory_points[10].position.latitude = 30; raw.trajectory_points[10].video_time_ms = 800;
  assert.equal(adaptSafetyVideoRoam(record, raw, decoded).available, false);
});

test("record loader permits only this recording's local library files and makes no writes", async () => {
  const { record, raw } = fixture(), calls: Array<[string, string]> = [];
  const request: typeof fetch = async (url, init) => {
    calls.push([String(url), init?.method || "GET"]);
    if (String(url).includes("/records/")) return new Response(JSON.stringify(record));
    if (init?.method === "HEAD") return new Response(null, { headers: { "content-length": "10000" } });
    return new Response(JSON.stringify(raw));
  };
  const loaded = await loadSafetyVideoRoamSource(record.id, undefined, request);
  assert.equal(loaded.sizeBytes, 10000); assert.deepEqual(calls.map(([, method]) => method).sort(), ["GET", "GET", "HEAD"]);
  assert.equal(roamLibraryFile("test-record", "https://example.org/private", "source"), undefined);
  assert.equal(roamLibraryFile("test-record", "/__library/files/other/source/file.json", "source"), undefined);
  assert.equal(roamLibraryFile("test-record", "/__library/files/test-record/source/a.json?x=1", "source"), undefined);
  record.files.source.url = "https://example.org/source.json";
  await assert.rejects(loadSafetyVideoRoamSource(record.id, undefined, request), /缺少/);
});

test("25/50/75 percent seek positions follow media seconds and retain source points and transform", () => {
  const h = harness(), before = JSON.stringify(h.track), matrix = C.Matrix4.clone(h.camera.transform), core = h.start(); core.start();
  for (const time of [1, 2, 3]) {
    h.video.currentTime = time; h.video.seeking = true; h.video.fire("seeking"); h.video.seeking = false; h.video.fire("seeked");
    assert.equal(core.getState().mediaTime, time);
    assert.ok(C.Cartesian3.equals(h.camera.positionWC, new C.Cartesian3(...[h.track.samples[time * 10].position.x, h.track.samples[time * 10].position.y, h.track.samples[time * 10].position.z])));
  }
  assert.equal(JSON.stringify(h.track), before); assert.ok(C.Matrix4.equals(h.camera.transform, matrix));
  core.destroy(); assert.equal(h.entities.values.length, 0);
});

test("requestVideoFrameCallback mediaTime wins over advanced currentTime and records actual callback delay", () => {
  const h = harness(), core = h.start(); h.video.paused = false; core.start(); h.video.currentTime = 1.03; h.video.frame(1, 1234);
  assert.equal(core.getState().mediaTime, 1); assert.equal(core.getState().clockSource, "requestVideoFrameCallback.mediaTime");
  assert.ok(C.Cartesian3.equals(h.camera.positionWC, new C.Cartesian3(h.track.samples[10].position.x, h.track.samples[10].position.y, h.track.samples[10].position.z)));
  assert.equal(core.getState().lastFrameTiming!.callbackToExpectedDisplayMs, 7);
  assert.ok(Math.abs(core.getState().lastFrameTiming!.mediaCurrentTimeDeltaMs! - 30) < 1e-8);
  assert.equal(h.video.pending.size, 1); core.destroy(); assert.equal(h.video.pending.size, 0);
});

test("browsers without RVFC sample currentTime without creating another simulation clock", () => {
  const h = harness(), frames = new Map<number, FrameRequestCallback>(); let next = 0;
  Object.defineProperties(h.video, { requestVideoFrameCallback: { value: undefined }, cancelVideoFrameCallback: { value: undefined },
    ownerDocument: { value: { defaultView: { requestAnimationFrame: (callback: FrameRequestCallback) => { const id = ++next; frames.set(id, callback); return id; },
      cancelAnimationFrame: (id: number) => frames.delete(id) } } } });
  const core = h.start(); h.video.paused = false; core.start(); h.video.currentTime = 1.5;
  const [id, callback] = frames.entries().next().value!; frames.delete(id); callback(1000);
  assert.equal(core.getState().mediaTime, 1.5); assert.equal(core.getState().clockSource, "video.currentTime");
  h.video.paused = true; h.video.fire("pause"); assert.equal(frames.size, 0); core.destroy();
});

test("pause and buffering stop frame updates; seek while paused updates once immediately", () => {
  const h = harness(), core = h.start(); h.video.paused = false; core.start(); h.video.currentTime = 1; h.video.frame(1);
  h.video.paused = true; h.video.fire("pause"); const count = h.views.length, camera = C.Cartesian3.clone(h.camera.positionWC);
  assert.equal(h.video.pending.size, 0); assert.equal(h.video.frame(3, 4000), false); assert.equal(h.views.length, count); assert.ok(C.Cartesian3.equals(h.camera.positionWC, camera));
  h.video.currentTime = .5; h.video.seeking = true; h.video.fire("seeking"); assert.equal(h.views.length, count);
  h.video.seeking = false; h.video.fire("seeked"); assert.equal(h.views.length, count + 1); assert.equal(core.getState().mediaTime, .5);
  h.video.paused = false; h.video.fire("playing"); h.video.fire("waiting"); const waitingCount = h.views.length;
  h.video.currentTime = 2; assert.equal(h.video.frame(2), false); assert.equal(h.views.length, waitingCount);
  h.video.fire("playing"); assert.equal(core.getState().mediaTime, 2); core.destroy();
});

test("playback rate is never multiplied into position time, and telemetric gaps are never bridged", () => {
  const h = harness(), core = h.start(); h.video.paused = false; core.start(); h.video.playbackRate = 2; h.video.currentTime = 1; h.video.fire("ratechange");
  assert.equal(core.getState().mediaTime, 1); assert.ok(C.Cartesian3.equals(h.camera.positionWC, new C.Cartesian3(h.track.samples[10].position.x, h.track.samples[10].position.y, h.track.samples[10].position.z))); core.destroy();
  const gapped = { ...h.track, samples: h.track.samples.filter(p => p.timeSeconds <= 1 || p.timeSeconds >= 3) }, blocked = h.start(gapped);
  h.video.currentTime = 0; blocked.start(); h.video.currentTime = 2; h.video.frame(2);
  assert.equal(blocked.getState().code, "TELEMETRY_TIME_GAP"); assert.equal(h.video.pending.size, 0); blocked.destroy();
});

test("out of range and spatial jumps halt, while endpoint/error keep the last valid camera", () => {
  const h = harness(), core = h.start(); core.start(); h.video.currentTime = 5; core.sync(); assert.equal(core.getState().code, "OUTSIDE_TRACK_RANGE");
  h.video.currentTime = 2; core.start(); const previous = C.Cartesian3.clone(h.camera.positionWC); h.video.ended = true; h.video.fire("ended");
  assert.ok(C.Cartesian3.equals(h.camera.positionWC, previous)); assert.equal(h.entities.values[0].show, true); core.destroy();
  h.video.ended = false; const jumped = structuredClone(h.track); jumped.samples[1].position = C.Cartesian3.fromDegrees(121, 31, 100);
  const second = h.start(jumped); h.video.currentTime = .05; second.start(); assert.equal(second.getState().code, "TELEMETRY_SPATIAL_GAP"); second.destroy();
});

test("pointer/wheel release ownership without pausing video; no second roam can take the same camera", () => {
  const h = harness(), core = h.start(); h.video.paused = false; core.start(); const other = h.start(); other.start();
  assert.equal(other.getState().code, "CAMERA_BUSY"); h.canvas.dispatchEvent(new Event("pointerdown"));
  assert.equal(core.getState().state, "user-interrupted"); assert.equal(h.video.paused, false); assert.equal(h.video.pending.size, 0);
  other.start(); assert.equal(other.getState().enabled, true); h.canvas.dispatchEvent(new Event("wheel"));
  assert.equal(other.getState().state, "user-interrupted"); core.destroy(); other.destroy();
});

test("source change, tracked entity and changed reference frame stop the old binding", () => {
  const h = harness(), core = h.start(); core.start(); h.viewer.trackedEntity = {}; core.sync(); assert.equal(core.getState().code, "TRACKED_ENTITY_ACTIVE");
  h.viewer.trackedEntity = undefined; core.start(); h.camera.transform = C.Matrix4.fromTranslation(new C.Cartesian3(1, 0, 0)); core.sync(); assert.equal(core.getState().code, "CAMERA_TRANSFORM_CHANGED");
  h.camera.transform = C.Matrix4.clone(C.Matrix4.IDENTITY); core.start(); h.video.currentSrc = h.video.src = "blob:replacement"; h.video.fire("loadstart");
  assert.equal(core.getState().code, "VIDEO_SOURCE_CHANGED"); assert.equal(core.getState().enabled, false); core.destroy();
  assert.equal(core.getState().listenerCount, 0); assert.equal(core.getState().ownedEntityCount, 0);
});

test("camera mode refuses unverified path attitude and interpolates complete world axes through heading wrap", () => {
  const h = harness(); const rejected = createVideoRoam({ Cesium: C, viewer: h.viewer as unknown as C.Viewer, videoElement: h.video as unknown as HTMLVideoElement,
    videoId: "video:test-record", track: h.track, followMode: "camera" }); assert.equal(rejected.ok, false); assert.equal(rejected.status.code, "ATTITUDE_REQUIRED");
  const angle = (degrees: number) => { const r = degrees * Math.PI / 180; return new C.Cartesian3(Math.cos(r), Math.sin(r), 0); };
  const attitude = { ...h.track, samples: h.track.samples.map((p, i) => ({ ...p, direction: angle(i === 0 ? 179 : -179), up: new C.Cartesian3(0, 0, 1) })) };
  const core = h.start(attitude, { followMode: "camera" }); h.video.currentTime = .05; core.start();
  assert.ok(h.views.at(-1)!.orientation.direction.x < -.9999, "slerp crosses the short 2 degree arc, not a full turn"); core.destroy();
});

function hostHarness() {
  const h = harness(), states: SafetyVideoRoamState[] = [], stored = new Map<string, string>(); let cameraAllowed = true;
  const host = new SafetyVideoRoam({ viewer: h.viewer as unknown as C.Viewer, video: h.video as unknown as HTMLVideoElement,
    onState: state => states.push(state), canTakeCamera: () => cameraAllowed,
    storage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => { stored.set(key, value); } },
    loadSource: async () => ({ record: h.record, raw: h.raw, sizeBytes: 10000 }) });
  const input = { mediaId: "video:test-record", sourceRecordId: "test-record", sourceUrl: "blob:record", generation: 1, mediaName: "record.mp4", reducedMotion: false };
  return { ...h, host, states, stored, input, setCameraAllowed: (value: boolean) => { cameraAllowed = value; } };
}

test("host automatically starts verified playback, remembers manual free-view across plays, and explicitly refollows", async () => {
  const h = hostHarness(); h.host.beforeManualNavigation(); assert.equal(h.stored.size, 0, "initial overview does not opt the user out before a source exists");
  await h.host.bind(h.input); assert.equal(h.host.getState().available, true); assert.equal(h.host.getState().enabled, false);
  h.video.paused = false; h.video.fire("play"); assert.equal(h.host.getState().enabled, true);
  h.canvas.dispatchEvent(new Event("wheel")); assert.equal(h.host.getState().userWantsFollow, false); assert.equal([...h.stored.values()][0], "false");
  h.video.fire("play"); assert.equal(h.host.getState().enabled, false);
  h.video.currentTime = 3; h.host.setEnabled(true); assert.equal(h.host.getState().mediaTime, 3); assert.equal(h.host.getState().telemetryTimeMs, 1700000003000);
  h.host.beforeManualNavigation(); assert.equal(h.host.getState().enabled, false); assert.equal(h.video.paused, false); h.host.dispose();
});

test("reduced motion prevents auto camera movement but explicit opt-in remains usable; camera ownership is respected", async () => {
  const h = hostHarness(); await h.host.bind({ ...h.input, reducedMotion: true }); h.video.paused = false; h.video.fire("play");
  assert.equal(h.host.getState().enabled, false); h.host.setEnabled(true); assert.equal(h.host.getState().enabled, true);
  h.host.beforeManualNavigation(); h.setCameraAllowed(false); h.host.setEnabled(true);
  assert.equal(h.host.getState().enabled, false); assert.equal(h.host.getState().state, "camera-busy"); h.host.dispose();
});

test("source switch and unmount release callbacks/entities/listeners and stale async data cannot bind", async () => {
  const h = hostHarness(); await h.host.bind(h.input); h.video.paused = false; h.host.setEnabled(true);
  assert.equal(h.video.pending.size, 1); h.video.fire("emptied"); assert.equal(h.video.pending.size, 0); assert.equal(h.entities.values.length, 0);
  assert.equal(h.host.debugStats().hostListenerCount, 0); assert.equal(h.host.getState().available, false);
  h.host.dispose(); assert.equal(h.host.debugStats().disposed, true);
  const a = harness(); let resolve!: (source: { record: LibraryRecord; raw: unknown; sizeBytes: number }) => void;
  const pending = new Promise<{ record: LibraryRecord; raw: unknown; sizeBytes: number }>(r => { resolve = r; });
  const host = new SafetyVideoRoam({ viewer: a.viewer as unknown as C.Viewer, video: a.video as unknown as HTMLVideoElement, onState() {}, canTakeCamera: () => true, loadSource: () => pending });
  const loaded = host.bind(h.input); host.unbind(); resolve({ record: a.record, raw: a.raw, sizeBytes: 10000 }); await loaded;
  assert.equal(host.getState().available, false); assert.equal(a.entities.values.length, 0); host.dispose();
});

test("actual-unknown-height policy disables roam only and leaves the real video's state untouched", async () => {
  const h = hostHarness(); h.raw.flight_info.altitude_reference = "absolute"; h.video.paused = false; h.video.currentTime = 2;
  await h.host.bind(h.input); h.host.setEnabled(true);
  assert.equal(h.host.getState().available, false); assert.equal(h.host.getState().label, "未关联同录像航迹");
  assert.match(h.host.getState().missing.join(" "), /高程基准未知/); assert.equal(h.video.paused, false); assert.equal(h.video.currentTime, 2);
  assert.equal(h.views.length, 0); assert.equal(h.entities.values.length, 0); h.host.dispose();
});


test("converted height and media offset drive the same camera, marker and display track without modifying source", async () => {
  const h = hostHarness(); h.raw.flight_info.altitude_reference = "absolute";
  h.record.settings.video!.controls = { videoArTimeOffset: "0.5" };
  h.record.settings.video!.roamVerticalReference = { status: "verified", recordId: h.record.id, targetReference: "EPSG:4979",
    sourceReference: "CPU fixture datum", evidence: "CPU fixture surveyed offset", method: "source-offset", sourceToEllipsoidOffsetMeters: 12 };
  const original = JSON.stringify({ raw: h.raw, record: h.record });
  const adapted = adaptSafetyVideoRoam(h.record, h.raw, h.decoded);
  await h.host.bind(h.input); h.video.currentTime = 1; h.host.setEnabled(true);
  const point = h.raw.trajectory_points[15].position;
  const expected = C.Cartesian3.fromDegrees(point.longitude, point.latitude, point.altitude + 12);
  assert.ok(C.Cartesian3.equals(h.camera.positionWC, expected));
  const marker = h.entities.values.find(e => e.point)!;
  assert.ok(C.Cartesian3.equals(marker.position!.getValue(C.JulianDate.now())!, expected));
  const lines = h.entities.values.filter(e => e.polyline);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].polyline!.positions!.getValue(C.JulianDate.now()), adapted.track!.samples.map(p => p.position));
  assert.equal(h.host.getState().telemetryTimeMs, 1700000001500);
  assert.equal(JSON.stringify({ raw: h.raw, record: h.record }), original);
  h.host.dispose(); assert.equal(h.entities.values.length, 0);
});

test("track and marker layer switches survive frames, stop/start and restore without taking the camera", async () => {
  const h = hostHarness(); await h.host.bind(h.input); h.host.setEnabled(true);
  assert.ok(h.entities.values.some(e => e.polyline && e.show));
  h.host.setLayerVisibility(false, false); assert.ok(h.entities.values.every(e => !e.show));
  h.video.paused = false; h.video.fire("play"); h.video.currentTime = 1; h.video.frame(1);
  assert.ok(h.entities.values.every(e => !e.show), "new video frame cannot override the layer controls");
  h.host.beforeManualNavigation(); h.host.setEnabled(true);
  assert.ok(h.entities.values.every(e => !e.show), "restarting follow cannot override the layer controls");
  const views = h.views.length; h.host.setLayerVisibility(true, true);
  assert.ok(h.entities.values.every(e => e.show)); assert.equal(h.views.length, views);
  h.host.setLayerVisibility(false, true);
  assert.ok(h.entities.values.filter(e => e.polyline).every(e => !e.show));
  assert.equal(h.entities.values.find(e => e.point)!.show, true);
  h.host.dispose(); assert.equal(h.video.pending.size, 0); assert.equal(h.entities.values.length, 0);
});

test("converted display polylines split at the same telemetry gaps that stop camera interpolation", async () => {
  const h = hostHarness(); h.raw.trajectory_points = h.raw.trajectory_points.filter(p => p.video_time_ms <= 1000 || p.video_time_ms >= 3000);
  const original = JSON.stringify(h.raw); await h.host.bind(h.input);
  const lines = h.entities.values.filter(e => e.polyline).map(e => e.polyline!.positions!.getValue(C.JulianDate.now()) as C.Cartesian3[]);
  assert.equal(lines.length, 2); assert.deepEqual(lines.map(p => p.length), [11, 11]);
  assert.ok(C.Cartesian3.equals(lines[0].at(-1)!, C.Cartesian3.fromDegrees(120.00001, 30, 101)));
  assert.ok(C.Cartesian3.equals(lines[1][0], C.Cartesian3.fromDegrees(120.00003, 30, 103)));
  h.video.currentTime = 2; h.host.setEnabled(true);
  assert.equal(h.host.getState().state, "telemetry-unavailable"); assert.equal(h.views.length, 0);
  assert.equal(JSON.stringify(h.raw), original); h.host.dispose(); assert.equal(h.entities.values.length, 0);
});


test("runtime status and host layer-visibility feedback settle without recursive publication", async () => {
  const h = harness(); let calls = 0, track = true, marker = true;
  const host = new SafetyVideoRoam({ viewer: h.viewer as unknown as C.Viewer, video: h.video as unknown as HTMLVideoElement,
    canTakeCamera: () => true, loadSource: async () => ({ record: h.record, raw: h.raw, sizeBytes: 10000 }),
    onState: state => {
      assert.ok(++calls < 30, "visibility callback feedback must settle");
      host.setLayerVisibility(state.available && track, state.available && marker);
    } });
  await host.bind({ mediaId: "video:test-record", sourceRecordId: "test-record", sourceUrl: "blob:record", generation: 1,
    mediaName: "record.mp4", reducedMotion: false });
  host.setEnabled(true); const previous = calls;
  track = false; marker = false; host.setLayerVisibility(track, marker);
  assert.equal(calls, previous + 1, "the repeated flags from onState must not republish");
  assert.ok(h.entities.values.every(e => !e.show));
  host.setLayerVisibility(track, marker); assert.equal(calls, previous + 1);
  track = true; marker = true; host.setLayerVisibility(track, marker);
  assert.equal(calls, previous + 2); assert.ok(h.entities.values.every(e => e.show));
  host.dispose(); assert.equal(h.entities.values.length, 0);
});
