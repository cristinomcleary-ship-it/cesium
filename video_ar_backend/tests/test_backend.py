from __future__ import annotations

import asyncio
import base64
import json
import os
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

os.environ["DRONE_DEVICE_SN"] = "TEST-AIRCRAFT-001"
os.environ["DRONE_MQTT_HOST"] = "127.0.0.1"
os.environ["DRONE_RTMP_URL_TEMPLATE"] = "rtmp://127.0.0.1/live/{device_sn}-81-0-0"

from backend_v1.config import TelemetryConfig, config
from backend_v1.main import DroneBackendService
from backend_v1.models import (
    DroneCoordinates,
    DroneStatus,
    GimbalAttitude,
    GroundFootprintWGS84,
    VideoFrame,
)
from backend_v1.mqtt_client import MQTTClient
from backend_v1.packager import package_flight
from backend_v1.video_processor import SavedFrame, VideoProcessor
from backend_v1.video_websocket_server import VideoWebSocketServer
from backend_v1.websocket_server import WebSocketServer
from websockets.legacy.client import connect


def valid_footprint_payload(timestamp_ms: int = 1_700_000_000_000) -> dict:
    return {
        "top_left": {"latitude": 30.001, "longitude": 120.0},
        "top_right": {"latitude": 30.001, "longitude": 120.001},
        "bottom_right": {"latitude": 30.0, "longitude": 120.001},
        "bottom_left": {"latitude": 30.0, "longitude": 120.0},
        "source_crs": "EPSG:4326",
        "footprint_timestamp_ms": timestamp_ms,
    }


def valid_footprint(timestamp_ms: int = 1_700_000_000_000) -> GroundFootprintWGS84:
    return GroundFootprintWGS84.from_payload(valid_footprint_payload(timestamp_ms))


class ConfigurationTests(unittest.TestCase):
    def test_ground_altitude_is_optional_and_requires_a_finite_number(self) -> None:
        with patch.dict(os.environ, {"DRONE_GROUND_ALTITUDE_M": ""}):
            self.assertIsNone(TelemetryConfig().ground_altitude_m)
        with patch.dict(os.environ, {"DRONE_GROUND_ALTITUDE_M": "123.4"}):
            self.assertEqual(TelemetryConfig().ground_altitude_m, 123.4)
        with patch.dict(os.environ, {"DRONE_GROUND_ALTITUDE_M": "nan"}):
            with self.assertRaises(ValueError):
                TelemetryConfig()


