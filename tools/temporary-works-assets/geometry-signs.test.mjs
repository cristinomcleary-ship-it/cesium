import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Document, NodeIO} from '@gltf-transform/core';
import sharp from 'sharp';
import {addSignImage, createSignTextImage, measureSignNode, rewriteGeometrySigns} from './geometry-signs.mjs';

// Every mesh, name, coordinate and image in this suite is synthetic. No source
// model, private source binding, supplied logo or private mapping is required.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const near = (actual, expected, tolerance=1e-6) => assert.ok(Math.abs(actual-expected)<tolerance, `${actual} != ${expected}`);
const io = new NodeIO();

function fixture() {
  const doc=new Document(), buffer=doc.createBuffer('synthetic-buffer');
  const scene=doc.createScene('synthetic-scene');doc.getRoot().setDefaultScene(scene);
  const attribute=(type,array)=>doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const position=attribute('VEC3',new Float32Array([-1,0,0, 1,0,0, 1,1,0, -1,1,0]));
  const indices=attribute('SCALAR',new Uint16Array([0,1,2, 0,2,3]));
  const material=doc.createMaterial('synthetic-original-material').setBaseColorFactor([0.2,0.3,0.4,1]);
  const primitive=doc.createPrimitive().setAttribute('POSITION',position).setIndices(indices).setMaterial(material);
  const sharedMesh=doc.createMesh('synthetic-shared-mesh').addPrimitive(primitive);
  const parent=doc.createNode('synthetic-parent').setTranslation([10,20,30]);
  const source=doc.createNode('synthetic-source-sign').setMesh(sharedMesh).setTranslation([1,2,3]).setScale([2,3,1]);
  const child=doc.createNode('synthetic-preserved-child').setMesh(sharedMesh).setTranslation([0,4,0]);
  const sibling=doc.createNode('synthetic-shared-sibling').setMesh(sharedMesh).setTranslation([-3,2,3]);
  source.addChild(child);parent.addChild(source).addChild(sibling);scene.addChild(parent);
  const binding=(node=source,text='TEST SIGN')=>({
    sourceNode:doc.getRoot().listNodes().indexOf(node),sourceName:node.getName(),
    geometrySha256:measureSignNode(node).geometrySha256,normal:[0,0,1],text,
    replacementName:`synthetic-replacement-${node.getName()}`,
  });
  return {doc,scene,parent,source,child,sibling,sharedMesh,primitive,position,indices,material,binding};
}

test('source measurements apply the hierarchy and bind both positions and triangle indices',()=>{
  const f=fixture(), measured=measureSignNode(f.source);
  assert.deepEqual(measured.min,[9,22,33]);assert.deepEqual(measured.max,[13,25,33]);
  assert.equal(measured.triangles,2);
  const positionBytes=Buffer.from(f.position.getArray().buffer),indexBytes=Buffer.from(f.indices.getArray().buffer);
  assert.equal(measured.geometrySha256,hash(Buffer.concat([positionBytes,indexBytes])));
  f.indices.getArray()[0]=1;
  assert.notEqual(measureSignNode(f.source).geometrySha256,measured.geometrySha256);
  f.source.setMesh(null);
  assert.throws(()=>measureSignNode(f.source),/no mesh/);
});

