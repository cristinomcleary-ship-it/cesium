import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { InheritedTextureWriterPool } from './texture-writer-pool.mjs';

const NO_DATA = 9;
const valid = (ref) => ref && ref.ptr !== null && ref.ptr !== 0n;
const errorNames = ['成功', '空输入', '无效输入', '空输出', '无效输出', '覆盖有效对象', '未知错误', '文件读写失败', '超出范围', '没有数据', '空间不足', 'SDK 异常', '无效 SKP 文件', 'SKP 版本不支持'];

export async function loadSketchupApi(library, { configureWindowsSearch = true } = {}) {
  let koffi;
  try { koffi = (await import('koffi')).default; }
  catch { throw new Error('SKP 后台转换依赖未安装，请在平台目录运行 npm install 后重启'); }
  if (configureWindowsSearch && process.platform === 'win32') {
    // Only this isolated worker's DLL search path is affected.
    const kernel = koffi.load('kernel32.dll');
    const setDirectory = kernel.func('bool __stdcall SetDllDirectoryW(const char16_t *path)');
    if (!setDirectory(dirname(library))) throw new Error('无法设置 SketchUp C SDK 的依赖目录');
  }
  let lib;
  try { lib = koffi.load(library); }
  catch (error) { throw new Error(`无法加载 SketchUp C SDK。请完整复制官方 binaries/sketchup/x64 文件，并安装其要求的 Microsoft Visual C++ x64 运行库。${error.message}`); }
  const Ref = koffi.struct({ ptr: 'void *' });
  const RefPtr = koffi.inout(koffi.pointer(Ref));
  const outSize = koffi.out(koffi.pointer('size_t'));
  const outInt = koffi.out(koffi.pointer('int'));
  const outBool = koffi.out(koffi.pointer('bool'));
  const outDouble = koffi.out(koffi.pointer('double'));
  const outLong = koffi.out(koffi.pointer('long'));
  const functions = new Map();
  const fn = (name, result, args) => {
    if (!functions.has(name)) {
      try { functions.set(name, lib.func(name, result, args)); }
      catch { throw new Error(`SketchUp C SDK 缺少 ${name}，请使用 2021 或更新版本的完整独立 SDK`); }
    }
    return functions.get(name);
  };
  const check = (code, name) => {
    if (code !== 0) throw new Error(`${name}：${errorNames[code] ?? 'SDK 错误'}（${code}）`);
  };
  const reference = (name, value, optional = false) => {
    const output = { ptr: null };
    const code = fn(name, 'int', [Ref, RefPtr])(value, output);
    if (optional && code === NO_DATA) return null;
    check(code, name);
    return valid(output) ? output : null;
  };
  const count = (name, value) => {
    const output = [0]; check(fn(name, 'int', [Ref, outSize])(value, output), name);
    const size = Number(output[0]);
    if (!Number.isSafeInteger(size) || size < 0 || size > 15_000_000) throw new Error('模型元素数量超出转换限制，请拆分模型');
    return size;
  };
  const list = (kind, entities) => {
    const size = count(`SUEntitiesGetNum${kind}`, entities);
    if (!size) return [];
    const buffer = Buffer.alloc(size * koffi.sizeof(Ref)); const written = [0];
    check(fn(`SUEntitiesGet${kind}`, 'int', [Ref, 'size_t', 'void *', outSize])(entities, size, buffer, written), `读取 ${kind}`);
    const actual = Number(written[0]);
    if (actual < 0 || actual > size) throw new Error('SDK 返回了无效元素数量');
    return koffi.decode(buffer, Ref, actual);
  };
  const cast = (name, value) => fn(name, Ref, [Ref])(value);
  const scalar = (name, value, type, initial) => {
    const output = [initial]; check(fn(name, 'int', [Ref, type])(value, output), name); return output[0];
  };
  const transform = (name, value) => {
    const buffer = new Float64Array(16);
    check(fn(name, 'int', [Ref, 'void *'])(value, buffer), name);
    return [...buffer];
  };
  const materialCache = new Map(); const textureCache = new Map(); const imagesByHash = new Map();
  const inheritedWriters = new InheritedTextureWriterPool(
    () => api.createTextureWriter(),
    (writer) => check(fn('SUTextureWriterRelease', 'int', [RefPtr])(writer), '释放贴图读取器'),
  );
  const material = (ref, textureId, writer, scratch, namespace = 'shared') => {
    const referenceKey = valid(ref) ? ref.ptr.toString() : 'default';
    const key = `${referenceKey}:${namespace}:${textureId ?? 'none'}`;
    if (materialCache.has(key)) return materialCache.get(key);
    let rgba = [0.72, 0.74, 0.78, 1]; let transparent = false;
    if (valid(ref)) {
      const colour = Buffer.alloc(4);
      check(fn('SUMaterialGetColor', 'int', [Ref, 'void *'])(ref, colour), '读取材质颜色');
      const useOpacity = scalar('SUMaterialGetUseOpacity', ref, outBool, false);
      const alpha = useOpacity ? scalar('SUMaterialGetOpacity', ref, outDouble, 1) : 1;
      rgba = [colour[0] / 255, colour[1] / 255, colour[2] / 255, Math.max(0, Math.min(1, alpha))];
      transparent = scalar('SUMaterialIsDrawnTransparent', ref, outBool, false);
    }
    let image; let imageKey;
    if (textureId !== undefined && textureId !== null && textureId > 0) {
      const textureKey = `${namespace}:${textureId}`;
      if (!textureCache.has(textureKey)) {
        const path = join(scratch, `texture-${textureId}.png`);
        check(fn('SUTextureWriterWriteTexture', 'int', [Ref, 'long', 'str', 'bool'])(writer, textureId, path, false), '提取 SKP 贴图');
        const bytes = readFileSync(path);
        if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('SDK 导出的贴图不是有效 PNG');
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (!imagesByHash.has(hash)) imagesByHash.set(hash, bytes);
        textureCache.set(textureKey, hash);
      }
      imageKey = textureCache.get(textureKey);
      image = imagesByHash.get(imageKey);
    }
    const result = { key: `${referenceKey}:${imageKey ?? 'colour'}`, rgba, transparent, image, imageKey };
    materialCache.set(key, result);
    return result;
  };
  const api = {
    initialize() { fn('SUInitialize', 'void', [])(); },
    terminate() { fn('SUTerminate', 'void', [])(); },
    open(path) {
      const model = { ptr: null }; const status = [0];
      const code = fn('SUModelCreateFromFileWithStatus', 'int', [RefPtr, 'str', outInt])(model, path, status);
      if (code !== 0 || status[0] !== 0) {
        if (valid(model)) api.releaseModel(model);
        if (status[0] !== 0 && code === 0) throw new Error('SKP 文件由更新版本保存，请更新 C SDK 后再导入，避免缺失模型内容');
        check(code, '读取 SKP');
      }
      return model;
    },
    releaseModel(model) { check(fn('SUModelRelease', 'int', [RefPtr])(model), '释放模型'); },
    createTextureWriter() { const writer = { ptr: null }; check(fn('SUTextureWriterCreate', 'int', [RefPtr])(writer), '创建贴图读取器'); return writer; },
    releaseTextureWriter(writer) {
      try { inheritedWriters.release(writer); }
      finally { check(fn('SUTextureWriterRelease', 'int', [RefPtr])(writer), '释放贴图读取器'); }
    },
    entities(model) { return reference('SUModelGetEntities', model); },
    faces(entities) { return list('Faces', entities); },
    groups(entities) { return list('Groups', entities); },
    instances(entities) { return list('Instances', entities); },
    omissions(entities) {
      const messages = [];
      if (count('SUEntitiesGetNumImages', entities)) messages.push('独立图片实体未转换；贴在面上的纹理已保留');
      const edges = [0];
      check(fn('SUEntitiesGetNumEdges', 'int', [Ref, 'bool', outSize])(entities, true, edges), '读取独立线条数量');
      if (Number(edges[0]) || count('SUEntitiesGetNumCurves', entities)) messages.push('独立线条/曲线未转换；如需显示请先转为有面的构件');
      if (count('SUEntitiesGetNumTexts', entities) || count('SUEntitiesGetNumDimensions', entities)) messages.push('文字和尺寸标注未转换');
      if (count('SUEntitiesGetNumSectionPlanes', entities)) messages.push('SketchUp 剖切状态未转换，本次导入完整构件几何');
      return messages;
    },
    groupEntities(group) { return reference('SUGroupGetEntities', group); },
    definition(instance) { return reference('SUComponentInstanceGetDefinition', instance); },
    definitionEntities(definition) { return reference('SUComponentDefinitionGetEntities', definition); },
    key(ref) { return ref.ptr.toString(); },
    visible(kind, ref) {
      const element = cast(`SU${kind}ToDrawingElement`, ref);
      if (scalar('SUDrawingElementGetHidden', element, outBool, false)) return false;
      const layer = reference('SUDrawingElementGetLayer', element, true);
      if (!layer) return true;
      if (!scalar('SULayerGetVisibility', layer, outBool, true)) return false;
      let folder = reference('SULayerGetParentLayerFolder', layer, true);
      const seen = new Set();
      while (folder) {
        const key = folder.ptr.toString();
        if (seen.has(key) || seen.size > 128) throw new Error('模型标签文件夹存在循环引用');
        seen.add(key);
        if (!scalar('SULayerFolderGetVisibility', folder, outBool, true)) return false;
        folder = reference('SULayerFolderGetParentLayerFolder', folder, true);
      }
      return true;
    },
    transform(kind, ref) { return transform(`SU${kind}GetTransform`, ref); },
    inheritedMaterial(kind, ref, inherited) {
      const own = reference('SUDrawingElementGetMaterial', cast(`SU${kind}ToDrawingElement`, ref), true);
      return own ?? inherited;
    },
    face(face, inherited, writer, scratch) {
      const originalFront = reference('SUFaceGetFrontMaterial', face, true);
      const originalBack = reference('SUFaceGetBackMaterial', face, true);
      const applyFront = !originalFront && valid(inherited);
      const applyBack = !originalBack && valid(inherited);
      const setMaterial = (side, value) => check(fn(`SUFaceSet${side}Material`, 'int', [Ref, Ref])(face, value ?? { ptr: null }), `设置 ${side} 材质`);
      let namespace = 'shared';
      // Expand an inherited material only in the transient SDK model, then restore
      // it. SDK computes its default/projected UVs; repeated component instances
      // with different paints do not contaminate each other. The input is never saved.
      try {
      // Scope the writer by inherited paint, not by face. Different instances
      // cannot contaminate one another, and repeated ordinary textures are
      // encoded once. The SDK still assigns separate IDs to projected textures.
      if ((applyFront || applyBack) && reference('SUMaterialGetTexture', inherited, true)) {
        const context = inheritedWriters.get(writer, inherited);
        writer = context.writer; namespace = context.namespace;
      }
      if (applyFront) setMaterial('Front', inherited);
      if (applyBack) setMaterial('Back', inherited);
      const front = originalFront ?? inherited;
      const back = originalBack ?? inherited;
      const frontTexture = [-1]; const backTexture = [-1];
      const textureCode = fn('SUTextureWriterLoadFace', 'int', [Ref, Ref, outLong, outLong])(writer, face, frontTexture, backTexture);
      if (textureCode !== 0 && textureCode !== 6) check(textureCode, '读取面贴图');
      const mesh = { ptr: null };
      // Write projected textures before asking the helper for corrected UVs.
      const frontMaterial = material(front ?? inherited, frontTexture[0], writer, scratch, namespace);
      const backMaterial = back ? material(back, backTexture[0], writer, scratch, namespace) : null;
      check(fn('SUMeshHelperCreateWithTextureWriter', 'int', [RefPtr, Ref, Ref])(mesh, face, writer), '三角化 SKP 面');
      try {
        const vertices = count('SUMeshHelperGetNumVertices', mesh);
        const triangles = count('SUMeshHelperGetNumTriangles', mesh);
        if (!vertices || !triangles) return null;
        const vector = (name) => {
          const values = new Float64Array(vertices * 3); const actual = [0];
          check(fn(name, 'int', [Ref, 'size_t', 'void *', outSize])(mesh, vertices, values, actual), name);
          if (Number(actual[0]) !== vertices) throw new Error('SDK 返回了不完整的网格属性');
          return values;
        };
        const indicesBuffer = Buffer.alloc(triangles * 3 * koffi.sizeof('size_t')); const actual = [0];
        check(fn('SUMeshHelperGetVertexIndices', 'int', [Ref, 'size_t', 'void *', outSize])(mesh, triangles * 3, indicesBuffer, actual), '读取三角面索引');
        if (Number(actual[0]) !== triangles * 3) throw new Error('SDK 返回了不完整的三角面索引');
        return {
          mesh: { positions: vector('SUMeshHelperGetVertices'), normals: vector('SUMeshHelperGetNormals'), indices: Array.from(koffi.decode(indicesBuffer, 'size_t', triangles * 3), Number), frontUV: frontMaterial.image ? vector('SUMeshHelperGetFrontSTQCoords') : null, backUV: backMaterial?.image ? vector('SUMeshHelperGetBackSTQCoords') : null },
          front: frontMaterial,
          back: backMaterial,
        };
      } finally { check(fn('SUMeshHelperRelease', 'int', [RefPtr])(mesh), '释放网格'); }
      } finally {
        try { if (applyFront) setMaterial('Front', originalFront); }
        finally { if (applyBack) setMaterial('Back', originalBack); }
      }
    },
  };
  return api;
}
