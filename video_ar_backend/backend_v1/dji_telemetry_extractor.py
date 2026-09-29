"""Extract verifiable metadata and telemetry from DJI video assets.

This module is intentionally independent from the running backend.  It reads:

* MP4/MOV container and stream metadata through ``ffprobe``;
* a reduced set of video properties through OpenCV when ``ffprobe`` is absent;
* DJI sidecar SRT files;
* embedded subtitle streams (through ``ffmpeg``); and
* telemetry-like tags already present in a supplied ffprobe JSON document.

No camera, aircraft, lens, attitude, or position value is guessed.  Values that
are not present in the source remain ``None`` on Python objects and are omitted
from serialized samples.  ``field_sources`` and ``missing_fields`` make that
distinction explicit to downstream tools.
"""
from __future__ import annotations

import argparse
import html
import json
import math
import os
import re
import signal
import shutil
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Optional, Sequence


SCHEMA_VERSION = "dji-video-telemetry/v1"
MAX_SRT_BYTES = 64 * 1024 * 1024
MAX_SRT_SAMPLES = 120_000


class ExtractionError(RuntimeError):
    """Base class for recoverable extraction failures."""


class ExtractionCancelled(ExtractionError):
    """Raised when a caller requests cancellation of an active extraction."""


class FFprobeNotFoundError(ExtractionError):
    """Raised when ffprobe is required but cannot be found."""


class FFprobeExecutionError(ExtractionError):
    """Raised when ffprobe exits unsuccessfully or emits invalid JSON."""


class FFmpegNotFoundError(ExtractionError):
    """Raised when an embedded subtitle stream needs ffmpeg."""


class SubtitleParseError(ExtractionError):
    """Raised when an SRT source is malformed or contains invalid coordinates."""


class VideoOpenError(ExtractionError):
    """Raised when neither ffprobe nor OpenCV can inspect the video."""


CancelCallback = Callable[[], bool]
PROCESS_POLL_INTERVAL_SECONDS = 0.2


TELEMETRY_VALUE_FIELDS = (
    "latitude",
    "longitude",
    "relative_altitude_m",
    "absolute_altitude_m",
    "gps_altitude_m",
    "gimbal_yaw_deg",
    "gimbal_pitch_deg",
    "gimbal_roll_deg",
    "aircraft_yaw_deg",
    "aircraft_pitch_deg",
    "aircraft_roll_deg",
    "iso",
    "shutter_seconds",
    "aperture_f_number",
    "exposure_value_ev",
    "color_temperature_k",
    "color_mode",
    "ae_metering_mode",
    "focal_length_35mm_equivalent_mm",
    "digital_zoom_ratio",
    "horizontal_speed_m_s",
    "vertical_speed_m_s",
    "distance_m",
)


def _without_none(value: Any) -> Any:
    """Recursively remove ``None`` while retaining zero and false values."""

    if isinstance(value, Mapping):
        return {str(key): _without_none(item) for key, item in value.items() if item is not None}
    if isinstance(value, (list, tuple)):
        return [_without_none(item) for item in value if item is not None]
    return value


