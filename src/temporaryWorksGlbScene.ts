import { Axis, BoundingSphere, Cartesian2, Cartesian3, Cesium3DTileset, Color, HeadingPitchRange,
  ImageMaterialProperty, LabelStyle, Math as CesiumMath, Matrix3, Matrix4, Model, Plane, Quaternion,
  Transforms, VerticalOrigin, type Entity, type Viewer } from 'cesium';
import { TemporaryWorksClippingManager } from './temporaryWorksClipping';
import { getTemporaryWorksGlbFootprints, getTemporaryWorksGlbModelMatrix, loadTemporaryWorksGlbManifest,
  type TemporaryWorksGlbConfig, type TemporaryWorksGlbResource } from './temporaryWorksGlb';
import { applyTemporaryWorksGlbAmbientFill, temporaryWorksGlbLightingOptions } from './temporaryWorksGlbLighting';

export type TemporaryWorksGlbStatus = { state: 'loading'|'ready'|'waiting'|'blocked'|'error'|'hidden'|'disabled'; message: string };
const managers = new WeakMap<Viewer, TemporaryWorksClippingManager>();
/** Version only this deployment's private runtime assets; leave external/signed URLs intact. */
export function getTemporaryWorksRuntimeGlbUrl(asset: TemporaryWorksGlbResource, base: string, pageUrl: string) {
  const baseUrl = new URL(base, pageUrl), url = new URL(asset.url, baseUrl);
  const runtimeRoot = new URL('models/temporary-works/', baseUrl);
  if (url.origin === new URL(pageUrl).origin && url.origin === runtimeRoot.origin &&
      url.pathname.startsWith(runtimeRoot.pathname) && typeof asset.sha256 === 'string' && /^[a-f\d]{64}$/i.test(asset.sha256)) {
    url.searchParams.set('v', asset.sha256.toLowerCase());
  }
  return url.href;
}
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
  let stopStatusWatch: (() => void) | undefined;
  let visible = true, destroyed = false, tileset = options.tileset;
  let status: TemporaryWorksGlbStatus = {state:'loading',message:'正在加载真实 GLB 资源…'};
  const bounds = new BoundingSphere(Cartesian3.fromDegrees(options.placement.longitude, options.placement.latitude, options.placement.height), 20);
  const setStatus = (value: TemporaryWorksGlbStatus) => {
    if (status.state === value.state && status.message === value.message) return;
    status = value; if (!destroyed) options.onStatus?.(value);
  };
  const requestRender = () => { if (!viewer.isDestroyed()) viewer.scene.requestRender(); };
  function reflectClippingStatus() {
    if (destroyed || !visible || !options.clippingEnabled || options.resourceId === 'wall') return;
    const current=manager.getStatus(clippingId);
    if (!current) return;
    if (current.state === 'active') setStatus({state:'ready',message:'真实 GLB 已加载，建筑底面摄影遮挡已启用。'});
    else setStatus({state:'blocked',message:current.message});
  }
  function syncClipping() {
    if (destroyed || !asset || !model?.ready || viewer.isDestroyed()) return;
    if (!visible) { manager.remove(clippingId); setStatus({state:'hidden',message:'模型已隐藏，对应摄影遮挡已撤销。'}); return; }
    if (!options.clippingEnabled || options.resourceId === 'wall') {
      manager.remove(clippingId); setStatus({state:'disabled',message:options.resourceId === 'wall' ? '独立宣传墙已加载。' : '模型已加载，摄影遮挡已关闭。'}); return;
    }
    if (!tileset || tileset.isDestroyed()) {
      manager.remove(clippingId); setStatus({state:'waiting',message:'模型已加载，等待关联原倾斜摄影后恢复遮挡。'}); return;
    }
    manager.upsert({id:clippingId,tileset,footprints:getTemporaryWorksGlbFootprints(asset,options.placement),visible:true,enabled:true});
    reflectClippingStatus();
    stopStatusWatch ??= viewer.scene.postUpdate?.addEventListener(reflectClippingStatus);
    requestRender();
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopStatusWatch?.(); stopStatusWatch = undefined;
    manager.remove(clippingId);
    if (!viewer.isDestroyed()) {
      entities.forEach(e => viewer.entities.remove(e));
      if (model && collection.contains(model)) collection.remove(model);
      requestRender();
    }
    // Covers destroyPrimitives=false collections and viewer teardown as well. Model owns
    // its default IBL/environment map, so this releases their GPU resources exactly once.
    if (model && !model.isDestroyed()) model.destroy();
  }
  async function addBranding() {
    const branding = options.branding;
    if (!branding || branding.visible === false || (!branding.text?.trim() && !branding.logoUrl)) return;
    if (branding.logoUrl) {
      const parsed = new URL(branding.logoUrl,window.location.href);
      if (!['http:','https:','data:'].includes(parsed.protocol) || (parsed.protocol === 'data:' && !/^data:image\/(png|jpeg|webp);base64,/i.test(branding.logoUrl)))
        throw new Error('企业 LOGO 请使用 PNG/JPEG/WebP 图片或有效图片网址。');
    }
    const {longitude,latitude,height,dimensions} = options.placement;
    const position = Cartesian3.fromDegrees(longitude,latitude,height + dimensions.height + 1);
    const text = branding.text?.trim().slice(0, 250);
    if (options.resourceId === 'wall' && asset) {
      const canvas = document.createElement('canvas');
      canvas.width=2048; canvas.height=512;
      const ctx=canvas.getContext('2d');
      if (!ctx) throw new Error('无法创建宣传墙文字画布。');
      ctx.fillStyle='#f7f9fc';ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.fillStyle='#153c72';ctx.fillRect(0,460,2048,52);
      let textX=1024,textWidth=1800;
      if (branding.logoUrl) {
        const logo=await new Promise<HTMLImageElement>((resolve,reject)=>{
          const img=new Image();img.crossOrigin='anonymous';
          img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('企业 LOGO 图片加载失败，请重新选择图片。'));
          img.src=branding.logoUrl!;
        });
        if (destroyed || viewer.isDestroyed()) return;
        const ratio=Math.min(360/logo.naturalWidth,330/logo.naturalHeight);
        const w=logo.naturalWidth*ratio,h=logo.naturalHeight*ratio;
        ctx.drawImage(logo,50+(360-w)/2,65+(330-h)/2,w,h);
        textX=1220;textWidth=1480;
      }
      ctx.fillStyle='#173b70';ctx.textAlign='center';ctx.textBaseline='middle';
      const lines=(text || '').split(/\n/).filter(Boolean).slice(0,4);
      const font=Math.min(110,Math.floor(330/Math.max(lines.length,1)));
      ctx.font=`600 ${font}px sans-serif`;
      lines.forEach((line,i)=>ctx.fillText(line,textX,230+(i-(lines.length-1)/2)*(font+28),textWidth));
      const matrix=getTemporaryWorksGlbModelMatrix(asset,options.placement);
      const widthScale=dimensions.width/asset.dimensions.width;
      const face=Matrix4.multiplyByPoint(matrix,new Cartesian3((asset.bounds.min[0]+asset.bounds.max[0])/2,
        (asset.bounds.min[1]+asset.bounds.max[1])/2,asset.bounds.max[2]+0.01/widthScale),new Cartesian3());
      const frame=Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(longitude,latitude,height));
      const rotation=Matrix3.multiply(Matrix3.fromRotationZ(CesiumMath.toRadians(options.placement.headingDeg)),Matrix3.fromRotationX(Math.PI/2),new Matrix3());
      const worldRotation=Matrix3.multiply(Matrix4.getMatrix3(frame,new Matrix3()),rotation,new Matrix3());
      entities.push(viewer.entities.add({name:`临建宣传面板 · ${options.id}`,position:face,orientation:Quaternion.fromRotationMatrix(worldRotation),
        plane:{plane:new Plane(Cartesian3.UNIT_Z,0),dimensions:new Cartesian2(dimensions.length*0.98,dimensions.height*0.94),material:new ImageMaterialProperty({image:canvas})},show:visible}));
      return;
    }
    if (text) entities.push(viewer.entities.add({name:`临建宣传文字 · ${options.id}`,position,
      label:{text,font:'22px sans-serif',fillColor:Color.WHITE,outlineColor:Color.fromCssColorString('#12345c'),
        outlineWidth:3,style:LabelStyle.FILL_AND_OUTLINE,verticalOrigin:VerticalOrigin.BOTTOM,pixelOffset:new Cartesian2(0,-12)}, show:visible}));
    if (branding.logoUrl) {
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
    const loaded = await Model.fromGltfAsync({url:getTemporaryWorksRuntimeGlbUrl(asset,base,window.location.href),
      modelMatrix:matrix,upAxis:Axis.Z,forwardAxis:Axis.X,minimumPixelSize:0,show:visible,
      ...temporaryWorksGlbLightingOptions(),
      incrementallyLoadTextures:false,enableVerticalExaggeration:false,id:`temporary-works:${options.id}`});
    if (destroyed || viewer.isDestroyed()) { if (!loaded.isDestroyed()) loaded.destroy(); return; }
    loaded.show = visible;
    // Take ownership before attaching so an attachment failure also releases model/IBL.
    model = loaded;
    applyTemporaryWorksGlbAmbientFill(loaded);
    collection.add(loaded);
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
    await addBranding();
    if (destroyed || viewer.isDestroyed()) return;
    syncClipping(); requestRender();
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
