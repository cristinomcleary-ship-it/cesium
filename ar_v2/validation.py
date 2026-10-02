"""Independent AR v2 pose validation; withheld points never enter the solver."""
from __future__ import annotations
import json
from pathlib import Path
from typing import Any
import cv2
import numpy as np


def project_points(xyz, K, transform, distortion=None):
    """Scene ENU metres to OpenCV optical pixels and signed forward depth."""
    xyz = np.asarray(xyz, dtype=np.float64).reshape(-1, 3)
    transform = np.asarray(transform, dtype=np.float64).reshape(4, 4)
    camera_xyz = xyz @ transform[:3, :3].T + transform[:3, 3]
    if not len(xyz):
        return np.empty((0, 2)), np.empty(0)
    rvec = cv2.Rodrigues(transform[:3, :3])[0]
    pixels = cv2.projectPoints(xyz, rvec, transform[:3, 3],
                               np.asarray(K, dtype=np.float64).reshape(3, 3),
                               distortion)[0]
    return pixels.reshape(-1, 2), camera_xyz[:, 2]


def grid_coverage(pixels, width, height, columns=4, rows=3):
    pixels = np.asarray(pixels).reshape(-1, 2)
    inside = ((pixels[:, 0] >= 0) & (pixels[:, 0] < width)
              & (pixels[:, 1] >= 0) & (pixels[:, 1] < height))
    cells = np.floor(pixels[inside] / [width / columns, height / rows]).astype(int)
    return len(set(map(tuple, cells)))


def residual_statistics(residuals, height):
    residuals = np.asarray(residuals, dtype=float)
    if not len(residuals):
        return {"count": 0, "median_px1080": None, "p95_px1080": None,
                "rms_px1080": None, "maximum_px1080": None}
    scaled = residuals * 1080.0 / height
    return {"count": len(scaled), "median_px1080": float(np.median(scaled)),
            "p95_px1080": float(np.percentile(scaled, 95)),
            "rms_px1080": float(np.sqrt(np.mean(scaled ** 2))),
            "maximum_px1080": float(np.max(scaled))}


def evaluate_checkpoints(checkpoints, K, transform, height, distortion=None):
    """Measure withheld annotations without changing any pose parameter."""
    if not checkpoints:
        return None
    xyz = np.asarray([p.get("scene_xyz", p.get("xyz")) for p in checkpoints], dtype=float)
    pixels = np.asarray([p.get("video_xy", p.get("pixel")) for p in checkpoints], dtype=float)
    if xyz.shape != (len(checkpoints), 3) or pixels.shape != (len(checkpoints), 2):
        raise ValueError("Checkpoints require scene_xyz[3] and video_xy[2].")
    if not np.isfinite(xyz).all() or not np.isfinite(pixels).all():
        raise ValueError("Checkpoint coordinates must be finite.")
    projected, depth = project_points(xyz, K, transform, distortion)
    report = residual_statistics(np.linalg.norm(projected - pixels, axis=1), height)
    report.update({"positive_depth_fraction": float(np.mean(depth > 0)),
                   "residual_px": np.linalg.norm(projected - pixels, axis=1).tolist(),
                   "projected_xy": projected.tolist(),
                   "ids": [p.get("id", str(i)) for i, p in enumerate(checkpoints)]})
    return report


def checkpoint_acceptance(report, settings=None):
    settings = settings or {}
    return bool(report and report["count"] >= settings.get("min_checkpoints", 6)
                and report["positive_depth_fraction"] == 1.0
                and report["rms_px1080"] <= settings.get("checkpoint_rms_px1080", 3.0)
                and report["p95_px1080"] <= settings.get("checkpoint_p95_px1080", 6.0)
                and report["maximum_px1080"] <= settings.get("checkpoint_max_px1080", 10.0))


