import {
  ArcType, Cartesian2, Cartesian3, Cartographic, Cesium3DTileset,
  Color, ColorGeometryInstanceAttribute,
  ConstantProperty, CustomShader, CustomShaderMode, CustomShaderTranslucencyMode, GeometryInstance, EllipseGeometry,
  LabelCollection, LightingModel, Material, MaterialAppearance, Matrix4,
  PerInstanceColorAppearance, PolygonGeometry, PolylineGeometry, PolylineMaterialAppearance,
  Primitive, PrimitiveCollection, SceneMode, SceneTransforms, Transforms, UniformType, WallGeometry,
  type Entity, type Property, type Viewer,
} from "cesium";
import tokens from "./safetyDesignTokens.json";
import type { ImportRecord } from "./types";
import type { SafetyDataset, SafetyNode, SafetyState, SafetyView } from "./safetyTypes";

export type SafetyStageRect = { left: number; top: number; width: number; height: number };
export type SafetyPresentationOptions = {
  getImports?: () => readonly ImportRecord[];
  getStageRect?: () => SafetyStageRect;
  onPresentationStatus?: (messages: string[]) => void;
};
type TileState = { tileset: Cesium3DTileset; shader: CustomShader; previousShader: CustomShader | undefined };
type Stage = {
  key: string; origin: Cartesian3; enu: Matrix4; angle: number; halfLength: number; halfWidth: number;
  positions: Cartesian3[]; center: Cartesian3; radius: number; topHeight: number; bottomHeight: number;
  heading: number; pitch: number; range: number;
};
type LabelState = { labels: LabelCollection; show: boolean; individual: Array<{ show: boolean; id: unknown }> };

const MODEL_SHADER = `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  vec3 local = (u_fixedToStage * czm_inverseView * vec4(fsInput.attributes.positionEC, 1.0)).xyz;
  float ca = cos(u_stageAngle), sa = sin(u_stageAngle);
  vec2 p = vec2(local.x * ca + local.y * sa, -local.x * sa + local.y * ca);
  vec2 q = abs(p) - u_halfExtent;
  if (u_clipEnabled > 0.5 && max(q.x, q.y) > 0.0) discard;
  // Preserve photographed detail. This asset has unlit textured meshes, not semantic BIM surfaces.
  float luminance = dot(material.diffuse, vec3(0.2126, 0.7152, 0.0722));
  float tone = pow(clamp(luminance, 0.0, 1.0), 0.65);
  vec3 n = normalize(cross(dFdx(fsInput.attributes.positionEC), dFdy(fsInput.attributes.positionEC)));
  float roof = abs(dot(n, normalize((czm_view * vec4(u_upWC, 0.0)).xyz)));
  vec3 blue = mix(czm_srgbToLinear(u_dark.rgb), czm_srgbToLinear(u_light.rgb), tone);
  // Display weights in local coordinates do not identify buildings or alter engineering geometry.
  float shoulder = smoothstep(u_halfExtent.y * 0.22, u_halfExtent.y * 0.94, abs(p.y));
  float elevated = smoothstep(u_baseHeight + 28.0, u_baseHeight + 95.0, local.z);
  float emphasis = 1.0 - 0.34 * shoulder - 0.20 * elevated * shoulder;
  material.diffuse = blue * (0.76 + 0.24 * roof) * emphasis;
  material.alpha = 1.0;
}
`;

/** Owns presentation-only style and geometry; never changes a model matrix, source coordinate or saved layer flag. */
export class SafetyScenePresentation {
  private readonly primitives = new PrimitiveCollection();
  private focusPrimitive?: Primitive;
  private focusMaterial?: Material;
  private arcPrimitive?: Primitive;
  private arcMaterial?: Material;
  private focusPosition?: Cartesian3;
  private focusEnabled = false;
  private motionStarted = false;
  private focusGeometryBuilds = 0;
  private readonly tiles = new Map<Cesium3DTileset, TileState>();
  private readonly labels = new Map<LabelCollection, LabelState>();
  private readonly entityLabels = new Map<Entity, Property | undefined>();
  private readonly fixedToStage = new Matrix4();
  private readonly upWC = new Cartesian3();
  private dataset?: SafetyDataset;
  private state?: SafetyState;
  private view?: SafetyView;
  private stage?: Stage;
  private active = false;
  private authoring = false;
  private readonly cadGeometry = new Map<{ show: boolean; isDestroyed?: (() => boolean) | boolean }, boolean>();
  private readonly cadEntityShows = new Map<Entity, boolean>();
  private styled = false;
  private disposed = false;
  private globeShow = true;
  private skyShow = true;
  private atmosphereShow = true;
  private background?: Color;
  private lastSync = -Infinity;
  private lastHeightSample = -Infinity;
  private heightSamples = 0;
  private messages: string[] = [];