class MQTTParsingTests(unittest.TestCase):
    def test_osd_parsing_preserves_position_on_gimbal_only_update(self) -> None:
        client = MQTTClient()
        client._handle_osd_message(
            {
                "timestamp": 1_700_000_000_000,
                "data": {
                    "latitude": 30.123,
                    "longitude": 120.456,
                    "height": 88.5,
                    "attitude_head": 35.0,
                    "attitude_pitch": 1.5,
                    "attitude_roll": -2.0,
                    "81-0-0": {
                        "payload_index": "81-0-0",
                        "gimbal_pitch": -45.0,
                        "gimbal_roll": 0.5,
                        "gimbal_yaw": 36.0,
                    },
                },
            }
        )
        status = client.get_current_status()
        self.assertAlmostEqual(status.coordinates.latitude, 30.123)
        self.assertAlmostEqual(status.coordinates.altitude, 88.5)
        self.assertAlmostEqual(status.gimbal_attitude.pitch, -45.0)
        coordinate_timestamp = status.coordinates.timestamp

        client._handle_osd_message(
            {
                "timestamp": 1_700_000_000_100,
                "data": {
                    "81-0-0": {
                        "payload_index": "81-0-0",
                        "gimbal_pitch": -50.0,
                        "gimbal_roll": 0.0,
                        "gimbal_yaw": 40.0,
                    }
                },
            }
        )
        updated = client.get_current_status()
        self.assertEqual(updated.coordinates.timestamp, coordinate_timestamp)
        self.assertAlmostEqual(updated.coordinates.latitude, 30.123)
        self.assertAlmostEqual(updated.gimbal_attitude.pitch, -50.0)

    def test_explicit_offline_status_is_applied(self) -> None:
        client = MQTTClient()
        client.current_status.is_online = True
        client._handle_status_message({"timestamp": 1_700_000_000_000, "data": {"online_status": False}})
        self.assertFalse(client.get_current_status().is_online)

    def test_unexpected_disconnect_marks_device_offline(self) -> None:
        client = MQTTClient()
        client.is_connected = True
        client.current_status.is_online = True
        client._on_disconnect(None, None, None, 1, None)
        self.assertFalse(client.get_current_status().is_online)

    def test_nested_wgs84_footprint_is_validated_and_saved_on_status(self) -> None:
        client = MQTTClient()
        footprint = valid_footprint_payload()
        client._handle_osd_message(
            {
                "timestamp": 1_700_000_000_000,
                "data": {
                    "latitude": 30.0,
                    "longitude": 120.0,
                    "height": 80.0,
                    "81-0-0": {
                        "device_sn": "TEST-AIRCRAFT-001",
                        "footprint_wgs84": {
                            key: value
                            for key, value in footprint.items()
                            if key not in {"source_crs", "footprint_timestamp_ms"}
                        },
                        "source_crs": "WGS84",
                        "footprint_timestamp_ms": footprint["footprint_timestamp_ms"],
                    },
                },
            }
        )
        status = client.get_current_status()
        self.assertIsNotNone(status.ground_footprint_wgs84)
        self.assertEqual(status.ground_footprint_wgs84.source_crs, "EPSG:4326")
        self.assertEqual(status.ground_footprint_wgs84.timestamp_ms, 1_700_000_000_000)
        wire = status.to_dict()
        self.assertEqual(wire["ground_footprint_wgs84"]["top_left"]["longitude"], 120.0)
        self.assertEqual(wire["source_crs"], "EPSG:4326")
        self.assertNotIn("footprint_wgs84", wire)

    def test_status_aliases_are_normalised_but_invalid_or_wrong_device_footprints_clear_state(self) -> None:
        client = MQTTClient()
        footprint = valid_footprint_payload()
        alias_corners = {
            "TL": {"lat": 30.001, "lng": 120.0},
            "TR": {"lat": 30.001, "lng": 120.001},
            "BR": {"lat": 30.0, "lng": 120.001},
            "BL": {"lat": 30.0, "lng": 120.0},
        }
        client._handle_status_message(
            {
                "timestamp": 1_700_000_000_000,
                "data": {
                    "ground_footprint_wgs84": alias_corners,
                    "source_crs": "EPSG:4326",
                    "footprint_timestamp_ms": footprint["footprint_timestamp_ms"],
                },
            }
        )
        self.assertIsNotNone(client.get_current_status().ground_footprint_wgs84)

        client._handle_status_message(
            {
                "timestamp": 1_700_000_000_100,
                "data": {
                    "ground_footprint_wgs84": alias_corners,
                    "source_crs": "GCJ-02",
                    "footprint_timestamp_ms": footprint["footprint_timestamp_ms"] + 100,
                },
            }
        )
        self.assertIsNone(client.get_current_status().ground_footprint_wgs84)

        client._handle_status_message(
            {
                "timestamp": 1_700_000_000_200,
                "device_sn": "ANOTHER-AIRCRAFT",
                "data": {
                    "ground_footprint_wgs84": alias_corners,
                    "source_crs": "EPSG:4326",
                    "footprint_timestamp_ms": footprint["footprint_timestamp_ms"] + 200,
                },
            }
        )
        self.assertIsNone(client.get_current_status().ground_footprint_wgs84)

    def test_self_intersecting_footprint_is_rejected(self) -> None:
        client = MQTTClient()
        invalid = valid_footprint_payload()
        invalid["bottom_right"], invalid["bottom_left"] = invalid["bottom_left"], invalid["bottom_right"]
        client._handle_osd_message(
            {
                "timestamp": 1_700_000_000_000,
                "data": {
                    "latitude": 30.0,
                    "longitude": 120.0,
                    "ground_footprint_wgs84": invalid,
                },
            }
        )
        self.assertIsNone(client.get_current_status().ground_footprint_wgs84)


class MQTTBackpressureTests(unittest.IsolatedAsyncioTestCase):
    async def test_status_delivery_coalesces_burst(self) -> None:
        client = MQTTClient()
        client.set_event_loop(asyncio.get_running_loop())
        delivered: list[float] = []

        async def callback(status: DroneStatus) -> None:
            delivered.append(status.timestamp)
            await asyncio.sleep(0.01)

        client.set_status_callback(callback)
        for index in range(100):
            client.current_status.timestamp = float(index)
            client._emit_status()
        await asyncio.sleep(0.08)
        self.assertLess(len(delivered), 10)
        self.assertEqual(delivered[-1], 99.0)


class FootprintFrameBindingTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_same_device_fresh_footprint_is_atomically_bound_to_video_frame(self) -> None:
        service = DroneBackendService()
        footprint_timestamp_ms = 1_700_000_000_000
        footprint = valid_footprint(footprint_timestamp_ms)
        service._latest_footprints["TEST-AIRCRAFT-001"] = footprint
        service.video_websocket_server.broadcast_video_frame = AsyncMock()

        await service._broadcast_video_frame(
            "TEST-AIRCRAFT-001",
            b"fresh",
            (footprint_timestamp_ms + 1_500) / 1000,
        )
        fresh_frame = service.video_websocket_server.broadcast_video_frame.await_args.args[1]
        self.assertIs(fresh_frame.ground_footprint_wgs84, footprint)

        service.video_websocket_server.broadcast_video_frame.reset_mock()
        await service._broadcast_video_frame(
            "TEST-AIRCRAFT-001",
            b"stale",
            (footprint_timestamp_ms + 1_501) / 1000,
        )
        stale_frame = service.video_websocket_server.broadcast_video_frame.await_args.args[1]
        self.assertIsNone(stale_frame.ground_footprint_wgs84)

        service.video_websocket_server.broadcast_video_frame.reset_mock()
        await service._broadcast_video_frame(
            "ANOTHER-AIRCRAFT",
            b"other-device",
            footprint_timestamp_ms / 1000,
        )
        other_frame = service.video_websocket_server.broadcast_video_frame.await_args.args[1]
        self.assertIsNone(other_frame.ground_footprint_wgs84)


class WebSocketIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_status_and_video_wire_formats(self) -> None:
        original_status_port = config.websocket.status_port
        original_ground_altitude = config.telemetry.ground_altitude_m
        config.websocket.status_port = 0
        config.telemetry.ground_altitude_m = None
        status_server = WebSocketServer()
        video_server = VideoWebSocketServer(host="127.0.0.1", port=0)
        try:
            await status_server.start_server()
            await video_server.start()
            status_port = status_server.server.sockets[0].getsockname()[1]
            video_port = video_server.server.sockets[0].getsockname()[1]

            async with connect(f"ws://127.0.0.1:{status_port}") as status_socket:
                connected = json.loads(await status_socket.recv())
                self.assertEqual(connected["type"], "connection_status")
                status = DroneStatus(
                    device_sn="TEST-AIRCRAFT-001",
                    is_online=True,
                    coordinates=DroneCoordinates(latitude=30, longitude=120, altitude=50, timestamp=time.time()),
                    gimbal_attitude=GimbalAttitude(pitch=-45),
                )
                await status_server.broadcast_drone_status(status)
                message = json.loads(await status_socket.recv())
                self.assertEqual(message["type"], "drone_status")
                self.assertEqual(message["data"]["coordinates"]["longitude"], 120)
                self.assertNotIn("ground_altitude_m", message["data"]["coordinates"])
                self.assertNotIn("relative_altitude", message["data"]["coordinates"])

                config.telemetry.ground_altitude_m = 42.5
                await status_server.broadcast_drone_status(status)
                message = json.loads(await status_socket.recv())
                self.assertEqual(message["data"]["coordinates"]["ground_altitude_m"], 42.5)
                self.assertEqual(message["data"]["coordinates"]["relative_altitude"], 7.5)

                await status_server.broadcast_coordinates(status)
                message = json.loads(await status_socket.recv())
                self.assertEqual(message["type"], "coordinates")
                self.assertEqual(message["data"]["coordinates"]["ground_altitude_m"], 42.5)
                self.assertEqual(message["data"]["coordinates"]["relative_altitude"], 7.5)

            async with connect(f"ws://127.0.0.1:{video_port}") as video_socket:
                connected = json.loads(await video_socket.recv())
                self.assertEqual(connected["type"], "connection_established")
                frame_bytes = b"jpeg-test-frame"
                await video_server.broadcast_video_frame(
                    "TEST-AIRCRAFT-001",
                    VideoFrame(frame_data=frame_bytes, timestamp=123.0, width=1280, height=720),
                )
                message = json.loads(await video_socket.recv())
                self.assertEqual(message["type"], "video_frame")
                self.assertEqual(base64.b64decode(message["data"]["frame"]), frame_bytes)
                self.assertNotIn("ground_footprint_wgs84", message["data"])
                self.assertNotIn("source_crs", message["data"])
                self.assertNotIn("footprint_timestamp_ms", message["data"])

                footprint = valid_footprint(123_000)
                await video_server.broadcast_video_frame(
                    "TEST-AIRCRAFT-001",
                    VideoFrame(
                        frame_data=frame_bytes,
                        timestamp=123.0,
                        width=1280,
                        height=720,
                        ground_footprint_wgs84=footprint,
                    ),
                )
                message = json.loads(await video_socket.recv())
                self.assertEqual(message["data"]["source_crs"], "EPSG:4326")
                self.assertEqual(message["data"]["footprint_timestamp_ms"], 123_000)
                self.assertEqual(
                    message["data"]["ground_footprint_wgs84"]["bottom_right"]["latitude"],
                    30.0,
                )
        finally:
            await video_server.stop()
            await status_server.stop_server()
            config.websocket.status_port = original_status_port
            config.telemetry.ground_altitude_m = original_ground_altitude


