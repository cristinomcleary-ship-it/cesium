"""DJI trajectory recorder and real-time WebSocket bridge."""
from __future__ import annotations

import asyncio
import json
import logging
import logging.handlers
import math
import os
import re
import shutil
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

from .config import config
from .models import DroneStatus, VideoFrame
from .mqtt_client import MQTTClient
from .packager import package_flight
from .video_processor import SavedFrame, VideoProcessorManager
from .video_websocket_server import VideoWebSocketServer
from .websocket_server import WebSocketServer


def configure_logging() -> None:
    config.storage.ensure_directories()
    level = getattr(logging, config.log_level)
    formatter = logging.Formatter("%(asctime)s - %(levelname)s - %(name)s - %(message)s")
    console = logging.StreamHandler()
    console.setFormatter(formatter)
    rotating_file = logging.handlers.RotatingFileHandler(
        config.storage.log_file,
        maxBytes=config.storage.log_max_bytes,
        backupCount=config.storage.log_backups,
        encoding="utf-8",
    )
    rotating_file.setFormatter(formatter)
    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.addHandler(console)
    root_logger.addHandler(rotating_file)
    root_logger.setLevel(level)


configure_logging()
logger = logging.getLogger(__name__)
_FOOTPRINT_FRAME_MAX_DELTA_MS = 1_500


