import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { findSketchupSdk } from '../tools/sketchup-sdk-runtime.mjs';
import { GlbWriter, IDENTITY, multiply, transformPoint } from '../tools/sketchup/glb-writer.mjs';
import { convertSketchup } from '../tools/sketchup/convert.mjs';
import { loadSketchupApi } from '../tools/sketchup/sdk-api.mjs';

const mesh = { positions: [0, 0, 0, 100, 0, 0, 0, 100, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] };
const material = { key: 'red', rgba: [1, 0, 0, 1] };
const translated = (x, y, z) => [...IDENTITY.slice(0, 12), x, y, z, 1];
function decode(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const jsonSize = bytes.readUInt32LE(12);
  const doc = JSON.parse(bytes.subarray(20, 20 + jsonSize).toString());
  const binary = bytes.subarray(28 + jsonSize);
  const attribute = (name, primitive = 0) => {
    const accessor = doc.accessors[doc.meshes[0].primitives[primitive].attributes[name]];
    const view = doc.bufferViews[accessor.bufferView]; const width = Number(accessor.type.slice(3));
    return Array.from({ length: accessor.count * width }, (_, i) => binary.readFloatLE(view.byteOffset + i * 4));
  };
  return { doc, binary, attribute };
}
function approximately(actual, expected, eps = 1e-5) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < eps, `${value} != ${expected[i]}`));
}

test('metres, Y-up, footprint centre and bottom height survive far-away survey coordinates', () => {
  const writer = new GlbWriter();
  writer.addFace(mesh, translated(1e10, 2e10, 500), material);
  const result = decode(writer.finish().bytes);
  approximately(result.attribute('POSITION'), [-1.27, 0, 1.27, 1.27, 0, 1.27, -1.27, 0, -1.27]);
  approximately(result.attribute('NORMAL'), [0, 1, 0, 0, 1, 0, 0, 1, 0]);
  assert.equal(result.doc.extras.placementAnchor, 'bottom-centre');
});

test('nested matrices, nonuniform scale, rotated normals and mirrored winding stay correct', () => {
  const rotation = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  approximately(transformPoint(multiply(translated(10, 20, 30), rotation), [1, 2, 3]), [8, 21, 33]);
  const writer = new GlbWriter();
  const yz = { positions: [0, 0, 0, 0, 1, 0, 0, 0, 1], normals: [1, 0, 0, 1, 0, 0, 1, 0, 0], indices: [0, 1, 2] };
  writer.addFace(yz, rotation, material);
  approximately(decode(writer.finish().bytes).attribute('NORMAL'), [0, 0, -1, 0, 0, -1, 0, 0, -1]);
  const mirrored = new GlbWriter();
  mirrored.addFace(mesh, [-2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], material);
  const result = decode(mirrored.finish().bytes);
  const p = result.attribute('POSITION'); const n = result.attribute('NORMAL');
  const a = p.slice(0, 3), b = p.slice(3, 6), c = p.slice(6, 9);
  const crossY = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  assert.ok(crossY * n[1] > 0);
});

test('embedded texture/UV and distinct back face are retained in a complete GLB', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
  const textured = { ...mesh, frontUV: [0, 0, 1, 1, 0, 1, 0, 1, 1], backUV: [0, 0, 1, 0, 1, 1, 1, 0, 1] };
  const writer = new GlbWriter();
  writer.addFace(textured, IDENTITY, { ...material, image: png }, { doubleSided: false });
  writer.addFace(textured, IDENTITY, { key: 'blue', rgba: [0, 0, 1, 0.5] }, { back: true, doubleSided: false });
  const result = decode(writer.finish().bytes);
  assert.equal(result.doc.images[0].mimeType, 'image/png');
  const view = result.doc.bufferViews[result.doc.images[0].bufferView];
  assert.deepEqual(result.binary.subarray(view.byteOffset, view.byteOffset + view.byteLength), png);
  approximately(result.attribute('TEXCOORD_0'), [0, 1, 1, 1, 0, 0]);
  assert.equal(result.doc.meshes[0].primitives.length, 2);
  assert.equal(result.doc.materials[1].alphaMode, 'BLEND');
  approximately(result.attribute('NORMAL', 1), [0, -1, 0, 0, -1, 0, 0, -1, 0]);
});

