import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Matrix4 } from 'cesium';
import { dxf, transform } from './temporary-works-survey.mjs';

// This probe observes actual geometry entering the normal viewer. It neither creates
// a second set of buildings nor reads the reference-dialog Three.js scene.
function attachGeometryProbe(viewer, frame) {
  const state={primitives:[],focus:null};
  window.__standardFacilitySurvey=state;
  const m=frame, coord=(x,y,z,i)=>m[i]*x+m[i+4]*y+m[i+8]*z+m[i+12];
  viewer.scene.primitives.primitiveAdded.addEventListener(primitive=>{
    const instances=primitive.geometryInstances;
    if(!Array.isArray(instances))return;
    const ids=[], extents={},all={vertices:0,min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
    const include=(box,p)=>{
      ++box.vertices;
      for(let j=0;j<3;j++){box.min[j]=Math.min(box.min[j],p[j]);box.max[j]=Math.max(box.max[j],p[j]);}
    };
    for(const instance of instances) {
      if(typeof instance.id!=='string' || !instance.id.startsWith('tw-standard/'))continue;
      ids.push(instance.id);
      const a=instance.geometry.attributes.position.values, role=instance.id.split('/')[2];
      const box=extents[role]??={vertices:0,min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
      for(let k=0;k<a.length;k+=3){
        const p=[0,1,2].map(j=>coord(a[k],a[k+1],a[k+2],j));
        include(all,p);include(box,p);
      }
    }
    if(ids.length)state.primitives.push({primitive,ids,all,extents});
  });
  const fly=viewer.camera.flyToBoundingSphere.bind(viewer.camera);
  viewer.camera.flyToBoundingSphere=(sphere,options)=>{
    const {x,y,z}=sphere.center;
    state.focus={center:[0,1,2].map(j=>coord(x,y,z,j)),radius:sphere.radius};
    return fly(sphere,options);
  };
}

async function removeNewFields(page, id) {
  // Capture how a pad-only record was stored before the placement fields existed.
  await page.evaluate(async id=>{
    const db=await new Promise((ok,fail)=>{
      const req=indexedDB.open('cesium-temporary-works-v1');
      req.onsuccess=()=>ok(req.result);req.onerror=()=>fail(req.error);
    });
    try {
      await new Promise((ok,fail)=>{
        const tx=db.transaction('plans','readwrite'), store=tx.objectStore('plans'), r=store.getAll();
        r.onsuccess=()=>{
          const row=r.result.find(row=>row.id===id);
          if(!row){tx.abort();return;}
          delete row.plan.inputs.facilityMode;delete row.plan.inputs.facilityPlacement;
          store.put(row);
        };
        tx.oncomplete=ok;tx.onabort=()=>fail(tx.error);
      });
    } finally {db.close();}
  },id);
}

export async function verifyStandardFacilities(ctx) {
  const {page,origin,input,selectCad,register,fields,save,stored,row,check,withViewer,output,x,y}=ctx;
  // Approximate the screenshot's CAD rectangle from its exact bounding-box spans and the displayed orientation.
  const theta=Math.atan2(33,93), a=Math.cos(theta), b=Math.sin(theta);
  const dx=55.540,dy=39.925;
  const halfLength=(dx*a-dy*b)/(2*(a*a-b*b)),halfWidth=(dy*a-dx*b)/(2*(a*a-b*b));
  const points=[[-halfLength,-halfWidth],[halfLength,-halfWidth],[halfLength,halfWidth],[-halfLength,halfWidth]]
    .map(([e,n])=>[x+e*a-n*b,y+e*b+n*a]);
  const drawing=dxf('仅含旋转场界.dxf',[{layer:'SITE_BOUNDARY',closed:true,points}]);
  const toLocal=Matrix4.toArray(Matrix4.inverseTransformation(transform,new Matrix4()));
  await page.locator('[data-tab="tiles"]').click();
  await page.locator('#tilesUrl').fill(origin+'/__placement_survey/tileset.json');await page.locator('#loadTiles').click();
  await page.waitForFunction(()=>document.querySelectorAll('#tw-model option').length>=2,undefined,{timeout:90000});
  await page.locator('[data-tab="temporary-works"]').click();
  await withViewer(attachGeometryProbe,toLocal);

  async function configure(kind,name,mode) {
    await input('kind').selectOption(kind);await selectCad('SITE_BOUNDARY',drawing);await register();
    await input('name').fill(name);await input('ref-mode').selectOption('cad');
    if(mode)await input('facility-mode').selectOption(mode);
    await fields({'ref-x':x,'ref-y':y,finished:1,thickness:.2,treatment:.3,grid:5});
  }
  async function place() {
    await input('confirmed').check();await input('place-facility').click();
    await page.waitForFunction(()=>!document.querySelector('#tw-save').disabled ||
      document.querySelector('#tw-status')?.hasAttribute('data-error'),undefined,{timeout:240000});
    assert.equal(await input('save').isDisabled(),false,await input('status').innerText());
  }
  async function findRender(kind){
    return page.evaluate(kind=>{
      const s=window.__standardFacilitySurvey, prefix='tw-standard/'+kind+'/';
      const live=s.primitives.filter(x=>!x.primitive.isDestroyed()&&x.primitive.show&&x.ids.some(id=>id.startsWith(prefix)));
      const c=live.sort((p,q)=>q.ids.length-p.ids.length)[0];
      return c ? {ids:c.ids,all:c.all,extents:c.extents,focus:s.focus,ready:c.primitive.ready} : null;
    },kind);
  }
  async function expectVisible(kind,expected=true) {
    await page.waitForFunction(({kind,expected})=>{
      const found=window.__standardFacilitySurvey.primitives.some(x=>!x.primitive.isDestroyed()&&x.primitive.ready&&x.primitive.show&&x.ids.some(id=>id.startsWith('tw-standard/'+kind+'/')));
      return found===expected;
    },{kind,expected},{timeout:30000});
  }
  const verifyGeometry=(kind,render)=>{
    assert(render?.ready,kind+' solid not emitted and ready');
    const roles=Object.keys(render.extents);
    const main=kind==='steel'?'workshop':'office', body=render.extents[main];
    assert(body&&body.vertices>100,kind+' main building missing: '+roles.join(','));
    assert(render.ids.some(id=>id.startsWith('tw-standard/'+kind+'/'+main+'/roof')),kind+' roof missing');
    assert(render.ids.some(id=>id.endsWith('/signLetter')),kind+' facade inscription missing');
    for(const role of kind==='steel'?['fence','gate']:['flag','parking']) assert(roles.includes(role),'missing '+kind+' '+role+': '+roles.join(','));
    const {min,max}=body;
    // The site datum is about ENU 9m at its centre: synthetic tile z=8 + 1m finish.
    assert(min[2]>6 && min[2]<14 && max[2]>min[2]+2.5 && max[2]<30,JSON.stringify(body));
    for(const j of [0,1]){assert(min[j]>-33 && max[j]<33);assert(max[j]-min[j]>3);}
    assert(Math.abs(render.focus.center[0])<30 && Math.abs(render.focus.center[1])<30 && render.focus.radius>4 && render.focus.radius<55,'locate must target actual compound');
    return {roles,instanceCount:render.ids.length,main:[min,max],focus:render.focus};
  };

  const names={camp:'仅场界 · 驻地',steel:'仅场界 · 钢筋场'};
  const saved={};
  for(const kind of ['camp','steel']){
    await check(names[kind]+'的主场景实体、隐显和保存',async()=>{
      await configure(kind,names[kind]);assert.equal(await input('facility-mode').inputValue(),'standard');
      const picked=await input('building').evaluate(e=>Array.from(e.selectedOptions).filter(o=>o.value).length);assert.equal(picked,0);
      await place();await expectVisible(kind);
      const evidence=verifyGeometry(kind,await findRender(kind));
      await input('draft-visibility').click();await expectVisible(kind,false);
      await input('draft-visibility').click();await expectVisible(kind);
      saved[kind]=await save(names[kind]);assert.equal(saved[kind].inputs.facilityMode,'standard');
      assert.ok(saved[kind].inputs.facilityPlacement,'standard placement missing from saved plan');
      await row(saved[kind].id).locator('[data-tw-action="locate"]').click();
      await page.waitForTimeout(1500);
      await page.locator('#cesiumContainer canvas').first().screenshot({path:join(output,kind+'-on-survey.png')});
      if(kind==='camp')await row(saved[kind].id).locator('[data-tw-action="hide"]').click();
      return {...evidence,id:saved[kind].id,area:saved[kind].metrics.coveredArea};
    });
  }

  await check('旧场坪在原有方案上补建，复核文件和网格、数量保持一致',async()=>{
    await configure('camp','原有驻地场坪','pad');
    // Pad-only placement controls may be hidden; use the ordinary calculate entry.
    await input('confirmed').check();await input('run').click();
    await page.waitForFunction(()=>!document.querySelector('#tw-save').disabled || document.querySelector('#tw-status')?.hasAttribute('data-error'),undefined,{timeout:240000});
    assert.equal(await input('save').isDisabled(),false,await input('status').innerText());
    const old=await save('原有驻地场坪');await removeNewFields(page,old.id);
    await page.reload({waitUntil:'domcontentloaded'});await page.locator('[data-tab="temporary-works"]').click();
    await row(old.id).waitFor({state:'attached'});await row(saved.steel.id).waitFor({state:'attached'});
    const ids=await withViewer(v=>{
      const prim=v.scene.primitives, out=[];
      for(let i=0;i<prim.length;i++){const p=prim.get(i);if(p.show)out.push(...(p._instanceIds??[]).filter(s=>typeof s==='string'&&s.startsWith('tw-standard/')));}
      return [...new Set(out)];
    });
    assert(ids.some(s=>s.startsWith('tw-standard/steel/workshop/')),'saved steel model not restored in main scene');
    assert(!ids.some(s=>s.startsWith('tw-standard/camp/')),'hidden camp or old pad incorrectly rendered');
    await withViewer(attachGeometryProbe,toLocal);
    await row(old.id).locator('[data-tw-action="standardize"]').click();await expectVisible('camp');
    await page.waitForFunction(async id=>{
      const db=await new Promise(ok=>{const r=indexedDB.open('cesium-temporary-works-v1');r.onsuccess=()=>ok(r.result);});
      try{return await new Promise(ok=>{const r=db.transaction('plans').objectStore('plans').getAll();
        r.onsuccess=()=>ok(r.result.find(x=>x.id===id)?.plan.inputs.facilityMode==='standard');});}finally{db.close();}
    },old.id,{timeout:30000});
    const upgraded=await stored('原有驻地场坪');assert.equal(upgraded.id,old.id);
    assert.deepEqual(upgraded.metrics,old.metrics);assert.deepEqual(upgraded.mesh,old.mesh);
    assert.equal(upgraded.inputs.cadName,old.inputs.cadName);
    assert.equal(await page.locator('[data-plan-id]').count(),3);
    const evidence=verifyGeometry('camp',await findRender('camp'));
    return {id:old.id,area:old.metrics.coveredArea,triangles:old.mesh.triangles.length,...evidence};
  });
}
