/** Reproducible derivative pipeline. Never writes to source directory.
 * npm ci --prefix tools/temporary-works-assets
 * node tools/temporary-works-assets/build.mjs /absolute/source-models
 */
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {dedup, prune, instance, draco, weld, simplifyPrimitive, compactPrimitive, flatten, join, textureCompress} from '@gltf-transform/functions';
import {MeshoptSimplifier} from 'meshoptimizer';
import sharp from 'sharp';
import draco3d from 'draco3dgltf';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const source=path.resolve(process.argv[2]||'../source-models');
const out=path.join(repo,'public/models/temporary-works');
const reports=path.join(repo,'docs/temporary-works-upgrade');
await fs.mkdir(out,{recursive:true});await fs.mkdir(reports,{recursive:true});
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'draco3d.decoder':await draco3d.createDecoderModule(),'draco3d.encoder':await draco3d.createEncoderModule()});
await MeshoptSimplifier.ready;
const configs=[
 {id:'wall',name:'独立宣传墙',file:'中铁二十四局_独立宣传墙.glb',exclude:[],baseNodes:['CR24_Freestanding_Sign_Wall']},
 {id:'steel',name:'钢筋棚',file:'钢筋棚_中铁二十四局_品牌整理版.glb',exclude:[],baseNodes:['3DGeom-58','3DGeom-375']},
 {id:'camp',name:'项目部',file:'项目部_中铁二十四局_品牌整理版.glb',exclude:[
  {name:'Obj3d66-17103362-1-478',sourceNode:2,reason:'Oversized 1157m × 1750m export ground plane; only two triangles, outside architectural facility.'},
  {name:'Obj3d66-17103362-2822-564',sourceNode:3103,reason:'Detached component 90m beyond the actual base slab, entirely below slab level.'},
  {name:'Obj3d66-17103362-2823-656',sourceNode:3104,reason:'Detached component 90m beyond the actual base slab, entirely below slab level.'},
  {name:'Obj3d66-17103362-3596-728',sourceNode:3916,reason:'Isolated invisible component 2.57m below base slab, no connection to aboveground architecture.'},
  {name:'Obj3d66-17103362-6873-524',sourceNode:7332,reason:'Isolated inverted component 5.95m below base slab, no connection to aboveground architecture.'},
 ],baseNodes:['Obj3d66-17103362-2792-171']}
];
const manifest=process.argv[3]?JSON.parse(await fs.readFile(path.join(out,'manifest.json'),'utf8')):{schemaVersion:1,unit:'metre',coordinateConvention:'GLTF scene coordinates; Y up; footprint pairs are X,Z; Cesium ENU = X,-Z,Y.',assets:[]};
const audits=process.argv[3]?JSON.parse(await fs.readFile(path.join(reports,'assets-audit.json'),'utf8')):[];
const sha=b=>createHash('sha256').update(b).digest('hex');
const vec=(a,m)=>[m[0]*a[0]+m[4]*a[1]+m[8]*a[2]+m[12],m[1]*a[0]+m[5]*a[1]+m[9]*a[2]+m[13],m[2]*a[0]+m[6]*a[1]+m[10]*a[2]+m[14]];
function hull(points){
 const p=[...new Map(points.map(a=>[a.map(n=>n.toFixed(5)).join(','),a])).values()].sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
 const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
 const low=[],up=[];for(const a of p){while(low.length>1&&cross(low.at(-2),low.at(-1),a)<=1e-7)low.pop();low.push(a);}
 for(const a of p.toReversed()){while(up.length>1&&cross(up.at(-2),up.at(-1),a)<=1e-7)up.pop();up.push(a);}return low.slice(0,-1).concat(up.slice(0,-1));
}
function meshStats(doc){
 let uniqueTriangles=0,renderTriangles=0,nodes=0,draws=0;const root=doc.getRoot();
 for(const mesh of root.listMeshes())for(const p of mesh.listPrimitives())uniqueTriangles+=(p.getIndices()?.getCount()??p.getAttribute('POSITION')?.getCount()??0)/3;
 root.getDefaultScene().traverse(n=>{if(!n.getMesh())return;nodes++;const inst=n.getExtension('EXT_mesh_gpu_instancing');const count=inst?inst.listAttributes()[0].getCount():1;for(const p of n.getMesh().listPrimitives()){draws++;renderTriangles+=count*(p.getIndices()?.getCount()??p.getAttribute('POSITION')?.getCount()??0)/3;}});
 return {uniqueTriangles,renderTriangles,nodes,draws,textures:root.listTextures().length};
}
function geometryAudit(doc,baseNames){
 const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity],baseVertices=[],nodeBounds=[];
 doc.getRoot().getDefaultScene().traverse(n=>{
  const mesh=n.getMesh();if(!mesh)return;const m=n.getWorldMatrix(),mn=[Infinity,Infinity,Infinity],mx=[-Infinity,-Infinity,-Infinity];
  const isBase=baseNames.includes(n.getName());
  for(const pr of mesh.listPrimitives()){
   const pos=pr.getAttribute('POSITION'),v=[0,0,0];for(let i=0;i<pos.getCount();i++){
    pos.getElement(i,v);const p=vec(v,m);for(let j=0;j<3;j++){min[j]=Math.min(min[j],p[j]);max[j]=Math.max(max[j],p[j]);mn[j]=Math.min(mn[j],p[j]);mx[j]=Math.max(mx[j],p[j]);}if(isBase)baseVertices.push(p);
   }
  }nodeBounds.push({name:n.getName(),mesh:mesh.getName(),min:mn,max:mx});
 });
 const floor=Math.min(...baseVertices.map(p=>p[1]));
 const bottom=baseVertices.filter(p=>Math.abs(p[1]-floor)<0.003);
 if(bottom.length<3)throw new Error('Cannot certify structural bottom perimeter');
 const outer=hull(bottom.map(p=>[p[0],p[2]]));
 return {bounds:{min,max},floor,outer,nodeBounds};
}
// Split sign faces in UV space. Original safety panels stay unchanged; former-company logo
// strips get the supplied logo on independent mesh primitives. No raster reconstruction.
function replaceSignBands(doc,sourceTexture,logo,axis,bands,options={}){
 const material=doc.createMaterial(options.name??'CR24_Independent_Logo_Panel').setBaseColorTexture(logo).setBaseColorFactor(options.color??[1,1,1,1]).setRoughnessFactor(0.8).setMetallicFactor(0).setDoubleSided(true);
 let modifiedPrimitives=0;
 const clip=(poly,bound,keepAbove)=>{
  const result=[];for(let i=0;i<poly.length;i++){
   const a=poly[i],b=poly[(i+1)%poly.length],va=a.TEXCOORD_0[axis],vb=b.TEXCOORD_0[axis];
   const ina=keepAbove?va>=bound:va<=bound,inb=keepAbove?vb>=bound:vb<=bound;
   if(ina)result.push(a);
   if(ina!==inb){const t=(bound-va)/(vb-va);result.push(Object.fromEntries(Object.keys(a).map(k=>[k,a[k].map((v,j)=>v+(b[k][j]-v)*t)])));}
  }return result;
 };
 for(const mesh of doc.getRoot().listMeshes())for(const prim of [...mesh.listPrimitives()]){
  if(prim.getMaterial()?.getBaseColorTexture()!==sourceTexture)continue;
  modifiedPrimitives++;
  const uv=prim.getAttribute('TEXCOORD_0');if(!uv)throw new Error('Branded face lacks UV coordinates');
  const attrs=prim.listSemantics(),indices=prim.getIndices()?.getArray()??Array.from({length:uv.getCount()},(_,i)=>i),segments=[];
  const uvMin=uv.getMin([])[axis],uvMax=uv.getMax([])[axis];
  for(let tile=Math.floor(uvMin);tile<Math.max(Math.floor(uvMin)+1,Math.ceil(uvMax));tile++){
   let cursor=tile;for(const [lower,upper]of bands){const lo=tile+lower,hi=tile+upper;if(lo>cursor)segments.push({lo:cursor,hi:lo,replace:false});segments.push({lo,hi,replace:true});cursor=hi;}if(cursor<tile+1)segments.push({lo:cursor,hi:tile+1,replace:false});
  }
  const triangleArea=(a,b,c)=>{const u=b.map((v,i)=>v-a[i]),v=c.map((x,i)=>x-a[i]);return Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])/2;};
  let inputArea=0,outputArea=0;const position=prim.getAttribute('POSITION');for(let i=0;i<indices.length;i+=3){const p=[[],[],[]];p.forEach((v,j)=>position.getElement(indices[i+j],v));inputArea+=triangleArea(...p);}
  for(const segment of segments){
   const arrays=Object.fromEntries(attrs.map(k=>[k,[]]));
   for(let i=0;i<indices.length;i+=3){let poly=[0,1,2].map(j=>Object.fromEntries(attrs.map(k=>{const a=prim.getAttribute(k),value=[];a.getElement(indices[i+j],value);return[k,value];})));
    poly=clip(clip(poly,segment.lo,true),segment.hi,false);
    for(let t=1;t<poly.length-1;t++)for(const vertex of [poly[0],poly[t],poly[t+1]])for(const k of attrs){
     const value=[...vertex[k]];if(segment.replace&&k==='TEXCOORD_0')value[axis]=(value[axis]-segment.lo)/(segment.hi-segment.lo);arrays[k].push(...value);
    }
   }
   if(!arrays.POSITION.length)continue;
   for(let i=0;i<arrays.POSITION.length;i+=9)outputArea+=triangleArea(arrays.POSITION.slice(i,i+3),arrays.POSITION.slice(i+3,i+6),arrays.POSITION.slice(i+6,i+9));
   const replacement=doc.createPrimitive().setMaterial(segment.replace?material:prim.getMaterial());
   for(const k of attrs)replacement.setAttribute(k,doc.createAccessor().setType(prim.getAttribute(k).getType()).setArray(new Float32Array(arrays[k])));
   mesh.addPrimitive(replacement);
  }if(Math.abs(inputArea-outputArea)>Math.max(1e-6,inputArea*1e-5))throw new Error('Brand UV segmentation changed surface area: '+mesh.getName()+' '+inputArea+' -> '+outputArea);
  mesh.removePrimitive(prim);prim.dispose();
 }
 if(!modifiedPrimitives)throw new Error('Audited branded texture has no reachable primitive');
 return {name:material.getName(),axis,bands,modifiedPrimitives};
}
for(const config of configs.filter(c=>!process.argv[3]||c.id===process.argv[3])){
 const bytes=await fs.readFile(path.join(source,config.file));console.log('Decoding',config.id);
 const doc=await io.readBinary(bytes);const rawStats=meshStats(doc);const originalTextures=[...doc.getRoot().listTextures()];const originalMeshes=[...doc.getRoot().listMeshes()];
 for(const entry of config.exclude){const node=doc.getRoot().listNodes().find(n=>n.getName()===entry.name);if(!node)throw new Error('Missing audited exclusion '+entry.name);node.dispose();}
 // The supplied old alternate logo (image 142) is unreachable. Pruning removes it and other unused export data.
 await doc.transform(prune({keepLeaves:false}));
 if(config.id==='wall'){
  // Keep the actual body and inset face geometry; branding is an independent runtime object.
  for(const mat of doc.getRoot().listMaterials())if(mat.getName()==='CorporateSignFace')mat.setBaseColorTexture(null).setBaseColorFactor([1,1,1,1]);
 }
 const brandingRepairs=[];
 if(config.id==='steel'){
  // The supplied company footer starts below a thin surviving strip of the old
  // footer. Replace the full old strip, including its filtered edges, with a
  // solid material in UV space. Keep all pictograms and the new company text.
  const srgbToLinear=value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4;
  brandingRepairs.push(replaceSignBands(doc,originalTextures[0],null,1,[[390/455,419/455]],{name:'CR24_Neutral_Safety_Footer_Band',color:[0,srgbToLinear(76/255),srgbToLinear(152/255),1]}));
 }
 if(config.id==='camp'){
  const logoNode=doc.getRoot().listNodes().find(n=>n.getName()==='Logo_中铁二十四局_1');
  const texture=logoNode?.getMesh()?.listPrimitives().map(p=>p.getMaterial()?.getBaseColorTexture()).find(Boolean);
  if(!texture?.getImage())throw new Error('Supplied corporate logo is missing');
  if(!originalTextures[136]?.getImage())throw new Error('Supplied pending-project site plan template is missing');
  let projectDrawingReplacements=0;
  for(const mat of doc.getRoot().listMaterials()){
   if(mat.getBaseColorTexture()===originalTextures[3])mat.setBaseColorTexture(texture);
   if(mat.getBaseColorTexture()===originalTextures[25])mat.setBaseColorTexture(texture); // Do not inherit former-company honours as CR24 facts.
   if(mat.getBaseColorTexture()===originalTextures[134]){mat.setBaseColorTexture(originalTextures[136]);projectDrawingReplacements++;}
  }
  if(!projectDrawingReplacements)throw new Error('Audited former-project rendering is not referenced');
  brandingRepairs.push({name:'Replace former-project stadium rendering with supplied pending-project site plan template',sourceTexture:134,replacementTexture:136,materials:projectDrawingReplacements});
  brandingRepairs.push(replaceSignBands(doc,originalTextures[5],texture,1,[[0,0.22]]));
  brandingRepairs.push(replaceSignBands(doc,originalTextures[26],texture,0,[[0,70/1536],[490/1536,559/1536],[979/1536,1048/1536],[1468/1536,1]]));
  const logoFile='cr24-logo.'+(texture.getMimeType()==='image/png'?'png':'jpg');
  await fs.writeFile(path.join(out,logoFile),texture.getImage());
  manifest.logo={url:'models/temporary-works/'+logoFile,bytes:texture.getImage().byteLength,sha256:sha(texture.getImage())};
 }
 const materialRepairs=[];
 for(const mesh of doc.getRoot().listMeshes())for(const prim of mesh.listPrimitives()){
  const mat=prim.getMaterial();if(!prim.getAttribute('TEXCOORD_0')&&mat?.getBaseColorTexture()){
   prim.setMaterial(mat.clone().setName(mat.getName()+'_NoUV').setBaseColorTexture(null));
   materialRepairs.push({mesh:mesh.getName(),reason:'Source primitive had textured material without TEXCOORD_0; preserve geometry and use its original baseColorFactor.'});
  }
 }
 const audit=geometryAudit(doc,config.baseNodes);console.log('Bounds',config.id,audit.bounds,'floor',audit.floor,'footprint',audit.outer);
 const anchor=[(Math.min(...audit.outer.map(p=>p[0]))+Math.max(...audit.outer.map(p=>p[0])))/2,audit.floor,(Math.min(...audit.outer.map(p=>p[1]))+Math.max(...audit.outer.map(p=>p[1])))/2];
 // Engineering LOD: detailed plants and small accessories below 2m dominate the source (52.6M rendered triangles).
 const simplified=[];
 if(config.id==='camp'){
  await doc.transform(weld());
  for(const mesh of doc.getRoot().listMeshes()){
   const sourceMesh=originalMeshes.indexOf(mesh);
   const nodeRecords=audit.nodeBounds.filter(n=>n.mesh===mesh.getName());
   const maxWorldSize=Math.max(0,...nodeRecords.map(n=>Math.max(...n.max.map((v,i)=>v-n.min[i]))));
   const vegetation=sourceMesh>=405&&sourceMesh<=462;
   const smallAccessory=maxWorldSize>0&&maxWorldSize<2.0;
   for(const prim of mesh.listPrimitives()){
    const before=(prim.getIndices()?.getCount()??0)/3;
    if(before<500||(!vegetation&&!smallAccessory))continue;
    const ratio=vegetation?0.008:0.01,error=vegetation?0.02:Math.min(0.12,0.008/maxWorldSize);
    simplifyPrimitive(prim,{simplifier:MeshoptSimplifier,ratio,error,lockBorder:false});
    let after=(prim.getIndices()?.getCount()??0)/3,method='topology-preserving';
    if(after>Math.max(64,before*ratio*2)){
     const indices=Uint32Array.from(prim.getIndices().getArray());
     const [reduced,actualError]=MeshoptSimplifier.simplifySloppy(indices,prim.getAttribute('POSITION').getArray(),3,null,Math.max(24,Math.floor(before*ratio)*3),error);
     if(reduced.length>=24&&reduced.length<indices.length){prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(reduced));compactPrimitive(prim);method='bounded vertex clustering';after=reduced.length/3;}
    }
    simplified.push({mesh:mesh.getName(),sourceMesh,category:vegetation?'vegetation':'small accessory below 2m',maxWorldSize,before,after,maxRelativeError:error,method});
   }
  }
 }
 await doc.transform(dedup(),prune(),instance({min:3}));
 if(config.id==='camp')await doc.transform(flatten(),join({filter:node=>!node.getExtension('EXT_mesh_gpu_instancing')}));
 await doc.transform(textureCompress({encoder:sharp,targetFormat:'webp',quality:90}),draco({method:'edgebreaker',encodeSpeed:5,decodeSpeed:5,quantizePosition:16,quantizeNormal:12,quantizeTexcoord:14}));
 // Extents and bottom datum are measured from decoded, filtered source before lossy compression.
 const result=await io.writeBinary(doc);await fs.writeFile(path.join(out,config.id+'.glb'),result);
 // Compression can remove degenerate triangles. The manifest describes the
 // actual deployed bytes, so count the final decoded geometry and instances.
 const stats=meshStats(await io.readBinary(result));
 const asset={id:config.id,name:config.name,url:'models/temporary-works/'+config.id+'.glb',upAxis:'Y',bounds:audit.bounds,anchor,dimensions:{length:audit.bounds.max[0]-audit.bounds.min[0],width:audit.bounds.max[2]-audit.bounds.min[2],height:audit.bounds.max[1]-audit.bounds.min[1]},footprints:[{outer:audit.outer,holes:[]}],sourceSha256:sha(bytes),sha256:sha(result),sourceFile:config.file,bytes:result.byteLength,sourceBytes:bytes.byteLength,baseHeight:audit.floor,baseDescription:config.id==='camp'?'主场坪底板真实四角（源节点3073），包含整套项目部建筑和院内实体地坪；非场景包围盒。':config.id==='steel'?'厂房围护底部顶点闭合外轮廓（源3DGeom-58/375），排除屋顶挑檐及宣传附件。':'独立宣传墙主体底面四角；正面标识板厚度另计。',verification:{geometry:'Decoded reachable geometry in metres, cumulative node transforms applied; explicit isolated helpers excluded.',dimensions:'Model geometry dimensions, not survey-certified construction dimensions. Set target dimensions from site/design drawings.',footprint:'Convex structural base outline; audited selected base is convex and has no holes.',brand:'Reachable former-contractor logo texture 3 replaced with supplied CRCC logo; mixed former-contractor header/strip textures 5/26 replaced in UV-separated logo primitives, old-company honours texture 25 replaced by supplied logo; remaining safety pictograms, national flag and generic content retained. Independent wall face uses configurable runtime branding.'},excludedNodes:config.exclude,performance:{...stats,simplifiedPrimitives:simplified.length},editableBranding:config.id==='wall'};
 asset.verification.brand=config.id==='steel'?'Supplied CR24 company slogans and safety pictograms retained; former footer remnants hidden by a UV-separated solid band, without editing the source texture.':config.id==='wall'?'Original wall body retained; independent runtime text and logo provide editable branding.':'Former contractor logos and honours replaced; mixed logo bands split in UV space. Former-project stadium rendering replaced with the supplied site-plan template marked pending project information. Generic safety content and national flag retained.';
 asset.verification.performance='Counts from final decoded GLB bytes, including GPU instances.';
 manifest.assets=manifest.assets.filter(a=>a.id!==config.id);manifest.assets.push(asset);const oldAudit=audits.findIndex(a=>a.id===config.id);if(oldAudit>=0)audits.splice(oldAudit,1);audits.push({id:config.id,sourceStats:rawStats,outputStats:stats,sourceBytes:bytes.byteLength,outputBytes:result.byteLength,sourceSha256:asset.sourceSha256,outputSha256:asset.sha256,excludedNodes:config.exclude,simplified,baseNodes:config.baseNodes,baseBottomVertices:audit.outer,bounds:audit.bounds,anchor,units:'metres',materialRepairs,brandingRepairs,sourceBrandingExtras:doc.getRoot().getAsset().extras??null});
 console.log('Written',config.id,result.byteLength,stats);
}

await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
await fs.writeFile(path.join(reports,'assets-audit.json'),JSON.stringify(audits,null,2)+'\n');
