/**
 * World-space presentation effects. ES module; no framework, images, Ion or backend.
 * Pass the Cesium namespace already used by the application and its existing Viewer.
 * All coordinates are caller-supplied ECEF metres in that Viewer's world frame.
 * This module never picks a point, creates business objects or writes user geometry.
 * Public APIs: Material/Fabric, Primitive, PolylineGeometry, Geometry, Transforms.
 * Docs: https://cesium.com/learn/cesiumjs/ref-doc/Material.html
 *       https://cesium.com/learn/cesiumjs/ref-doc/Primitive.html
 *       https://cesium.com/learn/cesiumjs/ref-doc/Transforms.html
 */

export const EFFECT_DEFAULTS = Object.freeze({
  pulsePeriodSeconds: 2.4,
  pulseDelaySeconds: 0.8,
  pulseRadiusMeters: 35,
  normalOffsetMeters: 0.2,
  routePeriodSeconds: 4,
  routeWidthPx: 4,
  selectionWidthPx: 3,
  cyan: '#43d9ff',
  amber: '#ffb957',
  red: '#ff687d'
});

// The complete Fabric source is passed to the public Material constructor.
// There is no private Material._materialCache registration and no texture download.
const PULSE_SOURCE = `
float pulseBand(float radius, float phase, float thickness) {
  float ringRadius = 0.08 + 0.86 * phase;
  float edge = 1.0 - smoothstep(thickness, thickness * 2.1,
                              abs(radius - ringRadius));
  float fade = smoothstep(0.0, 0.08, phase) * pow(1.0 - phase, 0.75);
  return edge * fade;
}
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  float radius = length(materialInput.st * 2.0 - 1.0);
  float phaseA = fract(seconds / period);
  float phaseB = fract((seconds - delay) / period + 1.0);
  float rings = pulseBand(radius, phaseA, thickness)
              + pulseBand(radius, phaseB, thickness);
  float base = (1.0 - smoothstep(0.007, 0.016, abs(radius - 0.95))) * 0.10;
  float center = (1.0 - smoothstep(0.0, 0.035, radius)) * 0.50;
  material.diffuse = color.rgb;
  material.emission = color.rgb * 0.12;
  material.alpha = min(0.82, rings * 0.65 + base + center) * color.a;
  return material;
}`;

const FLOW_SOURCE = `
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  float progress = fract(seconds / period);
  float behind = fract(progress - materialInput.st.s + 1.0);
  float trail = (1.0 - smoothstep(0.0, tailLength, behind));
  float edge = 1.0 - smoothstep(0.22, 0.5, abs(materialInput.st.t - 0.5));
  float head = 1.0 - smoothstep(0.0, 0.018, behind);
  material.diffuse = mix(color.rgb, vec3(0.88, 0.98, 1.0), head * 0.45);
  material.emission = color.rgb * trail * 0.18;
  material.alpha = (baseAlpha + trail * (1.0 - baseAlpha)) * edge * color.a;
  return material;
}`;

/**
 * createWorldEffects(Cesium, viewer, options?)
 * options: { paused?, reducedMotion?, pulseRings?[], flowRoutes?[], selectionOutlines?[] }
 * No defaults include geography or business objects; an empty options object is empty.
 * Ring anchor is an existing model-surface point. A ring is a local planar decoration,
 * not a draped surface or a safety-distance boundary. Route coordinates stay unchanged.
 * In a custom render loop, call viewer.render() as usual; this module owns no RAF loop.
 */
