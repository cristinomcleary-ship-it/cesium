"""Independent CPU checks of the GPU reference render coordinate contract.

This checks renderer/geometry self-consistency only. It does not establish a
camera's real-world location, matching quality, or independent check-point error.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile

import cv2
import numpy as np

BACKGROUND_TRIANGLE = np.uint32(4294967295)


def _safe_path(output: Path, value: str) -> Path:
    path = (output / value).resolve()
    if not path.is_relative_to(output):
        raise ValueError('Reference asset path is outside output_dir')
    if not path.is_file():
        raise FileNotFoundError(str(path))
    return path


def _load_array(path: Path, dtype, width: int, height: int):
    expected = width * height * np.dtype(dtype).itemsize
    if path.stat().st_size != expected:
        raise ValueError(f'{path.name}: expected exactly {expected} bytes')
    return np.fromfile(path, dtype=dtype).reshape(height, width)


def _ray_triangle(origin, direction, triangle):
    """Moller-Trumbore intersection, without using the renderer depth."""
    edge1, edge2 = triangle[1] - triangle[0], triangle[2] - triangle[0]
    h = np.cross(direction, edge2)
    determinant = float(np.dot(edge1, h))
    if abs(determinant) < 1e-12:
        return None
    displacement = origin - triangle[0]
    u = float(np.dot(displacement, h) / determinant)
    q = np.cross(displacement, edge1)
    v = float(np.dot(direction, q) / determinant)
    distance = float(np.dot(edge2, q) / determinant)
    return distance, np.array([1.0 - u - v, u, v])


def _candidate_pixels(triangle_ids, foreground, desired: int, seed: int):
    """Spread samples over image bins; keep only same-ID 3x3 interiors."""
    height, width = triangle_ids.shape
    interior = np.zeros((height, width), dtype=bool)
    if height < 3 or width < 3:
        return []
    center = triangle_ids[1:-1, 1:-1]
    core = foreground[1:-1, 1:-1].copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            core &= (triangle_ids[1 + dy:height - 1 + dy, 1 + dx:width - 1 + dx] == center)
    interior[1:-1, 1:-1] = core
    ys, xs = np.nonzero(interior)
    if not len(xs):
        return []
    rng = np.random.default_rng(seed)
    order = rng.permutation(len(xs))
    columns = max(1, int(np.sqrt(desired * width / height)))
    rows = max(1, int(np.ceil(desired / columns)))
    bins = ((ys * rows // height) * columns + xs * columns // width)
    chosen, seen_bins = [], set()
    for index in order:
        cell = int(bins[index])
        if cell not in seen_bins:
            chosen.append(int(index))
            seen_bins.add(cell)
    selected = set(chosen)
    # Reserve extra candidates to replace CPU-detected geometric edge pixels.
    for index in order:
        if len(chosen) >= min(len(xs), desired * 8):
            break
        if int(index) not in selected:
            chosen.append(int(index))
            selected.add(int(index))
    return [(int(xs[index]), int(ys[index])) for index in chosen]


def _validate_one(output, row, vertices, faces, options, scene_geometry_version):
    width, height = int(row['width']), int(row['height'])
    if width <= 0 or height <= 0:
        raise ValueError('Reference image dimensions must be positive')
    K = np.asarray(row['K'], dtype=float).reshape(3, 3)
    transform = np.asarray(row['T_camera_from_scene'], dtype=float).reshape(4, 4)
    if not np.isfinite(K).all() or K[0, 0] <= 0 or K[1, 1] <= 0 or not np.allclose(K[2], [0, 0, 1]):
        raise ValueError('Reference K is not a finite CV intrinsic matrix')
    rotation = transform[:3, :3]
    if (not np.isfinite(transform).all() or not np.allclose(transform[3], [0, 0, 0, 1])
            or not np.allclose(rotation @ rotation.T, np.eye(3), atol=1e-6)
            or not np.isclose(np.linalg.det(rotation), 1, atol=1e-6)):
        raise ValueError('Reference camera transform is not a right-handed rigid transform')
    inverse_K = np.linalg.inv(K)
    center_world = -rotation.T @ transform[:3, 3]
    image = cv2.imdecode(np.fromfile(_safe_path(output, row['rgb']), dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None or image.shape[:2] != (height, width) or image.ndim != 3 or image.shape[2] not in (3, 4):
        raise ValueError('RGB asset dimensions/channels differ from reference metadata')
    depth = _load_array(_safe_path(output, row['depth_z']), '<f4', width, height)
    ids = _load_array(_safe_path(output, row['triangle_id']), '<u4', width, height)
    mask_path = _safe_path(output, row['valid_mask'])
    if mask_path.suffix.lower() == '.png':
        mask = cv2.imdecode(np.fromfile(mask_path, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
        if mask is None or mask.shape != (height, width):
            raise ValueError('Valid-mask dimensions differ from reference metadata')
    else:
        mask = _load_array(mask_path, 'u1', width, height)
    foreground = ids != BACKGROUND_TRIANGLE
    valid_id = foreground & (ids < len(faces))
    valid_depth = np.isfinite(depth) & (depth > 0)
    structural = {
        'mask_id_disagreements': int(np.count_nonzero((mask != 0) != foreground)),
        'out_of_range_triangle_ids': int(np.count_nonzero(foreground & ~valid_id)),
        'foreground_invalid_depth': int(np.count_nonzero(foreground & ~valid_depth)),
        'background_nonzero_depth': int(np.count_nonzero(~foreground & ((depth != 0) | ~np.isfinite(depth)))),
    }
    errors = [key for key, count in structural.items() if count]
    if scene_geometry_version and row.get('geometry_version') != scene_geometry_version:
        errors.append('geometry_version_mismatch')
    candidates = _candidate_pixels(ids, valid_id & valid_depth & (mask != 0), options['samples_per_reference'], options['seed'])
    checked, boundary, missed, negative, depth_failures = 0, 0, 0, 0, 0
    measured_errors, failure_examples = [], []
    worst = None
    triangles_sampled = set()
    sample_x, sample_y = [], []
    for x, y in candidates:
        if checked >= options['samples_per_reference']:
            break
        triangle_id = int(ids[y, x])
        triangle = vertices[faces[triangle_id]]
        direction_camera = inverse_K @ [x, y, 1.0]
        direction_world = rotation.T @ direction_camera
        hit = _ray_triangle(center_world, direction_world, triangle)
        if hit is None:
            missed += 1
            if len(failure_examples) < 8:
                failure_examples.append({'pixel': [x, y], 'triangle_id': triangle_id, 'failure': 'parallel_ray'})
            continue
        distance, barycentric = hit
        if float(np.min(barycentric)) < -1e-5:
            missed += 1
            if len(failure_examples) < 8:
                failure_examples.append({'pixel': [x, y], 'triangle_id': triangle_id,
                                         'failure': 'ray_misses_marked_triangle', 'barycentric': barycentric.tolist()})
            continue
        if distance <= 0:
            negative += 1
            if len(failure_examples) < 8:
                failure_examples.append({'pixel': [x, y], 'triangle_id': triangle_id, 'failure': 'intersection_behind_camera'})
            continue
        if float(np.min(barycentric)) < options['barycentric_margin']:
            boundary += 1
            continue
        world_hit = center_world + distance * direction_world
        camera_hit = rotation @ world_hit + transform[:3, 3]
        cpu_z, gpu_z = float(camera_hit[2]), float(depth[y, x])
        error = abs(cpu_z - gpu_z)
        tolerance = options['absolute_tolerance_m'] + options['relative_tolerance'] * abs(cpu_z)
        sample = {'pixel': [x, y], 'triangle_id': triangle_id, 'gpu_optical_z_m': gpu_z,
                  'cpu_optical_z_m': cpu_z, 'absolute_error_m': error,
                  'allowed_error_m': tolerance, 'barycentric': barycentric.tolist()}
        if worst is None or error > worst['absolute_error_m']:
            worst = sample
        if error > tolerance:
            depth_failures += 1
            if len(failure_examples) < 8:
                failure_examples.append({**sample, 'failure': 'optical_depth_mismatch'})
        measured_errors.append(error)
        triangles_sampled.add(triangle_id)
        sample_x.append(x)
        sample_y.append(y)
        checked += 1
    if missed:
        errors.append('marked_triangle_ray_misses')
    if negative:
        errors.append('marked_triangle_behind_camera')
    if depth_failures:
        errors.append('optical_depth_mismatch')
    if checked < options['minimum_samples']:
        errors.append('insufficient_interior_samples')
    return {'id': row['id'], 'status': 'passed' if not errors else 'failed', 'errors': errors,
            'width': width, 'height': height, 'foreground_pixels': int(np.count_nonzero(foreground)),
            'coverage_fraction': float(np.count_nonzero(foreground) / (width * height)),
            'structural_counts': structural, 'samples_checked': checked,
            'boundary_samples_skipped': boundary, 'ray_miss_count': missed,
            'behind_camera_count': negative, 'depth_failure_count': depth_failures,
            'distinct_sampled_triangles': len(triangles_sampled),
            'sample_pixel_bounds': [min(sample_x), min(sample_y), max(sample_x), max(sample_y)] if checked else None,
            'max_absolute_error_m': max(measured_errors) if measured_errors else None,
            'mean_absolute_error_m': float(np.mean(measured_errors)) if measured_errors else None,
            'p95_absolute_error_m': float(np.percentile(measured_errors, 95)) if measured_errors else None,
            'worst_sample': worst, 'failure_examples': failure_examples}, measured_errors


def validate_references(config: dict) -> dict:
    """Validate all reference artifacts and write references/validation.json.

    Uses integer zero-based pixel-center coordinates and independent CPU
    ray/triangle intersections. No feature matches or telemetry are involved.
    """
    output = Path(config['output_dir']).resolve()
    options = {'samples_per_reference': 64, 'minimum_samples': 16,
               'absolute_tolerance_m': 0.002, 'relative_tolerance': 2e-5,
               'barycentric_margin': 0.025, 'seed': 20261002}
    options.update(config.get('reference_validation', {}))
    if not (1 <= options['minimum_samples'] <= options['samples_per_reference'] <= 10000):
        raise ValueError('Invalid reference validation sample counts')
    if (options['absolute_tolerance_m'] < 0 or options['relative_tolerance'] < 0
            or not 0 <= options['barycentric_margin'] < 1 / 3):
        raise ValueError('Invalid reference validation tolerances')
    geometry_path = output / 'scene' / 'geometry.npz'
    with np.load(geometry_path, allow_pickle=False) as geometry:
        vertices = np.asarray(geometry['vertices'], dtype=np.float64)
        faces = np.asarray(geometry['faces'])
    if (vertices.ndim != 2 or vertices.shape[1] != 3 or not np.isfinite(vertices).all()
            or faces.ndim != 2 or faces.shape[1] != 3 or not np.issubdtype(faces.dtype, np.integer)
            or not len(faces) or faces.min() < 0 or faces.max() >= len(vertices)):
        raise ValueError('Scene geometry arrays are invalid')
    scene_path = output / 'scene' / 'scene_manifest.json'
    scene = json.loads(scene_path.read_text(encoding='utf-8')) if scene_path.exists() else {}
    scene_geometry_version = scene.get('geometry_version')
    manifest_path = output / 'references' / 'manifest.jsonl'
    rows = [json.loads(line) for line in manifest_path.read_text(encoding='utf-8').splitlines() if line.strip()]
    results, all_errors = [], []
    seen = set()
    for row in rows:
        try:
            if row['id'] in seen:
                raise ValueError('Duplicate reference ID')
            seen.add(row['id'])
            result, errors = _validate_one(output, row, vertices, faces, options, scene_geometry_version)
            all_errors.extend(errors)
        except (KeyError, ValueError, TypeError, OSError, np.linalg.LinAlgError) as error:
            result = {'id': row.get('id'), 'status': 'failed', 'errors': ['invalid_reference_artifact'], 'detail': str(error)}
        results.append(result)
    failed = [row['id'] for row in results if row['status'] != 'passed']
    report = {'schema_version': 'ar-v2-reference-validation/1',
              'status': 'passed' if rows and not failed else 'failed',
              'scope': 'GPU reference renderer and scene geometry self-consistency',
              'real_world_localization_accepted': False,
              'limitations': ['Does not validate real video camera location or independent checkpoints.',
                             'Tests marked-triangle intersection/depth; does not exhaustively test visibility against all other triangles.',
                             'Samples interior pixels; silhouette and geometric triangle edges are excluded.'],
              'coordinate_contract': {'world': 'local ENU metres', 'camera': 'CV right/down/forward',
                                      'pixel_centers': 'zero-based integer indices',
                                      'depth': 'positive optical Z metres', 'storage': 'little endian; top-down rows',
                                      'triangle_ids': 'zero-based; 4294967295 is background'},
              'options': options, 'geometry_npz_sha256': hashlib.sha256(geometry_path.read_bytes()).hexdigest(),
              'geometry_version': scene_geometry_version, 'vertex_count': len(vertices), 'triangle_count': len(faces),
              'reference_count': len(rows), 'passed_count': len(rows) - len(failed),
              'failed_count': len(failed), 'failed_reference_ids': failed,
              'samples_checked': len(all_errors),
              'max_absolute_error_m': max(all_errors) if all_errors else None,
              'mean_absolute_error_m': float(np.mean(all_errors)) if all_errors else None,
              'p95_absolute_error_m': float(np.percentile(all_errors, 95)) if all_errors else None,
              'references': results}
    destination = output / 'references' / 'validation.json'
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    temporary.replace(destination)
    return report


def self_test() -> dict:
    """Exercise independent ray math plus passing and corrupted GPU fixtures."""
    triangle = np.array([[-1, -1, 5], [1, -1, 5], [0, 1, 5]], dtype=float)
    distance, barycentric = _ray_triangle(np.zeros(3), np.array([0, 0, 1.0]), triangle)
    np.testing.assert_allclose(distance, 5)
    np.testing.assert_allclose(barycentric, [0.25, 0.25, 0.5])
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory)
        (output / 'scene').mkdir()
        (output / 'references').mkdir()
        vertices = np.array([[-6, -6, 10], [6, -6, 10], [6, 6, 10], [-6, 6, 10]], dtype=float)
        np.savez(output / 'scene' / 'geometry.npz', vertices=vertices, faces=np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int32))
        size = 32
        y, x = np.indices((size, size))
        ids = np.where(x >= y, 0, 1).astype('<u4')
        ids.tofile(output / 'references' / 'test.triangle.u32')
        np.full((size, size), 10, dtype='<f4').tofile(output / 'references' / 'test.depth.f32')
        np.full((size, size), 255, dtype='u1').tofile(output / 'references' / 'test.mask.u8')
        success, encoded = cv2.imencode('.png', np.full((size, size, 3), 127, dtype=np.uint8))
        assert success
        encoded.tofile(output / 'references' / 'test.png')
        row = {'id': 'synthetic-plane', 'width': size, 'height': size,
               'K': [32, 0, 15.5, 0, 32, 15.5, 0, 0, 1], 'T_camera_from_scene': np.eye(4).reshape(-1).tolist(),
               'rgb': 'references/test.png', 'depth_z': 'references/test.depth.f32',
               'triangle_id': 'references/test.triangle.u32', 'valid_mask': 'references/test.mask.u8'}
        (output / 'references' / 'manifest.jsonl').write_text(json.dumps(row) + '\n', encoding='utf-8')
        config = {'output_dir': directory}
        report = validate_references(config)
        assert report['status'] == 'passed', report
        assert report['samples_checked'] == 64
        assert not report['real_world_localization_accepted']
        np.full((size, size), 10.1, dtype='<f4').tofile(output / 'references' / 'test.depth.f32')
        corrupt_depth = validate_references(config)
        assert corrupt_depth['status'] == 'failed'
        assert 'optical_depth_mismatch' in corrupt_depth['references'][0]['errors']
        (1 - ids).astype('<u4').tofile(output / 'references' / 'test.triangle.u32')
        corrupt_ids = validate_references(config)
        assert corrupt_ids['status'] == 'failed'
        assert 'marked_triangle_ray_misses' in corrupt_ids['references'][0]['errors']
    return {'status': 'passed', 'checks': ['analytic_ray_triangle', 'correct_reference', 'depth_corruption', 'triangle_id_corruption']}


if __name__ == '__main__':
    print(json.dumps(self_test(), ensure_ascii=False))
