/**
 * Scene presentation for an EXISTING Cesium Viewer. ESM, no package dependencies.
 * No Viewer creation; no modelMatrix/geometry/data-store changes; no picking.
 * Input positions are world ECEF on the declared project's ellipsoid, with known heights.
 * Showcase extent is a presentation configuration, NEVER a saved business polygon.
 * The default showcase grades the original material toward the approved blue-gray
 * reference while retaining texture detail, material differences and source lighting.
 * It never replaces the original surface with one flat blue color or fabricated lamps.
 * See the unified requirement for real-project visual acceptance and integration.
 */
export async function createScenePresentation(options = {}) {
  const { Cesium: C, viewer, tilesets = [], displayEnvelope: env,
    initialMode = 'showcase', allowMaterialReplacement = false,
    onStatus = () => {} } = options;
  const issues = [];
  const fail = (code, message, state = 'not-ready') => {
    const status = { ok: false, state, code, message, cesiumVersion: C?.VERSION || 'unknown' };
    onStatus(status); return { ok: false, status };
  };
  if (!C || !viewer?.scene || viewer.isDestroyed?.())
    return fail('VIEWER_REQUIRED', 'Pass the existing live Cesium Viewer and its Cesium namespace.');
  if (options.palette !== undefined && (!options.palette || typeof options.palette !== 'object' || Array.isArray(options.palette)))
    return fail('INVALID_PALETTE', 'palette must be an optional plain configuration object.');
  // Color strings are sRGB/CSS. Shader grading is explicitly converted from and
  // back to Cesium's linear material.diffuse, before the inherited lighting stage.
  const palette = Object.freeze({
    saturation: 0.72, brightness: 0.98, contrast: 1.04,
    coolness: 0.12, blueGrayMix: 0.24, shadowLift: 0.020,
    background: '#030c18', sidewall: '#0b2747', bottom: '#061326',
    outline: '#29c6ff', outlineOpacity: 0.90, outlineWidth: 1.8,
    outlineGlowWidth: 4.2, outlineGlowOpacity: 0.16,
    bottomOutline: '#176591', bottomOutlineOpacity: 0.50, bottomOutlineWidth: 1,
    ...(options.palette || {})
  });
  const ranges = { saturation: [0, 1.2], brightness: [0.7, 1.3], contrast: [0.8, 1.2],
    coolness: [0, 0.15], blueGrayMix: [0, 0.4], shadowLift: [0, 0.04], outlineOpacity: [0, 1],
    outlineWidth: [0.5, 3], outlineGlowWidth: [0, 8], outlineGlowOpacity: [0, 0.25],
    bottomOutlineOpacity: [0, 1], bottomOutlineWidth: [0.5, 2] };
  if (Object.entries(ranges).some(([k, [lo, hi]]) =>
      !Number.isFinite(palette[k]) || palette[k] < lo || palette[k] > hi))
    return fail('INVALID_PALETTE', 'Palette grading/line parameters must stay within their documented modest ranges.');
  if (['background', 'sidewall', 'bottom', 'outline', 'bottomOutline'].some(k =>
      typeof palette[k] !== 'string' || !C.Color.fromCssColorString(palette[k])))
    return fail('INVALID_PALETTE_COLOR', 'Palette colors must be valid CSS colors.');
  const scene = viewer.scene;
  if (scene.mode !== C.SceneMode.SCENE3D)
    return fail('SCENE_3D_REQUIRED', 'Finish scene morphing and enter 3D before applying presentation.');
  if (!C.CustomShader || !C.ClippingPolygon || !C.ClippingPolygonCollection?.isSupported)
    return fail('API_UNSUPPORTED', 'This locked Cesium build lacks the required shader or polygon clipping APIs.', 'unsupported');
  if (!C.ClippingPolygonCollection.isSupported(scene))
    return fail('CLIPPING_UNSUPPORTED', 'Polygon clipping is unsupported in this WebGL context; showcase is not applied.', 'unsupported');
  if (!tilesets.length || tilesets.some(x => !x.id || !x.tileset || x.contentType !== 'model'))
    return fail('MODEL_ALLOWLIST_REQUIRED', 'Pass explicitly allowed loaded tilesets with id and confirmed contentType: model.');
  if (new Set(tilesets.map(x => x.tileset)).size !== tilesets.length)
    return fail('DUPLICATE_TILESET', 'Each tileset instance must occur once.');
  if (!env?.id || !Array.isArray(env.positions) || env.positions.length < 3 ||
      !['surveyed', 'sampled-model', 'dataset', 'synthetic-demo'].includes(env.heightSource))
    return fail('ENVELOPE_REQUIRED', 'Provide a display envelope with ordered ECEF vertices and an explicit upper-edge height source.');
  const finitePoint = p => p && [p.x, p.y, p.z].every(Number.isFinite) && C.Cartesian3.magnitude(p) > 1000;
  if (!env.positions.every(finitePoint))
    return fail('INVALID_ECEF', 'Every envelope vertex must be a finite world ECEF position. No fallback coordinates are generated.');
  const positions = env.positions.map(p => C.Cartesian3.clone(p));
  if (C.Cartesian3.equalsEpsilon(positions[0], positions.at(-1), 0, 0.001)) positions.pop();
  if (positions.length < 3 || new Set(positions.map(p => `${p.x}/${p.y}/${p.z}`)).size < 3)
    return fail('INVALID_ENVELOPE', 'The display envelope must contain at least three distinct vertices.');
  const ellipsoid = options.ellipsoid || scene.globe?.ellipsoid || C.Ellipsoid.WGS84;
  const cartographics = positions.map(p => ellipsoid.cartesianToCartographic(p));
  if (cartographics.some(p => !p || !Number.isFinite(p.height) || Math.abs(p.height) > 100000))
    return fail('HEIGHT_REQUIRED', 'The display envelope heights cannot be resolved on the declared ellipsoid.');
  const sphere = C.BoundingSphere.fromPoints(positions);
  if (!(sphere.radius > 0.1 && sphere.radius < 100000))
    return fail('ENVELOPE_SCALE', 'Use a non-degenerate local project display envelope smaller than a 100 km radius.');
  const frame = C.Transforms.eastNorthUpToFixedFrame(sphere.center, ellipsoid);
  const inverseFrame = C.Matrix4.inverseTransformation(frame, new C.Matrix4());
  const xy = positions.map(p => C.Matrix4.multiplyByPoint(inverseFrame, p, new C.Cartesian3()));
  const orient = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const area2 = xy.reduce((sum, a, i) => { const b = xy[(i + 1) % xy.length]; return sum + a.x * b.y - a.y * b.x; }, 0);
  if (Math.abs(area2) < 1) return fail('DEGENERATE_ENVELOPE', 'The display envelope has no usable plan area.');
  const between = (v, a, b) => v >= Math.min(a, b) - 1e-6 && v <= Math.max(a, b) + 1e-6;
  const onSegment = (a, b, p) => Math.abs(orient(a, b, p)) < 1e-6 && between(p.x, a.x, b.x) && between(p.y, a.y, b.y);
  for (let i = 0; i < xy.length; i++) for (let j = i + 1; j < xy.length; j++) {
    if (j === i + 1 || (i === 0 && j === xy.length - 1)) continue;
    const a = xy[i], b = xy[(i + 1) % xy.length], c = xy[j], d = xy[(j + 1) % xy.length];
    if ((orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0) ||
        onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b))
      return fail('SELF_INTERSECTING_ENVELOPE', 'Use a simple display envelope without crossing or touching non-adjacent edges.');
  }
  // Keep reliable, densely sampled upper-edge heights for the skirt. Native
  // clipping needs only the same planar corner sequence. Separate representations
  // avoid unnecessary distance-field work without changing the display footprint.
  // Actual mesh/texture completion is verified from stable project render output;
  // assigning this collection or checking its state is not visual acceptance.
  const clippingSource = env.clippingPositions ?? positions;
  if (!Array.isArray(clippingSource) || clippingSource.length < 3 || !clippingSource.every(finitePoint))
    return fail('INVALID_CLIPPING_ENVELOPE', 'Provide finite ECEF corners for the same display perimeter.');
  const clippingPositions = clippingSource.map(p => C.Cartesian3.clone(p));
  if (C.Cartesian3.equalsEpsilon(clippingPositions[0], clippingPositions.at(-1), 0, 0.001)) clippingPositions.pop();
  const clipXY = clippingPositions.map(p => C.Matrix4.multiplyByPoint(inverseFrame, p, new C.Cartesian3()));
  const clipArea2 = clipXY.reduce((sum, a, i) => { const b = clipXY[(i + 1) % clipXY.length]; return sum + a.x * b.y - a.y * b.x; }, 0);
  if (clipXY.length < 3 || Math.abs(clipArea2) < 1)
    return fail('DEGENERATE_CLIPPING_ENVELOPE', 'The clipping perimeter must enclose a usable plan area.');
  for (let i = 0; i < clipXY.length; i++) for (let j = i + 1; j < clipXY.length; j++) {
    if (j === i + 1 || (i === 0 && j === clipXY.length - 1)) continue;
    const a = clipXY[i], b = clipXY[(i + 1) % clipXY.length], c = clipXY[j], d = clipXY[(j + 1) % clipXY.length];
    if ((orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0) ||
        onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b))
      return fail('SELF_INTERSECTING_CLIPPING_ENVELOPE', 'The clipping perimeter must be a simple ordered ring.');
  }
  const distanceToSegment = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
    const t = length2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0;
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  };
  const distanceToRing = (p, ring) => Math.min(...ring.map((a, i) => distanceToSegment(p, a, ring[(i + 1) % ring.length])));
  // One metre is a display-perimeter tolerance, not an engineering/safety tolerance.
  // Bidirectional checks reject a different polygon or corners that cut across the skirt.
  const clippingBoundaryDeviationMeters = Math.max(
    ...xy.map(p => distanceToRing(p, clipXY)), ...clipXY.map(p => distanceToRing(p, xy)));
  if (clippingBoundaryDeviationMeters > 1)
    return fail('CLIPPING_ENVELOPE_MISMATCH', 'Clipping corners and sampled skirt must describe the same horizontal display perimeter.');
  const depth = env.baseDepthMeters ?? Math.max(3, Math.min(90, sphere.radius * 0.09));
  if (!(Number.isFinite(depth) && depth > 0 && depth < 5000))
    return fail('BASE_DEPTH', 'baseDepthMeters must be positive and less than 5000; it is decorative, not excavation depth.');
  const baseHeight = Math.min(...cartographics.map(p => p.height)) - depth;
  for (const item of tilesets) {
    const t = item.tileset;
    if (t.isDestroyed?.() || !('customShader' in t) || !('clippingPolygons' in t))
      issues.push({ id: item.id, code: 'TILESET_NOT_READY' });
    if (t.clippingPolygons || t.clippingPlanes)
      issues.push({ id: item.id, code: 'EXISTING_CLIPPING_OWNER' });
    if ((t.style || t.customShader) && !allowMaterialReplacement)
      issues.push({ id: item.id, code: 'EXISTING_MATERIAL_OWNER' });
  }
  if (issues.length) {
    const result = fail('OWNERSHIP_OR_READINESS', 'Resolve these ownership/capability conflicts explicitly before applying presentation.', 'conflict');
    result.status.issues = issues; onStatus(result.status); return result;
  }
  const key = `presentation:${env.id}:${Math.random().toString(36).slice(2)}`;
  const dataSource = new C.CustomDataSource(key);
  dataSource.show = false;
  try { await viewer.dataSources.add(dataSource); }
  catch (error) { return fail('DATASOURCE_ATTACH_FAILED', String(error?.message || error), 'error'); }
  if (viewer.isDestroyed?.()) return fail('VIEWER_DESTROYED', 'The Viewer was destroyed during initialization.');
  let mode = 'reality', destroyed = false, runtimeError = null, renderedFrames = 0;
  let scenePatches = [], activeRecords = [], lastRestoreConflicts = [];
  const matrices = tilesets.map(x => ({ id: x.id, t: x.tileset, matrix: C.Matrix4.clone(x.tileset.modelMatrix) }));
  const originals = tilesets.map(x => ({ ...x, style: x.tileset.style, shader: x.tileset.customShader }));
  const alive = () => !destroyed && !viewer.isDestroyed?.();
  const request = () => { if (alive()) scene.requestRender(); };
  const ownershipDrift = () => activeRecords.filter(r => r.tileset.isDestroyed?.() ||
    r.tileset.customShader !== r.shader || r.tileset.style !== undefined ||
    r.tileset.clippingPolygons !== r.clipping || !r.clipping.enabled || !r.clipping.inverse).map(r => r.id);
  const currentStatus = () => ({ ok: !destroyed && !runtimeError && !lastRestoreConflicts.length && !ownershipDrift().length,
    state: destroyed ? 'destroyed' : runtimeError ? 'error' : (lastRestoreConflicts.length || ownershipDrift().length) ? 'conflict' : 'configured',
    mode, cesiumVersion: C.VERSION, renderedFrames, runtimeError,
    visualAcceptance: 'required-on-project-data', envelopeId: env.id,
    heightSource: env.heightSource, restoreConflicts: [...lastRestoreConflicts], ownershipDrift: ownershipDrift() });
  const emit = () => { const s = currentStatus(); onStatus(s); return s; };
  const patch = (target, name, value) => {
    if (!target) return;
    const old = target[name]; target[name] = value;
    scenePatches.push({ target, name, old, value: target[name] });
  };
  const restoreScene = () => {
    for (const p of scenePatches.reverse()) {
      if (p.target[p.name] === p.value) p.target[p.name] = p.old;
      else lastRestoreConflicts.push({ scope: 'scene', property: p.name });
    }
    scenePatches = [];
  };
  const color = value => C.Color.fromCssColorString(value);
  const tagged = (suffix, graphics) => dataSource.entities.add({
    id: `${key}:${suffix}`, name: `展示层 ${suffix}`,
    properties: { presentationOnly: true, notForMeasurement: true, envelopeId: env.id, heightSource: env.heightSource },
    ...graphics
  });
  const closed = [...positions, C.Cartesian3.clone(positions[0])];
  const topHeights = [...cartographics.map(p => p.height), cartographics[0].height];
  const bottom = cartographics.map(p => ellipsoid.cartographicToCartesian(new C.Cartographic(p.longitude, p.latitude, baseHeight)));
  tagged('skirt', { wall: { positions: closed, maximumHeights: topHeights,
    minimumHeights: closed.map(() => baseHeight), material: color(palette.sidewall), outline: false } });
  tagged('bottom', { polygon: { hierarchy: new C.PolygonHierarchy(bottom), perPositionHeight: true,
    material: color(palette.bottom), outline: false } });
  const raised = cartographics.map(p => ellipsoid.cartographicToCartesian(new C.Cartographic(p.longitude, p.latitude, p.height + 0.15)));
  // A bounded translucent halo under a narrow cyan core. PolylineGlow's built-in
  // singular center can become white; these two controlled layers never add white
  // or bloom to the model surface. They belong only to the decorative display edge.
  tagged('top-halo', { polyline: { positions: [...raised, raised[0]],
    show: palette.outlineGlowWidth > palette.outlineWidth && palette.outlineGlowOpacity > 0,
    width: Math.max(palette.outlineWidth, palette.outlineGlowWidth),
    arcType: C.ArcType.NONE, material: color(palette.outline).withAlpha(palette.outlineGlowOpacity) } });
  tagged('top-edge', { polyline: { positions: [...raised, raised[0]], width: palette.outlineWidth,
    arcType: C.ArcType.NONE, material: color(palette.outline).withAlpha(palette.outlineOpacity) } });
  tagged('bottom-edge', { polyline: { positions: [...bottom, bottom[0]], width: palette.bottomOutlineWidth,
    arcType: C.ArcType.NONE, material: color(palette.bottomOutline).withAlpha(palette.bottomOutlineOpacity) } });
  // MODIFY_MATERIAL runs after Cesium has sampled the original base-color texture.
  // The installed Cesium 1.144 MaterialStageFS converts that texture from sRGB to
  // linear; LightingStageFS later performs output conversion/tone mapping.
  // Grade once in display-like sRGB then return linear values for lighting. Do not
  // gamma-encode material.diffuse twice, paint over it, or replace its normals.
  // No lightingModel override: preserve each primitive's original PBR/UNLIT model.
  // Sources: Cesium CustomShaderGuide and packages/engine/Source/Shaders/Model/
  // MaterialStageFS.glsl + LightingStageFS.glsl (checked against this project's locked Cesium 1.144 source).
  const makeShader = () => new C.CustomShader({
    mode: C.CustomShaderMode.MODIFY_MATERIAL,
    uniforms: {
      u_saturation: { type: C.UniformType.FLOAT, value: palette.saturation },
      u_brightness: { type: C.UniformType.FLOAT, value: palette.brightness },
      u_contrast: { type: C.UniformType.FLOAT, value: palette.contrast },
      u_coolness: { type: C.UniformType.FLOAT, value: palette.coolness },
      u_blueGrayMix: { type: C.UniformType.FLOAT, value: palette.blueGrayMix },
      u_shadowLift: { type: C.UniformType.FLOAT, value: palette.shadowLift }
    },
    fragmentShaderText: `
      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
        vec3 source = czm_linearToSrgb(max(material.diffuse, vec3(0.0)));
        float luminance = dot(source, vec3(0.2126, 0.7152, 0.0722));
        vec3 graded = mix(vec3(luminance), source, u_saturation);
        graded = (graded - vec3(0.5)) * u_contrast + vec3(0.5);
        graded *= u_brightness * vec3(1.0 - 0.45 * u_coolness,
                                     1.0 + 0.08 * u_coolness,
                                     1.0 + 0.35 * u_coolness);
        // Limited blue-gray grading preserves at least 60% of the graded original
        // color even at the strongest allowed setting. Brighter concrete remains
        // brighter than darker ground; warm source materials retain their identity.
        vec3 blueGray = luminance * vec3(0.58, 0.84, 1.10);
        graded = mix(graded, blueGray, u_blueGrayMix);
        float shadowWeight = 1.0 - smoothstep(0.08, 0.50, luminance);
        graded += u_shadowLift * shadowWeight * (vec3(1.0) - graded);
        material.diffuse = czm_srgbToLinear(max(graded, vec3(0.0)));
      }
    `
  });
  const releaseMaterials = () => {
    for (const r of activeRecords) {
      if (!r.tileset.isDestroyed?.()) {
        if (r.tileset.customShader === r.shader) r.tileset.customShader = r.oldShader;
        else lastRestoreConflicts.push({ id: r.id, property: 'customShader' });
        if (r.tileset.style === undefined) r.tileset.style = r.oldStyle;
        else if (r.tileset.style !== r.oldStyle) lastRestoreConflicts.push({ id: r.id, property: 'style' });
        // Cesium 1.120 Model content can retain the old collection reference after
        // tileset detachment. Disable first so that its next update drops clip draw commands
        // before touching textures destroyed by the collection-owner setter.
        if (r.tileset.clippingPolygons === r.clipping) { r.clipping.enabled = false; r.tileset.clippingPolygons = undefined; }
        else lastRestoreConflicts.push({ id: r.id, property: 'clippingPolygons' });
      }
      if (!r.shader.isDestroyed()) r.shader.destroy();
      // Older setters destroy the attached collection; newer builds may not.
      if (r.clipping?.isDestroyed && !r.clipping.isDestroyed()) r.clipping.destroy();
    }
    activeRecords = [];
  };
  const release = () => {
    dataSource.show = false; releaseMaterials(); restoreScene(); mode = 'reality'; request();
  };
  const setMode = next => {
    if (!alive()) return { ok: false, state: 'destroyed' };
    if (!['showcase', 'reality'].includes(next)) return { ok: false, code: 'INVALID_MODE' };
    if (next === mode && !runtimeError) return emit();
    lastRestoreConflicts = []; runtimeError = null;
    release();
    if (lastRestoreConflicts.length || next === 'reality') return emit();
    // Re-check ownership because a different feature may have changed state in reality mode.
    for (const r of originals) {
      if (r.tileset.isDestroyed?.() || r.tileset.clippingPolygons || r.tileset.clippingPlanes ||
          r.tileset.style !== r.style || r.tileset.customShader !== r.shader) {
        lastRestoreConflicts.push({ id: r.id, property: 'runtime ownership changed' });
      }
    }
    if (lastRestoreConflicts.length) return emit();
    try {
      patch(scene, 'backgroundColor', color(palette.background));
      for (const target of [scene.skyBox, scene.skyAtmosphere, scene.sun, scene.moon, scene.globe]) patch(target, 'show', false);
      patch(scene.fog, 'enabled', false);
      for (const r of originals) {
        const shader = makeShader();
        const clipping = new C.ClippingPolygonCollection({
          polygons: [new C.ClippingPolygon({ positions: clippingPositions.map(p => C.Cartesian3.clone(p)), ellipsoid })],
          enabled: true, inverse: true
        });
        activeRecords.push({ ...r, shader, clipping, oldShader: r.tileset.customShader, oldStyle: r.tileset.style });
        r.tileset.style = undefined;
        r.tileset.customShader = shader;
        r.tileset.clippingPolygons = clipping;
      }
      dataSource.show = true; mode = 'showcase'; renderedFrames = 0; request();
    } catch (error) {
      runtimeError = { code: 'APPLY_FAILED', message: String(error?.message || error) };
      release();
    }
    return emit();
  };
  const removeRender = scene.postRender.addEventListener(() => {
    if (mode === 'showcase') renderedFrames += 1;
  });
  const removeError = scene.renderError.addEventListener((_scene, error) => {
    if (mode !== 'showcase') return;
    runtimeError = { code: 'RENDER_FAILED', message: String(error?.message || error) };
    // Tell the host; do not label an API assignment as a successful visual result.
    emit();
  });
  const home = ({ duration = 1.6, headingDegrees = 325, pitchDegrees = -38,
    rangeMultiplier, rangeMeters, target, padding = { left: 320, right: 320, top: 110, bottom: 110 } } = {}) => {
    if (!alive()) return { ok: false, state: 'destroyed' };
    if (![duration, headingDegrees, pitchDegrees].every(Number.isFinite) ||
        duration < 0 || pitchDegrees >= 0 || pitchDegrees < -90 ||
        (rangeMultiplier !== undefined && (!Number.isFinite(rangeMultiplier) || rangeMultiplier < 1)) ||
        (rangeMeters !== undefined && (!Number.isFinite(rangeMeters) || rangeMeters <= 0)) ||
        (target !== undefined && !finitePoint(target)))
      return { ok: false, code: 'INVALID_CAMERA_OPTIONS' };
    const canvas = scene.canvas, w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
    const p = { left: 0, right: 0, top: 0, bottom: 0, ...padding };
    if (Object.values(p).some(v => !Number.isFinite(v) || v < 0)) return { ok: false, code: 'INVALID_PADDING' };
    // Symmetric safe extent keeps the complete sphere out of both overlay panels.
    const safeX = Math.max(0.15, 1 - 2 * Math.max(p.left, p.right) / w);
    const safeY = Math.max(0.15, 1 - 2 * Math.max(p.top, p.bottom) / h);
    const frustum = viewer.camera.frustum;
    if (!Number.isFinite(frustum.fovy)) return { ok: false, code: 'PERSPECTIVE_CAMERA_REQUIRED' };
    const vertical = Math.tan(frustum.fovy / 2);
    const safeHalfAngle = Math.atan(Math.min(vertical * (w / h) * safeX, vertical * safeY));
    const range = rangeMeters ?? sphere.radius * (rangeMultiplier ?? (1.04 / Math.sin(safeHalfAngle)));
    const offset = new C.HeadingPitchRange(C.Math.toRadians(headingDegrees), C.Math.toRadians(pitchDegrees), range);
    const cameraSphere = target ? new C.BoundingSphere(C.Cartesian3.clone(target), sphere.radius) : sphere;
    viewer.camera.flyToBoundingSphere(cameraSphere, { duration, offset });
    request(); return { ok: true, envelopeId: env.id, rangeMeters: range, padding: p, target: C.Cartesian3.clone(cameraSphere.center) };
  };
  const getEvidence = () => ({ ...currentStatus(),
    scope: 'existing-viewer-presentation-only', createdViewerCount: 0, businessGeometryWrites: 0,
    tilesets: matrices.map(({ id, t, matrix }) => ({ id, alive: !t.isDestroyed?.(),
      modelMatrixUnchanged: !t.isDestroyed?.() && C.Matrix4.equals(t.modelMatrix, matrix),
      shaderAttached: activeRecords.some(r => r.tileset === t && t.customShader === r.shader),
      clippingAttached: activeRecords.some(r => r.tileset === t && t.clippingPolygons === r.clipping),
      clippingInverse: t.clippingPolygons?.inverse ?? null })),
    presentationEntityCount: dataSource.entities.values.length,
    presentationVisible: dataSource.show, baseDepthMeters: depth, baseHeightMeters: baseHeight,
    boundaryVertices: positions.map(p => ({ x: p.x, y: p.y, z: p.z })),
    boundaryHeightRange: [Math.min(...topHeights), Math.max(...topHeights)],
    clippingVertexCount: clippingPositions.length, sampledBoundaryVertexCount: positions.length, clippingBoundaryDeviationMeters,
    palette: { ...palette }, lightingModel: 'inherited', materialColorStrategy: 'source-texture-with-blue-gray-grade',
    displayOnly: true, envelopeWritesToBusinessStore: 0
  });
  const destroy = () => {
    if (destroyed) return currentStatus();
    if (!viewer.isDestroyed?.()) release();
    else for (const r of activeRecords) if (!r.shader.isDestroyed()) r.shader.destroy();
    removeRender(); removeError();
    if (!viewer.isDestroyed?.()) viewer.dataSources.remove(dataSource, true);
    destroyed = true; return emit();
  };
  const controller = Object.freeze({ setMode, home, getStatus: currentStatus, getEvidence,
    getOwnedObjects: () => [...dataSource.entities.values], destroy });
  const status = setMode(initialMode);
  if (!status.ok) { destroy(); return { ok: false, status }; }
  return { ok: true, status, controller };
}