function fakeApi() {
  const calls = [];
  return {
    calls,
    initialize() { calls.push('initialize'); }, terminate() { calls.push('terminate'); },
    open() { return 'model'; }, releaseModel() { calls.push('releaseModel'); },
    createTextureWriter() { return 'textures'; }, releaseTextureWriter() { calls.push('releaseTextures'); },
    entities() { return 'root'; }, omissions() { return []; },
    faces(entities) { return entities === 'definition' ? ['face', 'hidden'] : []; },
    groups(entities) { return entities === 'root' ? ['group'] : []; },
    groupEntities() { return 'groupEntities'; },
    instances(entities) { return entities === 'groupEntities' ? ['a', 'b'] : []; },
    definition() { return 'sharedDefinition'; }, definitionEntities() { return 'definition'; }, key(value) { return value; },
    visible(_kind, ref) { return ref !== 'hidden'; },
    transform(kind, ref) { return kind === 'Group' ? translated(1000, 2000, 3000) : translated(ref === 'a' ? 0 : 200, 0, 0); },
    inheritedMaterial() { return material; }, face() { return { mesh, front: material, back: null }; },
  };
}

test('every component instance is exported, hidden faces excluded, SDK resources released', () => {
  const api = fakeApi(); const result = convertSketchup(api, 'sample.skp', '.', 'model');
  assert.equal(result.metadata.triangleCount, 2);
  assert.deepEqual(api.calls, ['initialize', 'releaseTextures', 'releaseModel', 'terminate']);
  const p = decode(result.bytes).attribute('POSITION');
  approximately([Math.min(...p.filter((_, i) => i % 3 === 0)), Math.max(...p.filter((_, i) => i % 3 === 0))], [-3.81, 3.81]);
});

test('failed conversion, cycles, empty geometry and invalid inputs do not report success', () => {
  const api = fakeApi(); api.face = () => { throw new Error('bad model'); };
  assert.throws(() => convertSketchup(api, 'sample.skp', '.', 'model'), /bad model/);
  assert.deepEqual(api.calls, ['initialize', 'releaseTextures', 'releaseModel', 'terminate']);
  const cycle = fakeApi(); cycle.instances = () => ['same']; cycle.groups = () => []; cycle.faces = () => [];
  assert.throws(() => convertSketchup(cycle, 'sample.skp', '.', 'model'), /循环引用/);
  assert.throws(() => new GlbWriter().finish(), /没有可显示/);
  const writer = new GlbWriter({ maxTriangles: 1 });
  writer.addFace(mesh, IDENTITY, material);
  assert.throws(() => writer.addFace(mesh, IDENTITY, material), /三角面/);
  assert.throws(() => new GlbWriter().addFace({ ...mesh, indices: [0, 1, 99] }, IDENTITY, material), /索引越界/);
});

test('unsupported entity and section diagnostics are returned once per conversion', () => {
  const api = fakeApi();
  api.omissions = () => ['独立线条/曲线未转换', 'SketchUp 剖切状态未转换'];
  const result = convertSketchup(api, 'sample.skp', '.', 'model');
  assert.deepEqual(result.warnings, ['独立线条/曲线未转换', 'SketchUp 剖切状态未转换']);
});

