import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildStandardSiteLayout} from './temporaryWorksSiteLayout';
import {calculatePlanningEarthwork, type PlanningMesh, type PlanningTriangle} from './temporaryWorksGeometry';
import {buildStandardSiteDecor} from './temporaryWorksSiteDecor';
import {facilityGeometry, type XY} from './temporaryWorksArchitecture';

const near=(a:number,b:number,tolerance=1e-7)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} differs from ${b}`);
const ground=(x:number,y:number)=>82+.02*x-.013*y;
const rectangle=(width:number,depth:number):XY[]=>[[0,0],[width,0],[width,depth],[0,depth]];

/** Independent measured triangles, with whole grid cells deliberately absent from coverage. */
function site(width:number,depth:number,angle=0,missing=(_x:number,_y:number)=>false,outline=rectangle(width,depth)) {
  const a=angle*Math.PI/180,cos=Math.cos(a),sin=Math.sin(a);
  const rotate=([x,y]:XY):XY=>[x*cos-y*sin+75,x*sin+y*cos-18];
  const unrotate=([x,y]:XY):XY=>[(x-75)*cos+(y+18)*sin,-(x-75)*sin+(y+18)*cos];
  const vertices=Array.from({length:(width+1)*(depth+1)},(_,i)=>{
    const [x,y]=rotate([i%(width+1),Math.floor(i/(width+1))]);
    return {x,y,z:ground(x,y)};
  });
  const triangles:PlanningTriangle[]=[];
  for(let y=0;y<depth;y++)for(let x=0;x<width;x++){
    if(missing(x,y))continue;
    const k=y*(width+1)+x;
    triangles.push([k,k+1,k+width+2],[k,k+width+2,k+width+1]);
  }
  return {width,depth,vertices,triangles,boundary:outline.map(rotate),unrotate};
}

type Site=ReturnType<typeof site>;
type Layout=ReturnType<typeof buildStandardSiteLayout>;
const layout=(floor:Site,kind:'camp'|'steel')=>buildStandardSiteLayout(kind,floor.boundary,floor.vertices,floor.triangles);

function checkEnvelope(floor:Site,fit:Layout,support:(x:number,y:number)=>boolean) {
  near(Math.hypot(...fit.axis),1);
  assert.ok(fit.scale>=.65-1e-9 && fit.scale<=1+1e-9);
  for(let y=-15;y<=15;y+=.5)for(let x=-24;x<=24;x+=.5) {
    const point=fit.toLocal(x,y);
    const [u,v]=floor.unrotate(point);
    assert.ok(u>=-1e-6 && u<=floor.width+1e-6 && v>=-1e-6 && v<=floor.depth+1e-6 && support(u,v),`unmeasured template point (${u}, ${v})`);
    near(fit.altitude(...point),ground(...point),1e-6);
  }
}

test('a rotated single CAD boundary fits both facility types with identifiable buildings on measured grades',()=>{
  // A 50 x 25 m rectangle rotated 20° has the approximate XY extent seen in the field screenshots.
  const floor=site(50,25,20);
  for(const kind of ['camp','steel'] as const) {
    const fit=layout(floor,kind);
    assert.ok(fit.scale>=.75 && fit.scale<=25/30+1e-6);
    const angle=20*Math.PI/180;
    assert.ok(Math.abs(fit.axis[0]*Math.cos(angle)+fit.axis[1]*Math.sin(angle))>.999);
    checkEnvelope(floor,fit,()=>true);
    const roles=fit.buildings.map(b=>b.role).sort();
    assert.deepEqual(roles,kind==='steel'?['workshop']:['dormitory','gatehouse','office']);
    for(const b of fit.buildings){
      assert.equal(b.outline.length,4);
      assert.ok(b.height>2);
      assert.equal(b.showCompanySign,b.role==='workshop' || b.role==='office');
      const vertices=b.outline.map(([x,y])=>({x,y,z:fit.altitude(x,y)}));
      const parts=facilityGeometry(kind,{...b,vertices,triangles:[[0,1,2],[0,2,3]]});
      const finishes=new Set(parts.filter(part=>part.indices.length>0).map(part=>part.finish));
      assert.ok(finishes.has('roof'));
      assert.equal(finishes.has('signLetter'),b.showCompanySign);
      if(kind==='steel') assert.ok(finishes.has('cladding') && finishes.has('shutter'));
      else assert.ok(finishes.has('wall') && finishes.has('glass'));
    }
    const details=buildStandardSiteDecor(kind,true);
    const expectedRoles=kind==='camp' ? ['entry','fence','flag','lighting','parking','vehicles'] : ['equipment','fence','gate','lighting','stock'];
    assert.deepEqual([...new Set(details.filter(b=>b.indices.length>0).map(b=>b.role))].sort(),expectedRoles);
    for(const b of details) for(let i=0;i<b.positions.length;i+=3) {
      const p=fit.toLocal(b.positions[i],b.positions[i+1]);
      const [u,v]=floor.unrotate(p);
      assert.ok(u>=0 && u<=floor.width && v>=0 && v<=floor.depth, `${b.role} outside the selected site`);
    }
    if(kind==='camp') {
      const noYard=buildStandardSiteDecor(kind,false);
      assert.deepEqual([...new Set(noYard.map(b=>b.role))].sort(),['entry','fence','lighting']);
    }
    const again=layout(floor,kind);
    assert.deepEqual([again.center,again.axis,again.scale,again.buildings],[fit.center,fit.axis,fit.scale,fit.buildings]);
  }
});

test('a concave site and an interior survey hole cannot be bridged by any part of the fitted yard',()=>{
  const outline:XY[]=[[0,0],[73,0],[73,21],[40,21],[40,39],[0,39]];
  const missing=(x:number,y:number)=>(x>=40 && y>=21) || (x>=6 && x<8 && y>=29 && y<31);
  const complex=site(73,39,37,missing,outline);
  const measured=(x:number,y:number)=> !(x>40+1e-6 && y>21+1e-6) &&
    !(x>6+1e-6 && x<8-1e-6 && y>29+1e-6 && y<31-1e-6);
  checkEnvelope(complex,layout(complex,'steel'),measured);
});

test('uncovered strips, disconnected islands, and a small enclosed hole cannot support a full facility module',()=>{
  const sites=[
    site(70,12,13),
    site(44,35,22,x=>x%13===11),
    site(32,20,10,(x,y)=>x===16 && y===10),
    site(50,30,0,()=>true),
  ];
  for(const kind of ['camp','steel'] as const) for(const floor of sites)
    assert.throws(()=>layout(floor,kind),/有效|覆盖|空间|布置|尺寸|场地|场坪/);
});

test('standard buildings are display objects; both facility types leave hardstanding quantities and measured triangles intact',()=>{
  const floor=site(64,40,11);
  const mesh:PlanningMesh={points:floor.vertices.map(({x,y})=>({x,y})),triangles:floor.triangles,spacing:1,planArea:64*40};
  const survey=floor.vertices.map(p=>p.z+.15);
  const design={reference:mesh.points[0],referenceHeight:floor.vertices[0].z,finishedOffset:0,
    gradeEastPct:2,gradeNorthPct:-1.3,surfaceToTreatment:.2,treatmentDepth:.3};
  const before=calculatePlanningEarthwork(mesh,survey,design);
  near(before.coveredArea,2560); near(before.cutVolume,2560*.65,1e-6); near(before.fillVolume,0);
  const snapshot=JSON.stringify([floor.boundary,floor.vertices,floor.triangles]);
  for(const kind of ['camp','steel'] as const) {
    const fit=layout(floor,kind);
    near(fit.scale,1,1e-6);
    assert.ok(fit.buildings.length>0);
    assert.equal(JSON.stringify([floor.boundary,floor.vertices,floor.triangles]),snapshot);
    assert.deepEqual(calculatePlanningEarthwork(mesh,survey,design),before);
  }
});
