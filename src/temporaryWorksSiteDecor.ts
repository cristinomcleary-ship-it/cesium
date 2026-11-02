import type { FacilityKind } from './temporaryWorksArchitecture';
import { flagPlatformGeometry, parkedCarGeometry, YardMesh, type CourtyardBatch } from './temporaryWorksCourtyard';

type SiteRole = 'fence' | 'entry' | 'flag' | 'parking' | 'vehicles' | 'gate' | 'stock' | 'equipment' | 'lighting';
export type SiteDecoration = CourtyardBatch & {role: SiteRole};

const parkingRow = {left:-2.65, bay:2.6, south:-13.55, depth:5.2};

function boxFor(mesh: YardMesh) {
  return (x:number, y:number, z:number, length:number, width:number, height:number, color:string) =>
    mesh.box(color,x,y,z,length,width,height,true);
}

function tube(mesh:YardMesh, axis:'x'|'y'|'z', x:number,y:number,z:number,
  bottom:number,top:number,length:number,segments:number,color:string) {
  mesh.cylinder(color,(angle,upper) => {
    const r=upper?top:bottom, at=(upper ? 0.5 : -0.5)*length;
    const a=r*Math.cos(angle), b=r*Math.sin(angle);
    if (axis==='x') return [x+at,y+a,z+b];
    if (axis==='y') return [x+b,y+at,z+a];
    return [x+a,y+b,z+at];
  },segments);
}

function perimeter(mesh: YardMesh) {
  const box = boxFor(mesh);
  const fence=(x:number,y:number,l:number,w:number)=>{
    box(x,y,0,l,w,.27,'#8f9898');
    box(x,y,.27,l*.997,w*.997,1.15,'#9eaeb0');
    box(x,y,1.42,l,w,.07,'#748b91');
    const n=Math.ceil(Math.max(l,w)/2.7);
    for(let i=0;i<=n;i++)box(x+(l>w?l*(i/n-.5):0),y+(w>l?w*(i/n-.5):0),0,.12,.12,1.5,'#72848a');
  };
  fence(0,14.5,47,.17);fence(-23.5,0,.17,29);fence(23.5,0,.17,29);
  fence(-17.5,-14.5,12,.17);fence(11.2,-14.5,24.6,.17);
}

function officeEntry(mesh: YardMesh) {
  const box = boxFor(mesh);
  box(-5,3.9,.025,29.4,1.55,.10,'#dbd8ca');
  // Office entrance, external access balcony and stair.
  box(-5,3.3,2.67,4.4,2.9,.18,'#748e94');
  for(const x of [-6.85,-3.15])box(x,2.09,0,.13,.13,2.67,'#556d75');
  for(let j=0;j<3;j++)box(-5,2.97+j*.32,.02,3.7,1.2-j*.32,.12+j*.115,'#b8b4a8');
  box(-5,3.98,2.98,29.3,1.7,.19,'#aab7b4');
  for(const x of [-19,-15.5,-12,-8.5,-5,-1.5,2,5.5,9]){
    box(x,3.22,.11,.105,.105,3.02,'#89999a');
    box(x,3.22,3.17,.075,.075,.93,'#93a5a4');
  }
  for(const z of [3.42,3.71,4.09])box(-5,3.22,z,28.04,.055,.065,'#839897');
  const rise=3.13/17;
  for(let i=0;i<17;i++)box(9.13-i*.275,1.97,0,.285,1.45,rise*(i+1),'#9da7a7');
  for(const y of [1.26,2.69]){
    for(let i=0;i<17;i+=4)box(9.13-i*.275,y,rise*(i+1),.065,.065,.91,'#8d9f9f');
    const rail = new YardMesh();
    rail.box('#8d9f9f',0,0,-.0375,5.3,.065,.075,true);
    const pitch = -Math.atan2(rise,.275);
    for (const part of rail.result()) {
      for (let i=0;i<part.positions.length;i+=3) {
        const x=part.positions[i], z=part.positions[i+2];
        part.positions[i]=x*Math.cos(pitch)-z*Math.sin(pitch);
        part.positions[i+2]=x*Math.sin(pitch)+z*Math.cos(pitch);
      }
      mesh.append(part,6.93,y,2.49+.0375);
    }
  }
  box(4.62,2.75,2.98,.95,1.6,.2,'#aab7b4');
}

function flagSquare(mesh: YardMesh) {
  const box = boxFor(mesh);
  // The flag square is offset from both the front entrance and the gate-to-parking aisle.
  box(-14.65,-1.37,.003,7.65,4.84,.056,'#a9acad');
  for(const b of flagPlatformGeometry())mesh.append(b,-14.65,-1.37,.059);
}

function parkingArea(mesh: YardMesh) {
  const box = boxFor(mesh);
  // The gate leaves a clear route into the 5.8 m manoeuvring aisle north of the bays.
  const {left,bay,south,depth}=parkingRow;
  box(left+2.5*bay,south+depth/2,.003,5*bay+.22,depth+.28,.018,'#858f93');
  for(let i=0;i<=5;i++)box(left+i*bay,south+depth/2,.022,.09,depth,.012,'#edf0e6');
  box(left+2.5*bay,south,.022,5*bay,.09,.012,'#edf0e6');
  for(let i=0;i<5;i++){
    const x=left+(i+.5)*bay;
    for(const offset of [-.58,.58])box(x+offset,south+.53,.022,.52,.14,.11,'#d9b963');
  }
  // The parking marker sits at the row's corner; both the driveway and the first stall stay clear.
  const signX=left-.38, signY=south+.46;
  box(signX,signY,.02,.08,.08,2.03,'#9ca9ac');
  box(signX,signY,1.62,.85,.055,.87,'#e8ece4');
  box(signX,signY-.031,1.655,.78,.02,.80,'#315a74');
  for(const [dx,z,w,h] of [[-.14,1.74,.095,.58],[.018,2.22,.37,.09],[.16,2.01,.085,.23],[.01,1.98,.37,.087]])
    box(signX+dx,signY-.046,z,w,.014,h,'#f1f2e6');
}

