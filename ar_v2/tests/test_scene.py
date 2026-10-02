"""Synthetic georeferenced fixtures: transforms, LOD, identity and fail-closed."""
import json
import struct
import tempfile
import unittest
from pathlib import Path

import numpy as np

from ar_v2.scene import ScenePreparationError, _parse_glb, prepare_scene


def _fixture_glb(texture=b"\xff\xd8fixture\xff\xd9", node_translation=(0, 0, 0), extra_extension=None):
    position = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype="<f4").tobytes()
    uv = np.array([[0, 0], [1, 0], [0, 1]], dtype="<f4").tobytes()
    indices = np.array([0, 1, 2], dtype="<u2").tobytes()
    binary = position+uv+indices+b"\0\0"+texture
    doc = {"asset": {"version": "2.0"}, "buffers": [{"byteLength": len(binary)}], "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(position)}, {"buffer": 0, "byteOffset": len(position), "byteLength": len(uv)}, {"buffer": 0, "byteOffset": len(position)+len(uv), "byteLength": len(indices)}, {"buffer": 0, "byteOffset": 68, "byteLength": len(texture)}], "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"}, {"bufferView": 1, "componentType": 5126, "count": 3, "type": "VEC2"}, {"bufferView": 2, "componentType": 5123, "count": 3, "type": "SCALAR"}], "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "TEXCOORD_0": 1}, "indices": 2, "material": 0}]}], "nodes": [{"mesh": 0, "translation": list(node_translation)}], "scenes": [{"nodes": [0]}], "scene": 0, "images": [{"bufferView": 3, "mimeType": "image/jpeg"}], "textures": [{"source": 0}], "materials": [{"alphaMode": "MASK", "alphaCutoff": .7, "doubleSided": True, "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0}, "extensions": {"KHR_materials_unlit": {}}}], "extensionsUsed": ["KHR_materials_unlit"]}
    if extra_extension:
        doc["extensionsUsed"].append(extra_extension)
    text = json.dumps(doc).encode()
    text += b" "*(-len(text)%4)
    binary += b"\0"*(-len(binary)%4)
    return struct.pack("<4sII", b"glTF", 2, 28+len(text)+len(binary))+struct.pack("<I4s", len(text), b"JSON")+text+struct.pack("<I4s", len(binary), b"BIN\0")+binary


def _b3dm(path, rtc=(0, 0, 0), **kwargs):
    feature = json.dumps({"RTC_CENTER": list(rtc), "BATCH_LENGTH": 0}).encode()
    feature += b" "*(-(28+len(feature))%8)
    glb = _fixture_glb(**kwargs)
    path.write_bytes(struct.pack("<4s6I", b"b3dm", 1, 28+len(feature)+len(glb), len(feature), 0, 0, 0)+feature+glb)


def _tile(uri=None, error=0, **kwargs):
    result = {"boundingVolume": {"sphere": [0, 0, 0, 100]}, "geometricError": error, **kwargs}
    if uri:
        result["content"] = {"uri": uri}
    return result


def _write_tileset(path, root):
    path.write_text(json.dumps({"asset": {"version": "1.0", "gltfUpAxis": "Y"}, "geometricError": 100, "root": root}), encoding="utf-8")


class SceneTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.config = {"tileset_path": str(self.base/"root.json"), "output_dir": str(self.base/"output"), "origin_wgs84": [0, 0, 0], "scene": {"roi_radius_m": 300, "max_geometric_error": 2}}
        self.root_transform = np.eye(4)
        self.root_transform[0, 3] = 6378137

    def root(self, root):
        root["transform"] = self.root_transform.ravel(order="F").tolist()
        _write_tileset(self.base/"root.json", root)

    def test_external_noncommuting_transforms_rtc_axis_and_node(self):
        _b3dm(self.base/"mesh.b3dm", rtc=(10, 20, 30), node_translation=(2, 3, 4))
        nested = np.array([[0, -1, 0, 7], [1, 0, 0, 11], [0, 0, 1, 13], [0, 0, 0, 1]], dtype=float)
        _write_tileset(self.base/"external.json", _tile("mesh.b3dm", transform=nested.ravel(order="F").tolist()))
        self.root(_tile("external.json"))
        manifest = prepare_scene(self.config)
        with np.load(self.base/"output/scene/geometry.npz") as mesh:
            np.testing.assert_allclose(mesh["vertices"], [[23, 46, -9], [24, 46, -9], [23, 47, -9]], atol=1e-6)
            np.testing.assert_array_equal(mesh["faces"], [[0, 1, 2]])
            self.assertEqual(mesh["vertices"].dtype, np.float64)
            self.assertEqual(mesh["faces"].dtype, np.int32)
        self.assertTrue(manifest["validation"]["passed"])
        chunk = manifest["chunks"][0]
        self.assertEqual(chunk["triangle_offset"], 0)
        gltf, binary = _parse_glb((self.base/"output/scene"/chunk["uri"]).read_bytes())
        self.assertTrue(gltf["materials"][0]["doubleSided"])
        self.assertEqual(gltf["materials"][0]["alphaMode"], "MASK")
        self.assertEqual(gltf["materials"][0]["alphaCutoff"], .7)
        self.assertEqual(gltf["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_0"], 1)
        self.assertIn(b"fixture", binary)
        self.assertNotIn("matrix", gltf["nodes"][0])

    def test_replace_never_duplicates_parent_and_add_preserves_both(self):
        _b3dm(self.base/"parent.b3dm")
        _b3dm(self.base/"child.b3dm")
        for refine, expected in (("REPLACE", 1), ("ADD", 2)):
            self.root(_tile("parent.b3dm", error=10, refine=refine, children=[_tile("child.b3dm")]))
            manifest = prepare_scene(self.config)
            self.assertEqual(len(manifest["chunks"]), expected)
            self.assertEqual(manifest["geometry"]["triangle_count"], expected)
            self.assertEqual([c["triangle_offset"] for c in manifest["chunks"]], list(range(expected)))
        self.config["scene"]["max_geometric_error"] = 10
        self.root(_tile("parent.b3dm", error=10, refine="REPLACE", children=[_tile("child.b3dm")]))
        self.assertEqual(Path(prepare_scene(self.config)["chunks"][0]["source"]).name, "parent.b3dm")

    def test_version_covers_texture_and_lod_and_is_repeatable(self):
        _b3dm(self.base/"mesh.b3dm")
        self.root(_tile("mesh.b3dm"))
        first = prepare_scene(self.config)["geometry_version"]
        self.assertEqual(first, prepare_scene(self.config)["geometry_version"])
        _b3dm(self.base/"mesh.b3dm", texture=b"\xff\xd8changed\xff\xd9")
        second = prepare_scene(self.config)["geometry_version"]
        self.assertNotEqual(first, second)
        self.config["scene"]["max_geometric_error"] = 1
        self.assertNotEqual(second, prepare_scene(self.config)["geometry_version"])

    def test_unsupported_content_fails_and_overwrites_ready_status(self):
        _b3dm(self.base/"mesh.b3dm")
        self.root(_tile("mesh.b3dm"))
        prepare_scene(self.config)
        _b3dm(self.base/"mesh.b3dm", extra_extension="KHR_draco_mesh_compression")
        with self.assertRaisesRegex(ScenePreparationError, "Unsupported glTF"):
            prepare_scene(self.config)
        manifest = json.loads((self.base/"output/scene/scene_manifest.json").read_text())
        self.assertEqual(manifest["status"], "failed")
        self.assertNotIn("geometry_version", manifest)
        self.assertTrue(manifest["issues"])

    def test_missing_external_resource_is_reported(self):
        self.root(_tile("absent.b3dm"))
        with self.assertRaises(ScenePreparationError):
            prepare_scene(self.config)
        manifest = json.loads((self.base/"output/scene/scene_manifest.json").read_text())
        self.assertTrue(manifest["missing"])

    def test_roi_excludes_distant_child(self):
        _b3dm(self.base/"near.b3dm")
        far = _tile("absent_far.b3dm")
        far["boundingVolume"]["sphere"] = [5000, 0, 0, 20]
        self.root(_tile(error=100, children=[_tile("near.b3dm"), far]))
        manifest = prepare_scene(self.config)
        self.assertEqual(len(manifest["chunks"]), 1)



    def test_external_root_inherits_add_refinement(self):
        _b3dm(self.base/"parent.b3dm")
        _b3dm(self.base/"child.b3dm")
        _write_tileset(self.base/"external.json", _tile("parent.b3dm", error=10, children=[_tile("child.b3dm")]))
        self.root(_tile("external.json", refine="ADD"))
        result = prepare_scene(self.config)
        self.assertEqual(len(result["chunks"]), 2)
        self.assertTrue(all(chunk["refine"] == "ADD" for chunk in result["chunks"]))

    def test_appearance_identity_is_bound_to_geometry_and_texture(self):
        _b3dm(self.base/"mesh.b3dm")
        self.root(_tile("mesh.b3dm"))
        before = prepare_scene(self.config)
        _b3dm(self.base/"mesh.b3dm", texture=b"\xff\xd8different\xff\xd9")
        after = prepare_scene(self.config)
        self.assertNotEqual(before["appearance_version"], after["appearance_version"])
        self.assertNotEqual(before["chunks"][0]["appearance_sha256"], after["chunks"][0]["appearance_sha256"])
        self.assertEqual(after["appearance_contract"]["geometry_version"], after["geometry_version"])


if __name__ == "__main__":
    unittest.main()