def validate_pose(xyz, pixels, K, transform, inliers, width, height,
                  settings=None, checkpoints=None, distortion=None):
    settings = settings or {}
    xyz = np.asarray(xyz, dtype=float).reshape(-1, 3)
    pixels = np.asarray(pixels, dtype=float).reshape(-1, 2)
    transform = np.asarray(transform, dtype=float).reshape(4, 4)
    inliers = np.asarray(inliers, dtype=int).reshape(-1)
    projected, depth = project_points(xyz, K, transform, distortion)
    residuals = np.linalg.norm(projected - pixels, axis=1)
    fit = residual_statistics(residuals[inliers], height)
    centered = xyz[inliers] - np.mean(xyz[inliers], axis=0) if len(inliers) else np.empty((0, 3))
    singular = np.linalg.svd(centered, compute_uv=False) if len(inliers) >= 3 else np.zeros(3)
    planarity = float(singular[-1] / max(singular[0], 1e-12))
    linearity = float(singular[1] / max(singular[0], 1e-12)) if len(singular) > 1 else 0.0
    coverage = grid_coverage(pixels[inliers], width, height)
    positive = float(np.mean(depth[inliers] > 0)) if len(inliers) else 0.0
    independent = evaluate_checkpoints(checkpoints, K, transform, height, distortion)
    reasons = []
    if len(inliers) < settings.get("min_inliers", 30):
        reasons.append("too_few_inliers")
    if coverage < settings.get("min_grid_cells", 6):
        reasons.append("insufficient_image_coverage")
    if len(inliers) / max(1, len(xyz)) < settings.get("min_inlier_ratio", 0.2):
        reasons.append("low_inlier_ratio")
    if positive < settings.get("min_positive_depth_fraction", 0.99):
        reasons.append("nonpositive_depth")
    if planarity < settings.get("min_planarity_ratio", 0.001):
        reasons.append("coplanar_or_insufficient_depth_geometry")
    if linearity < settings.get("min_linearity_ratio", 0.01):
        reasons.append("collinear_geometry")
    if fit["p95_px1080"] is None or fit["p95_px1080"] > settings.get("max_p95_px1080", 6.0):
        reasons.append("excessive_reprojection_error")
    if (not np.allclose(transform[:3, :3].T @ transform[:3, :3], np.eye(3), atol=1e-5)
            or not np.isclose(np.linalg.det(transform[:3, :3]), 1.0, atol=1e-5)):
        reasons.append("invalid_rotation")
    return {"status": "DEGRADED" if reasons else "LOCALIZED", "reasons": reasons,
            "accepted": checkpoint_acceptance(independent, settings) and not reasons,
            "metrics": {"matches": len(xyz), "inliers": len(inliers),
                        "inlier_ratio": len(inliers) / max(1, len(xyz)), "grid_cells": coverage,
                        "positive_depth_fraction": positive, "planarity_ratio": planarity,
                        "linearity_ratio": linearity, **fit, "independent_checkpoints": independent},
            "residuals": residuals, "projected_xy": projected, "depths": depth}


def load_checkpoints(config, time_seconds, identity=None):
    """Load withheld annotations only when their complete source/frame identity matches.

    Documents may declare common identity fields at the top level (or in an
    identity object) and frame fields on each point. A plain list instead needs
    complete identity on each point. Conflicting declarations are rejected.
    """
    from fractions import Fraction
    path = config.get("validation", {}).get("checkpoints_path")
    if not path:
        return None
    required = ("source_video_hash", "original_frame_id", "original_pts", "time_base",
                "geometry_version", "camera_profile_id", "calibration_version")

    def normalized(key, value):
        if key == "original_pts":
            if not isinstance(value, (int, np.integer)) or isinstance(value, (bool, np.bool_)):
                raise ValueError("Checkpoint identity original_pts must be an integer.")
            return int(value)
        if key == "original_frame_id":
            if isinstance(value, (bool, np.bool_)) or not isinstance(value, (str, int, np.integer)) or value == "":
                raise ValueError("Checkpoint identity original_frame_id is missing or invalid.")
            return int(value) if isinstance(value, np.integer) else value
        if key == "time_base":
            try:
                if isinstance(value, str):
                    base = Fraction(value)
                elif isinstance(value, (list, tuple)) and len(value) == 2 and all(
                        isinstance(v, (int, np.integer)) and not isinstance(v, (bool, np.bool_)) for v in value):
                    base = Fraction(int(value[0]), int(value[1]))
                else:
                    raise ValueError("Unsupported time_base format")
                if base <= 0:
                    raise ValueError("Nonpositive time_base")
                return (base.numerator, base.denominator)
            except (ValueError, TypeError, ZeroDivisionError) as exc:
                raise ValueError("Checkpoint identity time_base must be a positive rational.") from exc
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"Checkpoint identity {key} is missing or invalid.")
        return value

    if not isinstance(identity, dict):
        raise ValueError("Checkpoint validation requires complete expected pose/frame identity.")
    missing_expected = [key for key in required if key not in identity or identity[key] is None]
    if missing_expected:
        raise ValueError("Expected checkpoint identity is missing: " + ", ".join(missing_expected))
    expected = {key: normalized(key, identity[key]) for key in required}
    document = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    points = document.get("checkpoints", []) if isinstance(document, dict) else document
    if not isinstance(points, list):
        raise ValueError("Checkpoint document must be a list or contain a checkpoints list.")

    def declarations(record):
        if not isinstance(record, dict):
            raise ValueError("Each checkpoint and identity declaration must be an object.")
        nested = record.get("identity", {})
        if not isinstance(nested, dict):
            raise ValueError("Checkpoint identity must be an object.")
        values = {}
        for source in (nested, record):
            for key in required:
                if key not in source:
                    continue
                value = normalized(key, source[key])
                if key in values and values[key] != value:
                    raise ValueError(f"Conflicting checkpoint identity declarations for {key}.")
                values[key] = value
        return values

    common = declarations(document) if isinstance(document, dict) else {}
    selected = []
    for point in points:
        if not isinstance(point, dict):
            raise ValueError("Each checkpoint must be an object.")
        stamp = point.get("time_seconds", document.get("time_seconds") if isinstance(document, dict) else None)
        if stamp is None or abs(float(stamp) - float(time_seconds)) >= 0.001:
            continue
        if not np.isfinite(float(stamp)):
            raise ValueError("Checkpoint time_seconds must be finite.")
        actual = dict(common)
        for key, value in declarations(point).items():
            if key in actual and actual[key] != value:
                raise ValueError(f"Conflicting common and per-point checkpoint identity for {key}.")
            actual[key] = value
        missing = [key for key in required if key not in actual]
        if missing:
            raise ValueError("Checkpoint identity is missing: " + ", ".join(missing))
        for key in required:
            if actual[key] != expected[key]:
                raise ValueError(f"Checkpoint identity mismatch: {key}.")
        selected.append(point)
    return selected


