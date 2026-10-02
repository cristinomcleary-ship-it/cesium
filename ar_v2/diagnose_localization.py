"""Read-only per-reference re-solving of a saved localization correspondence set.

Run: python -m ar_v2.diagnose_localization --config ar_v2.project.yaml --time 10.01
Only diagnostics/per-reference.json is written. No matching, image extraction,
reference generation or production localization artifact is modified.
"""
from __future__ import annotations
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import time
import cv2
import numpy as np
from .camera import telemetry_camera
from .config import load_config
from .io import load_json, write_json
from .localization import deduplicate_correspondences, solve_correspondences
from .validation import residual_statistics


def _hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _transform(document):
    for key in ("T_camera_from_scene", "T_camera_from_world", "T_world_to_camera"):
        if document.get(key) is not None:
            return np.asarray(document[key], dtype=float).reshape(4, 4)
    raise ValueError("Telemetry prior has no explicit camera-from-world transform.")


def _delta(transform, prior):
    center = np.linalg.inv(transform)[:3, 3]
    prior_center = np.linalg.inv(prior)[:3, 3]
    offset = center - prior_center
    relative_rotation = transform[:3, :3] @ prior[:3, :3].T
    angle = math.degrees(float(np.linalg.norm(cv2.Rodrigues(relative_rotation)[0])))
    return {"center_enu_m": center.tolist(), "center_delta_from_prior_enu_m": offset.tolist(),
            "center_distance_from_prior_m": float(np.linalg.norm(offset)),
            "rotation_angle_from_prior_deg": angle}