test('replacing one node preserves its children and every other user of its shared mesh',async()=>{
  const f=fixture(), oldPosition=Array.from(f.position.getArray()), oldIndices=Array.from(f.indices.getArray());
  const oldWorld=f.child.getWorldMatrix(),oldBounds=measureSignNode(f.source),oldBinding=f.binding();
  const audit=await rewriteGeometrySigns(f.doc,{plan:[oldBinding],sharp,fontFamily:'sans-serif'});
  assert.equal(audit.length,1);assert.equal(f.source.getMesh(),null);
  assert.deepEqual(f.source.listChildren(),[f.child]);assert.deepEqual(f.parent.listChildren(),[f.source,f.sibling]);
  assert.deepEqual(f.child.getWorldMatrix(),oldWorld);
  assert.equal(f.child.getMesh(),f.sharedMesh);assert.equal(f.sibling.getMesh(),f.sharedMesh);
  assert.deepEqual(f.sharedMesh.listPrimitives(),[f.primitive]);assert.equal(f.primitive.getMaterial(),f.material);
  assert.deepEqual(f.material.getBaseColorFactor(),[0.2,0.3,0.4,1]);
  assert.deepEqual(Array.from(f.position.getArray()),oldPosition);assert.deepEqual(Array.from(f.indices.getArray()),oldIndices);
  assert.deepEqual(audit[0].removed,oldBounds);assert.equal(audit[0].replacementText,'TEST SIGN');
  const replacement=f.scene.listChildren().find(n=>n.getName()===oldBinding.replacementName);
  assert.ok(replacement);assert.deepEqual(replacement.getTranslation(),[0,0,0],'world-space face attaches at scene root');
  const bounds=measureSignNode(replacement);
  for(let i=0;i<3;i++){assert.ok(bounds.min[i]>=oldBounds.min[i]-1e-6);assert.ok(bounds.max[i]<=oldBounds.max[i]+1e-6);}
  // Verify the invariants survive an actual GLB serialization/parse, not just API mocks.
  const restored=await io.readBinary(await io.writeBinary(f.doc));
  const nodes=restored.getRoot().listNodes(),source=nodes.find(n=>n.getName()===f.source.getName());
  const sibling=nodes.find(n=>n.getName()===f.sibling.getName()),child=nodes.find(n=>n.getName()===f.child.getName());
  assert.equal(source.getMesh(),null);assert.deepEqual(source.listChildren(),[child]);
  assert.equal(sibling.getMesh(),child.getMesh());assert.equal(sibling.getMesh().listPrimitives()[0].getAttribute('POSITION').getCount(),4);
});

test('removal-only bindings remove the selected mesh without removing child geometry or adding a covering face',async()=>{
  const f=fixture(),binding=f.binding();delete binding.text;delete binding.normal;
  const originalNodes=f.doc.getRoot().listNodes(),originalMeshes=f.doc.getRoot().listMeshes();
  const audit=await rewriteGeometrySigns(f.doc,{plan:[binding],sharp});
  assert.equal(f.source.getMesh(),null);assert.equal(f.child.getMesh(),f.sharedMesh);assert.equal(f.sibling.getMesh(),f.sharedMesh);
  assert.deepEqual(f.doc.getRoot().listNodes(),originalNodes);assert.deepEqual(f.doc.getRoot().listMeshes(),originalMeshes);
  assert.equal(f.doc.getRoot().listTextures().length,0);assert.equal(audit[0].replacement,null);
});

test('any invalid name/hash/index or duplicate binding rejects the entire plan before mutation',async t=>{
  const cases=[
    ['wrong name',item=>({...item,sourceName:'synthetic-wrong-name'}),/binding mismatch/],
    ['wrong geometry digest',item=>({...item,geometrySha256:'0'.repeat(64)}),/geometry mismatch/],
    ['missing digest',item=>({...item,geometrySha256:undefined}),/geometry mismatch/],
    ['malformed digest',item=>({...item,geometrySha256:'not-a-sha256'}),/geometry mismatch/],
    ['missing node',item=>({...item,sourceNode:999}),/binding mismatch/],
    ['fractional node',item=>({...item,sourceNode:0.5}),/invalid source sign binding/],
    ['duplicate node',(_item,first)=>({...first}),/Duplicate/],
  ];
  for(const [name,change,error] of cases)await t.test(name,async()=>{
    const f=fixture(),first=f.binding(),second=change(f.binding(f.sibling,'SECOND TEST'),first);
    const before=await io.writeBinary(f.doc);
    await assert.rejects(rewriteGeometrySigns(f.doc,{plan:[first,second],sharp,fontFamily:'sans-serif'}),error);
    assert.equal(f.source.getMesh(),f.sharedMesh);assert.equal(f.sibling.getMesh(),f.sharedMesh);
    assert.deepEqual(await io.writeBinary(f.doc),before,'later bad binding must not leave a partial rewrite');
  });
});

test('invalid later face normals and missing logo bytes fail before deleting earlier lettering',async t=>{
  for(const normal of [[0.5,0,0.5],[0,1,0],[0,0,0],[2,0,0],[0,0,Infinity],undefined])await t.test(String(normal),async()=>{
    const f=fixture(),before=await io.writeBinary(f.doc);
    await assert.rejects(rewriteGeometrySigns(f.doc,{plan:[f.binding(),{...f.binding(f.sibling,'SECOND TEST'),normal}],sharp}),/horizontal face normal/);
    assert.deepEqual(await io.writeBinary(f.doc),before);
  });
  const f=fixture(),before=await io.writeBinary(f.doc);
  await assert.rejects(rewriteGeometrySigns(f.doc,{plan:[f.binding(),{...f.binding(f.sibling),text:undefined,logo:true}],sharp}),/logo bytes/);
  assert.deepEqual(await io.writeBinary(f.doc),before);
});

