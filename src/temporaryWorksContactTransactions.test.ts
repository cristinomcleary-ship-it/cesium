import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Cesium3DTileset, ClippingPolygonCollection, Event, type Viewer } from 'cesium';
import type { TemporaryWorksClippingManager } from './temporaryWorksClipping';
import type { ContactVolume } from './modelContactOcclusion/types';
const root=resolve(import.meta.dirname,'..'),output=join(root,'output/contact-transaction-tests');mkdirSync(output,{recursive:true});
const compiled=join(mkdtempSync(join(output,'manager-')),'manager.mjs');
const boundary=`import {ClippingPolygonCollection} from 'cesium';
export const control={fail:false,attempts:0,volumes:[],destroyed:0};
export class ContactClippingPolygonCollection extends ClippingPolygonCollection {
 constructor(polygons,volumes){super({polygons});this.volumes=volumes;control.volumes=volumes;control.attempts++;}
 prepare(){if(control.fail)throw Error('contact-gpu-allocation-failed');}
 destroy(){control.destroyed++;return super.destroy();}
}`;
const bundled=await build({stdin:{contents:`export {TemporaryWorksClippingManager} from './src/temporaryWorksClipping.ts';export {control} from 'contact-test-boundary';`,resolveDir:root},platform:'node',target:'node24',format:'esm',bundle:true,write:false,packages:'external',plugins:[{name:'contact-boundary',setup(b){
  b.onResolve({filter:/^contact-test-boundary$|^\.\/modelContactOcclusion\/clipping$/},()=>({path:'boundary',namespace:'contact'}));
  b.onLoad({filter:/.*/,namespace:'contact'},()=>({contents:boundary,loader:'js',resolveDir:root}));
}}]});writeFileSync(compiled,bundled.outputFiles[0].text);const code=await import(pathToFileURL(compiled).href);
const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const volume=():ContactVolume=>({geometry:{stats:{sourceTriangles:12}} as ContactVolume['geometry'],worldFromLocal:[...matrix]});
function fixture(){
  Object.assign(code.control,{fail:false,attempts:0,volumes:[],destroyed:0});const event=new Event();
  const viewer={scene:{context:{webgl2:true,_gl:{}},postUpdate:event,requestRender(){}},isDestroyed:()=>false} as unknown as Viewer;
  const manager:TemporaryWorksClippingManager=new code.TemporaryWorksClippingManager(viewer),a=new Cesium3DTileset({}),b=new Cesium3DTileset({});
  const first=manager.createContactScope('first'),second=manager.createContactScope('second');
  const put=(scope=first,tileset=a)=>scope.upsert({id:'model',tileset,volume:volume()});
  const legacy=()=>manager.upsert({id:'legacy',tileset:a,footprints:[{outer:[{longitude:121,latitude:31},{longitude:121.001,latitude:31},{longitude:121.001,latitude:31.001}]}]});
  return{manager,a,b,first,second,event,put,legacy,close(){code.control.fail=false;first.dispose();second.dispose();manager.clear();manager.dispose();a.destroy();b.destroy();}};
}
test('three-dimensional model contributions have no footprint and multiple models remain separate union terms',()=>{
  const f=fixture();try{f.put();assert.equal(f.a.clippingPolygons.length,0);assert.equal(code.control.volumes.length,1);f.put(f.second);assert.equal(code.control.volumes.length,2);
    f.legacy();assert.equal(f.a.clippingPolygons.length,1);assert.equal(code.control.volumes.length,2);f.first.clear();assert.equal(code.control.volumes.length,1);assert.equal(f.second.getStatus('model')?.state,'active');
    f.second.clear();assert.equal(f.a.clippingPolygons.length,1);assert.equal(f.manager.getStatus('legacy')?.state,'active');
  }finally{f.close();}
});
test('failed initial GPU allocation or pose replacement preserves committed state without retrying every frame',()=>{
  for(const seeded of [false,true]){const f=fixture();try{f.legacy();if(seeded)f.put();const before=f.a.clippingPolygons,status=f.first.getStatus('model');code.control.fail=true;
    assert.throws(()=>f.put(),/contact-gpu/);assert.equal(f.a.clippingPolygons,before);assert.equal(before.isDestroyed(),false);assert.deepEqual(f.first.getStatus('model'),status);
    const attempts=code.control.attempts;f.event.raiseEvent();f.event.raiseEvent();assert.equal(code.control.attempts,attempts);
  }finally{f.close();}}
});
test('failed target migration preserves old target and exact contribution',()=>{const f=fixture();try{f.put();const before=f.a.clippingPolygons;code.control.fail=true;
  assert.throws(()=>f.put(f.first,f.b),/contact-gpu/);assert.equal(f.a.clippingPolygons,before);assert.equal(f.b.clippingPolygons,undefined);assert.equal(f.first.getStatus('model')?.state,'active');
}finally{f.close();}});
test('removing one model rolls back if the remaining combined GPU resource cannot be prepared',()=>{const f=fixture();try{f.put();f.put(f.second);const before=f.a.clippingPolygons;code.control.fail=true;
  assert.throws(()=>f.first.remove('model'),/contact-gpu/);assert.equal(f.a.clippingPolygons,before);assert.equal(f.first.getStatus('model')?.state,'active');assert.equal(f.second.getStatus('model')?.state,'active');
}finally{f.close();}});

