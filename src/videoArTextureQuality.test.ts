import assert from 'node:assert/strict';
import test from 'node:test';
import {planVideoTexture,scaleTextureIntrinsics} from './videoArTextureQuality.ts';
test('4K source selects real 1024/1920 dimensions without upsampling',()=>{
 assert.deepEqual(planVideoTexture('economy',3840,2160,false,16384).planned,{width:1024,height:576});
 assert.deepEqual(planVideoTexture('clear',3840,2160,false,16384).planned,{width:1920,height:1080});
 assert.deepEqual(planVideoTexture('clear',640,360,false,16384).planned,{width:640,height:360});
 assert.match(planVideoTexture('clear',640,360,false,16384).downshiftReasons.join(''),/不放大/);
});
test('native inspection only when paused, constrained by GPU edge and atomic transition budget',()=>{
 assert.deepEqual(planVideoTexture('inspection',3840,2160,true,16384).planned,{width:3840,height:2160});
 assert.deepEqual(planVideoTexture('inspection',3840,2160,false,16384).planned,{width:1920,height:1080});
 assert.deepEqual(planVideoTexture('inspection',3840,2160,true,2048).planned,{width:2048,height:1152});
 const memory=planVideoTexture('inspection',7680,4320,true,16384,8*1024*1024);assert.ok(memory.estimatedTransitionBytes!<=8*1024*1024);assert.ok(memory.downshiftReasons.some(x=>x.includes('预算')));
});
test('missing source stays null and unknown device never implies native support',()=>{
 assert.equal(planVideoTexture('clear',0,0,true,null).planned,null);
 assert.deepEqual(planVideoTexture('inspection',3840,2160,true,null).planned,{width:1024,height:576});
 assert.throws(()=>planVideoTexture('unknown' as never,1,1,true,16));
});
test('original and resized K preserve exact normalized UV, including off-center principal point',()=>{
 const k={width:3840,height:2160,fx:2543.7,fy:2545.1,cx:1889.4,cy:1077.3};
 for(const [w,h]of[[1024,576],[1920,1080],[1001,563]]){const scaled=scaleTextureIntrinsics(k,w,h);for(const [x,y]of[[-.3,.2],[0,0],[.4,-.1]]){assert.ok(Math.abs((k.fx*x+k.cx)/k.width-(scaled.fx*x+scaled.cx)/w)<1e-12);assert.ok(Math.abs((k.fy*y+k.cy)/k.height-(scaled.fy*y+scaled.cy)/h)<1e-12);}}
 assert.equal(k.width,3840);assert.throws(()=>scaleTextureIntrinsics(k,0,1));
});
