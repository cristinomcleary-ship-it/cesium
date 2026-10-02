"""Geometry/quality regression tests independent of learned-model downloads."""
import unittest
import cv2
import numpy as np
from ar_v2.localization import (SiftMatcher, deduplicate_correspondences,
                                lift_reference_points, solve_correspondences)
from ar_v2.validation import (evaluate_checkpoints, grid_coverage,
                              project_points, residual_statistics)


class LocalizationTests(unittest.TestCase):
    def setUp(self):
        self.K = np.array([[1200., 0, 960], [0, 1200, 540], [0, 0, 1.]])
        self.rng = np.random.default_rng(9)
        self.pixels = self.rng.uniform([80, 60], [1840, 1020], (180, 2))
        z = self.rng.uniform(12, 60, len(self.pixels))
        camera = np.column_stack(((self.pixels[:, 0]-960)*z/1200,
                                  (self.pixels[:, 1]-540)*z/1200, z))
        self.T = np.eye(4)
        self.T[:3, :3] = cv2.Rodrigues(np.array([.13, -.09, .04]))[0]
        self.T[:3, 3] = [2, -3, 1]
        self.xyz = (camera - self.T[:3, 3]) @ self.T[:3, :3]

    def test_metric_pose_recovers_with_outliers(self):
        observations = self.pixels + self.rng.normal(0, .2, self.pixels.shape)
        observations[:40] += self.rng.uniform(50, 300, (40, 2))
        result = solve_correspondences(self.xyz, observations, self.K, 1920, 1080)
        self.assertEqual(result["status"], "LOCALIZED")
        self.assertGreaterEqual(result["metrics"]["inliers"], 135)
        self.assertLess(np.linalg.norm(np.asarray(result["T_camera_from_scene"]).reshape(4, 4) - self.T), .03)
        self.assertIsNone(result["metrics"]["independent_checkpoints"])
        self.assertFalse(result["accepted"])

    def test_withheld_points_do_not_change_solve(self):
        ordinary = solve_correspondences(self.xyz, self.pixels, self.K, 1920, 1080)
        checks = [{"scene_xyz": xyz.tolist(), "video_xy": (pixel + [50, 0]).tolist()}
                  for xyz, pixel in zip(self.xyz[:8], self.pixels[:8])]
        withheld = solve_correspondences(self.xyz, self.pixels, self.K, 1920, 1080,
                                        checkpoints=checks)
        np.testing.assert_allclose(ordinary["T_camera_from_scene"], withheld["T_camera_from_scene"], atol=1e-10)
        self.assertFalse(withheld["accepted"])
        self.assertGreater(withheld["metrics"]["independent_checkpoints"]["rms_px1080"], 49)

    def test_independent_correct_checkpoints_accept(self):
        checks = [{"scene_xyz": xyz.tolist(), "video_xy": pixel.tolist()}
                  for xyz, pixel in zip(self.xyz[:8], self.pixels[:8])]
        result = solve_correspondences(self.xyz, self.pixels, self.K, 1920, 1080,
                                       checkpoints=checks)
        self.assertTrue(result["accepted"])

    def test_planar_support_is_degraded(self):
        z = np.full(len(self.pixels), 25.0)
        xyz = np.column_stack(((self.pixels[:, 0]-960)*z/1200,
                               (self.pixels[:, 1]-540)*z/1200, z))
        result = solve_correspondences(xyz, self.pixels, self.K, 1920, 1080)
        self.assertEqual(result["status"], "DEGRADED")
        self.assertIn("coplanar_or_insufficient_depth_geometry", result["reasons"])

    def test_insufficient_points_are_lost_without_pose(self):
        result = solve_correspondences(self.xyz[:5], self.pixels[:5], self.K, 1920, 1080)
        self.assertEqual(result["status"], "LOST")
        self.assertIsNone(result["T_camera_from_scene"])

    def test_projection_uses_camera_from_scene(self):
        pixels, depth = project_points(self.xyz, self.K, self.T)
        np.testing.assert_allclose(pixels, self.pixels, atol=1e-8)
        self.assertTrue(np.all(depth > 0))

    def test_resolution_normalized_error(self):
        self.assertEqual(residual_statistics([2, 2], 540)["rms_px1080"], 4)
        self.assertEqual(grid_coverage(np.array([[10, 10], [9999, 20], [10, 10]]), 1920, 1080), 1)

    def test_depth_is_optical_z_and_pose_is_inverted(self):
        depth = np.full((7, 7), 10., dtype=np.float32)
        K = np.array([[10, 0, 3], [0, 10, 3], [0, 0, 1.]])
        T = np.eye(4)
        T[:3, 3] = [1, 2, 3]
        xyz, valid, reason = lift_reference_points([[4, 3]], depth, K, T)
        np.testing.assert_allclose(xyz, [[0, -2, 7]], atol=1e-12)
        self.assertTrue(valid[0])
        self.assertEqual(reason[0], "valid")

    def test_depth_discontinuity_is_rejected(self):
        depth = np.full((7, 7), 10., dtype=np.float32)
        depth[3, 4] = 30
        xyz, valid, reason = lift_reference_points([[3, 3]], depth, np.eye(3), np.eye(4))
        self.assertFalse(valid[0])
        self.assertEqual(reason[0], "depth_discontinuity")

    def test_precise_triangle_ray_intersection(self):
        depth = np.full((7, 7), 10., dtype=np.float32)
        triangles = np.zeros((7, 7), dtype=np.uint32)
        K = np.array([[10, 0, 3], [0, 10, 3], [0, 0, 1.]])
        scene = {"vertices": np.array([[-100, -100, 10], [100, -100, 10], [0, 100, 10.]]),
                 "faces": np.array([[0, 1, 2]])}
        xyz, valid, _ = lift_reference_points([[3.25, 3.5]], depth, K, np.eye(4), triangles, scene)
        self.assertTrue(valid[0])
        np.testing.assert_allclose(xyz, [[.25, .5, 10]], atol=1e-10)

    def test_duplicates_and_conflicting_anchors_are_not_counted(self):
        pixels = np.array([[10, 10], [10.1, 10], [20, 20], [20.1, 20], [30, 30.]])
        xyz = np.array([[1, 2, 3], [1.1, 2, 3], [5, 5, 5], [10, 10, 10], [4, 4, 4.]])
        selected, conflicts = deduplicate_correspondences(pixels, xyz, np.array([.8, .9, .5, .8, .9]))
        np.testing.assert_array_equal(selected, [1, 4])
        np.testing.assert_array_equal(conflicts, [2, 3])

    def test_sift_matches_are_symmetric_and_unique(self):
        image = self.rng.integers(0, 256, (320, 480, 3), dtype=np.uint8)
        image = cv2.GaussianBlur(image, (3, 3), .6)
        moved = cv2.warpAffine(image, np.array([[1., 0, 7], [0, 1, 4]]), (480, 320))
        matcher = SiftMatcher({"max_keypoints": 700})
        query, reference = matcher.extract(image), matcher.extract(moved)
        pairs, _ = matcher.match(query, reference)
        self.assertGreater(len(pairs), 30)
        self.assertEqual(len(set(pairs[:, 0])), len(pairs))
        self.assertEqual(len(set(pairs[:, 1])), len(pairs))
        displacement = reference["points"][pairs[:, 1]] - query["points"][pairs[:, 0]]
        np.testing.assert_allclose(np.median(displacement, axis=0), [7, 4], atol=.2)




