import bpy
import sys

separator = sys.argv.index("--")
source, target = sys.argv[separator + 1:separator + 3]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=source, use_custom_normals=True)
bpy.ops.export_scene.gltf(filepath=target, export_format="GLB", export_apply=True)
