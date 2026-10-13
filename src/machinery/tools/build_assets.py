#!/usr/bin/env python3
"""Pack the reviewed metre/Y-up source arrays without changing their geometry.

Usage: python src/machinery/tools/build_assets.py --source /path/model_data.json
Only the generated output directory is written. Input geometry is never modified.
"""

from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import json
import math
import struct
from pathlib import Path


VERSION = "2026-10-13-v1"
CHUNK_BYTES = 512 * 1024
SECTION_ORDER = ("positions", "indices", "partIds", "palette", "faceColorIndices")


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def decode(model: dict, key: str, item_bytes: int) -> bytes:
    value = base64.b64decode(model[key], validate=True)
    if not value or len(value) % item_bytes:
        raise ValueError(f"{model['id']}: invalid {key} byte length")
    return value


def compact_config(model: dict) -> dict:
    config = copy.deepcopy(model["config"])
    config["type"] = model["type"]
    if model["id"] == "crane":
        # Source FBX is flat-root. A reviewed whole-component mapping supplies
        # articulation without changing the original source arrays or part IDs.
        overlay = json.loads(Path(__file__).with_name("crane_slew_mapping.json").read_text(encoding="utf-8"))
        rotation = overlay["rotation"]
        for key, field in (("source_vertices", "source_positions_sha256"), ("source_indices", "source_indices_sha256"), ("source_part_ids", "source_part_ids_sha256")):
            if sha256(base64.b64decode(model[key], validate=True)) != rotation[field]:
                raise ValueError("Crane slew mapping does not match this source geometry")
        config["parameters"] = [parameter for parameter in config["parameters"] if parameter["key"] != "boom_rotation_deg"] + [overlay["parameter"]]
        config["rotation"] = rotation
        elevation_overlay = json.loads(Path(__file__).with_name("crane_elevation_mapping.json").read_text(encoding="utf-8"))
        elevation = elevation_overlay["elevation"]
        for key, field in (("source_vertices", "source_positions_sha256"), ("source_indices", "source_indices_sha256")):
            if sha256(base64.b64decode(model[key], validate=True)) != elevation[field]:
                raise ValueError("Crane elevation mapping does not match this source geometry")
        config["parameters"] = [parameter for parameter in config["parameters"] if parameter["key"] != "boom_elevation_deg"] + [elevation_overlay["parameter"]]
        config["elevation"] = elevation
        config["limits"][2] = "支持上车水平回转与吊臂仰角几何调整；吊钩保持竖向姿态，未提供吊重和独立吊钩升降控制。"
    # All inputs already use world Y-up metres. These reference planes are
    # derived from the reviewed anchor/body measurement, never a unit conversion.
    reference = config["reference_dimensions"]
    reference["ground_y_m"] = reference["anchor_m"][1]
    reference["body_top_y_m"] = reference["ground_y_m"] + reference["body_height_m"]
    for key in ("source_ranges", "mesh_ranges", "array_contract", "geometry_file"):
        config.pop(key, None)
    for part in config.get("parts", []):
        part.pop("component_ids", None)
    evidence = config.get("reference_dimensions", {}).get("source_evidence")
    if evidence:
        keep = (
            "source_mesh_count", "source_vertex_count", "source_triangle_count",
            "source_coordinate_normalization_applied", "source_unit_conversion_applied_again",
            "measurement_status",
        )
        config["reference_dimensions"]["source_evidence"] = {
            key: evidence[key] for key in keep if key in evidence
        }
    return config


def dimensions(positions: bytes, indices: bytes | None = None) -> dict:
    points = list(struct.iter_unpack("<ddd", positions))
    selected = points if indices is None else (points[i[0]] for i in struct.iter_unpack("<I", indices))
    lower, upper = [math.inf] * 3, [-math.inf] * 3
    for point in selected:
        for axis, value in enumerate(point):
            if not math.isfinite(value):
                raise ValueError("Non-finite source vertex")
            lower[axis] = min(lower[axis], value)
            upper[axis] = max(upper[axis], value)
    return {"min": lower, "max": upper, "size": [upper[i] - lower[i] for i in range(3)]}


