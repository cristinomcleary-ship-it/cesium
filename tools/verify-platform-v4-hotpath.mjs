import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
import * as C from 'cesium';
const checks=[];
const globals={Cartesian3:C.Cartesian3,Cartographic:C.Cartographic,SceneMode:C.SceneMode,
  ConstantProperty:C.ConstantProperty,ConstantPositionProperty:C.ConstantPositionProperty,HeightReference:C.HeightReference,
  cartesian:(p,offset=0,result)=>C.Cartesian3.fromDegrees(p.longitude,p.latitude,p.height+offset,undefined,result),
  SPATIAL_BOUNDARY_WIDTH:{normal:3,selected:4}};
// Execute the actual production methods, extracted through TypeScript's AST; no Viewer or mocked GPU result is claimed.
function method(file,className,name){const source=fs.readFileSync(file,'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true),klass=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name.text===className),member=klass.members.find(n=>n.name?.getText(ast)===name);assert.ok(member);const js=ts.transpileModule('class Harness {'+member.getText(ast)+'}',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;return new Function(...Object.keys(globals),js+';return Harness.prototype.'+name)(...Object.values(globals));}
const sample=method('src/safetySceneEffects.ts','SafetySceneEffects','sampleDisplayAnchors'),authoring=method('src/safetySceneEffects.ts','SafetySceneEffects','setAuthoring'),update=method('src/safetySceneEffects.ts','SafetySceneEffects','update'),visibility=method('src/safetySpatialEditor.ts','SafetySpatialEditor','applyVisibility');
globalThis.document={hidden:false};
const camera={positionWC:new C.Cartesian3(1,2,3),directionWC:new C.Cartesian3(0,0,-1)};
const original={longitude:114.25,latitude:30.5,height:20};
const node={id:'cad',position:{...original}},marker={position:new C.ConstantPositionProperty(C.Cartesian3.fromDegrees(114.25,30.5,20)),point:{},label:{}};
let ready=true,calls=0,result=undefined;
const subject={viewer:{scene:{pickPositionSupported:true,mode:C.SceneMode.SCENE3D,requestRender(){}},camera},labelCandidates:['cad'],anchorSamples:new Map(),anchorSurfaceReady:false,anchorCursor:0,anchorCamera:C.Cartesian3.clone(camera.positionWC),anchorDirection:C.Cartesian3.clone(camera.directionWC),nodeVisuals:new Map([['cad',{node,marker}]]),authoring:false,active:true,source:{show:true},applyVisibility(){},layoutLabels(){},presentation:{isSurfaceReady:()=>ready,displaySurfaceHeight(){calls++;if(result==='throw')throw Error('unavailable surface');return result},setAuthoring(){}}};
const savedMarker=marker.position;
for(let i=0;i<50;i++)sample.call(subject);
assert.equal(calls,3);assert.equal(marker.position,savedMarker);assert.deepEqual(node.position,original);checks.push('failed static-view picks stop at three attempts without fabricated marker/source heights');
ready=false;sample.call(subject);ready=true;result='throw';for(let i=0;i<20;i++)sample.call(subject);assert.equal(calls,6);checks.push('not-ready to ready reopens exactly one bounded retry budget, including thrown failures');
ready=false;sample.call(subject);ready=true;result=82;sample.call(subject);assert.equal(calls,9);assert.ok(Math.abs(C.Cartographic.fromCartesian(marker.position.getValue(C.JulianDate.now())).height-83.2)<1e-6);assert.deepEqual(node.position,original);checks.push('late available genuine sampled height refreshes display marker only');
camera.positionWC.x+=2;sample.call(subject);assert.equal(subject.anchorSamples.size,0);sample.call(subject);assert.equal(calls,12);checks.push('camera movement clears exhausted budget and permits resampling');
authoring.call(subject,true);assert.equal(subject.anchorSamples.size,0);sample.call(subject);assert.equal(calls,12);authoring.call(subject,false);sample.call(subject);assert.equal(calls,15);checks.push('authoring suspends unrelated CAD readbacks and closing reopens sampling');
subject.dataset={};subject.state={mode:'presentation',layers:{},timeRange:[0,1]};subject.presentation.update=()=>{throw Error('stop after reset')};
assert.throws(()=>update.call(subject,{...subject.state,mode:'inspection'},{selected:{id:'project'}}),/stop after reset/);assert.equal(subject.anchorSamples.size,0);assert.equal(subject.anchorSurfaceReady,false);checks.push('theme change invalidates prior sampling budget');
subject.nodeVisuals.set('cad',{node:{...node,spatialObjectId:'saved-user-point'},marker});subject.anchorSurfaceReady=true;subject.presentation.displaySurfaceHeight=()=>{throw Error('manual geometry must not sample')};sample.call(subject);assert.equal(subject.anchorSamples.size,0);assert.deepEqual(node.position,original);checks.push('authoritative manual model anchors never enter CAD height adjustment');
const positions=C.Cartesian3.fromDegreesArray([114,30,114.1,30.1]);const entity=new C.Entity({id:'area',polyline:{positions,width:3}});const property=entity.polyline.width;let changes=0;property.definitionChanged.addEventListener(()=>changes++);
const editor={snapshot:{objects:[{id:'area',kind:'construction-area',visible:true}]},entities:new Map([['area',entity]]),layers:{constructionAreas:true},options:{viewer:{scene:{requestRender(){}}}}};
for(let i=0;i<100;i++)visibility.call(editor);assert.equal(entity.polyline.width,property);assert.equal(changes,0);editor.selectedId='area';visibility.call(editor);for(let i=0;i<100;i++)visibility.call(editor);assert.equal(entity.polyline.width,property);assert.equal(changes,1);assert.equal(property.getValue(),4);editor.selectedId=undefined;visibility.call(editor);assert.equal(changes,2);assert.equal(property.getValue(),3);assert.deepEqual(entity.polyline.positions.getValue(C.JulianDate.now()),positions);checks.push('same width retains ConstantProperty without definition events; selection changes width once and leaves geometry intact');
fs.mkdirSync('output/platform-v4',{recursive:true});const report={scope:'CPU execution of production method bodies with deterministic unavailable/available sample stubs, actual Cesium properties; no GPU/performance claims',checks,pass:checks.length,fail:0};fs.writeFileSync('output/platform-v4/hotpath-regression-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