class RecordingAndPackagingTests(unittest.IsolatedAsyncioTestCase):
    async def test_recording_output_and_zip_are_browser_loadable(self) -> None:
        original_root = config.storage.root
        original_auto_zip = config.storage.auto_zip
        original_match_age = config.video.frame_match_max_age_ms
        original_ground_altitude = config.telemetry.ground_altitude_m
        with tempfile.TemporaryDirectory() as temporary_directory:
            config.storage.root = Path(temporary_directory)
            config.storage.auto_zip = False
            config.video.frame_match_max_age_ms = 2000
            config.telemetry.ground_altitude_m = None
            config.storage.ensure_directories()
            service = DroneBackendService()
            source_time = time.time()
            cache_frame = config.storage.video_cache_dir / "TEST-AIRCRAFT-001_frame.jpg"
            cache_frame.write_bytes(b"fake-jpeg")
            frame_time = source_time + 0.125
            saved = SavedFrame(cache_frame.name, cache_frame, frame_time)
            service.video_processor_manager.latest_saved_frame = lambda _device_sn: saved
            status = DroneStatus(
                device_sn="TEST-AIRCRAFT-001",
                is_online=True,
                coordinates=DroneCoordinates(
                    latitude=30.1,
                    longitude=120.2,
                    altitude=88.0,
                    heading=12.0,
                    timestamp=source_time,
                ),
                gimbal_attitude=GimbalAttitude(pitch=-45.0, yaw=12.0, timestamp=source_time),
                timestamp=source_time,
            )
            service._start_recording(status)
            flight_directory = service.active_flight_dir
            await service._record_trajectory_point(status)
            await service._finish_recording(source_time + 1)

            self.assertIsNotNone(flight_directory)
            trajectory_files = list(flight_directory.glob("trajectory_*.json"))
            self.assertEqual(len(trajectory_files), 1)
            payload = json.loads(trajectory_files[0].read_text(encoding="utf-8"))
            self.assertEqual(payload["flight_info"]["total_points"], 1)
            self.assertNotIn("ground_altitude_m", payload["flight_info"])
            self.assertNotIn("altitude_reference", payload["flight_info"])
            point = payload["trajectory_points"][0]
            self.assertNotIn("relative_altitude", point["position"])
            self.assertEqual(point["video_frame_timestamp_ms"], round(frame_time * 1000))
            self.assertEqual(point["video_frame_time_delta_ms"], 125)
            frame_name = point["video_frame"]
            self.assertTrue((flight_directory / "video_frames" / frame_name).is_file())

            archive = package_flight(flight_directory)
            with zipfile.ZipFile(archive) as package:
                names = package.namelist()
                self.assertTrue(any(name.endswith(".json") for name in names))
                self.assertTrue(any("/video_frames/" in name and name.endswith(".jpg") for name in names))
        config.storage.root = original_root
        config.storage.auto_zip = original_auto_zip
        config.video.frame_match_max_age_ms = original_match_age
        config.telemetry.ground_altitude_m = original_ground_altitude

    async def test_ground_altitude_and_unmatched_frame_metadata_are_explicit(self) -> None:
        original_root = config.storage.root
        original_ground_altitude = config.telemetry.ground_altitude_m
        with tempfile.TemporaryDirectory() as temporary_directory:
            config.storage.root = Path(temporary_directory)
            config.telemetry.ground_altitude_m = 75.5
            config.storage.ensure_directories()
            service = DroneBackendService()
            service.video_processor_manager.latest_saved_frame = lambda _device_sn: None
            source_time = time.time()
            status = DroneStatus(
                device_sn="TEST-AIRCRAFT-001",
                is_online=True,
                coordinates=DroneCoordinates(
                    latitude=30.1,
                    longitude=120.2,
                    altitude=88.0,
                    timestamp=source_time,
                ),
                timestamp=source_time,
            )
            service._start_recording(status)
            flight_directory = service.active_flight_dir
            await service._record_trajectory_point(status)
            await service._finish_recording(source_time + 1)

            trajectory_file = next(flight_directory.glob("trajectory_*.json"))
            payload = json.loads(trajectory_file.read_text(encoding="utf-8"))
            self.assertEqual(payload["flight_info"]["ground_altitude_m"], 75.5)
            self.assertEqual(payload["flight_info"]["altitude_reference"], "absolute")
            point = payload["trajectory_points"][0]
            self.assertEqual(point["position"]["relative_altitude"], 12.5)
            self.assertIsNone(point["video_frame"])
            self.assertIsNone(point["video_frame_timestamp_ms"])
            self.assertIsNone(point["video_frame_time_delta_ms"])
        config.storage.root = original_root
        config.telemetry.ground_altitude_m = original_ground_altitude

    async def test_matched_frame_keeps_validated_wgs84_footprint_in_trajectory(self) -> None:
        original_root = config.storage.root
        original_auto_zip = config.storage.auto_zip
        original_match_age = config.video.frame_match_max_age_ms
        try:
            with tempfile.TemporaryDirectory() as temporary_directory:
                config.storage.root = Path(temporary_directory)
                config.storage.auto_zip = False
                config.video.frame_match_max_age_ms = 2_000
                config.storage.ensure_directories()
                service = DroneBackendService()
                source_time = time.time()
                frame_time = source_time + 0.1
                cache_frame = config.storage.video_cache_dir / "TEST-AIRCRAFT-001_frame.jpg"
                cache_frame.write_bytes(b"fake-jpeg")
                service.video_processor_manager.latest_saved_frame = lambda _device_sn: SavedFrame(
                    cache_frame.name,
                    cache_frame,
                    frame_time,
                )
                status = DroneStatus(
                    device_sn="TEST-AIRCRAFT-001",
                    is_online=True,
                    coordinates=DroneCoordinates(
                        latitude=30.1,
                        longitude=120.2,
                        altitude=88.0,
                        timestamp=source_time,
                    ),
                    ground_footprint_wgs84=valid_footprint(round(frame_time * 1000)),
                    timestamp=source_time,
                )
                service._start_recording(status)
                await service._record_trajectory_point(status)
                point = service.flight_trajectory["trajectory_points"][0]
                self.assertEqual(point["source_crs"], "EPSG:4326")
                self.assertEqual(point["footprint_timestamp_ms"], round(frame_time * 1000))
                self.assertEqual(point["ground_footprint_wgs84"]["top_right"]["longitude"], 120.001)
                await service._finish_recording(source_time + 1)
        finally:
            config.storage.root = original_root
            config.storage.auto_zip = original_auto_zip
            config.video.frame_match_max_age_ms = original_match_age


class VideoSamplingTests(unittest.TestCase):
    def test_immediate_frames_do_not_all_hit_disk(self) -> None:
        import numpy as np

        original_root = config.storage.root
        original_save_fps = config.video.save_fps
        with tempfile.TemporaryDirectory() as temporary_directory:
            config.storage.root = Path(temporary_directory)
            config.video.save_fps = 2.0
            processor = VideoProcessor()
            processor.device_sn = "TEST-AIRCRAFT-001"
            processor.video_dir = config.storage.video_cache_dir
            processor.video_dir.mkdir(parents=True)
            frame = np.zeros((360, 640, 3), dtype=np.uint8)
            processor._process_frame(frame)
            processor._process_frame(frame)
            self.assertEqual(processor.stats["frames_processed"], 2)
            self.assertEqual(processor.stats["frames_saved"], 1)
            self.assertEqual(len(list(processor.video_dir.glob("*.jpg"))), 1)
        config.storage.root = original_root
        config.video.save_fps = original_save_fps


if __name__ == "__main__":
    unittest.main()
