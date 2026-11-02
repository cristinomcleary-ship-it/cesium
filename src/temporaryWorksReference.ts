import {
  AmbientLight, BoxGeometry, BufferGeometry, CanvasTexture,
  DirectionalLight, DoubleSide, Float32BufferAttribute, Group, HemisphereLight, Mesh, MeshStandardMaterial,
  PCFSoftShadowMap, PerspectiveCamera, PlaneGeometry, RepeatWrapping, Scene, SRGBColorSpace, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { facilityGeometry, finishes, type FacilityKind, type Finish, type XY } from './temporaryWorksArchitecture';
import { buildStandardSiteDecor } from './temporaryWorksSiteDecor';
import { standardSiteBuildings, standardSiteSize } from './temporaryWorksSiteLayout';
import './temporaryWorksReference.css';

const samples = {
  camp:{code:'01',name:'项目驻地',label:'国旗台、营房与停车区',rows:['中铁二十四局集团有限公司','办公营房、宿舍与门卫室','院内国旗台 · 5 个停车位']},
  steel:{code:'02',name:'钢筋加工场',label:'封闭式厂房与堆料区',rows:['中铁二十四局集团有限公司','厂房 32 × 15 m，高 6.5 m','围护外墙、工业门与水平条幅']},
};
let active: {show:(kind:FacilityKind)=>void; close:()=>void} | undefined;
function texture(roof:boolean) {
  const c=document.createElement('canvas'); c.width=c.height=256;
  const ctx=c.getContext('2d')!;
  const pixels=ctx.createImageData(256,256);
  let n=7219;
  for(let i=0;i<256*256;i++){
    n=(Math.imul(n,1664525)+1013904223)>>>0;
    const x=i%256,y=i>>>8;
    const shade=roof ? 228+18*Math.sin(x*Math.PI/16)+(x%32<4?-54:0)+((n>>>29)-4) :
      239+((n>>>28)-8)+((x%256<2||y%256<2)?-29:0)+2*Math.sin(y*.9);
    pixels.data[i*4]=pixels.data[i*4+1]=pixels.data[i*4+2]=shade;pixels.data[i*4+3]=255;
  }
  ctx.putImageData(pixels,0,0);
  const t=new CanvasTexture(c);
  t.colorSpace=SRGBColorSpace;t.wrapS=t.wrapT=RepeatWrapping;t.repeat.set(roof?.42:.24,roof?.42:.24);
  return t;
}

/** The reference viewer shares its building and yard geometry with the main scene. */
export function openFacilityReference(kind: FacilityKind) {
  if(active){active.show(kind);return;}
  const dialog=document.createElement('dialog');dialog.id='tw-reference-dialog';dialog.dataset.facilityAppearance='20261102d';dialog.setAttribute('aria-label','临建设施三维参考模型');
  dialog.innerHTML=`<header><div><small>临建规划　/　三维参考</small><h2>临建设施模型预览</h2></div><button data-tw-reference-close aria-label="关闭参考模型">×</button></header>
    <div class="tw-ref-layout"><main data-tw-facility-preview><div class="tw-ref-view">三维透视　·　示例场地</div></main>
    <aside><div class="tw-ref-selector"><button data-tw-reference-kind="camp">项目驻地</button><button data-tw-reference-kind="steel">钢筋场</button></div>
    <p class="tw-ref-series"></p><h3></h3><p class="tw-ref-sub"></p><ul></ul><p class="tw-ref-note">在临建规划中选择对应场界和“自动布置标准模型”，点击“在摄影场景中生成模型”，即可将这套设施放到现场。实际布置比例可在方案复核中查看。</p><button class="tw-ref-reset">复位视角</button></aside></div>
    <footer><span>拖动旋转　·　滚轮缩放</span><span>参考模型　/　单位 m</span></footer>`;
  document.body.append(dialog);dialog.showModal();
  const host=dialog.querySelector<HTMLElement>('[data-tw-facility-preview]')!;
  let renderer:WebGLRenderer;
  try {renderer=new WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true});}
  catch(e) {
    host.append('此设备暂时无法建立三维预览，请开启浏览器硬件加速。');
    const close=()=>{dialog.close();dialog.remove();active=undefined;};
    dialog.querySelector('button')!.onclick=close;
    dialog.addEventListener('cancel',e=>{e.preventDefault();close();},{once:true});
    return;
  }
  renderer.setPixelRatio(Math.min(2,window.devicePixelRatio||1));
  renderer.outputColorSpace=SRGBColorSpace;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=PCFSoftShadowMap;
  host.prepend(renderer.domElement);
  const scene=new Scene(), camera=new PerspectiveCamera(34,1,.2,380);
  const controls=new OrbitControls(camera,renderer.domElement);
  controls.enablePan=false;controls.minDistance=24;controls.maxDistance=115;
  controls.maxPolarAngle=Math.PI*.485;controls.minPolarAngle=.2;
  const render=()=>renderer.render(scene,camera);
  controls.addEventListener('change',render);
  scene.add(new HemisphereLight('#fffaf1','#a7aba5',2.15),new AmbientLight('#e7edf2',.34));
  const sun=new DirectionalLight('#fff3d5',2.3);sun.position.set(-28,52,19);sun.castShadow=true;
  Object.assign(sun.shadow.camera,{left:-40,right:40,top:36,bottom:-36,near:1,far:130});
  sun.shadow.mapSize.set(2048,2048);sun.shadow.normalBias=.025;sun.shadow.bias=-.00016;scene.add(sun);
  const groundMat=new MeshStandardMaterial({color:'#bdc6c2',roughness:1});
  const ground=new Mesh(new PlaneGeometry(340,340),groundMat);
  ground.rotation.x=-Math.PI/2;ground.position.y=-.52;ground.receiveShadow=true;scene.add(ground);
  const concrete=texture(false), roof=texture(true);
  const materials = new Map<string,MeshStandardMaterial>();
  function mat(color:string,finish?:Finish) {
    const key=color+(finish??'');
    let material=materials.get(key);
    if (!material) {
      material=new MeshStandardMaterial({color,side:DoubleSide,roughness:finish==='glass'?.29:finish==='roof'?.55:.86,
        metalness:finish==='frame'||finish==='roof'?.17:0,bumpMap:finish==='roof'?roof:null,bumpScale:.045,map:finish==='roof'?roof:finish==='concrete'?concrete:null});
      materials.set(key,material);
    }
    return material;
  }
  let group:Group,current=kind;
  function disposeGroup() {
    if(!group)return;
    scene.remove(group);group.traverse(o=>{if(o instanceof Mesh)o.geometry.dispose();});
  }
  function add(geom:BufferGeometry,color:string,x:number,y:number,z:number,finish?:Finish){
    const m=new Mesh(geom,mat(color,finish));m.position.set(x,z,-y);m.castShadow=true;m.receiveShadow=true;group.add(m);return m;
  }
  function box(x:number,y:number,z:number,l:number,w:number,h:number,color:string){
    return add(new BoxGeometry(l,h,w),color,x,y,z+h/2);
  }
  function batchMesh(positions:number[],indices:number[],color:string,x=0,y=0,z=0,finish?:Finish,uv?:number[]) {
    const pos:number[]=[];
    for(let i=0;i<positions.length;i+=3)pos.push(positions[i],positions[i+2],-positions[i+1]);
    const geo=new BufferGeometry();
    geo.setAttribute('position',new Float32BufferAttribute(pos,3));
    if(uv)geo.setAttribute('uv',new Float32BufferAttribute(uv,2));
    geo.setIndex(indices);geo.computeVertexNormals();add(geo,color,x,y,z,finish);
  }
  function building(k:FacilityKind,x:number,y:number,l:number,w:number,h:number,showCompanySign=true) {
    const outline:XY[]=[[x-l/2,y-w/2],[x+l/2,y-w/2],[x+l/2,y+w/2],[x-l/2,y+w/2]];
    const bs=facilityGeometry(k,{outline,vertices:outline.map(([x,y])=>({x,y,z:0})),triangles:[[0,1,2],[0,2,3]],height:h,showCompanySign});
    for(const b of bs)batchMesh(b.positions,b.indices,finishes[b.finish],0,0,0,b.finish,b.uv);
  }
  function model(k:FacilityKind) {
    disposeGroup();group=new Group();scene.add(group);
    const {length,width}=standardSiteSize;
    box(0,0,-.45,length,width,.42,'#9a9b93');
    const pad=new PlaneGeometry(length,width);pad.rotateX(-Math.PI/2);
    const uv=pad.getAttribute('uv');
    for(let i=0;i<uv.count;i++)uv.setXY(i,uv.getX(i)*length,uv.getY(i)*width);
    add(pad,'#c3bfb5',0,0,0,'concrete');
    for(const b of standardSiteBuildings[k]) building(k,b.x,b.y,b.length,b.width,b.height,b.showCompanySign);
    for(const part of buildStandardSiteDecor(k,true)) batchMesh(part.positions,part.indices,part.color);
  }
  function reset(){
    camera.position.copy(current==='steel'?new Vector3(37,17.8,48):new Vector3(23,24.3,52));
    controls.target.set(0,1.85,0);controls.update();render();
  }
  function show(k:FacilityKind) {
    current=k;model(k);const sample=samples[k];
    dialog.dataset.kind=k;
    for(const b of dialog.querySelectorAll<HTMLElement>('[data-tw-reference-kind]'))b.setAttribute('aria-pressed',String(b.dataset.twReferenceKind===k));
    dialog.querySelector('.tw-ref-series')!.textContent='方案样例  /  '+sample.code;
    dialog.querySelector('h3')!.textContent=sample.name;dialog.querySelector('.tw-ref-sub')!.textContent=sample.label;
    dialog.querySelector('ul')!.replaceChildren(...sample.rows.map(v=>{const li=document.createElement('li');li.textContent=v;return li;}));
    reset();
  }
  function resize(){
    const w=Math.max(1,host.clientWidth),h=Math.max(1,host.clientHeight);
    renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();render();
  }
  const observer=new ResizeObserver(resize);observer.observe(host);
  function close(){
    active=undefined;observer.disconnect();controls.dispose();disposeGroup();
    ground.geometry.dispose();groundMat.dispose();materials.forEach(m=>m.dispose());roof.dispose();concrete.dispose();
    sun.shadow.dispose();renderer.dispose();renderer.forceContextLoss();dialog.remove();
  }
  dialog.addEventListener('close',close,{once:true});
  for(const b of dialog.querySelectorAll<HTMLButtonElement>('[data-tw-reference-kind]'))b.onclick=()=>show(b.dataset.twReferenceKind as FacilityKind);
  dialog.querySelector<HTMLButtonElement>('[data-tw-reference-close]')!.onclick=()=>dialog.close();
  dialog.querySelector<HTMLButtonElement>('.tw-ref-reset')!.onclick=reset;
  active={show,close:()=>dialog.close()};resize();show(kind);
}