function cars(mesh: YardMesh) {
  const {left,bay,south,depth}=parkingRow;
  for (const [bayIndex,color] of [[0,'#567387'],[2,'#d0d2cc'],[4,'#727b78']] as const) {
    for(const b of parkedCarGeometry(color))mesh.append(b,left+(bayIndex+.5)*bay,south+depth/2,.034);
  }
}

function slidingGate(mesh: YardMesh) {
  const box = boxFor(mesh);
  // The workshop and the reference yard are both enclosed. The two closed
  // sliding leaves meet on the same entrance line as the south fence.
  const gateY=-14.5, gateLeft=-11.5, gateRight=-1.1, gateMiddle=(gateLeft+gateRight)/2;
  for(const end of [gateLeft,gateRight])box(end,gateY,0,.30,.30,1.93,'#536875');
  box(gateMiddle,gateY,.012,gateRight-gateLeft+1.1,.18,.05,'#7c888b');
  for(const [lo,hi] of [[gateLeft+.12,gateMiddle],[gateMiddle,gateRight-.12]]) {
    const width=hi-lo, center=(lo+hi)/2;
    box(center,gateY,.15,width,.105,.63,'#617987');
    for(const z of [.10,.77,1.68])box(center,gateY,z,width,.13,.085,'#445e6f');
    const posts=25;
    for(let j=0;j<=posts;j++)box(lo+width*j/posts,gateY,.80,.052,.075,.90,'#526d7d');
    for(const wheel of [lo+.24,hi-.24])box(wheel,gateY,.045,.15,.12,.08,'#4b5360');
  }
}

function steelStock(mesh: YardMesh) {
  const box = boxFor(mesh);
  for(const [x,y,l] of [[-11,-8,13],[5,-8,12],[-8,.7,11],[5,.8,9]]){
    for(const d of [-.32,.32])box(x+l*d,y,.02,.38,1.8,.42,'#9a9e99');
    for(let j=0;j<9;j++){
      tube(mesh,'x',x,y+(j-4)*.18,.56+((j%3===0)?.08:0),.105,.105,l,8,'#635d54');
    }
  }
  for(const x of [-9.5,3.8]){
    box(x,-10.75,.05,5.7,1.7,.19,'#8f9390');
    for(let i=0;i<12;i++){
      tube(mesh,'x',x,-10.75+(i%5-2)*.28,.40+Math.floor(i/5)*.235,.14,.14,5.5,8,'#60564e');
    }
  }
}

function workshopEquipment(mesh: YardMesh) {
  const box = boxFor(mesh);
  // A material feed table and an example bending station make the operations legible at eye level.
  for(const [x,y] of [[8.7,3.1],[8.7,7.7]]){
    box(x,y,.1,3.15,1.5,.69,'#4d7877');box(x,y,.79,3.3,1.67,.13,'#607077');
    tube(mesh,'z',x-.59,y,.99,.43,.43,.15,20,'#9b9a88');
    for(const d of [-.19,.2])tube(mesh,'z',x-.59+d,y,1.12,.09,.08,.18,8,'#59676c');
    box(x+.97,y,.94,.75,.68,.23,'#dbad54');
  }
  for(const [x,y] of [[3.3,3.1],[3.3,7.7]]){
    for(const d of [-2.45,2.45])for(const t of [-.49,.49])box(x+d,y+t,.02,.15,.15,.83,'#5b7978');
    for(const t of [-.52,.52])box(x,y+t,.79,5.43,.12,.16,'#c8a55f');
    for(let i=0;i<10;i++){
      tube(mesh,'y',x-2.37+i*.52,y,.94,.105,.105,1.07,9,'#9d9e96');
    }
  }
  for(const x of [-18.7,14.7]){box(x,4.5,.025,.09,16,.018,'#d5b45e');}
  for(const x of [-17,15])box(x,11.8,0,.5,.5,.64,'#dcb753');
}

function lighting(mesh: YardMesh) {
  const box = boxFor(mesh);
  for(let i=0;i<2;i++){
    const x=i?20.7:-21;
    box(x,12,.02,.27,.27,5.2,'#848f91');box(x-.25,12,5.2,.73,.27,.09,'#56656a');
  }
}

/** Canonical 48 × 30 m compound, in metres with Z up. Buildings and the surveyed pad are added separately. */
export function buildStandardSiteDecor(kind: FacilityKind, campYard: boolean): SiteDecoration[] {
  const result: SiteDecoration[] = [];
  function add(role: SiteRole, draw: (mesh: YardMesh) => void) {
    const mesh = new YardMesh();
    draw(mesh);
    for (const batch of mesh.result()) result.push({...batch,role});
  }
  add('fence',perimeter);
  if (kind==='camp') {
    add('entry',officeEntry);
    if (campYard) {
      add('flag',flagSquare);
      add('parking',parkingArea);
      add('vehicles',cars);
    }
  } else {
    add('gate',slidingGate);
    add('stock',steelStock);
    add('equipment',workshopEquipment);
  }
  add('lighting',lighting);
  return result;
}
