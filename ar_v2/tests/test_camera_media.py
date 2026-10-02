"""Independent geometry and exact video identity regression tests."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import numpy as np

from ar_v2.camera import (camera_from_telemetry, ecef_from_enu, geodetic_to_ecef,
                          project, scale_intrinsics, telemetry_camera, validate_transform)
from ar_v2 import media


class CameraGeometryTests(unittest.TestCase):
    def test_enu_is_right_handed_and_has_geodetic_origin(self):
        transform = ecef_from_enu(120.8, 30.8, 12)
        np.testing.assert_allclose(transform[:3, 3], geodetic_to_ecef(120.8, 30.8, 12))
        validate_transform(transform)
        np.testing.assert_allclose(np.linalg.inv(transform) @ np.r_[transform[:3, 3], 1], [0, 0, 0, 1], atol=1e-8)

    def test_north_camera_convention_and_positive_depth(self):
        transform = camera_from_telemetry(0, 0, 0, 0, 0, 0, [0, 0, 0])
        K = [[100, 0, 50], [0, 100, 40], [0, 0, 1]]
        pixels, depths, valid = project([[0, 10, 0], [1, 10, 0], [0, 10, 1], [0, -10, 0]], K, transform)
        np.testing.assert_allclose(pixels[:3], [[50, 40], [60, 40], [50, 30]], atol=1e-7)
        self.assertEqual(valid.tolist(), [True, True, True, False])
        self.assertTrue(np.isnan(pixels[-1]).all())
        self.assertLess(depths[-1], 0)

    def test_nadir_and_east_camera_attitude(self):
        nadir = camera_from_telemetry(0, 0, 100, 0, -90, 0, [0, 0, 0])
        camera_origin = nadir @ np.array([0, 0, 0, 1])
        np.testing.assert_allclose(camera_origin, [0, 0, 100, 1], atol=1e-7)
        east = camera_from_telemetry(0, 0, 0, 90, 0, 0, [0, 0, 0])
        np.testing.assert_allclose(east[:3, :3] @ [10, 0, 0], [0, 0, 10], atol=1e-7)

    def test_pixel_centers_scale_including_skew(self):
        K = [[2560, 8, 1920], [0, 2560, 1080], [0, 0, 1]]
        scaled = scale_intrinsics(K, 0.5)
        np.testing.assert_allclose(scaled, [[1280, 4, 959.75], [0, 1280, 539.75], [0, 0, 1]])

    def test_reflections_are_rejected(self):
        invalid = np.eye(4)
        invalid[0, 0] = -1
        with self.assertRaises(ValueError):
            validate_transform(invalid)

    def test_telemetry_keeps_height_hypotheses_estimated(self):
        with tempfile.TemporaryDirectory() as directory:
            trajectory = Path(directory) / 'trajectory.json'
            trajectory.write_text(json.dumps({'trajectory_points': [{
                'video_time_ms': 10010, 'video_sample_index': 300,
                'position': {'longitude': 0, 'latitude': 0, 'altitude': 99.117, 'relative_altitude': 70.001},
                'gimbal_attitude': {'yaw': -30, 'pitch': -30, 'roll': 0}}]}), encoding='utf-8')
            config = {'trajectory_path': str(trajectory), 'origin': [0, 0, 0]}
            absolute = telemetry_camera(config, 10.01, 'absolute')
            relative = telemetry_camera(config, 10.01, 'relative')
            self.assertEqual(absolute['height_m'], 99.117)
            self.assertEqual(relative['height_m'], 70.001)
            self.assertTrue(absolute['prior_only'])
            self.assertEqual(relative['height_status'], 'estimated')


class MediaIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.config = {'output_dir': self.temporary.name, 'video_path': 'synthetic.mp4',
                       'media': {'width': 32},
                       'camera': {'K_raw': [40, 0, 31.5, 0, 40, 17.5, 0, 0, 1],
                                  'D_raw': [0, 0, 0, 0, 0], 'status': 'estimated', 'raw_size': [64, 36]}}
        # Deliberate VFR gaps make index/fps inference observably wrong.
        self.probe = {'width': 64, 'height': 36, 'source_video_hash': 'test-video-sha256',
                      'time_base': '1/1000', 'frame_count': 3,
                      'frames': [{'original_frame_id': i, 'original_pts': pts, 'time_base': '1/1000',
                                  'time_seconds': pts / 1000} for i, pts in enumerate([0, 33, 101])]}

    def test_variable_pts_identity_rectified_calibration_and_cache(self):
        raw = np.full((36, 64, 3), 120, np.uint8)
        with mock.patch.object(media, 'probe_video', return_value=self.probe), \
                mock.patch.object(media, '_decode_exact', return_value=(raw, 'test-exact-pts')) as decoder:
            manifest = media.extract_frames(self.config, [0.099])
            frame = manifest['frames'][0]
            self.assertEqual((frame['original_frame_id'], frame['original_pts']), (2, 101))
            image, identity, profile = media.load_frame(self.config, 0.099)
            self.assertEqual(image.shape, (18, 32, 3))
            self.assertEqual(identity['original_pts'], 101)
            self.assertEqual(profile['K'][0][2], 15.5)
            self.assertEqual(profile['K'][1][2], 8.5)
            self.assertEqual(profile['distortion'], [0, 0, 0, 0, 0])
            self.assertEqual(decoder.call_count, 1)
            self.assertEqual(manifest['time_mapping'][0]['time_error_seconds'], 0.101 - 0.099)
            original_index = json.loads(Path(manifest['frame_index_path']).read_text())
            self.assertEqual([row['original_pts'] for row in original_index['frames']], [0, 33, 101])

    def test_rejects_unavailable_requested_times(self):
        with mock.patch.object(media, 'probe_video', return_value=self.probe):
            with self.assertRaises(ValueError):
                media.extract_frames(self.config, [120])
            with self.assertRaises(ValueError):
                media.extract_frames(self.config, [float('nan')])

    def test_calibration_change_changes_profile_identity(self):
        profile_a, _, _ = media._profile(self.config, self.probe)
        self.config['camera']['K_raw'][0] = 45
        profile_b, _, _ = media._profile(self.config, self.probe)
        self.assertNotEqual(profile_a['id'], profile_b['id'])

    def test_calibration_cannot_silently_apply_to_other_video_size(self):
        self.config['camera']['raw_size'] = [3840, 2160]
        with self.assertRaises(ValueError):
            media._profile(self.config, self.probe)


if __name__ == '__main__':
    unittest.main()