def prepare(model: dict) -> tuple[dict, dict[str, bytes], bytes, bytes]:
    positions = decode(model, "source_vertices", 24)
    indices = decode(model, "source_indices", 12)
    part_ids = decode(model, "source_part_ids", 1)
    colors = decode(model, "colors", 36)
    vertex_count, triangle_count = len(positions) // 24, len(indices) // 12
    if vertex_count != model["source_vertex_count"] or triangle_count != model["triangle_count"]:
        raise ValueError(f"{model['id']}: declared geometry count mismatch")
    if len(part_ids) != vertex_count or len(colors) != triangle_count * 36:
        raise ValueError(f"{model['id']}: part/color count mismatch")
    for (index,) in struct.iter_unpack("<I", indices):
        if index >= vertex_count:
            raise ValueError(f"{model['id']}: index outside source vertices")
    palette_entries, palette_lookup, color_indices = [], {}, bytearray()
    for offset in range(0, len(colors), 36):
        rgb = colors[offset:offset + 12]
        if colors[offset + 12:offset + 24] != rgb or colors[offset + 24:offset + 36] != rgb:
            raise ValueError(f"{model['id']}: a triangle has differing corner colors")
        if any(not math.isfinite(v) or not 0 <= v <= 1 for v in struct.unpack("<fff", rgb)):
            raise ValueError(f"{model['id']}: invalid source RGB")
        if rgb not in palette_lookup:
            if len(palette_entries) >= 256:
                raise ValueError(f"{model['id']}: palette exceeds Uint8 capacity")
            palette_lookup[rgb] = len(palette_entries)
            palette_entries.append(rgb)
        color_indices.append(palette_lookup[rgb])
    sections = {
        "positions": positions, "indices": indices, "partIds": part_ids,
        "palette": b"".join(palette_entries), "faceColorIndices": bytes(color_indices),
    }
    packed, arrays = bytearray(), {}
    for name in SECTION_ORDER:
        packed.extend(b"\0" * (-len(packed) % 8))
        arrays[name] = {"offset": len(packed), "byteLength": len(sections[name])}
        packed.extend(sections[name])
    manifest = {
        "schema": "machinery-asset/v1", "version": VERSION,
        "id": model["id"], "name": model["name"], "type": model["type"],
        "config": compact_config(model), "vertexCount": vertex_count,
        "triangleCount": triangle_count, "paletteSize": len(palette_entries),
        "byteLength": len(packed), "arrays": arrays, "chunks": [],
    }
    return manifest, sections, bytes(packed), colors


