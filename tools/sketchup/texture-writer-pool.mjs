// A TextureWriter remembers face handles. Keep different inherited paints in
// separate writers, while allowing the SDK to reuse texture IDs for all faces
// with the same paint. Projected faces still retain the IDs assigned by the SDK.
export class InheritedTextureWriterPool {
  constructor(create, release) {
    this.create = create;
    this.releaseWriter = release;
    this.owners = new Map();
    this.sequence = 0;
  }

  get(owner, material) {
    const ownerKey = owner.ptr.toString();
    let materials = this.owners.get(ownerKey);
    if (!materials) { materials = new Map(); this.owners.set(ownerKey, materials); }
    const materialKey = material.ptr.toString();
    let context = materials.get(materialKey);
    if (!context) {
      context = { writer: this.create(), namespace: `inherited-${++this.sequence}` };
      materials.set(materialKey, context);
    }
    return context;
  }

  release(owner) {
    const ownerKey = owner.ptr.toString();
    const materials = this.owners.get(ownerKey);
    this.owners.delete(ownerKey);
    const errors = [];
    for (const { writer } of materials?.values() ?? []) {
      try { this.releaseWriter(writer); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, '释放继承贴图读取器失败');
  }
}
