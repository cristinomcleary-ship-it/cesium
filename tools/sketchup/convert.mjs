import { GlbWriter, IDENTITY, multiply } from './glb-writer.mjs';

// The injected API makes traversal/export verifiable without redistributing the
// proprietary SDK. All native calls are synchronous on this worker's main thread.
export function convertSketchup(api, input, scratch, name) {
  const writer = new GlbWriter();
  const warnings = new Set();
  let model; let textures; let visits = 0;
  api.initialize();
  try {
    model = api.open(input);
    textures = api.createTextureWriter();
    const walk = (entities, transform, inherited, ancestry) => {
      if (++visits > 100_000 || ancestry.size > 128) throw new Error('模型的组件层级或数量过大，请拆分后导入');
      for (const message of api.omissions(entities)) warnings.add(message);
      for (const face of api.faces(entities)) {
        if (!api.visible('Face', face)) continue;
        const data = api.face(face, inherited, textures, scratch);
        if (!data) continue;
        const distinctBack = data.back && data.back.key !== data.front.key;
        writer.addFace(data.mesh, transform, data.front, { doubleSided: !distinctBack });
        if (distinctBack) writer.addFace(data.mesh, transform, data.back, { back: true, doubleSided: false });
      }
      for (const group of api.groups(entities)) {
        if (!api.visible('Group', group)) continue;
        walk(api.groupEntities(group), multiply(transform, api.transform('Group', group)), api.inheritedMaterial('Group', group, inherited), ancestry);
      }
      for (const instance of api.instances(entities)) {
        if (!api.visible('ComponentInstance', instance)) continue;
        const definition = api.definition(instance); const key = api.key(definition);
        if (ancestry.has(key)) throw new Error('模型存在循环引用的组件定义，请修复 SKP 后重新导入');
        const nested = new Set(ancestry); nested.add(key);
        walk(api.definitionEntities(definition), multiply(transform, api.transform('ComponentInstance', instance)), api.inheritedMaterial('ComponentInstance', instance, inherited), nested);
      }
    };
    walk(api.entities(model), IDENTITY, null, new Set());
    const result = writer.finish(name);
    return { ...result, warnings: [...warnings] };
  } finally {
    try { if (textures) api.releaseTextureWriter(textures); }
    finally { try { if (model) api.releaseModel(model); } finally { api.terminate(); } }
  }
}