test('a later text-rendering failure does not partially mutate the source document',async()=>{
  const f=fixture(),before=await io.writeBinary(f.doc);let imageCalls=0;
  const failingSharp=input=>{if(++imageCalls===2)throw new Error('synthetic raster failure');return sharp(input);};
  await assert.rejects(rewriteGeometrySigns(f.doc,{plan:[f.binding(),f.binding(f.sibling,'SECOND TEST')],sharp:failingSharp,fontFamily:'sans-serif'}),/synthetic raster failure/);
  assert.equal(imageCalls,2);assert.deepEqual(await io.writeBinary(f.doc),before);
});

test('all four outward faces have correct triangle winding, unmirrored UVs, and contained image aspect',async t=>{
  const image=await sharp({create:{width:8,height:4,channels:4,background:{r:180,g:20,b:20,alpha:1}}}).png().toBuffer();
  const bounds={min:[-3,2,-4],max:[3,6,4]};
  for(const normal of [[0,0,1],[0,0,-1],[1,0,0],[-1,0,0]])await t.test(normal.join(','),async()=>{
    const f=fixture(),name='synthetic-face';
    const result=await addSignImage(f.doc,image,bounds,normal,name,{sharp,contain:true});
    const node=f.scene.listChildren().find(n=>n.getName()===name),prim=node.getMesh().listPrimitives()[0];
    const positions=prim.getAttribute('POSITION'),normals=prim.getAttribute('NORMAL'),uv=prim.getAttribute('TEXCOORD_0'),indices=prim.getIndices().getArray();
    const point=i=>positions.getElement(i,[]),dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0),subtract=(a,b)=>a.map((x,i)=>x-b[i]);
    const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const right=[normal[2],0,-normal[0]],depthAxis=normal[0]?0:2;
    const values=Array.from({length:positions.getCount()},(_,i)=>point(i)),across=values.map(p=>dot(p,right));
    const minAcross=Math.min(...across),maxAcross=Math.max(...across),minY=Math.min(...values.map(p=>p[1])),maxY=Math.max(...values.map(p=>p[1]));
    for(let i=0;i<indices.length;i+=3){
      const a=point(indices[i]),b=point(indices[i+1]),c=point(indices[i+2]);
      const direction=cross(subtract(b,a),subtract(c,a));
      near(dot(direction,normal)/Math.hypot(...direction),1);
    }
    for(let i=0;i<positions.getCount();i++){
      assert.deepEqual(normals.getElement(i,[]),normal);
      const p=point(i),tex=uv.getElement(i,[]);
      near(p[depthAxis],normal[depthAxis]<0?bounds.min[depthAxis]:bounds.max[depthAxis]);
      near(tex[0],(dot(p,right)-minAcross)/(maxAcross-minAcross));near(tex[1],(maxY-p[1])/(maxY-minY));
      for(let axis=0;axis<3;axis++)assert.ok(p[axis]>=bounds.min[axis]&&p[axis]<=bounds.max[axis]);
    }
    near(result.width/result.height,2);assert.equal(result.imageSha256,hash(image));
    assert.equal(prim.getMaterial().getDoubleSided(),false);assert.equal(prim.getMaterial().getAlphaMode(),'MASK');
    assert.deepEqual(prim.getMaterial().getBaseColorTexture().getImage(),image);
  });
});

test('text rendering escapes XML and creates transparent horizontal or vertical glyph images',async()=>{
  for(const vertical of [false,true]){
    const image=await createSignTextImage(sharp,'AB&<CD>',{vertical,fontFamily:'sans-serif',color:'#123456'});
    const {data,info}=await sharp(image).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(info.channels,4);assert.ok(info.width>0&&info.height>0);
    assert.ok(vertical?info.height>info.width:info.width>info.height);
    const alpha=Array.from({length:info.width*info.height},(_,i)=>data[i*4+3]);
    assert.ok(alpha.some(a=>a===0),'cutout background must remain transparent');assert.ok(alpha.some(a=>a>200),'glyphs must be visible');
  }
  await assert.rejects(createSignTextImage(sharp,'  '),/empty/);
});
