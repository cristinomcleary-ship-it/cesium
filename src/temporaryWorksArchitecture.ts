import { steelWorkshopWalls } from './temporaryWorksSteelWalls';
import { companySignGeometry } from './temporaryWorksCompanySign';

// Display geometry only. Every roof and facade comes from the measured, clipped footprint.
export type FacilityKind = 'camp' | 'steel';
export type XYZ = [number,number,number];
export type XY = [number,number];
export type Finish = 'roof' | 'seam' | 'lining' | 'wall' | 'skirting' | 'trim' | 'glass' | 'door' | 'frame' | 'concrete' | 'bar' | 'cladding' | 'shutter' | 'panelRib' | 'steelBand' | 'signFace' | 'signLetter' | 'signEdge';
export const finishes: Record<Finish,string> = {
  roof:'#63869a', seam:'#91a5a9', lining:'#c2cbca', wall:'#e3e5df', skirting:'#677a81', trim:'#b1c2c6', glass:'#456875',
  signFace:'#ae2026', signLetter:'#fff7de', signEdge:'#725443',
  cladding:'#c5d1d3', shutter:'#899ea8', panelRib:'#a6b8c0', steelBand:'#516b80',
  door:'#b98957', frame:'#536875', concrete:'#b4b1a9', bar:'#534b43',
};
export type DisplayBatch = { finish:Finish; positions:number[]; uv:number[]; indices:number[] };
type Vertex = {x:number; y:number; z:number};
export type FacilitySurface = { vertices:Vertex[]; triangles:readonly (readonly number[])[]; outline:XY[]; height:number; showCompanySign?:boolean };

