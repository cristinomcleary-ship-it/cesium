// Deterministic independent geometry for three-dimensional clipping acceptance.
// Generated in memory; no project assets or records are copied or changed.
export function boxTriangles(min, max, reverse = false) {
  const [x,y,z]=min,[X,Y,Z]=max;
  const positions=[x,y,z,X,y,z,X,Y,z,x,Y,z,x,y,Z,X,y,Z,X,Y,Z,x,Y,Z];
  const indices=[0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5];
  if(reverse)for(let i=0;i<indices.length;i+=3)[indices[i+1],indices[i+2]]=[indices[i+2],indices[i+1]];
  return {positions,indices};
}
export function mergeMeshes(meshes) {
  const positions=[],indices=[];
  for(const mesh of meshes){const offset=positions.length/3;positions.push(...mesh.positions);indices.push(...mesh.indices.map(i=>i+offset));}
  return {positions,indices};
}
export function makeGlb(meshes, color=[.8,.1,.1,1]) {
  const chunks=[],bufferViews=[],accessors=[],gltfMeshes=[];let offset=0;
  for(const mesh of meshes){
    const positions=new Float32Array(mesh.positions),indices=new Uint32Array(mesh.indices);
    const firstAccessor=accessors.length;
    const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
    for(let i=0;i<positions.length;i++){min[i%3]=Math.min(min[i%3],positions[i]);max[i%3]=Math.max(max[i%3],positions[i]);}
    bufferViews.push({buffer:0,byteOffset:offset,byteLength:positions.byteLength});chunks.push(Buffer.from(positions.buffer));offset+=positions.byteLength;
    accessors.push({bufferView:bufferViews.length-1,componentType:5126,count:positions.length/3,type:'VEC3',min,max});
    bufferViews.push({buffer:0,byteOffset:offset,byteLength:indices.byteLength});chunks.push(Buffer.from(indices.buffer));offset+=indices.byteLength;
    accessors.push({bufferView:bufferViews.length-1,componentType:5125,count:indices.length,type:'SCALAR'});
    gltfMeshes.push({primitives:[{attributes:{POSITION:firstAccessor},indices:firstAccessor+1,material:0}]});
  }
  const binary=Buffer.concat(chunks),doc={asset:{version:'2.0'},extensionsUsed:['KHR_materials_unlit'],scene:0,
    scenes:[{nodes:meshes.map((_,i)=>i)}],nodes:meshes.map((_,i)=>({mesh:i,name:'contact-fixture-'+i})),meshes:gltfMeshes,
    materials:[{pbrMetallicRoughness:{baseColorFactor:color},doubleSided:true,extensions:{KHR_materials_unlit:{}}}],
    buffers:[{byteLength:binary.length}],bufferViews,accessors};
  let json=Buffer.from(JSON.stringify(doc));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
  const head=Buffer.alloc(20);head.writeUInt32LE(0x46546c67);head.writeUInt32LE(2,4);head.writeUInt32LE(28+json.length+binary.length,8);head.writeUInt32LE(json.length,12);head.writeUInt32LE(0x4e4f534a,16);
  const binHead=Buffer.alloc(8);binHead.writeUInt32LE(binary.length);binHead.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([head,json,binHead,binary]);
}
export function syntheticContactModels(){
  const sloped=boxTriangles([-4,-2,4],[4,2,6]);
  for(let i=0;i<sloped.positions.length;i+=3)sloped.positions[i+2]+=.5*sloped.positions[i];
  const ring=[[-4,-4],[4,-4],[4,-1],[-1,-1],[-1,4],[-4,4]],faces=[0,1,3,1,2,3,0,3,5,3,4,5];
  const concave={positions:[...ring.flatMap(([x,y])=>[x,y,1]),...ring.flatMap(([x,y])=>[x,y,3])],indices:[]};
  for(let i=0;i<faces.length;i+=3){const [a,b,c]=faces.slice(i,i+3);concave.indices.push(a,c,b,a+6,b+6,c+6);}
  for(let i=0;i<6;i++){const j=(i+1)%6;concave.indices.push(i,j,j+6,i,j+6,i+6);}
  return new Map([
    ['bridge',makeGlb([boxTriangles([-4,-3,8],[4,3,10]),boxTriangles([-3,-1,-2],[-2,1,8])])],
    ['layers',makeGlb([boxTriangles([-4,-3,1],[4,3,2]),boxTriangles([-4,-3,8],[4,3,10])])],
    ['overlap',makeGlb([boxTriangles([-4,-3,1],[1,3,6]),boxTriangles([-1,-3,3],[4,3,8])])],
    ['cavity',makeGlb([mergeMeshes([boxTriangles([-4,-4,-4],[4,4,4]),boxTriangles([-2,-2,-2],[2,2,2],true)])])],
    ['open',makeGlb([{positions:[-4,-4,5,4,-4,5,4,4,5,-4,4,5],indices:[0,1,2,0,2,3]}])],
    ['sloped',makeGlb([sloped])],
    ['concave',makeGlb([concave])],
    ['crossing',makeGlb([boxTriangles([-4,-1,4],[4,1,6]),boxTriangles([-1,-4,4],[1,4,6])])],
  ]);
}
export function photographyGlb(radius=20){
  // A y-up GLB becomes an ENU horizontal plane through the tileset transform.
  return makeGlb([{positions:[-radius,0,radius,radius,0,radius,radius,0,-radius,-radius,0,-radius],indices:[0,1,2,0,2,3]}],[.04,.8,.08,1]);
}