  constructor(private readonly viewer: Viewer, private readonly options: SafetyPresentationOptions,
    _excludedObjects: () => Entity[]) {
    this.primitives.show = false;
    viewer.scene.primitives.add(this.primitives);
  }

  update(dataset: SafetyDataset, state: SafetyState, view: SafetyView, active: boolean): void {
    if (this.disposed) return;
    this.dataset = dataset; this.state = state; this.view = view; this.active = active;
    if (!active) { this.restore(); return; }
    this.syncAnnotations();
    if (state.mode !== "presentation") { this.restoreScene(); return; }
    const scope = [...view.breadcrumbs].reverse().find((node) => node.kind === "section" && !node.spatialObjectId) ?? dataset.nodes.find((node) => node.id === dataset.projectId)!;
    const key = `${scope.id}:${JSON.stringify(scope.boundary ?? scope.position)}`;
    if (this.stage?.key !== key) {
      this.stage = this.makeStage(scope, key);
      this.heightSamples = 0;
      this.lastHeightSample = -Infinity;
      this.rebuildBase();
      for (const entry of this.tiles.values()) this.configureShader(entry.shader);
    }
    if (!this.styled) {
      const scene = this.viewer.scene;
      this.globeShow = scene.globe.show;
      this.skyShow = scene.skyBox?.show ?? false;
      this.atmosphereShow = scene.skyAtmosphere?.show ?? false;
      this.background = scene.backgroundColor.clone();
      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      scene.backgroundColor = Color.fromCssColorString(tokens.colors.background)!;
      this.styled = true;
    }
    this.primitives.show = !this.authoring;
    this.syncTiles();
    this.updateUniforms();
  }

