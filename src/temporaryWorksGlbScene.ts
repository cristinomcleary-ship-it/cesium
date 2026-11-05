import { Axis, BoundingSphere, Cartesian2, Cartesian3, Cesium3DTileset, Color, HeadingPitchRange,
  LabelStyle, Matrix4, Model, VerticalOrigin, type Entity, type Viewer } from 'cesium';
import { TemporaryWorksClippingManager } from './temporaryWorksClipping';
import { getTemporaryWorksGlbFootprints, getTemporaryWorksGlbModelMatrix, loadTemporaryWorksGlbManifest,
  type TemporaryWorksGlbConfig, type TemporaryWorksGlbResource } from './temporaryWorksGlb';

export type TemporaryWorksGlbStatus = { state: 'loading'|'ready'|'waiting'|'blocked'|'error'|'hidden'|'disabled'; message: string };
const managers = new WeakMap<Viewer, TemporaryWorksClippingManager>();
function clippingManager(viewer: Viewer) {
  let manager = managers.get(viewer);
  if (!manager) { manager = new TemporaryWorksClippingManager(viewer); managers.set(viewer, manager); }
  return manager;
}

/** Each handle owns only its primitive, branding entities and clipping ID. No global layer state changes. */
export function renderTemporaryWorksGlb(viewer: Viewer, options: TemporaryWorksGlbConfig & {
  id: string; tileset?: Cesium3DTileset; onStatus?: (status: TemporaryWorksGlbStatus) => void;
}) {
  const collection = viewer.scene.primitives, manager = clippingManager(viewer);
  // Handles may overlap briefly while an edited plan is being validated. Never reuse the saved ID as ownership token.
  const clippingId = `tw-glb:${options.id}:${crypto.randomUUID()}`;
  const entities: Entity[] = [];
  let model: Model | undefined, asset: TemporaryWorksGlbResource | undefined;
  let visible = true, destroyed = false, tileset = options.tileset;
  let status: TemporaryWorksGlbStatus = {state:'loading',message:'正在加载真实 GLB 资源…'};
  const bounds = new BoundingSphere(Cartesian3.fromDegrees(options.placement.longitude, options.placement.latitude, options.placement.height), 20);
  const setStatus = (value: TemporaryWorksGlbStatus) => { status = value; if (!destroyed) options.onStatus?.(value); };
  const requestRender = () => { if (!viewer.isDestroyed()) viewer.scene.requestRender(); };
  function syncClipping() {
    if (destroyed || !asset || !model?.ready || viewer.isDestroyed()) return;
    if (!visible) { manager.remove(clippingId); setStatus({state:'hidden',message:'模型已隐藏，对应摄影遮挡已撤销。'}); return; }
    if (!options.clippingEnabled || options.resourceId === 'wall') {
      manager.remove(clippingId); setStatus({state:'disabled',message:options.resourceId === 'wall' ? '独立宣传墙已加载。' : '模型已加载，摄影遮挡已关闭。'}); return;
    }
    if (!tileset || tileset.isDestroyed()) {
      manager.remove(clippingId); setStatus({state:'waiting',message:'模型已加载，等待关联原倾斜摄影后恢复遮挡。'}); return;
    }
    const result = manager.upsert({id:clippingId,tileset,footprints:getTemporaryWorksGlbFootprints(asset,options.placement),visible:true,enabled:true});
    const current = result ?? manager.getStatus(clippingId);
    if (current?.state === 'active') setStatus({state:'ready',message:'真实 GLB 已加载，建筑底面摄影遮挡已启用。'});
    else setStatus({state:'blocked',message:current?.message ?? '摄影遮挡未生效，请检查目标模型裁剪状态。'});
    requestRender();
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    manager.remove(clippingId);
    if (!viewer.isDestroyed()) {
      entities.forEach(e => viewer.entities.remove(e));
      if (model && collection.contains(model)) collection.remove(model);
      else if (model && !model.isDestroyed()) model.destroy();
      requestRender();
    }
  }
  function addBranding() {
    const branding = options.branding;
    if (!branding || branding.visible === false || (!branding.text?.trim() && !branding.logoUrl)) return;
    const {longitude,latitude,height,dimensions} = options.placement;
    const position = Cartesian3.fromDegrees(longitude,latitude,height + dimensions.height + 1);
    const text = branding.text?.trim().slice(0, 250);
    if (text) entities.push(viewer.entities.add({name:`临建宣传文字 · ${options.id}`,position,
      label:{text,font:'22px sans-serif',fillColor:Color.WHITE,outlineColor:Color.fromCssColorString('#12345c'),
        outlineWidth:3,style:LabelStyle.FILL_AND_OUTLINE,verticalOrigin:VerticalOrigin.BOTTOM,pixelOffset:new Cartesian2(0,-12)}, show:visible}));
    if (branding.logoUrl) {
      const parsed = new URL(branding.logoUrl,window.location.href);
      if (!['http:','https:','data:'].includes(parsed.protocol) || (parsed.protocol === 'data:' && !/^data:image\/(png|jpeg|webp);base64,/i.test(branding.logoUrl)))
        throw new Error('企业 LOGO 请使用 PNG/JPEG/WebP 图片或有效图片网址。');
      entities.push(viewer.entities.add({name:`临建企业标识 · ${options.id}`,position,
        billboard:{image:branding.logoUrl,width:80,height:80,verticalOrigin:VerticalOrigin.BOTTOM,pixelOffset:new Cartesian2(0,-65)},show:visible}));
    }
  }
  const ready = (async () => {
    const manifest = await loadTemporaryWorksGlbManifest();
    if (destroyed || viewer.isDestroyed()) return;
    asset = manifest.assets.find(a => a.id === options.resourceId);
    if (!asset) throw new Error('所选临建资源不存在，请更新完整部署包。');
    const matrix = getTemporaryWorksGlbModelMatrix(asset,options.placement);
    const corners: Cartesian3[] = [];
    for (const x of [asset.bounds.min[0],asset.bounds.max[0]]) for (const y of [asset.bounds.min[1],asset.bounds.max[1]]) for (const z of [asset.bounds.min[2],asset.bounds.max[2]])
      corners.push(Matrix4.multiplyByPoint(matrix,new Cartesian3(x,y,z),new Cartesian3()));
    BoundingSphere.fromPoints(corners,bounds);
    const base = import.meta.env?.BASE_URL ?? '/';
    const loaded = await Model.fromGltfAsync({url:new URL(asset.url,new URL(base,window.location.href)).href,
      modelMatrix:matrix,upAxis:Axis.Z,forwardAxis:Axis.X,minimumPixelSize:0,show:visible,
      incrementallyLoadTextures:false,enableVerticalExaggeration:false,id:`temporary-works:${options.id}`});
    if (destroyed || viewer.isDestroyed()) { if (!loaded.isDestroyed()) loaded.destroy(); return; }
    model = collection.add(loaded);
    // fromGltfAsync resolves before the first GPU update. Clipping is installed only after the model is ready.
    await new Promise<void>((resolve,reject) => {
      const start = performance.now();
      let settled = false;
      const removeError = loaded.errorEvent.addEventListener((error: Error) => { settled = true; removeError(); reject(error); });
      const tick = () => {
        if (settled) return;
        if (destroyed || viewer.isDestroyed()) { removeError(); resolve(); return; }
        if (loaded.ready) { removeError(); resolve(); return; }
        if (performance.now() - start > 180000) { removeError(); reject(new Error('GLB 加载超时，请检查模型文件与显卡资源。')); return; }
        requestRender(); setTimeout(tick,30);
      };
      tick();
    });
    if (destroyed || viewer.isDestroyed()) return;
    addBranding(); syncClipping(); requestRender();
  })().catch(error => {
    setStatus({state:'error',message:error instanceof Error ? error.message : String(error)});
    destroy(); throw error;
  });
  return {
    yard:{flag:false,spaces:0}, standardPlacement:undefined, bounds, ready, hasStructure:true,
    builtStructureCount:1, structureBuilt:[true], endpoints:[],
    get status() { return status; },
    get show() { return visible; },
    set show(value:boolean) { visible = value; if (model && !model.isDestroyed()) model.show = value; entities.forEach(e => { e.show = value; }); syncClipping(); requestRender(); },
    get xray() { return false; }, set xray(_value:boolean) { /* GLB always uses physical depth testing. */ },
    setTileset(value:Cesium3DTileset|undefined) { if (tileset !== value || status.state === 'waiting' || status.state === 'blocked') { tileset=value;syncClipping(); } },
    zoom() { if (!destroyed && !viewer.isDestroyed()) viewer.camera.flyToBoundingSphere(bounds,{offset:new HeadingPitchRange(-0.5,-0.6,Math.max(15,bounds.radius*2.8))}); },
    destroy,
  };
}
