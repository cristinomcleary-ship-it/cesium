"""Freeze a local 3D Tiles ROI into one explicitly ENU scene.

Output GLBs deliberately contain numerical ENU POSITION values. GLTFLoader must
load them without an additional Y-up rotation; set camera.up=(0,0,1). They are
application GLBs, not portable Y-up assets. Transform order follows OGC 3D Tiles:
scene_from_ecef @ accumulated_tile @ RTC_CENTER @ y_up_to_z_up @ gltf_node.
All matrices in the manifest are row-major, acting on column vectors.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import math
import struct
from pathlib import Path
from urllib.parse import unquote, urlsplit

import numpy as np

CONVERTER_VERSION = "ar-v2-enu-scene-1"
CONVENTION = "ENU metres baked into POSITION; no loader Y-up correction; +X east,+Y north,+Z up"
_DTYPES = {5120: "i1", 5121: "u1", 5122: "<i2", 5123: "<u2", 5125: "<u4", 5126: "<f4"}
_WIDTHS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


class ScenePreparationError(RuntimeError):
    pass


def _json_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _ecef(lon, lat, height):
    lon, lat = math.radians(lon), math.radians(lat)
    a, e2 = 6378137.0, 6.6943799901413165e-3
    n = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
    return np.array([(n + height) * math.cos(lat) * math.cos(lon), (n + height) * math.cos(lat) * math.sin(lon), (n * (1 - e2) + height) * math.sin(lat)])


def ecef_from_enu(origin_wgs84):
    """WGS84 longitude/latitude degrees and ellipsoid height metres."""
    lon, lat, height = map(float, origin_wgs84)
    lr, br = math.radians(lon), math.radians(lat)
    sl, cl, sb, cb = math.sin(lr), math.cos(lr), math.sin(br), math.cos(br)
    result = np.eye(4)
    result[:3, :3] = [[-sl, -sb * cl, cb * cl], [cl, -sb * sl, cb * sl], [0, cb, sb]]
    result[:3, 3] = _ecef(lon, lat, height)
    return result


def _matrix(raw):
    result = np.asarray(raw, dtype=np.float64).reshape(4, 4, order="F")
    if not np.isfinite(result).all() or not np.allclose(result[3], [0, 0, 0, 1]):
        raise ScenePreparationError("Invalid non-affine tile/node transform")
    return result


def _translation(xyz):
    result = np.eye(4)
    result[:3, 3] = xyz
    return result


def _node_matrix(node):
    if "matrix" in node:
        return _matrix(node["matrix"])
    x, y, z, w = node.get("rotation", [0, 0, 0, 1])
    length = math.sqrt(x*x+y*y+z*z+w*w)
    if length == 0:
        raise ScenePreparationError("Zero glTF quaternion")
    x, y, z, w = (v/length for v in (x, y, z, w))
    result = np.eye(4)
    result[:3, :3] = np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)], [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)], [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]]) @ np.diag(node.get("scale", [1, 1, 1]))
    result[:3, 3] = node.get("translation", [0, 0, 0])
    return result


def _points(points, matrix):
    return np.asarray(points, dtype=np.float64) @ matrix[:3, :3].T + matrix[:3, 3]


def _up_matrix(axis):
    axis = axis.upper()
    if axis == "Z":
        return np.eye(4)
    if axis == "Y":
        return np.array([[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1]], dtype=float)
    if axis == "X":
        return np.array([[0, 0, -1, 0], [0, 1, 0, 0], [1, 0, 0, 0], [0, 0, 0, 1]], dtype=float)
    raise ScenePreparationError(f"Unknown gltfUpAxis {axis}")


def _local_path(base, uri):
    parsed = urlsplit(uri.replace("\\", "/"))
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
        raise ScenePreparationError(f"Only local source URIs are supported: {uri}")
    return (base / unquote(parsed.path)).resolve()


class _Sources:
    def __init__(self):
        self.hashes = {}

    def read(self, path):
        path = Path(path).resolve()
        data = path.read_bytes()
        self.hashes[str(path)] = _sha(data)
        return data

    def resource(self, base, uri):
        if uri.startswith("data:"):
            header, payload = uri.split(",", 1)
            if ";base64" not in header:
                raise ScenePreparationError("Only base64 data URIs are supported")
            return base64.b64decode(payload, validate=True)
        return self.read(_local_path(base, uri))


def _roi_intersects(tile, transform, scene_from_ecef, center, radius):
    volume = tile.get("boundingVolume", {})
    if "sphere" in volume:
        sphere = volume["sphere"]
        c = _points([sphere[:3]], scene_from_ecef @ transform)[0]
        r = float(sphere[3]) * np.linalg.norm(transform[:3, :3], ord=2)
    elif "box" in volume:
        box = volume["box"]
        c = _points([box[:3]], scene_from_ecef @ transform)[0]
        axes = np.asarray(box[3:], dtype=float).reshape(3, 3).T
        r = sum(np.linalg.norm(transform[:3, :3] @ axes[:, k]) for k in range(3))
    elif "region" in volume:
        # Region is WGS84 regardless of tile.transform. A conservative globe
        # bound avoids falsely culling large/antimeridian geographic regions.
        west, south, east, north, lo, hi = volume["region"]
        if east < west or max(east-west, north-south) > .05:
            return True
        corners = [_ecef(math.degrees(lon), math.degrees(lat), h) for lon in (west, east) for lat in (south, north) for h in (lo, hi)]
        pts = _points(corners, scene_from_ecef)
        c = pts.mean(axis=0)
        # Curvature safety padding for the spherical chord approximation.
        r = max(np.linalg.norm(pts-c, axis=1)) + 6378137 * max(east-west, north-south)**2
    else:
        return True
    return np.linalg.norm(c-center) <= radius+r


def _select(tileset, sources, scene_from_ecef, opts):
    selected, decisions = [], []
    center = np.asarray(opts.get("roi_center_enu", [0, 0, 0]), dtype=float)
    radius = float(opts.get("roi_radius_m", 300))
    error_limit = float(opts.get("max_geometric_error", 2))
    active = set()

    def external(path, accumulated, inherited_axis, inherited_refine="REPLACE"):
        if path in active:
            raise ScenePreparationError(f"External tileset cycle: {path}")
        active.add(path)
        doc = json.loads(sources.read(path))
        if doc.get("extensionsRequired"):
            raise ScenePreparationError(f"Unsupported required tileset extensions: {doc['extensionsRequired']}")
        axis = doc.get("asset", {}).get("gltfUpAxis", inherited_axis)
        walk(doc["root"], path.parent, accumulated, inherited_refine, axis, str(path)+"#root")
        active.remove(path)

    def walk(tile, base, parent, inherited_refine, axis, key):
        if "implicitTiling" in tile or "3DTILES_implicit_tiling" in tile.get("extensions", {}):
            raise ScenePreparationError(f"Implicit tiling is unsupported: {key}")
        transform = parent @ (_matrix(tile["transform"]) if "transform" in tile else np.eye(4))
        if not _roi_intersects(tile, transform, scene_from_ecef, center, radius):
            return
        refine = tile.get("refine", inherited_refine).upper()
        if refine not in ("ADD", "REPLACE"):
            raise ScenePreparationError(f"Unsupported refinement {refine}")
        contents = tile.get("contents", [tile["content"]] if "content" in tile else [])
        children = tile.get("children", [])
        descend = bool(children) and (not contents or float(tile.get("geometricError", 0)) * np.linalg.norm(transform[:3, :3], ord=2) > error_limit)
        decisions.append({"tile": key, "refine": refine, "geometric_error": tile.get("geometricError", 0), "descend": bool(descend)})
        if contents and (not descend or refine == "ADD"):
            for content in contents:
                uri = content.get("uri", content.get("url"))
                if not uri:
                    raise ScenePreparationError(f"Missing content URI: {key}")
                path = _local_path(base, uri)
                if path.suffix.lower() == ".json":
                    external(path, transform, axis, refine)
                else:
                    selected.append({"path": path, "transform": transform, "up_axis": axis, "tile": key, "refine": refine, "geometric_error": tile.get("geometricError", 0)})
        if descend:
            for i, child in enumerate(children):
                walk(child, base, transform, refine, axis, key+f"/children/{i}")

    external(tileset, np.eye(4), "Y")
    return selected, decisions


def _parse_glb(data):
    if len(data) < 20:
        raise ScenePreparationError("Truncated GLB")
    magic, version, length = struct.unpack_from("<4sII", data)
    if magic != b"glTF" or version != 2 or length > len(data):
        raise ScenePreparationError("Only valid glTF 2.0 GLBs are supported")
    doc, binary, offset = None, b"", 12
    while offset < length:
        size, kind = struct.unpack_from("<I4s", data, offset)
        offset += 8
        chunk = data[offset:offset+size]
        if len(chunk) != size:
            raise ScenePreparationError("Truncated GLB chunk")
        if kind == b"JSON":
            doc = json.loads(chunk.rstrip(b" \x00\r\n\t"))
        elif kind == b"BIN\x00":
            binary = chunk
        offset += size
    if doc is None:
        raise ScenePreparationError("GLB JSON chunk missing")
    return doc, binary


def _parse_content(path, sources):
    data = sources.read(path)
    rtc = np.zeros(3)
    if data[:4] == b"b3dm":
        if len(data) < 28:
            raise ScenePreparationError("Truncated B3DM")
        _, version, length, fj, fb, bj, bb = struct.unpack_from("<4s6I", data)
        if version != 1 or length != len(data):
            raise ScenePreparationError("Only B3DM v1 current 28-byte headers are supported")
        feature = json.loads(data[28:28+fj].rstrip(b" \x00\r\n\t") or b"{}")
        value = feature.get("RTC_CENTER", [0, 0, 0])
        if isinstance(value, dict):
            rtc = np.frombuffer(data, dtype="<f4", count=3, offset=28+fj+int(value["byteOffset"])).astype(float)
        else:
            rtc = np.asarray(value, dtype=float)
        data = data[28+fj+fb+bj+bb:]
    elif data[:4] in (b"i3dm", b"pnts", b"cmpt"):
        raise ScenePreparationError(f"Unsupported tile content {data[:4].decode()}: {path}")
    if data[:4] == b"glTF":
        doc, binary = _parse_glb(data)
    elif path.suffix.lower() == ".gltf":
        doc, binary = json.loads(data), b""
    else:
        raise ScenePreparationError(f"Unsupported content format: {path}")
    if str(doc.get("asset", {}).get("version")) != "2.0":
        raise ScenePreparationError("Only glTF 2.0 is supported")
    # These extensions alter geometry or material decoding and cannot be silently ignored.
    unsupported = {"KHR_draco_mesh_compression", "EXT_meshopt_compression", "CESIUM_RTC", "EXT_mesh_gpu_instancing", "KHR_texture_basisu", "MSFT_texture_dds"}
    found = unsupported.intersection(doc.get("extensionsUsed", []) + doc.get("extensionsRequired", []))
    allowed_required = {"KHR_materials_unlit", "KHR_texture_transform", "KHR_mesh_quantization"}
    found.update(set(doc.get("extensionsRequired", [])) - allowed_required)
    if found or doc.get("skins") or doc.get("animations"):
        raise ScenePreparationError(f"Unsupported glTF feature: {sorted(found)} / skin or animation")
    buffers = [sources.resource(path.parent, b["uri"]) if "uri" in b else binary for b in doc.get("buffers", [])]
    return doc, buffers, rtc


def _accessor(doc, buffers, index):
    acc = doc["accessors"][index]
    dtype = np.dtype(_DTYPES[acc["componentType"]])
    width, count = _WIDTHS[acc["type"]], int(acc["count"])
    if "bufferView" in acc:
        view = doc["bufferViews"][acc["bufferView"]]
        offset = view.get("byteOffset", 0)+acc.get("byteOffset", 0)
        stride = view.get("byteStride", width*dtype.itemsize)
        array = np.ndarray((count, width), dtype=dtype, buffer=buffers[view["buffer"]], offset=offset, strides=(stride, dtype.itemsize)).copy()
    else:
        array = np.zeros((count, width), dtype=dtype)
    if "sparse" in acc:
        sparse = acc["sparse"]
        idx, val = sparse["indices"], sparse["values"]
        iv, vv = doc["bufferViews"][idx["bufferView"]], doc["bufferViews"][val["bufferView"]]
        indices = np.frombuffer(buffers[iv["buffer"]], dtype=_DTYPES[idx["componentType"]], count=sparse["count"], offset=iv.get("byteOffset", 0)+idx.get("byteOffset", 0))
        values = np.frombuffer(buffers[vv["buffer"]], dtype=dtype, count=sparse["count"]*width, offset=vv.get("byteOffset", 0)+val.get("byteOffset", 0)).reshape(-1, width)
        array[indices] = values
    if acc.get("normalized") and dtype.kind in "iu":
        limit = np.iinfo(dtype).max
        array = np.maximum(array.astype(np.float64)/limit, -1) if dtype.kind == "i" else array.astype(np.float64)/limit
    return array


class _Writer:
    def __init__(self, source, buffers, base, sources):
        self.doc = copy.deepcopy(source)
        self.data = bytearray()
        offsets = [self.append(data) for data in buffers]
        for view in self.doc.get("bufferViews", []):
            view["byteOffset"] = view.get("byteOffset", 0)+offsets[view["buffer"]]
            view["buffer"] = 0
        for image in self.doc.get("images", []):
            if "uri" in image:
                uri = image.pop("uri")
                blob = sources.resource(base, uri)
                image["bufferView"] = self.view(blob)
                image.setdefault("mimeType", "image/png" if blob[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg" if blob[:2] == b"\xff\xd8" else "application/octet-stream")
                if image["mimeType"] not in ("image/png", "image/jpeg"):
                    raise ScenePreparationError(f"Unsupported external texture type: {uri}")
        self.doc["meshes"], self.doc["nodes"] = [], []
        self.doc["scenes"], self.doc["scene"] = [{"nodes": []}], 0
        self.doc.pop("animations", None)
        self.doc.pop("skins", None)
        self.doc.setdefault("asset", {})["generator"] = CONVERTER_VERSION
        self.doc["asset"].setdefault("extras", {})["coordinateConvention"] = CONVENTION

    def append(self, blob):
        self.data.extend(b"\x00" * (-len(self.data) % 4))
        offset = len(self.data)
        self.data.extend(blob)
        return offset

    def view(self, blob, target=None):
        view = {"buffer": 0, "byteOffset": self.append(blob), "byteLength": len(blob)}
        if target:
            view["target"] = target
        self.doc.setdefault("bufferViews", []).append(view)
        return len(self.doc["bufferViews"])-1

    def accessor(self, array, kind, component=5126):
        array = np.ascontiguousarray(array, dtype=_DTYPES[component])
        acc = {"bufferView": self.view(array.tobytes(), 34963 if kind == "SCALAR" else 34962), "componentType": component, "count": len(array), "type": kind}
        if kind == "VEC3" and len(array):
            acc.update(min=array.min(axis=0).tolist(), max=array.max(axis=0).tolist())
        self.doc.setdefault("accessors", []).append(acc)
        return len(self.doc["accessors"])-1

    def finish(self):
        self.doc["buffers"] = [{"byteLength": len(self.data)}]
        encoded = _json_bytes(self.doc)
        encoded += b" " * (-len(encoded) % 4)
        self.data.extend(b"\x00" * (-len(self.data) % 4))
        return struct.pack("<4sII", b"glTF", 2, 28+len(encoded)+len(self.data))+struct.pack("<I4s", len(encoded), b"JSON")+encoded+struct.pack("<I4s", len(self.data), b"BIN\x00")+self.data


def _triangles(indices, mode):
    indices = np.asarray(indices, dtype=np.int64).ravel()
    if mode == 4:
        if len(indices) % 3:
            raise ScenePreparationError("TRIANGLES index count is not a multiple of 3")
        return indices.reshape(-1, 3)
    if mode == 5:
        result = np.array([indices[i:i+3] if i % 2 == 0 else indices[[i+1, i, i+2]] for i in range(len(indices)-2)], dtype=np.int64).reshape(-1, 3)
        return result
    if mode == 6:
        return np.array([[indices[0], indices[i], indices[i+1]] for i in range(1, len(indices)-1)], dtype=np.int64).reshape(-1, 3)
    raise ScenePreparationError(f"Unsupported primitive mode {mode}; surface triangles required")


def _appearance_hash(doc, buffers, base, sources):
    """Hash material semantics, image bytes, texture sampling and vertex colour/UV."""
    images = []
    for image in doc.get("images", []):
        if "uri" in image:
            blob = sources.resource(base, image["uri"])
        else:
            view = doc["bufferViews"][image["bufferView"]]
            start = view.get("byteOffset", 0)
            blob = buffers[view["buffer"]][start:start+view["byteLength"]]
        images.append({"sha256": _sha(blob), "mimeType": image.get("mimeType"), "extensions": image.get("extensions", {})})
    attrs = []
    for mesh in doc.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            values = {}
            for semantic, index in primitive.get("attributes", {}).items():
                if semantic.startswith(("TEXCOORD_", "COLOR_")):
                    array = np.ascontiguousarray(_accessor(doc, buffers, index))
                    values[semantic] = {"dtype": array.dtype.str, "shape": list(array.shape), "sha256": _sha(array.tobytes())}
            attrs.append({"material": primitive.get("material"), "attributes": values})
    return _sha(_json_bytes({"materials": doc.get("materials", []), "textures": doc.get("textures", []), "samplers": doc.get("samplers", []), "images": images, "vertex_appearance": attrs}))


def _convert(item, sources, scene_from_ecef, ecef_from_scene):
    doc, buffers, rtc = _parse_content(item["path"], sources)
    writer = _Writer(doc, buffers, item["path"].parent, sources)
    transform = scene_from_ecef @ item["transform"] @ _translation(rtc) @ _up_matrix(item["up_axis"])
    vertices, faces, validations = [], [], []
    offset = 0
    active = set()

    def visit(node_id, parent):
        nonlocal offset
        if node_id in active:
            raise ScenePreparationError("glTF node cycle")
        active.add(node_id)
        node = doc["nodes"][node_id]
        local = parent @ _node_matrix(node)
        full = transform @ local
        if "mesh" in node:
            for primitive_id, primitive in enumerate(doc["meshes"][node["mesh"]]["primitives"]):
                if primitive.get("targets") or "KHR_draco_mesh_compression" in primitive.get("extensions", {}):
                    raise ScenePreparationError("Morph targets/Draco primitives are unsupported")
                positions = _accessor(doc, buffers, primitive["attributes"]["POSITION"]).astype(np.float64)
                enu = _points(positions, full)
                if not np.isfinite(enu).all():
                    raise ScenePreparationError("Nonfinite transformed vertices")
                # The NPZ stores exactly the float32 positions used by WebGL,
                # promoted to float64 for CPU intersections: identical surface.
                baked = enu.astype(np.float32).astype(np.float64)
                indices = _accessor(doc, buffers, primitive["indices"]) if "indices" in primitive else np.arange(len(positions))
                tris = _triangles(indices, primitive.get("mode", 4))
                if len(tris) and (tris.min() < 0 or tris.max() >= len(positions)):
                    raise ScenePreparationError("Out-of-range triangle index")
                reflected = np.linalg.det(full[:3, :3]) < 0
                if reflected:
                    tris = tris[:, [0, 2, 1]]
                output = copy.deepcopy(primitive)
                output["mode"] = 4
                output["attributes"]["POSITION"] = writer.accessor(baked, "VEC3")
                output["indices"] = writer.accessor(tris.astype(np.uint32).ravel(), "SCALAR", 5125)
                for semantic in ("NORMAL", "TANGENT"):
                    if semantic in primitive["attributes"]:
                        value = _accessor(doc, buffers, primitive["attributes"][semantic]).astype(float)
                        xyz = value[:, :3] @ (np.linalg.inv(full[:3, :3]) if semantic == "NORMAL" else full[:3, :3].T)
                        lengths = np.linalg.norm(xyz, axis=1, keepdims=True)
                        xyz = xyz/np.maximum(lengths, 1e-30)
                        if semantic == "TANGENT":
                            xyz = np.column_stack([xyz, value[:, 3] * (-1 if reflected else 1)])
                        output["attributes"][semantic] = writer.accessor(xyz, "VEC3" if semantic == "NORMAL" else "VEC4")
                mesh_id = len(writer.doc["meshes"])
                writer.doc["meshes"].append({"primitives": [output]})
                writer.doc["nodes"].append({"mesh": mesh_id, "name": f"source_node_{node_id}_primitive_{primitive_id}"})
                writer.doc["scenes"][0]["nodes"].append(mesh_id)
                vertices.append(baked)
                faces.append(tris+offset)
                sample_ids = np.unique(np.linspace(0, max(0, len(positions)-1), min(16, len(positions)), dtype=int))
                expected_ecef = _points(_points(_points(positions[sample_ids], local), _up_matrix(item["up_axis"])), _translation(rtc))
                expected_ecef = _points(expected_ecef, item["transform"])
                restored = _points(baked[sample_ids], ecef_from_scene)
                validations.append({"source_node": node_id, "source_primitive": primitive_id, "vertex_indices": sample_ids.tolist(), "max_ecef_error_m": float(np.max(np.linalg.norm(restored-expected_ecef, axis=1))) if len(sample_ids) else 0, "max_float32_error_m": float(np.max(np.linalg.norm(baked-enu, axis=1))) if len(baked) else 0, "scene_from_source": full.ravel().tolist()})
                offset += len(baked)
        for child in node.get("children", []):
            visit(child, local)
        active.remove(node_id)

    for root in doc.get("scenes", [{}])[doc.get("scene", 0)].get("nodes", []):
        visit(root, np.eye(4))
    if not faces or not sum(len(f) for f in faces):
        raise ScenePreparationError(f"Content contains no triangles: {item['path']}")
    return writer.finish(), np.concatenate(vertices), np.concatenate(faces), validations, _appearance_hash(doc, buffers, item["path"].parent, sources)


def prepare_scene(config: dict) -> dict:
    """Write a fixed LOD scene, provenance and a CPU mesh; fail closed on gaps."""
    destination = Path(config["output_dir"]).resolve()/"scene"
    destination.mkdir(parents=True, exist_ok=True)
    (destination/"chunks").mkdir(exist_ok=True)
    manifest_path = destination/"scene_manifest.json"
    sources = _Sources()
    manifest = {"schema_version": 1, "converter_version": CONVERTER_VERSION, "status": "preparing", "coordinateConvention": CONVENTION, "matrix_layout": "row-major", "issues": [], "missing": [], "chunks": []}
    try:
        origin = list(map(float, config["origin_wgs84"]))
        opts = dict(config.get("scene", {}))
        radius = float(opts.get("roi_radius_m", 300))
        if len(origin) != 3 or not np.isfinite(origin).all() or radius <= 0 or not math.isfinite(radius):
            raise ScenePreparationError("Invalid origin or ROI radius")
        matrix = ecef_from_enu(origin)
        inverse = np.linalg.inv(matrix)
        manifest.update(origin_wgs84=origin, T_ecef_from_scene=matrix.ravel().tolist(), T_scene_from_ecef=inverse.ravel().tolist(), selection={"roi_radius_m": radius, "roi_center_enu": opts.get("roi_center_enu", [0, 0, 0]), "max_geometric_error": opts.get("max_geometric_error", 2), "policy": "fixed geometric error; ADD keeps parent; REPLACE selects parent or children exclusively; conservative tile ROI"})
        selected, decisions = _select(Path(config["tileset_path"]).resolve(), sources, inverse, opts)
        if not selected:
            raise ScenePreparationError("ROI selects no model content")
        all_vertices, all_faces, total_vertices, total_faces = [], [], 0, 0
        for index, item in enumerate(selected):
            blob, vertices, faces, validation, appearance_hash = _convert(item, sources, inverse, matrix)
            uri = f"chunks/chunk_{index:05d}.glb"
            (destination/uri).write_bytes(blob)
            bounds = {"min": vertices.min(axis=0).tolist(), "max": vertices.max(axis=0).tolist()}
            manifest["chunks"].append({"uri": uri, "sha256": _sha(blob), "source": str(item["path"]), "source_sha256": sources.hashes[str(item["path"])], "tile": item["tile"], "geometric_error": item["geometric_error"], "refine": item["refine"], "T_ecef_from_tile": item["transform"].ravel().tolist(), "source_gltf_up_axis": item["up_axis"], "vertex_offset": total_vertices, "vertex_count": len(vertices), "triangle_offset": total_faces, "triangle_count": len(faces), "bounds": bounds, "conversion_validation": validation, "appearance_sha256": appearance_hash})
            all_vertices.append(vertices)
            all_faces.append(faces+total_vertices)
            total_vertices += len(vertices)
            total_faces += len(faces)
            try:
                from .io import progress
                progress(config, "prepare_scene", index+1, len(selected), {"triangles": total_faces})
            except ImportError:
                pass
        vertices = np.ascontiguousarray(np.concatenate(all_vertices), dtype=np.float64)
        faces64 = np.concatenate(all_faces)
        if total_vertices >= 2**31:
            raise ScenePreparationError("CPU mesh exceeds int32 index capacity")
        faces = np.ascontiguousarray(faces64, dtype=np.int32)
        geometry_path = destination/"geometry.npz"
        np.savez(geometry_path, vertices=vertices, faces=faces)
        geometry_hash = _sha(vertices.tobytes()+faces.tobytes())
        manifest.update(geometry={"uri": "geometry.npz", "sha256": _sha(geometry_path.read_bytes()), "arrays_sha256": geometry_hash, "vertex_count": len(vertices), "triangle_count": len(faces), "vertices_dtype": "float64 (exact promoted GLB float32)", "faces_dtype": "int32", "triangle_order": "chunks manifest order, flattened glTF node/primitive order, index order"}, bounds={"min": vertices.min(axis=0).tolist(), "max": vertices.max(axis=0).tolist()}, sources=[{"path": key, "sha256": value} for key, value in sorted(sources.hashes.items())], lod_decisions=decisions)
        max_error = max(v["max_ecef_error_m"] for c in manifest["chunks"] for v in c["conversion_validation"])
        max_quantization = max(v["max_float32_error_m"] for c in manifest["chunks"] for v in c["conversion_validation"])
        manifest["validation"] = {"max_sampled_ecef_error_m": max_error, "max_vertex_float32_error_m": max_quantization, "tolerance_m": .01, "passed": max(max_error, max_quantization) <= .01, "vertices_sampled": sum(len(v["vertex_indices"]) for c in manifest["chunks"] for v in c["conversion_validation"])}
        if not manifest["validation"]["passed"]:
            raise ScenePreparationError(f"ENU conversion exceeds 1 cm tolerance: {max_error} m / {max_quantization} m")
        fingerprint = {"converter": CONVERTER_VERSION, "origin": origin, "selection": manifest["selection"], "sources": manifest["sources"], "lod_decisions": decisions, "chunk_sha256": [c["sha256"] for c in manifest["chunks"]], "arrays_sha256": geometry_hash}
        manifest["geometry_version"] = _sha(_json_bytes(fingerprint))
        manifest["appearance_version"] = _sha(_json_bytes({"schema": "ar-v2-appearance-1", "geometry_version": manifest["geometry_version"], "chunks": [c["appearance_sha256"] for c in manifest["chunks"]]}))
        manifest["appearance_contract"] = {"geometry_version": manifest["geometry_version"], "preserved": ["material PBR and extensions", "texture bytes and samplers", "UV and vertex colour", "alphaMode/alphaCutoff", "doubleSided"], "lighting": "renderer configuration must be recorded separately in reference_manifest"}
        manifest["status"] = "ready"
        manifest_path.write_bytes(_json_bytes(manifest))
        return manifest
    except Exception as error:
        manifest["status"] = "failed"
        manifest["issues"].append({"type": type(error).__name__, "message": str(error)})
        if isinstance(error, FileNotFoundError):
            manifest["missing"].append(str(error.filename))
        manifest["sources"] = [{"path": key, "sha256": value} for key, value in sorted(sources.hashes.items())]
        manifest_path.write_bytes(_json_bytes(manifest))
        if isinstance(error, ScenePreparationError):
            raise
        raise ScenePreparationError(str(error)) from error
