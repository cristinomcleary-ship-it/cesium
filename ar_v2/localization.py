"""Independent visual model localization, metric pose refinement and anchored LK.

No telemetry or legacy AR code participates in a pose solve. Camera coordinates
are optical right/down/forward. T_camera_from_scene is row-major, scene ENU m.
"""
from __future__ import annotations
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import time
from typing import Any
import cv2
import numpy as np
from .validation import (load_checkpoints, project_points, validate_pose,
                         residual_statistics)


class MatcherUnavailable(RuntimeError):
    pass


def _sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _json_write(path, data):
    from .io import write_json
    write_json(path, data)


def _read_image(path):
    image = cv2.imdecode(np.fromfile(Path(path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Cannot decode image: {path}")
    return image


def _write_image(path, image):
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise RuntimeError(f"Cannot encode diagnostic image: {path}")
    encoded.tofile(Path(path))


def _resolve(root, path, manifest_dir=None):
    path = Path(path)
    if path.is_absolute():
        return path
    candidate = Path(root) / path
    if candidate.exists() or manifest_dir is None:
        return candidate
    return Path(manifest_dir) / path


class SiftMatcher:
    """Explicit CPU diagnostic baseline: symmetric Lowe ratio and unique pairs."""
    def __init__(self, settings):
        self.settings = settings
        self.extractor = cv2.SIFT_create(nfeatures=int(settings.get("max_keypoints", 4096)))
        self.ratio = float(settings.get("sift_ratio", 0.75))
        self.provenance = {"matcher": "sift", "backend": "opencv-cpu",
                           "versions": {"opencv": cv2.__version__, "numpy": np.__version__},
                           "weights_sha256": {}, "baseline_only": True}

    def extract(self, image):
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        max_side = int(self.settings.get("max_image_size", 1600))
        scale = min(1.0, max_side / max(gray.shape))
        resized = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else gray
        keypoints, descriptors = self.extractor.detectAndCompute(resized, None)
        # Use actual rounded resize ratios, and OpenCV pixel-centre convention.
        sx, sy = resized.shape[1] / gray.shape[1], resized.shape[0] / gray.shape[0]
        points = np.array([((p.pt[0] + 0.5) / sx - 0.5,
                            (p.pt[1] + 0.5) / sy - 0.5) for p in keypoints], dtype=float).reshape(-1, 2)
        return {"points": points, "descriptors": descriptors}

    def match(self, query, reference):
        qdesc, rdesc = query["descriptors"], reference["descriptors"]
        if qdesc is None or rdesc is None or min(len(qdesc), len(rdesc)) < 2:
            return np.empty((0, 2), dtype=int), np.empty(0)
        matcher = cv2.BFMatcher(cv2.NORM_L2)
        forward = matcher.knnMatch(qdesc, rdesc, k=2)
        backward = matcher.knnMatch(rdesc, qdesc, k=2)
        reverse = {(m[0].queryIdx, m[0].trainIdx) for m in backward
                   if len(m) == 2 and m[0].distance < self.ratio * m[1].distance}
        selected = [m for m in forward if len(m) == 2
                    and m[0].distance < self.ratio * m[1].distance
                    and (m[0].trainIdx, m[0].queryIdx) in reverse]
        pairs = np.asarray([(m[0].queryIdx, m[0].trainIdx) for m in selected], dtype=int).reshape(-1, 2)
        scores = np.asarray([1.0 - m[0].distance / max(m[1].distance, 1e-9) for m in selected])
        return pairs, scores


class AlikedLightGlueMatcher:
    """Official LightGlue adapter. Missing dependencies/weights fail explicitly."""
    def __init__(self, settings):
        try:
            import torch
            from lightglue import ALIKED, LightGlue
        except (ImportError, OSError, RuntimeError) as exc:
            raise MatcherUnavailable("ALIKED+LightGlue dependency unavailable; install the pinned optional dependencies. "
                                     "No SIFT fallback was used.") from exc
        self.torch, self.settings = torch, settings
        self.device = str(settings.get("device", "cuda"))
        if self.device.startswith("cuda") and not torch.cuda.is_available():
            raise MatcherUnavailable("CUDA requested but unavailable. Set device=cpu explicitly for CPU inference.")
        hub_dir = settings.get("torch_hub_dir")
        if hub_dir:
            torch.hub.set_dir(str(hub_dir))
        model_name = str(settings.get("aliked_model", "aliked-n16"))
        filenames = [f"{model_name}.pth", f"aliked_lightglue_{LightGlue.version.replace('.', '-')}.pth"]
        weights = [Path(torch.hub.get_dir()) / "checkpoints" / name for name in filenames]
        missing = [str(path) for path in weights if not path.is_file()]
        if missing:
            raise MatcherUnavailable("Missing ALIKED/LightGlue weights: " + ", ".join(missing)
                                     + ". Download official weights before localization; no implicit download or fallback.")
        expected = settings.get("weight_sha256", {})
        for path in weights:
            if path.name in expected and _sha256(path) != expected[path.name]:
                raise MatcherUnavailable(f"Weight checksum mismatch: {path.name}")
        try:
            self.extractor = ALIKED(model_name=model_name,
                                   max_num_keypoints=int(settings.get("max_keypoints", 4096))).eval().to(self.device)
            self.matcher = LightGlue(features="aliked",
                                     filter_threshold=float(settings.get("lightglue_threshold", 0.1)),
                                     depth_confidence=float(settings.get("depth_confidence", 0.95)),
                                     width_confidence=float(settings.get("width_confidence", 0.99))).eval().to(self.device)
        except Exception as exc:
            raise MatcherUnavailable(f"Official ALIKED+LightGlue initialization failed: {exc}") from exc
        try:
            version = importlib.metadata.version("lightglue")
            direct_url = json.loads(importlib.metadata.distribution("lightglue").read_text("direct_url.json") or "{}")
        except (importlib.metadata.PackageNotFoundError, TypeError, json.JSONDecodeError):
            version, direct_url = "unknown", {}
        self.provenance = {"matcher": "aliked-lightglue", "backend": self.device,
                           "versions": {"opencv": cv2.__version__, "numpy": np.__version__,
                                        "torch": torch.__version__, "lightglue": version},
                           "source": direct_url, "weights_sha256": {p.name: _sha256(p) for p in weights},
                           "baseline_only": False}

    def extract(self, image):
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        tensor = self.torch.from_numpy(rgb.copy()).permute(2, 0, 1).float().to(self.device) / 255.0
        with self.torch.inference_mode():
            features = self.extractor.extract(tensor, resize=min(int(self.settings.get("max_image_size", 1600)), max(image.shape[:2])))
        points = features["keypoints"][0].detach().cpu().numpy()
        return {"points": points, "features": features}

    def match(self, query, reference):
        if not len(query["points"]) or not len(reference["points"]):
            return np.empty((0, 2), dtype=int), np.empty(0)
        with self.torch.inference_mode():
            result = self.matcher({"image0": query["features"], "image1": reference["features"]})
        return (result["matches"][0].detach().cpu().numpy().astype(int),
                result["scores"][0].detach().cpu().numpy())


def make_matcher(settings):
    name = settings.get("matcher", "aliked-lightglue")
    if name == "sift":
        return SiftMatcher(settings)
    if name == "aliked-lightglue":
        return AlikedLightGlueMatcher(settings)
    raise ValueError(f"Unsupported matcher: {name}. Expected aliked-lightglue or explicit sift baseline.")


def load_references(config):
    root = Path(config["output_dir"])
    manifest = Path(config.get("localization", {}).get("references_manifest", root / "references" / "manifest.jsonl"))
    if not manifest.is_file():
        raise FileNotFoundError(f"Reference manifest is missing: {manifest}; run render-references first.")
    references = [json.loads(line) for line in manifest.read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    if not references:
        raise ValueError("The reference manifest contains no images.")
    versions = {r.get("geometry_version") for r in references}
    if None in versions or len(versions) != 1:
        raise ValueError("All references must carry the same nonempty geometry_version.")
    appearances = {r.get("appearance_version") for r in references}
    if len(appearances) != 1:
        raise ValueError("References contain different appearance versions.")
    for reference in references:
        reference["_manifest_dir"] = str(manifest.parent)
    return references


def _load_scene(config):
    root = Path(config["output_dir"])
    scene_config = config.get("scene", {})
    candidates = [scene_config.get("geometry_npz"), root / "scene" / "geometry.npz",
                  root / "scene" / "scene.npz"]
    path = next((Path(p) for p in candidates if p and Path(p).is_file()), None)
    if path is None:
        return None
    manifest_path = root / "scene" / "scene_manifest.json"
    if not manifest_path.is_file():
        raise ValueError("Geometry NPZ has no scene manifest; its identity cannot be established.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    if manifest.get("status") != "ready" or _sha256(path) != manifest.get("geometry", {}).get("sha256"):
        raise ValueError("Scene geometry is not ready or its NPZ hash differs from the manifest.")
    with np.load(path, allow_pickle=False) as data:
        if "vertices" not in data or "faces" not in data:
            raise ValueError("Scene geometry requires vertices and faces arrays.")
        return {"vertices": np.asarray(data["vertices"], dtype=float),
                "faces": np.asarray(data["faces"], dtype=int),
                "geometry_version": manifest["geometry_version"],
                "appearance_version": manifest.get("appearance_version")}


def lift_reference_points(points, depth, K, transform, triangle_ids=None,
                          scene=None, settings=None):
    """Depth discontinuity rejection then exact ray/triangle when mesh is available.

    Render depth is optical z, not Euclidean ray length. The scene matrix is
    explicitly inverted; neither geodetic axes nor renderer camera axes are guessed.
    """
    settings = settings or {}
    points = np.asarray(points, dtype=float).reshape(-1, 2)
    height, width = depth.shape
    xyz = np.full((len(points), 3), np.nan)
    valid = np.zeros(len(points), dtype=bool)
    reason = np.full(len(points), "outside_image", dtype="<U40")
    invK = np.linalg.inv(np.asarray(K, dtype=float).reshape(3, 3))
    camera_to_scene = np.linalg.inv(np.asarray(transform, dtype=float).reshape(4, 4))
    for index, (u, v) in enumerate(points):
        px, py = int(round(u)), int(round(v))
        if px < 1 or py < 1 or px >= width - 1 or py >= height - 1:
            continue
        patch = depth[py-1:py+2, px-1:px+2]
        z = float(depth[py, px])
        if not np.isfinite(patch).all() or np.any(patch <= 0):
            reason[index] = "background_or_invalid_depth"
            continue
        max_jump = max(float(settings.get("depth_jump_m", 0.25)),
                       z * float(settings.get("depth_jump_relative", 0.015)))
        if float(patch.max() - patch.min()) > max_jump:
            reason[index] = "depth_discontinuity"
            continue
        triangle_id = int(triangle_ids[py, px]) if triangle_ids is not None else None
        if triangle_id is not None and triangle_id == 4294967295:
            reason[index] = "background_triangle"
            continue
        ray_camera = invK @ np.asarray([u, v, 1.0])
        ray_scene = camera_to_scene[:3, :3] @ ray_camera
        origin = camera_to_scene[:3, 3]
        if scene is not None and triangle_id is not None:
            if not 0 <= triangle_id < len(scene["faces"]):
                reason[index] = "invalid_triangle_id"
                continue
            a, b, c = scene["vertices"][scene["faces"][triangle_id]]
            e1, e2 = b - a, c - a
            pvec = np.cross(ray_scene, e2)
            determinant = np.dot(e1, pvec)
            if abs(determinant) < 1e-10:
                reason[index] = "grazing_triangle"
                continue
            tvec = origin - a
            bary_u = np.dot(tvec, pvec) / determinant
            qvec = np.cross(tvec, e1)
            bary_v = np.dot(ray_scene, qvec) / determinant
            distance = np.dot(e2, qvec) / determinant
            if bary_u < -1e-6 or bary_v < -1e-6 or bary_u + bary_v > 1.000001 or distance <= 0:
                reason[index] = "ray_misses_triangle"
                continue
            recovered = origin + ray_scene * distance
            actual_z = (np.asarray(transform).reshape(4, 4) @ np.append(recovered, 1.0))[2]
            if abs(actual_z - z) > max_jump:
                reason[index] = "triangle_depth_conflict"
                continue
        else:
            if triangle_ids is not None:
                patch_ids = triangle_ids[py-1:py+2, px-1:px+2]
                if np.count_nonzero(patch_ids == triangle_id) < 5:
                    reason[index] = "triangle_boundary"
                    continue
            # Interpolate inverse depth: exact for a locally planar surface under
            # perspective projection, including noninteger feature coordinates.
            x0, y0 = int(math.floor(u)), int(math.floor(v))
            dx, dy = u - x0, v - y0
            samples = depth[y0:y0+2, x0:x0+2]
            interpolated_inverse = ((1-dx)*(1-dy)/samples[0, 0] + dx*(1-dy)/samples[0, 1]
                                    + (1-dx)*dy/samples[1, 0] + dx*dy/samples[1, 1])
            recovered = origin + ray_scene / interpolated_inverse
        xyz[index], valid[index], reason[index] = recovered, True, "valid"
    return xyz, valid, reason


def deduplicate_correspondences(pixels, xyz, scores, settings=None):
    """One video observation has one 3D anchor, including across render views.

    Nearby observations with contradictory anchors invalidate the entire cluster;
    selecting only the highest score would let repeated structures invent evidence.
    """
    settings = settings or {}
    pixels, xyz, scores = np.asarray(pixels), np.asarray(xyz), np.asarray(scores)
    radius = float(settings.get("dedup_pixel_radius", 1.5))
    tolerance = float(settings.get("anchor_conflict_m", 0.5))
    parents = np.arange(len(pixels))
    buckets = {}
    def find(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i
    for i, point in enumerate(pixels):
        cell = tuple(np.floor(point / radius).astype(int))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in buckets.get((cell[0]+dx, cell[1]+dy), []):
                    if np.linalg.norm(point - pixels[j]) <= radius:
                        parents[find(i)] = find(j)
        buckets.setdefault(cell, []).append(i)
    groups = {}
    for i in range(len(pixels)):
        groups.setdefault(find(i), []).append(i)
    selected, conflicted = [], []
    for group in groups.values():
        positions = xyz[group]
        # The conservative bounding-box diagonal upper-bounds pairwise distance.
        if np.linalg.norm(np.ptp(positions, axis=0)) > tolerance:
            conflicted.extend(group)
        else:
            selected.append(max(group, key=lambda i: scores[i]))
    return np.asarray(sorted(selected), dtype=int), np.asarray(sorted(conflicted), dtype=int)


def solve_correspondences(xyz, pixels, K, width, height, settings=None,
                          distortion=None, checkpoints=None):
    settings = settings or {}
    xyz = np.asarray(xyz, dtype=np.float64).reshape(-1, 3)
    pixels = np.asarray(pixels, dtype=np.float64).reshape(-1, 2)
    K = np.asarray(K, dtype=np.float64).reshape(3, 3)
    distortion = np.asarray(distortion if distortion is not None else np.zeros(5), dtype=np.float64)
    if len(xyz) != len(pixels) or not np.isfinite(xyz).all() or not np.isfinite(pixels).all():
        raise ValueError("PnP correspondences must be finite and have matching lengths.")
    threshold = float(settings.get("ransac_px1080", 3.0)) * height / 1080.0
    empty = {"status": "LOST", "reasons": ["insufficient_correspondences"], "accepted": False,
             "T_camera_from_scene": None, "inlier_indices": np.empty(0, dtype=int),
             "metrics": {"matches": len(xyz), "inliers": 0, "independent_checkpoints": None},
             "residuals": np.full(len(xyz), np.nan), "projected_xy": np.full((len(xyz), 2), np.nan)}
    if len(xyz) < 6:
        return empty
    cv2.setRNGSeed(int(settings.get("random_seed", 42)))
    try:
        ok, rvec, tvec, inliers = cv2.solvePnPRansac(
            xyz, pixels, K, distortion, iterationsCount=int(settings.get("iterations", 5000)),
            reprojectionError=threshold, confidence=float(settings.get("confidence", 0.999)),
            flags=cv2.SOLVEPNP_EPNP)
    except cv2.error as exc:
        empty["reasons"] = ["pnp_solver_rejected_degenerate_input"]
        empty["solver_error"] = str(exc)
        return empty
    if not ok or inliers is None or len(inliers) < 6:
        empty["reasons"] = ["pnp_ransac_failed"]
        return empty
    inliers = inliers.reshape(-1)
    # LM only receives RANSAC fit points; held-out annotations are passed solely
    # to validation after solving. Reclassify support after each refinement.
    for _ in range(2):
        try:
            rvec, tvec = cv2.solvePnPRefineLM(
                xyz[inliers], pixels[inliers], K, distortion, rvec, tvec,
                criteria=(cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_COUNT, 50, 1e-8))
        except cv2.error as exc:
            empty["reasons"] = ["pose_refinement_failed"]
            empty["solver_error"] = str(exc)
            return empty
        transform = np.eye(4)
        transform[:3, :3], transform[:3, 3] = cv2.Rodrigues(rvec)[0], tvec.reshape(3)
        projected, depth = project_points(xyz, K, transform, distortion)
        new_inliers = np.flatnonzero((np.linalg.norm(projected - pixels, axis=1) <= threshold) & (depth > 0))
        if len(new_inliers) < 6:
            empty["reasons"] = ["refinement_lost_support"]
            return empty
        if np.array_equal(new_inliers, inliers):
            break
        inliers = new_inliers
    assessed = validate_pose(xyz, pixels, K, transform, inliers, width, height,
                            settings, checkpoints, distortion)
    assessed["T_camera_from_scene"] = transform.reshape(-1).tolist()
    assessed["inlier_indices"] = inliers
    return assessed


def _identity(frame, profile, references):
    return {"original_frame_id": frame.get("original_frame_id", frame.get("frame_id")),
            "original_pts": frame.get("original_pts", frame.get("pts")),
            "time_base": frame.get("time_base"), "source_video_hash": frame.get("source_video_hash"),
            "camera_profile_id": profile.get("id", profile.get("camera_profile_id")),
            "calibration_version": profile.get("calibration_version"),
            "geometry_version": references[0].get("geometry_version") if references else None,
            "appearance_version": references[0].get("appearance_version") if references else None}


def _overlay(image, pixels, assessment, scene, K, distortion):
    canvas = image.copy()
    height, width = image.shape[:2]
    transform = assessment.get("T_camera_from_scene")
    if transform is not None and scene is not None:
        transform = np.asarray(transform).reshape(4, 4)
        vertices, faces = scene["vertices"], scene["faces"]
        if len(faces) > 4000:
            faces = faces[np.linspace(0, len(faces)-1, 4000, dtype=int)]
        used = np.unique(faces)
        projected, depth = project_points(vertices[used], K, transform, distortion)
        lookup = {int(idx): n for n, idx in enumerate(used)}
        for face in faces:
            indices = [lookup[int(i)] for i in face]
            corners = projected[indices]
            if np.all(depth[indices] > 0) and np.isfinite(corners).all() and np.all(np.abs(corners) < max(width, height)*5):
                cv2.polylines(canvas, [np.round(corners).astype(np.int32)], True, (200, 160, 40), 1, cv2.LINE_AA)
    inliers = set(map(int, assessment.get("inlier_indices", [])))
    reprojections = assessment.get("projected_xy", np.empty((0, 2)))
    for index, pixel in enumerate(pixels):
        color = (80, 240, 80) if index in inliers else (50, 60, 240)
        point = tuple(np.round(pixel).astype(int))
        cv2.circle(canvas, point, 3, color, 1, cv2.LINE_AA)
        if index < len(reprojections) and np.isfinite(reprojections[index]).all():
            projected = tuple(np.round(np.clip(reprojections[index], -10000, 10000)).astype(int))
            cv2.line(canvas, point, projected, color, 1, cv2.LINE_AA)
    label = f"{assessment['status']} | fit inliers={len(inliers)} / {len(pixels)} | independent acceptance={assessment.get('accepted', False)}"
    cv2.rectangle(canvas, (0, 0), (width, 32), (0, 0, 0), -1)
    cv2.putText(canvas, label, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
    return canvas


def _save_pose(directory, image, xyz, pixels, assessment, pose, scene, K, distortion, extras=None):
    from .contracts import validate_pose_record
    validate_pose_record(pose)
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    inliers = np.asarray(assessment.get("inlier_indices", []), dtype=int)
    flags = np.zeros(len(xyz), dtype=bool)
    flags[inliers] = True
    np.savez_compressed(directory / "correspondences.npz", scene_xyz=np.asarray(xyz),
                        video_xy=np.asarray(pixels), inlier_mask=flags,
                        inlier_indices=inliers, outlier_indices=np.flatnonzero(~flags),
                        residual_px=assessment["residuals"],
                        projected_xy=assessment["projected_xy"], **(extras or {}))
    _write_image(directory / "overlay.png", _overlay(image, pixels, assessment, scene, K, distortion))
    pose["artifacts"] = {"correspondences": str(directory / "correspondences.npz"),
                         "overlay": str(directory / "overlay.png"), "pose": str(directory / "pose.json")}
    _json_write(directory / "pose.json", pose)
    return pose


def localize(config: dict[str, Any], time_seconds: float) -> dict[str, Any]:
    started = time.perf_counter()
    settings = config.get("localization", {})
    image, frame, profile = _load_frame(config, time_seconds)
    height, width = image.shape[:2]
    K = np.asarray(profile["K"], dtype=float).reshape(3, 3)
    distortion = np.asarray(profile.get("distortion", [0, 0, 0, 0, 0]), dtype=float)
    if width != profile["width"] or height != profile["height"]:
        raise ValueError("Camera profile dimensions do not match the decoded original frame.")
    references = load_references(config)
    scene = _load_scene(config)
    if scene is not None and scene["geometry_version"] != references[0]["geometry_version"]:
        raise ValueError("Reference geometry version does not match the immutable scene.")
    if scene is not None and scene.get("appearance_version") and scene["appearance_version"] != references[0].get("appearance_version"):
        raise ValueError("Reference appearance version does not match the immutable scene textures.")
    _progress(config, "localize", 0, len(references), {"time_seconds": time_seconds})
    matcher = make_matcher(settings)
    query_features = matcher.extract(image)
    left, top, roi_width, roi_height = profile.get("validROI", [0, 0, width, height])
    query_points = query_features["points"]
    query_valid = ((query_points[:, 0] >= left + 1) & (query_points[:, 0] < left + roi_width - 1)
                   & (query_points[:, 1] >= top + 1) & (query_points[:, 1] < top + roi_height - 1))
    if profile.get("valid_mask_path"):
        mask_path = _resolve(Path(config["output_dir"]), profile["valid_mask_path"])
        mask = cv2.imdecode(np.fromfile(mask_path, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
        if mask is None or mask.shape != (height, width):
            raise ValueError("Rectification mask is missing or differs from the camera profile dimensions.")
        mask = cv2.erode(mask, np.ones((5, 5), dtype=np.uint8), borderType=cv2.BORDER_CONSTANT, borderValue=0)
        rounded = np.rint(query_points).astype(int)
        inside = ((rounded[:, 0] >= 0) & (rounded[:, 0] < width)
                  & (rounded[:, 1] >= 0) & (rounded[:, 1] < height))
        query_valid = np.zeros(len(query_points), dtype=bool)
        query_valid[inside] = mask[rounded[inside, 1], rounded[inside, 0]] == 255
    extraction_seconds = time.perf_counter() - started
    raw_query, raw_reference, raw_xyz, raw_scores, raw_ids, raw_valid, raw_reasons = [], [], [], [], [], [], []
    reference_stats = []
    root = Path(config["output_dir"])
    for reference_index, reference in enumerate(references):
        reference_started = time.perf_counter()
        rgb_path = _resolve(root, reference["rgb"], reference["_manifest_dir"])
        depth_path = _resolve(root, reference["depth_z"], reference["_manifest_dir"])
        reference_image = _read_image(rgb_path)
        rw, rh = int(reference["width"]), int(reference["height"])
        if reference_image.shape[:2] != (rh, rw):
            raise ValueError(f"Reference image dimensions disagree with manifest: {reference['id']}")
        depth = np.fromfile(depth_path, dtype="<f4").reshape(rh, rw)
        triangles = None
        if reference.get("triangle_id"):
            triangles = np.fromfile(_resolve(root, reference["triangle_id"], reference["_manifest_dir"]), dtype="<u4").reshape(rh, rw)
        reference_features = matcher.extract(reference_image)
        pairs, scores = matcher.match(query_features, reference_features)
        qpoints, rpoints = query_features["points"][pairs[:, 0]], reference_features["points"][pairs[:, 1]]
        xyz, valid, reasons = lift_reference_points(rpoints, depth, reference["K"],
                                                    reference["T_camera_from_scene"], triangles, scene, settings)
        invalid_query = ~query_valid[pairs[:, 0]]
        valid[invalid_query] = False
        reasons[invalid_query] = "invalid_rectification_region"
        raw_query.extend(qpoints)
        raw_reference.extend(rpoints)
        raw_xyz.extend(xyz)
        raw_scores.extend(scores)
        raw_ids.extend([str(reference["id"])] * len(scores))
        raw_valid.extend(valid)
        raw_reasons.extend(reasons)
        reference_stats.append({"id": reference["id"], "matches": len(pairs),
                                "valid_3d": int(np.count_nonzero(valid)),
                                "seconds": time.perf_counter() - reference_started})
        _progress(config, "localize", reference_index + 1, len(references),
                  {"reference": reference["id"], "matches": len(pairs), "valid_3d": int(np.count_nonzero(valid))})
    all_pixels = np.asarray(raw_query, dtype=float).reshape(-1, 2)
    all_xyz = np.asarray(raw_xyz, dtype=float).reshape(-1, 3)
    all_scores = np.asarray(raw_scores, dtype=float)
    valid_indices = np.flatnonzero(raw_valid)
    _, legacy_conflicts = deduplicate_correspondences(all_pixels[valid_indices],
                                                     all_xyz[valid_indices], all_scores[valid_indices], settings)
    matched_seconds = time.perf_counter() - started
    actual_time = float(frame.get("time_seconds", time_seconds))
    from .consensus import solve_reference_hypotheses, select_consensus
    raw = {"video_xy": all_pixels, "scene_xyz": all_xyz, "score": all_scores,
           "reference_id": np.asarray(raw_ids, dtype=str), "valid_3d": np.asarray(raw_valid, dtype=bool)}
    _progress(config, "geometric-hypotheses", 0, len(references))
    hypotheses = solve_reference_hypotheses(raw, K, width, height, settings, distortion,
        progress_callback=lambda done, total: _progress(config, "geometric-hypotheses", done, total))
    consensus = select_consensus(raw, hypotheses, K, width, height, settings, distortion,
                                 load_checkpoints(config, actual_time, _identity(frame, profile, references)))
    chosen, assessment = consensus["selected_raw_indices"], consensus["assessment"]
    xyz, pixels = all_xyz[chosen], all_pixels[chosen]
    pose = {"schema_version": "ar-v2.pose.v1", "status": assessment["status"],
            "accepted": assessment["accepted"], "reasons": assessment["reasons"],
            "time_seconds": actual_time, "requested_time_seconds": float(time_seconds),
            "width": width, "height": height, "K": K.reshape(-1).tolist(),
            "distortion": distortion.reshape(-1).tolist(),
            "T_camera_from_scene": assessment["T_camera_from_scene"],
            "metrics": assessment["metrics"], "provenance": matcher.provenance,
            "reference_stats": reference_stats, "legacy_anchor_conflicts": len(legacy_conflicts),
            "selection_method": "visual-hypothesis-consensus/v1", "consensus_support": consensus["diagnostics"]["selected_support"],
            "coordinate_convention": "scene ENU metres; camera optical right/down/forward; row-major T_camera_from_scene",
            "timing": {"extract_and_initialize_seconds": extraction_seconds,
                       "match_and_lift_seconds": matched_seconds - extraction_seconds,
                       "solve_seconds": time.perf_counter() - started - matched_seconds,
                       "total_seconds": time.perf_counter() - started},
            "independent_checkpoints_used_for_solve": False,
            **_identity(frame, profile, references)}
    directory = root / "localization" / f"{actual_time:012.6f}"
    directory.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(directory / "raw_matches.npz", video_xy=all_pixels,
                        reference_xy=np.asarray(raw_reference, dtype=float).reshape(-1, 2),
                        scene_xyz=all_xyz, score=all_scores, reference_id=np.asarray(raw_ids, dtype=str),
                        valid_3d=np.asarray(raw_valid, dtype=bool),
                        rejection_reason=np.asarray(raw_reasons, dtype=str), selected_raw_indices=chosen,
                        legacy_conflicting_raw_indices=valid_indices[legacy_conflicts], conflicting_raw_indices=np.empty(0, dtype=int))
    result = _save_pose(directory, image, xyz, pixels, assessment, pose, scene, K, distortion,
                       {"reference_id": np.asarray(raw_ids, dtype=str)[chosen], "scores": all_scores[chosen]})
    _json_write(directory / "consensus.json", consensus["diagnostics"])
    _json_write(directory / "reference_hypotheses.json", hypotheses)
    result["artifacts"]["consensus"] = str(directory / "consensus.json")
    result["artifacts"]["raw_matches"] = str(directory / "raw_matches.npz")
    _json_write(directory / "pose.json", result)
    return result


def _progress(config, phase, done, total, details=None):
    # Progress is optional for standalone library use, never involved in solving.
    try:
        from .io import progress
    except ImportError:
        return
    progress(config, phase, done, total, details)


def refine(config, window_seconds=20.0):
    """Robust metric pose-only bundle refinement with fixed, explicit camera K.

    Rectified observations do not retain enough information to safely update
    raw K/distortion. Requesting that mode is rejected rather than mislabelled as
    successful calibration. There are no temporal smoothness pseudo-observations.
    """
    from scipy.optimize import least_squares
    from .validation import preserve_observation_denominator
    settings = config.get("refinement", {})
    if settings.get("optimize_intrinsics", False) or settings.get("optimize_distortion", False):
        raise NotImplementedError("Shared raw K/distortion refinement requires original raw observations and re-rectification; "
                                  "this baseline supports pose_only with fixed camera profiles.")
    root = Path(config["output_dir"])
    paths = sorted((root / "localization").glob("*/pose.json"))
    frames = []
    for path in paths:
        pose = json.loads(path.read_text(encoding="utf-8"))
        if pose["status"] != "LOCALIZED" or pose["time_seconds"] > float(window_seconds):
            continue
        with np.load(pose["artifacts"]["correspondences"], allow_pickle=False) as data:
            mask = data["inlier_mask"].astype(bool)
            xyz, pixels = data["scene_xyz"][mask], data["video_xy"][mask]
        if len(xyz) >= 6:
            frames.append((pose, xyz, pixels))
    if len(frames) < 2:
        report = {"schema_version": "ar-v2.refinement.v1", "status": "NOT_OBSERVABLE",
                  "reason": "At least two independently localized frames are required.",
                  "input_frames": len(frames), "mode": "pose_only", "shared_intrinsics_optimized": False}
        _json_write(root / "refinement" / "report.json", report)
        return report
    identities = {(p["source_video_hash"], p["geometry_version"], p["camera_profile_id"], p["calibration_version"])
                  for p, _, _ in frames}
    if len(identities) != 1:
        raise ValueError("A refinement window must share video, geometry and camera calibration identity.")
    scene = _load_scene(config)
    if scene is not None and any(p["geometry_version"] != scene["geometry_version"] or
                                p.get("appearance_version") != scene.get("appearance_version") for p, _, _ in frames):
        raise ValueError("Refinement poses do not match the current immutable scene identity.")
    records, all_before, all_after = [], [], []
    for index, (pose, xyz, pixels) in enumerate(frames):
        T = np.asarray(pose["T_camera_from_scene"]).reshape(4, 4)
        K = np.asarray(pose["K"]).reshape(3, 3)
        distortion = np.asarray(pose["distortion"])
        initial = np.concatenate((cv2.Rodrigues(T[:3, :3])[0].reshape(3), T[:3, 3]))
        def residual(parameters):
            projected = cv2.projectPoints(xyz, parameters[:3], parameters[3:], K, distortion)[0].reshape(-1, 2)
            return ((projected - pixels) * (1080 / pose["height"])).reshape(-1)
        solved = least_squares(residual, initial, loss="huber",
                               f_scale=float(settings.get("huber_px1080", 2.0)),
                               max_nfev=int(settings.get("max_evaluations", 100)), x_scale="jac")
        updated = np.eye(4)
        updated[:3, :3], updated[:3, 3] = cv2.Rodrigues(solved.x[:3])[0], solved.x[3:]
        assessment = validate_pose(xyz, pixels, K, updated, np.arange(len(xyz)),
                                   pose["width"], pose["height"], config.get("localization", {}),
                                   load_checkpoints(config, pose["time_seconds"], pose), distortion)
        assessment = preserve_observation_denominator(assessment, pose["metrics"], config.get("localization", {}))
        before = np.linalg.norm(residual(initial).reshape(-1, 2), axis=1)
        after = np.linalg.norm(residual(solved.x).reshape(-1, 2), axis=1)
        apply = bool(solved.success and assessment["status"] == "LOCALIZED"
                     and np.mean(after**2) <= np.mean(before**2) + 1e-6)
        output_pose = dict(pose)
        if apply:
            output_pose.update({"T_camera_from_scene": updated.reshape(-1).tolist(),
                                "status": assessment["status"], "accepted": assessment["accepted"],
                                "metrics": assessment["metrics"], "reasons": assessment["reasons"]})
        output_pose["refinement"] = {"mode": "pose_only", "applied": apply,
                                     "shared_intrinsics_optimized": False,
                                     "solver_success": bool(solved.success),
                                     "evaluations": int(solved.nfev), "input_pose": pose["artifacts"]["pose"]}
        destination = root / "refinement" / f"{pose['time_seconds']:012.6f}" / "pose.json"
        if not apply:
            assessment = validate_pose(xyz, pixels, K, T, np.arange(len(xyz)),
                                       pose["width"], pose["height"], config.get("localization", {}),
                                       load_checkpoints(config, pose["time_seconds"], pose), distortion)
        assessment = preserve_observation_denominator(assessment, pose["metrics"], config.get("localization", {}))
        output_pose.update({"status": assessment["status"], "accepted": assessment["accepted"],
                            "metrics": assessment["metrics"], "reasons": assessment["reasons"]})
        assessment["T_camera_from_scene"] = output_pose["T_camera_from_scene"]
        assessment["inlier_indices"] = np.arange(len(xyz))
        image, frame, profile = _load_frame(config, pose["time_seconds"])
        observed_identity = _identity(frame, profile, [{"geometry_version": pose["geometry_version"],
                                                       "appearance_version": pose.get("appearance_version")}])
        if observed_identity != {key: pose.get(key) for key in observed_identity}:
            raise ValueError("Refinement input pose no longer matches its original frame/calibration.")
        _save_pose(destination.parent, image, xyz, pixels, assessment, output_pose, scene, K, distortion)
        records.append({"time_seconds": pose["time_seconds"], "applied": apply, "pose": str(destination),
                        "before": residual_statistics(before, 1080), "after": residual_statistics(after, 1080)})
        all_before.extend(before)
        all_after.extend(after if apply else before)
        _progress(config, "refine", index + 1, len(frames))
    report = {"schema_version": "ar-v2.refinement.v1", "status": "COMPLETE",
              "mode": "pose_only", "input_frames": len(frames), "frames": records,
              "shared_intrinsics_optimized": False, "independent_checkpoints_used_for_solve": False,
              "before": residual_statistics(all_before, 1080), "after": residual_statistics(all_after, 1080)}
    _json_write(root / "refinement" / "report.json", report)
    return report


def track_points(previous_gray, current_gray, pixels, settings=None):
    """Forward/backward pyramidal Lucas-Kanade with finite/bounds checks."""
    settings = settings or {}
    pixels = np.asarray(pixels, dtype=np.float32).reshape(-1, 1, 2)
    if not len(pixels):
        return np.empty((0, 2)), np.empty(0, dtype=bool), np.empty(0)
    kwargs = {"winSize": (int(settings.get("lk_window", 21)),) * 2,
              "maxLevel": int(settings.get("lk_levels", 3)),
              "criteria": (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, .01)}
    forward, status1, _ = cv2.calcOpticalFlowPyrLK(previous_gray, current_gray, pixels, None, **kwargs)
    if forward is None:
        return pixels.reshape(-1, 2), np.zeros(len(pixels), dtype=bool), np.full(len(pixels), np.inf)
    backward, status2, _ = cv2.calcOpticalFlowPyrLK(current_gray, previous_gray, forward, None, **kwargs)
    if backward is None:
        return forward.reshape(-1, 2), np.zeros(len(pixels), dtype=bool), np.full(len(pixels), np.inf)
    error = np.linalg.norm(backward.reshape(-1, 2) - pixels.reshape(-1, 2), axis=1)
    points = forward.reshape(-1, 2)
    height, width = current_gray.shape
    maximum = float(settings.get("lk_fb_px1080", 1.5)) * height / 1080
    valid = ((status1.reshape(-1) != 0) & (status2.reshape(-1) != 0)
             & np.isfinite(points).all(axis=1) & np.isfinite(error)
             & (error <= maximum) & (points[:, 0] >= 1) & (points[:, 0] < width-1)
             & (points[:, 1] >= 1) & (points[:, 1] < height-1))
    return points, valid, error


def track(config, start_seconds=0.0, end_seconds=None):
    """Track independently localized 3D anchors; every emitted pose is measured.

    Uses cached original-frame identities via the media adapter. Lost anchors are
    replenished only by full model localization, never interpolated telemetry.
    The baseline seeks/caches each selected frame; this is an offline correctness
    path, and the report records its measured processing speed.
    """
    root = Path(config["output_dir"])
    settings = config.get("tracking", {})
    start_seconds = float(settings.get("start_seconds", start_seconds))
    end_seconds = float(settings.get("end_seconds", 20.0 if end_seconds is None else end_seconds))
    times = _tracking_times(config, start_seconds, end_seconds)
    every = int(settings.get("frame_stride", 1))
    if every < 1:
        raise ValueError("tracking.frame_stride must be at least one.")
    times = times[::every]
    if not times:
        raise ValueError("No original video frames fall within the requested tracking window.")
    directory = root / "tracking"
    directory.mkdir(parents=True, exist_ok=True)
    scene = _load_scene(config)
    references = load_references(config)
    previous_gray, previous_pose = None, None
    anchors, previous_pixels = np.empty((0, 3)), np.empty((0, 2))
    last_localized = -float("inf")
    started = time.perf_counter()
    poses, lost_count, relocalizations = [], 0, 0
    for index, timestamp in enumerate(times):
        frame_started = time.perf_counter()
        image, frame, profile = _load_frame(config, timestamp)
        height, width = image.shape[:2]
        K = np.asarray(profile["K"]).reshape(3, 3)
        distortion = np.asarray(profile.get("distortion", [0, 0, 0, 0, 0]))
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        actual_time = float(frame.get("time_seconds", timestamp))
        need_model = (previous_gray is None or len(anchors) < config.get("localization", {}).get("min_inliers", 30)
                      or actual_time-last_localized >= float(settings.get("relocalize_seconds", 2.0)))
        if not need_model:
            current_pixels, valid, fb_error = track_points(previous_gray, gray, previous_pixels, settings)
            anchors, current_pixels = anchors[valid], current_pixels[valid]
            assessment = solve_correspondences(anchors, current_pixels, K, width, height,
                                               config.get("localization", {}), distortion,
                                               load_checkpoints(config, actual_time, _identity(frame, profile, references)))
            # Reject implausible metric jumps; a prior is a gate, never a replacement pose.
            if assessment["status"] == "LOCALIZED" and previous_pose is not None:
                current_T = np.asarray(assessment["T_camera_from_scene"]).reshape(4, 4)
                prior_T = np.asarray(previous_pose["T_camera_from_scene"]).reshape(4, 4)
                displacement = np.linalg.norm(np.linalg.inv(current_T)[:3, 3] - np.linalg.inv(prior_T)[:3, 3])
                angle = math.degrees(np.linalg.norm(cv2.Rodrigues(current_T[:3, :3] @ prior_T[:3, :3].T)[0]))
                dt = max(actual_time - previous_pose["time_seconds"], .001)
                if displacement > float(settings.get("max_translation_m_per_second", 50)) * dt or angle > float(settings.get("max_rotation_deg_per_second", 120)) * dt:
                    assessment["status"] = "DEGRADED"
                    assessment["accepted"] = False
                    assessment["reasons"].append("implausible_pose_jump")
            need_model = assessment["status"] != "LOCALIZED"
        if need_model:
            pose = localize(config, timestamp)
            relocalizations += 1
            if pose["status"] == "LOCALIZED":
                with np.load(pose["artifacts"]["correspondences"], allow_pickle=False) as data:
                    mask = data["inlier_mask"].astype(bool)
                    anchors, current_pixels = data["scene_xyz"][mask], data["video_xy"][mask]
                last_localized = actual_time
            else:
                anchors, current_pixels = np.empty((0, 3)), np.empty((0, 2))
                lost_count += 1
            pose["tracking_method"] = "model_relocalization"
        else:
            pose = {"schema_version": "ar-v2.pose.v1", "status": assessment["status"],
                    "accepted": assessment["accepted"], "reasons": assessment["reasons"],
                    "time_seconds": actual_time, "width": width, "height": height,
                    "K": K.reshape(-1).tolist(), "distortion": distortion.reshape(-1).tolist(),
                    "T_camera_from_scene": assessment["T_camera_from_scene"],
                    "metrics": assessment["metrics"],
                    "provenance": {"matcher": "pyramidal-lk-forward-backward", "opencv": cv2.__version__},
                    "tracking_method": "anchored_lk_pnp", "independent_checkpoints_used_for_solve": False,
                    "forward_backward_median_px": float(np.median(fb_error[valid])) if np.any(valid) else None,
                    **_identity(frame, profile, references)}
            pose = _save_pose(directory / f"{actual_time:012.6f}", image, anchors, current_pixels,
                              assessment, pose, scene, K, distortion)
            inliers = assessment["inlier_indices"]
            anchors, current_pixels = anchors[inliers], current_pixels[inliers]
        pose["processing_seconds"] = time.perf_counter() - frame_started
        pose["interpolated"] = False
        poses.append(pose)
        with (directory / "poses.jsonl").open("a" if index else "w", encoding="utf-8") as stream:
            stream.write(json.dumps(pose, ensure_ascii=False, allow_nan=False) + "\n")
        previous_gray = gray
        previous_pixels = current_pixels
        previous_pose = pose if pose["status"] == "LOCALIZED" else None
        _progress(config, "track", index + 1, len(times), {"status": pose["status"], "time_seconds": actual_time})
    elapsed = time.perf_counter() - started
    report = {"schema_version": "ar-v2.tracking.v1", "status": "COMPLETE",
              "frames": len(poses), "lost_frames": lost_count, "relocalizations": relocalizations,
              "measured_processing_fps": len(poses)/max(elapsed, 1e-9), "elapsed_seconds": elapsed,
              "frame_stride": every, "realtime_claim": False, "poses": str(directory / "poses.jsonl"),
              "independently_accepted_frames": sum(bool(p.get("accepted")) for p in poses),
              "whole_window_accepted": every == 1 and all(p.get("accepted", False) for p in poses),
              "acceptance_status": "NOT_EVALUATED" if not any(p.get("metrics", {}).get("independent_checkpoints") for p in poses) else "REVIEW_REQUIRED"}
    _json_write(directory / "report.json", report)
    return report


def _load_frame(config, time_seconds):
    from .media import load_frame
    image, frame, profile = load_frame(config, time_seconds)
    # Adapter deliberately preserves the media pipeline's exact original PTS.
    required = ("original_frame_id", "original_pts", "time_base", "source_video_hash",
                "camera_profile_id", "calibration_version", "time_seconds")
    if any(frame.get(key) is None for key in required):
        raise ValueError("Media frame is missing mandatory source/PTS/calibration identity.")
    if profile.get("id") != frame["camera_profile_id"] or profile.get("calibration_version") != frame["calibration_version"]:
        raise ValueError("Rectified frame and camera profile identity disagree.")
    return image, frame, profile


def _tracking_times(config, start_seconds, end_seconds):
    from .media import probe_video
    manifest = probe_video(config)
    frames = manifest.get("frames")
    if not isinstance(frames, list):
        raise ValueError("Video manifest must contain every original presentation frame.")
    times = [float(frame["time_seconds"]) for frame in frames
             if start_seconds <= float(frame["time_seconds"]) <= end_seconds]
    if any(b <= a for a, b in zip(times, times[1:])):
        raise ValueError("Original frame PTS must increase strictly for tracking.")
    return times