def validate(config, pose_path=None):
    """Re-evaluate stored poses; missing check points is NOT_EVALUATED."""
    root = Path(config["output_dir"])
    candidates = [Path(pose_path)] if pose_path else sorted((root / "localization").glob("*/pose.json"))
    reports = []
    for path in candidates:
        pose = json.loads(path.read_text(encoding="utf-8"))
        selected = load_checkpoints(config, pose["time_seconds"], pose)
        transform = pose.get("T_camera_from_scene")
        assessment = evaluate_checkpoints(
            selected, np.asarray(pose["K"]).reshape(3, 3),
            np.asarray(transform).reshape(4, 4), pose["height"],
            np.asarray(pose.get("distortion", [0, 0, 0, 0, 0]))) if transform else None
        accepted = checkpoint_acceptance(assessment, config.get("validation", {})) and pose["status"] == "LOCALIZED"
        reports.append({"pose": str(path), "time_seconds": pose["time_seconds"],
                        "status": pose["status"], "accepted": accepted,
                        "independent_checkpoints": assessment})
    evaluated = [r for r in reports if r["independent_checkpoints"]]
    report = {"schema_version": "ar-v2.validation.v1", "poses": reports,
              "acceptance_status": ("NOT_EVALUATED" if not evaluated else
                                    "PASS" if len(evaluated) == len(reports) and all(r["accepted"] for r in reports) else "FAIL"),
              "checkpoints_used_for_optimization": False}
    directory = root / "validation"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return report


def preserve_observation_denominator(assessment, original_metrics, settings=None):
    """Retain the full input observation set when refinement fits only inliers."""
    settings = settings or {}
    metrics = assessment["metrics"]
    denominator = original_metrics.get("matches")
    selected = metrics.get("selected_matches", metrics.get("matches"))
    inliers = metrics.get("inliers", 0)
    for name, count in (("original matches", denominator), ("selected matches", selected), ("inliers", inliers)):
        if not isinstance(count, (int, np.integer)) or isinstance(count, (bool, np.bool_)) or count < 0:
            raise ValueError(f"Refinement {name} must be a nonnegative integer.")
    if denominator < selected or denominator < inliers:
        raise ValueError("Refinement cannot shrink the original complete observation denominator.")
    solver_ratio = metrics.get("solver_inlier_ratio", metrics.get("inlier_ratio", 0.0))
    ratio = inliers / max(1, denominator)
    metrics.update({"matches": int(denominator), "selected_matches": int(selected),
                    "solver_inlier_ratio": float(solver_ratio), "inlier_ratio": float(ratio),
                    "inlier_ratio_denominator": original_metrics.get(
                        "inlier_ratio_denominator", "original_pose_complete_observation_set")})
    if ratio < settings.get("min_inlier_ratio", .2):
        if "low_inlier_ratio" not in assessment["reasons"]:
            assessment["reasons"].append("low_inlier_ratio")
        if assessment["status"] == "LOCALIZED":
            assessment["status"] = "DEGRADED"
    assessment["accepted"] = bool(assessment.get("accepted", False) and assessment["status"] == "LOCALIZED")
    return assessment
