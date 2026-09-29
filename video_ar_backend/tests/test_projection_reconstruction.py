from __future__ import annotations

import json
import math
import os
import sqlite3
import struct
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

import projection_reconstruction as reconstruction


class UnicodeFrameWriterTests(unittest.TestCase):
    def test_jpeg_writer_supports_chinese_and_punctuation_paths(self) -> None:
        import cv2

        image = np.zeros((24, 32, 3), dtype=np.uint8)
        image[:, :, 1] = 180
        with tempfile.TemporaryDirectory() as temporary_directory:
            destination = (
                Path(temporary_directory)
                / "1、工作"
                / "航拍测试视频"
                / "重建帧_0000000.jpg"
            )
            reconstruction._write_jpeg_unicode_atomic(destination, image, cv2)
            encoded = destination.read_bytes()
            decoded = cv2.imdecode(np.frombuffer(encoded, dtype=np.uint8), cv2.IMREAD_COLOR)

        self.assertTrue(encoded.startswith(b"\xff\xd8"))
        self.assertTrue(encoded.endswith(b"\xff\xd9"))
        self.assertIsNotNone(decoded)
        self.assertEqual(decoded.shape[:2], (24, 32))

    def test_jpeg_writer_preserves_previous_file_and_cleans_temp_on_publish_error(self) -> None:
        import cv2

        image = np.zeros((8, 8, 3), dtype=np.uint8)
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory) / "中文目录"
            root.mkdir()
            destination = root / "frame.jpg"
            destination.write_bytes(b"previous-complete-file")
            with patch.object(
                reconstruction.os,
                "replace",
                side_effect=OSError("simulated publish failure"),
            ):
                with self.assertRaisesRegex(reconstruction.ProjectionError, "无法写入重建帧"):
                    reconstruction._write_jpeg_unicode_atomic(destination, image, cv2)

            self.assertEqual(destination.read_bytes(), b"previous-complete-file")
            self.assertEqual(
                [path for path in root.iterdir() if path != destination],
                [],
            )

    def test_jpeg_encode_failure_never_creates_a_destination(self) -> None:
        class FailedEncoder:
            IMWRITE_JPEG_QUALITY = 1

            @staticmethod
            def imencode(*_args: object, **_kwargs: object) -> tuple[bool, None]:
                return False, None

        with tempfile.TemporaryDirectory() as temporary_directory:
            destination = Path(temporary_directory) / "中文" / "frame.jpg"
            with self.assertRaisesRegex(reconstruction.ProjectionError, "无法编码重建帧"):
                reconstruction._write_jpeg_unicode_atomic(
                    destination,
                    np.zeros((2, 2, 3), dtype=np.uint8),
                    FailedEncoder,
                )
            self.assertFalse(destination.exists())
            self.assertEqual(list(destination.parent.iterdir()), [])


class ColmapWorkspaceCompatibilityTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows drive-letter behavior")
    def test_unicode_result_directory_uses_same_volume_ascii_staging(self) -> None:
        result_directory = Path(r"E:\1、工作\航拍测试\提取结果")
        parent = reconstruction._colmap_workspace_parent_path(
            result_directory,
            platform_name="nt",
        )

        self.assertEqual(parent.anchor.casefold(), result_directory.anchor.casefold())
        self.assertEqual(parent.name, reconstruction.COLMAP_VOLUME_WORKSPACE_DIRECTORY)
        self.assertTrue(str(parent).isascii())

    @unittest.skipUnless(os.name == "nt", "Windows drive-letter behavior")
    def test_ascii_result_directory_keeps_staging_beside_results(self) -> None:
        result_directory = Path(r"E:\cesium\flight_output")
        parent = reconstruction._colmap_workspace_parent_path(
            result_directory,
            platform_name="nt",
        )

        self.assertEqual(parent.parent, result_directory.resolve())
        self.assertEqual(parent.name, reconstruction.COLMAP_LOCAL_WORKSPACE_DIRECTORY)
        self.assertTrue(str(parent).isascii())

    @staticmethod
    def _create_feature_database(path: Path, *, image_count: int) -> None:
        connection = sqlite3.connect(path)
        try:
            connection.execute("CREATE TABLE cameras(camera_id INTEGER PRIMARY KEY)")
            connection.execute("CREATE TABLE images(image_id INTEGER PRIMARY KEY)")
            connection.execute(
                "CREATE TABLE keypoints(image_id INTEGER PRIMARY KEY, rows INTEGER NOT NULL)"
            )
            connection.execute(
                "CREATE TABLE descriptors(image_id INTEGER PRIMARY KEY, rows INTEGER NOT NULL)"
            )
            connection.execute(
                "CREATE TABLE matches(pair_id INTEGER PRIMARY KEY, rows INTEGER NOT NULL)"
            )
            connection.execute(
                "CREATE TABLE two_view_geometries(pair_id INTEGER PRIMARY KEY, rows INTEGER NOT NULL)"
            )
            if image_count:
                connection.execute("INSERT INTO cameras(camera_id) VALUES (1)")
            for image_id in range(1, image_count + 1):
                connection.execute("INSERT INTO images(image_id) VALUES (?)", (image_id,))
                connection.execute(
                    "INSERT INTO keypoints(image_id, rows) VALUES (?, ?)",
                    (image_id, 50),
                )
                connection.execute(
                    "INSERT INTO descriptors(image_id, rows) VALUES (?, ?)",
                    (image_id, 50),
                )
            connection.commit()
        finally:
            connection.close()

    def test_feature_database_validation_accepts_all_decoded_images(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database = Path(temporary_directory) / "database.db"
            self._create_feature_database(database, image_count=2)

            counts = reconstruction._validate_colmap_feature_database(database, 2)

        self.assertEqual(counts["images"], 2)
        self.assertEqual(counts["cameras"], 1)
        self.assertEqual(counts["images_with_keypoints"], 2)
        self.assertEqual(counts["images_with_descriptors"], 2)

    def test_feature_database_validation_rejects_colmap_false_success(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database = Path(temporary_directory) / "database.db"
            self._create_feature_database(database, image_count=0)

            with self.assertRaisesRegex(reconstruction.ProjectionError, "未能读取任何重建帧"):
                reconstruction._validate_colmap_feature_database(database, 2)

    def test_feature_database_validation_rejects_partial_descriptors(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database = Path(temporary_directory) / "database.db"
            self._create_feature_database(database, image_count=2)
            connection = sqlite3.connect(database)
            try:
                connection.execute("UPDATE descriptors SET rows = 0 WHERE image_id = 2")
                connection.commit()
            finally:
                connection.close()

            with self.assertRaisesRegex(reconstruction.ProjectionError, "逐帧网格断裂"):
                reconstruction._validate_colmap_feature_database(database, 2)

    def test_match_database_validation_requires_verified_geometry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database = Path(temporary_directory) / "database.db"
            self._create_feature_database(database, image_count=2)
            connection = sqlite3.connect(database)
            try:
                pair_id = reconstruction.COLMAP_MAX_IMAGE_ID + 2
                connection.execute("INSERT INTO matches(pair_id, rows) VALUES (?, 30)", (pair_id,))
                connection.execute(
                    "INSERT INTO two_view_geometries(pair_id, rows) VALUES (?, 24)",
                    (pair_id,),
                )
                connection.commit()
            finally:
                connection.close()

            counts = reconstruction._validate_colmap_match_database(database, 2)

        self.assertEqual(counts, {
            "matched_pairs": 1,
            "verified_pairs": 1,
            "matched_images": 2,
            "connected_components": 1,
        })

    def test_match_database_validation_rejects_empty_matches(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database = Path(temporary_directory) / "database.db"
            self._create_feature_database(database, image_count=2)

            with self.assertRaisesRegex(reconstruction.ProjectionError, "没有得到可用的相邻帧"):
                reconstruction._validate_colmap_match_database(database, 2)


class HeightAndTimelineTests(unittest.TestCase):
    def test_ellipsoid_height_requires_an_explicit_vertical_datum(self) -> None:
        sample = {
            "absolute_altitude_m": 30.0,
            "gps_altitude_m": 31.0,
            "relative_altitude_m": 10.0,
        }
        self.assertIsNone(reconstruction.ellipsoid_height(sample, reconstruction.ProjectionOptions()))
        self.assertEqual(
            reconstruction.ellipsoid_height(
                sample,
                reconstruction.ProjectionOptions(height_mode="absolute_is_wgs84_ellipsoid"),
            ),
            30.0,
        )
        self.assertEqual(
            reconstruction.ellipsoid_height(
                sample,
                reconstruction.ProjectionOptions(
                    height_mode="orthometric_plus_geoid_offset",
                    height_offset_m=7.5,
                ),
            ),
            37.5,
        )
        self.assertEqual(
            reconstruction.ellipsoid_height(
                sample,
                reconstruction.ProjectionOptions(
                    height_mode="relative_plus_takeoff_ellipsoid",
                    height_offset_m=21.0,
                ),
            ),
            31.0,
        )

    def test_projection_sample_selection_covers_endpoints_and_keeps_gap_under_100ms(self) -> None:
        samples = [
            {"video_sample_index": index, "video_time_ms": time_ms}
            for index, time_ms in enumerate([*range(0, 991, 33), 1000])
        ]
        selected = reconstruction.select_projection_samples(samples, 1000, 12.0)
        times = [item["video_time_ms"] for item in selected]
        self.assertLessEqual(times[0], 50)
        self.assertLessEqual(1000 - times[-1], 50)
        self.assertLessEqual(max(right - left for left, right in zip(times, times[1:])), 100)
        self.assertEqual(len(times), len(set(times)))

    def test_projection_sample_selection_repairs_2997fps_rounding_without_inventing_pts(self) -> None:
        source_times = [round(index * 1000 / 29.97) for index in range(3468)]
        samples = [
            {"video_sample_index": index, "video_time_ms": time_ms}
            for index, time_ms in enumerate(source_times)
        ]
        duration_ms = source_times[-1]
        selected = reconstruction.select_projection_samples(samples, duration_ms, 12.0)
        selected_times = [item["video_time_ms"] for item in selected]
        self.assertLessEqual(max(right - left for left, right in zip(selected_times, selected_times[1:])), 100)
        self.assertTrue(set(selected_times).issubset(source_times))

    def test_effective_grid_never_exceeds_frontend_total_budgets(self) -> None:
        columns, rows = reconstruction.effective_grid(64, 36, 10_000)
        self.assertLessEqual(columns * rows * 10_000, reconstruction.MAX_TOTAL_VERTICES)
        self.assertLessEqual(
            2 * (columns - 1) * (rows - 1) * 10_000,
            reconstruction.MAX_TOTAL_TRIANGLES,
        )

    def test_camera_initialization_rejects_zoom_changes_in_a_single_camera_model(self) -> None:
        common = {
            "browser_width_px": 3840,
            "browser_height_px": 2160,
            "reconstruction_width_px": 1280,
            "reconstruction_height_px": 720,
        }
        frames = [
            {
                **common,
                "estimated_intrinsics": {"fx_px": focal, "fy_px": focal, "cx_px": 1920, "cy_px": 1080},
            }
            for focal in (2560.0, 3200.0)
        ]
        with self.assertRaisesRegex(reconstruction.ProjectionError, "焦距或数字变焦"):
            reconstruction._initial_camera_arguments(frames)


class GeometryTests(unittest.TestCase):
    def test_wgs84_ecef_round_trip(self) -> None:
        expected = (120.890825, 30.836687, 42.35)
        actual = reconstruction.ecef_to_geodetic(reconstruction.geodetic_to_ecef(*expected))
        self.assertAlmostEqual(actual[0], expected[0], places=8)
        self.assertAlmostEqual(actual[1], expected[1], places=8)
        self.assertAlmostEqual(actual[2], expected[2], places=4)

    def test_robust_similarity_recovers_known_transform_and_rejects_one_outlier(self) -> None:
        source = np.asarray([
            [0, 0, 0], [2, 0, 0], [0, 3, 0], [2, 3, 1],
            [4, 1, 0], [1, 5, 2], [5, 4, 1], [3, 2, 4],
        ], dtype=np.float64)
        angle = math.radians(23)
        rotation = np.asarray([
            [math.cos(angle), -math.sin(angle), 0],
            [math.sin(angle), math.cos(angle), 0],
            [0, 0, 1],
        ])
        target = (2.5 * (rotation @ source.T)).T + np.asarray([12.0, -7.0, 3.0])
        target[-1] += np.asarray([30.0, -20.0, 10.0])
        transform = reconstruction.robust_similarity(source, target)
        self.assertGreaterEqual(transform.inlier_count, 7)
        self.assertAlmostEqual(transform.scale, 2.5, places=5)
        self.assertLess(transform.rmse_m, 1e-5)

    def test_colmap_depth_map_reader_uses_documented_fortran_order(self) -> None:
        expected = np.asarray([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]], dtype=np.float32)
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "depth.bin"
            with path.open("wb") as handle:
                handle.write(b"3&2&1&")
                packed = expected[:, :, None].transpose(1, 0, 2).reshape(-1, order="F")
                handle.write(packed.astype(np.float32).tobytes())
            actual = reconstruction.read_colmap_depth_map(path)
        np.testing.assert_allclose(actual, expected)

    def test_depth_sampling_never_fills_a_hole_from_neighboring_pixels(self) -> None:
        depth = np.full((5, 5), 10.0, dtype=np.float32)
        depth[2, 2] = 0.0
        self.assertIsNone(reconstruction._depth_value(depth, 2, 2))

    def test_triangle_midpoint_depth_check_rejects_an_internal_occlusion_edge(self) -> None:
        vertices = [
            {"depth": 10.0, "world": np.asarray([0.0, 0.0, 0.0]), "depth_pixel": (0, 0)},
            {"depth": 10.0, "world": np.asarray([0.0, 1.0, 0.0]), "depth_pixel": (0, 4)},
            {"depth": 10.0, "world": np.asarray([1.0, 0.0, 0.0]), "depth_pixel": (4, 0)},
        ]
        flat = np.full((5, 5), 10.0, dtype=np.float32)
        self.assertTrue(reconstruction._triangle_safe(vertices, (0, 1, 2), depth_map=flat))
        discontinuous = flat.copy()
        discontinuous[0:3, 1:4] = 40.0
        self.assertFalse(reconstruction._triangle_safe(vertices, (0, 1, 2), depth_map=discontinuous))


class ProjectionOutputTests(unittest.TestCase):
    @staticmethod
    def _mesh(sample_index: int, time_ms: int) -> dict[str, object]:
        return {
            "video_sample_index": sample_index,
            "video_time_ms": time_ms,
            "projection_mesh_wgs84": {
                "vertices": [
                    [0.0, 0.0, 120.0, 30.0, 20.0],
                    [0.0, 1.0, 120.0, 29.9999, 20.0],
                    [1.0, 0.0, 120.0001, 30.0, 21.0],
                ],
                "triangles": [0, 1, 2],
                "quality": {"valid": True, "method": "fixture", "reprojection_rmse_px": 0.5},
            },
        }

    def test_streamed_mesh_sidecar_has_strict_cesium_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            destination = Path(temporary_directory) / "mesh.json"
            reconstruction.write_projection_mesh_sidecar(
                destination,
                source_video={"file_name": "DJI.MP4", "size_bytes": 1234, "duration_ms": 100},
                image_width_px=3840,
                image_height_px=2160,
                meshes=[self._mesh(0, 0), self._mesh(3, 100)],
            )
            document = json.loads(destination.read_text(encoding="utf-8"))
        self.assertEqual(document["source_crs"], "EPSG:4979")
        self.assertEqual(document["height_reference"], "WGS84_ELLIPSOID")
        self.assertEqual(document["image_space"], "browser_display")
        self.assertEqual(document["visibility"], "first_surface_hit")
        self.assertEqual(document["frame_meshes"][1]["video_time_ms"], 100)

    def test_cancelled_writer_never_replaces_or_publishes_a_mesh(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            destination = Path(temporary_directory) / "mesh.json"
            cancellation = threading.Event()
            cancellation.set()
            with self.assertRaises(reconstruction.ProjectionCancelled):
                reconstruction.write_projection_mesh_sidecar(
                    destination,
                    source_video={"file_name": "DJI.MP4", "size_bytes": 1234, "duration_ms": 100},
                    image_width_px=3840,
                    image_height_px=2160,
                    meshes=[self._mesh(0, 0), self._mesh(3, 100)],
                    cancel_event=cancellation,
                )
            self.assertFalse(destination.exists())

    def test_writer_rejects_a_mesh_that_the_browser_would_reject(self) -> None:
        invalid = self._mesh(0, 0)
        invalid["projection_mesh_wgs84"]["triangles"] = [0, 1, 2, 0, 2, 1]
        with tempfile.TemporaryDirectory() as temporary_directory:
            destination = Path(temporary_directory) / "mesh.json"
            with self.assertRaisesRegex(reconstruction.ProjectionError, "重复三角形"):
                reconstruction.write_projection_mesh_sidecar(
                    destination,
                    source_video={"file_name": "DJI.MP4", "size_bytes": 1234, "duration_ms": 100},
                    image_width_px=3840,
                    image_height_px=2160,
                    meshes=[invalid, self._mesh(3, 100)],
                )
            self.assertFalse(destination.exists())

    @staticmethod
    def _iso_box(box_type: bytes, payload: bytes) -> bytes:
        return struct.pack(">I4s", len(payload) + 8, box_type) + payload

    @classmethod
    def _minimal_mp4(cls, rotation_degrees: int = 0, *, pixel_aspect: tuple[int, int] | None = None) -> bytes:
        angle = math.radians(rotation_degrees)
        a = round(math.cos(angle) * 65536)
        b = round(math.sin(angle) * 65536)
        c = round(-math.sin(angle) * 65536)
        d = round(math.cos(angle) * 65536)
        tkhd_payload = bytearray(76)
        tkhd_payload[40:76] = struct.pack(">9i", a, b, 0, c, d, 0, 0, 0, 1 << 30)
        sample_payload = bytearray(78)
        if pixel_aspect is not None:
            sample_payload.extend(cls._iso_box(b"pasp", struct.pack(">II", *pixel_aspect)))
        sample_entry = cls._iso_box(b"avc1", bytes(sample_payload))
        stsd = cls._iso_box(b"stsd", bytes(4) + struct.pack(">I", 1) + sample_entry)
        stbl = cls._iso_box(b"stbl", stsd)
        minf = cls._iso_box(b"minf", stbl)
        hdlr = cls._iso_box(b"hdlr", bytes(8) + b"vide")
        mdia = cls._iso_box(b"mdia", hdlr + minf)
        trak = cls._iso_box(b"trak", cls._iso_box(b"tkhd", bytes(tkhd_payload)) + mdia)
        return cls._iso_box(b"ftyp", b"isom" + bytes(8)) + cls._iso_box(b"moov", trak)

    def test_iso_bmff_display_verification_reads_rotation_and_square_pixels(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "fixture.mp4"
            path.write_bytes(self._minimal_mp4(0, pixel_aspect=(1, 1)))
            verified = reconstruction.verify_browser_display_metadata(path)
            rotated = Path(temporary_directory) / "rotated.mp4"
            rotated.write_bytes(self._minimal_mp4(90))
            rotated_verified = reconstruction.verify_browser_display_metadata(rotated)
        self.assertTrue(verified["verified"])
        self.assertEqual(verified["rotation_degrees"], 0)
        self.assertEqual(rotated_verified["rotation_degrees"], 90)

    def test_iso_bmff_display_verification_rejects_non_square_pixels(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "anamorphic.mp4"
            path.write_bytes(self._minimal_mp4(0, pixel_aspect=(4, 3)))
            with self.assertRaisesRegex(reconstruction.ProjectionError, "非方形像素"):
                reconstruction.verify_browser_display_metadata(path)

    def test_missing_colmap_writes_failure_report_without_fake_mesh(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            video = directory / "DJI.MP4"
            video.write_bytes(b"not-a-real-video")
            options = reconstruction.ProjectionOptions(
                enabled=True,
                colmap_bin=str(directory / "definitely-missing-colmap.exe"),
                height_mode="absolute_is_wgs84_ellipsoid",
            )
            outcome = reconstruction.run_projection_reconstruction(
                video,
                source_video={"file_name": video.name, "size_bytes": video.stat().st_size, "duration_ms": 100},
                samples=[],
                output_directory=directory,
                options=options,
                cancel_event=threading.Event(),
            )
            report = json.loads(outcome.report_path.read_text(encoding="utf-8"))
            meshes = list(directory.glob("DJI*_三维投影网格_请选择此文件.json"))
        self.assertEqual(outcome.status, "failed")
        self.assertFalse(report["mesh_published"])
        self.assertIn("COLMAP", report["message"])
        self.assertEqual(meshes, [])

    def test_rotated_source_is_rejected_before_any_unverified_uv_mesh_is_published(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            video = directory / "DJI.MP4"
            video.write_bytes(b"not-decoded-because-preflight-rejects-rotation")
            options = reconstruction.ProjectionOptions(
                enabled=True,
                height_mode="absolute_is_wgs84_ellipsoid",
            )
            capabilities = {
                "ready": True,
                "colmap_executable": str(video),
                "numpy_available": True,
                "opencv_available": True,
                "height_reference_confirmed": True,
                "height_mode": options.height_mode,
                "missing": [],
            }
            with patch.object(reconstruction, "projection_capabilities", return_value=capabilities):
                outcome = reconstruction.run_projection_reconstruction(
                    video,
                    source_video={
                        "file_name": video.name,
                        "size_bytes": video.stat().st_size,
                        "duration_ms": 100,
                        "rotation_degrees": 90,
                    },
                    samples=[],
                    output_directory=directory,
                    options=options,
                )
            report = json.loads(outcome.report_path.read_text(encoding="utf-8"))
            meshes = list(directory.glob("DJI*_三维投影网格_请选择此文件.json"))
        self.assertEqual(outcome.status, "failed")
        self.assertIn("旋转元数据", report["message"])
        self.assertEqual(meshes, [])


if __name__ == "__main__":
    unittest.main()
