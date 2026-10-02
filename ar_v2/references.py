from __future__ import annotations
import itertools
import os
import subprocess
from pathlib import Path
import numpy as np
from .io import load_json, write_json, file_hash, content_hash


def render_request(config, references=None):
    runtime = config.get('runtime', {})
    bundled = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
    playwright = runtime.get('playwright_module') or os.environ.get('AR_V2_PLAYWRIGHT_MODULE')
    if not playwright and bundled.is_dir():
        playwright = str(bundled)
    return {'project_root': config['project_root'], 'output_dir': config['output_dir'],
            'browser_executable': runtime.get('browser'), 'port': runtime.get('render_port', 5198),
            'playwright_module': playwright, 'references': references or [],
            'job_status_path': config.get('_job_status_path')}


def run_renderer(config, request):
    output = Path(config['output_dir'])
    path = output / 'references' / 'render-request.json'
    write_json(path, request)
    if not config.get('node_path'):
        raise RuntimeError('Node.js unavailable; configure runtime.node')
    subprocess.run([config['node_path'], str(Path(config['project_root']) / 'tools/ar-v2-render.mjs'), str(path)],
                   cwd=config['project_root'], check=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def build_references(config):
    from .media import load_frame
    from .camera import telemetry_camera
    output = Path(config['output_dir'])
    manifest = load_json(output / 'scene/scene_manifest.json')
    if manifest.get('status') != 'ready':
        raise ValueError('A complete fixed scene must be prepared first')
    settings = config.get('references', {})
    time_seconds = float(settings.get('time', 10.01))
    image, frame, profile = load_frame(config, time_seconds)
    K = np.asarray(profile.get('K_rect', profile.get('K')), dtype=float).reshape(3, 3)
    height, width = image.shape[:2]
    target_width = int(settings.get('width', 960))
    target_height = int(round(height * target_width / width))
    sx, sy = target_width / width, target_height / height
    Kref = K.copy(); Kref[0, 0] *= sx; Kref[1, 1] *= sy
    Kref[0, 2] = (K[0, 2] + .5) * sx - .5; Kref[1, 2] = (K[1, 2] + .5) * sy - .5
    renderer_sources = {name: file_hash(Path(config['project_root']) / name) for name in ('ar_v2/web/camera.ts', 'ar_v2/web/renderer.ts', 'tools/ar-v2-render.mjs')}
    renderer_version = content_hash(renderer_sources)
    prior = telemetry_camera(config, time_seconds)
    transform = np.asarray(prior.get('T_camera_from_scene', prior.get('T_world_to_camera')), dtype=float).reshape(4, 4)
    center = -transform[:3, :3].T @ transform[:3, 3]
    dimensions = [settings.get('height_offsets_m', [0]), settings.get('yaw_offsets_deg', [0]),
                  settings.get('pitch_offsets_deg', [0]), settings.get('east_offsets_m', [0]), settings.get('north_offsets_m', [0])]
    references = []
    for index, (height_offset, yaw, pitch, east, north) in enumerate(itertools.product(*dimensions)):
        yaw, pitch = np.radians([yaw, pitch])
        # ENU positive heading is clockwise from North. Optical pitch rotates about the image-right axis.
        cy, syaw, cp, sp = np.cos(yaw), np.sin(yaw), np.cos(pitch), np.sin(pitch)
        heading = np.array([[cy, syaw, 0], [-syaw, cy, 0], [0, 0, 1]])
        pitch_delta = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
        rotation = pitch_delta @ transform[:3, :3] @ heading.T
        candidate_center = center + [east, north, height_offset]
        T = np.eye(4); T[:3, :3] = rotation; T[:3, 3] = -rotation @ candidate_center
        references.append({'id': f'ref_{index:04d}', 'width': target_width, 'height': target_height,
            'K': Kref.reshape(-1).tolist(), 'T_camera_from_scene': T.reshape(-1).tolist(),
            'geometry_version': manifest['geometry_version'], 'appearance_version': manifest.get('appearance_version'),
            'camera_profile_id': profile.get('id', profile.get('camera_profile_id')),
            'calibration_version': profile.get('calibration_version'), 'prior_only': True,
            'renderer_version': renderer_version, 'rendering_policy': 'unlit-base-color-preserve-uv-alpha-test', 'source_time_seconds': time_seconds, 'source_frame_id': frame.get('original_frame_id'),
            'candidate_offset': {'height_m': height_offset, 'yaw_deg': float(np.degrees(yaw)),
                                 'pitch_deg': float(np.degrees(pitch)), 'east_m': east, 'north_m': north}})
    write_json(output / 'references/candidate-prior.json', prior)
    run_renderer(config, render_request(config, references))
    from .reference_validation import validate_references
    validation = validate_references(config)
    if validation['status'] != 'passed':
        raise RuntimeError('Rendered references failed independent CPU geometry/depth checks; see references/validation.json')
    result = load_json(output / 'references/render-report.json')
    result['reference_validation'] = {key: value for key, value in validation.items() if key != 'references'}
    return result
