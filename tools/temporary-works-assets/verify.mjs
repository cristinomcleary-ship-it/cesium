import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import validator from 'gltf-validator';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const directory=path.join(repo,'public/models/temporary-works');
const manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json')));
assert.equal(manifest.schemaVersion,1);
assert.deepEqual(manifest.assets.map(a=>a.id).sort(),['camp','steel','wall']);
const reports=[];
for(const asset of manifest.assets){
 const bytes=await fs.readFile(path.join(repo,'public',asset.url));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256);
 assert.equal(asset.bytes,bytes.length);
 for(let i=0;i<3;i++)assert.ok(Number.isFinite(asset.bounds.min[i])&&asset.bounds.max[i]>asset.bounds.min[i]&&Number.isFinite(asset.anchor[i]));
 assert.equal(asset.upAxis,'Y');assert.ok(asset.footprints.length);
 for(const footprint of asset.footprints){assert.ok(footprint.outer.length>=3);assert.ok(footprint.outer.flat().every(Number.isFinite));}
 if(asset.id==='camp'){
  assert.ok(asset.bounds.max[0]-asset.bounds.min[0]<70,'excluded enormous helper is absent');
  assert.ok(asset.bounds.max[2]-asset.bounds.min[2]<40,'excluded far-away components are absent');
  assert.ok(asset.performance.renderTriangles<2_000_000,'engineering rendering triangle budget');
  assert.ok(asset.performance.draws<=500,'engineering draw-call budget');
 }
 const validation=await validator.validateBytes(new Uint8Array(bytes),{uri:asset.url,maxIssues:50});
 reports.push({id:asset.id,sha256:asset.sha256,bytes:bytes.length,geometryBudget:asset.performance,validation});
 assert.equal(validation.issues.numErrors,0,`${asset.id}: GLTF validator errors: ${JSON.stringify(validation.issues.messages)}`);
 console.log(asset.id,bytes.length,validation.issues.numErrors,'errors',validation.issues.numWarnings,'warnings');
}
await fs.writeFile(path.join(repo,'docs/temporary-works-upgrade/assets-validation.json'),JSON.stringify({validator:validator.version(),reports},null,2)+'\n');
console.log('Asset integrity, dimensions, footprint and validator checks passed.');
