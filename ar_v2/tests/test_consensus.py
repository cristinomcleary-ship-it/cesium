"""Consensus regressions: wrong references cannot poison unique visual support."""
import unittest
from unittest.mock import patch
import numpy as np
from ar_v2.consensus import select_consensus, solve_reference_hypotheses


class ConsensusTests(unittest.TestCase):
    def setUp(self):
        self.rng = np.random.default_rng(66)
        self.K = np.array([[1200., 0, 959.5], [0, 1200., 539.5], [0, 0, 1.]])
        self.pixels = self.rng.uniform([60, 50], [1860, 1030], (180, 2))
        self.z = self.rng.uniform(18, 70, len(self.pixels))
        self.xyz = np.column_stack(((self.pixels[:, 0]-959.5)*self.z/1200,
                                    (self.pixels[:, 1]-539.5)*self.z/1200, self.z))

    def hypothesis(self, name="visual", transform=None, **changes):
        candidate = {"id": name, "status": "DEGRADED", "reasons": ["insufficient_image_coverage"],
                     "T_camera_from_scene": (np.eye(4) if transform is None else transform).reshape(-1).tolist(),
                     "metrics": {"inliers": 60, "positive_depth_fraction": 1.0, "linearity_ratio": .25}}
        candidate.update(changes)
        return candidate

    def raw(self, pixels=None, xyz=None, ids=None):
        pixels = self.pixels.copy() if pixels is None else pixels
        xyz = self.xyz.copy() if xyz is None else xyz
        return {"video_xy": pixels, "scene_xyz": xyz, "score": np.full(len(pixels), .8),
                "valid_3d": np.ones(len(pixels), dtype=bool),
                "reference_id": np.asarray(["reference"]*len(pixels) if ids is None else ids)}

    def select(self, raw, candidates=None, **kwargs):
        return select_consensus(raw, candidates or [self.hypothesis()], self.K, 1920, 1080, **kwargs)

    def test_inconsistent_reference_does_not_poison_correct_anchors(self):
        raw = self.raw(np.vstack([self.pixels, self.pixels]),
                       np.vstack([self.xyz, self.xyz+[500, 200, 0]]))
        result = self.select(raw)
        self.assertEqual(result["assessment"]["status"], "LOCALIZED")
        self.assertEqual(result["assessment"]["metrics"]["inliers"], 180)
        self.assertEqual(result["diagnostics"]["unique_valid_observations"], 180)
        self.assertTrue(np.all(result["selected_raw_indices"] < 180))
        self.assertEqual(result["diagnostics"]["selected_support"]["ambiguous_groups"], 0)
        np.testing.assert_allclose(np.asarray(result["assessment"]["T_camera_from_scene"]).reshape(4, 4),
                                   np.eye(4), atol=1e-5)
        self.assertFalse(result["assessment"]["accepted"])

    def test_two_separated_anchors_on_same_ray_are_ambiguous(self):
        raw = self.raw(np.vstack([self.pixels, self.pixels]), np.vstack([self.xyz, self.xyz*1.5]))
        result = self.select(raw)
        self.assertEqual(result["assessment"]["status"], "LOST")
        self.assertIsNone(result["assessment"]["T_camera_from_scene"])
        self.assertEqual(result["diagnostics"]["selected_support"]["ambiguous_groups"], 180)
        self.assertEqual(len(result["selected_raw_indices"]), 0)

    def test_ratio_denominator_includes_unmatched_original_observations(self):
        xyz = self.xyz.copy()
        xyz[30:] += [200, 300, 0]
        result = self.select(self.raw(xyz=xyz))
        metrics = result["assessment"]["metrics"]
        self.assertEqual(metrics["inliers"], 30)
        self.assertEqual(metrics["matches"], 180)
        self.assertEqual(metrics["selected_matches"], 30)
        self.assertAlmostEqual(metrics["solver_inlier_ratio"], 1.)
        self.assertAlmostEqual(metrics["inlier_ratio"], 30/180)
        self.assertEqual(result["assessment"]["status"], "DEGRADED")
        self.assertIn("low_inlier_ratio", result["assessment"]["reasons"])

    def test_coverage_gate_remains_six_cells(self):
        pixels = self.rng.uniform([1550, 420], [1770, 590], (180, 2))
        xyz = np.column_stack(((pixels[:, 0]-959.5)*self.z/1200,
                               (pixels[:, 1]-539.5)*self.z/1200, self.z))
        result = self.select(self.raw(pixels, xyz))
        self.assertEqual(result["assessment"]["status"], "DEGRADED")
        self.assertLess(result["assessment"]["metrics"]["grid_cells"], 6)
        self.assertIn("insufficient_image_coverage", result["assessment"]["reasons"])

    def test_invalid_depth_rotation_or_collinearity_cannot_seed(self):
        bad_rotation = np.eye(4)
        bad_rotation[0, 0] = 2.
        candidates = [self.hypothesis("rotation", bad_rotation),
                      self.hypothesis("depth", metrics={"inliers": 50, "positive_depth_fraction": .5, "linearity_ratio": .3}),
                      self.hypothesis("line", metrics={"inliers": 50, "positive_depth_fraction": 1., "linearity_ratio": .001})]
        result = self.select(self.raw(), candidates)
        self.assertEqual(result["assessment"]["status"], "LOST")
        self.assertEqual(len(result["diagnostics"]["rejected_hypotheses"]), 3)
        self.assertEqual(result["diagnostics"]["evaluated_hypotheses"], 0)

    def test_competing_well_supported_distant_poses_stay_degraded(self):
        alternate = np.eye(4)
        alternate[0, 3] = 50.
        raw = self.raw(np.vstack([self.pixels, self.pixels]), np.vstack([self.xyz, self.xyz-[50, 0, 0]]))
        result = self.select(raw, [self.hypothesis("first"), self.hypothesis("repeat", alternate)])
        self.assertEqual(result["assessment"]["status"], "DEGRADED")
        self.assertIn("ambiguous_visual_hypotheses", result["assessment"]["reasons"])
        self.assertEqual(len(result["diagnostics"]["competing_visual_hypotheses"]), 1)
        self.assertAlmostEqual(result["diagnostics"]["competing_visual_hypotheses"][0]["translation_m"], 50., places=4)

    def test_reference_solver_and_consensus_use_no_telemetry(self):
        raw = self.raw(np.vstack([self.pixels, self.pixels]), np.vstack([self.xyz, self.xyz]),
                       ["a"]*180+["b"]*180)
        with patch("ar_v2.camera.telemetry_camera", side_effect=AssertionError("Telemetry forbidden")):
            candidates = solve_reference_hypotheses(raw, self.K, 1920, 1080)
            result = self.select(raw, candidates)
        self.assertEqual(len(candidates), 2)
        self.assertEqual(result["assessment"]["status"], "LOCALIZED")
        self.assertFalse(result["diagnostics"]["telemetry_used"])
        self.assertEqual(result["diagnostics"]["competing_visual_hypotheses"], [])

    def test_withheld_checkpoints_do_not_affect_candidate_selection(self):
        raw = self.raw()
        ordinary = self.select(raw)
        checkpoints = [{"scene_xyz": xyz.tolist(), "video_xy": (pixel+[80, 0]).tolist()}
                       for xyz, pixel in zip(self.xyz[:8], self.pixels[:8])]
        checked = self.select(raw, checkpoints=checkpoints)
        np.testing.assert_array_equal(ordinary["selected_raw_indices"], checked["selected_raw_indices"])
        np.testing.assert_allclose(ordinary["assessment"]["T_camera_from_scene"],
                                   checked["assessment"]["T_camera_from_scene"], atol=1e-12)
        self.assertFalse(checked["assessment"]["accepted"])
        self.assertFalse(checked["diagnostics"]["checkpoints_used_for_selection_or_solve"])

    def test_raw_correspondences_are_not_modified(self):
        raw = self.raw()
        before = {key: value.copy() for key, value in raw.items()}
        self.select(raw)
        for key in raw:
            np.testing.assert_array_equal(raw[key], before[key])


if __name__ == "__main__":
    unittest.main()
