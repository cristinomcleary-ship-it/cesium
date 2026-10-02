"""Checkpoint-source binding and full-observation refinement regressions."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from ar_v2.validation import load_checkpoints, preserve_observation_denominator


class CheckpointIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "checkpoints.json"
        self.config = {"validation": {"checkpoints_path": str(self.path)}}
        self.identity = {"source_video_hash": "video-A", "original_frame_id": 300,
                         "original_pts": 300300, "time_base": "1/30000",
                         "geometry_version": "geometry-A", "camera_profile_id": "camera-A",
                         "calibration_version": "calibration-A"}
        self.point = {"id": "withheld-1", "time_seconds": 10.01,
                      "scene_xyz": [1., 2., 3.], "video_xy": [100., 200.]}

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, document):
        self.path.write_text(json.dumps(document), encoding="utf-8")

    def bound_point(self):
        return {**self.point, **self.identity}

    def test_no_checkpoint_file_config_returns_none_without_identity(self):
        self.assertIsNone(load_checkpoints({}, 10.01))
        self.assertIsNone(load_checkpoints({"validation": {}}, 10.01, None))

    def test_common_identity_plus_per_point_frame_identity(self):
        frame_keys = ("original_frame_id", "original_pts", "time_base")
        common = {key: value for key, value in self.identity.items() if key not in frame_keys}
        point = {**self.point, **{key: self.identity[key] for key in frame_keys}}
        self.write({**common, "checkpoints": [point]})
        self.assertEqual(load_checkpoints(self.config, 10.01, self.identity), [point])

    def test_each_point_may_carry_complete_identity(self):
        point = self.bound_point()
        self.write([point])
        self.assertEqual(load_checkpoints(self.config, 10.01, self.identity), [point])

    def test_nested_common_identity_is_supported(self):
        self.write({"identity": self.identity, "checkpoints": [self.point]})
        self.assertEqual(load_checkpoints(self.config, 10.01, self.identity), [self.point])

    def test_each_identity_field_must_match_at_same_timestamp(self):
        wrong = {"source_video_hash": "video-B", "original_frame_id": 301,
                 "original_pts": 301301, "time_base": "1/1000",
                 "geometry_version": "geometry-B", "camera_profile_id": "camera-B",
                 "calibration_version": "calibration-B"}
        for key, value in wrong.items():
            with self.subTest(field=key):
                point = self.bound_point()
                point[key] = value
                self.write([point])
                with self.assertRaisesRegex(ValueError, key):
                    load_checkpoints(self.config, 10.01, self.identity)

    def test_missing_expected_identity_cannot_be_skipped(self):
        self.write([self.bound_point()])
        with self.assertRaisesRegex(ValueError, "expected pose/frame identity"):
            load_checkpoints(self.config, 10.01)
        expected = dict(self.identity)
        del expected["geometry_version"]
        with self.assertRaisesRegex(ValueError, "geometry_version"):
            load_checkpoints(self.config, 10.01, expected)

    def test_missing_checkpoint_identity_is_rejected(self):
        point = self.bound_point()
        del point["original_pts"]
        self.write([point])
        with self.assertRaisesRegex(ValueError, "original_pts"):
            load_checkpoints(self.config, 10.01, self.identity)

    def test_conflicting_common_and_point_identity_is_rejected(self):
        point = self.bound_point()
        self.write({"source_video_hash": "conflicting-video", "checkpoints": [point]})
        with self.assertRaisesRegex(ValueError, "Conflicting.*source_video_hash"):
            load_checkpoints(self.config, 10.01, self.identity)

    def test_equivalent_positive_rational_time_base_is_supported(self):
        point = self.bound_point()
        point["time_base"] = [2, 60000]
        self.write([point])
        self.assertEqual(len(load_checkpoints(self.config, 10.01, self.identity)), 1)

    def test_boolean_pts_cannot_impersonate_integer_identity(self):
        point = self.bound_point()
        point["original_pts"] = True
        self.write([point])
        with self.assertRaisesRegex(ValueError, "original_pts"):
            load_checkpoints(self.config, 10.01, self.identity)

    def test_another_timestamp_is_not_reused(self):
        point = self.bound_point()
        point["time_seconds"] = 20.02
        self.write([point])
        self.assertEqual(load_checkpoints(self.config, 10.01, self.identity), [])


class RefinementDenominatorTests(unittest.TestCase):
    def assessment(self, inliers=30, accepted=True):
        return {"status": "LOCALIZED", "accepted": accepted, "reasons": [],
                "metrics": {"matches": inliers, "inliers": inliers, "inlier_ratio": 1.,
                            "independent_checkpoints": {"count": 6}}}

    def test_rejected_points_remain_in_ratio_denominator(self):
        result = preserve_observation_denominator(self.assessment(30),
            {"matches": 200, "inlier_ratio_denominator": "all_unique_valid_video_observations"})
        self.assertEqual(result["metrics"]["matches"], 200)
        self.assertEqual(result["metrics"]["selected_matches"], 30)
        self.assertAlmostEqual(result["metrics"]["inlier_ratio"], .15)
        self.assertEqual(result["metrics"]["solver_inlier_ratio"], 1.)
        self.assertEqual(result["status"], "DEGRADED")
        self.assertFalse(result["accepted"])
        self.assertIn("low_inlier_ratio", result["reasons"])

    def test_passing_complete_ratio_remains_localized(self):
        result = preserve_observation_denominator(self.assessment(30), {"matches": 100})
        self.assertAlmostEqual(result["metrics"]["inlier_ratio"], .3)
        self.assertEqual(result["status"], "LOCALIZED")
        self.assertTrue(result["accepted"])

    def test_missing_independent_acceptance_is_never_promoted(self):
        result = preserve_observation_denominator(self.assessment(30, False), {"matches": 100})
        self.assertFalse(result["accepted"])

    def test_reapplying_full_denominator_is_idempotent(self):
        original = {"matches": 200}
        first = preserve_observation_denominator(self.assessment(30), original)
        expected = copy.deepcopy(first)
        second = preserve_observation_denominator(first, original)
        self.assertEqual(second, expected)

    def test_missing_or_smaller_original_denominator_is_rejected(self):
        for original in ({}, {"matches": 10}, {"matches": True}):
            with self.subTest(original=original):
                with self.assertRaises(ValueError):
                    preserve_observation_denominator(self.assessment(30), original)


if __name__ == "__main__":
    unittest.main()
