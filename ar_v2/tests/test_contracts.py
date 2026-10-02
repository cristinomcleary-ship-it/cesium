import copy
import unittest
import numpy as np
from ar_v2.contracts import validate_pose_record


class PoseContractTests(unittest.TestCase):
    def setUp(self):
        self.pose = {
            'schema_version': 'ar-v2.pose.v1', 'status': 'LOCALIZED', 'accepted': False,
            'source_video_hash': 'synthetic', 'original_frame_id': 300,
            'original_pts': 300300, 'time_base': '1/30000', 'time_seconds': 10.01,
            'camera_profile_id': 'profile', 'calibration_version': 'estimated',
            'geometry_version': 'geometry', 'width': 1920, 'height': 1080,
            'K': [1200, 0, 960, 0, 1200, 540, 0, 0, 1],
            'T_camera_from_scene': np.eye(4).reshape(-1).tolist(),
            'metrics': {'independent_checkpoints': None},
        }

    def test_localized_without_checkpoints_is_unaccepted(self):
        validate_pose_record(self.pose)

    def test_acceptance_requires_passing_independent_evidence(self):
        pose = copy.deepcopy(self.pose)
        pose['accepted'] = True
        pose['metrics']['independent_checkpoints'] = {}
        with self.assertRaises(ValueError):
            validate_pose_record(pose)
        report = dict(count=6, positive_depth_fraction=1., rms_px1080=2.,
                      p95_px1080=5., maximum_px1080=8.)
        pose['metrics']['independent_checkpoints'] = report
        validate_pose_record(pose)
        for change in ({'count': 5}, {'rms_px1080': 4.}, {'p95_px1080': 7.},
                       {'maximum_px1080': 11.}, {'positive_depth_fraction': .9}):
            pose['metrics']['independent_checkpoints'] = {**report, **change}
            with self.assertRaises(ValueError):
                validate_pose_record(pose)
        pose['metrics']['independent_checkpoints'] = report
        pose['status'] = 'DEGRADED'
        with self.assertRaises(ValueError):
            validate_pose_record(pose)

    def test_nonfinite_or_nonrigid_camera_is_rejected(self):
        for field, index, value in [('K', 0, float('nan')), ('K', 4, -1),
                                    ('T_camera_from_scene', 0, 2),
                                    ('T_camera_from_scene', 15, 0)]:
            pose = copy.deepcopy(self.pose)
            pose[field][index] = value
            with self.assertRaises(ValueError):
                validate_pose_record(pose)

    def test_pose_time_is_bound_to_integer_pts(self):
        pose = copy.deepcopy(self.pose)
        pose['time_seconds'] += .3
        with self.assertRaises(ValueError):
            validate_pose_record(pose)


if __name__ == '__main__':
    unittest.main()
