"""Independent V2 camera geometry.

World coordinates are local ENU metres. CV camera axes are right, down,
forward. Transforms multiply column vectors; JSON matrices are row-major.
DJI gimbal yaw is clockwise from north, pitch is positive up, and roll is
clockwise looking along the optical axis. Telemetry is a prior, not a fix.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

WGS84_A = 6378137.0
WGS84_E2 = 6.6943799901413165e-3


def geodetic_to_ecef(longitude: float, latitude: float, height: float) -> np.ndarray:
    """Convert WGS84 degrees and ellipsoidal metres to ECEF metres."""
    lon, lat = np.deg2rad([longitude, latitude])
    n = WGS84_A / np.sqrt(1.0 - WGS84_E2 * np.sin(lat) ** 2)
    return np.array([(n + height) * np.cos(lat) * np.cos(lon),
                     (n + height) * np.cos(lat) * np.sin(lon),
                     (n * (1 - WGS84_E2) + height) * np.sin(lat)])


def ecef_from_enu(origin_longitude: float, origin_latitude: float, origin_height: float) -> np.ndarray:
    """Return T_ecef_from_world for an ENU origin (lon, lat, height)."""
    lon, lat = np.deg2rad([origin_longitude, origin_latitude])
    matrix = np.eye(4)
    matrix[:3, :3] = [[-np.sin(lon), -np.sin(lat) * np.cos(lon), np.cos(lat) * np.cos(lon)],
                       [np.cos(lon), -np.sin(lat) * np.sin(lon), np.cos(lat) * np.sin(lon)],
                       [0.0, np.cos(lat), np.sin(lat)]]
    matrix[:3, 3] = geodetic_to_ecef(origin_longitude, origin_latitude, origin_height)
    return matrix


def validate_transform(transform, atol: float = 1e-6) -> np.ndarray:
    """Validate and return a rigid 4x4 transform (flat row-major accepted)."""
    matrix = np.asarray(transform, dtype=float).reshape(4, 4)
    if not np.isfinite(matrix).all() or not np.allclose(matrix[3], [0, 0, 0, 1], atol=atol):
        raise ValueError('Transform must be finite and homogeneous')
    rotation = matrix[:3, :3]
    if not np.allclose(rotation.T @ rotation, np.eye(3), atol=atol) or not np.isclose(np.linalg.det(rotation), 1, atol=atol):
        raise ValueError('Transform rotation must be right-handed and orthonormal')
    return matrix


def camera_from_telemetry(longitude: float, latitude: float, height: float,
                          yaw: float, pitch: float, roll: float, origin) -> np.ndarray:
    """Return T_camera_from_world using DJI angles in degrees.

    ``height`` is a caller-selected candidate in the origin's vertical datum.
    This function does not infer a relative/absolute altitude correction.
    """
    world_from_ecef = np.linalg.inv(ecef_from_enu(*origin))
    center = (world_from_ecef @ np.r_[geodetic_to_ecef(longitude, latitude, height), 1])[:3]
    y, p, r = np.deg2rad([yaw, pitch, roll])
    right = np.array([np.cos(y), -np.sin(y), 0.0])
    forward = np.array([np.sin(y) * np.cos(p), np.cos(y) * np.cos(p), np.sin(p)])
    down = np.cross(forward, right)
    # Attitude is expressed at the camera's geodetic tangent plane.
    origin_rotation = ecef_from_enu(*origin)[:3, :3]
    local_rotation = ecef_from_enu(longitude, latitude, height)[:3, :3]
    world_from_local = origin_rotation.T @ local_rotation
    world_from_camera = world_from_local @ np.column_stack((
        np.cos(r) * right + np.sin(r) * down,
        -np.sin(r) * right + np.cos(r) * down, forward))
    transform = np.eye(4)
    transform[:3, :3] = world_from_camera.T
    transform[:3, 3] = -world_from_camera.T @ center
    return validate_transform(transform)


def project(points_world, K, T_camera_from_world, *, min_depth: float = 1e-6):
    """Return (pixels Nx2, depths N, valid N); behind-camera pixels are NaN."""
    points = np.asarray(points_world, dtype=float).reshape(-1, 3)
    transform = validate_transform(T_camera_from_world)
    camera_points = points @ transform[:3, :3].T + transform[:3, 3]
    depths = camera_points[:, 2]
    valid = np.isfinite(camera_points).all(axis=1) & (depths > min_depth)
    homogeneous = camera_points @ np.asarray(K, dtype=float).reshape(3, 3).T
    pixels = np.full((len(points), 2), np.nan)
    pixels[valid] = homogeneous[valid, :2] / homogeneous[valid, 2:3]
    return pixels, depths, valid


def scale_intrinsics(K, scale_x: float, scale_y: float | None = None) -> np.ndarray:
    """Pixel-centre-correct resize: c' = scale * (c + 0.5) - 0.5."""
    if scale_y is None:
        scale_y = scale_x
    if scale_x <= 0 or scale_y <= 0:
        raise ValueError('Image scales must be positive')
    transform = np.array([[scale_x, 0, (scale_x - 1) / 2],
                          [0, scale_y, (scale_y - 1) / 2], [0, 0, 1]])
    return transform @ np.asarray(K, dtype=float).reshape(3, 3)


def _origin_from_config(config):
    origin = config.get('origin_wgs84', config.get('origin', config.get('world_origin', config.get('enu_origin'))))
    if origin is None:
        origin = config.get('world', {}).get('origin', config.get('scene', {}).get('origin'))
    if isinstance(origin, dict):
        return (origin.get('longitude', origin.get('lon')), origin.get('latitude', origin.get('lat')),
                origin.get('height', origin.get('altitude', 0)))
    if origin is None:
        raise ValueError('Explicit ENU origin required in config.origin (longitude,latitude,height)')
    return tuple(origin)


def telemetry_camera(config: dict, time_seconds: float, height_mode: str = 'absolute') -> dict:
    """Nearest timestamp telemetry candidate, explicitly unlocalized/estimated.

    relative altitude is a separate hypothesis at the same geographic position;
    no constant vertical offset is silently introduced.
    """
    data = json.loads(Path(config['trajectory_path']).read_text(encoding='utf-8-sig'))
    rows = data.get('trajectory_points', [])
    if not rows:
        raise ValueError('Trajectory contains no trajectory_points')
    row = min(rows, key=lambda item: abs(float(item['video_time_ms']) / 1000 - time_seconds))
    position, attitude = row['position'], row['gimbal_attitude']
    if height_mode not in ('absolute', 'relative'):
        raise ValueError('height_mode must be absolute or relative')
    height_key = 'altitude' if height_mode == 'absolute' else 'relative_altitude'
    height = float(position[height_key])
    transform = camera_from_telemetry(position['longitude'], position['latitude'], height,
                                      attitude['yaw'], attitude['pitch'], attitude['roll'],
                                      _origin_from_config(config))
    return {'T_world_to_camera': transform.tolist(), 'T_camera_from_world': transform.tolist(),
            'center_world': np.linalg.inv(transform)[:3, 3].tolist(),
            'prior_only': True, 'status': 'estimated', 'height_status': 'estimated',
            'height_mode': height_mode, 'height_m': height,
            'height_source': position.get('altitude_source', 'unspecified'),
            'vertical_datum': 'unverified', 'requested_time_seconds': float(time_seconds),
            'telemetry_time_seconds': float(row['video_time_ms']) / 1000,
            'telemetry_sample_index': row.get('video_sample_index'),
            'gimbal_attitude_degrees': dict(attitude)}