  private makeStage(scope: SafetyNode, key: string): Stage {
    const dataset = this.dataset!;
    const byId = new Map(dataset.nodes.map((node) => [node.id, node]));
    const inside = (node: SafetyNode) => {
      let current: SafetyNode | undefined = node;
      const seen = new Set<string>();
      while (current && !seen.has(current.id)) {
        if (current.id === scope.id) return true;
        seen.add(current.id); current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return false;
    };
    const anchors = dataset.nodes.filter((node) => node.kind === "pier" && inside(node));
    const source = anchors.length >= 2 ? anchors.map((node) => node.position) : scope.boundary?.length ? scope.boundary : [scope.position];
    const origin = Cartesian3.fromDegrees(scope.position.longitude, scope.position.latitude, 0);
    const enu = Transforms.eastNorthUpToFixedFrame(origin), inverse = Matrix4.inverseTransformation(enu, new Matrix4());
    const points = source.map((p) => Matrix4.multiplyByPoint(inverse, Cartesian3.fromDegrees(p.longitude, p.latitude, p.height), new Cartesian3()));
    const mean = points.reduce((sum, p) => Cartesian3.add(sum, p, sum), new Cartesian3());
    Cartesian3.divideByScalar(mean, points.length, mean);
    let xx = 0, yy = 0, xy = 0;
    for (const p of points) { xx += (p.x - mean.x) ** 2; yy += (p.y - mean.y) ** 2; xy += (p.x - mean.x) * (p.y - mean.y); }
    const angle = points.length > 1 ? 0.5 * Math.atan2(2 * xy, xx - yy) : Math.PI / 4;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const along = points.map((p) => (p.x - mean.x) * ca + (p.y - mean.y) * sa);
    const across = points.map((p) => -(p.x - mean.x) * sa + (p.y - mean.y) * ca);
    const halfLength = Math.max(90, (Math.max(...along) - Math.min(...along)) / 2 + 75);
    const halfWidth = Math.max(scope.kind === "project" ? halfLength * 0.52 : halfLength * 0.48, 75, (Math.max(...across) - Math.min(...across)) / 2 + 55);
    const middleA = (Math.max(...along) + Math.min(...along)) / 2, middleB = (Math.max(...across) + Math.min(...across)) / 2;
    mean.x += middleA * ca - middleB * sa; mean.y += middleA * sa + middleB * ca;
    const centerZero = Matrix4.multiplyByPoint(enu, new Cartesian3(mean.x, mean.y, 0), new Cartesian3());
    const stageEnu = Transforms.eastNorthUpToFixedFrame(centerZero);
    const radius = Math.hypot(halfLength, halfWidth);
    const rect = this.options.getStageRect?.() ?? { left: 0, top: 0, width: this.viewer.canvas.clientWidth, height: this.viewer.canvas.clientHeight };
    const fovy = "fovy" in this.viewer.camera.frustum ? Number(this.viewer.camera.frustum.fovy) : Math.PI / 3;
    const pitch = (tokens.scene.cameraPitchReferenceDegrees[0] + tokens.scene.cameraPitchReferenceDegrees[1]) / 2 * Math.PI / 180;
    const projectedCorridorAngle = Math.PI / 6;
    const diagonalOffset = Math.atan(Math.sin(Math.abs(pitch)) / Math.tan(projectedCorridorAngle));
    const screenHalfWidth = halfLength * Math.sin(diagonalOffset) + halfWidth * Math.cos(diagonalOffset);
    const screenHalfHeight = (halfLength * Math.cos(diagonalOffset) + halfWidth * Math.sin(diagonalOffset)) * Math.sin(Math.abs(pitch));
    const occupancy = (tokens.layout.stageOccupancyRange[0] + tokens.layout.stageOccupancyRange[1]) / 2;
    const pixelsPerRadian = this.viewer.canvas.clientHeight / (2 * Math.tan(fovy / 2));
    // Fit the actual projected rectangle to the uncovered stage, including perspective at the near edge.
    const range = Math.max(screenHalfWidth * 2 / Math.max(180, rect.width * occupancy), screenHalfHeight * 2 / Math.max(180, rect.height * occupancy)) * pixelsPerRadian * 1.05;
    const thickness = Math.max(18, range * 2 * Math.tan(fovy / 2) / Math.max(1, this.viewer.canvas.clientHeight)
      * ((tokens.scene.displayBaseApparentThicknessPx[0] + tokens.scene.displayBaseApparentThicknessPx[1]) / 2) / Math.cos(pitch));
    const topHeight = scope.position.height - 1;
    const positions = [[-halfLength, -halfWidth], [halfLength, -halfWidth], [halfLength, halfWidth], [-halfLength, halfWidth]].map(([x, y]) =>
      Matrix4.multiplyByPoint(stageEnu, new Cartesian3(x * ca - y * sa, x * sa + y * ca, 0), new Cartesian3()));
    const center = Cartesian3.clone(centerZero);
    const carto = Cartographic.fromCartesian(center);
    Cartesian3.fromRadians(carto.longitude, carto.latitude, topHeight, undefined, center);
    // Keep source coordinates fixed; only orient the camera for a 30-degree projected corridor.
    const bearing = Math.PI / 2 - angle;
    const heading = bearing - diagonalOffset;
    return { key, origin: centerZero, enu: stageEnu, angle, halfLength, halfWidth, positions, center, radius, topHeight, bottomHeight: topHeight - thickness, heading, pitch, range };
  }

  private configureShader(shader: CustomShader): void {
    if (!this.stage) return;
    shader.setUniform("u_stageAngle", this.stage.angle);
    shader.setUniform("u_halfExtent", new Cartesian2(this.stage.halfLength, this.stage.halfWidth));
  }

  private syncTiles(): void {
    if (!this.stage || !this.styled) return;
    const records = this.options.getImports?.() ?? [];
    const current = new Set(records.filter((record) => record.kind === "3D Tiles" && record.visible).map((record) => record.resource as Cesium3DTileset));
    for (const [tileset, entry] of this.tiles) if (!current.has(tileset) || tileset.isDestroyed() || tileset.customShader !== entry.shader || tileset.style) this.releaseTile(entry);
    const messages: string[] = [];
    for (const record of records) {
      if (record.kind !== "3D Tiles" || !record.visible) continue;
      const tileset = record.resource as Cesium3DTileset;
      if (tileset.isDestroyed() || this.tiles.has(tileset)) continue;
      if (tileset.customShader || tileset.style) {
        messages.push(`${record.name} 已有专用着色/样式，汇报调色已跳过以保留原功能。`); continue;
      }
      const shader = new CustomShader({
        mode: CustomShaderMode.MODIFY_MATERIAL, translucencyMode: CustomShaderTranslucencyMode.INHERIT,
        lightingModel: LightingModel.UNLIT,
        uniforms: {
          u_fixedToStage: { type: UniformType.MAT4, value: new Matrix4() },
          u_stageAngle: { type: UniformType.FLOAT, value: this.stage.angle },
          u_halfExtent: { type: UniformType.VEC2, value: new Cartesian2(this.stage.halfLength, this.stage.halfWidth) },
          u_clipEnabled: { type: UniformType.FLOAT, value: this.authoring ? 0 : 1 },
          u_baseHeight: { type: UniformType.FLOAT, value: this.stage.topHeight },
          u_upWC: { type: UniformType.VEC3, value: new Cartesian3(0, 1, 0) },
          u_dark: { type: UniformType.VEC4, value: Color.fromCssColorString(tokens.colors.sceneDark)! },
          u_light: { type: UniformType.VEC4, value: Color.lerp(Color.fromCssColorString(tokens.colors.sceneDark)!, Color.fromCssColorString(tokens.colors.cyan)!, 0.43, new Color()) },
        }, fragmentShaderText: MODEL_SHADER,
      });
      const entry: TileState = { tileset, shader, previousShader: tileset.customShader };
      try {
        tileset.customShader = shader;
        this.tiles.set(tileset, entry);
      } catch (error) {
        if (tileset.customShader === shader) tileset.customShader = entry.previousShader;
        if (!shader.isDestroyed()) shader.destroy();
        messages.push(`${record.name} 汇报样式不可用：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (messages.join("|") !== this.messages.join("|")) { this.messages = messages; this.options.onPresentationStatus?.([...messages]); }
  }

  private updateUniforms(): void {
    if (!this.stage) return;
    // Automatic view uniforms follow the current render pass, including Cesium's offscreen height sampler.
    // A main-camera-only EC matrix would silently corrupt those auxiliary depth passes.
    Matrix4.inverseTransformation(this.stage.enu, this.fixedToStage);
    Matrix4.multiplyByPointAsVector(this.stage.enu, Cartesian3.UNIT_Z, this.upWC);
    Cartesian3.normalize(this.upWC, this.upWC);
    for (const entry of this.tiles.values()) if (!entry.shader.isDestroyed() && !entry.tileset.isDestroyed() && entry.tileset.customShader === entry.shader) {
      entry.shader.setUniform("u_clipEnabled", this.authoring ? 0 : 1); entry.shader.setUniform("u_baseHeight", this.stage.topHeight);
      entry.shader.setUniform("u_fixedToStage", this.fixedToStage); entry.shader.setUniform("u_upWC", this.upWC);
    }
  }

  private rebuildBase(): void {
    this.primitives.removeAll();
    this.focusPrimitive = this.arcPrimitive = undefined; this.focusMaterial = this.arcMaterial = undefined;
    const stage = this.stage;
    if (!stage) return;
    const basePositions = stage.positions.map((position) => { const p = Cartographic.fromCartesian(position); return Cartesian3.fromRadians(p.longitude, p.latitude, stage.topHeight); });
    const loop = [...basePositions, basePositions[0]];
    const wall = WallGeometry.fromConstantHeights({ positions: loop, maximumHeight: stage.topHeight, minimumHeight: stage.bottomHeight,
      vertexFormat: MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat });
    const sideMaterial = new Material({ fabric: {
      type: "SafetyDisplayBaseSide", uniforms: { topColor: Color.fromCssColorString(tokens.colors.sceneDark)!, bottomColor: Color.fromCssColorString(tokens.colors.panel)! },
      source: `czm_material czm_getMaterial(czm_materialInput materialInput) {
        czm_material m = czm_getDefaultMaterial(materialInput);
        float bands = 0.88 + 0.12 * pow(abs(sin(materialInput.st.s * 210.0)), 18.0);
        m.diffuse = mix(bottomColor.rgb, topColor.rgb, pow(materialInput.st.t, 0.65)) * bands;
        m.emission = topColor.rgb * 0.08 * materialInput.st.t; m.alpha = 1.0; return m;
      }`,
    } });
    this.primitives.add(new Primitive({ geometryInstances: new GeometryInstance({ geometry: wall }),
      appearance: new MaterialAppearance({ material: sideMaterial, flat: true, faceForward: true, translucent: false }), asynchronous: false, allowPicking: false }));
    // Never put a cap over real photogrammetry. Only the underside is solid; the loaded terrain is the top.
    for (const height of [stage.bottomHeight]) {
      const geometry = PolygonGeometry.fromPositions({ positions: basePositions, height, vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT });
      this.primitives.add(new Primitive({ geometryInstances: new GeometryInstance({ geometry, attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(height === stage.bottomHeight ? tokens.colors.panel : tokens.colors.sceneDark)!) } }),
        appearance: new PerInstanceColorAppearance({ flat: true, translucent: false }), asynchronous: false, allowPicking: false }));
    }
    for (const [height, width, alpha] of [[stage.topHeight + 0.4, 3.2, 0.9], [stage.bottomHeight + 0.3, 1.4, 0.4]]) {
      const positions = loop.map((position) => { const p = Cartographic.fromCartesian(position); return Cartesian3.fromRadians(p.longitude, p.latitude, height); });
      this.primitives.add(new Primitive({ geometryInstances: new GeometryInstance({ geometry: new PolylineGeometry({ positions, width, arcType: ArcType.NONE, vertexFormat: PolylineMaterialAppearance.VERTEX_FORMAT }) }),
        appearance: new PolylineMaterialAppearance({ material: Material.fromType("PolylineGlow", { color: Color.fromCssColorString(tokens.colors.cyan)!.withAlpha(alpha), glowPower: 0.18 }) }), asynchronous: false, allowPicking: false }));
    }
    this.addBaseArc();
    this.rebuildFocus();
  }

  setFocus(position: Cartesian3, enabled: boolean): void {
    this.focusEnabled = enabled;
    if (!this.focusPosition || Cartesian3.distanceSquared(this.focusPosition, position) > 0.04) {
      this.focusPosition = Cartesian3.clone(position);
      this.rebuildFocus();
    }
    if (this.focusPrimitive) this.focusPrimitive.show = this.focusEnabled && this.motionStarted;
  }

  private rebuildFocus(): void {
    if (this.focusPrimitive) this.primitives.remove(this.focusPrimitive);
    this.focusPrimitive = undefined; this.focusMaterial = undefined;
    if (!this.focusPosition) return;
    const height = Cartographic.fromCartesian(this.focusPosition).height;
    const radius = 160;
    this.focusMaterial = new Material({ fabric: {
      type: "SafetyFocusMotionV2",
      uniforms: { tint: Color.fromCssColorString(tokens.colors.cyan)!, elapsed: 0, metresPerPixel: 1, worldRadius: radius,
        pulsePeriod: tokens.motion.pulse.periodSeconds, phaseOffset: tokens.motion.pulse.phaseOffsetSeconds,
        minRadius: tokens.motion.pulse.radiusReferencePx[0], maxRadius: tokens.motion.pulse.radiusReferencePx[1],
        startOpacity: tokens.motion.pulse.opacity[0], radarPeriod: tokens.motion.radar.periodSeconds,
        radarSector: tokens.motion.radar.sectorDegrees * Math.PI / 180 },
      source: `czm_material czm_getMaterial(czm_materialInput materialInput) {
        czm_material m = czm_getDefaultMaterial(materialInput);
        vec2 p = (materialInput.st - 0.5) * 2.0;
        float r = length(p) * worldRadius / max(metresPerPixel, 0.01);
        float a = fract(elapsed / pulsePeriod), b = fract((elapsed - phaseOffset) / pulsePeriod);
        float waveA = (1.0 - smoothstep(0.6, 1.9, abs(r - mix(minRadius, maxRadius, a)))) * (1.0 - a);
        float waveB = (1.0 - smoothstep(0.6, 1.9, abs(r - mix(minRadius, maxRadius, b)))) * (1.0 - b);
        float angle = mod(atan(p.y, p.x) + elapsed / radarPeriod * czm_twoPi + czm_twoPi, czm_twoPi);
        float sweep = (1.0 - step(radarSector, angle)) * (angle / radarSector) * (1.0 - smoothstep(maxRadius * 0.75, maxRadius, r)) * 0.15;
        m.diffuse = tint.rgb; m.emission = tint.rgb * 0.14;
        m.alpha = min(0.72, (waveA + waveB) * startOpacity + sweep); return m;
      }`,
    }, translucent: true });
    this.focusPrimitive = this.primitives.add(new Primitive({ show: this.focusEnabled && this.motionStarted,
      geometryInstances: new GeometryInstance({ geometry: new EllipseGeometry({ center: this.focusPosition, semiMajorAxis: radius, semiMinorAxis: radius,
        height: height + 0.35, vertexFormat: MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat }) }),
      appearance: new MaterialAppearance({ material: this.focusMaterial, flat: true, faceForward: true, translucent: true }),
      asynchronous: false, allowPicking: false }));
    this.focusGeometryBuilds++;
  }

  private addBaseArc(): void {
    if (!this.stage) return;
    const positions = [...this.stage.positions, this.stage.positions[0]].map((position) => {
      const p = Cartographic.fromCartesian(position); return Cartesian3.fromRadians(p.longitude, p.latitude, this.stage!.bottomHeight + 0.7);
    });
    this.arcMaterial = new Material({ fabric: {
      type: "SafetyBaseArcV2", uniforms: { tint: Color.fromCssColorString(tokens.colors.cyan)!, elapsed: 0, period: tokens.motion.baseArc.periodSeconds },
      source: `czm_material czm_getMaterial(czm_materialInput materialInput) {
        czm_material m = czm_getDefaultMaterial(materialInput);
        float d = fract(materialInput.st.s - elapsed / period);
        float arc = (1.0 - smoothstep(0.0, 0.16, d)) * smoothstep(0.0, 0.008, d);
        m.diffuse = tint.rgb; m.emission = tint.rgb * 0.3; m.alpha = arc * 0.82; return m;
      }`,
    }, translucent: true });
    this.arcPrimitive = this.primitives.add(new Primitive({ show: false,
      geometryInstances: new GeometryInstance({ geometry: new PolylineGeometry({ positions, width: tokens.motion.flow.headReferencePx,
        arcType: ArcType.NONE, vertexFormat: PolylineMaterialAppearance.VERTEX_FORMAT }) }),
      appearance: new PolylineMaterialAppearance({ material: this.arcMaterial }), asynchronous: false, allowPicking: false }));
  }

  setAuthoring(active: boolean): void {
    this.authoring = active;
    this.primitives.show = this.styled && !active;
    this.updateUniforms(); this.viewer.scene.requestRender();
  }

  private syncAnnotations(): void {
    const current = new Set<object>();
    for (const record of this.options.getImports?.() ?? []) {
      if (record.kind !== "CAD") continue;
      const collection = record.resource as PrimitiveCollection & { entities?: { values: Entity[] } };
      if (collection instanceof PrimitiveCollection && !collection.isDestroyed()) for (let i = 0; i < collection.length; i++) {
        const child = collection.get(i);
        if (!(child instanceof LabelCollection)) {
          if (child && typeof child.show === "boolean" && !(typeof child.isDestroyed === "function" ? child.isDestroyed() : child.isDestroyed === true)) {
            current.add(child); if (!this.cadGeometry.has(child)) this.cadGeometry.set(child, child.show);
            child.show = false;
          }
          continue;
        }
        if (child.isDestroyed()) continue;
        current.add(child);
        let saved = this.labels.get(child);
        if (!saved) {
          saved = { labels: child, show: child.show, individual: Array.from({ length: child.length }, (_, j) => ({ show: child.get(j).show, id: child.get(j).id })) };
          this.labels.set(child, saved);
        }
        child.show = !!this.state?.engineeringAnnotations && saved.show;
        if (child.show) for (let j = 0; j < child.length; j++) {
          const id = child.get(j).id as { entityIndex?: number } | undefined;
          child.get(j).show = !!saved.individual[j]?.show && record.id === this.view?.selected.sourceRecordId
            && id?.entityIndex === this.view?.selected.sourceEntityIndex;
        }
      }
      for (const entity of collection.entities?.values ?? []) {
        current.add(entity); if (!this.cadEntityShows.has(entity)) this.cadEntityShows.set(entity, entity.show);
        const selected = !!this.state?.engineeringAnnotations && record.id === this.view?.selected.sourceRecordId && Number(entity.id.match(/-(\d+)$/)?.[1]) === this.view?.selected.sourceEntityIndex;
        entity.show = !!this.cadEntityShows.get(entity) && selected;
      }
      for (const entity of collection.entities?.values ?? []) if (entity.label) {
        current.add(entity);
        if (!this.entityLabels.has(entity)) this.entityLabels.set(entity, entity.label.show);
        const index = Number(entity.id.match(/-(\d+)$/)?.[1]);
        entity.label.show = new ConstantProperty(!!this.state?.engineeringAnnotations && record.id === this.view?.selected.sourceRecordId && index === this.view?.selected.sourceEntityIndex);
      }
    }
    for (const [primitive, show] of this.cadGeometry) if (!current.has(primitive)) { if (!(typeof primitive.isDestroyed === "function" ? primitive.isDestroyed() : primitive.isDestroyed === true)) primitive.show = show; this.cadGeometry.delete(primitive); }
    for (const [entity, show] of this.cadEntityShows) if (!current.has(entity)) { entity.show = show; this.cadEntityShows.delete(entity); }
    for (const [labels, state] of this.labels) if (!current.has(labels)) { this.restoreLabels(state); this.labels.delete(labels); }
    for (const [entity, show] of this.entityLabels) if (!current.has(entity)) { if (entity.label) entity.label.show = show; this.entityLabels.delete(entity); }
  }

  private restoreLabels(state: LabelState): void {
    if (state.labels.isDestroyed()) return;
    state.labels.show = state.show;
    for (let i = 0; i < Math.min(state.labels.length, state.individual.length); i++) state.labels.get(i).show = state.individual[i].show;
  }

  private releaseTile(entry: TileState): void {
    if (!entry.tileset.isDestroyed()) {
      if (entry.tileset.customShader === entry.shader) entry.tileset.customShader = entry.previousShader;
    }
    if (!entry.shader.isDestroyed()) entry.shader.destroy();
    this.tiles.delete(entry.tileset);
  }

  samplingExclusions(): object[] { return [this.primitives]; }

  isSurfaceReady(): boolean {
    return (this.options.getImports?.() ?? []).filter((record) => record.kind === "3D Tiles" && record.visible)
      .every((record) => { const tileset = record.resource as Cesium3DTileset; return !tileset.isDestroyed() && tileset.tilesLoaded; });
  }

  readOpaqueDepthPosition(screen: Cartesian2): Cartesian3 | undefined {
    const scene = this.viewer.scene;
    if (!scene.pickPositionSupported) return;
    // Subsurface tools enable translucent picking globally. For solid photogrammetry display anchors,
    // temporarily opt out so pickPosition only reads the existing depth buffer instead of a nested render.
    const previous = scene.pickTranslucentDepth;
    scene.pickTranslucentDepth = false;
    try { return scene.pickPosition(screen); }
    finally { scene.pickTranslucentDepth = previous; }
  }

  /** Derive a display-only height from the last rendered depth buffer, without triggering a nested render pass. */
  displaySurfaceHeight(location: Cartographic): number | undefined {
    const scene = this.viewer.scene;
    if (scene.mode !== SceneMode.SCENE3D || !scene.pickPositionSupported || !this.isSurfaceReady()) return;
    let height = location.height;
    let found = false;
    for (let i = 0; i < 4; i++) {
      const world = Cartesian3.fromRadians(location.longitude, location.latitude, height);
      const screen = SceneTransforms.worldToWindowCoordinates(scene, world);
      if (!screen || screen.x < 1 || screen.y < 1 || screen.x >= this.viewer.canvas.clientWidth - 1 || screen.y >= this.viewer.canvas.clientHeight - 1) break;
      const depthPosition = this.readOpaqueDepthPosition(screen);
      if (!depthPosition) break;
      const next = Cartographic.fromCartesian(depthPosition).height;
      if (!Number.isFinite(next) || (this.styled && this.stage && next <= this.stage.bottomHeight + 3)) break;
      found = true;
      if (Math.abs(next - height) < 0.2) { height = next; break; }
      height = next;
    }
    return found ? height : undefined;
  }

  private restoreScene(): void {
    this.primitives.show = false;
    for (const entry of [...this.tiles.values()]) this.releaseTile(entry);
    if (this.styled) {
      const scene = this.viewer.scene; scene.globe.show = this.globeShow;
      if (scene.skyBox) scene.skyBox.show = this.skyShow;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = this.atmosphereShow;
      if (this.background) scene.backgroundColor = this.background;
    }
    this.styled = false;
  }

  restore(): void {
    this.active = false;
    this.restoreScene();
    for (const state of this.labels.values()) this.restoreLabels(state);
    this.labels.clear();
    for (const [entity, show] of this.entityLabels) if (entity.label) entity.label.show = show;
    this.entityLabels.clear();
    for (const [primitive, show] of this.cadGeometry) if (!(typeof primitive.isDestroyed === "function" ? primitive.isDestroyed() : primitive.isDestroyed === true)) primitive.show = show;
    this.cadGeometry.clear();
    for (const [entity, show] of this.cadEntityShows) entity.show = show;
    this.cadEntityShows.clear();
  }

  tick(elapsed: number, decorativeTime = 0, animated = false, reducedMotion = false): void {
    if (!this.active || this.disposed) return;
    if (elapsed - this.lastSync > 0.7) {
      this.lastSync = elapsed; this.syncAnnotations();
      if (this.styled) this.syncTiles();
    }
    if (!this.styled) return;
    this.updateUniforms();
    if (animated) this.motionStarted = true;
    const ornamentsVisible = !this.authoring && this.motionStarted && !!this.state?.layers.effects && !reducedMotion && !document.hidden;
    if (this.focusPrimitive) this.focusPrimitive.show = ornamentsVisible && this.focusEnabled;
    if (this.arcPrimitive) this.arcPrimitive.show = ornamentsVisible;
    if (this.focusMaterial && this.focusPosition) {
      const distance = Cartesian3.distance(this.viewer.camera.positionWC, this.focusPosition);
      const fovy = "fovy" in this.viewer.camera.frustum ? Number(this.viewer.camera.frustum.fovy) : Math.PI / 3;
      this.focusMaterial.uniforms.metresPerPixel = distance * 2 * Math.tan(fovy / 2) / Math.max(1, this.viewer.canvas.clientHeight);
      this.focusMaterial.uniforms.elapsed = decorativeTime;
    }
    if (this.arcMaterial) this.arcMaterial.uniforms.elapsed = decorativeTime;
    if (!this.authoring && this.stage && this.isSurfaceReady() && this.heightSamples < 4 && elapsed - this.lastHeightSample > 1.5
      && this.viewer.scene.mode === SceneMode.SCENE3D && this.viewer.scene.pickPositionSupported) {
      this.lastHeightSample = elapsed; this.heightSamples++;
      const samples: number[] = [];
      for (const position of [this.stage.center, ...this.stage.positions]) {
        const p = Cartographic.fromCartesian(position);
        try { const height = this.displaySurfaceHeight(p); if (typeof height === "number" && Number.isFinite(height)) samples.push(height); } catch { /* Surface not loaded yet. */ }
      }
      if (samples.length) {
        // Photogrammetry boundary skirts can be tens of metres below the real centre surface.
        // Base thickness is decorative; anchor its top near the centre and reject those skirt outliers.
        const reference = samples[0];
        const nearSurface = samples.filter((value) => value >= reference - 15 && value <= reference + 15);
        const height = Math.min(...nearSurface) - 1.5;
        if (Math.abs(height - this.stage.topHeight) > 1) {
          const thickness = this.stage.topHeight - this.stage.bottomHeight;
          this.stage.topHeight = height; this.stage.bottomHeight = height - thickness;
          const p = Cartographic.fromCartesian(this.stage.center); Cartesian3.fromRadians(p.longitude, p.latitude, height, undefined, this.stage.center);
          this.rebuildBase();
        }
      }
    }
  }

  frame(): { center: Cartesian3; radius: number; heading: number; pitch: number; range: number } | undefined {
    return this.stage && this.styled ? this.stage : undefined;
  }

  debugStats(): Record<string, unknown> {
    return { authoring: this.authoring, cadGeometryHidden: this.cadGeometry.size, active: this.active, styled: this.styled, shaderCount: this.tiles.size, ownedClipCount: 0, clippingMethod: "owned-fragment-shader-discard",
      basePrimitives: this.primitives.length, focusGeometryBuilds: this.focusGeometryBuilds, dynamicGeometryPerFrame: false,
      focusPulseVisible: !!this.focusPrimitive?.show && this.styled, baseArcVisible: !!this.arcPrimitive?.show && this.styled, cadLabelCollections: this.labels.size, cadEntityLabels: this.entityLabels.size, messages: [...this.messages],
      stage: this.stage ? { key: this.stage.key, lengthMeters: this.stage.halfLength * 2, widthMeters: this.stage.halfWidth * 2, topHeight: this.stage.topHeight, bottomHeight: this.stage.bottomHeight,
        headingDegrees: this.stage.heading * 180 / Math.PI, pitchDegrees: this.stage.pitch * 180 / Math.PI, displayOnly: true } : null };
  }

  dispose(): void {
    if (this.disposed) return;
    this.restore(); this.disposed = true;
    this.viewer.scene.primitives.remove(this.primitives);
  }
}
