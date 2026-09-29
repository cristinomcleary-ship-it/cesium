"""Bounded RTMP/RTSP video reader and frame sampler."""
from __future__ import annotations

import asyncio
import logging
import os
import queue
import threading
import time
from concurrent.futures import Future
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Optional

import cv2

from .config import config
from .models import DroneCoordinates


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SavedFrame:
    filename: str
    path: Path
    timestamp: float


class VideoProcessor:
    """Read one video source in a dedicated thread without unbounded queues."""

    def __init__(self) -> None:
        self.is_running = False
        self.is_stream_connected = False
        self.device_sn: Optional[str] = None
        self.rtmp_url: Optional[str] = None
        self.current_coordinates: Optional[DroneCoordinates] = None
        self.websocket_callback = None
        self.should_broadcast: Optional[Callable[[], bool]] = None
        self.event_loop: Optional[asyncio.AbstractEventLoop] = None

        self.process_thread: Optional[threading.Thread] = None
        self.stop_event = threading.Event()
        self.coordinate_queue: queue.Queue[DroneCoordinates] = queue.Queue(maxsize=1)
        self.cap = None

        self.video_dir = config.storage.video_cache_dir
        self._latest_frame_lock = threading.Lock()
        self._latest_frame: Optional[SavedFrame] = None
        self._broadcast_future: Optional[Future] = None
        self._last_save_monotonic = 0.0
        self._last_broadcast_monotonic = 0.0
        self._last_stats_log = 0.0
        self._saves_since_prune = 0

        self.stats: Dict[str, Any] = {
            "frames_processed": 0,
            "frames_saved": 0,
            "frames_broadcast": 0,
            "frames_dropped": 0,
            "connection_attempts": 0,
            "last_frame_time": None,
            "fps": 0.0,
            "stream_connected": False,
        }

    def set_websocket_callback(self, callback, should_broadcast: Optional[Callable[[], bool]] = None) -> None:
        self.websocket_callback = callback
        self.should_broadcast = should_broadcast

    def set_event_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self.event_loop = loop

    def start(self, device_sn: str) -> bool:
        if self.is_running:
            return True
        self.device_sn = device_sn
        self.rtmp_url = config.rtmp.get_stream_url(device_sn)
        self.video_dir.mkdir(parents=True, exist_ok=True)
        self.stop_event.clear()
        self.is_running = True
        self.process_thread = threading.Thread(
            target=self._process_loop,
            name=f"VideoProcessor-{device_sn}",
            daemon=True,
        )
        self.process_thread.start()
        logger.info("视频处理线程已启动: %s", device_sn)
        return True

    def stop(self) -> None:
        if not self.is_running and not (self.process_thread and self.process_thread.is_alive()):
            return
        self.is_running = False
        self.stop_event.set()
        timeout = max(5.0, config.video.read_timeout_ms / 1000.0 + 2.0)
        if self.process_thread and self.process_thread.is_alive():
            self.process_thread.join(timeout=timeout)
        if self.process_thread and self.process_thread.is_alive():
            logger.warning("视频线程未能在 %.1f 秒内停止，将等待读取超时自行退出", timeout)
        else:
            self.process_thread = None
        logger.info("视频处理线程已停止: %s", self.device_sn)

    def update_coordinates(self, coordinates: DroneCoordinates) -> None:
        try:
            self.coordinate_queue.put_nowait(coordinates)
        except queue.Full:
            try:
                self.coordinate_queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self.coordinate_queue.put_nowait(coordinates)
            except queue.Full:
                pass

    def latest_saved_frame(self) -> Optional[SavedFrame]:
        with self._latest_frame_lock:
            return self._latest_frame

    def get_stats(self) -> Dict[str, Any]:
        result = self.stats.copy()
        result["stream_connected"] = self.is_stream_connected
        return result

    def _process_loop(self) -> None:
        consecutive_failures = 0
        try:
            while self.is_running and not self.stop_event.is_set():
                self._update_coordinates_from_queue()
                self.stats["connection_attempts"] += 1
                if self._attempt_connection():
                    consecutive_failures = 0
                    self._stream_loop()
                    if self.is_running and not self.stop_event.is_set():
                        self.stop_event.wait(config.video.retry_interval)
                else:
                    consecutive_failures += 1
                    if config.video.max_retries > 0 and consecutive_failures >= config.video.max_retries:
                        logger.error("视频流达到最大重试次数 %s", config.video.max_retries)
                        break
                    self.stop_event.wait(config.video.retry_interval)
        except Exception:
            logger.exception("视频处理线程异常: %s", self.device_sn)
        finally:
            self._release_capture()
            self.is_stream_connected = False
            self.is_running = False
            self.stats["stream_connected"] = False

    def _update_coordinates_from_queue(self) -> None:
        try:
            while True:
                self.current_coordinates = self.coordinate_queue.get_nowait()
        except queue.Empty:
            pass

    def _attempt_connection(self) -> bool:
        self._release_capture()
        if not self.rtmp_url:
            return False
        logger.info("尝试连接视频流: %s", self._redacted_stream_url())
        try:
            parameters = [
                cv2.CAP_PROP_OPEN_TIMEOUT_MSEC,
                int(config.video.open_timeout_ms),
                cv2.CAP_PROP_READ_TIMEOUT_MSEC,
                int(config.video.read_timeout_ms),
            ]
            self.cap = cv2.VideoCapture(self.rtmp_url, cv2.CAP_FFMPEG, parameters)
            if not self.cap.isOpened():
                logger.warning("无法打开视频流，%.1f 秒后重试", config.video.retry_interval)
                self._release_capture()
                return False
            self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            success, test_frame = self.cap.read()
            if not success or test_frame is None:
                logger.warning("视频流已打开但没有可读取的帧")
                self._release_capture()
                return False
            self.is_stream_connected = True
            self.stats["stream_connected"] = True
            logger.info("视频流连接成功，源帧尺寸 %sx%s", test_frame.shape[1], test_frame.shape[0])
            self._process_frame(test_frame)
            return True
        except Exception as exc:
            logger.warning("连接视频流失败: %s", exc)
            self._release_capture()
            return False

    def _redacted_stream_url(self) -> str:
        if not self.rtmp_url:
            return ""
        if "@" not in self.rtmp_url:
            return self.rtmp_url
        prefix, suffix = self.rtmp_url.rsplit("@", 1)
        scheme = prefix.split("://", 1)[0]
        return f"{scheme}://***@{suffix}"

    def _stream_loop(self) -> None:
        window_start = time.monotonic()
        window_frames = 0
        try:
            while self.is_running and not self.stop_event.is_set() and self.cap and self.cap.isOpened():
                self._update_coordinates_from_queue()
                success, frame = self.cap.read()
                if not success or frame is None:
                    logger.warning("视频帧读取中断，准备重新连接")
                    break
                window_frames += 1
                self._process_frame(frame)
                now = time.monotonic()
                elapsed = now - window_start
                if elapsed >= 5.0:
                    self.stats["fps"] = window_frames / elapsed
                    window_start = now
                    window_frames = 0
                if now - self._last_stats_log >= 10.0:
                    self._last_stats_log = now
                    logger.info(
                        "视频统计: 读取=%s 保存=%s 推送=%s 丢弃=%s 源FPS=%.1f",
                        self.stats["frames_processed"],
                        self.stats["frames_saved"],
                        self.stats["frames_broadcast"],
                        self.stats["frames_dropped"],
                        self.stats["fps"],
                    )
        finally:
            self._release_capture()
            self.is_stream_connected = False
            self.stats["stream_connected"] = False

    def _process_frame(self, frame) -> None:
        now_monotonic = time.monotonic()
        self.stats["frames_processed"] += 1
        self.stats["last_frame_time"] = time.time()

        save_due = config.video.save_fps > 0 and (
            now_monotonic - self._last_save_monotonic >= 1.0 / config.video.save_fps
        )
        broadcast_allowed = bool(
            self.websocket_callback
            and self.event_loop
            and self.event_loop.is_running()
            and (self.should_broadcast is None or self.should_broadcast())
        )
        broadcast_due = broadcast_allowed and (
            now_monotonic - self._last_broadcast_monotonic >= 1.0 / config.video.broadcast_fps
        )
        if not save_due and not broadcast_due:
            return

        if frame.shape[1] != config.video.frame_width or frame.shape[0] != config.video.frame_height:
            frame = cv2.resize(
                frame,
                (config.video.frame_width, config.video.frame_height),
                interpolation=cv2.INTER_AREA,
            )
        encoded, jpeg_buffer = cv2.imencode(
            ".jpg",
            frame,
            [cv2.IMWRITE_JPEG_QUALITY, config.video.quality],
        )
        if not encoded:
            logger.warning("JPEG 编码失败，已跳过当前帧")
            return
        frame_data = jpeg_buffer.tobytes()
        frame_timestamp = time.time()
        if save_due:
            self._last_save_monotonic = now_monotonic
            self._save_encoded_frame(frame_data, frame_timestamp)
        if broadcast_due:
            self._last_broadcast_monotonic = now_monotonic
            self._queue_broadcast(frame_data, frame_timestamp)

    def _save_encoded_frame(self, frame_data: bytes, frame_timestamp: float) -> None:
        if not self.device_sn:
            return
        timestamp = datetime.fromtimestamp(frame_timestamp).strftime("%Y%m%d_%H%M%S_%f")[:-3]
        filename = f"{self.device_sn}_{timestamp}.jpg"
        path = self.video_dir / filename
        temporary = path.with_suffix(".jpg.tmp")
        try:
            temporary.write_bytes(frame_data)
            os.replace(temporary, path)
            coordinates = self.current_coordinates
            if coordinates:
                sidecar = path.with_suffix(".txt")
                sidecar_temporary = sidecar.with_suffix(".txt.tmp")
                sidecar_temporary.write_text(
                    "\n".join(
                        (
                            f"lat={coordinates.latitude:.8f}",
                            f"lon={coordinates.longitude:.8f}",
                            f"alt={coordinates.altitude:.3f}",
                            f"timestamp={timestamp}",
                            "",
                        )
                    ),
                    encoding="utf-8",
                )
                os.replace(sidecar_temporary, sidecar)
            with self._latest_frame_lock:
                self._latest_frame = SavedFrame(filename=filename, path=path, timestamp=frame_timestamp)
            self.stats["frames_saved"] += 1
            self._saves_since_prune += 1
            if self._saves_since_prune >= 50:
                self._saves_since_prune = 0
                self._prune_cache()
        except Exception:
            logger.exception("保存视频采样帧失败: %s", path)
            temporary.unlink(missing_ok=True)

    def _prune_cache(self) -> None:
        if not self.device_sn or config.video.cache_max_frames <= 0:
            return
        try:
            frames = sorted(
                self.video_dir.glob(f"{self.device_sn}_*.jpg"),
                key=lambda item: item.stat().st_mtime,
            )
            overflow = len(frames) - config.video.cache_max_frames
            for frame in frames[:max(0, overflow)]:
                frame.unlink(missing_ok=True)
                frame.with_suffix(".txt").unlink(missing_ok=True)
        except Exception:
            logger.warning("清理视频缓存失败", exc_info=True)

    def _queue_broadcast(self, frame_data: bytes, frame_timestamp: float) -> None:
        if not self.websocket_callback or not self.event_loop or not self.event_loop.is_running():
            return
        if self._broadcast_future and not self._broadcast_future.done():
            self.stats["frames_dropped"] += 1
            return
        try:
            coroutine = self.websocket_callback(self.device_sn, frame_data, frame_timestamp)
            self._broadcast_future = asyncio.run_coroutine_threadsafe(coroutine, self.event_loop)
            self._broadcast_future.add_done_callback(self._broadcast_finished)
            self.stats["frames_broadcast"] += 1
        except Exception:
            logger.exception("投递视频帧到主事件循环失败")

    def _broadcast_finished(self, future: Future) -> None:
        try:
            future.result()
        except Exception:
            logger.warning("视频帧广播失败", exc_info=True)

    def _release_capture(self) -> None:
        capture, self.cap = self.cap, None
        if capture is not None:
            try:
                capture.release()
            except Exception:
                logger.debug("释放 VideoCapture 失败", exc_info=True)