class PipelineIntegrationTests(unittest.TestCase):
    def test_real_sift_pipeline_writes_pose_correspondences_and_overlay(self):
        import json
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        from ar_v2.localization import localize
        rng = np.random.default_rng(55)
        image = rng.integers(0, 256, (360, 640, 3), dtype=np.uint8)
        image = cv2.GaussianBlur(image, (3, 3), .6)
        K = [440., 0, 319.5, 0, 440., 179.5, 0, 0, 1.]
        yy, xx = np.indices(image.shape[:2])
        depth = (25 + 3 * np.sin(xx / 120) + 3 * np.cos(yy / 80)).astype("<f4")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            reference_dir = root / "references"
            reference_dir.mkdir()
            cv2.imencode(".png", image)[1].tofile(reference_dir / "synthetic.png")
            depth.tofile(reference_dir / "synthetic.depth")
            reference = {"id": "synthetic", "rgb": "references/synthetic.png",
                         "depth_z": "references/synthetic.depth", "width": 640, "height": 360,
                         "K": K, "T_camera_from_scene": np.eye(4).reshape(-1).tolist(),
                         "geometry_version": "test-geometry", "camera_profile_id": "test-reference"}
            (reference_dir / "manifest.jsonl").write_text(json.dumps(reference) + "\n", encoding="utf-8")
            frame = {"time_seconds": 1.001, "original_frame_id": 30, "original_pts": 30030,
                     "time_base": "1/30000", "source_video_hash": "test-video"}
            profile = {"K": K, "width": 640, "height": 360, "id": "test-camera",
                       "calibration_version": "test-calibration"}
            config = {"output_dir": str(root), "localization": {"matcher": "sift", "max_keypoints": 1200}}
            with patch("ar_v2.localization._load_frame", return_value=(image, frame, profile)):
                result = localize(config, 1.0)
            self.assertEqual(result["status"], "LOCALIZED")
            self.assertEqual(result["original_pts"], 30030)
            self.assertEqual(result["time_seconds"], 1.001)
            self.assertFalse(result["accepted"])
            self.assertGreater(result["metrics"]["inliers"], 30)
            np.testing.assert_allclose(np.asarray(result["T_camera_from_scene"]).reshape(4, 4), np.eye(4), atol=1e-4)
            for key in ("pose", "overlay", "correspondences", "raw_matches"):
                self.assertTrue(Path(result["artifacts"][key]).is_file())
            with np.load(result["artifacts"]["correspondences"], allow_pickle=False) as data:
                self.assertEqual(len(data["scene_xyz"]), result["metrics"]["matches"])
                self.assertEqual(int(data["inlier_mask"].sum()), result["metrics"]["inliers"])

    def test_lk_forward_backward_preserves_metric_anchor_indices(self):
        from ar_v2.localization import track_points
        rng = np.random.default_rng(21)
        previous = rng.integers(0, 256, (240, 320), dtype=np.uint8)
        previous = cv2.GaussianBlur(previous, (3, 3), .5)
        current = cv2.warpAffine(previous, np.array([[1., 0, 3], [0, 1, -2]]), (320, 240))
        points = np.array([(x, y) for y in range(40, 200, 30) for x in range(40, 280, 30)], dtype=float)
        tracked, valid, errors = track_points(previous, current, points)
        self.assertGreater(np.count_nonzero(valid), 35)
        np.testing.assert_allclose(np.median(tracked[valid] - points[valid], axis=0), [3, -2], atol=.1)
        self.assertLess(np.median(errors[valid]), .1)

    def test_tracking_enumerates_all_original_pts(self):
        from unittest.mock import patch
        from ar_v2.localization import _tracking_times
        manifest = {"frames": [{"time_seconds": i * 1001 / 30000} for i in range(601)]}
        with patch("ar_v2.media.probe_video", return_value=manifest):
            times = _tracking_times({}, 0., 20.)
        self.assertEqual(len(times), 600)
        self.assertEqual(times[1], 1001/30000)




