"""PTS-preserving raw/rectified video extraction for the isolated V2 pipeline."""
from __future__ import annotations

import hashlib
import json
import math
from fractions import Fraction
from pathlib import Path
import shutil
import subprocess

import cv2
import numpy as np

from .camera import scale_intrinsics

_PROBE_CACHE: dict = {}
_DEFAULT_TIMES = [0, 10.01, 30, 60, 90, 114]


def _write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def _command(config, name):
    value = config.get(name + '_path') or shutil.which(name)
    if not value:
        raise RuntimeError(f'{name} is required; set {name}_path')
    return str(value)


def _run(arguments):
    result = subprocess.run(arguments, check=False, capture_output=True, text=True,
                            encoding='utf-8', errors='replace', timeout=600)
    if result.returncode:
        raise RuntimeError(f'{Path(arguments[0]).name} failed: {result.stderr[-4000:]}')
    return result.stdout


def _sha256(path: Path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def probe_video(config: dict) -> dict:
    """Probe every decoded frame's integer PTS; never synthesize index / fps."""
    source = Path(config['video_path']).resolve()
    stat = source.stat()
    cache_key = (str(source), stat.st_size, stat.st_mtime_ns)
    if cache_key in _PROBE_CACHE:
        return _PROBE_CACHE[cache_key]
    # Reuse a provenance-bound complete frame index across CLI invocations.
    media_dir = Path(config['output_dir']).resolve() / 'media'
    manifest_path, index_path = media_dir / 'video_manifest.json', media_dir / 'original_frame_index.json'
    if manifest_path.exists() and index_path.exists():
        try:
            previous = json.loads(manifest_path.read_text(encoding='utf-8'))
            index = json.loads(index_path.read_text(encoding='utf-8'))
            unchanged = (previous.get('video_path') == str(source)
                         and previous.get('source_size_bytes') == stat.st_size
                         and previous.get('source_mtime_ns') == stat.st_mtime_ns
                         and index.get('source_video_hash') == previous.get('source_video_hash')
                         and index.get('time_base') == previous.get('time_base')
                         and len(index.get('frames', [])) == previous.get('frame_count'))
            if unchanged and index.get('frames') and all(isinstance(row.get('original_pts'), int) for row in index['frames']):
                result = {key: previous[key] for key in ('video_path', 'source_video_hash', 'source_size_bytes',
                    'source_mtime_ns', 'width', 'height', 'time_base', 'start_pts', 'duration_ts',
                    'avg_frame_rate', 'codec_name', 'frame_count')}
                result.update({'schema_version': 'ar-v2-video-probe/1', 'frames': index['frames']})
                _PROBE_CACHE[cache_key] = result
                return result
        except (KeyError, ValueError, TypeError, OSError):
            pass  # An incomplete or incompatible cache is re-probed.
    document = json.loads(_run([_command(config, 'ffprobe'), '-v', 'error', '-select_streams', 'v:0',
        '-show_streams', '-show_frames', '-show_entries',
        'stream=index,width,height,time_base,start_pts,duration_ts,avg_frame_rate,codec_name:frame=pts,best_effort_timestamp,pkt_duration',
        '-of', 'json', str(source)]))
    stream = document['streams'][0]
    time_base = Fraction(stream['time_base'])
    frames = []
    for index, frame in enumerate(document.get('frames', [])):
        pts = frame.get('pts')
        if pts is None:
            raise ValueError(f'Original integer PTS missing for decoded frame {index}; refusing inferred timestamps')
        pts = int(pts)
        frames.append({'original_frame_id': index, 'original_pts': pts,
                       'time_base': str(time_base), 'time_seconds': float(pts * time_base)})
    if not frames:
        raise ValueError('No video frames found')
    if any(a['original_pts'] > b['original_pts'] for a, b in zip(frames, frames[1:])):
        raise ValueError('Decoded presentation timestamps are not monotonic')
    result = {'schema_version': 'ar-v2-video-probe/1', 'video_path': str(source),
              'source_video_hash': _sha256(source), 'source_size_bytes': stat.st_size,
              'source_mtime_ns': stat.st_mtime_ns, 'width': int(stream['width']),
              'height': int(stream['height']), 'time_base': str(time_base),
              'start_pts': stream.get('start_pts', frames[0]['original_pts']),
              'duration_ts': stream.get('duration_ts'), 'avg_frame_rate': stream.get('avg_frame_rate'),
              'codec_name': stream.get('codec_name'), 'frame_count': len(frames), 'frames': frames}
    if len(_PROBE_CACHE) >= 4:
        _PROBE_CACHE.clear()
    _PROBE_CACHE[cache_key] = result
    return result


def _profile(config, probe):
    camera = config.get('camera', {})
    width_raw, height_raw = probe['width'], probe['height']
    calibrated_size = camera.get('calibration_raw_size', camera.get('raw_size', [3840, 2160]))
    if list(calibrated_size) != [width_raw, height_raw]:
        raise ValueError(f'Camera calibration raw size {calibrated_size} differs from video size {[width_raw, height_raw]}')
    width = int(config.get('media', {}).get('width', width_raw))
    if width <= 0:
        raise ValueError('media.width must be positive')
    height = max(1, int(round(height_raw * width / width_raw)))
    K_raw = np.asarray(camera['K_raw'], dtype=float).reshape(3, 3)
    D_raw = np.asarray(camera.get('D_raw', [0, 0, 0, 0, 0]), dtype=float).reshape(-1)
    if not np.isfinite(K_raw).all() or not np.isfinite(D_raw).all() or K_raw[0, 0] <= 0 or K_raw[1, 1] <= 0:
        raise ValueError('Camera calibration must have finite values and positive focal lengths')
    if D_raw.size not in (4, 5, 8, 12, 14):
        raise ValueError('D_raw must use OpenCV Brown-Conrady 4/5/8/12/14 coefficients')
    K_rect = scale_intrinsics(K_raw, width / width_raw, height / height_raw)
    # Keep a single explicitly documented pinhole K. OpenCV remap finds valid pixels.
    map_x, map_y = cv2.initUndistortRectifyMap(K_raw, D_raw, None, K_rect,
                                             (width, height), cv2.CV_32FC1)
    valid = ((map_x >= 0) & (map_y >= 0) & (map_x <= width_raw - 1) & (map_y <= height_raw - 1))
    # Bounding ROI alone does not imply all its pixels are valid for nonlinear lenses.
    # The conservative rectangle is shrunk until every enclosed pixel is valid.
    left, top, right, bottom = 0, 0, width, height
    while right > left and bottom > top:
        section = valid[top:bottom, left:right]
        if section.all():
            break
        invalid_edges = [np.count_nonzero(~section[0]), np.count_nonzero(~section[-1]),
                         np.count_nonzero(~section[:, 0]), np.count_nonzero(~section[:, -1])]
        edge = int(np.argmax(invalid_edges))
        if max(invalid_edges) == 0:
            raise ValueError('Rectification valid mask has interior holes')
        if edge == 0: top += 1
        elif edge == 1: bottom -= 1
        elif edge == 2: left += 1
        else: right -= 1
    version = str(camera.get('calibration_version', camera.get('version', 'estimated-v1')))
    fingerprint = hashlib.sha256(json.dumps({'K_raw': K_raw.tolist(), 'D_raw': D_raw.tolist(),
        'K_rect': K_rect.tolist(), 'raw_size': [width_raw, height_raw], 'size': [width, height],
        'version': version}, sort_keys=True).encode()).hexdigest()[:16]
    profile = {'id': 'rectified-' + fingerprint, 'camera_profile_id': 'rectified-' + fingerprint,
               'calibration_version': version, 'version': version,
               'status': camera.get('status', 'estimated'),
               'K_raw': K_raw.reshape(-1).tolist(), 'D_raw': D_raw.tolist(),
               'K_rect': K_rect.reshape(-1).tolist(), 'K': K_rect.tolist(),
               'distortion': [0, 0, 0, 0, 0], 'distortion_model': 'opencv-brown-conrady',
               'width': width, 'height': height, 'raw_width': width_raw, 'raw_height': height_raw,
               'raw_size': [width_raw, height_raw], 'rectified_size': [width, height],
               'calibration_raw_size': list(calibrated_size),
               'validROI': [left, top, max(0, right - left), max(0, bottom - top)],
               'pixel_coordinates': 'zero-based pixel centers; resize c=s*(c+0.5)-0.5',
               'image_domain': 'rectified', 'rectification_rotation': np.eye(3).tolist()}
    return profile, map_x, map_y


def _decode_exact(config, frame):
    """Decode the selected original PTS with PyAV, falling back to ffmpeg select."""
    try:
        import av
    except ImportError:
        av = None
    if av is not None:
        with av.open(str(config['video_path'])) as container:
            stream = container.streams.video[0]
            target = Fraction(frame['original_pts']) * Fraction(frame['time_base'])
            seek_pts = int(target / stream.time_base)
            container.seek(seek_pts, backward=True, any_frame=False, stream=stream)
            for decoded in container.decode(stream):
                if decoded.pts is None:
                    continue
                actual = decoded.pts * decoded.time_base
                if actual == target:
                    return decoded.to_ndarray(format='bgr24'), 'pyav-exact-pts'
                if actual > target:
                    break
        raise RuntimeError(f'Exact original PTS {frame["original_pts"]} was not decoded')
    arguments = [_command(config, 'ffmpeg'), '-v', 'error', '-noautorotate', '-i', str(config['video_path']),
                 '-vf', f'select=eq(n\\,{frame["original_frame_id"]})', '-frames:v', '1',
                 '-fps_mode', 'passthrough', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']
    result = subprocess.run(arguments, capture_output=True, check=False, timeout=600)
    if result.returncode:
        raise RuntimeError(result.stderr.decode('utf-8', errors='replace')[-4000:])
    image = cv2.imdecode(np.frombuffer(result.stdout, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError('ffmpeg failed to return the selected frame')
    return image, 'ffmpeg-decoded-frame-selection'


def _read_image(path):
    return cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_COLOR)


def _save_image(path, image):
    success, encoded = cv2.imencode('.png', image)
    if not success:
        raise RuntimeError(f'Could not encode image: {path}')
    encoded.tofile(str(path))


def extract_frames(config: dict, times=None) -> dict:
    """Write raw and rectified images with auditable original frame identity."""
    requested = list(config.get('media', {}).get('times', _DEFAULT_TIMES) if times is None else times)
    if not requested or any(not math.isfinite(float(t)) or float(t) < 0 for t in requested):
        raise ValueError('Requested times must be a nonempty list of finite nonnegative seconds')
    probe = probe_video(config)
    profile, map_x, map_y = _profile(config, probe)
    output = Path(config['output_dir']).resolve() / 'media'
    raw_dir, rect_dir = output / 'raw', output / 'rectified'
    raw_dir.mkdir(parents=True, exist_ok=True)
    rect_dir.mkdir(parents=True, exist_ok=True)
    mask_path = output / ('valid_mask_' + profile['id'] + '.png')
    valid_mask = (((map_x >= 0) & (map_y >= 0) & (map_x <= probe['width'] - 1)
                   & (map_y <= probe['height'] - 1)).astype(np.uint8) * 255)
    if not mask_path.exists():
        _save_image(mask_path, valid_mask)
    profile['valid_mask_path'] = mask_path.relative_to(output.parent).as_posix()
    manifest_path = output / 'video_manifest.json'
    records, mappings = {}, []
    if manifest_path.exists():
        previous = json.loads(manifest_path.read_text(encoding='utf-8'))
        if previous.get('source_video_hash') == probe['source_video_hash'] and previous.get('camera_profile_id') == profile['id']:
            records = {int(row['original_frame_id']): row for row in previous.get('frames', [])}
            mappings = previous.get('time_mapping', [])
    for count, requested_time in enumerate(requested):
        requested_time = float(requested_time)
        if requested_time > probe['frames'][-1]['time_seconds'] + float(Fraction(probe['time_base'])):
            raise ValueError(f'Requested time {requested_time} is beyond the last video PTS')
        frame = min(probe['frames'], key=lambda row: abs(row['time_seconds'] - requested_time))
        index = frame['original_frame_id']
        stem = f'frame_{index:06d}_pts_{frame["original_pts"]}'
        raw_path, rect_path = raw_dir / (stem + '.png'), rect_dir / (stem + '_' + profile['id'] + '.png')
        record = records.get(index)
        if record is None or not raw_path.exists() or not rect_path.exists():
            raw, decoder = _decode_exact(config, frame)
            if raw.shape[:2] != (probe['height'], probe['width']):
                raise ValueError('Decoded dimensions differ from probed raw camera dimensions')
            rectified = cv2.remap(raw, map_x, map_y, interpolation=cv2.INTER_LINEAR,
                                  borderMode=cv2.BORDER_CONSTANT)
            _save_image(raw_path, raw)
            _save_image(rect_path, rectified)
            record = {**frame, 'raw_image': str(raw_path), 'rectified_image': str(rect_path),
                      'source_video_hash': probe['source_video_hash'], 'camera_profile_id': profile['id'],
                      'calibration_version': profile['calibration_version'], 'decoder': decoder}
            records[index] = record
        record.update({'rectified_path': rect_path.relative_to(output.parent).as_posix(),
                       'raw_path': raw_path.relative_to(output.parent).as_posix(),
                       'valid_mask_path': profile['valid_mask_path'],
                       'width': profile['width'], 'height': profile['height']})
        mappings = [row for row in mappings if row['requested_time_seconds'] != requested_time]
        mappings.append({'requested_time_seconds': requested_time, **frame,
                         'time_error_seconds': frame['time_seconds'] - requested_time})
        try:
            from .io import progress
        except ImportError:
            progress = None
        if progress is not None:
            progress(config, 'extract_frames', count + 1, len(requested), {'original_pts': frame['original_pts']})
    manifest = {key: value for key, value in probe.items() if key != 'frames'}
    manifest.update({'schema_version': 'ar-v2-video-manifest/1', 'camera_profile_id': profile['id'],
                     'calibration_version': profile['calibration_version'],
                     'camera_profiles_path': str(output / 'camera_profiles.json'),
                     'frame_index_path': str(output / 'original_frame_index.json'),
                     'frames': sorted(records.values(), key=lambda row: row['original_frame_id']),
                     'time_mapping': sorted(mappings, key=lambda row: row['requested_time_seconds']),
                     'timestamp_policy': 'nearest original integer presentation timestamp; no nominal-fps conversion'})
    _write_json(output / 'original_frame_index.json', {'time_base': probe['time_base'],
        'source_video_hash': probe['source_video_hash'], 'frames': probe['frames']})
    _write_json(output / 'camera_profiles.json', {'schema_version': 'ar-v2-camera-profiles/1',
        'active_profile_id': profile['id'], 'profiles': [profile]})
    _write_json(manifest_path, manifest)
    return manifest


def load_frame(config: dict, time_seconds: float):
    """Return rectified BGR, original frame metadata, rectified camera profile."""
    manifest = extract_frames(config, [time_seconds])
    mapping = next(row for row in manifest['time_mapping'] if row['requested_time_seconds'] == float(time_seconds))
    frame = next(row for row in manifest['frames'] if row['original_frame_id'] == mapping['original_frame_id'])
    profiles = json.loads(Path(manifest['camera_profiles_path']).read_text(encoding='utf-8'))
    profile = next(row for row in profiles['profiles'] if row['id'] == frame['camera_profile_id'])
    image = _read_image(frame['rectified_image'])
    if image is None:
        raise RuntimeError('Rectified image could not be read')
    return image, {**frame, 'requested_time_seconds': float(time_seconds)}, profile


def find_extracted_frame(config: dict, pts: int, profile_id: str) -> dict:
    """Find an extracted frame without decoding; paths are output-relative."""
    output = Path(config['output_dir']).resolve()
    manifest = json.loads((output / 'media' / 'video_manifest.json').read_text(encoding='utf-8'))
    if manifest.get('camera_profile_id') != profile_id:
        raise ValueError('Requested camera profile does not match the extracted media')
    for row in manifest['frames']:
        if row['original_pts'] == int(pts) and row['camera_profile_id'] == profile_id:
            for key in ('rectified_path', 'valid_mask_path'):
                candidate = (output / row[key]).resolve()
                if not candidate.is_relative_to(output) or not candidate.is_file():
                    raise ValueError(f'Extracted media path is unavailable: {key}')
            return dict(row)
    raise KeyError(f'Original PTS {pts} has not been extracted for profile {profile_id}')