class DroneBackendService:
    """Own all runtime resources and shut them down in reverse order."""

    def __init__(self) -> None:
        self.mqtt_client = MQTTClient()
        self.websocket_server = WebSocketServer()
        self.video_websocket_server = VideoWebSocketServer()
        self.video_processor_manager = VideoProcessorManager()
        self.video_processor_manager.set_websocket_callback(
            self._broadcast_video_frame,
            lambda: self.video_websocket_server.get_client_count() > 0,
        )

        self.is_running = False
        self._stop_event = asyncio.Event()
        self._stop_lock = asyncio.Lock()
        self._status_lock = asyncio.Lock()
        self._status_ws_started = False
        self._video_ws_started = False
        self._mqtt_started = False

        self.is_recording = False
        self.flight_trajectory: dict = {}
        self.active_flight_dir: Optional[Path] = None
        self.active_frames_dir: Optional[Path] = None
        self.trajectory_file: Optional[Path] = None
        self._copied_frames: set[str] = set()
        self._last_recorded_timestamp = 0.0
        self._last_checkpoint_monotonic = 0.0
        self._latest_footprints = {}

    async def start(self) -> None:
        errors = config.validation_errors()
        if errors:
            raise RuntimeError("配置无效: " + "; ".join(errors))
        config.storage.ensure_directories()
        loop = asyncio.get_running_loop()
        self.mqtt_client.set_event_loop(loop)
        self.mqtt_client.set_status_callback(self._on_drone_status_update)
        self.video_processor_manager.set_event_loop(loop)

        try:
            await self.websocket_server.start_server()
            self._status_ws_started = True
            await self.video_websocket_server.start()
            self._video_ws_started = True
            connected = await asyncio.to_thread(self.mqtt_client.connect)
            if not connected:
                raise RuntimeError("MQTT 连接失败，请检查地址、鉴权、TLS 与防火墙")
            self._mqtt_started = True
            self.is_running = True
            logger.info("后端服务已启动，等待设备 %s 的 OSD 数据", config.target_device_sn)
        except Exception:
            logger.exception("后端启动失败，正在回滚已启动资源")
            await self.stop()
            raise

    async def stop(self) -> None:
        async with self._stop_lock:
            if not any((self.is_running, self._status_ws_started, self._video_ws_started, self._mqtt_started, self.is_recording)):
                return
            self.is_running = False
            self._stop_event.set()

            if self._mqtt_started:
                try:
                    await asyncio.to_thread(self.mqtt_client.disconnect)
                except Exception:
                    logger.exception("停止 MQTT 客户端失败")
                self._mqtt_started = False

            try:
                await asyncio.to_thread(self.video_processor_manager.stop_all_processors)
            except Exception:
                logger.exception("停止视频处理线程失败")

            if self.is_recording:
                try:
                    await self._finish_recording()
                except Exception:
                    logger.exception("结束航次并保存轨迹失败")

            if self._video_ws_started:
                try:
                    await self.video_websocket_server.stop()
                except Exception:
                    logger.exception("停止视频 WebSocket 失败")
                self._video_ws_started = False
            if self._status_ws_started:
                try:
                    await self.websocket_server.stop_server()
                except Exception:
                    logger.exception("停止状态 WebSocket 失败")
                self._status_ws_started = False
            self._latest_footprints.clear()
            logger.info("后端服务已停止")

    async def run_forever(self) -> None:
        await self.start()
        try:
            await self._stop_event.wait()
        except asyncio.CancelledError:
            logger.info("收到停止请求")
            raise
        finally:
            stop_task = asyncio.create_task(self.stop())
            try:
                await asyncio.shield(stop_task)
            except asyncio.CancelledError:
                await stop_task
                raise

    def request_stop(self) -> None:
        self.is_running = False
        self._stop_event.set()

    async def _broadcast_video_frame(self, device_sn: str, frame_data: bytes, timestamp: float) -> None:
        footprint = self._latest_footprints.get(device_sn)
        if footprint is not None and (
            not math.isfinite(timestamp)
            or abs(footprint.timestamp_ms - round(timestamp * 1000)) > _FOOTPRINT_FRAME_MAX_DELTA_MS
        ):
            footprint = None
        frame = VideoFrame(
            frame_data=frame_data,
            timestamp=timestamp,
            width=config.video.frame_width,
            height=config.video.frame_height,
            format="jpeg",
            ground_footprint_wgs84=footprint,
        )
        await self.video_websocket_server.broadcast_video_frame(device_sn, frame)

    @staticmethod
    def _valid_coordinates(status: DroneStatus) -> bool:
        coordinates = status.coordinates
        return (
            coordinates is not None
            and -90 <= coordinates.latitude <= 90
            and -180 <= coordinates.longitude <= 180
            and not (coordinates.latitude == 0 and coordinates.longitude == 0)
            and coordinates.timestamp > 0
        )

    async def _on_drone_status_update(self, status: DroneStatus) -> None:
        async with self._status_lock:
            try:
                if status.ground_footprint_wgs84 is not None:
                    self._latest_footprints[status.device_sn] = status.ground_footprint_wgs84
                else:
                    self._latest_footprints.pop(status.device_sn, None)
                await self.websocket_server.broadcast_drone_status(status)
                if not status.is_online:
                    self._latest_footprints.pop(status.device_sn, None)
                    if status.device_sn in self.video_processor_manager.get_active_processors():
                        await asyncio.to_thread(self.video_processor_manager.stop_processor, status.device_sn)
                    if self.is_recording:
                        await self._finish_recording(status.timestamp)
                    return
                if not self._valid_coordinates(status):
                    return

                if status.device_sn not in self.video_processor_manager.get_active_processors():
                    self.video_processor_manager.start_processor(status.device_sn)
                self.video_processor_manager.update_coordinates(status.device_sn, status.coordinates)

                if not self.is_recording:
                    self._start_recording(status)
                await self._record_trajectory_point(status)
            except Exception:
                logger.exception("处理设备状态失败")

    @staticmethod
    def _safe_device_sn(device_sn: str) -> str:
        return re.sub(r"[^A-Za-z0-9_.-]", "_", device_sn)[:128] or "unknown-device"

    def _start_recording(self, status: DroneStatus) -> None:
        source_time = status.coordinates.timestamp or status.timestamp or time.time()
        start_time = datetime.fromtimestamp(source_time).strftime("%Y%m%d_%H%M%S")
        safe_device_sn = self._safe_device_sn(status.device_sn)
        base_name = f"flight_{safe_device_sn}_{start_time}"
        flight_dir = config.storage.trajectory_dir / base_name
        suffix = 1
        while flight_dir.exists():
            flight_dir = config.storage.trajectory_dir / f"{base_name}_{suffix:02d}"
            suffix += 1
        frames_dir = flight_dir / "video_frames"
        frames_dir.mkdir(parents=True, exist_ok=False)

        self.active_flight_dir = flight_dir
        self.active_frames_dir = frames_dir
        self.trajectory_file = flight_dir / f"trajectory_{start_time}.json"
        self.flight_trajectory = {
            "flight_info": {
                "device_sn": status.device_sn,
                "flight_start_time": start_time,
                "flight_start_timestamp_ms": round(source_time * 1000),
                "flight_end_time": None,
                "flight_end_timestamp_ms": None,
                "total_points": 0,
            },
            "trajectory_points": [],
        }
        if config.telemetry.ground_altitude_m is not None:
            self.flight_trajectory["flight_info"].update(
                {
                    "ground_altitude_m": config.telemetry.ground_altitude_m,
                    "altitude_reference": "absolute",
                }
            )
        self._copied_frames.clear()
        self._last_recorded_timestamp = 0.0
        self._last_checkpoint_monotonic = time.monotonic()
        self.is_recording = True
        logger.info("开始记录航次: %s", flight_dir.name)

    async def _record_trajectory_point(self, status: DroneStatus) -> None:
        if not self.is_recording or not self.active_frames_dir:
            return
        source_time = status.coordinates.timestamp or status.timestamp
        if source_time <= self._last_recorded_timestamp:
            return

        frame_name: Optional[str] = None
        video_frame_timestamp_ms: Optional[int] = None
        video_frame_time_delta_ms: Optional[int] = None
        saved_frame = self.video_processor_manager.latest_saved_frame(status.device_sn)
        if saved_frame and abs(saved_frame.timestamp - source_time) * 1000 <= config.video.frame_match_max_age_ms:
            frame_name = await asyncio.to_thread(self._attach_frame, saved_frame)
            if frame_name:
                video_frame_timestamp_ms = round(saved_frame.timestamp * 1000)
                video_frame_time_delta_ms = round((saved_frame.timestamp - source_time) * 1000)

        timestamp_text = datetime.fromtimestamp(source_time).strftime("%Y%m%d_%H%M%S_%f")[:-3]
        position = {
            "latitude": status.coordinates.latitude,
            "longitude": status.coordinates.longitude,
            "altitude": status.coordinates.altitude,
        }
        ground_altitude_m = self.flight_trajectory["flight_info"].get("ground_altitude_m")
        if ground_altitude_m is not None:
            position["relative_altitude"] = status.coordinates.altitude - ground_altitude_m
        point = {
            "timestamp": timestamp_text,
            "source_timestamp_ms": round(source_time * 1000),
            "position": position,
            "attitude": {
                "heading": status.coordinates.heading,
                "pitch": status.coordinates.pitch,
                "roll": status.coordinates.roll,
            },
            "gimbal_attitude": {
                "pitch": status.gimbal_attitude.pitch,
                "roll": status.gimbal_attitude.roll,
                "yaw": status.gimbal_attitude.yaw,
            },
            "video_frame": frame_name,
            "video_frame_timestamp_ms": video_frame_timestamp_ms,
            "video_frame_time_delta_ms": video_frame_time_delta_ms,
        }
        footprint = status.ground_footprint_wgs84
        if (
            footprint is not None
            and video_frame_timestamp_ms is not None
            and abs(footprint.timestamp_ms - video_frame_timestamp_ms) <= _FOOTPRINT_FRAME_MAX_DELTA_MS
        ):
            point.update(footprint.wire_metadata())
        self.flight_trajectory["trajectory_points"].append(point)
        self.flight_trajectory["flight_info"]["total_points"] = len(self.flight_trajectory["trajectory_points"])
        self._last_recorded_timestamp = source_time

        now = time.monotonic()
        if now - self._last_checkpoint_monotonic >= config.storage.checkpoint_seconds:
            self._last_checkpoint_monotonic = now
            await asyncio.to_thread(self._write_trajectory_atomic)
            logger.info(
                "轨迹检查点已保存: %s 点",
                self.flight_trajectory["flight_info"]["total_points"],
            )

    def _attach_frame(self, saved_frame: SavedFrame) -> Optional[str]:
        if not self.active_frames_dir or not saved_frame.path.is_file():
            return None
        destination = self.active_frames_dir / saved_frame.filename
        if saved_frame.filename not in self._copied_frames:
            temporary = destination.with_suffix(".jpg.tmp")
            sidecar_temporary: Optional[Path] = None
            try:
                shutil.copyfile(saved_frame.path, temporary)
                os.replace(temporary, destination)
                source_sidecar = saved_frame.path.with_suffix(".txt")
                if source_sidecar.is_file():
                    sidecar_destination = destination.with_suffix(".txt")
                    sidecar_temporary = sidecar_destination.with_suffix(".txt.tmp")
                    shutil.copyfile(source_sidecar, sidecar_temporary)
                    os.replace(sidecar_temporary, sidecar_destination)
                self._copied_frames.add(saved_frame.filename)
            finally:
                temporary.unlink(missing_ok=True)
                if sidecar_temporary:
                    sidecar_temporary.unlink(missing_ok=True)
        return saved_frame.filename if destination.is_file() else None

    def _write_trajectory_atomic(self) -> None:
        if not self.trajectory_file:
            return
        temporary = self.trajectory_file.with_suffix(".json.tmp")
        try:
            with temporary.open("w", encoding="utf-8", newline="\n") as handle:
                json.dump(self.flight_trajectory, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.trajectory_file)
        finally:
            temporary.unlink(missing_ok=True)

    async def _finish_recording(self, end_timestamp: Optional[float] = None) -> None:
        if not self.is_recording:
            return
        end_timestamp = end_timestamp or time.time()
        flight_info = self.flight_trajectory["flight_info"]
        flight_info["flight_end_time"] = datetime.fromtimestamp(end_timestamp).strftime("%Y%m%d_%H%M%S")
        flight_info["flight_end_timestamp_ms"] = round(end_timestamp * 1000)
        await asyncio.to_thread(self._write_trajectory_atomic)
        completed_dir = self.active_flight_dir
        self.is_recording = False
        logger.info(
            "航次保存完成: %s（%s 点，%s 帧）",
            completed_dir,
            flight_info["total_points"],
            len(self._copied_frames),
        )
        if config.storage.auto_zip and completed_dir:
            archive = await asyncio.to_thread(package_flight, completed_dir)
            logger.info("航次 ZIP 已生成: %s", archive)
        self.active_flight_dir = None
        self.active_frames_dir = None
        self.trajectory_file = None
        self.flight_trajectory = {}
        self._copied_frames.clear()


async def main() -> None:
    service = DroneBackendService()
    await service.run_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
