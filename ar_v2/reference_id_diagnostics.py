"""Diagnose adjacent primitive-ID corruption without changing validation gates."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .reference_validation import _load_array, _ray_triangle, _safe_path


def diagnose_reference_ids(config: dict, offsets=(-2, -1, 0, 1, 2)) -> dict:
    output = Path(config['output_dir']).resolve()
    report_path = Path(config.get('diagnostic_validation_path', output / 'references' / 'validation.json'))
    failed_report = json.loads(report_path.read_text(encoding='utf-8'))
    references = {row['id']: row for row in (json.loads(line) for line in
        (output / 'references' / 'manifest.jsonl').read_text(encoding='utf-8').splitlines() if line.strip())}
    with np.load(output / 'scene' / 'geometry.npz', allow_pickle=False) as geometry:
        vertices, faces = geometry['vertices'], geometry['faces']
    summary = {str(offset): {'attempted': 0, 'intersects_triangle': 0, 'matches_depth': 0} for offset in offsets}
    samples, seen = [], set()
    recovered = {str(offset): 0 for offset in offsets if offset != 0}
    original_failures = 0
    for reference_report in failed_report['references']:
        if reference_report['status'] == 'passed' or reference_report['id'] not in references:
            continue
        row = references[reference_report['id']]
        depth = _load_array(_safe_path(output, row['depth_z']), '<f4', int(row['width']), int(row['height']))
        transform = np.asarray(row['T_camera_from_scene'], dtype=float).reshape(4, 4)
        rotation = transform[:3, :3]
        center = -rotation.T @ transform[:3, 3]
        inverse_K = np.linalg.inv(np.asarray(row['K'], dtype=float).reshape(3, 3))
        source_samples = list(reference_report.get('failure_examples', []))
        if reference_report.get('worst_sample'):
            source_samples.append(reference_report['worst_sample'])
        for source in source_samples:
            if 'pixel' not in source or 'triangle_id' not in source:
                continue
            x, y = source['pixel']
            sample_key = (row['id'], x, y)
            if sample_key in seen:
                continue
            seen.add(sample_key)
            marked_id = int(source['triangle_id'])
            gpu_z = float(source.get('gpu_optical_z_m', depth[y, x]))
            direction = rotation.T @ (inverse_K @ [x, y, 1.0])
            candidates = {}
            for offset in offsets:
                candidate_id = marked_id + offset
                if candidate_id < 0 or candidate_id >= len(faces):
                    continue
                stats = summary[str(offset)]
                stats['attempted'] += 1
                hit = _ray_triangle(center, direction, vertices[faces[candidate_id]])
                result = {'triangle_id': candidate_id, 'intersects': False, 'matches_depth': False}
                if hit is not None:
                    distance, barycentric = hit
                    if distance > 0 and np.min(barycentric) >= -1e-5:
                        stats['intersects_triangle'] += 1
                        world = center + distance * direction
                        z = float((rotation @ world + transform[:3, 3])[2])
                        error = abs(gpu_z - z)
                        tolerance = (failed_report['options']['absolute_tolerance_m']
                                     + failed_report['options']['relative_tolerance'] * abs(z))
                        matches = error <= tolerance
                        stats['matches_depth'] += int(matches)
                        result.update({'intersects': True, 'matches_depth': bool(matches),
                                       'cpu_optical_z_m': z, 'absolute_error_m': error,
                                       'barycentric': barycentric.tolist()})
                candidates[str(offset)] = result
            original_matches = candidates.get('0', {}).get('matches_depth', False)
            if not original_matches:
                original_failures += 1
                for offset in offsets:
                    if offset != 0 and candidates.get(str(offset), {}).get('matches_depth'):
                        recovered[str(offset)] += 1
            samples.append({'reference_id': row['id'], 'pixel': [x, y],
                            'original_marked_triangle_id': marked_id, 'gpu_optical_z_m': gpu_z,
                            'original_matches_depth': original_matches, 'candidates': candidates})
    report = {'schema_version': 'ar-v2-reference-id-diagnostic/1',
              'validation_report_path': str(report_path), 'samples_checked': len(samples),
              'original_failures': original_failures, 'offset_summary': summary,
              'original_failures_recovered_by_offset': recovered,
              'interpretation': 'Recovery at offset +1 supports downward truncation of interpolated float IDs; unchanged validation thresholds.',
              'real_world_localization_accepted': False, 'samples': samples}
    path = output / 'references' / 'id_diagnostics.json'
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    return report
