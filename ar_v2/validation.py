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


def load_checkpoints(config, time_seconds):
    path = config.get("validation", {}).get("checkpoints_path")
    if not path:
        return None
    document = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    points = document.get("checkpoints", []) if isinstance(document, dict) else document
    # Timestamps are compulsory; an annotation from another frame cannot be reused.
    return [p for p in points if "time_seconds" in p
            and abs(float(p["time_seconds"]) - time_seconds) < 0.001]


def validate(config, pose_path=None):
    """Re-evaluate stored poses; missing check points is NOT_EVALUATED."""
    root = Path(config["output_dir"])
    candidates = [Path(pose_path)] if pose_path else sorted((root / "localization").glob("*/pose.json"))
    reports = []
    for path in candidates:
        pose = json.loads(path.read_text(encoding="utf-8"))
        selected = load_checkpoints(config, pose["time_seconds"])
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
