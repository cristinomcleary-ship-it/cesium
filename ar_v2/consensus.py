"""Visual-hypothesis consensus over saved, metric model correspondences.

No telemetry is read. A local pose is only a hypothesis; the final pose retains
the original PnP, image-coverage, geometry and residual gates. Its inlier ratio
uses ALL unique valid video observations, including ambiguous and unmatched ones.
"""
from __future__ import annotations
import argparse
import json
import math
from pathlib import Path
import time
import cv2
import numpy as np
from .camera import validate_transform
from .config import load_config
from .io import load_json, write_json
from .localization import deduplicate_correspondences, solve_correspondences
from .validation import project_points, evaluate_checkpoints, checkpoint_acceptance


def observation_groups(raw, settings=None):
    """Cluster identical/nearby video observations once, before pose selection."""
    settings = settings or {}
    pixels = np.asarray(raw["video_xy"], dtype=float).reshape(-1, 2)
    xyz = np.asarray(raw["scene_xyz"], dtype=float).reshape(-1, 3)
    scores = np.asarray(raw["score"], dtype=float).reshape(-1)
    if len(pixels) != len(xyz) or len(scores) != len(xyz):
        raise ValueError("Raw correspondence arrays have different lengths.")
    valid = (np.asarray(raw.get("valid_3d", np.ones(len(xyz))), dtype=bool)
             & np.isfinite(pixels).all(axis=1) & np.isfinite(xyz).all(axis=1) & np.isfinite(scores))
    indices = np.flatnonzero(valid)
    radius = float(settings.get("dedup_pixel_radius", 1.5))
    if radius <= 0:
        raise ValueError("The video-observation grouping radius must be positive.")
    if not len(indices):
        return pixels, xyz, scores, indices, []
    # Each query feature is reused by many renders. Collapse exact duplicates
    # before proximity union to avoid quadratic work in the reference count.
    unique, inverse = np.unique(pixels[indices], axis=0, return_inverse=True)
    parents = np.arange(len(unique))
    buckets = {}
    def find(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i
    for i, point in enumerate(unique):
        cell = tuple(np.floor(point / radius).astype(int))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in buckets.get((cell[0]+dx, cell[1]+dy), []):
                    delta = point-unique[j]
                    if float(delta @ delta) <= radius*radius:
                        parents[find(i)] = find(j)
        buckets.setdefault(cell, []).append(i)
    roots = np.asarray([find(i) for i in range(len(unique))])
    groups = {}
    for raw_index, unique_index in zip(indices, inverse):
        groups.setdefault(int(roots[unique_index]), []).append(int(raw_index))
    return pixels, xyz, scores, indices, [np.asarray(group, dtype=int) for group in groups.values()]


def _anchor_conflict(anchors, tolerance):
    if len(anchors) < 2:
        return False
    extent = np.ptp(anchors, axis=0)
    if np.linalg.norm(extent) <= tolerance:
        return False
    if np.max(extent) > tolerance:
        return True
    # Only the uncertain bounding-box case needs the exact pairwise distances.
    delta = anchors[:, None, :] - anchors[None, :, :]
    return bool(np.any(np.sum(delta*delta, axis=-1) > tolerance*tolerance))


def _compete(pixels, xyz, scores, indices, groups, K, transform, distortion, height, settings):
    projected, depth = project_points(xyz[indices], K, transform, distortion)
    residuals = np.full(len(xyz), np.inf)
    residuals[indices] = np.linalg.norm(projected-pixels[indices], axis=1)
    residuals[indices[depth <= 0]] = np.inf
    threshold = float(settings.get("ransac_px1080", 3.0)) * height / 1080
    tolerance = float(settings.get("anchor_conflict_m", .5))
    selected, ambiguous, unmatched = [], 0, 0
    for group in groups:
        eligible = group[residuals[group] <= threshold]
        if not len(eligible):
            unmatched += 1
            continue
        if _anchor_conflict(xyz[eligible], tolerance):
            ambiguous += 1
            continue
        rank = np.lexsort((eligible, -scores[eligible], residuals[eligible]))
        selected.append(int(eligible[rank[0]]))
    return np.asarray(selected, dtype=int), {"supported_groups": len(selected),
        "ambiguous_groups": ambiguous, "unmatched_groups": unmatched,
        "unique_valid_observations": len(groups)}


def _candidate_transform(candidate, settings):
    if candidate.get("status") not in ("LOCALIZED", "DEGRADED"):
        return None, "candidate_has_no_visual_pose"
    if candidate.get("T_camera_from_scene") is None:
        return None, "candidate_has_no_visual_pose"
    try:
        transform = validate_transform(candidate["T_camera_from_scene"])
    except (ValueError, TypeError):
        return None, "invalid_candidate_rotation_or_transform"
    metrics = candidate.get("metrics", {})
    if metrics.get("inliers", 0) < 6:
        return None, "candidate_has_fewer_than_six_inliers"
    if metrics.get("positive_depth_fraction", 0.0) < settings.get("min_positive_depth_fraction", .99):
        return None, "candidate_has_nonpositive_depth"
    if metrics.get("linearity_ratio", 0.0) < settings.get("min_linearity_ratio", .01):
        return None, "candidate_is_collinear"
    if any(reason in candidate.get("reasons", []) for reason in ("invalid_rotation", "collinear_geometry", "nonpositive_depth")):
        return None, "candidate_failed_rigid_geometry_gate"
    return transform, None


def _global_ratio(assessment, total_observations, selected_count, settings):
    metrics = assessment["metrics"]
    solver_ratio = metrics.get("inlier_ratio", 0.0)
    ratio = metrics.get("inliers", 0)/max(1, total_observations)
    metrics.update({"matches": total_observations, "selected_matches": selected_count,
                    "solver_inlier_ratio": solver_ratio, "inlier_ratio": ratio,
                    "inlier_ratio_denominator": "all_unique_valid_video_observations"})
    if ratio < settings.get("min_inlier_ratio", .2):
        if "low_inlier_ratio" not in assessment["reasons"]:
            assessment["reasons"].append("low_inlier_ratio")
        if assessment["T_camera_from_scene"] is not None:
            assessment["status"] = "DEGRADED"
        assessment["accepted"] = False
    return assessment


def _rank(result):
    metrics = result["assessment"]["metrics"]
    error = metrics.get("median_px1080")
    return (result["assessment"]["status"] == "LOCALIZED", metrics.get("inliers", 0),
            metrics.get("grid_cells", 0), metrics.get("inlier_ratio", 0), -(error if error is not None else 1e30))


def _pose_distance(left, right):
    left, right = np.asarray(left).reshape(4, 4), np.asarray(right).reshape(4, 4)
    distance = float(np.linalg.norm(np.linalg.inv(left)[:3, 3] - np.linalg.inv(right)[:3, 3]))
    angle = math.degrees(float(np.linalg.norm(cv2.Rodrigues(left[:3, :3] @ right[:3, :3].T)[0])))
    return distance, angle


def solve_reference_hypotheses(raw, K, width, height, settings=None, distortion=None, progress_callback=None):
    """Obtain purely visual per-reference PnP candidates without running a matcher."""
    settings = settings or {}
    pixels, xyz, scores, indices, _ = observation_groups(raw, settings)
    reference_ids = np.asarray(raw["reference_id"]).astype(str)
    candidates = []
    identifiers = np.unique(reference_ids)
    for number, identifier in enumerate(identifiers):
        eligible = indices[reference_ids[indices] == identifier]
        selected, conflicts = deduplicate_correspondences(pixels[eligible], xyz[eligible], scores[eligible], settings)
        chosen = eligible[selected]
        assessment = solve_correspondences(xyz[chosen], pixels[chosen], K, width, height,
                                           settings, distortion, checkpoints=None)
        candidates.append({"id": str(identifier), "status": assessment["status"],
            "reasons": assessment["reasons"], "metrics": assessment["metrics"],
            "T_camera_from_scene": assessment["T_camera_from_scene"],
            "selected_raw_indices": chosen.tolist(),
            "inlier_raw_indices": chosen[assessment["inlier_indices"]].tolist(),
            "within_reference_conflicts": len(conflicts)})
        if progress_callback is not None:
            progress_callback(number + 1, len(identifiers))
    return candidates


def select_consensus(raw, hypotheses, K, width, height, settings=None,
                     distortion=None, checkpoints=None):
    """Return selected raw indices, final PnP assessment, and audit diagnostics."""
    started = time.perf_counter()
    settings = settings or {}
    K = np.asarray(K, dtype=float).reshape(3, 3)
    distortion = np.asarray(distortion if distortion is not None else np.zeros(5), dtype=float)
    pixels, xyz, scores, indices, groups = observation_groups(raw, settings)
    results, rejected = [], []
    for number, candidate in enumerate(hypotheses):
        identifier = str(candidate.get("id", number))
        transform, reason = _candidate_transform(candidate, settings)
        if transform is None:
            rejected.append({"id": identifier, "reason": reason})
            continue
        previous_selection = None
        iterations = []
        for iteration in range(2):
            chosen, support = _compete(pixels, xyz, scores, indices, groups, K,
                                       transform, distortion, height, settings)
            assessment = solve_correspondences(xyz[chosen], pixels[chosen], K, width, height,
                                               settings, distortion, checkpoints=None)
            assessment = _global_ratio(assessment, len(groups), len(chosen), settings)
            iterations.append({"iteration": iteration+1, **support, "status": assessment["status"],
                               "inliers": assessment["metrics"].get("inliers", 0),
                               "inlier_ratio": assessment["metrics"]["inlier_ratio"]})
            if assessment["T_camera_from_scene"] is None or np.array_equal(chosen, previous_selection):
                break
            previous_selection = chosen
            transform = np.asarray(assessment["T_camera_from_scene"]).reshape(4, 4)
        results.append({"id": identifier, "selected_raw_indices": chosen,
                        "assessment": assessment, "iterations": iterations, "support": support})
    results.sort(key=_rank, reverse=True)
    if not results:
        assessment = solve_correspondences(np.empty((0, 3)), np.empty((0, 2)), K, width, height,
                                           settings, distortion, checkpoints=None)
        assessment["reasons"] = ["no_valid_visual_hypothesis"]
        assessment = _global_ratio(assessment, len(groups), 0, settings)
        winner = {"id": None, "selected_raw_indices": np.empty(0, dtype=int),
                  "assessment": assessment, "iterations": [], "support": {}}
    else:
        winner = results[0]
    assessment = winner["assessment"]
    competing = []
    # Two well-supported, materially different visual solutions are ambiguous.
    # This is an additional rejection gate; it never relaxes the original gates.
    if assessment["status"] == "LOCALIZED":
        best_inliers = assessment["metrics"]["inliers"]
        for alternative in results[1:]:
            other = alternative["assessment"]
            if other["status"] != "LOCALIZED" or other["metrics"]["inliers"] < .95*best_inliers:
                continue
            distance, angle = _pose_distance(assessment["T_camera_from_scene"], other["T_camera_from_scene"])
            if distance > settings.get("anchor_conflict_m", .5) or angle > .25:
                competing.append({"id": alternative["id"], "translation_m": distance,
                                  "rotation_deg": angle, "inliers": other["metrics"]["inliers"]})
        if competing:
            assessment["status"] = "DEGRADED"
            assessment["accepted"] = False
            assessment["reasons"].append("ambiguous_visual_hypotheses")
    # Held-out checks are evaluated only AFTER candidate ranking/selection.
    if assessment["T_camera_from_scene"] is not None:
        independent = evaluate_checkpoints(checkpoints, K,
            np.asarray(assessment["T_camera_from_scene"]).reshape(4, 4), height, distortion)
        assessment["metrics"]["independent_checkpoints"] = independent
        assessment["accepted"] = assessment["status"] == "LOCALIZED" and checkpoint_acceptance(independent, settings)
    diagnostics = {"schema_version": "ar-v2.consensus.v1", "selected_hypothesis": winner["id"],
        "raw_valid_correspondences": len(indices), "unique_valid_observations": len(groups),
        "denominator_policy": "All unique valid video observations, including unmatched and ambiguous groups.",
        "selected_support": winner["support"], "competing_visual_hypotheses": competing,
        "rejected_hypotheses": rejected, "evaluated_hypotheses": len(results),
        "hypotheses": [{"id": result["id"], "status": result["assessment"]["status"],
                        "reasons": result["assessment"]["reasons"],
                        "metrics": result["assessment"]["metrics"], "iterations": result["iterations"],
                        "T_camera_from_scene": result["assessment"]["T_camera_from_scene"]} for result in results],
        "telemetry_used": False, "checkpoints_used_for_selection_or_solve": False,
        "quality_gates_relaxed": False, "elapsed_seconds": time.perf_counter()-started}
    return {"selected_raw_indices": winner["selected_raw_indices"], "assessment": assessment,
            "diagnostics": diagnostics}


def diagnose_consensus(config, time_seconds=10.01):
    """Offline experiment: read saved raw matches/candidates; write one diagnostic."""
    root = Path(config["output_dir"])
    directory = root / "localization" / f"{time_seconds:012.6f}"
    pose = load_json(directory / "pose.json")
    document = load_json(root / "diagnostics" / "per-reference.json")
    if document.get("time_seconds") != pose["time_seconds"]:
        raise ValueError("Saved hypotheses belong to another original frame")
    from .io import file_hash
    raw_path = directory / "raw_matches.npz"
    expected_hash = document.get("source_sha256", {}).get(str(raw_path))
    if expected_hash is not None and file_hash(raw_path) != expected_hash:
        raise ValueError("Raw correspondences changed since the hypotheses were computed")
    for key in ("geometry_version", "appearance_version", "source_video_hash", "camera_profile_id", "calibration_version"):
        if pose.get(key) != document.get(key):
            raise ValueError(f"Saved hypotheses and raw-match pose disagree on {key}.")
    with np.load(directory / "raw_matches.npz", allow_pickle=False) as archive:
        raw = {key: archive[key].copy() for key in archive.files}
    result = select_consensus(raw, document["references"], pose["K"], pose["width"], pose["height"],
                              config.get("localization", {}), pose.get("distortion"))
    assessment = result["assessment"]
    report = {"schema_version": "ar-v2.consensus-experiment.v1", "time_seconds": pose["time_seconds"],
        "geometry_version": pose.get("geometry_version"), "appearance_version": pose.get("appearance_version"),
        "status": assessment["status"], "reasons": assessment["reasons"], "metrics": assessment["metrics"],
        "T_camera_from_scene": assessment["T_camera_from_scene"],
        "selected_raw_indices": result["selected_raw_indices"].tolist(),
        "inlier_raw_indices": result["selected_raw_indices"][assessment["inlier_indices"]].tolist(),
        "diagnostics": result["diagnostics"], "production_artifacts_modified": False}
    write_json(root / "diagnostics" / "consensus.json", report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="ar_v2.project.yaml")
    parser.add_argument("--time", type=float, default=10.01)
    args = parser.parse_args()
    report = diagnose_consensus(load_config(args.config), args.time)
    print(json.dumps({key: report[key] for key in ("status", "reasons", "metrics")}, indent=2, ensure_ascii=False))
    print(json.dumps({"selected_hypothesis": report["diagnostics"]["selected_hypothesis"],
                      "support": report["diagnostics"]["selected_support"],
                      "elapsed_seconds": report["diagnostics"]["elapsed_seconds"]}, indent=2))


if __name__ == "__main__":
    main()