def diagnose(config, time_seconds=10.01):
    started = time.perf_counter()
    root = Path(config["output_dir"]).resolve()
    directory = root / "localization" / f"{time_seconds:012.6f}"
    if not directory.is_dir():
        poses = list((root / "localization").glob("*/pose.json"))
        choices = [(abs(float(load_json(path)["time_seconds"])-time_seconds), path.parent) for path in poses]
        if not choices or min(item[0] for item in choices) > .05:
            raise FileNotFoundError(f"No saved localization within 0.05 seconds of {time_seconds}; no new localization was run.")
        directory = min(choices, key=lambda item: item[0])[1]
    pose_path = directory / "pose.json"
    raw_path = directory / "raw_matches.npz"
    manifest_path = root / "references" / "manifest.jsonl"
    paths = [pose_path, raw_path, manifest_path]
    hashes_before = {str(path): _hash(path) for path in paths}
    pose = load_json(pose_path)
    references = [json.loads(line) for line in manifest_path.read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    if any(r.get("geometry_version") != pose.get("geometry_version")
           or r.get("appearance_version") != pose.get("appearance_version") for r in references):
        raise ValueError("Saved raw matches/pose and reference manifest have different scene identities. Do not mix LOD experiments.")
    reference_by_id = {str(row["id"]): row for row in references}
    prior_path = root / "references" / "candidate-prior.json"
    prior_document = load_json(prior_path) if prior_path.is_file() else telemetry_camera(config, pose["time_seconds"])
    prior = _transform(prior_document)
    K = np.asarray(pose["K"], dtype=float).reshape(3, 3)
    distortion = np.asarray(pose.get("distortion", [0, 0, 0, 0, 0]), dtype=float)
    settings = dict(config.get("localization", {}))
    with np.load(raw_path, allow_pickle=False) as archive:
        pixels = archive["video_xy"].copy()
        xyz = archive["scene_xyz"].copy()
        scores = archive["score"].copy()
        ids = archive["reference_id"].astype(str)
        valid = archive["valid_3d"].astype(bool) & np.isfinite(xyz).all(axis=1) & np.isfinite(pixels).all(axis=1)
        reasons = archive["rejection_reason"].astype(str) if "rejection_reason" in archive else np.full(len(xyz), "unknown")
        production_selected = archive["selected_raw_indices"].copy() if "selected_raw_indices" in archive else np.empty(0, dtype=int)
        production_conflicts = archive["conflicting_raw_indices"].copy() if "conflicting_raw_indices" in archive else np.empty(0, dtype=int)
    unknown = set(ids) - set(reference_by_id)
    if unknown:
        raise ValueError(f"Raw matches refer to unknown reference IDs: {sorted(unknown)}")
    rows = []
    for identifier, reference in reference_by_id.items():
        began = time.perf_counter()
        all_indices = np.flatnonzero(ids == identifier)
        valid_indices = np.flatnonzero((ids == identifier) & valid)
        kept, conflicted = deduplicate_correspondences(pixels[valid_indices], xyz[valid_indices],
                                                      scores[valid_indices], settings)
        raw_indices = valid_indices[kept]
        result = solve_correspondences(xyz[raw_indices], pixels[raw_indices], K,
                                       int(pose["width"]), int(pose["height"]),
                                       settings, distortion, checkpoints=None)
        inlier_raw = raw_indices[result["inlier_indices"]]
        finite_residual = result["residuals"][np.isfinite(result["residuals"])]
        record = {"id": identifier, "candidate_offset": reference.get("candidate_offset"),
                  "raw_matches": len(all_indices), "valid_3d_matches": len(valid_indices),
                  "independently_deduplicated_matches": len(raw_indices),
                  "within_reference_conflicts": len(conflicted), "status": result["status"],
                  "reasons": result["reasons"], "metrics": result["metrics"],
                  "all_residuals": residual_statistics(finite_residual, pose["height"]),
                  "T_camera_from_scene": result["T_camera_from_scene"],
                  "inlier_raw_indices": inlier_raw.tolist(),
                  "inliers_rejected_by_production_global_conflicts": len(np.intersect1d(inlier_raw, production_conflicts)),
                  "inliers_retained_by_production_global_selection": len(np.intersect1d(inlier_raw, production_selected)),
                  "lifting_rejections": dict(Counter(reasons[all_indices[~valid[all_indices]]].tolist())),
                  "elapsed_seconds": time.perf_counter()-began}
        if result["T_camera_from_scene"] is not None:
            transform = np.asarray(result["T_camera_from_scene"]).reshape(4, 4)
            record["comparison_to_telemetry_prior"] = _delta(transform, prior)
            record["comparison_to_render_camera"] = _delta(transform, _transform(reference))
        else:
            record["comparison_to_telemetry_prior"] = None
            record["comparison_to_render_camera"] = None
        rows.append(record)
    rows.sort(key=lambda row: (row["status"] == "LOCALIZED", row["metrics"].get("inliers", 0),
                               row["metrics"].get("grid_cells", 0),
                               row["metrics"].get("inlier_ratio", 0)), reverse=True)
    localized = [row for row in rows if row["status"] == "LOCALIZED"]
    all_good_raw = np.unique(np.concatenate([np.asarray(row["inlier_raw_indices"], dtype=int) for row in localized])) if localized else np.empty(0, dtype=int)
    report = {"schema_version": "ar-v2.per-reference-diagnostic.v1",
              "purpose": "Isolate geometric support before cross-reference pooling; no quality thresholds lowered.",
              "output_root": str(root), "time_seconds": pose["time_seconds"],
              "geometry_version": pose.get("geometry_version"), "appearance_version": pose.get("appearance_version"),
              "source_video_hash": pose.get("source_video_hash"), "camera_profile_id": pose.get("camera_profile_id"),
              "calibration_version": pose.get("calibration_version"), "quality_settings": settings,
              "production_result": {"status": pose["status"], "metrics": pose["metrics"],
                                    "selected_raw_matches": len(production_selected),
                                    "globally_conflicting_raw_matches": len(production_conflicts)},
              "telemetry_prior": {"source": str(prior_path) if prior_path.is_file() else config.get("trajectory_path"),
                                  "prior_only": True, "not_ground_truth": True,
                                  "center_enu_m": np.linalg.inv(prior)[:3, 3].tolist()},
              "summary": {"references": len(rows), "localized_references": len(localized),
                          "best_reference": rows[0]["id"] if rows else None,
                          "best_inliers": rows[0]["metrics"].get("inliers", 0) if rows else 0,
                          "geometrically_qualified_inlier_raw_matches": len(all_good_raw),
                          "qualified_inliers_rejected_by_global_conflicts": len(np.intersect1d(all_good_raw, production_conflicts))},
              "references": rows, "independent_checkpoints_evaluated": False,
              "production_artifacts_modified": False, "source_sha256": hashes_before,
              "elapsed_seconds": time.perf_counter()-started}
    if any(_hash(path) != hashes_before[str(path)] for path in paths):
        raise RuntimeError("A production input changed during diagnosis; report was not committed.")
    output = root / "diagnostics" / "per-reference.json"
    write_json(output, report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="ar_v2.project.yaml")
    parser.add_argument("--time", type=float, default=10.01)
    args = parser.parse_args()
    report = diagnose(load_config(args.config), args.time)
    summary = {**report["summary"], "elapsed_seconds": report["elapsed_seconds"],
               "report": str(Path(report["output_root"]) / "diagnostics" / "per-reference.json"),
               "leaders": [{"id": row["id"], "status": row["status"], "inliers": row["metrics"].get("inliers", 0),
                            "grid_cells": row["metrics"].get("grid_cells", 0),
                            "inlier_ratio": row["metrics"].get("inlier_ratio", 0),
                            "median_px1080": row["metrics"].get("median_px1080"),
                            "lost_to_global_conflicts": row["inliers_rejected_by_production_global_conflicts"],
                            "telemetry_delta": row["comparison_to_telemetry_prior"]} for row in report["references"][:10]]}
    print(json.dumps(summary, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