/** All geometry uses metres. Batch by finish, not by frame, column or window. */
export function facilityGeometry(kind:FacilityKind, input:FacilitySurface):DisplayBatch[] {
  const {outline,triangles,height}=input;
  if (!triangles.length || outline.length<3) return [];
  const batches = new Map<Finish,DisplayBatch>();
  function polygon(finish:Finish, p:XYZ[], tex?:XY[]) {
    if(p.length<3)return;
    let b=batches.get(finish);
    if(!b){b={finish,positions:[],uv:[],indices:[]};batches.set(finish,b);}
    const start=b.positions.length/3;
    p.forEach(([x,y,z],i)=>{b.positions.push(x,y,z);b.uv.push(...(tex?.[i]??[x,y]));});
    for(let i=1;i+1<p.length;i++)b.indices.push(start,start+i,start+i+1);
  }
  const edges=outline.map(([x,y],i)=>{
    const [bx,by]=outline[(i+1)%outline.length], len=Math.hypot(bx-x,by-y);
    return {x,y,bx,by,len,ux:(bx-x)/len,uy:(by-y)/len};
  }).filter(e=>e.len>1e-6);
  if (!edges.length) return [];
  const axis=edges.reduce((a,b)=>a.len>=b.len?a:b);
  const along=(x:number,y:number)=>(x-axis.x)*axis.ux+(y-axis.y)*axis.uy;
  const across=(x:number,y:number)=>-(x-axis.x)*axis.uy+(y-axis.y)*axis.ux;
  const world=(u:number,v:number,z:number):XYZ=>[axis.x+axis.ux*u-axis.uy*v,axis.y+axis.uy*u+axis.ux*v,z];
  const us=outline.map(([x,y])=>along(x,y)), vs=outline.map(([x,y])=>across(x,y));
  const uMin=Math.min(...us),uMax=Math.max(...us),vMin=Math.min(...vs),vMax=Math.max(...vs),ridge=(vMin+vMax)/2;
  let crest=-Infinity;
  const vertices=input.vertices.map(p=>{
    crest=Math.max(crest,p.z+height);
    return {u:along(p.x,p.y),v:across(p.x,p.y),z:p.z};
  });
  const pitch=Math.min(kind==='steel'?.115:.075, height*.32/Math.max(.01,vMax-vMin));
  const eave=(v:number)=>crest-Math.abs(v-ridge)*pitch;
  const skin=Math.min(height*.045,kind==='steel'?.13:.15);
  const exterior=new Map<string,[number,number]>();
  const spans:{a:number;b:number;za:number;zb:number}[][]=[];
  // Portal frame stations are kept inside the clipped roof; each missing interval breaks the frame.
  const posts=kind==='steel'?Math.min(120,Math.max(1,Math.ceil((uMax-uMin)/6))):0;
  const stations=posts ? Array.from({length:posts+1},(_,i)=>uMin+.24+(uMax-uMin-.48)*i/posts) : [];
  for(const _ of stations) spans.push([]);
  for(const t of triangles){
    const face=t.map(i=>vertices[i]);
    const min=Math.min(...face.map(p=>p.v)), max=Math.max(...face.map(p=>p.v));
    function roof(poly:typeof face) {
      const top=poly.map(p=>world(p.u,p.v,eave(p.v)));
      polygon('roof',top,poly.map(p=>[p.u,p.v]));
      if(kind==='steel')polygon('lining',top.map(([x,y,z]):XYZ=>[x,y,z-skin]).reverse());
      function strip(axis:'u'|'v', lo:number, hi:number, lift:number) {
        let patch=poly;
        for(const [at,sign] of [[lo,1],[hi,-1]]){
          const part:typeof face=[];
          patch.forEach((a,i)=>{
            const b=patch[(i+1)%patch.length],da=(a[axis]-at)*sign,db=(b[axis]-at)*sign;
            if(da>=0)part.push(a);
            if((da<0 && db>0)||(da>0 && db<0)){
              const f=da/(da-db);
              part.push({u:a.u+(b.u-a.u)*f,v:a.v+(b.v-a.v)*f,z:0});
            }
          });
          patch=part;if(patch.length<3)return;
        }
        polygon('seam',patch.map(p=>world(p.u,p.v,eave(p.v)+lift)));
      }
      const first=Math.min(...poly.map(p=>p.u)),last=Math.max(...poly.map(p=>p.u));
      const period=Math.max(.92,(uMax-uMin)/180),width=Math.min(period*.09,.08);
      for(let i=Math.floor((first-uMin)/period);uMin+i*period<=last;i++){
        const at=uMin+i*period;
        strip('u',at,at+width,.014);
      }
      strip('v',ridge-.11,ridge+.11,.025);

    }
    if(min<ridge && max>ridge) {
      const sides:[typeof face,typeof face]=[[],[]];
      face.forEach((p,i)=>{
        const q=face[(i+1)%3];
        if(p.v<=ridge)sides[0].push(p);
        if(p.v>=ridge)sides[1].push(p);
        if((p.v-ridge)*(q.v-ridge)<0) {
          const f=(ridge-p.v)/(q.v-p.v);
          const mid={u:p.u+(q.u-p.u)*f,v:ridge,z:p.z+(q.z-p.z)*f};
          sides[0].push(mid);sides[1].push(mid);
        }
      });
      sides.forEach(roof);
    } else roof(face);
    for(let i=0;i<3;i++){
      const a=t[i],b=t[(i+1)%3],key=a<b?a+'/'+b:b+'/'+a;
      if(!exterior.delete(key))exterior.set(key,[a,b]);
    }
    if (kind!=='steel')continue;
    const ulo=Math.min(...face.map(p=>p.u)),uhi=Math.max(...face.map(p=>p.u));
    for(let i=0;i<stations.length;i++) {
      const s=stations[i];
      if(s<ulo || s>=uhi)continue;
      const hits:{v:number;z:number}[]=[];
      face.forEach((p,j)=>{
        const q=face[(j+1)%3];
        if((p.u<=s)===(q.u<=s))return;
        const f=(s-p.u)/(q.u-p.u);
        hits.push({v:p.v+f*(q.v-p.v),z:p.z+f*(q.z-p.z)});
      });
      if(hits.length===2){
        hits.sort((a,b)=>a.v-b.v);
        spans[i].push({a:hits[0].v,b:hits[1].v,za:hits[0].z,zb:hits[1].z});
      }
    }
  }
  if(kind==='steel') {
    steelWorkshopWalls(input,exterior.values(),axis,across,ridge,eave,skin,polygon);
  }
  // Divide the clipped wall into opaque panels, frames and glazing with no coincident decal polygons.
  if(kind==='camp') for(const [ai,bi] of exterior.values()){
    const a=input.vertices[ai],b=input.vertices[bi],va=vertices[ai].v,vb=vertices[bi].v;
    const original=edges.find(e=>{
      const on=(p:Vertex)=>Math.abs((p.x-e.x)*e.uy-(p.y-e.y)*e.ux)<.0002 &&
        (p.x-e.x)*e.ux+(p.y-e.y)*e.uy>=-.0002 && (p.x-e.bx)*e.ux+(p.y-e.by)*e.uy<=.0002;
      return on(a)&&on(b);
    });
    const starts=[0,1];
    if ((va-ridge)*(vb-ridge)<0) starts.push((ridge-va)/(vb-va));
    let ua=0,ub=1, bay=3;
    if(original && original.len>=2.0 && height>1.7){
      ua=(a.x-original.x)*original.ux+(a.y-original.y)*original.uy;
      ub=(b.x-original.x)*original.ux+(b.y-original.y)*original.uy;
      bay=original.len/Math.min(160,Math.max(1,Math.round(original.len/3.2)));
      const lo=Math.min(ua,ub),hi=Math.max(ua,ub);
      for(let j=Math.floor(lo/bay);j<=Math.floor(hi/bay);j++)for(const x of [.025,.19,.225,.49,.515,.775,.81,.975]){
        const pos=bay*(j+x);
        if(pos>lo+1e-7 && pos<hi-1e-7)starts.push((pos-ua)/(ub-ua));
      }
    }
    starts.sort((a,b)=>a-b);
    const point=(t:number,f:number):XYZ=>{
      const floor=a.z+(b.z-a.z)*t, roof=eave(va+(vb-va)*t);
      return [a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,floor+f*(roof-floor)];
    };
    const floors=Math.min(8,Math.max(1,Math.round(height/3.15)));
    for(let i=1;i<starts.length;i++){
      const l=starts[i-1],r=starts[i]; if(r-l<1e-10)continue;
      const tl=point(l,1),tr=point(r,1);
      polygon('seam',[tl,tr,[tr[0],tr[1],tr[2]+.035],[tl[0],tl[1],tl[2]+.035]]);
      const module=(ua+(ub-ua)*(l+r)/2)/bay;
      const phase=module-Math.floor(module);
      for(let floor=0;floor<floors;floor++){
        const zones=[0,.065,.30,.335,.76,.795,.94,1];
        for(let j=1;j<zones.length;j++){
          const h=(zones[j]+zones[j-1])*.5;
          let finish:Finish='wall';
          if(h<.065)finish='skirting';
          if(h>.94 || (original && (phase<.025 || phase>.975)))finish='trim';
          if(original && original.len>=2 && height>1.7 && phase>.19 && phase<.81) {
            const door=floor===0 && original.len>=axis.len*.87 && Math.floor(module)===Math.floor(original.len/bay/2);
            if((door || h>.30) && h<.795) {
              finish=phase<.225 || phase>.775 || h>.76 || (!door && h<.335) ? 'trim' :
                door ? (h>.335 && h<.76?'glass':'door') : phase>.49 && phase<.515 ? 'trim' : 'glass';
            }
          }
          polygon(finish,[point(l,(floor+zones[j-1])/floors),point(r,(floor+zones[j-1])/floors),
            point(r,(floor+zones[j])/floors),point(l,(floor+zones[j])/floors)]);
        }
      }
    }
  }
  // The covered interior retains the structural portal frames.
  function beam(u:number, v1:number,z1:number,v2:number,z2:number, depth:number, width:number) {
    const len=Math.hypot(v2-v1,z2-z1);
    if(len<1e-5)return;
    const dv=(z2-z1)/len*depth/2,dz=-(v2-v1)/len*depth/2;
    const cap=(v:number,z:number)=>[world(u-width/2,v-dv,z-dz),world(u+width/2,v-dv,z-dz),
      world(u+width/2,v+dv,z+dz),world(u-width/2,v+dv,z+dz)];
    const a=cap(v1,z1),b=cap(v2,z2);
    polygon('frame',a);polygon('frame',b.slice().reverse());
    for(let j=0;j<4;j++)polygon('frame',[a[j],a[(j+1)%4],b[(j+1)%4],b[j]]);
  }
  spans.forEach((segments,i)=>{
    segments.sort((a,b)=>a.a-b.a);
    const sections:typeof segments=[];
    for(const p of segments){
      const prev=sections.at(-1);
      if(prev && p.a<=prev.b+.00001){if(p.b>prev.b){prev.b=p.b;prev.zb=p.zb;}}
      else sections.push({...p});
    }
    for(const s of sections){
      const width=s.b-s.a;
      if(width<1 || height<.95 || uMax-uMin<1)continue;
      const u=stations[i], size=Math.min(.20,width/20,height/15);
      const l=s.a+size,r=s.b-size;
      const floor=(v:number)=>s.za+(s.zb-s.za)*(v-s.a)/width;
      // A complete portal requires a narrow unbroken support strip. Reject a
      // station if a concave CAD edge or a hole enters the finite beam width.
      const coveredStrip=[u-size*.51,u+size*.51,l-size*.51,r+size*.51];
      const crosses=[...exterior.values()].some(([i,j])=>{
        const a=vertices[i],b=vertices[j];
        let lo=0,hi=1;
        for(const [p,d,min,max] of [[a.u,b.u-a.u,coveredStrip[0],coveredStrip[1]],
          [a.v,b.v-a.v,coveredStrip[2],coveredStrip[3]]]){
          if(Math.abs(d)<1e-12){if(p<min || p>max)return false;}
          else {const t=(min-p)/d,w=(max-p)/d;lo=Math.max(lo,Math.min(t,w));hi=Math.min(hi,Math.max(t,w));}
        }
        return lo<=hi;
      });
      if(crosses)continue;
      const head=(v:number)=>eave(v)-skin-size*.6;
      const tie=Math.min(head(l),head(r))-Math.min(.7,height*.12);
      beam(u,l,floor(l),l,head(l),size,size);
      beam(u,r,floor(r),r,head(r),size,size);
      const top=[l,...(l<ridge && r>ridge ? [ridge]:[]),r];
      for(let j=1;j<top.length;j++)beam(u,top[j-1],head(top[j-1]),top[j],head(top[j]),size,size);
      beam(u,l,tie,r,tie,size*.52,size*.65);
      const bays=Math.min(22,Math.max(2,Math.ceil(width/2.35)));
      for(let j=0;j<bays;j++){
        const v1=l+(r-l)*j/bays,v2=l+(r-l)*(j+1)/bays;
        beam(u,v1,j%2?head(v1):tie,v2,j%2?tie:head(v2),size*.43,size*.47);
      }
    }
  });
  return [...batches.values(), ...(input.showCompanySign===false ? [] : companySignGeometry(kind,input,exterior.values(),(x,y)=>eave(across(x,y))))];
}
