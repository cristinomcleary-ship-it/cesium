# Railway protection worker

`guard.gltf` is an original procedural model for the protection-personnel marker.
It includes a yellow safety helmet, orange vest with reflective strips, navy
workwear, boots, a face, articulated-looking limbs, and a red signal flag.
No external model, texture, font, or downloaded asset is used.

## Coordinate and placement contract

- glTF 2.0, meters, **Y up**, facing **local +Z**.
- Feet rest at **Y = 0**; place the entity at its ground or model-surface position.
- Height: approximately **1.80 m**. The flag does not extend above the helmet.
- The mesh has no root rotation or offset. Cesium handles the glTF Y-up conversion.
- Use the Cesium entity scale/minimumPixelSize controls for legibility; do not
  change the model's floor offset when scaling.
- One mesh, eight opaque material primitives, an embedded binary buffer, and no
  runtime texture requests. The `extras` object contains exact bounds and triangle
  count. Outward winding and normals allow normal backface culling.

## Rebuild

From the repository root, after installing the existing dependencies:

```sh
node tools/build-rail-guard.mjs
```

The generator checks finite coordinates, normal lengths, triangle winding,
accessor byte ranges, human scale, and floor placement before writing the asset.
The geometry is deterministic and can be edited in that script.

## Use and limitations

This is a static visual marker, not a rigged avatar or a surveyed human outline.
It does not define the protection area, personnel clearance, or any safety
assessment. Those remain separate scene data.

The model and generator are original project assets and may be used and modified
with this project without attribution to an external model provider.
