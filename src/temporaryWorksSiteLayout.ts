import type { FacilityKind, XY } from './temporaryWorksArchitecture';
import { yardSurface } from './temporaryWorksYard';

type SiteRole = 'office'|'dormitory'|'gatehouse'|'workshop';
type StandardBuilding = {
  role:SiteRole; x:number; y:number; length:number; width:number; height:number; showCompanySign:boolean;
};
type Vertex = {x:number; y:number; z:number};
type Bounds = {left:number; right:number; bottom:number; top:number};
export const standardSiteSize = {length:48,width:30,minScale:.65} as const;
export const standardSiteBuildings:Record<FacilityKind,StandardBuilding[]> = {
  camp:[
    {role:'office',x:-5,y:8.1,length:29,width:6.3,height:6.25,showCompanySign:true},
    {role:'dormitory',x:14,y:0,length:6.2,width:17,height:3.25,showCompanySign:false},
    {role:'gatehouse',x:-15.4,y:-9.8,length:6.9,width:4.2,height:3.15,showCompanySign:false},
  ],
  steel:[{role:'workshop',x:-2,y:4.5,length:32,width:15,height:6.5,showCompanySign:true}],
};
export type StandardSiteLayout = {
  center:XY; axis:XY; scale:number;
  buildings:{role:SiteRole; outline:XY[]; height:number; showCompanySign:boolean}[];
  toLocal:(canonicalX:number, canonicalY:number)=>XY;
  altitude:(projectX:number, projectY:number)=>number;
};

const emptyBounds = ():Bounds => ({left:Infinity,right:-Infinity,bottom:Infinity,top:-Infinity});
function include(b:Bounds,x:number,y:number) {
  b.left=Math.min(b.left,x);b.right=Math.max(b.right,x);
  b.bottom=Math.min(b.bottom,y);b.top=Math.max(b.top,y);
}

// Search the connected portions of the retained slab separately. A large, distant
// island must not determine the placement grid for a smaller buildable component.
function meshComponents(vertices:readonly Vertex[],triangles:readonly (readonly number[])[]) {
  const parent = new Int32Array(vertices.length).fill(-1);
  function root(i:number):number {
    while(parent[i]>=0){if(parent[parent[i]]>=0)parent[i]=parent[parent[i]];i=parent[i];}
    return i;
  }
  function join(a:number,b:number) {
    const i=root(a),j=root(b);
    if(i===j)return;
    if(parent[i]>parent[j]){parent[j]+=parent[i];parent[i]=j;}
    else {parent[i]+=parent[j];parent[j]=i;}
  }
  const byPosition=new Map<string,number>(),used=new Set<number>();
  for(const face of triangles) {
    for(const i of face){
      if (!used.has(i)) {
        const p=vertices[i],key=Math.round(p.x*1e6)+','+Math.round(p.y*1e6);
        const other=byPosition.get(key);
        if(other!==undefined)join(i,other); else byPosition.set(key,i);
        used.add(i);
      }
    }
    join(face[0],face[1]);join(face[1],face[2]);
  }
  const groups=new Map<number,number[]>();
  for(const i of used){const r=root(i);let g=groups.get(r);if(!g){g=[];groups.set(r,g);}g.push(i);}
  return [...groups.values()];
}

function orientationAxes(boundary:readonly XY[]):XY[] {
  // Long CAD sides provide the compound direction. Keep distinct alternatives for
  // irregular boundaries, and try the perpendicular where the site's short side dominates.
  const directions=new Map<number,{angle:number;length:number;sum:number}>();
  for(let i=0;i<boundary.length;i++){
    const a=boundary[i], b=boundary[(i+1)%boundary.length], dx=b[0]-a[0],dy=b[1]-a[1];
    const length=Math.hypot(dx,dy);
    if(length<1e-6)continue;
    const angle=((Math.atan2(dy,dx)%Math.PI)+Math.PI)%Math.PI;
    const key=Math.round(angle*180/Math.PI)%180, entry=directions.get(key);
    if(!entry)directions.set(key,{angle,length,sum:length});
    else {entry.sum+=length;if(length>entry.length){entry.angle=angle;entry.length=length;}}
  }
  const axes:XY[]=[];
  for(const d of [...directions.values()].sort((a,b)=>b.sum-a.sum||a.angle-b.angle).slice(0,8)){
    for(const angle of [d.angle,d.angle+Math.PI/2]){
      let x=Math.cos(angle),y=Math.sin(angle);
      if(x< -1e-9 || Math.abs(x)<=1e-9 && y<0){x=-x;y=-y;}
      if(!axes.some(([u,v])=>Math.abs(x*v-y*u)<1e-6))axes.push([x,y]);
    }
  }
  return axes;
}

function candidateCoords(lo:number,hi:number,preferred:number) {
  const span=hi-lo, steps=Math.min(24,Math.ceil(Math.max(0,span)/1.5));
  const values=new Set([Math.min(hi,Math.max(lo,preferred)),(lo+hi)/2,lo,hi]);
  for(let i=1;i<steps;i++)values.add(lo+span*i/steps);
  return [...values];
}

