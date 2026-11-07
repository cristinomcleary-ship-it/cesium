import * as C from 'cesium';
import {syntheticRoadDxf} from './fixtures.mjs';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import {TemporaryWorksPanel, type TemporaryWorksPlan} from '../../src/temporaryWorksPanel.ts';
import {createTemporaryWorksGlbLighting, temporaryWorksGlbLightingOptions, applyTemporaryWorksGlbAmbientFill} from '../../src/temporaryWorksGlbLighting.ts';
import {hardeningGeoFromLocal} from '../../src/temporaryWorksHardeningEditorGeometry.ts';

const $=(id:string)=>document.getElementById(id)!;
const status=(message:string)=>{$('fixture-status').textContent=message;};
const error=(value:unknown)=>{const message=value instanceof Error?value.message:String(value);$('fixture-errors').textContent=message;console.error(message);};
window.addEventListener('error',e=>error(e.error??e.message));window.addEventListener('unhandledrejection',e=>error(e.reason));
const viewer=new C.Viewer('scene',{baseLayer:false,globe:false,skyBox:false,skyAtmosphere:false,animation:false,timeline:false,geocoder:false,homeButton:false,sceneModePicker:false,baseLayerPicker:false,navigationHelpButton:false,fullscreenButton:false,infoBox:false,selectionIndicator:false,contextOptions:{webgl:{preserveDrawingBuffer:true,alpha:false}}});
viewer.scene.backgroundColor=new C.Color(.10,.15,.20,1);viewer.scene.highDynamicRange=false;viewer.clock.shouldAnimate=false;viewer.clock.currentTime=C.JulianDate.fromIso8601('2026-11-06T04:00:00Z');
viewer.scene.renderError.addEventListener((_scene:unknown,e:unknown)=>error(e));
const origin={longitude:121,latitude:31,height:0};
const models:{id:string;name:string;tileset:C.Cesium3DTileset}[]=[];
const records=new Map<string,TemporaryWorksPlan>();
const project='temporary-works-isolated-validation';
const store={
  async list(){return [...records.values()].map(p=>structuredClone(p));},
  async put(_project:string,plan:TemporaryWorksPlan){records.set(plan.id,structuredClone(plan));},
  async updateExisting(_project:string,id:string,update:(p:TemporaryWorksPlan)=>TemporaryWorksPlan){const plan=records.get(id);if(!plan)throw new Error('演示记录已删除');const next=update(structuredClone(plan));records.set(id,structuredClone(next));return next;},
  async remove(_project:string,id:string){records.delete(id);},
};
const panel=new TemporaryWorksPanel({root:$('panel'),viewer,getTilesets:()=>models,store,canEdit:()=>true,
  toast:(message:string,isError?:boolean)=>{ $('notice').textContent=message;if(isError)$('fixture-errors').textContent=message;},
  onPlansChanged:()=>{$('notice').textContent=`内存方案 ${records.size} 条；本页无生产数据。`;},
  beginInteractionSession:()=>()=>{},onRequestClose:()=>status('验证面板保留打开，可继续操作。')});