class TrackingIntegrationTests(unittest.TestCase):
    def test_anchor_tracking_emits_lost_without_interpolation(self):
        import json
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        from ar_v2.localization import track
        rng = np.random.default_rng(28)
        image = rng.integers(0, 256, (240, 320, 3), dtype=np.uint8)
        image = cv2.GaussianBlur(image, (3, 3), .7)
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        pixels = cv2.goodFeaturesToTrack(gray, 150, .05, 12).reshape(-1, 2).astype(float)
        z = rng.uniform(10, 30, len(pixels))
        K = np.array([[250., 0, 159.5], [0, 250., 119.5], [0, 0, 1.]])
        xyz = np.column_stack(((pixels[:, 0]-159.5)*z/250, (pixels[:, 1]-119.5)*z/250, z))
        times = [0., 1001/30000, 2002/30000]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            anchors_path = root / "seed.npz"
            np.savez(anchors_path, scene_xyz=xyz, video_xy=pixels, inlier_mask=np.ones(len(xyz), dtype=bool))
            identity = {"source_video_hash": "synthetic", "camera_profile_id": "camera",
                        "calibration_version": "1", "geometry_version": "geometry", "time_base": "1/30000"}
            initial = {"schema_version": "ar-v2.pose.v1", "status": "LOCALIZED", "accepted": False,
                       "time_seconds": 0., "original_pts": 0, "original_frame_id": 0,
                       "T_camera_from_scene": np.eye(4).reshape(-1).tolist(), "width": 320, "height": 240,
                       "K": K.reshape(-1).tolist(), "distortion": [0]*5,
                       "metrics": {"independent_checkpoints": None}, "artifacts": {"correspondences": str(anchors_path)},
                       **identity}
            lost = {**initial, "time_seconds": times[2], "original_pts": 2002, "original_frame_id": 2,
                    "status": "LOST", "T_camera_from_scene": None, "reasons": ["insufficient_correspondences"]}
            profile = {"id": "camera", "calibration_version": "1", "K": K, "width": 320, "height": 240}
            def frame_loader(config, timestamp):
                i = times.index(timestamp)
                frame = {"time_seconds": timestamp, "original_pts": i*1001, "original_frame_id": i, **identity}
                return (image if i < 2 else np.zeros_like(image), frame, profile)
            config = {"output_dir": str(root), "tracking": {"relocalize_seconds": 2.0}}
            with patch("ar_v2.localization._tracking_times", return_value=times),                  patch("ar_v2.localization._load_frame", side_effect=frame_loader),                  patch("ar_v2.localization._load_scene", return_value=None),                  patch("ar_v2.localization.load_references", return_value=[{"geometry_version": "geometry"}]),                  patch("ar_v2.localization.localize", side_effect=[initial, lost]):
                report = track(config, end_seconds=times[-1])
            records = [json.loads(line) for line in Path(report["poses"]).read_text().splitlines()]
            self.assertEqual(len(records), 3)
            self.assertEqual([p["status"] for p in records], ["LOCALIZED", "LOCALIZED", "LOST"])
            self.assertEqual(records[1]["tracking_method"], "anchored_lk_pnp")
            self.assertIsNone(records[2]["T_camera_from_scene"])
            self.assertTrue(all(p["interpolated"] is False for p in records))
            self.assertFalse(report["whole_window_accepted"])

    def test_shared_raw_intrinsics_cannot_be_silently_optimized_in_rectified_domain(self):
        from ar_v2.localization import refine
        with self.assertRaisesRegex(NotImplementedError, "original raw observations"):
            refine({"refinement": {"optimize_intrinsics": True}})



