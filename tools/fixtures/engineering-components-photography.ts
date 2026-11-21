import { Axis, Cartesian2, Cartesian3, Cartographic, Cesium3DTileset, Color, EllipsoidTerrainProvider, HeadingPitchRange, Math as CesiumMath, Matrix3, Matrix4, Model, Transforms, Viewer } from 'cesium';
import * as CesiumRuntime from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { EngineeringFootprintClient } from '../../src/engineeringComponents/footprintClient';
import { EngineeringPhotographyOcclusion } from '../../src/engineeringComponents/photography';
import { EngineeringRenderAdapter } from '../../src/engineeringComponents/renderAdapter';
import { getTemporaryWorksClippingManager } from '../../src/temporaryWorksGlbScene';
import { readGlbJson } from '../../src/engineeringComponents/catalog';
import { renderFixtureFrames } from './render-fixture-frames';

(window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = '/__engineering_cesium/';
const unit = new URL(location.href).searchParams.get('unit') || 'A001';
const viewer = new Viewer('scene', { animation: false, timeline: false, baseLayer: false, terrainProvider: new EllipsoidTerrainProvider(), geocoder: false,
  homeButton: false, sceneModePicker: false, baseLayerPicker: false, navigationHelpButton: false, fullscreenButton: false, selectionIndicator: false, infoBox: false,
  requestRenderMode: true, contextOptions: { webgl: { preserveDrawingBuffer: true, antialias: false } } });
viewer.scene.globe.show = false; viewer.scene.skyAtmosphere.show = false; viewer.scene.skyBox.show = false; viewer.scene.sun.show = false; viewer.scene.moon.show = false;
viewer.scene.backgroundColor = Color.fromBytes(12, 18, 100); viewer.scene.postProcessStages.fxaa.enabled = false;
const errors: string[] = []; viewer.scene.renderError.addEventListener((_scene, error) => errors.push(String(error.stack || error)));
const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(121, 31, 0));
const point = (x: number, y: number, z = 20) => Matrix4.multiplyByPoint(frame, new Cartesian3(x, y, z), new Cartesian3());
const geographic = (x: number, y: number) => { const c = Cartographic.fromCartesian(point(x, y, 0)); return { longitude: CesiumMath.toDegrees(c.longitude), latitude: CesiumMath.toDegrees(c.latitude), height: c.height }; };
const rect = (x: number, y: number, half = 1) => [{ outer: [[x-half,y-half],[x+half,y-half],[x+half,y+half],[x-half,y+half]].map(([e,n]) => geographic(e,n)) }];
const bytes = await (await fetch(`/__engineering_real/${unit}.glb`)).arrayBuffer();
const sourceHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
const document = readGlbJson(bytes) as { nodes: { name?: string; mesh?: number; extras?: { componentId?: string } }[] };
const metadata = await (await fetch('/__engineering_real/meta.json')).json();
const references = new Set<string>(metadata.referenceIds);
const bindings = document.nodes.flatMap((node, index) => node.mesh === undefined || references.has(node.extras?.componentId ?? node.name!) ? [] : [{ componentId: node.extras?.componentId ?? node.name!, nodeIndices: [index] }]);
let client: EngineeringFootprintClient;
const projectionSummary = (result: Awaited<ReturnType<EngineeringFootprintClient['project']>>) => ({ componentCount: result.componentCount, triangleCount: result.triangleCount,
  boundaryPoints: result.boundaryPoints, polygons: result.polygons, topologyChecks: result.topologyChecks, milliseconds: result.milliseconds, footprints: result.footprints.length });
const frames = () => renderFixtureFrames(viewer.scene, 8, () => errors);
const context = (viewer.scene as unknown as { context: { readPixels(options: object): Uint8Array; _gl: WebGL2RenderingContext } }).context;
const gpu = () => { const gl = context._gl, extension = gl.getExtension('WEBGL_debug_renderer_info'); return { renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : '', maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) }; };
const glErrors = () => {const result:number[]=[];for(let i=0;i<16;i++){const code=context._gl.getError();if(code===context._gl.NO_ERROR)break;result.push(code);}return result;};

