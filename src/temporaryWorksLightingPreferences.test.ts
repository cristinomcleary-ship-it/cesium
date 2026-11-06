import test from 'node:test';
import assert from 'node:assert/strict';
import { Cartesian3, CustomShaderMode, CustomShaderTranslucencyMode, LightingModel } from 'cesium';
import { clampTemporaryWorksBrightness, createTemporaryWorksGlbLighting } from './temporaryWorksGlbLighting.ts';
import { getEffectiveTemporaryWorksBrightness, loadTemporaryWorksLightingPreferences, saveTemporaryWorksLightingPreferences,
  withTemporaryWorksBrightnessOverride } from './temporaryWorksLightingPreferences.ts';

function storage() {
  const map=new Map<string,string>();
  return {map,getItem:(key:string)=>map.get(key)??null,setItem:(key:string,value:string)=>{map.set(key,value);}};
}

test('brightness preferences round-trip per project and user; object overrides are absolute',()=>{
  const disk=storage(),initial=loadTemporaryWorksLightingPreferences('a',disk);
  assert.equal(initial.globalPercent,100);assert.equal(getEffectiveTemporaryWorksBrightness(initial,'camp'),100);
  const next=withTemporaryWorksBrightnessOverride({...initial,globalPercent:180},'camp',120);
  assert.equal(getEffectiveTemporaryWorksBrightness(next,'camp'),120);assert.equal(getEffectiveTemporaryWorksBrightness(next,'steel'),180);
  saveTemporaryWorksLightingPreferences('a',next,disk,'user-one');
  const restored=loadTemporaryWorksLightingPreferences('a',disk,'user-one');
  assert.equal(restored.globalPercent,180);assert.equal(restored.overrides.camp,120);
  assert.equal(loadTemporaryWorksLightingPreferences('b',disk,'user-one').globalPercent,100);
  assert.equal(loadTemporaryWorksLightingPreferences('a',disk,'user-two').globalPercent,100);
  assert.equal(loadTemporaryWorksLightingPreferences('a',disk).globalPercent,100);
  const reset=withTemporaryWorksBrightnessOverride(restored,'camp',undefined);
  assert.equal(getEffectiveTemporaryWorksBrightness(reset,'camp'),180);assert.equal(restored.overrides.camp,120);
});

test('invalid preference bytes fall back safely; storage failure remains a visible save error',()=>{
  const disk=storage();saveTemporaryWorksLightingPreferences('a',loadTemporaryWorksLightingPreferences('a',disk),disk);
  const key=[...disk.map.keys()][0];
  for(const raw of ['broken','null','[]','{"schemaVersion":2,"globalPercent":199}','{"schemaVersion":1,"globalPercent":"200"}']) {
    disk.map.set(key,raw);assert.equal(loadTemporaryWorksLightingPreferences('a',disk).globalPercent,100);
  }
  disk.map.set(key,'{"schemaVersion":1,"globalPercent":300,"overrides":{"camp":25,"steel":"120","__proto__":150}}');
  const p=loadTemporaryWorksLightingPreferences('a',disk);
  assert.equal(p.globalPercent,200);assert.equal(p.overrides.camp,50);assert.equal(Object.hasOwn(p.overrides,'steel'),false);
  assert.equal(Object.getPrototypeOf(p.overrides),null);assert.equal(p.overrides.__proto__,150);
  assert.throws(()=>saveTemporaryWorksLightingPreferences('a',p,{setItem:()=>{throw new Error('quota');}}),/quota/);
  assert.throws(()=>saveTemporaryWorksLightingPreferences('a',{...p,globalPercent:NaN},disk),/有效数值/);
  assert.equal(loadTemporaryWorksLightingPreferences('a',{getItem:()=>{throw new Error('denied');}}).globalPercent,100);
});

test('shader keeps material/translucency inheritance, fixed world light directions and a single mutable brightness uniform',()=>{
  const controller=createTemporaryWorksGlbLighting({longitude:121,latitude:31,height:12});
  try {
    const shader=controller.shader,source=shader.fragmentShaderText;
    assert.equal(shader.mode,CustomShaderMode.MODIFY_MATERIAL);assert.equal(shader.lightingModel,LightingModel.PBR);
    assert.equal(shader.translucencyMode,CustomShaderTranslucencyMode.INHERIT);assert.equal(shader.vertexShaderText,undefined);
    const key=shader.uniforms.u_twKeyDirectionWC.value as Cartesian3;
    assert.ok(Math.abs(Cartesian3.magnitude(key)-1)<1e-12);
    controller.setBrightness(160);assert.equal(controller.shader,shader);assert.equal(shader.fragmentShaderText,source);
    assert.equal(shader.uniforms.u_twBrightness.value,1.6);assert.equal(controller.setBrightness(160),false);
    assert.equal(shader.uniforms.u_twKeyDirectionWC.value,key);
    controller.setBrightness(400);assert.equal(controller.brightnessPercent,200);
    controller.setBrightness(-5);assert.equal(controller.brightnessPercent,50);
    assert.throws(()=>controller.setBrightness(NaN),/有效数值/);
    assert.equal(clampTemporaryWorksBrightness(100),100);
    controller.destroy();controller.destroy();assert.equal(shader.isDestroyed(),true);
    assert.equal(controller.setBrightness(100),false);
  } finally {controller.destroy();}
});
