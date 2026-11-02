import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Cesium3DTileset, Viewer } from 'cesium';
import { buildPlanningStructureMesh, planningBoundary, renderPlanningMesh, samplePlanningSurface, type PlanningVertex } from './temporaryWorksScene';

const unit = .00001;
const location = (x: number, y: number) => ({ longitude: 121 + x * unit, latitude: 31 + y * unit });
const vertex = (x: number, y: number): PlanningVertex => ({ ...location(x, y), surfaceHeight: 10 + x, baseHeight: 9 + x });
const square = [vertex(0, 0), vertex(2, 0), vertex(2, 2), vertex(0, 2)];
const triangles = [[0, 1, 2], [0, 2, 3]];

function area(mesh: ReturnType<typeof buildPlanningStructureMesh>) {
  return mesh.triangles.reduce((sum, [ai, bi, ci]) => {
    const [a, b, c] = [ai, bi, ci].map(i => mesh.vertices[i]);
    return sum + Math.abs((b.longitude - a.longitude) * (c.latitude - a.latitude) - (b.latitude - a.latitude) * (c.longitude - a.longitude)) / (2 * unit * unit);
  }, 0);
}

test('office mass follows concave CAD outline, supported hardstand and interpolated ground', () => {
  // CAD extends beyond the north and west site limits; its lower-right recess stays unbuilt.
  const footprint = [[-1, 0], [.5, 0], [.5, 1], [1.5, 1], [1.5, 3], [-1, 3]].map(([x, y]) => location(x, y));
  const result = buildPlanningStructureMesh('camp', square, triangles, { footprint, height: 6 });
  assert.ok(Math.abs(area(result) - 2) < .00001);
  for (const v of result.vertices) {
    assert.ok(Math.abs(v.baseHeight - 10 - (v.longitude - 121) / unit) < 1e-6);
    assert.ok(Math.abs(v.surfaceHeight - 17.5) < 1e-6);
  }
});

test('workshop roof skin is bounded in thickness and a missing coverage strip stays empty', () => {
  const vertices = [...square, vertex(3, 0), vertex(5, 0), vertex(5, 2), vertex(3, 2)];
  const footprint = [[-1, -1], [6, -1], [6, 3], [-1, 3]].map(([x, y]) => location(x, y));
  const result = buildPlanningStructureMesh('steel', vertices, [...triangles, [4, 5, 6], [4, 6, 7]], { footprint, height: 7 });
  assert.ok(Math.abs(area(result) - 8) < .00001);
  for (const v of result.vertices) {
    assert.ok(Math.abs(v.surfaceHeight - 22) < 1e-6);
    assert.ok(Math.abs(v.baseHeight - 21.82) < 1e-6);
  }
  for (const tri of result.triangles) {
    const xs = tri.map(i => (result.vertices[i].longitude - 121) / unit);
    assert.ok(Math.max(...xs) < 2.001 || Math.min(...xs) > 2.999);
  }
});

test('only exterior and hole edges acquire walls; interior diagonals are suppressed', () => {
  const edges = planningBoundary([[0, 1, 2], [0, 2, 3], [1, 4, 5], [1, 5, 2]]);
  assert.equal(edges.length, 6);
  assert.ok(!edges.some(([a, b]) => a === 2 && b === 1 || a === 1 && b === 2));
  assert.ok(!edges.some(([a, b]) => a === 0 && b === 2 || a === 2 && b === 0));
});

test('a wholly uncovered optional building is discarded; invalid building height is rejected', () => {
  const footprint = [location(8, 8), location(9, 8), location(8, 9)];
  assert.equal(buildPlanningStructureMesh('camp', square, triangles, { footprint, height: 4 }).triangles.length, 0);
  assert.throws(() => buildPlanningStructureMesh('steel', square, triangles, { footprint, height: 0 }), /高度/);
});