export function createWorldEffects(Cesium, viewer, options = {}) {
  const C = Cesium;
  if (!C?.Primitive || !viewer?.scene?.primitives) {
    throw new TypeError('An existing Cesium namespace and Viewer are required.');
  }
  const scene = viewer.scene;
  if (scene.mode !== C.SceneMode.SCENE3D) {
    throw new Error('World effects require the existing Viewer to be in 3D mode.');
  }
  const owned = scene.primitives.add(new C.PrimitiveCollection({ destroyPrimitives: true }));
  const entries = new Map();
  let disposed = false;
  let paused = !!options.paused;
  let reducedMotion = !!options.reducedMotion;
  let elapsedSeconds = 0.6;
  let lastNow = performance.now();

  const alive = () => !disposed && !(scene.isDestroyed?.());
  const requestRender = () => { if (alive()) scene.requestRender(); };
  const assertAlive = () => {
    if (!alive() || owned.isDestroyed()) throw new Error('World effects have been disposed.');
  };
  function number(value, fallback, name, min = -Infinity, max = Infinity) {
    const n = value === undefined ? fallback : value;
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new RangeError(`${name} must be finite and within [${min}, ${max}].`);
    }
    return n;
  }
  function worldPoint(point, name) {
    if (!point || !['x', 'y', 'z'].every(k => Number.isFinite(point[k])) ||
        Math.hypot(point.x, point.y, point.z) < 1000000) {
      throw new TypeError(`${name} must be a caller-supplied ECEF position in metres; transform local/screen coordinates first.`);
    }
    return C.Cartesian3.clone(point);
  }
  function worldLine(points, closed) {
    if (!Array.isArray(points) || points.length < (closed ? 3 : 2)) {
      throw new TypeError(`Supply at least ${closed ? 3 : 2} existing world positions.`);
    }
    const copy = points.map((point, i) => worldPoint(point, `positions[${i}]`));
    const distinct = copy.filter((point, i) => i === 0 ||
      C.Cartesian3.distance(point, copy[i - 1]) > 0.001);
    if (closed && C.Cartesian3.distance(distinct[0], distinct[distinct.length - 1]) < 0.001) {
      distinct.pop();
    }
    if (distinct.length < (closed ? 3 : 2)) throw new Error('The supplied geometry has too few distinct vertices.');
    if (closed) distinct.push(C.Cartesian3.clone(distinct[0]));
    return distinct;
  }
  function effectId(id) {
    assertAlive();
    if (typeof id !== 'string' || !id.trim()) throw new TypeError('A stable non-empty effect id is required.');
    if (entries.has(id)) throw new Error(`Effect id already exists: ${id}. Remove it before replacing geometry.`);
    return id;
  }
  function effectColor(value, fallback, opacity) {
    const color = typeof (value ?? fallback) === 'string'
      ? C.Color.fromCssColorString(value ?? fallback)
      : C.Color.clone(value);
    if (!color || !['red', 'green', 'blue', 'alpha'].every(k => Number.isFinite(color[k]))) {
      throw new TypeError('Color must be a valid CSS color or Cesium.Color.');
    }
    color.alpha *= number(opacity, 1, 'opacity', 0, 1);
    return color;
  }
  function track(id, type, primitive, material, animated) {
    owned.add(primitive);
    entries.set(id, { id, type, primitive, material, animated });
    requestRender();
    return id;
  }
  function linePrimitive(id, positions, width, material) {
    return new C.Primitive({
      geometryInstances: new C.GeometryInstance({
        id: `presentation-effect:${id}`,
        geometry: new C.PolylineGeometry({
          positions,
          width,
          // Exact supplied 3D segments, with no ellipsoid arc, terrain sampling or clamping.
          arcType: C.ArcType.NONE,
          vertexFormat: C.PolylineMaterialAppearance.VERTEX_FORMAT
        })
      }),
      appearance: new C.PolylineMaterialAppearance({
        material,
        translucent: true,
        renderState: { depthTest: { enabled: true }, depthMask: false }
      }),
      asynchronous: false,
      allowPicking: false
    });
  }

  function addPulseRing(config) {
    const id = effectId(config?.id);
    const anchor = worldPoint(config.anchor, 'anchor');
    const radius = number(config.radiusMeters, EFFECT_DEFAULTS.pulseRadiusMeters, 'radiusMeters', 0.1, 10000);
    const z = number(config.normalOffsetMeters, EFFECT_DEFAULTS.normalOffsetMeters, 'normalOffsetMeters', -100, 1000);
    const period = number(config.periodSeconds, EFFECT_DEFAULTS.pulsePeriodSeconds, 'periodSeconds', 0.5, 120);
    const delay = number(config.delaySeconds, EFFECT_DEFAULTS.pulseDelaySeconds, 'delaySeconds', 0, period);
    const material = new C.Material({
      fabric: {
        uniforms: {
          color: effectColor(config.color, EFFECT_DEFAULTS.cyan, config.opacity),
          seconds: elapsedSeconds,
          period,
          delay,
          thickness: number(config.ringThickness, 0.012, 'ringThickness', 0.002, 0.10)
        },
        source: PULSE_SOURCE
      },
      translucent: true
    });
    const positions = new Float64Array([-radius, -radius, z, radius, -radius, z,
      radius, radius, z, -radius, radius, z]);
    const geometry = new C.Geometry({
      attributes: {
        position: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.DOUBLE,
          componentsPerAttribute: 3, values: positions }),
        normal: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.FLOAT,
          componentsPerAttribute: 3, values: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]) }),
        st: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.FLOAT,
          componentsPerAttribute: 2, values: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]) })
      },
      indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
      primitiveType: C.PrimitiveType.TRIANGLES,
      boundingSphere: C.BoundingSphere.fromVertices(positions)
    });
    // Local X=east, Y=north, Z=up. Optional tilt affects only this decoration.
    const hpr = new C.HeadingPitchRoll(...['headingDegrees', 'pitchDegrees', 'rollDegrees']
      .map(key => C.Math.toRadians(number(config[key], 0, key, -360, 360))));
    const modelMatrix = C.Transforms.headingPitchRollToFixedFrame(anchor, hpr);
    const primitive = new C.Primitive({
      geometryInstances: new C.GeometryInstance({ id: `presentation-effect:${id}`, geometry }),
      modelMatrix,
      appearance: new C.MaterialAppearance({
        material,
        materialSupport: C.MaterialAppearance.MaterialSupport.TEXTURED,
        flat: true,
        faceForward: true,
        closed: false,
        translucent: true,
        renderState: { depthTest: { enabled: true }, depthMask: false }
      }),
      asynchronous: false,
      allowPicking: false
    });
    return track(id, 'pulse-ring', primitive, material, true);
  }

  function addFlowRoute(config) {
    const id = effectId(config?.id);
    const positions = worldLine(config.positions, false);
    const material = new C.Material({
      fabric: {
        uniforms: {
          color: effectColor(config.color, EFFECT_DEFAULTS.cyan, config.opacity),
          seconds: elapsedSeconds,
          period: number(config.periodSeconds, EFFECT_DEFAULTS.routePeriodSeconds, 'periodSeconds', 0.5, 120),
          tailLength: number(config.tailFraction, 0.2, 'tailFraction', 0.02, 0.5),
          baseAlpha: number(config.baseAlpha, 0.18, 'baseAlpha', 0, 0.6)
        },
        source: FLOW_SOURCE
      },
      translucent: true
    });
    const primitive = linePrimitive(id, positions,
      number(config.widthPx, EFFECT_DEFAULTS.routeWidthPx, 'widthPx', 1, 20), material);
    return track(id, 'flow-route', primitive, material, true);
  }

  function addSelectionOutline(config) {
    const id = effectId(config?.id);
    const positions = worldLine(config.positions, config.closed !== false);
    const material = C.Material.fromType('PolylineGlow', {
      color: effectColor(config.color, EFFECT_DEFAULTS.cyan, config.opacity ?? 0.8),
      glowPower: 0.12,
      taperPower: 1
    });
    const primitive = linePrimitive(id, positions,
      number(config.widthPx, EFFECT_DEFAULTS.selectionWidthPx, 'widthPx', 1, 12), material);
    return track(id, 'selection-outline', primitive, material, false);
  }

  function applyTime() {
    for (const entry of entries.values()) {
      if (entry.animated) entry.material.uniforms.seconds = elapsedSeconds;
    }
  }
  function remove(id) {
    assertAlive();
    const entry = entries.get(id);
    if (!entry) return false;
    owned.remove(entry.primitive);
    if (!entry.material.isDestroyed()) entry.material.destroy();
    entries.delete(id);
    requestRender();
    return true;
  }
  function setVisible(id, visible) {
    assertAlive();
    const entry = entries.get(id);
    if (!entry) return false;
    entry.primitive.show = !!visible;
    lastNow = performance.now();
    requestRender();
    return true;
  }
  function pause() { assertAlive(); paused = true; requestRender(); }
  function resume() { assertAlive(); paused = false; lastNow = performance.now(); requestRender(); }
  function setReducedMotion(value) {
    assertAlive(); reducedMotion = !!value; lastNow = performance.now(); requestRender();
  }
  function setTime(seconds) {
    assertAlive();
    const next = number(seconds, 0, 'seconds', 0, 100000000);
    if (next === elapsedSeconds) return;
    elapsedSeconds = next;
    lastNow = performance.now(); applyTime(); requestRender();
  }
  function getState() {
    return {
      disposed, paused, reducedMotion, elapsedSeconds, clockOwner: options.externalClock ? 'host' : 'scene-postUpdate',
      effects: [...entries.values()].map(entry => ({
        id: entry.id, type: entry.type, visible: entry.primitive.show
      }))
    };
  }
  const removeUpdate = options.externalClock ? () => {} : scene.postUpdate.addEventListener(() => {
    const now = performance.now();
    const delta = Math.max(0, (now - lastNow) / 1000);
    lastNow = now;
    if (!alive() || paused || reducedMotion || globalThis.document?.hidden) return;
    if (![...entries.values()].some(entry => entry.animated && entry.primitive.show)) return;
    elapsedSeconds += delta;
    applyTime();
    // Only visible, playing animations request more frames. Never changes the Viewer clock.
    scene.requestRender();
  });
  function dispose() {
    if (disposed) return;
    removeUpdate();
    if (!scene.isDestroyed?.() && scene.primitives.contains(owned)) scene.primitives.remove(owned);
    else if (!owned.isDestroyed()) owned.destroy();
    for (const entry of entries.values()) {
      if (!entry.material.isDestroyed()) entry.material.destroy();
    }
    entries.clear();
    disposed = true;
  }
  try {
    for (const config of options.pulseRings ?? []) addPulseRing(config);
    for (const config of options.flowRoutes ?? []) addFlowRoute(config);
    for (const config of options.selectionOutlines ?? []) addSelectionOutline(config);
  } catch (error) {
    dispose();
    throw error;
  }
  return Object.freeze({ addPulseRing, addFlowRoute, addSelectionOutline,
    remove, setVisible, pause, resume, setReducedMotion, setTime, getState,
    getOwnedObjects: () => [owned], dispose });
}