test('authoritative dispose withdraws a revoked model after GPU failure and blocks remaining owners until an explicit bounded retry',()=>{const f=fixture();try{
  f.legacy();f.put();f.put(f.second);const before=f.a.clippingPolygons;code.control.fail=true;
  assert.doesNotThrow(()=>f.first.dispose());assert.equal(f.first.getStatus('model'),undefined);assert.equal(f.a.clippingPolygons,undefined);
  assert.equal(before.isDestroyed(),true);assert.equal(f.second.getStatus('model')?.state,'blocked');assert.equal(f.manager.getStatus('legacy')?.state,'blocked');
  assert.match(f.second.getStatus('model')!.message,/尚未生效/);assert.throws(()=>f.put(),/已释放/);
  const attempts=code.control.attempts;for(let i=0;i<40;i++)f.event.raiseEvent();assert.equal(code.control.attempts,attempts,'failed remaining GPU resources do not retry every frame');
  assert.throws(()=>f.put(f.second),/contact-gpu/);const afterRetry=code.control.attempts;
  f.event.raiseEvent();assert.equal(code.control.attempts,afterRetry,'a failed explicit retry remains latched');
  code.control.fail=false;f.event.raiseEvent();assert.equal(f.a.clippingPolygons,undefined,'driver recovery alone is not permission to retry');
  f.put(f.second);assert.equal(f.second.getStatus('model')?.state,'active');assert.equal(f.manager.getStatus('legacy')?.state,'active');
  assert.equal(code.control.volumes.length,1,'revoked model cannot be reconstructed');assert.equal((f.a as {clippingPolygons:ClippingPolygonCollection}).clippingPolygons.length,1,'legacy footprint remains desired and restores');
}finally{f.close();}});

test('forced disposal affects only its photograph and never replaces a foreign clipping owner',()=>{const f=fixture();try{
  f.put();f.put(f.second);const third=f.manager.createContactScope('unrelated');f.put(third,f.b);const other=f.b.clippingPolygons;
  try{code.control.fail=true;f.first.dispose();assert.equal(f.b.clippingPolygons,other);assert.equal(other.isDestroyed(),false);assert.equal(third.getStatus('model')?.state,'active');
    code.control.fail=false;const foreignCollection=new ClippingPolygonCollection({polygons:[]});
    // A foreign replacement is never owned by the failed target's disposal path.
    f.a.clippingPolygons=foreignCollection;f.second.dispose();assert.equal(f.a.clippingPolygons,foreignCollection);assert.equal(foreignCollection.isDestroyed(),false);assert.equal(f.b.clippingPolygons,other);
  }finally{code.control.fail=false;third.dispose();}
}finally{f.close();}});
test('nested underground and global leases pause and restore all three-dimensional and legacy owners',()=>{const f=fixture();try{f.put();f.legacy();const target=f.manager.suspendTarget(f.a,{}),all=f.manager.suspend({});
  assert.equal(f.a.clippingPolygons,undefined);assert.equal(f.first.getStatus('model')?.state,'blocked');target();assert.equal(f.a.clippingPolygons,undefined);all();assert.equal(f.first.getStatus('model')?.state,'active');assert.equal(f.manager.getStatus('legacy')?.state,'active');
}finally{f.close();}});
test('disabled model does not clear the other model or its selection, and pose snapshot is immutable',()=>{const f=fixture();try{const source=volume();f.first.upsert({id:'model',tileset:f.a,volume:source});
  const captured=code.control.volumes[0];(source.worldFromLocal as number[])[12]=100;assert.equal(captured.worldFromLocal[12],0);
  f.put(f.second);f.first.setEnabled(false);assert.equal(f.first.getStatus('model')?.state,'disabled');assert.equal(f.second.getStatus('model')?.state,'active');assert.equal(code.control.volumes.length,1);
  f.first.setEnabled(true);assert.equal(code.control.volumes.length,2);
}finally{f.close();}});
