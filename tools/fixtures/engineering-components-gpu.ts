import { Cartesian3, ClippingPlane, ClippingPlaneCollection, Color, CustomShader, EllipsoidTerrainProvider, Matrix4, Model, SceneTransforms, Transforms, Viewer } from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { EngineeringRenderAdapter } from '../../src/engineeringComponents/renderAdapter';
import { EngineeringOcclusionRenderer } from '../../src/engineeringComponents/occlusion';
import { renderFixtureFrames } from './render-fixture-frames';

(window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = '/__engineering_cesium/';
const viewer = new Viewer('scene', { animation: false, timeline: false, baseLayer: false, terrainProvider: new EllipsoidTerrainProvider(),
  geocoder: false, homeButton: false, sceneModePicker: false, baseLayerPicker: false, navigationHelpButton: false, fullscreenButton: false,
  selectionIndicator: false, infoBox: false, requestRenderMode: true, contextOptions: { webgl: { preserveDrawingBuffer: true, antialias: false } } });
viewer.scene.globe.show = false; viewer.scene.skyAtmosphere.show = false; viewer.scene.skyBox.show = false;
viewer.scene.sun.show = false; viewer.scene.moon.show = false; viewer.scene.backgroundColor = Color.fromBytes(12, 18, 24);
viewer.scene.postProcessStages.fxaa.enabled = false;
const errors: string[] = []; viewer.scene.renderError.addEventListener((_scene, error) => errors.push(String(error.stack || error)));
const origin = Cartesian3.fromDegrees(121, 31, 0), frame = Transforms.eastNorthUpToFixedFrame(origin);
const point = (x: number, y: number, z: number) => Matrix4.multiplyByPoint(frame, new Cartesian3(x,y,z), new Cartesian3());
const direction = (x: number, y: number, z: number) => Cartesian3.normalize(Matrix4.multiplyByPointAsVector(frame, new Cartesian3(x,y,z), new Cartesian3()), new Cartesian3());
viewer.camera.setView({ destination: point(0,0,70), orientation: { direction: direction(0,0,-1), up: direction(0,1,0) } });
viewer.camera.frustum.near = 0.5;
const model = await Model.fromGltfAsync({ url: '/__engineering_test/model.glb', modelMatrix: frame, id: { engineeringModelId: 'synthetic' }, incrementallyLoadTextures: false });
viewer.scene.primitives.add(model);
await new Promise<void>((resolve, reject) => {
  const stop = viewer.scene.postRender.addEventListener(() => { if (model.ready) { clearTimeout(timer); stop(); resolve(); } else viewer.scene.requestRender(); });
  const timer = setTimeout(() => { stop(); reject(new Error('Synthetic model load timeout')); }, 30000); viewer.scene.requestRender();
});
const adapter = new EngineeringRenderAdapter(viewer, model, [{ componentId: 'front', nodeIndices: [0] }, { componentId: 'rear', nodeIndices: [1] }]);
adapter.setState('rear', { visible: true, occlusion: false });
const occlusion = new EngineeringOcclusionRenderer(viewer); occlusion.add(adapter);
occlusion.setDetectionPlane({ center: point(0,0,5), normal: direction(0,0,1), width: 18, height: 18, color: new Color(1,0.45,0,1) });
const frames = () => renderFixtureFrames(viewer.scene, 5, () => errors);
const pixelAt = (position: Cartesian3) => {
  const screen = SceneTransforms.worldToWindowCoordinates(viewer.scene, position)!;
  const x = Math.floor(screen.x * viewer.scene.drawingBufferWidth / viewer.canvas.clientWidth);
  const y = Math.floor((viewer.canvas.clientHeight - screen.y) * viewer.scene.drawingBufferHeight / viewer.canvas.clientHeight);
  const context = (viewer.scene as unknown as { context: { readPixels(options: object): Uint8Array } }).context;
  return { screen, x, y, pixel: [...context.readPixels({ x, y, width: 1, height: 1 })] };
};
const read = () => {
  const center = pixelAt(point(0,0,5)), edge = pixelAt(point(7,0,5));
  const picked = viewer.scene.pick(center.screen), pickedPosition = viewer.scene.pickPosition(center.screen);
  const result = { center: center.pixel, edge: edge.pixel, pick: adapter.componentIdFromPick(picked),
    position: pickedPosition ? Cartesian3.pack(pickedPosition, []) : null, stats: occlusion.getStats(), errors: [...errors],
    shows: [model.getNode('front').show, model.getNode('rear').show] };
  return { ...result, ...(occlusion.getStats().frameNumber >= 0 ? { independentCenter: occlusion.readDetectionPixel(center.x,center.y),
    independentEdge: occlusion.readDetectionPixel(edge.x,edge.y), depth: occlusion.readDepthPixel(center.x,center.y) } : {}) };
};
const api = {
  async state(visible: boolean, occ: boolean, enabled = true) { adapter.setState('front', { visible, occlusion: occ }); occlusion.setEnabled(enabled); await frames(); return read(); },
  async selection(id?: string) { adapter.setSelection(id ? [id] : []); await frames(); return read(); },
  async planeHeight(z: number) { occlusion.setDetectionPlane({ center: point(0,0,z), normal: direction(0,0,1), width:18,height:18,color:new Color(1,.45,0,1) }); await frames(); return read(); },
  async reverseOrder() { viewer.scene.primitives.raiseToTop(model); await frames(); return read(); },
  async suspend() { const release1=adapter.suspend(), release2=occlusion.suspend(), nested1=adapter.suspend(), nested2=occlusion.suspend(); await frames(); const suspended=read(); adapter.setState('front',{visible:false,occlusion:true}); release2(); release1(); await frames(); const stillSuspended=read(); nested2(); nested1(); await frames(); return {suspended,stillSuspended,resumed:read()}; },
  async resize() { viewer.resize(); await frames(); return read(); },
  async clipping(enabled: boolean) { if(enabled)model.clippingPlanes=new ClippingPlaneCollection({planes:[new ClippingPlane(new Cartesian3(1,0,0),-1000)]});
    else (model as unknown as {clippingPlanes:ClippingPlaneCollection|undefined}).clippingPlanes=undefined;await frames();return read(); },
  async opacity(alpha:number){model.color=new Color(1,1,1,alpha);await frames();return read();},
  async cacheChange(kind:string) {
    if(kind==='camera')viewer.camera.moveRight(1);
    if(kind==='frustum')viewer.camera.frustum.near=.75;
    if(kind==='matrix')model.modelMatrix=Matrix4.multiplyByTranslation(frame,new Cartesian3(30,0,0),new Matrix4());
    if(kind==='matrix-restore')model.modelMatrix=Matrix4.clone(frame);
    if(kind==='scale')model.scale=.2;
    if(kind==='scale-restore')model.scale=1;
    if(kind==='shader')model.customShader=new CustomShader({fragmentShaderText:'void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) { discard; }'});
    if(kind==='shader-restore'){const shader=model.customShader;(model as unknown as {customShader?:CustomShader}).customShader=undefined;shader?.destroy();}
    const history:ReturnType<typeof occlusion.getStats>[]=[];
    const stop=viewer.scene.postRender.addEventListener(()=>history.push(occlusion.getStats()));
    try{await frames();return {history,result:read()};}finally{stop();}
  },
  async failureRetry() {
    adapter.setState('front',{visible:false,occlusion:true});
    const nativeCommands=adapter.getOcclusionCommands.bind(adapter);
    const source=nativeCommands()[0];
    const shader=source.shaderProgram as {vertexShaderSource:unknown;fragmentShaderSource:{clone():{sources:string[]}};_attributeLocations:Record<string,number>};
    const fragment=shader.fragmentShaderSource.clone();
    // Fail actual WebGL compilation in the owned pass only. The native model's
    // program, geometry and draw command remain untouched throughout the test.
    fragment.sources.push('void ENGINEERING_INTENTIONAL_SHADER_FAILURE() { unavailable_engineering_test_symbol(); }');
    const invalid=Object.assign(Object.create(source),{shaderProgram:{vertexShaderSource:shader.vertexShaderSource,fragmentShaderSource:fragment,_attributeLocations:shader._attributeLocations}});
    adapter.getOcclusionCommands=()=>[invalid];
    try {
      occlusion.setEnabled(true);await renderFixtureFrames(viewer.scene,1,()=>errors);
      const failed=occlusion.getStats(),failedFrame=read();occlusion.setEnabled(false);
      adapter.getOcclusionCommands=nativeCommands;await frames();const disabled=occlusion.getStats();
      occlusion.setEnabled(true);const beforeFirstRetryFrame=occlusion.getStats();
      await frames();return {failed,failedFrame,disabled,beforeFirstRetryFrame,recovered:read()};
    } finally {adapter.getOcclusionCommands=nativeCommands;}
  },
  async dispose() { occlusion.dispose(); adapter.dispose(); await frames(); return { shows:[model.getNode('front').show,model.getNode('rear').show], errors:[...errors] }; },
  gpu() { const gl=viewer.canvas.getContext('webgl2')!; const ext=gl.getExtension('WEBGL_debug_renderer_info'); return { vendor:gl.getParameter(ext?.UNMASKED_VENDOR_WEBGL??gl.VENDOR), renderer:gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL??gl.RENDERER), version:gl.getParameter(gl.VERSION) }; },
};
(window as unknown as { engineeringFixture: typeof api }).engineeringFixture = api;
await frames();