class RefinementIntegrationTests(unittest.TestCase):
    def test_pose_only_refinement_writes_new_auditable_artifacts(self):
        import json
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        from ar_v2.localization import refine, solve_correspondences
        fixture = LocalizationTests()
        fixture.setUp()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            profiles = {"id": "camera", "calibration_version": "1", "K": fixture.K,
                        "width": 1920, "height": 1080}
            identity = {"source_video_hash": "synthetic", "camera_profile_id": "camera",
                        "calibration_version": "1", "geometry_version": "geometry", "time_base": "1/30000"}
            for i in range(2):
                directory = root / "localization" / f"{i:012.6f}"
                directory.mkdir(parents=True)
                pixels = fixture.pixels + fixture.rng.normal(0, .25, fixture.pixels.shape)
                assessment = solve_correspondences(fixture.xyz, pixels, fixture.K, 1920, 1080)
                np.savez(directory / "correspondences.npz", scene_xyz=fixture.xyz, video_xy=pixels,
                         inlier_mask=np.ones(len(pixels), dtype=bool))
                pose = {"status": "LOCALIZED", "accepted": False, "time_seconds": float(i),
                        "original_frame_id": i*30, "original_pts": i*30000, "width": 1920, "height": 1080,
                        "K": fixture.K.reshape(-1).tolist(), "distortion": [0]*5,
                        "T_camera_from_scene": assessment["T_camera_from_scene"],
                        "metrics": assessment["metrics"], "reasons": [],
                        "artifacts": {"correspondences": str(directory / "correspondences.npz"),
                                      "pose": str(directory / "pose.json")}, **identity}
                (directory / "pose.json").write_text(json.dumps(pose), encoding="utf-8")
            def loader(config, timestamp):
                frame = {"time_seconds": timestamp, "original_frame_id": int(timestamp*30),
                         "original_pts": int(timestamp*30000), **identity}
                return np.zeros((1080, 1920, 3), dtype=np.uint8), frame, profiles
            with patch("ar_v2.localization._load_frame", side_effect=loader):
                report = refine({"output_dir": str(root)})
            self.assertEqual(report["status"], "COMPLETE")
            self.assertEqual(report["input_frames"], 2)
            self.assertFalse(report["shared_intrinsics_optimized"])
            self.assertFalse(report["independent_checkpoints_used_for_solve"])
            for record in report["frames"]:
                result = json.loads(Path(record["pose"]).read_text())
                self.assertIn("refinement", result["artifacts"]["correspondences"])
                self.assertNotEqual(result["artifacts"]["pose"], result["refinement"]["input_pose"])
                for key in ("pose", "correspondences", "overlay"):
                    self.assertTrue(Path(result["artifacts"][key]).is_file())


if __name__ == "__main__":
    unittest.main()