def _finite_float(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        result = float(value)
    else:
        text = str(value).strip().strip(",;")
        if not text or text.lower() in {"n/a", "na", "none", "null", "--"}:
            return None
        try:
            result = float(text)
        except ValueError:
            return None
    return result if math.isfinite(result) else None


def _finite_int(value: Any) -> Optional[int]:
    number = _finite_float(value)
    if number is None or not number.is_integer():
        return None
    return int(number)


def _fraction_or_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    text = str(value).strip().strip(",;")
    if "/" in text:
        numerator, denominator = text.split("/", 1)
        left = _finite_float(numerator)
        right = _finite_float(denominator)
        if left is None or right in {None, 0.0}:
            return None
        result = left / right
        return result if math.isfinite(result) else None
    return _finite_float(text)


def _normalise_key(value: str) -> str:
    separated = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", value.strip())
    separated = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", separated)
    return re.sub(r"[^a-z0-9]+", "_", separated.lower()).strip("_")


def _resolve_binary(binary: str | Path, display_name: str) -> str:
    text = str(binary).strip()
    if not text:
        raise ExtractionError(f"{display_name} executable was not specified")
    candidate = Path(text).expanduser()
    if candidate.is_absolute() or candidate.parent != Path("."):
        if candidate.is_file():
            return str(candidate.resolve())
        if display_name == "ffprobe":
            raise FFprobeNotFoundError(f"找不到 ffprobe：{candidate}")
        raise FFmpegNotFoundError(f"找不到 ffmpeg：{candidate}")
    # The desktop extractor ships an application-local FFmpeg build so a user
    # can double-click the program without modifying PATH.  Only substitute it
    # for the canonical default names; an explicitly different command (for
    # example ``missing-ffprobe`` in diagnostics) must still be honoured.
    canonical_names = {display_name.casefold(), f"{display_name}.exe".casefold()}
    if text.casefold() in canonical_names:
        executable_name = f"{display_name}.exe" if os.name == "nt" else display_name
        bundled = Path(__file__).resolve().parent.parent / "tools" / "FFmpeg" / "bin" / executable_name
        if bundled.is_file():
            return str(bundled.resolve())

    resolved = shutil.which(text)
    if not resolved:
        if display_name == "ffprobe":
            raise FFprobeNotFoundError(
                "找不到 ffprobe。请安装 FFmpeg 并将 ffprobe 加入 PATH，"
                "或通过 ffprobe_bin 传入可执行文件路径。"
            )
        raise FFmpegNotFoundError(
            "找不到 ffmpeg，无法读取视频内嵌字幕。请安装 FFmpeg 并将 ffmpeg "
            "加入 PATH，或通过 ffmpeg_bin 传入可执行文件路径。"
        )
    return resolved


def _cancellation_requested(
    cancel_event: threading.Event | None,
    cancel_callback: CancelCallback | None,
) -> bool:
    """Return whether either supported cancellation source requests a stop."""

    return bool(
        (cancel_event is not None and cancel_event.is_set())
        or (cancel_callback is not None and cancel_callback())
    )


def _check_cancellation(
    cancel_event: threading.Event | None,
    cancel_callback: CancelCallback | None,
) -> None:
    if _cancellation_requested(cancel_event, cancel_callback):
        raise ExtractionCancelled("用户已取消视频信息提取")


def _close_process_pipes(process: subprocess.Popen[bytes]) -> None:
    for name in ("stdout", "stderr"):
        stream = getattr(process, name, None)
        if stream is None:
            continue
        try:
            stream.close()
        except (OSError, ValueError):
            pass


def _drain_process_pipes(process: subprocess.Popen[bytes]) -> None:
    """Join Popen's Windows pipe-reader threads without unbounded waiting."""

    try:
        process.communicate(timeout=0.5)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    finally:
        _close_process_pipes(process)


def _terminate_process_tree(process: subprocess.Popen[bytes]) -> None:
    """Best-effort termination of the process and every descendant it spawned."""

    try:
        if process.poll() is not None:
            return
        if os.name == "nt":
            # ffmpeg can create worker processes.  Killing only the parent leaves
            # inherited pipe handles alive and makes cancellation appear hung.
            taskkill: subprocess.Popen[bytes] | None = None
            tree_killed = False
            try:
                taskkill = subprocess.Popen(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                tree_killed = taskkill.wait(timeout=1) == 0
            except BaseException:
                if taskkill is not None and taskkill.poll() is None:
                    try:
                        taskkill.kill()
                        taskkill.wait(timeout=0.5)
                    except BaseException:
                        pass
            if not tree_killed:
                # Restricted Windows sessions can reject taskkill even for a
                # child process.  Do not make the UI wait for the full timeout.
                process.kill()
        else:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except (OSError, ProcessLookupError):
                process.terminate()

        try:
            process.wait(timeout=1)
            return
        except (OSError, subprocess.TimeoutExpired):
            pass

        if os.name == "nt":
            process.kill()
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (OSError, ProcessLookupError):
                process.kill()
        try:
            process.wait(timeout=0.5)
        except BaseException:
            pass
    except BaseException:
        # Cleanup must never replace the cancellation/timeout that caused it.
        try:
            process.kill()
            process.wait(timeout=0.5)
        except BaseException:
            pass
    finally:
        _drain_process_pipes(process)


def _run_cancellable_process(
    command: Sequence[str],
    *,
    timeout_seconds: float,
    cancel_event: threading.Event | None = None,
    cancel_callback: CancelCallback | None = None,
) -> subprocess.CompletedProcess[bytes]:
    """Run a captured subprocess while polling cancellation at short intervals."""

    _check_cancellation(cancel_event, cancel_callback)
    creation_flags = 0
    if os.name == "nt":
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(
            subprocess,
            "CREATE_NEW_PROCESS_GROUP",
            0,
        )
    process = subprocess.Popen(
        list(command),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=creation_flags,
        start_new_session=os.name != "nt",
    )
    deadline = time.monotonic() + timeout_seconds
    try:
        while True:
            _check_cancellation(cancel_event, cancel_callback)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, timeout_seconds)
            try:
                stdout, stderr = process.communicate(
                    timeout=min(PROCESS_POLL_INTERVAL_SECONDS, remaining)
                )
                break
            except subprocess.TimeoutExpired:
                continue
        _check_cancellation(cancel_event, cancel_callback)
        return subprocess.CompletedProcess(
            list(command),
            process.returncode,
            stdout or b"",
            stderr or b"",
        )
    except BaseException:
        _terminate_process_tree(process)
        raise


def _parse_rate(value: Any) -> Optional[float]:
    rate = _fraction_or_float(value)
    if rate is None or rate <= 0:
        return None
    return rate


@dataclass(frozen=True)
class VideoMetadata:
    """Normalized video properties plus lossless ffprobe stream metadata."""

    backend: str
    width: Optional[int] = None
    height: Optional[int] = None
    frame_rate_fps: Optional[float] = None
    frame_count: Optional[int] = None
    duration_ms: Optional[int] = None
    video_codec: Optional[str] = None
    pixel_format: Optional[str] = None
    bit_rate_bps: Optional[int] = None
    rotation_deg: Optional[float] = None
    creation_time: Optional[str] = None
    format_name: Optional[str] = None
    format_long_name: Optional[str] = None
    size_bytes: Optional[int] = None
    streams: tuple[Mapping[str, Any], ...] = ()
    chapters: tuple[Mapping[str, Any], ...] = ()
    format_info: Mapping[str, Any] = field(default_factory=dict)
    format_tags: Mapping[str, Any] = field(default_factory=dict)
    field_sources: Mapping[str, str] = field(default_factory=dict)
    missing_fields: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return _without_none(
            {
                "backend": self.backend,
                "width": self.width,
                "height": self.height,
                "frame_rate_fps": self.frame_rate_fps,
                "frame_count": self.frame_count,
                "duration_ms": self.duration_ms,
                "video_codec": self.video_codec,
                "pixel_format": self.pixel_format,
                "bit_rate_bps": self.bit_rate_bps,
                "rotation_deg": self.rotation_deg,
                "creation_time": self.creation_time,
                "format_name": self.format_name,
                "format_long_name": self.format_long_name,
                "size_bytes": self.size_bytes,
                "streams": list(self.streams),
                "chapters": list(self.chapters),
                "format_info": dict(self.format_info),
                "format_tags": dict(self.format_tags),
                "field_sources": dict(self.field_sources),
                "missing_fields": list(self.missing_fields),
            }
        )


@dataclass(frozen=True)
class TelemetrySample:
    """One timed DJI telemetry sample.

    ``gimbal_*`` values originate only from DJI ``gb_*``/``gimbal_*`` fields.
    They are deliberately not copied into ``aircraft_*`` fields.
    """

    source_kind: str
    source_name: str
    cue_index: Optional[int] = None
    stream_index: Optional[int] = None
    video_sample_index: Optional[int] = None
    start_time_ms: Optional[int] = None
    end_time_ms: Optional[int] = None
    frame_index: Optional[int] = None
    frame_delta_ms: Optional[float] = None
    recorded_at: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    position_crs: Optional[str] = None
    relative_altitude_m: Optional[float] = None
    absolute_altitude_m: Optional[float] = None
    gps_altitude_m: Optional[float] = None
    gimbal_yaw_deg: Optional[float] = None
    gimbal_pitch_deg: Optional[float] = None
    gimbal_roll_deg: Optional[float] = None
    aircraft_yaw_deg: Optional[float] = None
    aircraft_pitch_deg: Optional[float] = None
    aircraft_roll_deg: Optional[float] = None
    iso: Optional[int] = None
    shutter_seconds: Optional[float] = None
    aperture_f_number: Optional[float] = None
    exposure_value_ev: Optional[float] = None
    color_temperature_k: Optional[float] = None
    color_mode: Optional[str] = None
    ae_metering_mode: Optional[str] = None
    focal_length_35mm_equivalent_mm: Optional[float] = None
    digital_zoom_ratio: Optional[float] = None
    horizontal_speed_m_s: Optional[float] = None
    vertical_speed_m_s: Optional[float] = None
    distance_m: Optional[float] = None
    extra_fields: Mapping[str, Any] = field(default_factory=dict)
    raw_text: Optional[str] = None
    field_sources: Mapping[str, str] = field(default_factory=dict)
    missing_fields: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        values = {
            name: getattr(self, name)
            for name in (
                "cue_index",
                "stream_index",
                "video_sample_index",
                "start_time_ms",
                "end_time_ms",
                "frame_index",
                "frame_delta_ms",
                "recorded_at",
                "position_crs",
                *TELEMETRY_VALUE_FIELDS,
            )
        }
        return _without_none(
            {
                "source": {"kind": self.source_kind, "name": self.source_name},
                **values,
                "extra_fields": dict(self.extra_fields),
                "raw_text": self.raw_text,
                "field_sources": dict(self.field_sources),
                "missing_fields": list(self.missing_fields),
            }
        )


@dataclass(frozen=True)
class ExtractionResult:
    source_file: str
    video: VideoMetadata
    telemetry: tuple[TelemetrySample, ...]
    subtitle_sources: tuple[Mapping[str, Any], ...] = ()
    warnings: tuple[str, ...] = ()
    schema_version: str = SCHEMA_VERSION

    def telemetry_coverage(self) -> dict[str, Any]:
        present_counts = {
            name: sum(getattr(sample, name) is not None for sample in self.telemetry)
            for name in TELEMETRY_VALUE_FIELDS
        }
        return {
            "sample_count": len(self.telemetry),
            "present_counts": present_counts,
            "missing_in_all_samples": [
                name for name, count in present_counts.items() if count == 0
            ],
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "source": {"video_file": self.source_file},
            "video": self.video.to_dict(),
            "subtitle_sources": [dict(item) for item in self.subtitle_sources],
            "telemetry_coverage": self.telemetry_coverage(),
            "telemetry": [sample.to_dict() for sample in self.telemetry],
            "warnings": list(self.warnings),
        }


def _video_stream(document: Mapping[str, Any]) -> Optional[Mapping[str, Any]]:
    streams = document.get("streams")
    if not isinstance(streams, Sequence) or isinstance(streams, (str, bytes)):
        return None
    videos = [item for item in streams if isinstance(item, Mapping) and item.get("codec_type") == "video"]
    if not videos:
        return None
    for item in videos:
        disposition = item.get("disposition")
        if isinstance(disposition, Mapping) and disposition.get("default") == 1:
            return item
    return videos[0]


def _stream_rotation(stream: Mapping[str, Any]) -> Optional[float]:
    tags = stream.get("tags")
    if isinstance(tags, Mapping):
        rotation = _finite_float(tags.get("rotate"))
        if rotation is not None:
            return rotation
    side_data = stream.get("side_data_list")
    if isinstance(side_data, Sequence) and not isinstance(side_data, (str, bytes)):
        for item in side_data:
            if isinstance(item, Mapping):
                rotation = _finite_float(item.get("rotation"))
                if rotation is not None:
                    return rotation
    return None


def parse_ffprobe_document(document: Mapping[str, Any]) -> VideoMetadata:
    """Normalize a decoded ffprobe JSON document without discarding raw streams."""

    if not isinstance(document, Mapping):
        raise FFprobeExecutionError("ffprobe JSON 顶层必须是对象")
    stream = _video_stream(document)
    if stream is None:
        raise FFprobeExecutionError("ffprobe JSON 中没有视频流")
    format_info = document.get("format")
    if not isinstance(format_info, Mapping):
        format_info = {}
    tags = format_info.get("tags")
    format_tags = dict(tags) if isinstance(tags, Mapping) else {}
    stream_tags_value = stream.get("tags")
    stream_tags = dict(stream_tags_value) if isinstance(stream_tags_value, Mapping) else {}

    width = _finite_int(stream.get("width"))
    height = _finite_int(stream.get("height"))
    frame_rate = _parse_rate(stream.get("avg_frame_rate")) or _parse_rate(stream.get("r_frame_rate"))
    frame_count = _finite_int(stream.get("nb_frames")) or _finite_int(stream.get("nb_read_frames"))
    duration_s = _finite_float(stream.get("duration"))
    duration_source = "streams[video].duration"
    if duration_s is None:
        duration_s = _finite_float(format_info.get("duration"))
        duration_source = "format.duration"
    duration_ms = round(duration_s * 1000) if duration_s is not None and duration_s >= 0 else None
    bit_rate = _finite_int(stream.get("bit_rate")) or _finite_int(format_info.get("bit_rate"))
    creation_time = stream_tags.get("creation_time") or format_tags.get("creation_time")
    rotation = _stream_rotation(stream)

    sources: dict[str, str] = {}
    for name, value, source in (
        ("width", width, "streams[video].width"),
        ("height", height, "streams[video].height"),
        ("frame_rate_fps", frame_rate, "streams[video].avg_frame_rate/r_frame_rate"),
        ("frame_count", frame_count, "streams[video].nb_frames/nb_read_frames"),
        ("duration_ms", duration_ms, duration_source),
        ("video_codec", stream.get("codec_name"), "streams[video].codec_name"),
        ("pixel_format", stream.get("pix_fmt"), "streams[video].pix_fmt"),
        ("bit_rate_bps", bit_rate, "streams[video]/format.bit_rate"),
        ("rotation_deg", rotation, "streams[video].tags/side_data_list.rotation"),
        ("creation_time", creation_time, "streams[video]/format.tags.creation_time"),
    ):
        if value is not None:
            sources[name] = source

    expected = (
        "width",
        "height",
        "frame_rate_fps",
        "frame_count",
        "duration_ms",
        "video_codec",
        "pixel_format",
        "bit_rate_bps",
        "rotation_deg",
        "creation_time",
    )
    missing = tuple(name for name in expected if name not in sources)
    raw_streams = document.get("streams")
    streams = tuple(item for item in raw_streams if isinstance(item, Mapping)) if isinstance(raw_streams, Sequence) else ()
    raw_chapters = document.get("chapters")
    chapters = tuple(item for item in raw_chapters if isinstance(item, Mapping)) if isinstance(raw_chapters, Sequence) else ()
    return VideoMetadata(
        backend="ffprobe",
        width=width,
        height=height,
        frame_rate_fps=frame_rate,
        frame_count=frame_count,
        duration_ms=duration_ms,
        video_codec=str(stream.get("codec_name")) if stream.get("codec_name") is not None else None,
        pixel_format=str(stream.get("pix_fmt")) if stream.get("pix_fmt") is not None else None,
        bit_rate_bps=bit_rate,
        rotation_deg=rotation,
        creation_time=str(creation_time) if creation_time is not None else None,
        format_name=str(format_info.get("format_name")) if format_info.get("format_name") is not None else None,
        format_long_name=str(format_info.get("format_long_name")) if format_info.get("format_long_name") is not None else None,
        size_bytes=_finite_int(format_info.get("size")),
        streams=streams,
        chapters=chapters,
        format_info=dict(format_info),
        format_tags=format_tags,
        field_sources=sources,
        missing_fields=missing,
    )


def probe_video(
    video_path: str | Path,
    ffprobe_bin: str | Path = "ffprobe",
    *,
    cancel_event: threading.Event | None = None,
    cancel_callback: CancelCallback | None = None,
) -> dict[str, Any]:
    """Run ffprobe and return its decoded JSON document.

    This low-level API requires ffprobe and raises :class:`FFprobeNotFoundError`
    when it is unavailable.  :func:`extract_dji_video` provides an OpenCV
    fallback for callers that only need the properties OpenCV can verify.
    """

    source = Path(video_path).expanduser()
    if not source.is_file():
        raise VideoOpenError(f"视频文件不存在：{source}")
    executable = _resolve_binary(ffprobe_bin, "ffprobe")
    command = [
        executable,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        "-show_chapters",
        str(source),
    ]
    try:
        completed = _run_cancellable_process(
            command,
            timeout_seconds=120,
            cancel_event=cancel_event,
            cancel_callback=cancel_callback,
        )
    except OSError as exc:
        raise FFprobeExecutionError(f"无法启动 ffprobe：{exc}") from exc
    except subprocess.TimeoutExpired as exc:
        raise FFprobeExecutionError("ffprobe 检查视频超过 120 秒") from exc
    if completed.returncode != 0:
        error_text = completed.stderr.decode("utf-8", errors="replace").strip()
        raise FFprobeExecutionError(f"ffprobe 检查失败：{error_text or '未知错误'}")
    try:
        decoded = json.loads(completed.stdout.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise FFprobeExecutionError("ffprobe 未返回有效的 UTF-8 JSON") from exc
    if not isinstance(decoded, dict):
        raise FFprobeExecutionError("ffprobe JSON 顶层必须是对象")
    return decoded


def _opencv_video_metadata(video_path: Path) -> VideoMetadata:
    try:
        import cv2  # type: ignore
    except ImportError as exc:
        raise VideoOpenError(
            "ffprobe 不可用，且当前 Python 环境没有 OpenCV，无法读取视频元数据"
        ) from exc

    capture = cv2.VideoCapture(str(video_path))
    try:
        if not capture.isOpened():
            raise VideoOpenError(f"OpenCV 无法打开视频：{video_path}")
        width = _finite_int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = _finite_int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = _parse_rate(capture.get(cv2.CAP_PROP_FPS))
        frame_count = _finite_int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        rotation = (
            _finite_float(capture.get(cv2.CAP_PROP_ORIENTATION_META))
            if hasattr(cv2, "CAP_PROP_ORIENTATION_META")
            else None
        )
        fourcc = _finite_int(capture.get(cv2.CAP_PROP_FOURCC))
        video_codec = None
        if fourcc is not None and fourcc > 0:
            decoded_fourcc = "".join(chr((fourcc >> (8 * index)) & 0xFF) for index in range(4)).strip("\x00 ")
            if decoded_fourcc and all(32 <= ord(character) < 127 for character in decoded_fourcc):
                video_codec = decoded_fourcc
        bitrate_kbps = (
            _finite_float(capture.get(cv2.CAP_PROP_BITRATE))
            if hasattr(cv2, "CAP_PROP_BITRATE")
            else None
        )
        bit_rate_bps = (
            round(bitrate_kbps * 1000)
            if bitrate_kbps is not None and bitrate_kbps > 0
            else None
        )
        if width is not None and width <= 0:
            width = None
        if height is not None and height <= 0:
            height = None
        if frame_count is not None and frame_count <= 0:
            frame_count = None
        duration_ms = (
            round(frame_count / fps * 1000)
            if frame_count is not None and fps is not None and fps > 0
            else None
        )
    finally:
        capture.release()

    sources = {
        name: source
        for name, value, source in (
            ("width", width, "opencv.CAP_PROP_FRAME_WIDTH"),
            ("height", height, "opencv.CAP_PROP_FRAME_HEIGHT"),
            ("frame_rate_fps", fps, "opencv.CAP_PROP_FPS"),
            ("frame_count", frame_count, "opencv.CAP_PROP_FRAME_COUNT"),
            ("duration_ms", duration_ms, "derived: frame_count / frame_rate_fps"),
            ("video_codec", video_codec, "opencv.CAP_PROP_FOURCC"),
            ("bit_rate_bps", bit_rate_bps, "opencv.CAP_PROP_BITRATE"),
            ("rotation_deg", rotation, "opencv.CAP_PROP_ORIENTATION_META"),
        )
        if value is not None
    }
    expected = (
        "width",
        "height",
        "frame_rate_fps",
        "frame_count",
        "duration_ms",
        "video_codec",
        "pixel_format",
        "bit_rate_bps",
        "rotation_deg",
        "creation_time",
    )
    return VideoMetadata(
        backend="opencv",
        width=width,
        height=height,
        frame_rate_fps=fps,
        frame_count=frame_count,
        duration_ms=duration_ms,
        video_codec=video_codec,
        bit_rate_bps=bit_rate_bps,
        rotation_deg=rotation,
        size_bytes=video_path.stat().st_size,
        field_sources=sources,
        missing_fields=tuple(name for name in expected if name not in sources),
    )


_TIMECODE_RE = re.compile(
    r"^\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*"
    r"(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})(?:\s+.*)?$"
)
_FRAME_RE = re.compile(r"\bFrameCnt\s*:\s*(\d+)", re.IGNORECASE)
_DIFF_RE = re.compile(r"\bDiffTime\s*:\s*([+-]?\d+(?:\.\d+)?)\s*ms\b", re.IGNORECASE)
_DATETIME_RE = re.compile(r"\b(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?)\b")
_KEY_RE = re.compile(r"(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9_-]*)\s*:\s*")


def _timecode_ms(groups: Sequence[str]) -> int:
    hours, minutes, seconds, millis = (int(value) for value in groups)
    if minutes >= 60 or seconds >= 60:
        raise ValueError("invalid minute or second")
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis


def _strip_markup(value: str) -> str:
    without_tags = re.sub(r"<[^>]*>", "", value)
    return html.unescape(without_tags).replace("\ufeff", "").strip()


def _key_values(text: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for group in re.findall(r"\[([^\]]*)\]", text):
        matches = list(_KEY_RE.finditer(group))
        for index, match in enumerate(matches):
            end = matches[index + 1].start() if index + 1 < len(matches) else len(group)
            value = group[match.end() : end].strip(" \t,;")
            if value:
                result[_normalise_key(match.group(1))] = value
    return result


_FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "latitude": ("latitude", "gps_latitude", "lat"),
    "longitude": ("longitude", "gps_longitude", "lon", "lng"),
    "relative_altitude_m": ("rel_alt", "relative_altitude", "relative_altitude_m"),
    "absolute_altitude_m": ("abs_alt", "absolute_altitude", "absolute_altitude_m"),
    "gps_altitude_m": ("gps_alt", "gps_altitude", "gps_altitude_m"),
    "gimbal_yaw_deg": ("gb_yaw", "gimbal_yaw", "gimbal_yaw_degree"),
    "gimbal_pitch_deg": ("gb_pitch", "gimbal_pitch", "gimbal_pitch_degree"),
    "gimbal_roll_deg": ("gb_roll", "gimbal_roll", "gimbal_roll_degree"),
    "aircraft_yaw_deg": ("aircraft_yaw", "body_yaw", "flight_yaw"),
    "aircraft_pitch_deg": ("aircraft_pitch", "body_pitch", "flight_pitch"),
    "aircraft_roll_deg": ("aircraft_roll", "body_roll", "flight_roll"),
    "iso": ("iso",),
    "shutter_seconds": ("shutter", "shutter_speed"),
    "aperture_f_number": ("fnum", "f_number", "aperture"),
    "exposure_value_ev": ("ev", "exposure_value"),
    "color_temperature_k": ("ct", "color_temperature", "color_temp"),
    "color_mode": ("color_md", "color_mode"),
    "ae_metering_mode": ("ae_meter_md", "ae_metering_mode"),
    "focal_length_35mm_equivalent_mm": (
        "focal_len",
        "focal_length",
        "focal_length_35mm_equivalent",
        "focal_length_35mm_equivalent_mm",
    ),
    "digital_zoom_ratio": ("dzoom_ratio", "digital_zoom", "digital_zoom_ratio"),
    "horizontal_speed_m_s": ("h_speed", "horizontal_speed", "horizontal_speed_m_s"),
    "vertical_speed_m_s": ("v_speed", "vertical_speed", "vertical_speed_m_s"),
    "distance_m": ("distance", "distance_m"),
}


def _first_raw(raw: Mapping[str, Any], aliases: Iterable[str]) -> tuple[Optional[str], Any]:
    for alias in aliases:
        key = _normalise_key(alias)
        if key in raw:
            return key, raw[key]
    return None, None


def _sample_values(raw: Mapping[str, Any], source_prefix: str) -> tuple[dict[str, Any], dict[str, str]]:
    values: dict[str, Any] = {}
    sources: dict[str, str] = {}
    string_fields = {"color_mode", "ae_metering_mode"}
    integer_fields = {"iso"}
    fraction_fields = {"shutter_seconds"}
    for field_name, aliases in _FIELD_ALIASES.items():
        raw_key, raw_value = _first_raw(raw, aliases)
        if raw_key is None:
            continue
        if field_name in string_fields:
            parsed: Any = str(raw_value).strip() or None
        elif field_name in integer_fields:
            parsed = _finite_int(raw_value)
        elif field_name in fraction_fields:
            parsed = _fraction_or_float(raw_value)
        else:
            parsed = _finite_float(raw_value)
        if parsed is not None:
            values[field_name] = parsed
            suffix = " (DJI 35mm equivalent)" if field_name == "focal_length_35mm_equivalent_mm" else ""
            sources[field_name] = f"{source_prefix}.{raw_key}{suffix}"
    return values, sources


def _validate_coordinates(values: Mapping[str, Any], cue_label: str) -> None:
    latitude = values.get("latitude")
    longitude = values.get("longitude")
    if latitude is not None and not -90.0 <= latitude <= 90.0:
        raise SubtitleParseError(f"{cue_label} 的纬度超出 [-90, 90]：{latitude}")
    if longitude is not None and not -180.0 <= longitude <= 180.0:
        raise SubtitleParseError(f"{cue_label} 的经度超出 [-180, 180]：{longitude}")


def _parse_old_gps(text: str, raw: dict[str, Any]) -> None:
    match = re.search(
        r"\bGPS\s*\(\s*([+-]?\d+(?:\.\d+)?)\s*,\s*"
        r"([+-]?\d+(?:\.\d+)?)\s*(?:,\s*([+-]?\d+(?:\.\d+)?))?\s*\)",
        text,
        re.IGNORECASE,
    )
    if not match:
        return
    raw.setdefault("latitude", match.group(1))
    raw.setdefault("longitude", match.group(2))
    if match.group(3) is not None:
        raw.setdefault("gps_altitude", match.group(3))


def parse_dji_srt(
    text: str,
    *,
    source_name: str = "<memory>",
    stream_index: Optional[int] = None,
    source_kind: str = "sidecar_srt",
) -> list[TelemetrySample]:
    """Parse common DJI SRT variants into traceable samples.

    Cue timing is copied exactly.  ``FrameCnt`` is never inferred from the cue
    number, and timestamps without a timezone remain timezone-free strings.
    """

    if not isinstance(text, str):
        raise SubtitleParseError("SRT 内容必须是字符串")
    if len(text) > MAX_SRT_BYTES:
        raise SubtitleParseError("SRT 超过 64 MB，已停止读取以避免耗尽内存；请先按视频分段")
    normalized = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return []
    blocks = re.split(r"\n\s*\n", normalized)
    if len(blocks) > MAX_SRT_SAMPLES:
        raise SubtitleParseError("SRT 条目超过 120,000，已停止读取；请先按视频分段")
    samples: list[TelemetrySample] = []
    malformed_timecode = False
    for block_number, block in enumerate(blocks, start=1):
        lines = [line.strip() for line in block.split("\n") if line.strip()]
        if not lines:
            continue
        cue_index: Optional[int] = None
        time_line_index = 0
        if re.fullmatch(r"\d+", lines[0]):
            cue_index = int(lines[0])
            time_line_index = 1
        if time_line_index >= len(lines):
            continue
        match = _TIMECODE_RE.match(lines[time_line_index])
        if not match:
            if "-->" in lines[time_line_index] or any("-->" in line for line in lines):
                malformed_timecode = True
            continue
        try:
            start_ms = _timecode_ms(match.groups()[:4])
            end_ms = _timecode_ms(match.groups()[4:])
        except ValueError as exc:
            raise SubtitleParseError(f"{source_name} 第 {block_number} 块时间码无效") from exc
        if end_ms < start_ms:
            raise SubtitleParseError(f"{source_name} 第 {block_number} 块结束时间早于开始时间")

        raw_text = _strip_markup("\n".join(lines[time_line_index + 1 :]))
        raw_fields = _key_values(raw_text)
        _parse_old_gps(raw_text, raw_fields)
        values, field_sources = _sample_values(raw_fields, "srt")
        cue_label = f"{source_name} 第 {cue_index if cue_index is not None else block_number} 条"
        _validate_coordinates(values, cue_label)
        if values.get("latitude") is not None and values.get("longitude") is not None:
            values["position_crs"] = "EPSG:4326"
            field_sources["position_crs"] = "DJI geographic GPS convention (horizontal only)"

        frame_match = _FRAME_RE.search(raw_text)
        frame_index = int(frame_match.group(1)) if frame_match else None
        if frame_index is not None:
            field_sources["frame_index"] = "srt.FrameCnt"
        diff_match = _DIFF_RE.search(raw_text)
        frame_delta_ms = _finite_float(diff_match.group(1)) if diff_match else None
        if frame_delta_ms is not None:
            field_sources["frame_delta_ms"] = "srt.DiffTime"
        datetime_match = _DATETIME_RE.search(raw_text)
        recorded_at = None
        if datetime_match:
            recorded_at = datetime_match.group(1).replace(",", ".").replace(" ", "T", 1)
            field_sources["recorded_at"] = "srt.datetime (timezone not present)"
        field_sources["start_time_ms"] = "srt.timecode.start"
        field_sources["end_time_ms"] = "srt.timecode.end"
        video_sample_index = len(samples)
        field_sources["video_sample_index"] = "parser.source_order (not FrameCnt)"
        missing = tuple(name for name in TELEMETRY_VALUE_FIELDS if values.get(name) is None)
        samples.append(
            TelemetrySample(
                source_kind=source_kind,
                source_name=source_name,
                cue_index=cue_index,
                stream_index=stream_index,
                video_sample_index=video_sample_index,
                start_time_ms=start_ms,
                end_time_ms=end_ms,
                frame_index=frame_index,
                frame_delta_ms=frame_delta_ms,
                recorded_at=recorded_at,
                extra_fields=raw_fields,
                raw_text=raw_text or None,
                field_sources=field_sources,
                missing_fields=missing,
                **values,
            )
        )
    if malformed_timecode:
        raise SubtitleParseError(f"{source_name} 包含无效的 SRT 时间码")
    if not samples:
        raise SubtitleParseError(f"{source_name} 中没有可解析的 SRT 条目")
    return samples


def _decode_text_bytes(data: bytes, source_name: str) -> str:
    for encoding in ("utf-8-sig", "utf-16", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise SubtitleParseError(f"无法识别字幕编码：{source_name}")


def _load_json_document(value: str | Path | Mapping[str, Any]) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    path = Path(value).expanduser()
    if not path.is_file():
        raise FFprobeExecutionError(f"ffprobe JSON 文件不存在：{path}")
    try:
        decoded = json.loads(path.read_text(encoding="utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise FFprobeExecutionError(f"ffprobe JSON 文件无效：{path}") from exc
    if not isinstance(decoded, dict):
        raise FFprobeExecutionError("ffprobe JSON 顶层必须是对象")
    return decoded


def parse_ffprobe_telemetry(document: Mapping[str, Any]) -> list[TelemetrySample]:
    """Read telemetry tags from ``frames``/``packets`` in supplied ffprobe JSON.

    ffprobe normally does not decode DJI proprietary ``djmd`` payloads.  This
    function only emits values exposed as named tags or side-data fields; it
    does not decode unknown binary blobs or synthesize missing telemetry.
    """

    samples: list[TelemetrySample] = []
    for collection_name in ("frames", "packets"):
        collection = document.get(collection_name)
        if not isinstance(collection, Sequence) or isinstance(collection, (str, bytes)):
            continue
        for item_index, item in enumerate(collection):
            if not isinstance(item, Mapping):
                continue
            raw: dict[str, Any] = {}
            raw_sources: dict[str, str] = {}
            containers: list[tuple[str, Mapping[str, Any]]] = []
            tags = item.get("tags")
            if isinstance(tags, Mapping):
                containers.append(("tags", tags))
            side_data = item.get("side_data_list")
            if isinstance(side_data, Sequence) and not isinstance(side_data, (str, bytes)):
                for side_index, side_item in enumerate(side_data):
                    if isinstance(side_item, Mapping):
                        containers.append((f"side_data_list[{side_index}]", side_item))
            for container_name, container in containers:
                for key, raw_value in container.items():
                    normalized_key = _normalise_key(str(key))
                    if normalized_key and normalized_key not in raw:
                        raw[normalized_key] = raw_value
                        raw_sources[normalized_key] = (
                            f"ffprobe.{collection_name}[{item_index}].{container_name}.{key}"
                        )
            values, field_sources = _sample_values(raw, f"ffprobe.{collection_name}[{item_index}]")
            for field_name, aliases in _FIELD_ALIASES.items():
                key, _ = _first_raw(raw, aliases)
                if key is not None and field_name in values:
                    suffix = (
                        " (DJI 35mm equivalent)"
                        if field_name == "focal_length_35mm_equivalent_mm"
                        else ""
                    )
                    field_sources[field_name] = f"{raw_sources[key]}{suffix}"
            if not values:
                continue
            _validate_coordinates(values, f"ffprobe {collection_name}[{item_index}]")
            if values.get("latitude") is not None and values.get("longitude") is not None:
                values["position_crs"] = "EPSG:4326"
                field_sources["position_crs"] = "GPS latitude/longitude convention (horizontal only)"
            timestamp_candidates = (
                _finite_float(item.get("best_effort_timestamp_time")),
                _finite_float(item.get("pts_time")),
                _finite_float(item.get("pkt_pts_time")),
            )
            timestamp_s = next((value for value in timestamp_candidates if value is not None), None)
            duration_candidates = (
                _finite_float(item.get("duration_time")),
                _finite_float(item.get("pkt_duration_time")),
            )
            duration_s = next((value for value in duration_candidates if value is not None), None)
            start_ms = round(timestamp_s * 1000) if timestamp_s is not None else None
            end_ms = (
                round((timestamp_s + duration_s) * 1000)
                if timestamp_s is not None and duration_s is not None
                else None
            )
            frame_index = _finite_int(item.get("coded_picture_number"))
            if start_ms is not None:
                field_sources["start_time_ms"] = f"ffprobe.{collection_name}[{item_index}].timestamp_time"
            if frame_index is not None:
                field_sources["frame_index"] = f"ffprobe.{collection_name}[{item_index}].coded_picture_number"
            field_sources["video_sample_index"] = (
                f"ffprobe.{collection_name} source order (not coded_picture_number)"
            )
            samples.append(
                TelemetrySample(
                    source_kind="ffprobe_tags",
                    source_name=f"ffprobe.{collection_name}",
                    stream_index=_finite_int(item.get("stream_index")),
                    video_sample_index=item_index,
                    start_time_ms=start_ms,
                    end_time_ms=end_ms,
                    frame_index=frame_index,
                    extra_fields=raw,
                    field_sources=field_sources,
                    missing_fields=tuple(name for name in TELEMETRY_VALUE_FIELDS if values.get(name) is None),
                    **values,
                )
            )
    return samples


def _subtitle_streams(document: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    streams = document.get("streams")
    if not isinstance(streams, Sequence) or isinstance(streams, (str, bytes)):
        return []
    return [item for item in streams if isinstance(item, Mapping) and item.get("codec_type") == "subtitle"]


def _proprietary_metadata_stream_indexes(document: Mapping[str, Any]) -> list[int]:
    streams = document.get("streams")
    if not isinstance(streams, Sequence) or isinstance(streams, (str, bytes)):
        return []
    indexes: list[int] = []
    for item in streams:
        if not isinstance(item, Mapping) or item.get("codec_type") != "data":
            continue
        tags = item.get("tags")
        searchable = " ".join(
            str(value)
            for value in (
                item.get("codec_name"),
                item.get("codec_long_name"),
                item.get("codec_tag_string"),
                *(tags.values() if isinstance(tags, Mapping) else ()),
            )
            if value is not None
        ).casefold()
        if "djmd" in searchable or "dji" in searchable:
            index = _finite_int(item.get("index"))
            if index is not None:
                indexes.append(index)
    return indexes


def _extract_embedded_srt(
    video_path: Path,
    stream: Mapping[str, Any],
    ffmpeg_bin: str | Path,
    *,
    cancel_event: threading.Event | None = None,
    cancel_callback: CancelCallback | None = None,
) -> str:
    executable = _resolve_binary(ffmpeg_bin, "ffmpeg")
    stream_index = _finite_int(stream.get("index"))
    if stream_index is None:
        raise ExtractionError("内嵌字幕流没有有效的 stream index")
    command = [
        executable,
        "-v",
        "error",
        "-i",
        str(video_path),
        "-map",
        f"0:{stream_index}",
        "-f",
        "srt",
        "-fs",
        str(MAX_SRT_BYTES + 1),
        "pipe:1",
    ]
    try:
        completed = _run_cancellable_process(
            command,
            timeout_seconds=300,
            cancel_event=cancel_event,
            cancel_callback=cancel_callback,
        )
    except OSError as exc:
        raise ExtractionError(f"无法启动 ffmpeg：{exc}") from exc
    except subprocess.TimeoutExpired as exc:
        raise ExtractionError("ffmpeg 提取内嵌字幕超过 300 秒") from exc
    if completed.returncode != 0:
        error_text = completed.stderr.decode("utf-8", errors="replace").strip()
        raise ExtractionError(f"ffmpeg 提取字幕流 {stream_index} 失败：{error_text or '未知错误'}")
    if len(completed.stdout) > MAX_SRT_BYTES:
        raise ExtractionError(f"ffmpeg 提取字幕流 {stream_index} 超过 64 MB，已停止读取；请先按视频分段")
    return _decode_text_bytes(completed.stdout, f"embedded stream {stream_index}")


def _discover_sidecars(video_path: Path) -> list[Path]:
    matches: list[Path] = []
    try:
        for candidate in video_path.parent.iterdir():
            if (
                candidate.is_file()
                and candidate.stem.casefold() == video_path.stem.casefold()
                and candidate.suffix.casefold() == ".srt"
            ):
                matches.append(candidate)
    except OSError:
        return []
    return sorted(matches, key=lambda item: item.name.casefold())


def _normalize_srt_paths(srt_path: str | Path | Sequence[str | Path] | None, video_path: Path) -> list[Path]:
    if srt_path is None:
        return _discover_sidecars(video_path)
    raw_paths: Sequence[str | Path]
    if isinstance(srt_path, (str, Path)):
        raw_paths = [srt_path]
    else:
        raw_paths = srt_path
    result: list[Path] = []
    for item in raw_paths:
        path = Path(item).expanduser()
        if not path.is_file():
            raise SubtitleParseError(f"字幕文件不存在：{path}")
        result.append(path.resolve())
    return result


def extract_dji_video(
    video_path: str | Path,
    *,
    srt_path: str | Path | Sequence[str | Path] | None = None,
    ffprobe_json: str | Path | Mapping[str, Any] | None = None,
    ffprobe_bin: str | Path = "ffprobe",
    ffmpeg_bin: str | Path = "ffmpeg",
    extract_embedded_subtitles: bool = True,
    cancel_event: threading.Event | None = None,
    cancel_callback: CancelCallback | None = None,
) -> ExtractionResult:
    """Extract all verifiable metadata/telemetry available to this module.

    A supplied ``ffprobe_json`` is used verbatim as the probe source.  Otherwise
    ffprobe is attempted first and OpenCV is used as a documented fallback.
    Sidecar SRT has priority over embedded subtitles to avoid duplicate samples.
    """

    _check_cancellation(cancel_event, cancel_callback)
    source = Path(video_path).expanduser()
    if not source.is_file():
        raise VideoOpenError(f"视频文件不存在：{source}")
    source = source.resolve()
    warnings: list[str] = []

    probe_document: Optional[dict[str, Any]] = None
    if ffprobe_json is not None:
        probe_document = _load_json_document(ffprobe_json)
        video = parse_ffprobe_document(probe_document)
    else:
        try:
            probe_document = probe_video(
                source,
                ffprobe_bin=ffprobe_bin,
                cancel_event=cancel_event,
                cancel_callback=cancel_callback,
            )
            video = parse_ffprobe_document(probe_document)
        except (FFprobeNotFoundError, FFprobeExecutionError) as exc:
            warnings.append(
                f"{exc} 已使用 OpenCV 回退；编解码器、音轨、字幕流、旋转及容器标签可能缺失。"
            )
            video = _opencv_video_metadata(source)

    telemetry: list[TelemetrySample] = []
    subtitle_sources: list[Mapping[str, Any]] = []
    if probe_document is not None:
        telemetry.extend(parse_ffprobe_telemetry(probe_document))
        proprietary_indexes = _proprietary_metadata_stream_indexes(probe_document)
        if proprietary_indexes:
            warnings.append(
                "检测到 DJI 专有二进制定时元数据流 "
                f"{proprietary_indexes}；已保留流描述，但未把未知二进制内容伪装成遥测字段。"
            )

    sidecars = _normalize_srt_paths(srt_path, source)
    for subtitle_path in sidecars:
        _check_cancellation(cancel_event, cancel_callback)
        try:
            if subtitle_path.stat().st_size > MAX_SRT_BYTES:
                raise SubtitleParseError(f"字幕文件超过 64 MB，已停止读取；请先按视频分段：{subtitle_path}")
            subtitle_bytes = subtitle_path.read_bytes()
        except OSError as exc:
            raise SubtitleParseError(f"无法读取字幕文件 {subtitle_path}：{exc}") from exc
        subtitle_text = _decode_text_bytes(subtitle_bytes, str(subtitle_path))
        parsed = parse_dji_srt(
            subtitle_text,
            source_name=str(subtitle_path),
            source_kind="sidecar_srt",
        )
        _check_cancellation(cancel_event, cancel_callback)
        telemetry.extend(parsed)
        subtitle_sources.append(
            {
                "kind": "sidecar_srt",
                "name": str(subtitle_path),
                "sample_count": len(parsed),
            }
        )

    if not sidecars and extract_embedded_subtitles and probe_document is not None:
        streams = _subtitle_streams(probe_document)
        embedded_candidates: list[tuple[list[TelemetrySample], Mapping[str, Any], Optional[int]]] = []
        for stream in streams:
            _check_cancellation(cancel_event, cancel_callback)
            stream_index = _finite_int(stream.get("index"))
            try:
                subtitle_text = _extract_embedded_srt(
                    source,
                    stream,
                    ffmpeg_bin,
                    cancel_event=cancel_event,
                    cancel_callback=cancel_callback,
                )
                parsed = parse_dji_srt(
                    subtitle_text,
                    source_name=f"{source.name}:subtitle:{stream_index}",
                    stream_index=stream_index,
                    source_kind="embedded_srt",
                )
            except ExtractionCancelled:
                raise
            except FFmpegNotFoundError as exc:
                warnings.append(str(exc))
                break
            except ExtractionError as exc:
                warnings.append(str(exc))
                continue
            # A movie dialogue stream is valid SRT syntax too.  It must never
            # be mixed into the flight timeline merely because it is timed.
            has_dji_fields = any(
                (sample.latitude is not None and sample.longitude is not None)
                or sample.gimbal_pitch_deg is not None
                or sample.relative_altitude_m is not None
                or sample.absolute_altitude_m is not None
                for sample in parsed
            )
            if not has_dji_fields:
                warnings.append(
                    f"字幕流 {stream_index} 可读取，但不含 DJI 遥测字段；已按普通字幕忽略。"
                )
                continue
            embedded_candidates.append((parsed, stream, stream_index))

        if len(embedded_candidates) == 1:
            parsed, stream, stream_index = embedded_candidates[0]
            telemetry.extend(parsed)
            subtitle_sources.append(
                {
                    "kind": "embedded_srt",
                    "name": f"{source.name}:subtitle:{stream_index}",
                    "stream_index": stream_index,
                    "codec_name": stream.get("codec_name"),
                    "sample_count": len(parsed),
                }
            )
        elif len(embedded_candidates) > 1:
            warnings.append(
                "检测到多个包含 DJI 遥测字段的内嵌字幕流；为防止混合不同时轴，"
                "未自动选择。请先运行“提取大疆视频SRT.cmd”并按 stream index 确认。"
            )

    if not subtitle_sources:
        if probe_document is None:
            warnings.append(
                "未发现同名 SRT；OpenCV 无法枚举内嵌字幕。请提供 sidecar SRT 或安装 FFmpeg 工具链。"
            )
        elif not _subtitle_streams(probe_document):
            warnings.append("未发现同名 SRT 或可识别的内嵌字幕流。")

    telemetry.sort(
        key=lambda sample: (
            sample.start_time_ms is None,
            sample.start_time_ms if sample.start_time_ms is not None else 0,
            sample.frame_index if sample.frame_index is not None else -1,
            sample.source_kind,
        )
    )
    return ExtractionResult(
        source_file=str(source),
        video=video,
        telemetry=tuple(telemetry),
        subtitle_sources=tuple(subtitle_sources),
        warnings=tuple(warnings),
    )


def write_extraction_json(result: ExtractionResult, output_path: str | Path) -> Path:
    """Atomically write a UTF-8, human-readable extraction artifact."""

    destination = Path(output_path).expanduser()
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(result.to_dict(), ensure_ascii=False, indent=2)
    temporary_name: Optional[str] = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=destination.parent,
            prefix=f".{destination.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary_name = handle.name
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, destination)
        temporary_name = None
    except OSError as exc:
        raise ExtractionError(f"无法原子写入提取结果 {destination}：{exc}") from exc
    finally:
        if temporary_name is not None:
            try:
                Path(temporary_name).unlink()
            except FileNotFoundError:
                pass
    return destination.resolve()


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="提取 DJI 航拍视频元数据和逐帧 SRT 遥测")
    parser.add_argument("video", type=Path, help="DJI MP4/MOV 文件")
    parser.add_argument("-s", "--srt", type=Path, action="append", help="sidecar SRT，可重复指定")
    parser.add_argument("--ffprobe-json", type=Path, help="预先生成的 ffprobe JSON")
    parser.add_argument("--ffprobe", default="ffprobe", help="ffprobe 路径")
    parser.add_argument("--ffmpeg", default="ffmpeg", help="ffmpeg 路径")
    parser.add_argument("--no-embedded-subtitles", action="store_true", help="不读取内嵌字幕流")
    parser.add_argument("-o", "--output", type=Path, required=True, help="输出 JSON 文件")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_argument_parser().parse_args(argv)
    try:
        result = extract_dji_video(
            args.video,
            srt_path=args.srt,
            ffprobe_json=args.ffprobe_json,
            ffprobe_bin=args.ffprobe,
            ffmpeg_bin=args.ffmpeg,
            extract_embedded_subtitles=not args.no_embedded_subtitles,
        )
        destination = write_extraction_json(result, args.output)
    except ExtractionError as exc:
        raise SystemExit(f"提取失败：{exc}") from exc
    print(f"已提取 {len(result.telemetry)} 条遥测：{destination}")
    for warning in result.warnings:
        print(f"警告：{warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