class VideoProcessorManager:
    def __init__(self) -> None:
        self.processors: Dict[str, VideoProcessor] = {}
        self.websocket_callback = None
        self.should_broadcast: Optional[Callable[[], bool]] = None
        self.event_loop: Optional[asyncio.AbstractEventLoop] = None

    def set_websocket_callback(self, callback, should_broadcast: Optional[Callable[[], bool]] = None) -> None:
        self.websocket_callback = callback
        self.should_broadcast = should_broadcast

    def set_event_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self.event_loop = loop
        for processor in self.processors.values():
            processor.set_event_loop(loop)

    def start_processor(self, device_sn: str) -> bool:
        if device_sn in self.processors:
            return True
        processor = VideoProcessor()
        if self.websocket_callback:
            processor.set_websocket_callback(self.websocket_callback, self.should_broadcast)
        if self.event_loop:
            processor.set_event_loop(self.event_loop)
        if not processor.start(device_sn):
            return False
        self.processors[device_sn] = processor
        return True

    def stop_processor(self, device_sn: str) -> None:
        processor = self.processors.pop(device_sn, None)
        if processor:
            processor.stop()

    def stop_all_processors(self) -> None:
        for device_sn in tuple(self.processors):
            self.stop_processor(device_sn)

    def update_coordinates(self, device_sn: str, coordinates: DroneCoordinates) -> None:
        processor = self.processors.get(device_sn)
        if processor:
            processor.update_coordinates(coordinates)

    def latest_saved_frame(self, device_sn: str) -> Optional[SavedFrame]:
        processor = self.processors.get(device_sn)
        return processor.latest_saved_frame() if processor else None

    def get_active_processors(self) -> list[str]:
        return list(self.processors)

    def get_stats(self, device_sn: str) -> Optional[Dict[str, Any]]:
        processor = self.processors.get(device_sn)
        return processor.get_stats() if processor else None

    def get_all_stats(self) -> Dict[str, Dict[str, Any]]:
        return {device_sn: processor.get_stats() for device_sn, processor in self.processors.items()}