// FULL measures the complete original mesh in the worker. Sample pages additionally
// prove real 3D Tiles pixels and independent legacy clipping in the native renderer.
if (unit === 'FULL') {
  client = new EngineeringFootprintClient(bytes, bindings);
  const axis = Matrix4.multiply(Axis.Y_UP_TO_Z_UP, Axis.Z_UP_TO_X_UP, new Matrix4());
  const world = Matrix4.multiply(frame, axis, new Matrix4());
  const tileset = await Cesium3DTileset.fromUrl('/__engineering_photo/FULL/tileset.json'); viewer.scene.primitives.add(tileset);
  const photography = new EngineeringPhotographyOcclusion(viewer);
  const focus = async (x: number, y: number, range: number) => { viewer.camera.lookAt(point(x,y),new HeadingPitchRange(0,-Math.PI/2,range)); viewer.camera.lookAtTransform(Matrix4.IDENTITY); await frames(); };
  await focus(0,0,40);
  for(let i=0;i<90&&(!tileset.tilesLoaded||!tileset.root.contentReady);i++)await frames();
  if(!tileset.root.contentReady)throw Error('Full-line synthetic photography is not ready');
  const probe = (position: number[]) => { const window=viewer.scene.cartesianToCanvasCoordinates(point(position[0],position[1]),new Cartesian2());
    const x=Math.floor(window.x),y=Math.floor(viewer.canvas.clientHeight-window.y),pick=viewer.scene.pick(window,1,1) as {primitive?:unknown}|undefined;
    return {pixel:[...context.readPixels({x,y,width:1,height:1})],photographyPicked:pick?.primitive===tileset,point:position}; };
  const samples = async () => { await focus(0,0,40);const a001=probe([0,0]);await focus(-265.270682344,803.740794852,180);return {a001,tn021:probe([-265.270682344,803.740794852])}; };
  const api = { gpu, glErrors, async projectAll() {
    const before=await samples(),baselineStart=performance.now();await renderFixtureFrames(viewer.scene,10,()=>errors);const baselineFramesMs=performance.now()-baselineStart;
    const result=await client.project(Matrix4.toArray(world),bindings.map(binding=>binding.componentId));const applyStart=performance.now();
    photography.apply({id:'full-synthetic-photography',tileset},result.footprints);await frames();const applyMs=performance.now()-applyStart;
    const after=await samples(),enabledStart=performance.now();await renderFixtureFrames(viewer.scene,10,()=>errors);const enabledFramesMs=performance.now()-enabledStart;
    const status=photography.status,polygons=tileset.clippingPolygons?.length??0;photography.clear();await frames();const cleared=await samples();
    return {...projectionSummary(result),sourceHash,count:bindings.length,errors,before,after,cleared,status,polygons,applyMs,baselineFramesMs,enabledFramesMs};
  } };
  (window as unknown as { engineeringPhotographyFixture: typeof api }).engineeringPhotographyFixture = api;
} else {
  const model = await Model.fromGltfAsync({ url: `/__engineering_real/${unit}.glb`, modelMatrix: frame, id: { engineeringModelId: unit }, incrementallyLoadTextures: false });
  viewer.scene.primitives.add(model);
  const tileset = await Cesium3DTileset.fromUrl(`/__engineering_photo/${unit}/tileset.json`); viewer.scene.primitives.add(tileset);
  // Source Z-up -> GLB Y-up root combined with Cesium's default Z-forward
  // correction rotates source XY +90 degrees into this fixed ENU placement.
  const center = unit === 'A001' ? [0, 0] : [-265.270682344, 803.740794852];
  const outside = unit === 'A001' ? [-2.3942043781280518, 2.3942043781280518] : [-281.0352087111875, 832.2788483645733];
  const extent = unit === 'A001' ? 18 : 90;
  const legacy = [center[0]-extent*.35, center[1]+extent*.3], road = [center[0]+extent*.35, center[1]-extent*.3];
  const smallLegacy = [center[0]-extent*.35, center[1]-extent*.3];
  viewer.camera.setView({ destination: point(center[0], center[1], extent * 2.1 + 20), orientation: { direction: Cartesian3.normalize(Matrix4.multiplyByPointAsVector(frame, new Cartesian3(0, 0, -1), new Cartesian3()), new Cartesian3()), up: Cartesian3.normalize(Matrix4.multiplyByPointAsVector(frame, new Cartesian3(0, 1, 0), new Cartesian3()), new Cartesian3()) } });
  viewer.camera.frustum.near = .1;
  for (let i = 0; i < 90 && (!model.ready || !tileset.tilesLoaded || !tileset.root.contentReady); i++) await frames();
  if (!model.ready || !tileset.tilesLoaded || !tileset.root.contentReady) throw Error('Original model or synthetic photography did not become ready');
  const runtimeNodes = (model as unknown as { _sceneGraph: { _runtimeNodes: { computedTransform: Matrix4 }[] } })._sceneGraph._runtimeNodes;
  client = new EngineeringFootprintClient(bytes, bindings, bindings.flatMap(binding => binding.nodeIndices.map(nodeIndex => ({ nodeIndex, matrix: Matrix4.toArray(runtimeNodes[nodeIndex].computedTransform) }))));
  const adapter = new EngineeringRenderAdapter(viewer, model, bindings);
  const photography = new EngineeringPhotographyOcclusion(viewer);
  const manager = getTemporaryWorksClippingManager(viewer), roadScope = manager.createScope(`photography-test-road-${unit}`);
  const chosen = unit === 'A001' ? 'A001_cap_01' : 'TN021_tunnel_roof_01';
  const initialMatrix = Matrix4.toArray(model.modelMatrix);
  let currentMatrix = Matrix4.clone(frame), selected = [chosen];
  let lastProjection: ReturnType<typeof projectionSummary> | undefined;
  const worldFromGltf = () => {
    const graph = (model as unknown as { _sceneGraph: { components: { transform: Matrix4 }; axisCorrectionMatrix: Matrix4 } })._sceneGraph;
    return Matrix4.toArray(Matrix4.multiplyByUniformScale(Matrix4.multiply(Matrix4.multiply(model.modelMatrix, graph.components.transform, new Matrix4()), graph.axisCorrectionMatrix, new Matrix4()), model.scale, new Matrix4()));
  };
  const apply = async () => {
    const result = await client.project(worldFromGltf(), selected); lastProjection = projectionSummary(result);
    photography.apply({ id: 'synthetic-photography', tileset }, result.footprints); await frames();
  };
  const probe = (position: number[]) => {
    const window = viewer.scene.cartesianToCanvasCoordinates(point(position[0], position[1]), new Cartesian2());
    if (!window || window.x < 0 || window.y < 0 || window.x >= viewer.canvas.clientWidth || window.y >= viewer.canvas.clientHeight) throw Error('Probe outside canvas');
    const x = Math.floor(window.x * viewer.scene.drawingBufferWidth / viewer.canvas.clientWidth), y = Math.floor((viewer.canvas.clientHeight-window.y) * viewer.scene.drawingBufferHeight / viewer.canvas.clientHeight);
    // Match the single-pixel colour probe. Cesium's default 3x3 pick can select
    // preserved photography across a valid narrow clipping boundary.
    const pick = viewer.scene.pick(window,1,1) as { primitive?: unknown } | undefined;
    return { pixel: [...context.readPixels({ x, y, width: 1, height: 1 })], photographyPicked: pick?.primitive === tileset, point: position, window: [window.x, window.y], pickType: pick?.constructor.name, primitiveType: pick?.primitive?.constructor.name, pickKeys: pick ? Object.keys(pick) : [] };
  };
  const read = () => ({ sourceHash, unit, count: bindings.length, errors: [...errors], status: photography.status, projection: lastProjection,
    center: probe(center), outside: probe(outside), legacy: probe(legacy), road: probe(road), smallLegacy: probe(smallLegacy), polygons: tileset.clippingPolygons?.length ?? 0,
    modelMatrix: Matrix4.toArray(model.modelMatrix), initialMatrix, modelShow: model.show,legacyStatus:manager.getStatus(`legacy-${unit}`),roadStatus:roadScope.getStatus('road'),
    tileDebug: {loaded:tileset.tilesLoaded,show:tileset.show,contentReady:tileset.root.contentReady,contentUrl:tileset.root.content?.url,bounds:tileset.boundingSphere,
      selected:(tileset as unknown as {_selectedTiles:unknown[]})._selectedTiles.length,statistics:(tileset as unknown as {_statistics:unknown})._statistics,
      packed:tileset.clippingPolygons ? {points:Array.from((tileset.clippingPolygons as unknown as {_float32View:Float32Array})._float32View??[]).slice(0,180),extents:Array.from((tileset.clippingPolygons as unknown as {_extentsFloat32View:Float32Array})._extentsFloat32View??[]).slice(0,48)} : undefined,
      camera:viewer.camera.positionWC,photoModel:(() => { const m=(tileset.root.content as unknown as {_model?:Model})?._model;return m?{ready:m.ready,show:m.show,bounds:m.boundingSphere,matrix:Matrix4.toArray(m.modelMatrix)}:undefined;})()} });
  const setVisibility = (visible: boolean) => adapter.applyStates(bindings.map(binding => ({ ...binding, visible: visible && selected.includes(binding.componentId), occlusion: selected.includes(binding.componentId) })));
  const scan = (origin: number[], half = 4, step = .5) => { const missing: number[][]=[];for(let north=-half;north<=half;north+=step)for(let east=-half;east<=half;east+=step){
    const p=[origin[0]+east,origin[1]+north],window=viewer.scene.cartesianToCanvasCoordinates(point(p[0],p[1]),new Cartesian2());
    const pixel=context.readPixels({x:Math.floor(window.x),y:Math.floor(viewer.canvas.clientHeight-window.y),width:1,height:1});
    if(!(pixel[1]>150&&pixel[1]>pixel[0]*1.8&&pixel[1]>pixel[2]*1.8))missing.push(p);
  }return {origin,half,step,missing}; };
  setVisibility(false); await frames();
  const api = {
    gpu, glErrors, read, probe,
    async debug() {
      const glErrorAtFailure=context._gl.getError();
      type DebugTexture={_texture:WebGLTexture;width:number;height:number};
      const collection=tileset.clippingPolygons as unknown as {geometry?:{worldToLocal:Matrix4;earth:Cartesian3;nodes:Float32Array;vertices:Float32Array;nodeCount:number;rootBounds:number[]};fromEye?:Matrix4;nodeTexture?:DebugTexture;vertexTexture?:DebugTexture};
      const geometry=collection?.geometry;
      const textureData=(texture?:DebugTexture)=>{if(!texture)return;const gl=context._gl,previous=gl.getParameter(gl.FRAMEBUFFER_BINDING),fb=gl.createFramebuffer();
        try{gl.bindFramebuffer(gl.FRAMEBUFFER,fb);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture._texture,0);const status=gl.checkFramebufferStatus(gl.FRAMEBUFFER);
          const data=new Float32Array(texture.width*texture.height*4);if(status===gl.FRAMEBUFFER_COMPLETE)gl.readPixels(0,0,texture.width,texture.height,gl.RGBA,gl.FLOAT,data);return {width:texture.width,height:texture.height,status,data:Array.from(data)};
        }finally{gl.bindFramebuffer(gl.FRAMEBUFFER,previous);gl.deleteFramebuffer(fb);}};
      const m=(tileset.root.content as unknown as {_model?:{_sceneGraph:{_runtimeNodes:{runtimePrimitives:{drawCommand?:{command:{uniformMap:Record<string,()=>unknown>;shaderProgram:{vertexShaderSource:{sources:string[]};fragmentShaderSource:{sources:string[]}}}}}[]}[]}}})._model;
      const commands=m?m._sceneGraph._runtimeNodes.filter(Boolean).flatMap(n=>n.runtimePrimitives.flatMap(p=>p.drawCommand?[p.drawCommand.command]:[])):[];
      const actualUniforms=(program?:WebGLProgram)=>{const gl=context._gl,actual:Record<string,unknown>={};if(!program)return actual;for(let i=0;i<gl.getProgramParameter(program,gl.ACTIVE_UNIFORMS);i++){const info=gl.getActiveUniform(program,i);if(!info||!info.name.match(/engineeringClip|czm_modelView/))continue;
          const value=gl.getUniform(program,gl.getUniformLocation(program,info.name));actual[info.name]=ArrayBuffer.isView(value)?Array.from(value as Float32Array):value;}
        return actual;};
      const cached=(context as unknown as {_shaderCache:{_shaders:Record<string,{shaderProgram:{_program?:WebGLProgram;fragmentShaderSource:{sources:string[]}}}>}})._shaderCache._shaders;
      const translated=context._gl.getExtension('WEBGL_debug_shaders');
      const driverPrograms=Object.values(cached).filter(item=>item.shaderProgram._program&&item.shaderProgram.fragmentShaderSource.sources.join('').includes('engineeringClip')).map(item=>({
        infoLog:context._gl.getProgramInfoLog(item.shaderProgram._program!),shaders:context._gl.getAttachedShaders(item.shaderProgram._program!)?.map(shader=>({
          type:context._gl.getShaderParameter(shader,context._gl.SHADER_TYPE),infoLog:context._gl.getShaderInfoLog(shader),translated:translated?.getTranslatedShaderSource(shader)}))}));
      const actualPrograms=Object.values(cached).filter(item=>item.shaderProgram._program&&item.shaderProgram.fragmentShaderSource.sources.join('').includes('engineeringClip')).map(item=>actualUniforms(item.shaderProgram._program));
      const commandInfo=commands.map(command=>{return {uniformKeys:Object.keys(command.uniformMap),fromEye:command.uniformMap.engineeringClipFromEye?Matrix4.toArray(command.uniformMap.engineeringClipFromEye() as Matrix4):undefined,
          vertex:command.shaderProgram.vertexShaderSource.sources.join('\n'),fragment:command.shaderProgram.fragmentShaderSource.sources.join('\n')};});
      const originalNodeCount=geometry?.nodeCount;if(geometry)geometry.nodeCount=0;await frames();const zeroCount=read();
      const zeroCountActual=Object.values(cached).filter(item=>item.shaderProgram._program&&item.shaderProgram.fragmentShaderSource.sources.join('').includes('engineeringClip')).map(item=>actualUniforms(item.shaderProgram._program));
      if(geometry)geometry.nodeCount=originalNodeCount!;await frames();
      const builder=(CesiumRuntime as unknown as {ShaderBuilder:{prototype:{addFragmentLines(lines:string):void;addDefine(...args:unknown[]):void}}}).ShaderBuilder.prototype;
      const resetModel=m as unknown as {resetDrawCommands():void};const oldFragment=builder.addFragmentLines,oldDefine=builder.addDefine;
      const stageDiagnostic:Record<string,unknown>={};
      try{
        builder.addFragmentLines=function(lines:string){return oldFragment.call(this,typeof lines==='string'&&lines.includes('engineeringClipTexel')?'void modelClippingPolygonsStage() {}':lines);};
        resetModel.resetDrawCommands();await frames();stageDiagnostic.noopStage=read();
        builder.addDefine=function(...args:unknown[]){if(args[0]==='ENABLE_CLIPPING_POLYGONS')return;return oldDefine.apply(this,args);};
        resetModel.resetDrawCommands();await frames();stageDiagnostic.noDefine=read();
      }finally{builder.addFragmentLines=oldFragment;builder.addDefine=oldDefine;resetModel.resetDrawCommands();await frames();}
      return {geometry:geometry?{...geometry,worldToLocal:Matrix4.toArray(geometry.worldToLocal),nodes:Array.from(geometry.nodes),vertices:Array.from(geometry.vertices)}:undefined,
        gpuTextures:{nodes:textureData(collection?.nodeTexture),vertices:textureData(collection?.vertexTexture)},
        inverseViewMatrix:Matrix4.toArray(viewer.camera.inverseViewMatrix),fromEye:collection?.fromEye?Matrix4.toArray(collection.fromEye):undefined,
        localProbe:geometry?{center:Matrix4.multiplyByPoint(geometry.worldToLocal,point(center[0],center[1]),new Cartesian3()),outside:Matrix4.multiplyByPoint(geometry.worldToLocal,point(outside[0],outside[1]),new Cartesian3())}:undefined,
        commands:commandInfo,actualPrograms,zeroCount,zeroCountActual,stageDiagnostic,glErrorAtFailure,driverPrograms};
    },
    async baselineLegacy() {
      photography.clear();manager.remove(`legacy-${unit}`);roadScope.clear();tileset.modelMatrix=Matrix4.clone(Matrix4.IDENTITY);await frames();
      // A fixture-only HTTP module avoids unresolved diagnostic aliases when
      // unrelated legacy Vite tests scan every fixture HTML entry.
      const baselineModule='/__engineering_old_manager';
      const {TemporaryWorksClippingManager}=await import(/* @vite-ignore */ baselineModule);const baseline=new TemporaryWorksClippingManager(viewer);
      baseline.upsert({id:'old-legacy',tileset,footprints:rect(legacy[0],legacy[1],unit==='A001'?1:2)});await frames();
      const result={...read(),scan:scan(legacy)};baseline.dispose();await frames();return result;
    },
    async legacyDiagnostics() {
      photography.clear();tileset.modelMatrix=Matrix4.clone(Matrix4.IDENTITY);
      const results=[];
      for(const order of [[],['legacy'],['road'],['legacy','road'],['road','legacy']]) {
        manager.remove(`legacy-${unit}`);roadScope.clear();
        for(const key of order)if(key==='legacy')manager.upsert({id:`legacy-${unit}`,tileset,footprints:rect(legacy[0],legacy[1],unit==='A001'?1:2)});
        else roadScope.upsert({id:'road',tileset,footprints:rect(road[0],road[1],unit==='A001'?1:2)});
        await frames();results.push({order,...read(),scan:order.length===1&&order[0]==='legacy'?scan(legacy):undefined});
      }
      manager.remove(`legacy-${unit}`);roadScope.clear();await frames();
      if(unit==='A001'){selected=['A001_pile_01'];setVisibility(false);await apply();const position=[1.607891343,-.734632854];results.push({order:['engineering-pile'],...read(),pile:probe(position),scan:scan(position,2,.25)});selected=[chosen];photography.clear();await frames();}
      return results;
    },
    async state(visible: boolean, occlusion: boolean) { setVisibility(visible); if (occlusion) await apply(); else { photography.clear(); await frames(); } return read(); },
    async select(ids: string[]) { selected = ids; setVisibility(false); await apply(); return read(); },
    async all() { selected = bindings.map(binding => binding.componentId); setVisibility(false); await apply(); return read(); },
    // The original manager's global Float32-angle path cannot resolve every
    // 2 m building. Its failure is preserved in baselineLegacy/legacyDiagnostics.
    // Keep independent assertions for 2 m legacy geometry while precise engineering
    // is active; the existing 4 m building/road workflow must also survive withdrawal.
    async smallLegacy(enable: boolean) { if(enable)manager.upsert({id:`small-legacy-${unit}`,tileset,footprints:rect(smallLegacy[0],smallLegacy[1],1)});
      else manager.remove(`small-legacy-${unit}`);await frames();return read(); },
    async legacy(enable: boolean) { if (enable) { manager.upsert({ id: `legacy-${unit}`, tileset, footprints: rect(legacy[0], legacy[1], 2) }); roadScope.upsert({ id: 'road', tileset, footprints: rect(road[0], road[1], 2) }); }
      else { manager.remove(`legacy-${unit}`); roadScope.clear(); } await frames(); return read(); },
    async hideModel(hidden: boolean) { model.show = !hidden; await frames(); return read(); },
    async move(east: number, north: number) { currentMatrix = Matrix4.multiply(frame, Matrix4.fromTranslation(new Cartesian3(east,north,0)), new Matrix4()); model.modelMatrix = currentMatrix; await frames(); await apply(); return { ...read(), moved: probe([center[0]+east,center[1]+north]) }; },
    async transform(heading: number, scale: number) { const local = Matrix4.fromRotationTranslation(Matrix3.fromRotationZ(heading)); model.modelMatrix = Matrix4.multiply(frame, local, new Matrix4()); model.scale = scale; await frames(); await apply(); return read(); },
    async camera(pitch: number) { viewer.camera.lookAt(point(center[0],center[1]),new HeadingPitchRange(.6,pitch,extent*2.4));viewer.camera.lookAtTransform(Matrix4.IDENTITY);await frames();return read(); },
    async sceneMode(mode: '2D'|'CV'|'3D') {
      if(mode==='2D')viewer.scene.morphTo2D(0);else if(mode==='CV')viewer.scene.morphToColumbusView(0);else viewer.scene.morphTo3D(0);
      await frames();
      if(mode==='3D'){viewer.camera.lookAt(point(center[0],center[1]),new HeadingPitchRange(.6,-Math.PI/2,extent*2.4));viewer.camera.lookAtTransform(Matrix4.IDENTITY);await frames();return {mode:viewer.scene.mode,...read()};}
      return {mode:viewer.scene.mode,errors:[...errors],status:photography.status};
    },
    async photographyTransform(heading: number, east: number, north: number) {
      let local=Matrix4.fromTranslation(new Cartesian3(center[0]+east,center[1]+north,0));
      local=Matrix4.multiply(local,Matrix4.fromRotationTranslation(Matrix3.fromRotationZ(heading)),local);
      local=Matrix4.multiply(local,Matrix4.fromTranslation(new Cartesian3(-center[0],-center[1],0)),local);
      tileset.modelMatrix=Matrix4.multiply(Matrix4.multiply(frame,local,new Matrix4()),Matrix4.inverseTransformation(frame,new Matrix4()),new Matrix4());await frames();return read();
    },
    async suspend(value: boolean) { photography.setSuspended(value); await frames(); return read(); },
    async underground(value: boolean) { if (value) undergroundRelease ??= manager.suspendTarget(tileset, undergroundOwner); else { undergroundRelease?.(); undergroundRelease=undefined; } await frames(); return read(); },
    async clear() { photography.clear(); await frames(); return read(); },
    async dispose() { photography.dispose(); adapter.dispose(); roadScope.dispose(); manager.remove(`legacy-${unit}`);manager.remove(`small-legacy-${unit}`); await frames(); return { ...read(), restoredNodes: bindings.every(binding => model.getNode(binding.componentId).show) }; },
  };
  let undergroundRelease: (() => void) | undefined; const undergroundOwner = {};
  (window as unknown as { engineeringPhotographyFixture: typeof api }).engineeringPhotographyFixture = api;
}