test('an aborted solve or removed source can never be mistaken for an empty footprint', async () => {
  const viewer = { isDestroyed: () => false, scene: { primitives: { contains: () => false } } } as unknown as Viewer;
  const tileset = { show: true, isDestroyed: () => false } as unknown as Cesium3DTileset;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(samplePlanningSurface(viewer, tileset, [location(0, 0)], { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(samplePlanningSurface(viewer, tileset, [location(0, 0)]), /卸载/);
});

test('multiple CAD buildings share one measured slab and the render handles detach on removal', () => {
  const primitives = new Set<{show: boolean}>();
  const viewer = {
    scene: {
      primitives: {
        add(value: {show: boolean}) { primitives.add(value); return value; },
        remove(value: {show: boolean}) { return primitives.delete(value); },
      },
      requestRender() {},
    },
    isDestroyed: () => false,
  } as unknown as Viewer;
  const footprint = [location(0, 0), location(1, 0), location(1, 1), location(0, 1)];
  const outside = [location(8, 8), location(9, 8), location(9, 9)];
  const handle = renderPlanningMesh(viewer, 'camp', square, triangles, [
    { footprint, height: 4 }, { footprint: outside, height: 7 },
  ]);
  assert.equal(handle.builtStructureCount, 1);
  assert.deepEqual(handle.structureBuilt, [true, false]);
  assert.equal(primitives.size, 2);
  handle.show = false;
  assert.ok([...primitives].every(primitive => !primitive.show));
  handle.show = true;
  handle.xray = false;
  assert.equal([...primitives].filter(primitive => primitive.show).length, 1);
  handle.destroy();
  handle.destroy();
  assert.equal(primitives.size, 0);
});

test('parameter road draws the pavement, both sloping layers and only exposed end walls; labels follow plan lifecycle', () => {
  const vertices: PlanningVertex[] = [], faces: number[][] = [];
  // Vertical dimensions h=t=0.5 m, 1:2 side slope. Independent strip seams
  // mirror the calculation output and must not create artificial vertical walls.
  const offsets = [-4, -3, -2, 0, 2, 3, 4];
  for (let i = 1; i < offsets.length; i++) {
    const [a, b] = [offsets[i - 1], offsets[i]];
    const id = vertices.length;
    for (const [s, offset] of [[0, a], [10, a], [10, b], [0, b]]) {
      const z = 12 + s / 10;
      const surfaceHeight = z - Math.max(0, Math.abs(offset) - 2) / 2;
      vertices.push({ ...location(s, offset), surfaceHeight, baseHeight: Math.min(surfaceHeight, z - .5),
        formationHeight: z - 1, roadPart: Math.abs((a + b) / 2) <= 2 ? 'core' : 'slope', roadStation: s, roadOffset: offset });
    }
    faces.push([id, id + 1, id + 2], [id, id + 2, id + 3]);
  }
  type Rendered = { show: boolean; geometryInstances: { geometry: {indices: ArrayLike<number>} }[] };
  type Marker = { show: boolean; label: {text: string} };
  const primitives = new Set<Rendered>(), entities = new Set<Marker>();
  const viewer = { isDestroyed: () => false, scene: {requestRender() {}, primitives: {
    add(p: Rendered) { primitives.add(p); }, remove(p: Rendered) { primitives.delete(p); },
  }}, entities: {
    add(e: Marker) { entities.add(e); return e; }, remove(e: Marker) { entities.delete(e); },
  }} as unknown as Viewer;
  const road = {width: 4, length: 10};
  const handle = renderPlanningMesh(viewer, 'road', vertices, faces, undefined, road);
  const [solid, overlay] = [...primitives];
  assert.deepEqual(solid.geometryInstances.map(i => i.geometry.indices.length), [12, 12, 12, 48, 72, 36]);
  assert.equal(overlay.geometryInstances.length, 3);
  assert.deepEqual([...entities].map(e => e.label.text).sort(), ['终点 K0+010.000', '起点 K0+000.000'].sort());
  handle.show = false;
  assert.ok([...entities, ...primitives].every(p => !p.show));
  handle.show = true;
  assert.ok([...entities, ...primitives].every(p => p.show));
  handle.destroy(); handle.destroy();
  assert.equal(entities.size + primitives.size, 0);

  const clipped = renderPlanningMesh(viewer, 'road', vertices, faces, undefined, { width: 4, length: 20 });
  assert.deepEqual([...entities].map(e => e.label.text), ['起点 K0+000.000']);
  clipped.destroy();
  assert.equal(entities.size, 0);
});

test('a round corner keeps every exposed wall edge when station and radius are identical', () => {
  const vertices = [[0,0],[2,0],[Math.SQRT2,Math.SQRT2],[0,2]].map(([x,y], i): PlanningVertex => ({
    ...location(x,y), surfaceHeight:10, baseHeight:9.5, formationHeight:9,
    roadPart:'core', roadStation:5, roadOffset:i === 0 ? 0 : 2,
  }));
  type Collected = { geometryInstances: { geometry: { indices:ArrayLike<number> } }[] };
  const primitives: Collected[] = [];
  const viewer = { isDestroyed:()=>false, scene:{ requestRender(){}, primitives:{
    add(p: Collected) { primitives.push(p); }, remove(){ return true; },
  } }, entities:{add(){},remove(){}} } as unknown as Viewer;
  const h = renderPlanningMesh(viewer,'road',vertices,[[0,1,2],[0,2,3]],undefined,{length:10,width:4});
  // Two top faces, four exposed upper and lower wall quads, two bottom faces.
  assert.deepEqual(primitives[0].geometryInstances.map(i=>i.geometry.indices.length),[6,24,24,6]);
  h.destroy();
});

test('large road GPU batches share no interior walls, keep exactly two endpoint labels, and can be removed before upload', async () => {
  const length=4600, vertices:PlanningVertex[]=[], faces:number[][]=[];
  for (let s=0;s<=length;s++) {
    for (const off of [0,1]) vertices.push({...location(s,off), roadStation:s, roadOffset:off, roadPart:'core',
      surfaceHeight:12, baseHeight:11.5, formationHeight:11});
    if (s) faces.push([2*s-2,2*s,2*s+1],[2*s-2,2*s+1,2*s-1]);
  }
  type PrimitiveGroup={show:boolean; geometryInstances:{geometry:{indices:ArrayLike<number>}}[]};
  type Mark={show:boolean};
  const prims=new Set<PrimitiveGroup>(), labels=new Set<Mark>();
  const viewer={isDestroyed:()=>false, scene:{requestRender(){}, primitives:{
    add(p:PrimitiveGroup){prims.add(p);}, remove(p:PrimitiveGroup){prims.delete(p);},
  }}, entities:{add(e:Mark){labels.add(e);return e;}, remove(e:Mark){labels.delete(e);}}} as unknown as Viewer;
  const draw=()=>renderPlanningMesh(viewer,'road',vertices,faces,undefined,{length,width:4});
  const cancelled=draw(); cancelled.destroy(); await cancelled.ready;
  assert.equal(prims.size+labels.size,0);
  const kept=draw(); kept.show=false;
  await kept.ready;
  assert.ok(prims.size>2 && prims.size%2===0);
  assert.equal(labels.size,2);
  assert.ok([...labels,...prims].every(p=>!p.show));
  // Each retained quad strip edge contributes one vertical wall quad per layer.
  const solids=[...prims].filter((_,i)=>i%2===0);
  const counts=solids.reduce((sum,p)=>sum+p.geometryInstances.reduce((n,v)=>n+v.geometry.indices.length,0),0);
  assert.equal(counts,6*faces.length + 12*(2*length+2));
  kept.show=true; kept.xray=false;
  assert.equal([...prims].filter(p=>p.show).length,solids.length);
  kept.destroy(); assert.equal(prims.size+labels.size,0);
});

test('standard compound instances and their measured pad share visibility, zoom and removal',()=>{
  type Instance={id?:string;attributes:{color:{value:Uint8Array}};geometry:{indices:ArrayLike<number>}};
  type Group={show:boolean; geometryInstances:Instance[]};
  const groups=new Set<Group>();
  let focus:{radius:number}|undefined;
  const viewer={isDestroyed:()=>false,
    scene:{requestRender(){},primitives:{add(p:Group){groups.add(p);},remove(p:Group){return groups.delete(p);}}},
    camera:{flyToBoundingSphere(sphere:{radius:number}){focus=sphere;}}
  } as unknown as Viewer;
  const largePad=[[0,0],[140,0],[140,130],[0,130]].map(([x,y])=>({...location(x,y),surfaceHeight:18+.002*x,baseHeight:17.75+.002*x}));
  function draw(kind:'camp'|'steel',yard:boolean,standard=true) {
    return renderPlanningMesh(viewer,kind,largePad,triangles,undefined,undefined,yard,standard?{boundary:largePad}:undefined);
  }
  const camp=draw('camp',true);
  assert.equal(camp.builtStructureCount,3);
  assert.equal(camp.standardPlacement?.scale,1);
  assert.equal(camp.standardPlacement?.cars,3);
  assert.deepEqual(camp.yard,{flag:true,spaces:5});
  const [solid,overlay]=[...groups];
  const tags=solid.geometryInstances.filter(i=>i.geometry.indices.length>0).map(i=>i.id??'');
  for(const part of ['office/signLetter','dormitory/roof','gatehouse/roof','flag/','parking/','vehicles/','entry/','fence/']){
    assert.ok(tags.some(id=>id.startsWith('tw-standard/camp/'+part)),part);
  }
  assert.ok(overlay.geometryInstances.every(i=>i.attributes.color.value[3]<64),'the cutaway must not cover the buildings with solid pad colour');
  function checkRoofCutaway(solids:Group, cutaway:Group, expected:number) {
    const roofs=solids.geometryInstances.filter(instance=>instance.id?.endsWith('/roof'));
    assert.equal(roofs.length,expected);
    assert.ok(roofs.every(roof=>cutaway.geometryInstances.some(instance=>instance.geometry===roof.geometry)),
      'the occluded roof of every standard building must remain visible when inspecting buried design surfaces');
  }
  checkRoofCutaway(solid,overlay,3);
  camp.zoom();
  assert.ok(focus && focus.radius<camp.bounds.radius*.6,'zoom fits the compound on an oversized pad');
  camp.show=false;
  assert.ok([...groups].every(p=>!p.show));
  camp.destroy(); assert.equal(groups.size,0);
  const reload=draw('camp',true);
  assert.deepEqual(reload.standardPlacement,camp.standardPlacement);
  reload.destroy();
  const plain=draw('camp',false);
  assert.equal(plain.builtStructureCount,3);
  assert.deepEqual(plain.yard,{flag:false,spaces:0});
  assert.ok(![...groups][0].geometryInstances.some(i=>/\/(flag|parking|vehicles)\//.test(i.id??'')));
  plain.destroy();
  const steel=draw('steel',false);
  assert.equal(steel.builtStructureCount,1);
  const [steelSolid, steelCutaway] = [...groups];
  checkRoofCutaway(steelSolid,steelCutaway,1);
  for(const part of ['workshop/signLetter','workshop/cladding','fence/','gate/','stock/','equipment/']){
    assert.ok([...groups][0].geometryInstances.some(i=>(i.id??'').startsWith('tw-standard/steel/'+part)),part);
  }
  steel.destroy();
  const legacy=draw('steel',false,false);
  assert.equal(legacy.standardPlacement,undefined);
  assert.equal(legacy.builtStructureCount,0);
  legacy.destroy(); assert.equal(groups.size,0);
  assert.throws(()=>renderPlanningMesh(viewer,'camp',square,triangles,undefined,undefined,true,{boundary:square}),/连续区域/);
  assert.equal(groups.size,0);
});
