// Local metres, X east, Y north, Z up. The example and project renderer use the same assets.
export type CourtyardBatch = {color: string; positions: number[]; indices: number[]};
type Point = [number, number, number];

export class YardMesh {
  private batches = new Map<string, CourtyardBatch>();

  private forColor(color:string) {
    let batch=this.batches.get(color);
    if (!batch) {
      batch={color,positions:[],indices:[]};
      this.batches.set(color,batch);
    }
    return batch;
  }

  append(part: CourtyardBatch, x: number, y: number, z: number) {
    const batch = this.forColor(part.color);
    const offset = batch.positions.length / 3;
    for (let i = 0; i < part.positions.length; i += 3)
      batch.positions.push(part.positions[i] + x, part.positions[i + 1] + y, part.positions[i + 2] + z);
    for (const index of part.indices) batch.indices.push(offset + index);
  }

  face(color:string, points:Point[]) {
    const batch = this.forColor(color);
    const base=batch.positions.length/3;
    for (const p of points) batch.positions.push(...p);
    for (let i=1; i<points.length-1; i++) batch.indices.push(base,base+i,base+i+1);
  }

  sides(color:string, lower:Point[], upper:Point[]) {
    for (let i=0;i<lower.length;i++) {
      const j=(i+1)%lower.length;
      this.face(color,[lower[i],lower[j],upper[j],upper[i]]);
    }
  }

  box(color:string, x:number, y:number, z:number, width:number, depth:number, height:number, closed=false) {
    const layer=(h:number):Point[]=>[
      [x-width/2,y-depth/2,h],[x+width/2,y-depth/2,h],
      [x+width/2,y+depth/2,h],[x-width/2,y+depth/2,h],
    ];
    const floor=layer(z), top=layer(z+height);
    this.sides(color,floor,top); this.face(color,top);
    if (closed) this.face(color, floor.reverse());
  }

  cylinder(color:string, ring:(angle:number, top:boolean)=>Point, segments=16) {
    const lower:Point[]=[],upper:Point[]=[];
    for (let i=0;i<segments;i++) {
      const angle=2*Math.PI*i/segments;
      lower.push(ring(angle,false)); upper.push(ring(angle,true));
    }
    this.sides(color,lower,upper);
    this.face(color,upper); this.face(color,lower.reverse());
  }

  result() { return [...this.batches.values()]; }
}

export const FLAG_PLATFORM_SIZE={width:5.4, depth:3.2};
export const FLAG_CLOTH={width:2.88, height:1.92};

/** Unit flag grid (30 × 20), with origin at the upper hoist and Y measured downwards. */
export const NATIONAL_FLAG_STARS=[
  {x:5,y:5,r:3,tip:-Math.PI/2},
  ...[[10,2],[12,4],[12,7],[10,9]].map(([x,y])=>({x,y,r:1,tip:Math.atan2(5-y,5-x)})),
];