await panel.setProject(project);panel.open();
let syntheticModel:C.Model|undefined,syntheticLighting:ReturnType<typeof createTemporaryWorksGlbLighting>|undefined;
function look(top=false){const point=C.Cartesian3.fromDegrees(121,31,0);viewer.camera.lookAt(point,new C.HeadingPitchRange(0,top?-Math.PI/2:-.62,top?320:410));viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);viewer.scene.requestRender();}
look();
let loadingSynthetic:Promise<void>|undefined;
async function loadSynthetic(){
 if(loadingSynthetic)return loadingSynthetic;
 loadingSynthetic=loadSyntheticOnce().finally(()=>{loadingSynthetic=undefined;});
 return loadingSynthetic;
}
async function loadSyntheticOnce(){
 if(!models.length){const tileset=await C.Cesium3DTileset.fromUrl('/fixtures/tileset.json',{maximumScreenSpaceError:2});viewer.scene.primitives.add(tileset);models.push({id:'synthetic-ground',name:'合成地面 3D Tiles（非摄影数据）',tileset});panel.refresh();}
 if(!syntheticModel){const at=hardeningGeoFromLocal({x:0,y:-90},origin);const placement={...at,height:2};syntheticLighting=createTemporaryWorksGlbLighting(placement);syntheticModel=await C.Model.fromGltfAsync({url:'/fixtures/materials.gltf',modelMatrix:C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(at.longitude,at.latitude,2)),upAxis:C.Axis.Z,forwardAxis:C.Axis.X,...temporaryWorksGlbLightingOptions(),customShader:syntheticLighting.shader,incrementallyLoadTextures:false});applyTemporaryWorksGlbAmbientFill(syntheticModel);viewer.scene.primitives.add(syntheticModel);syntheticModel.errorEvent.addEventListener(error);}
 look();status('合成场景已加载：棋盘地面用于裁剪观察，前排色块用于独立亮度验证。');
}
function input(id:string,value:string,kind:'input'|'change'='input'){const element=$(id) as HTMLInputElement;element.value=value;element.dispatchEvent(new Event(kind,{bubbles:true}));}
async function seedRoad(){await loadSynthetic();input('tw-kind','road','change');const file=new File([syntheticRoadDxf()],'synthetic-road.dxf',{type:'application/dxf'});const transfer=new DataTransfer();transfer.items.add(file);const cad=$('tw-cad') as HTMLInputElement;cad.files=transfer.files;cad.dispatchEvent(new Event('change',{bubbles:true}));const until=performance.now()+10000;while(performance.now()<until&&(($('tw-feature') as HTMLSelectElement).options.length<2))await new Promise(r=>setTimeout(r,50));if(($('tw-feature') as HTMLSelectElement).options.length<2)throw new Error('演示CAD未成功导入，请检查右侧错误提示。');input('tw-coord','local','change');input('tw-axis','eastNorth','change');input('tw-unit','m','change');for(const[id,value]of Object.entries({'tw-anchor-x':'0','tw-anchor-y':'0','tw-anchor-lon':'121','tw-anchor-lat':'31','tw-rotation':'0','tw-width':'7','tw-thickness':'.3','tw-treatment':'.2','tw-road-elevation':'2','tw-name':'合成便道验证'}))input(id,value);status('便道演示图纸与参数已填入；请在右侧核对、选择纵坡、勾选确认并生成/保存。');}
async function seedHardening(){await loadSynthetic();input('tw-kind','hardening','change');for(const[key,value]of Object.entries({name:'合成硬化验证',longitude:'121',latitude:'31',height:'2',thickness:'.3'})){const e=document.querySelector<HTMLInputElement>(`[data-hde="${key}"]`)!;e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));}look(true);status('硬化参考点、顶标高2 m、厚度0.3 m已填入；请点击右侧矩形/多边形工具后在地面真实圈选。');}
async function reload(){await panel.setProject(null);await panel.setProject(project);panel.open();status(`已从独立内存存储重载 ${records.size} 条方案。`);}
async function loadPrivate(){await loadSynthetic();const response=await fetch('/models/temporary-works/manifest.json');if(!response.ok)throw new Error('未找到私有模型清单。请先用 --assets 指定已有运行资源目录；合成场景仍可独立检查。');const manifest=await response.json();const date=new Date().toISOString();for(const [id,x,y]of [['camp',-75,45],['steel',70,45],['wall',0,90]] as const){const asset=manifest.assets.find((a:any)=>a.id===id);if(!asset)continue;const geo=hardeningGeoFromLocal({x,y},origin);const dims=asset.dimensions;const plan={id:`private-${id}`,name:`本地私有${id==='camp'?'驻地':id==='steel'?'钢筋场':'宣传墙'}验证`,kind:id==='steel'?'steel':'camp',visible:true,createdAt:date,modelId:'synthetic-ground',modelName:models[0].name,glb:{resourceId:id,clippingEnabled:id!=='wall',placementMode:'manual',placement:{...geo,height:2,headingDeg:0,scaleMode:'uniform',dimensions:{...dims}},...(id==='wall'?{branding:{visible:true,text:'中铁二十四局\n安全施工 文明作业'}}:{})},earthworkDisabled:true,mesh:{vertices:[],triangles:[]},metrics:{planArea:0,coveredArea:0,excludedArea:0,cutVolume:0,fillVolume:0},inputs:{cadName:'本地私有独立验证，不使用现场CAD',modelMatrix:C.Matrix4.toArray(models[0].tileset.modelMatrix),modelRootTransform:C.Matrix4.toArray(models[0].tileset.root.transform),feature:{id:'fixture-boundary',layer:'synthetic',sourceType:'验证数据',closed:true,points:[{x:geo.longitude,y:geo.latitude},{x:geo.longitude+.0001,y:geo.latitude},{x:geo.longitude+.0001,y:geo.latitude+.0001}]},coordinates:{mode:'geographic',axisOrder:'eastNorth'},reference:{...geo,height:2},referenceInput:{mode:'geo',first:geo.longitude,second:geo.latitude},design:{reference:{x:0,y:0},referenceHeight:2,finishedOffset:0,surfaceToTreatment:0,treatmentDepth:0},facilityMode:'glb',spacing:0,sampleCount:0,refinementLevels:0,budgetLimited:false}} as TemporaryWorksPlan;records.set(plan.id,plan);}await reload();look();status('本地私有模型已作为独立验证记录加载；摄影仍是合成棋盘。右侧统一亮度控制这些模型。');}
for(const[id,fn]of Object.entries({'load-synthetic':loadSynthetic,'seed-road':seedRoad,'seed-hardening':seedHardening,'load-private':loadPrivate,'reload-plans':reload,'look-top':()=>look(true),'look-oblique':()=>look(false)}))$(id).addEventListener('click',()=>{Promise.resolve(fn()).catch(error);});
let night=false;$('toggle-time').addEventListener('click',()=>{night=!night;viewer.clock.currentTime=C.JulianDate.fromIso8601(night?'2026-11-06T16:00:00Z':'2026-11-06T04:00:00Z');$('toggle-time').textContent=night?'切换日间':'切换夜间';viewer.scene.requestRender();status(night?'当前夜间时刻；检查模型颜色是否保持。':'当前日间时刻；检查模型颜色是否保持。');});
$('synthetic-brightness').addEventListener('input',event=>{const value=Number((event.target as HTMLInputElement).value);syntheticLighting?.setBrightness(value);$('synthetic-value').textContent=`${value}%`;viewer.scene.requestRender();});
status('独立Viewer与真实临建面板已就绪。请先点击“加载合成场景”。私有模型未接入时可忽略资源提示；本页不连接生产接口。');
window.addEventListener('beforeunload',()=>{panel.destroy();syntheticLighting?.destroy();viewer.destroy();});