def verify(directory: Path, manifest: dict, sections: dict[str, bytes], colors: bytes) -> dict:
    chunks = []
    for chunk in manifest["chunks"]:
        blob = (directory / chunk["file"]).read_bytes()
        if len(blob) != chunk["byteLength"] or sha256(blob) != chunk["sha256"]:
            raise ValueError(f"Invalid output chunk: {chunk['file']}")
        if len(blob) > CHUNK_BYTES or len(blob) >= 1024 * 1024:
            raise ValueError("Chunk exceeds configured size")
        chunks.append(blob)
    packed = b"".join(chunks)
    if len(packed) != manifest["byteLength"]:
        raise ValueError("Packed byte length mismatch")
    restored = {}
    exact = {}
    for name in SECTION_ORDER:
        section = manifest["arrays"][name]
        if section["offset"] % 8:
            raise ValueError("Unaligned output section")
        start = section["offset"]
        restored[name] = packed[start:start + section["byteLength"]]
        exact[name] = restored[name] == sections[name]
        if not exact[name]:
            raise ValueError(f"Source array did not round-trip: {name}")
    restored_colors = b"".join(
        restored["palette"][index * 12:index * 12 + 12] * 3
        for index in restored["faceColorIndices"]
    )
    if restored_colors != colors:
        raise ValueError("Expanded material RGB did not round-trip")
    return {
        "sourceArrayBytesExact": exact,
        "expandedMaterialColorsBytesExact": True,
        "allChunkHashesVerified": True,
        "allArrayOffsetsAlignedTo8Bytes": True,
        "sourceBoundsMetres": dimensions(restored["positions"]),
        "renderedBoundsMetres": dimensions(restored["positions"], restored["indices"]),
        "coordinateConvention": "Source world Y-up metres; no recentering, scaling, or axis conversion",
        "sourceArraySha256": {key: sha256(value) for key, value in sections.items()},
        "expandedMaterialColorsSha256": sha256(colors),
        "packedSha256": sha256(packed),
    }


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def main() -> None:
    project = Path(__file__).resolve().parents[3]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=project.parent / "machinery-parametric/model_data.json")
    parser.add_argument("--output", type=Path, default=project / "public/machinery")
    args = parser.parse_args()
    original_file = args.source.read_bytes()
    data = json.loads(original_file)
    if data.get("units") != "m" or data.get("coordinate_system") != "Y-up":
        raise ValueError("Only reviewed metre/Y-up source data is accepted")
    models = data["models"]
    ids = [model["id"] for model in models]
    if len(ids) != len(set(ids)) or any(not value.replace("_", "").isalnum() for value in ids):
        raise ValueError("Invalid or duplicate model id")
    # Validate every source before writing any model.
    prepared = [(model, prepare(model)) for model in models]
    args.output.mkdir(parents=True, exist_ok=True)
    summary = {
        "schema": "machinery-asset-pack-summary/v1", "version": VERSION,
        "sourceFileName": args.source.name, "sourceFileSha256": sha256(original_file),
        "sourceFileByteLength": len(original_file), "chunkSizeBytes": CHUNK_BYTES,
        "sourceGeometryModified": False, "models": [],
    }
    for model, (manifest, sections, packed, colors) in prepared:
        directory = args.output / model["id"]
        directory.mkdir(parents=True, exist_ok=True)
        for index, offset in enumerate(range(0, len(packed), CHUNK_BYTES)):
            blob = packed[offset:offset + CHUNK_BYTES]
            filename = f"chunk-{index:03}.bin"
            (directory / filename).write_bytes(blob)
            manifest["chunks"].append({"file": filename, "byteLength": len(blob), "sha256": sha256(blob)})
        expected = {chunk["file"] for chunk in manifest["chunks"]}
        for old in directory.glob("chunk-*.bin"):
            if old.name not in expected:
                old.unlink()
        write_json(directory / "manifest.json", manifest)
        reloaded = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        validation = verify(directory, reloaded, sections, colors)
        summary["models"].append({
            "id": model["id"], "name": model["name"], "manifest": f"{model['id']}/manifest.json",
            "vertexCount": manifest["vertexCount"], "triangleCount": manifest["triangleCount"],
            "paletteSize": manifest["paletteSize"], "byteLength": len(packed),
            "chunkCount": len(manifest["chunks"]),
            "maximumChunkByteLength": max(chunk["byteLength"] for chunk in manifest["chunks"]),
            "referenceDimensions": model["config"]["reference_dimensions"],
            "validation": validation,
        })
    summary["totalBinaryBytes"] = sum(model["byteLength"] for model in summary["models"])
    summary["allModelsValidated"] = True
    if sha256(args.source.read_bytes()) != summary["sourceFileSha256"]:
        raise ValueError("Input changed during packing")
    write_json(args.output / "pack-summary.json", summary)
    print(json.dumps({
        "output": str(args.output.resolve()), "totalBinaryBytes": summary["totalBinaryBytes"],
        "models": [{key: model[key] for key in ("id", "vertexCount", "triangleCount", "paletteSize", "byteLength", "chunkCount")}
                   for model in summary["models"]], "allModelsValidated": True,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