/** Fit a complete, proportionate reference compound on one supported portion of the real CAD pad. */
export function buildStandardSiteLayout(kind:FacilityKind,boundary:readonly XY[],vertices:readonly Vertex[],
  inputTriangles:readonly (readonly number[])[]): StandardSiteLayout {
  const fail = () => new Error('当前场界和有效摄影覆盖内未找到可完整放置标准'+(kind==='steel'?'钢筋加工场':'项目驻地')+'的连续区域（至少 31.2 × 19.5 米）。请核对场界、模型覆盖和取样间距，或改用 CAD 建筑轮廓布置。');
  if(boundary.length<3 || boundary.some(([x,y])=>!Number.isFinite(x)||!Number.isFinite(y)))throw fail();
  const triangles=inputTriangles.filter(t=>t.length===3 && t.every(i=>Number.isInteger(i) && vertices[i] &&
    Number.isFinite(vertices[i].x) && Number.isFinite(vertices[i].y) && Number.isFinite(vertices[i].z)));
  if(!triangles.length)throw fail();
  const groups=meshComponents(vertices,triangles),origin=boundary[0], {length,width,minScale}=standardSiteSize;
  let best:StandardSiteLayout|undefined;
  for(const axis of orientationAxes(boundary)){
    const [u,v]=axis;
    const rotate=(x:number,y:number):XY=>[(x-origin[0])*u+(y-origin[1])*v,-(x-origin[0])*v+(y-origin[1])*u];
    const unrotate=(x:number,y:number):XY=>[origin[0]+x*u-y*v,origin[1]+x*v+y*u];
    const ring=boundary.map(([x,y])=>rotate(x,y)),cad=emptyBounds();
    for(const [x,y] of ring)include(cad,x,y);
    const projected=vertices.map(p=>{const [x,y]=rotate(p.x,p.y);return {x,y,z:p.z};});
    const extents=groups.map(ids=>{
      const bounds=emptyBounds();
      for(const i of ids)include(bounds,projected[i].x,projected[i].y);
      return {left:Math.max(cad.left,bounds.left),right:Math.min(cad.right,bounds.right),
        bottom:Math.max(cad.bottom,bounds.bottom),top:Math.min(cad.top,bounds.top)};
    });
    const capacity=(b:Bounds)=>Math.min(1,(b.right-b.left)/length,(b.top-b.bottom)/width);
    const lowerBound=best?.scale??minScale, boxes=extents.filter(b=>capacity(b)>=lowerBound-1e-9);
    if(!boxes.length)continue;
    const ground=yardSurface(projected,triangles,[],ring);
    const midX=(cad.left+cad.right)/2, midY=(cad.bottom+cad.top)/2;
    function locate(scale:number):XY|undefined {
      const hx=length*scale/2,hy=width*scale/2, positions:XY[]=[];
      for (const b of boxes) {
        if(capacity(b)<scale-1e-9)continue;
        const xs=candidateCoords(b.left+hx,b.right-hx,midX), ys=candidateCoords(b.bottom+hy,b.top-hy,midY);
        for(const x of xs)for(const y of ys)positions.push([x,y]);
      }
      positions.sort((a,b)=>(a[0]-midX)**2+(a[1]-midY)**2-(b[0]-midX)**2-(b[1]-midY)**2);
      for(const [x,y] of positions) {
        // A shared boundary is permitted. Test the open interior for CAD/mesh edges,
        // then the four actual (unmodified) corners for valid slab support.
        const eps=1e-7;
        if(ground.fits({left:x-hx+eps,right:x+hx-eps,bottom:y-hy+eps,top:y+hy-eps,rotated:false}) &&
          [[x-hx,y-hy],[x-hx,y+hy],[x+hx,y-hy],[x+hx,y+hy]].every(([cx,cy])=>ground.altitude(cx,cy)!==undefined))return [x,y];
      }
    }
    let hi=Math.max(...boxes.map(capacity)),lo=lowerBound;
    if(hi<lo)hi=lo;
    let position=locate(hi),scale=hi;
    if(!position) {
      position=locate(lo);
      if(!position)continue;
      while(hi-lo>0.001) {
        const mid=(lo+hi)/2, fit=locate(mid);
        if(fit){lo=mid;position=fit;} else hi=mid;
      }
      scale=lo;
    }
    if(best && scale<=best.scale+1e-8)continue;
    const [cx,cy]=position,center=unrotate(cx,cy);
    const toLocal=(x:number,y:number):XY=>unrotate(cx+x*scale,cy+y*scale);
    const altitude=(x:number,y:number):number=>{
      const h=ground.altitude(...rotate(x,y));
      if(h===undefined)throw fail();
      return h;
    };
    const buildings=standardSiteBuildings[kind].map(b=>{
      const x=b.x-b.length/2,y=b.y-b.width/2;
      return {role:b.role,height:b.height*scale,showCompanySign:b.showCompanySign,
        outline:[toLocal(x,y),toLocal(x+b.length,y),toLocal(x+b.length,y+b.width),toLocal(x,y+b.width)]};
    });
    best={center,axis,scale,buildings,toLocal,altitude};
    if(scale===1)break;
  }
  if(!best)throw fail();
  return best;
}
