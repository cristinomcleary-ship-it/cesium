/** Exact-text sign replacements for audited source nodes.
 * Bindings are supplied privately by the asset owner. Model vertices are never
 * embedded in this module. Original files are not modified.
 */
import {createHash} from 'node:crypto';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const validNormal = normal => Array.isArray(normal) && normal.length===3 && normal[1]===0 && Math.abs(normal[0])+Math.abs(normal[2])===1 && normal.every(Number.isFinite) && normal.every(Number.isInteger);

/** Render exact lettering, without reconstructing a source texture. */
export async function createSignTextImage(sharp, text, options = {}) {
  if (!text || !String(text).trim()) throw new Error('Replacement sign text is empty');
  const fontFamily = options.fontFamily ?? 'Noto Sans CJK SC';
  const fontSize = 160;
  const width = options.vertical ? 212 : Math.ceil([...text].length * fontSize + 32);
  const height = options.vertical ? [...text].length * 176 + 32 : 212;
  const glyphs = options.vertical
    ? [...text].map((glyph,i)=>`<tspan x="16" y="${168+i*176}">${xml(glyph)}</tspan>`).join('')
    : xml(text);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="16" y="168" font-family="${xml(fontFamily)}" font-weight="700" font-size="${fontSize}" fill="${xml(options.color ?? '#c8102e')}">${glyphs}</text></svg>`;
  // The font is a declared build dependency; Noto Sans CJK is OFL licensed.
  // trim() preserves actual glyph aspect ratio and eliminates transparent padding.
  return sharp(Buffer.from(svg)).trim().png().toBuffer();
}

export function measureSignNode(node) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const matrix = node.getWorldMatrix();
  const hash = createHash('sha256');
  let triangles = 0;
  for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
    const position = primitive.getAttribute('POSITION');
    if (!position) throw new Error('Audited sign has no POSITION attribute');
    const data = position.getArray();
    hash.update(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    const indices = primitive.getIndices()?.getArray();
    if (indices) hash.update(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
    triangles += (indices?.length ?? position.getCount()) / 3;
    for (let i = 0; i < position.getCount(); i++) {
      const v = []; position.getElement(i, v);
      const w = [matrix[0]*v[0]+matrix[4]*v[1]+matrix[8]*v[2]+matrix[12], matrix[1]*v[0]+matrix[5]*v[1]+matrix[9]*v[2]+matrix[13], matrix[2]*v[0]+matrix[6]*v[1]+matrix[10]*v[2]+matrix[14]];
      for (let j = 0; j < 3; j++) { min[j] = Math.min(min[j],w[j]); max[j] = Math.max(max[j],w[j]); }
    }
  }
  if (!triangles) throw new Error('Audited source sign has no mesh');
  return {min,max,triangles,geometrySha256:hash.digest('hex')};
}

/** Add a replacement face at the removed sign's measured surface, world Y-up.
 * normal is an axis-aligned horizontal outward normal, verified from source.
 * contain=true keeps logo aspect ratio; text fills the source's lettering area.
 */
export async function addSignImage(doc, image, bounds, normal, name, {sharp, contain=false} = {}) {
  if (!validNormal(normal)) throw new Error('A verified horizontal face normal is required');
  const right = [normal[2],0,-normal[0]];
  const wideAxis = Math.abs(right[0]) ? 0 : 2;
  const depthAxis = wideAxis === 0 ? 2 : 0;
  let width = bounds.max[wideAxis]-bounds.min[wideAxis], height=bounds.max[1]-bounds.min[1];
  const center = bounds.min.map((v,i)=>(v+bounds.max[i])/2);
  center[depthAxis] = normal[depthAxis] < 0 ? bounds.min[depthAxis] : bounds.max[depthAxis];
  if (contain) { const meta=await sharp(image).metadata(); const ratio=meta.width/meta.height; if(width/height>ratio)width=height*ratio; else height=width/ratio; }
  if (width<=0 || height<=0) throw new Error('Invalid source sign dimensions');
  const points=[[-1,-1],[1,-1],[1,1],[-1,1]].flatMap(([x,y])=>center.map((c,i)=>c+right[i]*x*width/2+(i===1?y*height/2:0)));
  const buffer=doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  const attribute=(type,data)=>doc.createAccessor().setType(type).setArray(data).setBuffer(buffer);
  const texture=doc.createTexture(name).setImage(image).setMimeType('image/png');
  const material=doc.createMaterial(name).setBaseColorTexture(texture).setBaseColorFactor([1,1,1,1]).setMetallicFactor(0).setRoughnessFactor(1).setAlphaMode('MASK').setAlphaCutoff(0.4).setDoubleSided(false);
  const primitive=doc.createPrimitive().setMaterial(material)
    .setAttribute('POSITION',attribute('VEC3',new Float32Array(points)))
    .setAttribute('NORMAL',attribute('VEC3',new Float32Array([...normal,...normal,...normal,...normal])))
    .setAttribute('TEXCOORD_0',attribute('VEC2',new Float32Array([0,1,1,1,1,0,0,0])))
    // right × up is the outward normal; preserve counter-clockwise winding.
    .setIndices(attribute('SCALAR',new Uint16Array([0,1,2,0,2,3])));
  const node=doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(primitive));
  doc.getRoot().getDefaultScene().addChild(node);
  return {node:name,width,height,imageSha256:sha256(image),normal};
}

/** Call before prune/flatten; plan uses the original source node indices.
 * Every binding is checked before any mutation, so a mismatched source fails closed.
 */
export async function rewriteGeometrySigns(doc, {mapping,plan=mapping,sharp,logoImage,fontFamily} = {}) {
  if (!Array.isArray(plan) || !plan.length || !sharp) throw new Error('Private audited sign plan and sharp are required');
  const sourceNodes=doc.getRoot().listNodes();
  const selected=new Set();
  const resolved=plan.map(item=>{
    if(!Number.isInteger(item.sourceNode)||selected.has(item.sourceNode))throw new Error('Duplicate or invalid source sign binding');
    selected.add(item.sourceNode);
    const node=sourceNodes[item.sourceNode];
    if (!node || node.getName()!==item.sourceName) throw new Error(`Source sign binding mismatch at ${item.sourceNode}`);
    const measured=measureSignNode(node);
    if(!/^[a-f0-9]{64}$/.test(item.geometrySha256??'') || measured.geometrySha256!==item.geometrySha256)throw new Error(`Source sign geometry mismatch at ${item.sourceNode}`);
    if(item.logo && !logoImage)throw new Error('Supplied CRCC logo bytes are required');
    if((item.text||item.logo)&&!validNormal(item.normal))throw new Error('A verified horizontal face normal is required');
    return {item,node,measured};
  });
  // Complete image preparation before changing any source geometry.
  for(const entry of resolved){const {item}=entry;entry.image=item.logo?logoImage:item.text?await createSignTextImage(sharp,item.text,{fontFamily,color:item.color,vertical:item.vertical}):null;}
  const audit=[];
  for(const {item,node,measured,image} of resolved){
    let replacement=null;
    if(image){
      replacement=await addSignImage(doc,image,measured,item.normal,item.replacementName??`CR24_Replaced_Sign_${item.sourceNode}`,{sharp,contain:true});
    }
    // Remove the old lettering mesh itself; no opaque covering is used to hide it.
    node.setMesh(null);
    audit.push({sourceNode:item.sourceNode,sourceName:item.sourceName,sourceText:item.sourceText,removed:measured,replacementText:item.text??null,replacement,removal:'setMesh(null); old mesh/accessors are removed by subsequent prune'});
  }
  return audit;
}

export const rewriteSteelBranding = rewriteGeometrySigns;