export function flagPlatformGeometry():CourtyardBatch[] {
  const mesh=new YardMesh();
  const {width,depth}=FLAG_PLATFORM_SIZE;
  mesh.box('#747a7b',0,0,0,width,depth,.15);
  mesh.box('#aaaeb0',0,0,.15,width-.44,depth-.44,.17);
  mesh.box('#747b7d',0,0,.32,width-.8,depth-.8,.19);
  mesh.box('#c4c8c6',0,0,.51,width-.75,depth-.75,.06);
  const poleX=-.69, topZ=9.05;
  const shaft=(color:string,base:number,top:number,r0:number,r1:number)=>
    mesh.cylinder(color,(a,hi)=>[poleX+(hi?r1:r0)*Math.cos(a),(hi?r1:r0)*Math.sin(a),hi?top:base]);
  shaft('#606c71',.57,.67,.28,.27);
  shaft('#c6d0d1',.67,topZ+.035,.105,.048);
  shaft('#e0bd73',topZ+.035,topZ+.13,.078,.038);

  // The obverse faces south. Grid-based stars and both sides of the cloth share one drape.
  function cloth(gx:number,gy:number,side:number):Point {
    const u=gx/30, v=gy/20;
    return [poleX+.049+gx*FLAG_CLOTH.width/30,
      u*(.12*Math.sin(u*8-v*.8)+.055*Math.sin(u*16+v)) + side,
      topZ - v*FLAG_CLOTH.height - .13*u*u + .025*u*Math.sin(u*8-v)];
  }
  shaft('#e6e6db',topZ-FLAG_CLOTH.height,topZ,.055,.053);
  for (let x=0;x<30;x++) for (let row=0;row<10;row++) {
    const y=row*2;
    for (const side of [-.0015,.0015]) {
      const p=[cloth(x,y,side),cloth(x+1,y,side),cloth(x+1,y+2,side),cloth(x,y+2,side)];
      mesh.face('#d20c19',side<0?p.reverse():p);
    }
  }
  // Official construction places the big star upright and each small star's tip towards its centre.
  const inner=Math.sin(Math.PI/10)/Math.sin(3*Math.PI/10);
  for (const {x,y,r,tip} of NATIONAL_FLAG_STARS) for (const side of [-.010,.010]) {
    const center=cloth(x,y,side),outline:Point[]=[];
    for (let i=0;i<10;i++) {
      const a=tip+i*Math.PI/5, radius=i%2===0?r:r*inner;
      outline.push(cloth(x+radius*Math.cos(a),y+radius*Math.sin(a),side));
    }
    for (let i=0;i<10;i++) {
      const next=(i+1)%10;
      mesh.face('#ffde00',side<0?[center,outline[next],outline[i]]:[center,outline[i],outline[next]]);
    }
  }
  return mesh.result();
}

/** Example passenger car, facing +Y. Occupies 4.46 × 1.82 m inside a 2.6 × 5.2 m bay. */
export function parkedCarGeometry(bodyColor:string):CourtyardBatch[] {
  const mesh=new YardMesh();
  const shell=(w:number,l:number,z:number):Point[]=>[
    [-w+.17,-l,z],[w-.17,-l,z],[w,-l+.24,z],[w,l-.30,z],
    [w-.18,l,z],[-w+.18,l,z],[-w,l-.30,z],[-w,-l+.24,z],
  ];
  const sill=shell(.79,2.12,.27), waist=shell(.9,2.23,.62), shoulder=shell(.84,2.13,.85);
  mesh.sides('#3e494b',sill,waist); mesh.sides(bodyColor,waist,shoulder);
  mesh.face(bodyColor,shoulder);
  const cabin:Point[]=[[-.79,-1.35,.86],[.79,-1.35,.86],[.79,1.20,.86],[-.79,1.20,.86]];
  const roof:Point[]=[[-.62,-.78,1.46],[.62,-.78,1.46],[.62,.48,1.46],[-.62,.48,1.46]];
  mesh.sides('#3e5a65',cabin,roof); mesh.face(bodyColor,roof);
  for (const sign of [-1,1]) {
    mesh.face('#354044',[[sign*.794,-.20,.86],[sign*.794,-.10,.86],[sign*.624,-.15,1.46],[sign*.624,-.25,1.46]]);
    for (const wheelY of [-1.42,1.40]) {
      const wheel=(color:string,r:number,low:number,high:number)=>
        mesh.cylinder(color,(a,outer)=>[(outer?high:low),wheelY+r*Math.cos(a),.33+r*Math.sin(a)],12);
      wheel('#292f30',.32,sign*.80-.09,sign*.80+.09);
      wheel('#9da5a7',.18,sign*.90-.012,sign*.90+.012);
    }
    mesh.box('#e4e3ce',sign*.57,2.16,.64,.30,.075,.10);
    mesh.box('#a33b3d',sign*.58,-2.16,.64,.28,.075,.085);
  }
  mesh.box('#263438',0,2.20,.42,.77,.055,.11);
  return mesh.result();
}