test('SDK discovery never treats a desktop executable as a headless SDK', () => {
  const directory = mkdtempSync(join(tmpdir(), 'skp-sdk-test-'));
  try {
    mkdirSync(join(directory, 'tools/sketchup-sdk'), { recursive: true });
    writeFileSync(join(directory, 'tools/sketchup-sdk/SketchUp.exe'), 'desktop');
    assert.equal(findSketchupSdk(directory, { platform: 'win32', arch: 'x64' }).available, false);
    writeFileSync(join(directory, 'tools/sketchup-sdk/SketchUpAPI.dll'), 'fixture');
    assert.equal(findSketchupSdk(directory, { platform: 'win32', arch: 'x64' }).available, true);
    assert.equal(findSketchupSdk(directory, { platform: 'linux', arch: 'x64' }).available, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('native FFI marshals SDK-sized structs, output pointers, double buffers and size_t indices', { skip: process.platform !== 'linux' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'skp-native-fixture-'));
  const source = `
    #include <stddef.h>
    #include <stdbool.h>
    #include <string.h>
    typedef struct { void *ptr; } Ref;
    static bool hidden_folder=false;
    void SUInitialize(void) {} void SUTerminate(void) {}
    int SUModelCreateFromFileWithStatus(Ref *r,const char *path,int *s) {r->ptr=(void*)1;*s=0;hidden_folder=strstr(path,"hidden-folder")!=0;return strstr(path,"bad")?12:0;}
    int SUModelRelease(Ref *r) {r->ptr=0;return 0;}
    int SUTextureWriterCreate(Ref *r) {r->ptr=(void*)2;return 0;} int SUTextureWriterRelease(Ref *r) {r->ptr=0;return 0;}
    int SUModelGetEntities(Ref r,Ref *out) {out->ptr=(void*)3;return 0;}
    int SUEntitiesGetNumFaces(Ref r,size_t *n) {*n=1;return 0;} int SUEntitiesGetFaces(Ref r,size_t len,Ref *out,size_t *n) {out[0].ptr=(void*)4;*n=1;return 0;}
    int SUEntitiesGetNumGroups(Ref r,size_t *n) {*n=0;return 0;} int SUEntitiesGetNumInstances(Ref r,size_t *n) {*n=0;return 0;} int SUEntitiesGetNumImages(Ref r,size_t *n) {*n=0;return 0;}
    int SUEntitiesGetNumEdges(Ref r,bool standalone,size_t *n) {*n=0;return standalone?0:2;} int SUEntitiesGetNumCurves(Ref r,size_t *n) {*n=0;return 0;}
    int SUEntitiesGetNumTexts(Ref r,size_t *n) {*n=0;return 0;} int SUEntitiesGetNumDimensions(Ref r,size_t *n) {*n=0;return 0;} int SUEntitiesGetNumSectionPlanes(Ref r,size_t *n) {*n=0;return 0;}
    Ref SUFaceToDrawingElement(Ref r) {return r;}
    int SUDrawingElementGetHidden(Ref r,bool *v) {*v=false;return 0;} int SUDrawingElementGetLayer(Ref r,Ref *out) {out->ptr=(void*)6;return 0;}
    int SULayerGetVisibility(Ref r,bool *v) {*v=true;return 0;} int SULayerGetParentLayerFolder(Ref r,Ref *out) {out->ptr=(void*)7;return 0;}
    int SULayerFolderGetVisibility(Ref r,bool *v) {*v=!hidden_folder;return 0;} int SULayerFolderGetParentLayerFolder(Ref r,Ref *out) {out->ptr=0;return 9;}
    int SUFaceGetFrontMaterial(Ref r,Ref *out) {out->ptr=0;return 0;} int SUFaceGetBackMaterial(Ref r,Ref *out) {out->ptr=0;return 0;}
    int SUTextureWriterLoadFace(Ref w,Ref f,long *front,long *back) {*front=-1;*back=-1;return 6;}
    int SUMeshHelperCreateWithTextureWriter(Ref *out,Ref face,Ref w) {out->ptr=(void*)5;return 0;} int SUMeshHelperRelease(Ref *r) {r->ptr=0;return 0;}
    int SUMeshHelperGetNumVertices(Ref r,size_t *n) {*n=3;return 0;} int SUMeshHelperGetNumTriangles(Ref r,size_t *n) {*n=1;return 0;}
    int SUMeshHelperGetVertexIndices(Ref r,size_t len,size_t *out,size_t *n) {out[0]=0;out[1]=1;out[2]=2;*n=3;return 0;}
    int SUMeshHelperGetVertices(Ref r,size_t len,double *out,size_t *n) {double p[9]={0,0,0,100,0,0,0,100,0};memcpy(out,p,sizeof(p));*n=3;return 0;}
    int SUMeshHelperGetNormals(Ref r,size_t len,double *out,size_t *n) {double p[9]={0,0,1,0,0,1,0,0,1};memcpy(out,p,sizeof(p));*n=3;return 0;}
  `;
  try {
    const file = join(directory, 'fixture.c'); const library = join(directory, 'fixture.so'); writeFileSync(file, source);
    const compiled = spawnSync('cc', ['-shared', '-fPIC', file, '-o', library], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
    const api = await loadSketchupApi(library, { configureWindowsSearch: false });
    const result = convertSketchup(api, 'fixture.skp', directory, 'fixture');
    assert.equal(result.metadata.triangleCount, 1);
    approximately(decode(result.bytes).attribute('POSITION'), [-1.27, 0, 1.27, 1.27, 0, 1.27, -1.27, 0, -1.27]);
    assert.throws(() => convertSketchup(api, 'hidden-folder.skp', directory, 'fixture'), /没有可显示/);
    assert.throws(() => convertSketchup(api, 'bad.skp', directory, 'fixture'), /无效 SKP/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
