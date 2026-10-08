/**
 * Couple an existing HTML video to an existing Cesium camera using verified,
 * pre-normalized telemetry from THAT recording. No Viewer/video creation, clock
 * simulation, coordinate conversion, trajectory fabrication or business writes.
 *
 * track: {id, videoId, timeBasis:'media-seconds', source:string, samples:[
 *   {timeSeconds, position:{x,y,z}, direction?:{x,y,z}, up?:{x,y,z}}
 * ]}. position/direction/up are WORLD ECEF; timeSeconds uses video.currentTime's
 * media timeline. The host resolves UTC offsets, altitude and gimbal conventions.
 * camera mode requires an attitude at every sample; path mode follows position
 * while keeping the viewing orientation from start, and is NOT frame registration.
 */
const activeVideoRoams = new WeakMap();
export function createVideoRoam(options = {}) {
  const { Cesium: C, viewer, videoElement: video, videoId, track,
    onStatus = () => {}, maxGapSeconds = 2, maxSegmentMeters = 250,
    followMode = 'path', showTrack = false, showMarker = false } = options;
  const failure = (code, message, details = {}) => {
    const status = { ok: false, state: 'not-ready', code, message, ...details };
    try { onStatus(status); } catch (_) { /* Host callback must not break cleanup. */ }
    return { ok: false, status };
  };
  if (!C?.Cartesian3 || !C?.Quaternion || !viewer?.scene || viewer.isDestroyed?.())
    return failure('VIEWER_REQUIRED', '传入现有 Cesium Viewer。');
  if (viewer.scene.mode !== C.SceneMode.SCENE3D)
    return failure('SCENE_3D_REQUIRED', '进入三维模式后再启用视频漫游。');
  if (!video || video.tagName !== 'VIDEO' || typeof video.addEventListener !== 'function' ||
      typeof video.removeEventListener !== 'function' || typeof video.currentTime !== 'number')
    return failure('VIDEO_ELEMENT_REQUIRED', '传入当前正在显示的真实 video 元素。');
  if (typeof onStatus !== 'function') return failure('STATUS_CALLBACK_INVALID', 'onStatus 必须是函数。');
  if (typeof videoId !== 'string' || !videoId.trim() || typeof track?.id !== 'string' || !track.id.trim() || track.videoId !== videoId)
    return failure('VIDEO_TRACK_MISMATCH', '录像与航迹的 videoId 不一致，未启动漫游。');
  if (track.timeBasis !== 'media-seconds' || typeof track.source !== 'string' || !track.source.trim())
    return failure('TRACK_TIME_SOURCE_REQUIRED', '航迹必须注明来源，并已换算到该录像的媒体秒时间轴。');
  if (!['path', 'camera'].includes(followMode)) return failure('INVALID_FOLLOW_MODE', '选择 path 或 camera。');
  if (!Number.isFinite(maxGapSeconds) || maxGapSeconds <= 0 || maxGapSeconds > 60 ||
      !Number.isFinite(maxSegmentMeters) || maxSegmentMeters <= 0 || maxSegmentMeters > 10000)
    return failure('INTERPOLATION_LIMITS_INVALID', '请提供有效的时间缺口与近距插值限制。');
  if (typeof showTrack !== 'boolean' || typeof showMarker !== 'boolean')
    return failure('VISUAL_FLAGS_INVALID', 'showTrack 和 showMarker 必须是布尔值。');
  if (!Array.isArray(track.samples) || track.samples.length < 2)
    return failure('TRACK_SAMPLES_REQUIRED', '至少需要两个按时间排列的真实航迹样本。');
  const finiteVector = p => p && [p.x, p.y, p.z].every(Number.isFinite);
  const ecef = p => finiteVector(p) && C.Cartesian3.magnitude(p) > 1000000 && C.Cartesian3.magnitude(p) < 100000000;
  const unit = p => finiteVector(p) && Math.abs(C.Cartesian3.magnitude(p) - 1) <= 0.001;
  const samples = []; let previousTime = -Infinity;
  for (let index = 0; index < track.samples.length; index++) {
    const sample = track.samples[index];
    if (!Number.isFinite(sample?.timeSeconds) || sample.timeSeconds < 0 || sample.timeSeconds <= previousTime || !ecef(sample.position))
      return failure('INVALID_TRACK_SAMPLE', '样本时间必须严格递增，位置必须是有效 ECEF 世界坐标。', { index });
    const item = { timeSeconds: sample.timeSeconds, position: C.Cartesian3.clone(sample.position) };
    const hasDirection = sample.direction !== undefined, hasUp = sample.up !== undefined;
    if (hasDirection || hasUp) {
      if (!hasDirection || !hasUp || !unit(sample.direction) || !unit(sample.up) ||
          Math.abs(C.Cartesian3.dot(sample.direction, sample.up)) > 0.2)
        return failure('INVALID_TRACK_ATTITUDE', 'direction 和 up 必须成对提供、归一化且近似正交。', { index });
      // Right/up/back form a camera-to-world rotation. Gram-Schmidt removes minor
      // telemetry rounding; slerp avoids heading wrap discontinuities at ±180°.
      const direction = C.Cartesian3.normalize(C.Cartesian3.clone(sample.direction), new C.Cartesian3());
      const right = C.Cartesian3.normalize(C.Cartesian3.cross(direction, sample.up, new C.Cartesian3()), new C.Cartesian3());
      const up = C.Cartesian3.normalize(C.Cartesian3.cross(right, direction, new C.Cartesian3()), new C.Cartesian3());
      const rotation = new C.Matrix3();
      C.Matrix3.setColumn(rotation, 0, right, rotation); C.Matrix3.setColumn(rotation, 1, up, rotation);
      C.Matrix3.setColumn(rotation, 2, C.Cartesian3.negate(direction, new C.Cartesian3()), rotation);
      item.quaternion = C.Quaternion.normalize(C.Quaternion.fromRotationMatrix(rotation), new C.Quaternion());
    }
    samples.push(item); previousTime = sample.timeSeconds;
  }
  const hasCompleteAttitude = samples.every(p => p.quaternion);
  if (followMode === 'camera' && !hasCompleteAttitude)
    return failure('ATTITUDE_REQUIRED', '该录像缺少完整相机姿态，不能启用相机姿态漫游；可明确选择沿航迹跟随。');
  const sourceKey = () => video.currentSrc || video.src || '';
  const boundSource = sourceKey(), boundStream = video.srcObject || null;
  if (!boundSource && !boundStream) return failure('VIDEO_SOURCE_REQUIRED', '先选择并绑定录像，再接入对应航迹。');
  const scene = viewer.scene, camera = viewer.camera, canvas = scene.canvas;
  const host = video.ownerDocument?.defaultView || globalThis;
  const frameCallbacks = typeof video.requestVideoFrameCallback === 'function' && typeof video.cancelVideoFrameCallback === 'function';
  if (!frameCallbacks && (typeof host.requestAnimationFrame !== 'function' || typeof host.cancelAnimationFrame !== 'function'))
    return failure('FRAME_CALLBACK_UNAVAILABLE', '当前浏览器没有可用的视频帧或动画帧回调。');
  let mode = followMode, enabled = false, destroyed = false, pending = null, epoch = 0;
  let sourceInvalid = false, buffering = false;
  let trackVisible = showTrack, markerVisible = showMarker;
  let state = 'ready', code = null, message = '录像与航迹已匹配，可开始漫游。';
  let lastMediaTime = null, frameCount = 0, lastSource = null, lastPose = null, callbackError = null;
  let startTransform = null, pathOrientation = null, lastFrameTiming = null;
  const removers = [], entities = [];
  const ownerToken = {};
  const ownerId = `video-roam:${track.id}:${Math.random().toString(36).slice(2)}`;
  const sameSource = () => sourceKey() === boundSource && (video.srcObject || null) === boundStream;
  const live = () => !destroyed && !viewer.isDestroyed?.();
  const getState = () => ({
    ok: !code, state, code, message, enabled, active: enabled && state === 'following', destroyed, buffering,
    sourceBindingValid: !sourceInvalid && sameSource(),
    videoId, trackId: track.id, trackSource: track.source, timeBasis: 'media-seconds', mode,
    viewMatch: mode === 'camera' ? 'position-and-attitude-only-not-optical-registration' : 'path-follow-only',
    hasCompleteAttitude, timeRange: [samples[0].timeSeconds, samples.at(-1).timeSeconds],
    mediaTime: lastMediaTime, clockSource: lastSource, frameCount, maxGapSeconds, maxSegmentMeters,
    pendingFrameCallback: pending !== null, listenerCount: removers.length, ownedEntityCount: entities.length,
    visibility: { track: trackVisible, marker: markerVisible }, createdViewerCount: 0, businessGeometryWrites: 0, cameraTransformChangedByModule: false,
    cameraTransformUnchanged: startTransform && live() ? C.Matrix4.equals(camera.transform, startTransform) : null,
    lastPosition: lastPose ? C.Cartesian3.clone(lastPose.position) : null, lastFrameTiming, callbackError
  });
  const publish = () => {
    const status = getState();
    try { onStatus(status); } catch (error) { callbackError = String(error?.message || error); }
    return status;
  };
  const cancel = () => {
    epoch++;
    if (pending !== null) {
      if (frameCallbacks) video.cancelVideoFrameCallback(pending); else host.cancelAnimationFrame(pending);
      pending = null;
    }
  };
  const stopWith = (nextState = 'stopped', nextCode = null, nextMessage = '已停止漫游，可自由观察模型。') => {
    enabled = false; cancel(); state = nextState; code = nextCode; message = nextMessage;
    if (activeVideoRoams.get(viewer) === ownerToken) activeVideoRoams.delete(viewer);
    if (nextState === 'source-changed' || nextState === 'source-unloaded') {
      sourceInvalid = true;
      for (const entity of entities) entity.show = false;
    }
    if (marker && nextState !== 'ended' && nextState !== 'error') marker.show = false;
    // setView preserves the existing camera transform; no lookAtTransform/inputs
    // override was installed, so there is no hidden camera lock to undo here.
    return publish();
  };
  const gap = (left, right) => {
    if (right.timeSeconds - left.timeSeconds > maxGapSeconds + 1e-8) return 'TELEMETRY_TIME_GAP';
    if (C.Cartesian3.distance(left.position, right.position) > maxSegmentMeters) return 'TELEMETRY_SPATIAL_GAP';
    return null;
  };
  const owned = graphics => {
    const entity = viewer.entities.add({ id: `${ownerId}:${entities.length}`,
      properties: { presentationOnly: true, videoId, trackId: track.id, source: track.source }, ...graphics });
    entities.push(entity); return entity;
  };
  let marker = null;
  try {
    if (showTrack) {
      let section = [samples[0].position];
      const addSection = () => { if (section.length >= 2) owned({ polyline: { positions: section.map(p => C.Cartesian3.clone(p)),
        width: 2, arcType: C.ArcType.NONE, material: C.Color.CYAN.withAlpha(0.6) } }); };
      for (let i = 1; i < samples.length; i++) {
        if (gap(samples[i - 1], samples[i])) { addSection(); section = [samples[i].position]; }
        else section.push(samples[i].position);
      }
      addSection();
    }
    if (showMarker) marker = owned({ show: false, position: samples[0].position,
      point: { pixelSize: 9, color: C.Color.CYAN, outlineColor: C.Color.WHITE, outlineWidth: 1 } });
  } catch (error) {
    for (const entity of entities) viewer.entities.remove(entity);
    return failure('VISUAL_ATTACH_FAILED', String(error?.message || error));
  }
  const interpolate = time => {
    if (!Number.isFinite(time)) return { error: 'INVALID_MEDIA_TIME' };
    const first = samples[0], last = samples.at(-1);
    if (time < first.timeSeconds - 1e-7 || time > last.timeSeconds + 1e-7) return { error: 'OUTSIDE_TRACK_RANGE' };
    let low = 0, high = samples.length - 1;
    while (low <= high) { const middle = (low + high) >> 1; if (samples[middle].timeSeconds <= time) low = middle + 1; else high = middle - 1; }
    const index = Math.max(0, high), left = samples[index], right = samples[Math.min(index + 1, samples.length - 1)];
    let alpha = 0;
    if (Math.abs(time - left.timeSeconds) > 1e-7 && left !== right) {
      const discontinuity = gap(left, right); if (discontinuity) return { error: discontinuity };
      alpha = (time - left.timeSeconds) / (right.timeSeconds - left.timeSeconds);
    }
    const position = C.Cartesian3.lerp(left.position, right.position, Math.min(1, Math.max(0, alpha)), new C.Cartesian3());
    let orientation = pathOrientation;
    if (mode === 'camera') {
      const q = C.Quaternion.slerp(left.quaternion, right.quaternion, Math.min(1, Math.max(0, alpha)), new C.Quaternion());
      const matrix = C.Matrix3.fromQuaternion(q);
      orientation = { direction: C.Cartesian3.negate(C.Matrix3.getColumn(matrix, 2, new C.Cartesian3()), new C.Cartesian3()),
        up: C.Matrix3.getColumn(matrix, 1, new C.Cartesian3()) };
    }
    return { position, orientation };
  };
  const apply = (time, clockSource) => {
    if (!enabled || !live()) return getState();
    if (sourceInvalid || !sameSource()) return stopWith('source-changed', 'VIDEO_SOURCE_CHANGED', '录像源已切换，请重新绑定与该录像对应的航迹。');
    if (buffering) return getState();
    if (activeVideoRoams.get(viewer) !== ownerToken) return stopWith('conflict', 'CAMERA_OWNER_CHANGED', '视频漫游相机控制权已改变。');
    if (scene.mode !== C.SceneMode.SCENE3D) return stopWith('stopped', 'SCENE_MODE_CHANGED', '场景已离开三维模式，漫游停止。');
    if (viewer.trackedEntity) return stopWith('conflict', 'TRACKED_ENTITY_ACTIVE', '当前相机正由其他对象跟踪功能控制。');
    if (!C.Matrix4.equals(camera.transform, startTransform)) return stopWith('conflict', 'CAMERA_TRANSFORM_CHANGED', '相机参考系已由其他功能改变，漫游停止。');
    const pose = interpolate(time);
    if (pose.error) return stopWith('telemetry-unavailable', pose.error,
      pose.error === 'OUTSIDE_TRACK_RANGE' ? '当前录像时间没有对应航迹，已停止跟随。' : '当前区间航迹缺失或跳变，已停止跟随，不跨缺口插值。');
    try {
      // World-coordinate setView keeps the camera's original reference transform.
      // Camera intrinsics/FOV and image reprojection are deliberately host-owned.
      camera.setView({ destination: pose.position, orientation: pose.orientation });
      scene.requestRender();
      if (marker) { marker.position = pose.position; marker.show = markerVisible; }
      lastPose = pose; lastMediaTime = time; lastSource = clockSource; frameCount++;
      state = video.paused ? 'paused' : video.seeking ? 'seeking' : 'following'; code = null;
      message = mode === 'camera' ? '按录像媒体时间跟随位置与相机姿态。' : '按录像媒体时间沿航迹跟随；当前朝向不代表录像相机姿态。';
      return publish();
    } catch (error) { return stopWith('error', 'CAMERA_UPDATE_FAILED', String(error?.message || error)); }
  };
  const schedule = () => {
    if (!enabled || !live() || pending !== null || buffering || video.paused || video.ended || video.seeking) return;
    const generation = epoch;
    if (frameCallbacks) {
      pending = video.requestVideoFrameCallback((now, metadata) => {
        if (generation !== epoch) return; pending = null;
        lastFrameTiming = { mediaTime: metadata.mediaTime, callbackTime: now,
          expectedDisplayTime: metadata.expectedDisplayTime, presentationTime: metadata.presentationTime,
          presentedFrames: metadata.presentedFrames, processingDuration: metadata.processingDuration,
          callbackToExpectedDisplayMs: Number.isFinite(metadata.expectedDisplayTime) ? metadata.expectedDisplayTime - now : null,
          mediaCurrentTimeDeltaMs: (video.currentTime - metadata.mediaTime) * 1000 };
        if (enabled && !video.paused && !video.seeking) apply(metadata.mediaTime, 'requestVideoFrameCallback.mediaTime');
        schedule();
      });
    } else {
      pending = host.requestAnimationFrame(() => {
        if (generation !== epoch) return; pending = null;
        if (enabled && !video.paused && !video.seeking && video.currentTime !== lastMediaTime)
          apply(video.currentTime, 'video.currentTime');
        schedule();
      });
    }
  };
  const sync = () => { const result = apply(video.currentTime, 'video.currentTime'); schedule(); return result; };
  const start = () => {
    if (!live()) return { ...getState(), ok: false, code: 'DESTROYED' };
    if (sourceInvalid || !sameSource()) return stopWith('source-changed', 'VIDEO_SOURCE_CHANGED', '录像源已切换，请重新绑定对应航迹。');
    if (video.readyState < 1 || video.error) return stopWith('not-ready', 'VIDEO_NOT_READY', '等待录像元数据加载完成后再开始。');
    if (video.ended) return stopWith('ended', null, '录像已结束，请选择有效回放时间后再开始漫游。');
    if (viewer.trackedEntity) return stopWith('conflict', 'TRACKED_ENTITY_ACTIVE', '先结束当前对象跟踪，再启用视频漫游。');
    if (activeVideoRoams.has(viewer) && activeVideoRoams.get(viewer) !== ownerToken)
      return stopWith('conflict', 'CAMERA_BUSY', '另一个录像正在控制相机，请由页面先结束原漫游。');
    cancel(); enabled = true; code = null;
    activeVideoRoams.set(viewer, ownerToken);
    buffering = video.readyState < 2;
    for (const entity of entities) if (entity.polyline) entity.show = trackVisible;
    startTransform = C.Matrix4.clone(camera.transform);
    pathOrientation = { direction: C.Cartesian3.clone(camera.directionWC), up: C.Cartesian3.clone(camera.upWC) };
    camera.cancelFlight?.();
    if (buffering) { state = 'buffering'; message = '等待当前录像帧加载，相机保持不动。'; return publish(); }
    return sync();
  };
  const stop = () => destroyed ? getState() : stopWith();
  const setVisibility = (visibility = {}) => {
    if (!live()) return getState();
    if (visibility.track !== undefined && typeof visibility.track !== 'boolean' ||
        visibility.marker !== undefined && typeof visibility.marker !== 'boolean') throw new TypeError('Visibility flags must be booleans.');
    const nextTrack = visibility.track ?? trackVisible, nextMarker = visibility.marker ?? markerVisible;
    if (nextTrack === trackVisible && nextMarker === markerVisible) return getState();
    trackVisible = nextTrack; markerVisible = nextMarker;
    const sourceValid = !sourceInvalid && sameSource();
    for (const entity of entities) if (entity.polyline) entity.show = trackVisible && sourceValid;
    if (marker) marker.show = markerVisible && sourceValid && !!lastPose && (enabled || state === 'ended' || state === 'error');
    scene.requestRender(); return publish();
  };
  const setFollowMode = next => {
    if (!live()) return { ...getState(), ok: false, code: 'DESTROYED' };
    if (!['path', 'camera'].includes(next)) return stopWith('not-ready', 'INVALID_FOLLOW_MODE', '选择 path 或 camera。');
    if (next === 'camera' && !hasCompleteAttitude)
      return stopWith('not-ready', 'ATTITUDE_REQUIRED', '缺少完整相机姿态，不能启用相机姿态漫游；请明确选择沿航迹跟随。');
    mode = next;
    if (mode === 'path') pathOrientation = { direction: C.Cartesian3.clone(camera.directionWC), up: C.Cartesian3.clone(camera.upWC) };
    if (enabled) return sync();
    code = null; state = 'ready'; message = '漫游模式已选择，可开始跟随。'; return publish();
  };
  const listen = (target, type, handler, opts) => { target.addEventListener(type, handler, opts); removers.push(() => target.removeEventListener(type, handler, opts)); };
  const resume = () => { if (enabled) { if (video.readyState >= 2) buffering = false; sync(); schedule(); } };
  const buffer = () => { if (enabled) { buffering = true; cancel(); state = 'buffering'; message = '录像正在缓冲，相机保持当前时间的位置。'; publish(); } };
  listen(video, 'playing', resume);
  listen(video, 'play', resume);
  listen(video, 'loadeddata', resume);
  listen(video, 'waiting', buffer);
  listen(video, 'stalled', buffer);
  listen(video, 'pause', () => { if (enabled) { cancel(); if (!buffering) apply(video.currentTime, 'video.currentTime'); else { state = 'paused'; publish(); } } });
  listen(video, 'seeking', () => { if (enabled) { cancel(); state = 'seeking'; message = '等待当前录像帧定位。'; publish(); } });
  listen(video, 'seeked', resume);
  listen(video, 'ratechange', () => { if (enabled) { cancel(); sync(); } });
  listen(video, 'ended', () => { if (enabled) stopWith('ended', null, '录像已结束，漫游停止。'); });
  listen(video, 'emptied', () => stopWith('source-unloaded', 'VIDEO_SOURCE_UNLOADED', '录像已卸载，请选择录像并核对对应航迹。'));
  listen(video, 'loadstart', () => { if (!sameSource()) stopWith('source-changed', 'VIDEO_SOURCE_CHANGED', '录像源已切换，请重新绑定对应航迹。'); });
  listen(video, 'error', () => stopWith('error', 'VIDEO_ERROR', '录像播放失败，漫游停止。'));
  listen(canvas, 'pointerdown', () => { if (enabled) stopWith('user-interrupted', null, '已暂停自动跟随，可自由操作三维场景。'); }, { passive: true });
  listen(canvas, 'wheel', () => { if (enabled) stopWith('user-interrupted', null, '已暂停自动跟随，可自由操作三维场景。'); }, { passive: true });
  const destroy = () => {
    if (destroyed) return getState();
    enabled = false; cancel(); for (const remove of removers.splice(0)) remove();
    if (activeVideoRoams.get(viewer) === ownerToken) activeVideoRoams.delete(viewer);
    if (!viewer.isDestroyed?.()) for (const entity of entities) viewer.entities.remove(entity);
    entities.length = 0; marker = null; destroyed = true; state = 'destroyed'; code = null; message = '已解除视频漫游绑定。';
    return publish();
  };
  const controller = Object.freeze({ start, stop, sync, setFollowMode, setVisibility, getState, destroy });
  return { ok: true, status: publish(), controller };
}
