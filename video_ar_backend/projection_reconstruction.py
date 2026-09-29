#!/usr/bin/env python3
"""Optional offline SfM/MVS reconstruction for Cesium video AR.

The lightweight DJI telemetry extractor imports this module lazily.  COLMAP is
run as an external process so a native crash or an out-of-memory error cannot
take the Tk application down with it.  No projection mesh is published unless
the complete video binding, WGS84 ellipsoid-height reference, georeferencing,
and first-visible-surface mesh checks all succeed.
"""
from __future__ import annotations

import bisect
import hashlib
import importlib.util
import json
import math
import os
import queue
import shutil
import signal
import sqlite3
import struct
import subprocess
import tempfile
import threading
import time
import traceback
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence


SERVICE_ROOT = Path(__file__).resolve().parent
HEIGHT_MODES = (
    "unconfirmed",
    "absolute_is_wgs84_ellipsoid",
    "orthometric_plus_geoid_offset",
    "relative_plus_takeoff_ellipsoid",
)
MAX_MESH_FRAMES = 10_000
# The frontend accepts up to two million items, but keeping that many Python
# float/int objects in the GUI process can exceed practical desktop memory.
# These producer-side caps stay below the browser contract and the 60MB JSON cap.
MAX_TOTAL_VERTICES = 500_000
MAX_TOTAL_TRIANGLES = 750_000
MAX_JSON_BYTES = 60 * 1024 * 1024
MAX_FRAME_VERTICES = 4_096
MAX_FRAME_TRIANGLES = 8_192
MAX_MESH_EDGE_METERS = 50_000.0
EARTH_RADIUS_METERS = 6_378_137.0
MAX_FRAME_GAP_MS = 100
MAX_ENDPOINT_DELTA_MS = 50
_COLMAP_PROBE_CACHE: dict[tuple[str, int, int], dict[str, Any]] = {}
COLMAP_LOCAL_WORKSPACE_DIRECTORY = "_AR_reconstruction_workspaces"
COLMAP_VOLUME_WORKSPACE_DIRECTORY = "CesiumARWorkspaces"
COLMAP_WORKSPACE_MARKER = "workspace_manifest.json"
COLMAP_MAX_IMAGE_ID = 2 ** 31 - 1


class ProjectionError(RuntimeError):
    """A user-actionable failure that prevents an accurate mesh export."""


class ProjectionCancelled(ProjectionError):
    """Raised when the user cancels a reconstruction."""


ProgressCallback = Callable[[str, str, float | None], None]


@dataclass(frozen=True)
class ProjectionOptions:
    enabled: bool = False
    colmap_bin: str = "colmap"
    mesh_fps: float = 12.0
    max_image_dimension: int = 1280
    grid_columns: int = 20
    grid_rows: int = 12
    height_mode: str = "unconfirmed"
    height_offset_m: float = 0.0

    def validate(self) -> None:
        if self.height_mode not in HEIGHT_MODES:
            raise ValueError(f"不支持的高程基准模式：{self.height_mode}")
        if not math.isfinite(self.mesh_fps) or not 10 <= self.mesh_fps <= 30:
            raise ValueError("三维网格采样率必须为 10–30 FPS，才能满足 Cesium 的 50ms 同帧绑定")
        if not 640 <= self.max_image_dimension <= 4096:
            raise ValueError("重建图像最长边必须为 640–4096 像素")
        if not 4 <= self.grid_columns <= 64 or not 3 <= self.grid_rows <= 36:
            raise ValueError("网格列数/行数超出安全范围")
        if not math.isfinite(self.height_offset_m) or abs(self.height_offset_m) > 20_000:
            raise ValueError("高程修正值超出安全范围")


@dataclass(frozen=True)
class ProjectionOutcome:
    status: str
    report_path: Path
    mesh_path: Path | None = None
    workspace: Path | None = None
    workspace_parent: Path | None = None
    frame_count: int = 0
    message: str = ""


@dataclass(frozen=True)
class ColmapCamera:
    camera_id: int
    model: str
    width: int
    height: int
    params: tuple[float, ...]


@dataclass(frozen=True)
class ColmapImage:
    image_id: int
    camera_id: int
    name: str
    rotation_world_to_camera: Any
    translation_world_to_camera: Any


def _emit(callback: ProgressCallback | None, stage: str, message: str, fraction: float | None = None) -> None:
    if callback is not None:
        callback(stage, message, fraction)


def _cancelled(cancel_event: threading.Event | None) -> bool:
    return cancel_event is not None and cancel_event.is_set()


def _check_cancelled(cancel_event: threading.Event | None) -> None:
    if _cancelled(cancel_event):
        raise ProjectionCancelled("用户已取消三维重建")


def _atomic_json(destination: Path, document: Mapping[str, Any]) -> Path:
    destination = destination.expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.stem}-",
        suffix=f"{destination.suffix}.tmp",
        dir=destination.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(document, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return destination


def find_colmap_executable(requested: str | os.PathLike[str] | None = None) -> Path | None:
    candidates: list[str | os.PathLike[str]] = []
    if requested and str(requested).strip():
        requested_text = os.fspath(requested).strip().strip('"')
        requested_path = Path(requested_text).expanduser()
        is_explicit_path = (
            requested_path.is_absolute()
            or "/" in requested_text
            or "\\" in requested_text
            or requested_path.suffix.casefold() in {".exe", ".bat", ".cmd"}
        )
        if is_explicit_path:
            if not requested_path.is_file():
                return None
            resolved = requested_path.resolve()
            if resolved.suffix.casefold() in {".bat", ".cmd"}:
                native = resolved.parent / "bin" / "colmap.exe"
                if native.is_file():
                    return native.resolve()
            return resolved
        candidates.append(requested_text)
    environment = os.environ.get("DJI_COLMAP_EXE", "").strip()
    if environment:
        candidates.append(environment)
    candidates.extend((
        SERVICE_ROOT / "tools" / "COLMAP" / "bin" / "colmap.exe",
        SERVICE_ROOT / "tools" / "COLMAP" / "COLMAP.bat",
        SERVICE_ROOT / "tools" / "COLMAP.bat",
        SERVICE_ROOT / "tools" / "colmap" / "bin" / "colmap.exe",
        "colmap",
    ))
    seen: set[str] = set()
    for candidate in candidates:
        text = os.fspath(candidate).strip().strip('"')
        if not text or text.casefold() in seen:
            continue
        seen.add(text.casefold())
        path = Path(text).expanduser()
        if path.is_file():
            resolved = path.resolve()
            if resolved.suffix.casefold() in {".bat", ".cmd"}:
                native = resolved.parent / "bin" / "colmap.exe"
                if native.is_file():
                    return native.resolve()
            return resolved
        located = shutil.which(text)
        if located and Path(located).is_file():
            return Path(located).resolve()
    return None


def projection_capabilities(options: ProjectionOptions | None = None) -> dict[str, Any]:
    selected = options or ProjectionOptions()
    colmap = find_colmap_executable(selected.colmap_bin)
    numpy_available = importlib.util.find_spec("numpy") is not None
    opencv_available = importlib.util.find_spec("cv2") is not None
    height_confirmed = selected.height_mode != "unconfirmed"
    runtime_probe: dict[str, Any] = {"ok": False, "version": None, "cuda": False, "error": None}
    if colmap is not None:
        try:
            stat = colmap.stat()
            cache_key = (str(colmap), stat.st_mtime_ns, stat.st_size)
            cached = _COLMAP_PROBE_CACHE.get(cache_key)
            if cached is None:
                creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
                completed = subprocess.run(
                    _colmap_command(colmap, ["-h"]),
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    creationflags=creation_flags,
                    timeout=15,
                    check=False,
                )
                output = completed.stdout or ""
                required_commands = (
                    "feature_extractor", "sequential_matcher", "mapper",
                    "image_undistorter", "patch_match_stereo", "model_converter",
                )
                first_line = next((line.strip() for line in output.splitlines() if line.strip()), None)
                cached = {
                    "ok": completed.returncode == 0 and all(command in output for command in required_commands),
                    "version": first_line,
                    "cuda": "with CUDA" in output,
                    "error": None if completed.returncode == 0 else f"帮助命令退出码 {completed.returncode}",
                }
                _COLMAP_PROBE_CACHE.clear()
                _COLMAP_PROBE_CACHE[cache_key] = cached
            runtime_probe = dict(cached)
        except (OSError, subprocess.SubprocessError) as exc:
            runtime_probe = {"ok": False, "version": None, "cuda": False, "error": str(exc)}
    missing: list[str] = []
    if colmap is None:
        missing.append("COLMAP 摄影测量引擎")
    elif not runtime_probe["ok"]:
        missing.append("可运行且包含 SfM/MVS 子命令的 COLMAP")
    elif os.name == "nt" and not runtime_probe["cuda"]:
        missing.append("支持 CUDA MVS 的 COLMAP")
    if not numpy_available:
        missing.append("NumPy")
    if not opencv_available:
        missing.append("OpenCV")
    if not height_confirmed:
        missing.append("WGS84 椭球高基准确认")
    return {
        "ready": not missing,
        "colmap_executable": str(colmap) if colmap else None,
        "numpy_available": numpy_available,
        "opencv_available": opencv_available,
        "height_reference_confirmed": height_confirmed,
        "height_mode": selected.height_mode,
        "colmap_runtime": runtime_probe,
        "missing": missing,
    }


def ellipsoid_height(sample: Mapping[str, Any], options: ProjectionOptions) -> float | None:
    """Return a height only when the operator explicitly establishes EPSG:4979."""

    absolute = sample.get("absolute_altitude_m")
    if not isinstance(absolute, (int, float)) or not math.isfinite(float(absolute)):
        absolute = sample.get("gps_altitude_m")
    relative = sample.get("relative_altitude_m")
    if options.height_mode == "absolute_is_wgs84_ellipsoid":
        return float(absolute) if isinstance(absolute, (int, float)) and math.isfinite(float(absolute)) else None
    if options.height_mode == "orthometric_plus_geoid_offset":
        return (
            float(absolute) + options.height_offset_m
            if isinstance(absolute, (int, float)) and math.isfinite(float(absolute))
            else None
        )
    if options.height_mode == "relative_plus_takeoff_ellipsoid":
        return (
            float(relative) + options.height_offset_m
            if isinstance(relative, (int, float)) and math.isfinite(float(relative))
            else None
        )
    return None


def _prepared_samples(samples: Sequence[Mapping[str, Any]], options: ProjectionOptions) -> list[dict[str, Any]]:
    prepared: list[dict[str, Any]] = []
    for fallback_index, sample in enumerate(samples):
        longitude = sample.get("longitude")
        latitude = sample.get("latitude")
        video_time_ms = sample.get("video_time_ms")
        sample_index = sample.get("video_sample_index", fallback_index)
        height = ellipsoid_height(sample, options)
        if not all(isinstance(value, (int, float)) and math.isfinite(float(value)) for value in (
            longitude, latitude, video_time_ms, sample_index,
        )) or height is None:
            continue
        if not -180 <= float(longitude) <= 180 or not -90 <= float(latitude) <= 90:
            continue
        prepared.append({
            **dict(sample),
            "longitude": float(longitude),
            "latitude": float(latitude),
            "ellipsoid_height_m": float(height),
            "video_time_ms": int(round(float(video_time_ms))),
            "video_sample_index": int(sample_index),
        })
    prepared.sort(key=lambda item: (item["video_time_ms"], item["video_sample_index"]))
    return prepared


def select_projection_samples(
    samples: Sequence[Mapping[str, Any]],
    duration_ms: int,
    mesh_fps: float,
) -> list[dict[str, Any]]:
    """Choose exact SRT samples with <=100 ms gaps and both endpoints covered."""

    ordered = sorted((dict(sample) for sample in samples), key=lambda item: int(item["video_time_ms"]))
    if len(ordered) < 2:
        raise ProjectionError("真实表面网格至少需要两个带精确 PTS 的遥测样本")
    times = [int(item["video_time_ms"]) for item in ordered]
    period_ms = 1000.0 / mesh_fps
    targets = [0.0]
    target = period_ms
    while target < duration_ms:
        targets.append(target)
        target += period_ms
    targets.append(float(duration_ms))
    selected: list[dict[str, Any]] = []
    seen_indices: set[int] = set()
    for target_ms in targets:
        insertion = bisect.bisect_left(times, target_ms)
        candidates = [index for index in (insertion - 1, insertion) if 0 <= index < len(ordered)]
        if not candidates:
            continue
        nearest_index = min(candidates, key=lambda index: abs(times[index] - target_ms))
        sample = ordered[nearest_index]
        sample_index = int(sample["video_sample_index"])
        if sample_index in seen_indices:
            continue
        seen_indices.add(sample_index)
        selected.append(sample)
    selected.sort(key=lambda item: int(item["video_time_ms"]))
    # Nearest-neighbour sampling can occasionally produce a 101ms gap on a
    # 29.97/30fps SRT because cue timestamps alternate between 33 and 34ms.
    # Fill such gaps with real intervening SRT samples; never invent a PTS.
    repaired: list[dict[str, Any]] = [selected[0]]
    for right in selected[1:]:
        right_time = int(right["video_time_ms"])
        left_time = int(repaired[-1]["video_time_ms"])
        while right_time - left_time > MAX_FRAME_GAP_MS:
            insertion = bisect.bisect_right(times, left_time + MAX_FRAME_GAP_MS) - 1
            if insertion < 0:
                break
            candidate = ordered[insertion]
            candidate_time = int(candidate["video_time_ms"])
            if candidate_time <= left_time or candidate_time >= right_time:
                break
            repaired.append(candidate)
            left_time = candidate_time
        repaired.append(right)
    selected = repaired
    if len(selected) > MAX_MESH_FRAMES:
        raise ProjectionError(f"网格帧数 {len(selected):,} 超过前端安全上限 {MAX_MESH_FRAMES:,}，请分段处理视频")
    first_time = int(selected[0]["video_time_ms"])
    last_time = int(selected[-1]["video_time_ms"])
    if first_time > MAX_ENDPOINT_DELTA_MS:
        raise ProjectionError(f"首个精确网格距视频起点 {first_time}ms，超过 50ms")
    if duration_ms - last_time > MAX_ENDPOINT_DELTA_MS:
        raise ProjectionError(f"最后精确网格距视频结束 {duration_ms - last_time}ms，超过 50ms")
    gaps = [
        int(right["video_time_ms"]) - int(left["video_time_ms"])
        for left, right in zip(selected, selected[1:])
    ]
    if gaps and max(gaps) > MAX_FRAME_GAP_MS:
        raise ProjectionError(f"遥测 PTS 存在 {max(gaps)}ms 空洞，无法满足逐帧精确投影绑定")
    return selected


def effective_grid(requested_columns: int, requested_rows: int, frame_count: int) -> tuple[int, int]:
    columns = requested_columns
    rows = requested_rows
    while (
        columns * rows * frame_count > MAX_TOTAL_VERTICES
        or 2 * (columns - 1) * (rows - 1) * frame_count > MAX_TOTAL_TRIANGLES
    ):
        if columns >= rows and columns > 4:
            columns -= 1
        elif rows > 3:
            rows -= 1
        else:
            raise ProjectionError("视频过长，最低安全网格仍超过 Cesium 总量限制，请分段处理")
    return columns, rows


def _colmap_command(executable: Path, arguments: Sequence[str]) -> list[str]:
    if executable.suffix.casefold() in {".bat", ".cmd"}:
        command_processor = os.environ.get("ComSpec") or os.environ.get("COMSPEC") or "cmd.exe"
        return [command_processor, "/d", "/c", str(executable), *arguments]
    return [str(executable), *arguments]


def _terminate_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                timeout=10,
                check=False,
            )
        else:
            os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=10)
    except BaseException:
        try:
            if os.name == "nt":
                process.kill()
            else:
                os.killpg(process.pid, signal.SIGKILL)
        except BaseException:
            pass
    finally:
        if process.stdout is not None:
            try:
                process.stdout.close()
            except OSError:
                pass


def _run_command(
    executable: Path,
    arguments: Sequence[str],
    *,
    stage: str,
    log_path: Path,
    progress: ProgressCallback | None,
    cancel_event: threading.Event | None,
) -> None:
    _check_cancelled(cancel_event)
    command = _colmap_command(executable, arguments)
    creation_flags = 0
    if os.name == "nt":
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=creation_flags,
        start_new_session=os.name != "nt",
    )
    lines: queue.Queue[str | None] = queue.Queue()

    def reader() -> None:
        assert process.stdout is not None
        try:
            for line in process.stdout:
                lines.put(line)
        finally:
            lines.put(None)

    reader_thread = threading.Thread(target=reader, name=f"colmap-{stage}-output", daemon=True)
    reader_thread.start()
    log_path.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    last_update = 0.0
    truncated = False
    tail_lines: deque[tuple[str, int]] = deque()
    tail_size = 0
    tail_limit = 256 * 1024
    with log_path.open("a", encoding="utf-8", newline="\n") as log:
        log.write(f"\n[{datetime_now()}] {' '.join(command)}\n")
        while True:
            if _cancelled(cancel_event):
                _terminate_process(process)
                raise ProjectionCancelled("用户已取消三维重建")
            try:
                line = lines.get(timeout=0.2)
            except queue.Empty:
                line = ""
            if line is None:
                break
            if line:
                encoded_size = len(line.encode("utf-8", errors="replace"))
                if written < 5 * 1024 * 1024:
                    log.write(line)
                    written += encoded_size
                else:
                    truncated = True
                    tail_lines.append((line, encoded_size))
                    tail_size += encoded_size
                    while tail_lines and tail_size > tail_limit:
                        _, removed_size = tail_lines.popleft()
                        tail_size -= removed_size
                now = time.monotonic()
                if now - last_update >= 1.0:
                    _emit(progress, stage, line.strip()[-240:] or "处理中……", None)
                    last_update = now
        return_code = process.wait()
        reader_thread.join(timeout=1.0)
        if truncated:
            log.write("\n[日志超过 5MB；省略中间输出，以下保留最后最多 256KB]\n")
            for tail_line, _ in tail_lines:
                log.write(tail_line)
    if return_code != 0:
        raise ProjectionError(f"COLMAP 阶段 {stage} 失败（退出码 {return_code}）；详见 {log_path}")


def datetime_now() -> str:
    from datetime import datetime

    return datetime.now().astimezone().isoformat(timespec="seconds")


def _iter_iso_bmff_boxes(handle: Any, start: int, end: int) -> Iterable[tuple[bytes, int, int]]:
    """Yield validated ISO-BMFF boxes as (type, payload_start, box_end)."""

    cursor = start
    while cursor + 8 <= end:
        handle.seek(cursor)
        header = handle.read(8)
        if len(header) != 8:
            raise ProjectionError("视频容器 box 头不完整，无法验证浏览器显示空间")
        size32, box_type = struct.unpack(">I4s", header)
        header_size = 8
        if size32 == 1:
            extended = handle.read(8)
            if len(extended) != 8:
                raise ProjectionError("视频容器扩展 box 头不完整")
            box_size = struct.unpack(">Q", extended)[0]
            header_size = 16
        elif size32 == 0:
            box_size = end - cursor
        else:
            box_size = size32
        if box_size < header_size or cursor + box_size > end:
            raise ProjectionError("视频容器 box 尺寸越界，无法安全解析显示矩阵")
        box_end = cursor + box_size
        yield box_type, cursor + header_size, box_end
        cursor = box_end
        if size32 == 0:
            break


def _first_iso_bmff_box(
    handle: Any,
    start: int,
    end: int,
    expected_type: bytes,
) -> tuple[int, int] | None:
    for box_type, payload_start, box_end in _iter_iso_bmff_boxes(handle, start, end):
        if box_type == expected_type:
            return payload_start, box_end
    return None


def _track_handler_type(handle: Any, mdia_start: int, mdia_end: int) -> bytes | None:
    hdlr = _first_iso_bmff_box(handle, mdia_start, mdia_end, b"hdlr")
    if hdlr is None or hdlr[0] + 12 > hdlr[1]:
        return None
    handle.seek(hdlr[0] + 8)
    value = handle.read(4)
    return value if len(value) == 4 else None


def _track_rotation_degrees(handle: Any, tkhd_start: int, tkhd_end: int) -> float:
    handle.seek(tkhd_start)
    full_box = handle.read(4)
    if len(full_box) != 4:
        raise ProjectionError("视频轨道 tkhd 不完整，无法验证旋转")
    version = full_box[0]
    if version == 0:
        matrix_offset = tkhd_start + 40
    elif version == 1:
        matrix_offset = tkhd_start + 52
    else:
        raise ProjectionError(f"视频轨道 tkhd 版本 {version} 不受支持")
    if matrix_offset + 36 > tkhd_end:
        raise ProjectionError("视频轨道显示矩阵不完整")
    handle.seek(matrix_offset)
    raw = struct.unpack(">9i", handle.read(36))
    a, b, u, c, d, v, _x, _y, w = raw
    if abs(u) > 1 or abs(v) > 1 or abs(w - (1 << 30)) > 1:
        raise ProjectionError("视频轨道包含无法解释的透视显示矩阵")
    a_f, b_f, c_f, d_f = (value / 65536.0 for value in (a, b, c, d))
    scale_x = math.hypot(a_f, b_f)
    scale_y = math.hypot(c_f, d_f)
    dot = a_f * c_f + b_f * d_f
    determinant = a_f * d_f - b_f * c_f
    if (
        not math.isclose(scale_x, 1.0, abs_tol=1e-4)
        or not math.isclose(scale_y, 1.0, abs_tol=1e-4)
        or abs(dot) > 1e-4
        or not math.isclose(determinant, 1.0, abs_tol=1e-4)
    ):
        raise ProjectionError("视频轨道显示矩阵含缩放、镜像或斜切，不能声明 browser_display 精确网格")
    angle = math.degrees(math.atan2(b_f, a_f)) % 360.0
    nearest = (round(angle / 90.0) * 90.0) % 360.0
    delta = abs(((angle - nearest + 180.0) % 360.0) - 180.0)
    if delta > 0.01:
        raise ProjectionError(f"视频轨道含非直角旋转 {angle:.4f}°，当前版本不支持")
    return nearest


def _verify_sample_descriptions(handle: Any, mdia_start: int, mdia_end: int) -> dict[str, Any]:
    minf = _first_iso_bmff_box(handle, mdia_start, mdia_end, b"minf")
    stbl = _first_iso_bmff_box(handle, *minf, b"stbl") if minf else None
    stsd = _first_iso_bmff_box(handle, *stbl, b"stsd") if stbl else None
    if stsd is None or stsd[0] + 8 > stsd[1]:
        raise ProjectionError("视频轨道缺少可验证的 stsd 样本描述")
    handle.seek(stsd[0] + 4)
    entry_count_bytes = handle.read(4)
    if len(entry_count_bytes) != 4:
        raise ProjectionError("视频轨道 stsd 条目计数不完整")
    entry_count = struct.unpack(">I", entry_count_bytes)[0]
    if not 1 <= entry_count <= 64:
        raise ProjectionError("视频轨道 stsd 条目数量异常")
    entry_cursor = stsd[0] + 8
    sample_entries: list[str] = []
    for _ in range(entry_count):
        entries = _iter_iso_bmff_boxes(handle, entry_cursor, stsd[1])
        try:
            entry_type, entry_payload, entry_end = next(iter(entries))
        except StopIteration as exc:
            raise ProjectionError("视频轨道 stsd 样本描述不完整") from exc
        sample_entries.append(entry_type.decode("latin-1", errors="replace"))
        child_start = entry_payload + 78
        if child_start > entry_end:
            raise ProjectionError("视频样本描述不是可识别的视觉格式")
        for child_type, child_payload, child_end in _iter_iso_bmff_boxes(handle, child_start, entry_end):
            if child_type == b"pasp":
                if child_payload + 8 > child_end:
                    raise ProjectionError("视频 pasp 像素宽高比元数据不完整")
                handle.seek(child_payload)
                horizontal, vertical = struct.unpack(">II", handle.read(8))
                if not horizontal or not vertical or horizontal != vertical:
                    raise ProjectionError("视频使用非方形像素；当前版本不会发布可能拉伸的精确网格")
            elif child_type == b"clap":
                raise ProjectionError("视频含 clean-aperture 隐式裁剪；请先规范化转封装后再生成精确网格")
        entry_cursor = entry_end
    return {"sample_entries": sample_entries, "pixel_aspect_ratio": "1:1", "clean_aperture": "absent"}


def verify_browser_display_metadata(video_path: Path) -> dict[str, Any]:
    """Verify rotation/crop/SAR directly from an MP4/MOV container."""

    file_size = video_path.stat().st_size
    if file_size < 8:
        raise ProjectionError("视频文件过小，无法验证浏览器显示空间")
    tracks: list[dict[str, Any]] = []
    with video_path.open("rb") as handle:
        moov = _first_iso_bmff_box(handle, 0, file_size, b"moov")
        if moov is None:
            raise ProjectionError("视频不是可验证的 MP4/MOV，找不到 moov 容器")
        for box_type, trak_start, trak_end in _iter_iso_bmff_boxes(handle, *moov):
            if box_type != b"trak":
                continue
            mdia = _first_iso_bmff_box(handle, trak_start, trak_end, b"mdia")
            if mdia is None or _track_handler_type(handle, *mdia) != b"vide":
                continue
            tkhd = _first_iso_bmff_box(handle, trak_start, trak_end, b"tkhd")
            if tkhd is None:
                raise ProjectionError("视频轨道缺少 tkhd 显示矩阵")
            tracks.append({
                "rotation_degrees": _track_rotation_degrees(handle, *tkhd),
                **_verify_sample_descriptions(handle, *mdia),
            })
    if not tracks:
        raise ProjectionError("MP4/MOV 中没有可验证的视频轨道")
    rotations = {track["rotation_degrees"] for track in tracks}
    if len(rotations) != 1:
        raise ProjectionError("多个视频轨道的显示旋转不一致")
    return {
        "verified": True,
        "method": "iso_bmff_tkhd_stsd",
        "rotation_degrees": tracks[0]["rotation_degrees"],
        "video_track_count": len(tracks),
        "tracks": tracks,
    }


def _write_jpeg_unicode_atomic(
    image_path: Path,
    image: Any,
    cv2_module: Any,
    *,
    quality: int = 92,
) -> None:
    """Encode a JPEG in memory and publish it through Windows wide-path I/O.

    ``cv2.imwrite`` delegates the filename to OpenCV's narrow C runtime on
    several Windows builds and returns ``False`` for otherwise writable paths
    containing Chinese characters.  ``imencode`` avoids passing the path into
    OpenCV; Python's ``Path``/``os.replace`` then use Unicode-safe Win32 APIs.
    A temporary sibling prevents COLMAP from ever seeing a partial JPEG.
    """

    destination = image_path.expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        encoded_ok, encoded = cv2_module.imencode(
            ".jpg",
            image,
            [int(cv2_module.IMWRITE_JPEG_QUALITY), int(quality)],
        )
    except Exception as exc:
        raise ProjectionError(f"无法编码重建帧 JPEG：{destination}（{exc}）") from exc
    if not encoded_ok or encoded is None or int(getattr(encoded, "size", 0)) <= 0:
        raise ProjectionError(f"无法编码重建帧 JPEG：{destination}")

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.stem}-",
        suffix=".jpg.tmp",
        dir=destination.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            # numpy.ndarray exposes the buffer protocol, avoiding a second
            # full encoded-byte copy for every reconstruction frame.
            handle.write(memoryview(encoded))
            handle.flush()
        os.replace(temporary, destination)
    except OSError as exc:
        raise ProjectionError(f"无法写入重建帧：{destination}（{exc}）") from exc
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _extract_frames(
    video_path: Path,
    selected: Sequence[Mapping[str, Any]],
    images_directory: Path,
    max_dimension: int,
    progress: ProgressCallback | None,
    cancel_event: threading.Event | None,
) -> tuple[list[dict[str, Any]], int, int]:
    try:
        import cv2
    except ImportError as exc:
        raise ProjectionError("缺少 OpenCV，无法解码重建帧") from exc

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise ProjectionError("OpenCV 无法打开视频，不能提取摄影测量帧")
    try:
        if not hasattr(cv2, "CAP_PROP_ORIENTATION_META"):
            raise ProjectionError("当前 OpenCV 无法验证视频旋转元数据，不能声明 browser_display 精确网格")
        orientation_meta = float(capture.get(cv2.CAP_PROP_ORIENTATION_META))
        if not math.isfinite(orientation_meta):
            raise ProjectionError("无法读取视频旋转元数据，不能声明 browser_display 精确网格")
        normalized_orientation = orientation_meta % 360.0
        if not math.isclose(normalized_orientation, 0.0, abs_tol=0.01):
            raise ProjectionError(
                f"OpenCV 检测到视频旋转 {orientation_meta:g}°；请先无损规范化像素方向后再生成精确网格"
            )
        if hasattr(cv2, "CAP_PROP_ORIENTATION_AUTO"):
            capture.set(cv2.CAP_PROP_ORIENTATION_AUTO, 1)
        source_fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
        if not math.isfinite(source_fps) or source_fps <= 0:
            raise ProjectionError("视频 FPS 无效，无法进行精确逐帧抽取")
        target_frame_indices = [max(0, round(int(item["video_time_ms"]) * source_fps / 1000)) for item in selected]
        if len(set(target_frame_indices)) != len(target_frame_indices):
            raise ProjectionError("网格采样率高于视频可区分帧率；请降低网格 FPS 后重试")
        images_directory.mkdir(parents=True, exist_ok=True)
        manifest: list[dict[str, Any]] = []
        source_index = -1
        target_index = 0
        decoded_width = decoded_height = 0
        last_frame = None
        while target_index < len(selected):
            _check_cancelled(cancel_event)
            ok, frame = capture.read()
            if not ok:
                break
            source_index += 1
            last_frame = frame
            if source_index < target_frame_indices[target_index]:
                continue
            while target_index < len(selected) and source_index >= target_frame_indices[target_index]:
                sample = selected[target_index]
                position_ms = float(capture.get(cv2.CAP_PROP_POS_MSEC) or 0.0)
                position_available = math.isfinite(position_ms) and (source_index == 0 or position_ms > 0)
                decoded_time_ms = position_ms if position_available else source_index / source_fps * 1000.0
                pts_error_ms = abs(decoded_time_ms - int(sample["video_time_ms"]))
                maximum_pts_error_ms = min(45.0, max(20.0, 1.1 * 1000.0 / source_fps))
                if pts_error_ms > maximum_pts_error_ms:
                    raise ProjectionError(
                        f"视频帧与 SRT PTS 在 {sample['video_time_ms']}ms 处相差 {pts_error_ms:.1f}ms；"
                        "视频可能是变帧率、被转码或与 SRT 不同源"
                    )
                height, width = frame.shape[:2]
                decoded_width, decoded_height = width, height
                scale = min(1.0, max_dimension / max(width, height))
                if scale < 1:
                    resized = cv2.resize(
                        frame,
                        (max(2, round(width * scale)), max(2, round(height * scale))),
                        interpolation=cv2.INTER_AREA,
                    )
                else:
                    resized = frame
                file_name = (
                    f"sample_{int(sample['video_sample_index']):07d}_"
                    f"t{int(sample['video_time_ms']):010d}.jpg"
                )
                image_path = images_directory / file_name
                _check_cancelled(cancel_event)
                _write_jpeg_unicode_atomic(image_path, resized, cv2, quality=92)
                manifest.append({
                    **dict(sample),
                    "image_name": file_name,
                    "decoded_frame_index": source_index,
                    "decoded_video_time_ms": round(decoded_time_ms, 3),
                    "video_time_error_ms": round(pts_error_ms, 3),
                    "decoded_time_source": "opencv.CAP_PROP_POS_MSEC" if position_available else "frame_index / fps",
                    "reconstruction_width_px": int(resized.shape[1]),
                    "reconstruction_height_px": int(resized.shape[0]),
                    "browser_width_px": width,
                    "browser_height_px": height,
                })
                target_index += 1
                _emit(
                    progress,
                    "extract_frames",
                    f"抽取重建帧 {target_index}/{len(selected)}",
                    target_index / len(selected),
                )
                if target_index >= len(selected) or source_index < target_frame_indices[target_index]:
                    break
        if target_index < len(selected) and last_frame is not None:
            raise ProjectionError(
                f"视频提前结束，只抽取 {target_index}/{len(selected)} 个绑定帧；请检查视频时长和 SRT 是否同源"
            )
        if not manifest or decoded_width <= 0 or decoded_height <= 0:
            raise ProjectionError("没有成功解码任何摄影测量帧")
        if any(
            item["browser_width_px"] != decoded_width or item["browser_height_px"] != decoded_height
            for item in manifest
        ):
            raise ProjectionError("视频中途分辨率发生变化，不能生成单一显示空间的精确网格")
        return manifest, decoded_width, decoded_height
    finally:
        capture.release()


def _initial_camera_arguments(frame_manifest: Sequence[Mapping[str, Any]]) -> list[str]:
    estimates: list[tuple[float, float, float]] = []
    for frame in frame_manifest:
        intrinsics = frame.get("estimated_intrinsics")
        if not isinstance(intrinsics, Mapping):
            continue
        fx = intrinsics.get("fx_px")
        fy = intrinsics.get("fy_px")
        cx = intrinsics.get("cx_px")
        cy = intrinsics.get("cy_px")
        browser_width = frame.get("browser_width_px")
        browser_height = frame.get("browser_height_px")
        reconstruction_width = frame.get("reconstruction_width_px")
        reconstruction_height = frame.get("reconstruction_height_px")
        values = (fx, fy, cx, cy, browser_width, browser_height, reconstruction_width, reconstruction_height)
        if not all(
            isinstance(value, (int, float))
            and math.isfinite(float(value))
            and float(value) > 0
            for value in values
        ):
            continue
        scale_x = float(reconstruction_width) / float(browser_width)
        scale_y = float(reconstruction_height) / float(browser_height)
        estimates.append((
            (float(fx) * scale_x + float(fy) * scale_y) / 2,
            float(cx) * scale_x,
            float(cy) * scale_y,
        ))
    if not estimates:
        return ["--ImageReader.camera_model", "SIMPLE_RADIAL", "--ImageReader.single_camera", "1"]
    focal_values = [item[0] for item in estimates]
    focal = sum(focal_values) / len(focal_values)
    if max(focal_values) - min(focal_values) > max(0.5, 0.01 * focal):
        raise ProjectionError(
            "视频期间 DJI 焦距或数字变焦发生变化；当前重建不能用单一相机模型表示。"
            "请按恒定焦段拆分视频后分别提取，避免产生呼吸式定位漂移"
        )
    principal_x = sum(item[1] for item in estimates) / len(estimates)
    principal_y = sum(item[2] for item in estimates) / len(estimates)
    return [
        "--ImageReader.camera_model", "SIMPLE_RADIAL",
        "--ImageReader.single_camera", "1",
        "--ImageReader.camera_params", f"{focal:.9f},{principal_x:.9f},{principal_y:.9f},0",
    ]


def _validate_colmap_feature_database(database_path: Path, expected_images: int) -> dict[str, int]:
    """Reject COLMAP's false-success when its bitmap reader skipped images."""

    if expected_images <= 0:
        raise ProjectionError("COLMAP 特征提取没有待处理帧")
    if not database_path.is_file():
        raise ProjectionError(f"COLMAP 特征数据库未生成：{database_path}")
    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(f"{database_path.resolve().as_uri()}?mode=ro", uri=True)
        counts = {
            "cameras": int(connection.execute("SELECT COUNT(*) FROM cameras").fetchone()[0]),
            "images": int(connection.execute("SELECT COUNT(*) FROM images").fetchone()[0]),
            "images_with_keypoints": int(
                connection.execute("SELECT COUNT(*) FROM keypoints WHERE rows > 0").fetchone()[0]
            ),
            "images_with_descriptors": int(
                connection.execute("SELECT COUNT(*) FROM descriptors WHERE rows > 0").fetchone()[0]
            ),
        }
    except sqlite3.Error as exc:
        raise ProjectionError(f"无法校验 COLMAP 特征数据库：{database_path}（{exc}）") from exc
    finally:
        if connection is not None:
            connection.close()

    if counts["images"] == 0:
        raise ProjectionError(
            "COLMAP 未能读取任何重建帧。Windows 版 COLMAP 不支持含中文的完整图片路径；"
            f"当前工作区为 {database_path.parent}。程序必须使用纯 ASCII 工作区后再重试"
        )
    if counts["images"] != expected_images:
        raise ProjectionError(
            f"COLMAP 只读取了 {counts['images']}/{expected_images} 张重建帧；"
            "为避免视频与网格错帧，已停止不完整重建"
        )
    if counts["cameras"] != 1:
        raise ProjectionError(
            f"COLMAP 特征数据库包含 {counts['cameras']} 个相机，而本次恒定焦段视频应只有 1 个"
        )
    if (
        counts["images_with_keypoints"] != expected_images
        or counts["images_with_descriptors"] != expected_images
    ):
        raise ProjectionError(
            f"COLMAP 仅为 {counts['images_with_keypoints']}/{expected_images} 张图提取到关键点、"
            f"为 {counts['images_with_descriptors']}/{expected_images} 张图提取到描述子；"
            "为避免逐帧网格断裂，已停止不完整重建。视频可能包含模糊、过曝或弱纹理帧"
        )
    return counts


def _validate_colmap_match_database(
    database_path: Path,
    expected_images: int,
) -> dict[str, int]:
    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(f"{database_path.resolve().as_uri()}?mode=ro", uri=True)
        image_ids = {
            int(row[0]) for row in connection.execute("SELECT image_id FROM images").fetchall()
        }
        matched_pair_ids = [
            int(row[0])
            for row in connection.execute("SELECT pair_id FROM matches WHERE rows > 0").fetchall()
        ]
        verified_pair_ids = [
            int(row[0])
            for row in connection.execute(
                "SELECT pair_id FROM two_view_geometries WHERE rows > 0"
            ).fetchall()
        ]
    except sqlite3.Error as exc:
        raise ProjectionError(f"无法校验 COLMAP 匹配数据库：{database_path}（{exc}）") from exc
    finally:
        if connection is not None:
            connection.close()
    if len(image_ids) != expected_images:
        raise ProjectionError(
            f"COLMAP 匹配数据库只有 {len(image_ids)}/{expected_images} 张图，不能继续稀疏建图"
        )
    if not matched_pair_ids or not verified_pair_ids:
        raise ProjectionError(
            "COLMAP 没有得到可用的相邻帧几何匹配；视频可能重叠不足、运动模糊、弱纹理，"
            "或抽样率与飞行速度不匹配"
        )
    adjacency: dict[int, set[int]] = {image_id: set() for image_id in image_ids}
    for pair_id in verified_pair_ids:
        image_id2 = pair_id % COLMAP_MAX_IMAGE_ID
        image_id1 = (pair_id - image_id2) // COLMAP_MAX_IMAGE_ID
        if image_id1 in adjacency and image_id2 in adjacency and image_id1 != image_id2:
            adjacency[image_id1].add(image_id2)
            adjacency[image_id2].add(image_id1)
    isolated = sum(1 for neighbors in adjacency.values() if not neighbors)
    if isolated:
        raise ProjectionError(
            f"COLMAP 几何匹配图中有 {isolated}/{expected_images} 张孤立帧；"
            "为避免逐帧投影中断，已停止稀疏建图"
        )
    unseen = set(image_ids)
    components = 0
    while unseen:
        components += 1
        stack = [unseen.pop()]
        while stack:
            current = stack.pop()
            new_neighbors = adjacency[current] & unseen
            unseen.difference_update(new_neighbors)
            stack.extend(new_neighbors)
    if components != 1:
        raise ProjectionError(
            f"COLMAP 几何匹配被分成 {components} 个不连通航段；"
            "请降低抽样间隔或按连续航段拆分视频"
        )
    counts = {
        "matched_pairs": len(matched_pair_ids),
        "verified_pairs": len(verified_pair_ids),
        "matched_images": len(image_ids),
        "connected_components": components,
    }
    return counts


def _parse_colmap_cameras(path: Path) -> dict[int, ColmapCamera]:
    cameras: dict[int, ColmapCamera] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 5:
            raise ProjectionError(f"COLMAP cameras.txt 行格式错误：{line[:120]}")
        camera_id = int(parts[0])
        cameras[camera_id] = ColmapCamera(
            camera_id=camera_id,
            model=parts[1].upper(),
            width=int(parts[2]),
            height=int(parts[3]),
            params=tuple(float(value) for value in parts[4:]),
        )
    if not cameras:
        raise ProjectionError(f"COLMAP 模型没有相机：{path}")
    return cameras


def _quaternion_rotation(qw: float, qx: float, qy: float, qz: float) -> Any:
    import numpy as np

    norm = math.sqrt(qw * qw + qx * qx + qy * qy + qz * qz)
    if norm <= 1e-12:
        raise ProjectionError("COLMAP 图像姿态包含零四元数")
    qw, qx, qy, qz = (value / norm for value in (qw, qx, qy, qz))
    return np.asarray([
        [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qw * qz), 2 * (qx * qz + qw * qy)],
        [2 * (qx * qy + qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qw * qx)],
        [2 * (qx * qz - qw * qy), 2 * (qy * qz + qw * qx), 1 - 2 * (qx * qx + qy * qy)],
    ], dtype=np.float64)


def _parse_colmap_images(path: Path) -> dict[str, ColmapImage]:
    import numpy as np

    lines = path.read_text(encoding="utf-8").splitlines()
    images: dict[str, ColmapImage] = {}
    line_index = 0
    while line_index < len(lines):
        line = lines[line_index].strip()
        line_index += 1
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 10:
            raise ProjectionError(f"COLMAP images.txt 姿态行格式错误：{line[:120]}")
        image_id = int(parts[0])
        rotation = _quaternion_rotation(*(float(value) for value in parts[1:5]))
        translation = np.asarray([float(value) for value in parts[5:8]], dtype=np.float64)
        camera_id = int(parts[8])
        name = " ".join(parts[9:])
        images[name] = ColmapImage(image_id, camera_id, name, rotation, translation)
        # Each image record has a second line containing POINTS2D.  It may be empty.
        if line_index < len(lines):
            line_index += 1
    if not images:
        raise ProjectionError(f"COLMAP 模型没有已注册图像：{path}")
    return images


def _colmap_reprojection_rmse(path: Path) -> float | None:
    squared: list[float] = []
    if not path.is_file():
        return None
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 8:
            continue
        try:
            error = float(parts[7])
        except ValueError:
            continue
        if math.isfinite(error) and error >= 0:
            squared.append(error * error)
    return math.sqrt(sum(squared) / len(squared)) if squared else None


def _convert_model_to_text(
    executable: Path,
    input_path: Path,
    output_path: Path,
    *,
    stage: str,
    log_path: Path,
    progress: ProgressCallback | None,
    cancel_event: threading.Event | None,
) -> None:
    output_path.mkdir(parents=True, exist_ok=True)
    _run_command(
        executable,
        [
            "model_converter",
            "--input_path", str(input_path),
            "--output_path", str(output_path),
            "--output_type", "TXT",
        ],
        stage=stage,
        log_path=log_path,
        progress=progress,
        cancel_event=cancel_event,
    )


def _run_colmap(
    executable: Path,
    workspace: Path,
    frame_manifest: Sequence[Mapping[str, Any]],
    max_image_dimension: int,
    progress: ProgressCallback | None,
    cancel_event: threading.Event | None,
) -> dict[str, Path]:
    images_path = workspace / "images"
    database_path = workspace / "database.db"
    sparse_path = workspace / "sparse"
    dense_path = workspace / "dense"
    log_path = workspace / "colmap.log"
    sparse_path.mkdir(parents=True, exist_ok=True)
    dense_path.mkdir(parents=True, exist_ok=True)
    worker_threads = max(1, min(8, max(1, (os.cpu_count() or 4) // 2)))

    _emit(progress, "feature_extractor", "COLMAP 正在提取特征……", None)
    _run_command(
        executable,
        [
            "feature_extractor",
            "--database_path", str(database_path),
            "--image_path", str(images_path),
            *_initial_camera_arguments(frame_manifest),
            "--FeatureExtraction.num_threads", str(worker_threads),
            "--FeatureExtraction.max_image_size", str(max_image_dimension),
        ],
        stage="feature_extractor",
        log_path=log_path,
        progress=progress,
        cancel_event=cancel_event,
    )
    feature_counts = _validate_colmap_feature_database(database_path, len(frame_manifest))
    _emit(
        progress,
        "feature_extractor",
        f"COLMAP 已读取 {feature_counts['images']} 张重建帧并写入特征数据库",
        None,
    )
    _run_command(
        executable,
        [
            "sequential_matcher",
            "--database_path", str(database_path),
            "--FeatureMatching.num_threads", str(worker_threads),
            "--SequentialMatching.num_threads", str(worker_threads),
            "--SequentialMatching.overlap", "12",
        ],
        stage="sequential_matcher",
        log_path=log_path,
        progress=progress,
        cancel_event=cancel_event,
    )
    match_counts = _validate_colmap_match_database(database_path, len(frame_manifest))
    _emit(
        progress,
        "sequential_matcher",
        f"COLMAP 已验证 {match_counts['verified_pairs']} 对相邻帧几何匹配",
        None,
    )
    _run_command(
        executable,
        [
            "mapper",
            "--database_path", str(database_path),
            "--image_path", str(images_path),
            "--output_path", str(sparse_path),
            "--Mapper.num_threads", str(worker_threads),
        ],
        stage="sparse_mapper",
        log_path=log_path,
        progress=progress,
        cancel_event=cancel_event,
    )

    models = sorted(
        path for path in sparse_path.iterdir()
        if path.is_dir() and (path / "cameras.bin").is_file()
    )
    if not models:
        raise ProjectionError("COLMAP 没有生成稀疏模型；视频可能缺少重叠、视差或稳定纹理")
    converted: list[tuple[int, Path, Path]] = []
    for model in models:
        text_path = workspace / f"sparse_txt_{model.name}"
        _convert_model_to_text(
            executable,
            model,
            text_path,
            stage=f"convert_sparse_{model.name}",
            log_path=log_path,
            progress=progress,
            cancel_event=cancel_event,
        )
        registered = len(_parse_colmap_images(text_path / "images.txt"))
        converted.append((registered, model, text_path))
    registered_count, best_model, best_text = max(converted, key=lambda item: item[0])
    minimum_registered = len(frame_manifest)
    if registered_count < minimum_registered:
        raise ProjectionError(
            f"COLMAP 只注册 {registered_count}/{len(frame_manifest)} 帧；至少需要 {minimum_registered} 帧，"
            "不能发布不完整的逐帧投影网格"
        )

    _run_command(
        executable,
        [
            "image_undistorter",
            "--image_path", str(images_path),
            "--input_path", str(best_model),
            "--output_path", str(dense_path),
            "--output_type", "COLMAP",
            "--max_image_size", str(max_image_dimension),
        ],
        stage="image_undistorter",
        log_path=log_path,
        progress=progress,
        cancel_event=cancel_event,
    )
    _run_command(
        executable,
        [
            "patch_match_stereo",
            "--workspace_path", str(dense_path),
            "--workspace_format", "COLMAP",
            "--PatchMatchStereo.geom_consistency", "true",
            "--PatchMatchStereo.max_image_size", str(max_image_dimension),
            "--PatchMatchStereo.cache_size", "4",
        ],
        stage="patch_match_stereo",
        log_path=log_path,
        progress=progress,
        cancel_event=cancel_event,
    )
    dense_text = workspace / "dense_sparse_txt"
    _convert_model_to_text(
        executable,
        dense_path / "sparse",
        dense_text,
        stage="convert_dense_model",
        log_path=log_path,
        progress=progress,
        cancel_event=cancel_event,
    )
    return {
        "sparse_model": best_model,
        "sparse_text": best_text,
        "dense": dense_path,
        "dense_text": dense_text,
        "log": log_path,
    }


def read_colmap_depth_map(path: Path) -> Any:
    """Read COLMAP's width&height&channels& + float32 Fortran-order format."""

    import numpy as np

    with path.open("rb") as handle:
        header_values: list[int] = []
        current = bytearray()
        while len(header_values) < 3:
            byte = handle.read(1)
            if not byte:
                raise ProjectionError(f"COLMAP 深度图头不完整：{path}")
            if byte == b"&":
                try:
                    header_values.append(int(current.decode("ascii")))
                except (ValueError, UnicodeDecodeError) as exc:
                    raise ProjectionError(f"COLMAP 深度图头无效：{path}") from exc
                current.clear()
            else:
                current.extend(byte)
                if len(current) > 16:
                    raise ProjectionError(f"COLMAP 深度图头异常：{path}")
        width, height, channels = header_values
        if width <= 0 or height <= 0 or channels not in (1, 3):
            raise ProjectionError(f"COLMAP 深度图尺寸无效：{width}x{height}x{channels}")
        data = np.fromfile(handle, dtype=np.float32, count=width * height * channels)
    if data.size != width * height * channels:
        raise ProjectionError(f"COLMAP 深度图数据被截断：{path}")
    array = data.reshape((width, height, channels), order="F").transpose(1, 0, 2)
    return array[:, :, 0] if channels == 1 else array


WGS84_A = 6_378_137.0
WGS84_F = 1 / 298.257223563
WGS84_E2 = WGS84_F * (2 - WGS84_F)


def geodetic_to_ecef(longitude_deg: float, latitude_deg: float, height_m: float) -> Any:
    import numpy as np

    longitude = math.radians(longitude_deg)
    latitude = math.radians(latitude_deg)
    sin_latitude = math.sin(latitude)
    cos_latitude = math.cos(latitude)
    prime_vertical = WGS84_A / math.sqrt(1 - WGS84_E2 * sin_latitude * sin_latitude)
    return np.asarray([
        (prime_vertical + height_m) * cos_latitude * math.cos(longitude),
        (prime_vertical + height_m) * cos_latitude * math.sin(longitude),
        (prime_vertical * (1 - WGS84_E2) + height_m) * sin_latitude,
    ], dtype=np.float64)


def ecef_to_geodetic(ecef: Any) -> tuple[float, float, float]:
    x, y, z = (float(value) for value in ecef)
    longitude = math.atan2(y, x)
    horizontal = math.hypot(x, y)
    if horizontal < 1e-9:
        latitude = math.copysign(math.pi / 2, z)
        height = abs(z) - WGS84_A * math.sqrt(1 - WGS84_E2)
        return math.degrees(longitude), math.degrees(latitude), height
    latitude = math.atan2(z, horizontal * (1 - WGS84_E2))
    height = 0.0
    for _ in range(12):
        sin_latitude = math.sin(latitude)
        prime_vertical = WGS84_A / math.sqrt(1 - WGS84_E2 * sin_latitude * sin_latitude)
        cos_latitude = math.cos(latitude)
        if abs(cos_latitude) < 1e-12:
            height = abs(z) - prime_vertical * (1 - WGS84_E2)
        else:
            height = horizontal / cos_latitude - prime_vertical
        denominator = horizontal * (1 - WGS84_E2 * prime_vertical / (prime_vertical + height))
        updated = math.atan2(z, denominator)
        if abs(updated - latitude) < 1e-13:
            latitude = updated
            break
        latitude = updated
    return math.degrees(longitude), math.degrees(latitude), height


def _ecef_from_enu_rotation(longitude_deg: float, latitude_deg: float) -> Any:
    import numpy as np

    longitude = math.radians(longitude_deg)
    latitude = math.radians(latitude_deg)
    sin_lon, cos_lon = math.sin(longitude), math.cos(longitude)
    sin_lat, cos_lat = math.sin(latitude), math.cos(latitude)
    return np.asarray([
        [-sin_lon, -sin_lat * cos_lon, cos_lat * cos_lon],
        [cos_lon, -sin_lat * sin_lon, cos_lat * sin_lon],
        [0.0, cos_lat, sin_lat],
    ], dtype=np.float64)


@dataclass(frozen=True)
class LocalTangentFrame:
    longitude_deg: float
    latitude_deg: float
    height_m: float
    origin_ecef: Any
    ecef_from_enu: Any

    @classmethod
    def at(cls, longitude_deg: float, latitude_deg: float, height_m: float) -> "LocalTangentFrame":
        return cls(
            longitude_deg,
            latitude_deg,
            height_m,
            geodetic_to_ecef(longitude_deg, latitude_deg, height_m),
            _ecef_from_enu_rotation(longitude_deg, latitude_deg),
        )

    def geodetic_to_enu(self, longitude_deg: float, latitude_deg: float, height_m: float) -> Any:
        ecef = geodetic_to_ecef(longitude_deg, latitude_deg, height_m)
        return self.ecef_from_enu.T @ (ecef - self.origin_ecef)

    def enu_to_geodetic(self, enu: Any) -> tuple[float, float, float]:
        return ecef_to_geodetic(self.origin_ecef + self.ecef_from_enu @ enu)


@dataclass(frozen=True)
class SimilarityTransform:
    scale: float
    rotation: Any
    translation: Any
    rmse_m: float
    inlier_count: int
    p95_error_m: float = 0.0
    max_error_m: float = 0.0

    def apply(self, point: Any) -> Any:
        return self.scale * (self.rotation @ point) + self.translation


def _umeyama_similarity(source: Any, target: Any) -> tuple[float, Any, Any]:
    import numpy as np

    if source.shape != target.shape or source.ndim != 2 or source.shape[1] != 3 or source.shape[0] < 3:
        raise ProjectionError("地理配准至少需要三个三维相机中心对应点")
    source_mean = source.mean(axis=0)
    target_mean = target.mean(axis=0)
    source_centered = source - source_mean
    target_centered = target - target_mean
    variance = float(np.sum(source_centered * source_centered) / source.shape[0])
    if variance <= 1e-12:
        raise ProjectionError("COLMAP 相机中心没有足够空间跨度，无法地理配准")
    covariance = (target_centered.T @ source_centered) / source.shape[0]
    left, singular_values, right_transpose = np.linalg.svd(covariance)
    sign = np.ones(3, dtype=np.float64)
    if np.linalg.det(left @ right_transpose) < 0:
        sign[-1] = -1
    rotation = left @ np.diag(sign) @ right_transpose
    scale = float(np.sum(singular_values * sign) / variance)
    if not math.isfinite(scale) or scale <= 0:
        raise ProjectionError("COLMAP 与 DJI GPS 的比例配准失败")
    translation = target_mean - scale * (rotation @ source_mean)
    return scale, rotation, translation


def robust_similarity(source: Any, target: Any) -> SimilarityTransform:
    import numpy as np

    source = np.asarray(source, dtype=np.float64)
    target = np.asarray(target, dtype=np.float64)
    if source.shape[0] < 6:
        raise ProjectionError("至少需要 6 个同时具有 DJI GPS 和 COLMAP 位姿的帧")
    singular_values = np.linalg.svd(target - target.mean(axis=0), compute_uv=False)
    if singular_values[0] < 2.0 or singular_values[1] < max(0.15, 0.01 * singular_values[0]):
        raise ProjectionError("飞行轨迹近似单点或直线，GPS 无法约束三维模型绕航线的旋转；需要转弯航迹或 GCP/三维模型")
    mask = np.ones(source.shape[0], dtype=bool)
    for _ in range(5):
        scale, rotation, translation = _umeyama_similarity(source[mask], target[mask])
        fitted = (scale * (rotation @ source.T)).T + translation
        residuals = np.linalg.norm(fitted - target, axis=1)
        median = float(np.median(residuals[mask]))
        threshold = max(1.5, min(10.0, 3 * median + 0.5))
        updated = residuals <= threshold
        if int(updated.sum()) < 6:
            break
        if np.array_equal(updated, mask):
            mask = updated
            break
        mask = updated
    scale, rotation, translation = _umeyama_similarity(source[mask], target[mask])
    fitted = (scale * (rotation @ source[mask].T)).T + translation
    inlier_residuals = np.linalg.norm(fitted - target[mask], axis=1)
    rmse = float(math.sqrt(float(np.mean(inlier_residuals ** 2))))
    p95 = float(np.percentile(inlier_residuals, 95))
    maximum = float(np.max(inlier_residuals))
    if (
        not all(math.isfinite(value) for value in (rmse, p95, maximum))
        or rmse > 3.0
        or p95 > 5.0
        or maximum > 8.0
    ):
        raise ProjectionError(
            f"DJI GPS 地理配准误差过大（RMSE {rmse:.2f}m，P95 {p95:.2f}m，最大 {maximum:.2f}m）；"
            "精确模式要求 RMSE≤3m、P95≤5m、最大≤8m，请使用 RTK/PPK/GCP 或外部三维模型"
        )
    return SimilarityTransform(scale, rotation, translation, rmse, int(mask.sum()), p95, maximum)


def _camera_center(image: ColmapImage) -> Any:
    return -(image.rotation_world_to_camera.T @ image.translation_world_to_camera)


def _pinhole_parameters(camera: ColmapCamera) -> tuple[float, float, float, float]:
    if camera.model in {"SIMPLE_PINHOLE", "SIMPLE_RADIAL", "RADIAL", "SIMPLE_RADIAL_FISHEYE", "RADIAL_FISHEYE"}:
        if len(camera.params) < 3:
            raise ProjectionError(f"COLMAP 相机 {camera.model} 内参数量不足")
        focal, cx, cy = camera.params[:3]
        return focal, focal, cx, cy
    if camera.model in {"PINHOLE", "OPENCV", "OPENCV_FISHEYE", "FULL_OPENCV", "FOV", "THIN_PRISM_FISHEYE"}:
        if len(camera.params) < 4:
            raise ProjectionError(f"COLMAP 相机 {camera.model} 内参数量不足")
        return camera.params[0], camera.params[1], camera.params[2], camera.params[3]
    raise ProjectionError(f"暂不支持 COLMAP 相机模型：{camera.model}")


def _validate_refined_camera(camera: ColmapCamera) -> None:
    fx, fy, cx, cy = _pinhole_parameters(camera)
    largest_dimension = max(camera.width, camera.height)
    if not all(math.isfinite(value) for value in (fx, fy, cx, cy)):
        raise ProjectionError(f"COLMAP 相机 {camera.camera_id} 内参包含非有限值")
    if (
        fx < 0.2 * largest_dimension
        or fy < 0.2 * largest_dimension
        or fx > 5.0 * largest_dimension
        or fy > 5.0 * largest_dimension
    ):
        raise ProjectionError(f"COLMAP 相机 {camera.camera_id} 焦距解算超出安全范围")
    if not (0.2 * camera.width <= cx <= 0.8 * camera.width) or not (
        0.2 * camera.height <= cy <= 0.8 * camera.height
    ):
        raise ProjectionError(f"COLMAP 相机 {camera.camera_id} 主点偏离画面中心过大")
    distortion_parameters: Sequence[float] = ()
    if camera.model == "SIMPLE_RADIAL":
        distortion_parameters = camera.params[3:4]
    elif camera.model == "RADIAL":
        distortion_parameters = camera.params[3:5]
    elif camera.model in {"OPENCV", "FULL_OPENCV", "OPENCV_FISHEYE"}:
        distortion_parameters = camera.params[4:]
    if any(not math.isfinite(value) or abs(value) > 2.0 for value in distortion_parameters):
        raise ProjectionError(f"COLMAP 相机 {camera.camera_id} 镜头畸变解算超出安全范围")


def _distort_normalized(camera: ColmapCamera, x: float, y: float) -> tuple[float, float]:
    model = camera.model
    params = camera.params
    if model in {"SIMPLE_PINHOLE", "PINHOLE"}:
        return x, y
    if model == "SIMPLE_RADIAL":
        k1 = params[3]
        radius2 = x * x + y * y
        factor = 1 + k1 * radius2
        return x * factor, y * factor
    if model == "RADIAL":
        k1, k2 = params[3:5]
        radius2 = x * x + y * y
        factor = 1 + k1 * radius2 + k2 * radius2 * radius2
        return x * factor, y * factor
    if model in {"OPENCV", "FULL_OPENCV"}:
        k1, k2, p1, p2 = params[4:8]
        radius2 = x * x + y * y
        if model == "FULL_OPENCV":
            k3, k4, k5, k6 = params[8:12]
            numerator = 1 + k1 * radius2 + k2 * radius2 ** 2 + k3 * radius2 ** 3
            denominator = 1 + k4 * radius2 + k5 * radius2 ** 2 + k6 * radius2 ** 3
            radial = numerator / denominator if abs(denominator) > 1e-12 else numerator
        else:
            radial = 1 + k1 * radius2 + k2 * radius2 ** 2
        return (
            x * radial + 2 * p1 * x * y + p2 * (radius2 + 2 * x * x),
            y * radial + p1 * (radius2 + 2 * y * y) + 2 * p2 * x * y,
        )
    if model in {"SIMPLE_RADIAL_FISHEYE", "RADIAL_FISHEYE", "OPENCV_FISHEYE"}:
        radius = math.hypot(x, y)
        if radius < 1e-12:
            return x, y
        theta = math.atan(radius)
        theta2 = theta * theta
        if model == "SIMPLE_RADIAL_FISHEYE":
            coefficients = (params[3],)
        elif model == "RADIAL_FISHEYE":
            coefficients = params[3:5]
        else:
            coefficients = params[4:8]
        theta_distorted = theta
        power = theta * theta2
        for coefficient in coefficients:
            theta_distorted += coefficient * power
            power *= theta2
        factor = theta_distorted / radius
        return x * factor, y * factor
    if model == "FOV":
        omega = params[4]
        radius = math.hypot(x, y)
        if radius < 1e-12 or abs(omega) < 1e-12:
            return x, y
        factor = math.atan(2 * radius * math.tan(omega / 2)) / (omega * radius)
        return x * factor, y * factor
    raise ProjectionError(f"暂不支持把 {model} 去畸变坐标映回浏览器视频")


def project_camera(camera: ColmapCamera, camera_point: Any) -> tuple[float, float] | None:
    x_coordinate, y_coordinate, depth = (float(value) for value in camera_point)
    if not math.isfinite(depth) or depth <= 1e-6:
        return None
    normalized_x = x_coordinate / depth
    normalized_y = y_coordinate / depth
    distorted_x, distorted_y = _distort_normalized(camera, normalized_x, normalized_y)
    fx, fy, cx, cy = _pinhole_parameters(camera)
    return fx * distorted_x + cx, fy * distorted_y + cy


def _depth_value(depth_map: Any, x: int, y: int, radius: int = 2) -> float | None:
    import numpy as np

    height, width = depth_map.shape[:2]
    center = float(depth_map[y, x])
    if not math.isfinite(center) or center <= 0:
        return None
    left, right = max(0, x - radius), min(width, x + radius + 1)
    top, bottom = max(0, y - radius), min(height, y + radius + 1)
    values = depth_map[top:bottom, left:right]
    valid = values[np.isfinite(values) & (values > 0)]
    if valid.size == 0:
        return None
    median = float(np.median(valid))
    if valid.size >= 4:
        lower, upper = (float(value) for value in np.percentile(valid, (10, 90)))
        if upper - lower > max(1.0, 0.08 * median):
            return None
    if abs(center - median) > max(0.75, 0.06 * median):
        return None
    return median


def _triangle_safe(
    vertices: Sequence[dict[str, Any]],
    indices: tuple[int, int, int],
    *,
    depth_map: Any | None = None,
    depth_scale: float = 1.0,
) -> bool:
    import numpy as np

    selected = [vertices[index] for index in indices]
    depths = [float(item["depth"]) for item in selected]
    median_depth = sorted(depths)[1]
    if max(depths) - min(depths) > max(1.5, 0.1 * median_depth):
        return False
    positions = [np.asarray(item["world"], dtype=np.float64) for item in selected]
    edges = [
        float(np.linalg.norm(positions[1] - positions[0])),
        float(np.linalg.norm(positions[2] - positions[1])),
        float(np.linalg.norm(positions[0] - positions[2])),
    ]
    if max(edges) > max(3.0, 0.18 * median_depth):
        return False
    if depth_map is not None:
        depth_pixels = [item.get("depth_pixel") for item in selected]
        if all(
            isinstance(pixel, tuple)
            and len(pixel) == 2
            and all(isinstance(value, int) for value in pixel)
            for pixel in depth_pixels
        ):
            sample_specs: list[tuple[int, int, float]] = []
            for left, right in ((0, 1), (1, 2), (2, 0)):
                left_pixel = depth_pixels[left]
                right_pixel = depth_pixels[right]
                assert isinstance(left_pixel, tuple) and isinstance(right_pixel, tuple)
                sample_specs.append((
                    round((left_pixel[0] + right_pixel[0]) / 2),
                    round((left_pixel[1] + right_pixel[1]) / 2),
                    (depths[left] + depths[right]) / 2,
                ))
            sample_specs.append((
                round(sum(pixel[0] for pixel in depth_pixels) / 3),  # type: ignore[index]
                round(sum(pixel[1] for pixel in depth_pixels) / 3),  # type: ignore[index]
                sum(depths) / 3,
            ))
            for sample_x, sample_y, expected_depth in sample_specs:
                sampled = _depth_value(depth_map, sample_x, sample_y, radius=1)
                if sampled is None:
                    return False
                sampled_metric = sampled * depth_scale
                if abs(sampled_metric - expected_depth) > max(1.0, 0.08 * expected_depth):
                    return False
    area = float(np.linalg.norm(np.cross(positions[1] - positions[0], positions[2] - positions[0])))
    return math.isfinite(area) and area > 1e-4


def _build_georeference(
    frame_manifest: Sequence[Mapping[str, Any]],
    sparse_images: Mapping[str, ColmapImage],
) -> tuple[LocalTangentFrame, SimilarityTransform]:
    import numpy as np

    matched = [item for item in frame_manifest if str(item["image_name"]) in sparse_images]
    if len(matched) < 6:
        raise ProjectionError("COLMAP 注册帧与 DJI GPS 对应少于 6 帧")
    reference = matched[len(matched) // 2]
    tangent = LocalTangentFrame.at(
        float(reference["longitude"]),
        float(reference["latitude"]),
        float(reference["ellipsoid_height_m"]),
    )
    source_centers = []
    target_centers = []
    for item in matched:
        source_centers.append(_camera_center(sparse_images[str(item["image_name"])]))
        target_centers.append(tangent.geodetic_to_enu(
            float(item["longitude"]),
            float(item["latitude"]),
            float(item["ellipsoid_height_m"]),
        ))
    source_array = np.asarray(source_centers)
    target_array = np.asarray(target_centers)
    transform = robust_similarity(source_array, target_array)
    fitted_centers = (transform.scale * (transform.rotation @ source_array.T)).T + transform.translation
    all_residuals = np.linalg.norm(fitted_centers - target_array, axis=1)
    all_rmse = float(math.sqrt(float(np.mean(all_residuals ** 2))))
    all_p95 = float(np.percentile(all_residuals, 95))
    maximum_all_frame_error = float(np.max(all_residuals))
    inlier_ratio = transform.inlier_count / len(matched)
    if (
        not all(math.isfinite(value) for value in (all_rmse, all_p95, maximum_all_frame_error))
        or inlier_ratio < 0.9
        or all_rmse > 3.0
        or all_p95 > 5.0
        or maximum_all_frame_error > 8.0
    ):
        worst_index = int(np.argmax(all_residuals))
        raise ProjectionError(
            f"逐帧地理配准未通过（内点 {inlier_ratio:.1%}，RMSE {all_rmse:.2f}m，"
            f"P95 {all_p95:.2f}m，第 {worst_index + 1} 帧最大 {maximum_all_frame_error:.2f}m）；"
            "要求内点≥90%、RMSE≤3m、P95≤5m、最大≤8m，请清理 GPS 跳点或使用 RTK/PPK/GCP"
        )
    return tangent, transform


def _depth_path(depth_directory: Path, image_name: str) -> Path | None:
    for suffix in (".geometric.bin", ".photometric.bin"):
        candidate = depth_directory / f"{image_name}{suffix}"
        if candidate.is_file():
            return candidate
    return None


def _build_frame_mesh(
    frame: Mapping[str, Any],
    *,
    original_camera: ColmapCamera,
    original_image: ColmapImage,
    dense_camera: ColmapCamera,
    dense_image: ColmapImage,
    depth_map: Any,
    tangent: LocalTangentFrame,
    transform: SimilarityTransform,
    grid_columns: int,
    grid_rows: int,
    sparse_reprojection_rmse_px: float | None,
) -> dict[str, Any]:
    import numpy as np

    depth_height, depth_width = depth_map.shape[:2]
    dense_fx, dense_fy, dense_cx, dense_cy = _pinhole_parameters(dense_camera)
    grid: list[list[int | None]] = [[None for _ in range(grid_columns)] for _ in range(grid_rows)]
    vertices: list[dict[str, Any]] = []
    for row in range(grid_rows):
        depth_y = round(row * (depth_height - 1) / (grid_rows - 1))
        for column in range(grid_columns):
            depth_x = round(column * (depth_width - 1) / (grid_columns - 1))
            depth = _depth_value(depth_map, depth_x, depth_y)
            if depth is None:
                continue
            # PatchMatch may internally resize an undistorted image.  Convert
            # depth-map pixel centers back into the camera calibration space.
            camera_x = (depth_x + 0.5) * dense_camera.width / depth_width - 0.5
            camera_y = (depth_y + 0.5) * dense_camera.height / depth_height - 0.5
            camera_point = np.asarray([
                (camera_x - dense_cx) / dense_fx * depth,
                (camera_y - dense_cy) / dense_fy * depth,
                depth,
            ], dtype=np.float64)
            world_point = dense_image.rotation_world_to_camera.T @ (
                camera_point - dense_image.translation_world_to_camera
            )
            original_camera_point = (
                original_image.rotation_world_to_camera @ world_point
                + original_image.translation_world_to_camera
            )
            projected = project_camera(original_camera, original_camera_point)
            if projected is None:
                continue
            pixel_x, pixel_y = projected
            u = pixel_x / original_camera.width
            v = pixel_y / original_camera.height
            if not -1e-6 <= u <= 1 + 1e-6 or not -1e-6 <= v <= 1 + 1e-6:
                continue
            enu = transform.apply(world_point)
            longitude, latitude, ellipsoid_height = tangent.enu_to_geodetic(enu)
            if not all(math.isfinite(value) for value in (longitude, latitude, ellipsoid_height)):
                continue
            metric_depth = depth * transform.scale
            if metric_depth < 0.5 or metric_depth > 5_000 or not -1_000 <= ellipsoid_height <= 10_000:
                continue
            vertex_index = len(vertices)
            grid[row][column] = vertex_index
            vertices.append({
                "wire": [
                    round(min(1.0, max(0.0, u)), 8),
                    round(min(1.0, max(0.0, v)), 8),
                    round(longitude, 9),
                    round(latitude, 9),
                    round(ellipsoid_height, 3),
                ],
                "depth": metric_depth,
                "depth_pixel": (depth_x, depth_y),
                "world": enu,
            })

    triangles: list[int] = []
    for row in range(grid_rows - 1):
        for column in range(grid_columns - 1):
            top_left = grid[row][column]
            top_right = grid[row][column + 1]
            bottom_left = grid[row + 1][column]
            bottom_right = grid[row + 1][column + 1]
            candidates = (
                (top_left, bottom_left, top_right),
                (top_right, bottom_left, bottom_right),
            )
            for candidate in candidates:
                if any(index is None for index in candidate):
                    continue
                indices = tuple(int(index) for index in candidate)
                if _triangle_safe(
                    vertices,
                    indices,
                    depth_map=depth_map,
                    depth_scale=transform.scale,
                ):
                    triangles.extend(indices)
    if triangles:
        used_indices = sorted(set(triangles))
        remap = {old_index: new_index for new_index, old_index in enumerate(used_indices)}
        vertices = [vertices[index] for index in used_indices]
        triangles = [remap[index] for index in triangles]
    if len(vertices) < 3 or len(triangles) < 3:
        raise ProjectionError(f"帧 {frame['image_name']} 没有足够可靠的首表面深度，已拒绝生成错误网格")
    valid_ratio = len(vertices) / (grid_columns * grid_rows)
    if valid_ratio < 0.15:
        raise ProjectionError(
            f"帧 {frame['image_name']} 的有效深度覆盖率仅 {valid_ratio:.1%}；水面/动态物体/弱纹理过多"
        )
    quality: dict[str, Any] = {
        "valid": True,
        "method": "sfm_mvs_colmap_dji_gps_similarity_first_surface",
        "georeference_rmse_m": round(transform.rmse_m, 4),
        "georeference_p95_error_m": round(transform.p95_error_m, 4),
        "georeference_max_error_m": round(transform.max_error_m, 4),
        "georeference_inlier_count": transform.inlier_count,
        "depth_grid_valid_ratio": round(valid_ratio, 6),
        "depth_discontinuities_are_open": True,
    }
    if sparse_reprojection_rmse_px is not None:
        quality["reprojection_rmse_px"] = round(sparse_reprojection_rmse_px, 6)
    return {
        "video_sample_index": int(frame["video_sample_index"]),
        "video_time_ms": int(frame["video_time_ms"]),
        "projection_mesh_wgs84": {
            "vertices": [item["wire"] for item in vertices],
            "triangles": triangles,
            "quality": quality,
        },
    }


def build_projection_meshes(
    frame_manifest: Sequence[Mapping[str, Any]],
    colmap_paths: Mapping[str, Path],
    *,
    grid_columns: int,
    grid_rows: int,
    progress: ProgressCallback | None,
    cancel_event: threading.Event | None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    sparse_text = colmap_paths["sparse_text"]
    dense_text = colmap_paths["dense_text"]
    original_cameras = _parse_colmap_cameras(sparse_text / "cameras.txt")
    original_images = _parse_colmap_images(sparse_text / "images.txt")
    dense_cameras = _parse_colmap_cameras(dense_text / "cameras.txt")
    dense_images = _parse_colmap_images(dense_text / "images.txt")
    for camera in (*original_cameras.values(), *dense_cameras.values()):
        _validate_refined_camera(camera)
    tangent, transform = _build_georeference(frame_manifest, original_images)
    sparse_rmse = _colmap_reprojection_rmse(sparse_text / "points3D.txt")
    if sparse_rmse is None or sparse_rmse > 3.0:
        raise ProjectionError(
            "COLMAP 稀疏模型缺少可验证重投影误差"
            if sparse_rmse is None
            else f"COLMAP 稀疏模型重投影 RMSE {sparse_rmse:.2f}px，超过 3px 安全阈值"
        )
    depth_directory = colmap_paths["dense"] / "stereo" / "depth_maps"
    meshes: list[dict[str, Any]] = []
    for index, frame in enumerate(frame_manifest):
        _check_cancelled(cancel_event)
        name = str(frame["image_name"])
        original_image = original_images.get(name)
        dense_image = dense_images.get(name)
        depth_path = _depth_path(depth_directory, name)
        if original_image is None or dense_image is None or depth_path is None:
            raise ProjectionError(f"帧 {name} 缺少 COLMAP 位姿或深度图，不能发布不完整网格")
        original_camera = original_cameras.get(original_image.camera_id)
        dense_camera = dense_cameras.get(dense_image.camera_id)
        if original_camera is None or dense_camera is None:
            raise ProjectionError(f"帧 {name} 引用不存在的 COLMAP 相机")
        depth_map = read_colmap_depth_map(depth_path)
        meshes.append(_build_frame_mesh(
            frame,
            original_camera=original_camera,
            original_image=original_image,
            dense_camera=dense_camera,
            dense_image=dense_image,
            depth_map=depth_map,
            tangent=tangent,
            transform=transform,
            grid_columns=grid_columns,
            grid_rows=grid_rows,
            sparse_reprojection_rmse_px=sparse_rmse,
        ))
        _emit(
            progress,
            "mesh_export",
            f"生成可见表面网格 {index + 1}/{len(frame_manifest)}",
            (index + 1) / len(frame_manifest),
        )
    statistics = {
        "frame_count": len(meshes),
        "vertex_count": sum(len(item["projection_mesh_wgs84"]["vertices"]) for item in meshes),
        "triangle_count": sum(len(item["projection_mesh_wgs84"]["triangles"]) // 3 for item in meshes),
        "georeference_rmse_m": transform.rmse_m,
        "georeference_p95_error_m": transform.p95_error_m,
        "georeference_max_error_m": transform.max_error_m,
        "georeference_inlier_count": transform.inlier_count,
        "sparse_reprojection_rmse_px": sparse_rmse,
        "origin": {
            "longitude": tangent.longitude_deg,
            "latitude": tangent.latitude_deg,
            "ellipsoid_height": tangent.height_m,
        },
        "refined_camera_models": [
            {
                "camera_id": camera.camera_id,
                "model": camera.model,
                "width_px": camera.width,
                "height_px": camera.height,
                "parameters": [round(float(value), 10) for value in camera.params],
                "parameter_order": "COLMAP camera model order; see official format documentation",
            }
            for camera in sorted(original_cameras.values(), key=lambda item: item.camera_id)
        ],
        "per_frame_camera_poses": [],
    }
    for frame in frame_manifest:
        name = str(frame["image_name"])
        image = original_images[name]
        center_enu = transform.apply(_camera_center(image))
        center_wgs84 = tangent.enu_to_geodetic(center_enu)
        telemetry_center_enu = tangent.geodetic_to_enu(
            float(frame["longitude"]),
            float(frame["latitude"]),
            float(frame["ellipsoid_height_m"]),
        )
        gps_fit_error_m = math.sqrt(float(sum((center_enu - telemetry_center_enu) ** 2)))
        camera_to_enu = transform.rotation @ image.rotation_world_to_camera.T
        statistics["per_frame_camera_poses"].append({
            "video_sample_index": int(frame["video_sample_index"]),
            "video_time_ms": int(frame["video_time_ms"]),
            "image_name": name,
            "camera_id": image.camera_id,
            "gps_fit_error_m": round(gps_fit_error_m, 4),
            "camera_center_wgs84_ellipsoid": {
                "longitude": round(center_wgs84[0], 9),
                "latitude": round(center_wgs84[1], 9),
                "height_m": round(center_wgs84[2], 3),
            },
            "camera_to_enu_at_origin": [
                [round(float(value), 10) for value in row]
                for row in camera_to_enu.tolist()
            ],
        })
    if statistics["vertex_count"] > MAX_TOTAL_VERTICES or statistics["triangle_count"] > MAX_TOTAL_TRIANGLES:
        raise ProjectionError("生成结果超过 Cesium 安全总量限制；请降低网格密度或分段处理")
    return meshes, statistics


def _validate_mesh_timeline(meshes: Sequence[Mapping[str, Any]], duration_ms: int) -> None:
    if len(meshes) < 2:
        raise ProjectionError("精确网格至少需要两帧")
    times = [int(item["video_time_ms"]) for item in meshes]
    sample_indices = [int(item["video_sample_index"]) for item in meshes]
    if len(set(times)) != len(times) or len(set(sample_indices)) != len(sample_indices):
        raise ProjectionError("三维网格存在重复 PTS 或 video_sample_index")
    if times != sorted(times):
        raise ProjectionError("三维网格 PTS 未严格递增")
    if times[0] > MAX_ENDPOINT_DELTA_MS or duration_ms - times[-1] > MAX_ENDPOINT_DELTA_MS:
        raise ProjectionError("三维网格未覆盖视频首尾 50ms")
    maximum_gap = max(right - left for left, right in zip(times, times[1:]))
    if maximum_gap > MAX_FRAME_GAP_MS:
        raise ProjectionError(f"三维网格最大 PTS 间隔 {maximum_gap}ms，超过 100ms")


def _mesh_number(value: Any, label: str) -> float:
    if isinstance(value, bool):
        raise ProjectionError(f"{label} 不是有效数字")
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ProjectionError(f"{label} 不是有效数字") from exc
    if not math.isfinite(parsed):
        raise ProjectionError(f"{label} 不是有限数字")
    return parsed


def _mesh_integer(value: Any, label: str) -> int:
    parsed = _mesh_number(value, label)
    if not parsed.is_integer():
        raise ProjectionError(f"{label} 必须是整数")
    return int(parsed)


def _validate_mesh_payloads(
    meshes: Sequence[Mapping[str, Any]],
    cancel_event: threading.Event | None,
) -> None:
    """Mirror the browser's critical mesh guards before atomic publication."""

    total_vertices = 0
    total_triangles = 0
    for frame_index, frame in enumerate(meshes):
        _check_cancelled(cancel_event)
        if not isinstance(frame, Mapping):
            raise ProjectionError(f"三维网格第 {frame_index} 帧不是对象")
        sample_index = _mesh_integer(frame.get("video_sample_index"), f"第 {frame_index} 帧 video_sample_index")
        video_time_ms = _mesh_integer(frame.get("video_time_ms"), f"第 {frame_index} 帧 video_time_ms")
        if sample_index < 0 or video_time_ms < 0:
            raise ProjectionError(f"三维网格第 {frame_index} 帧绑定不能为负数")
        payload = frame.get("projection_mesh_wgs84")
        if not isinstance(payload, Mapping):
            raise ProjectionError(f"三维网格第 {frame_index} 帧缺少 projection_mesh_wgs84")
        quality = payload.get("quality")
        if isinstance(quality, Mapping) and quality.get("valid") is False:
            raise ProjectionError(f"三维网格第 {frame_index} 帧质量标记为无效")

        raw_vertices = payload.get("vertices")
        if not isinstance(raw_vertices, (list, tuple)):
            raise ProjectionError(f"三维网格第 {frame_index} 帧缺少 vertices")
        vertex_count = len(raw_vertices)
        if not 3 <= vertex_count <= MAX_FRAME_VERTICES:
            raise ProjectionError(
                f"三维网格第 {frame_index} 帧顶点数必须为 3–{MAX_FRAME_VERTICES}"
            )
        vertices: list[tuple[float, float, float, float, float]] = []
        for vertex_index, raw_vertex in enumerate(raw_vertices):
            if vertex_index % 512 == 0:
                _check_cancelled(cancel_event)
            if not isinstance(raw_vertex, (list, tuple)) or len(raw_vertex) != 5:
                raise ProjectionError(
                    f"三维网格第 {frame_index} 帧顶点 {vertex_index} 必须为 [u,v,longitude,latitude,ellipsoidHeight]"
                )
            values = tuple(
                _mesh_number(value, f"第 {frame_index} 帧顶点 {vertex_index}")
                for value in raw_vertex
            )
            u, v, longitude, latitude, height = values
            if not 0.0 <= u <= 1.0 or not 0.0 <= v <= 1.0:
                raise ProjectionError(f"三维网格第 {frame_index} 帧顶点 {vertex_index} 的 UV 超出 [0,1]")
            if not -180.0 <= longitude <= 180.0 or not -90.0 <= latitude <= 90.0:
                raise ProjectionError(f"三维网格第 {frame_index} 帧顶点 {vertex_index} 的 WGS84 经纬度无效")
            if not -1_000.0 <= height <= 100_000.0:
                raise ProjectionError(f"三维网格第 {frame_index} 帧顶点 {vertex_index} 的椭球高无效")
            vertices.append(values)

        raw_triangles = payload.get("triangles")
        if not isinstance(raw_triangles, (list, tuple)) or not raw_triangles:
            raise ProjectionError(f"三维网格第 {frame_index} 帧必须提供显式 triangles")
        if isinstance(raw_triangles[0], (list, tuple)):
            if any(not isinstance(item, (list, tuple)) or len(item) != 3 for item in raw_triangles):
                raise ProjectionError(f"三维网格第 {frame_index} 帧 triangles 嵌套格式无效")
            flattened = [value for triangle in raw_triangles for value in triangle]
        else:
            if any(isinstance(item, (list, tuple)) for item in raw_triangles):
                raise ProjectionError(f"三维网格第 {frame_index} 帧 triangles 不能混用格式")
            flattened = list(raw_triangles)
        if len(flattened) % 3:
            raise ProjectionError(f"三维网格第 {frame_index} 帧 triangles 不是完整三角形组")
        triangle_count = len(flattened) // 3
        if not 1 <= triangle_count <= MAX_FRAME_TRIANGLES:
            raise ProjectionError(
                f"三维网格第 {frame_index} 帧三角形数必须为 1–{MAX_FRAME_TRIANGLES}"
            )
        indices = [
            _mesh_integer(value, f"第 {frame_index} 帧三角形索引 {index}")
            for index, value in enumerate(flattened)
        ]
        if any(index < 0 or index >= vertex_count for index in indices):
            raise ProjectionError(f"三维网格第 {frame_index} 帧存在越界索引")

        mean_latitude = sum(vertex[3] for vertex in vertices) / vertex_count
        longitude_scale = math.cos(math.radians(mean_latitude)) * math.pi / 180.0 * EARTH_RADIUS_METERS
        latitude_scale = math.pi / 180.0 * EARTH_RADIUS_METERS
        origin_longitude, origin_latitude, origin_height = vertices[0][2:5]

        def local_point(index: int) -> tuple[float, float, float]:
            longitude_delta = vertices[index][2] - origin_longitude
            if longitude_delta > 180.0:
                longitude_delta -= 360.0
            elif longitude_delta < -180.0:
                longitude_delta += 360.0
            return (
                longitude_delta * longitude_scale,
                (vertices[index][3] - origin_latitude) * latitude_scale,
                vertices[index][4] - origin_height,
            )

        seen_triangles: set[tuple[int, int, int]] = set()
        edge_use: dict[tuple[int, int], int] = {}
        referenced: set[int] = set()
        uv_winding = 0
        total_uv_area = 0.0
        for offset in range(0, len(indices), 3):
            if offset % 1536 == 0:
                _check_cancelled(cancel_event)
            a, b, c = indices[offset:offset + 3]
            if a == b or b == c or a == c:
                raise ProjectionError(f"三维网格第 {frame_index} 帧存在重复顶点三角形")
            key = tuple(sorted((a, b, c)))
            if key in seen_triangles:
                raise ProjectionError(f"三维网格第 {frame_index} 帧存在重复三角形")
            seen_triangles.add(key)
            referenced.update((a, b, c))
            au, av = vertices[a][0:2]
            bu, bv = vertices[b][0:2]
            cu, cv = vertices[c][0:2]
            uv_area = (bu - au) * (cv - av) - (bv - av) * (cu - au)
            if abs(uv_area) < 1e-9:
                raise ProjectionError(f"三维网格第 {frame_index} 帧存在 UV 退化三角形")
            winding = 1 if uv_area > 0 else -1
            if uv_winding and winding != uv_winding:
                raise ProjectionError(f"三维网格第 {frame_index} 帧 UV 绕序不一致")
            uv_winding = winding
            total_uv_area += abs(uv_area) / 2.0
            for left, right in ((a, b), (b, c), (c, a)):
                edge = (left, right) if left < right else (right, left)
                edge_use[edge] = edge_use.get(edge, 0) + 1
                if edge_use[edge] > 2:
                    raise ProjectionError(f"三维网格第 {frame_index} 帧存在非流形边")
            pa, pb, pc = local_point(a), local_point(b), local_point(c)
            ab = tuple(pb[axis] - pa[axis] for axis in range(3))
            ac = tuple(pc[axis] - pa[axis] for axis in range(3))
            cross = (
                ab[1] * ac[2] - ab[2] * ac[1],
                ab[2] * ac[0] - ab[0] * ac[2],
                ab[0] * ac[1] - ab[1] * ac[0],
            )
            if math.sqrt(sum(value * value for value in cross)) < 1e-4:
                raise ProjectionError(f"三维网格第 {frame_index} 帧存在空间退化三角形")
            maximum_edge = max(
                math.dist(pa, pb), math.dist(pb, pc), math.dist(pc, pa)
            )
            if maximum_edge > MAX_MESH_EDGE_METERS:
                raise ProjectionError(f"三维网格第 {frame_index} 帧存在超过 50km 的异常边")
        if total_uv_area > 1.02:
            raise ProjectionError(f"三维网格第 {frame_index} 帧 UV 覆盖重叠，可能导致 GPU 过绘")
        if len(referenced) != vertex_count:
            raise ProjectionError(f"三维网格第 {frame_index} 帧存在未被三角形引用的孤立顶点")

        total_vertices += vertex_count
        total_triangles += triangle_count
        if total_vertices > MAX_TOTAL_VERTICES or total_triangles > MAX_TOTAL_TRIANGLES:
            raise ProjectionError("三维网格超过生产端安全总量限制；请降低网格密度或分段处理")


def write_projection_mesh_sidecar(
    destination: Path,
    *,
    source_video: Mapping[str, Any],
    image_width_px: int,
    image_height_px: int,
    meshes: Sequence[Mapping[str, Any]],
    cancel_event: threading.Event | None = None,
    generation_id: str | None = None,
) -> Path:
    _check_cancelled(cancel_event)
    duration_ms = int(source_video["duration_ms"])
    _validate_mesh_timeline(meshes, duration_ms)
    _validate_mesh_payloads(meshes, cancel_event)
    if not 1 <= int(image_width_px) <= 16_384 or not 1 <= int(image_height_px) <= 16_384:
        raise ProjectionError("三维网格浏览器显示尺寸无效")
    header = {
        "schema_version": "cesium-video-projection-mesh/v1",
        "source_video": {
            "file_name": str(source_video["file_name"]),
            "size_bytes": int(source_video["size_bytes"]),
            "duration_ms": duration_ms,
            **(
                {
                    "content_fingerprint_sha256": str(source_video["content_fingerprint_sha256"]),
                    "content_fingerprint_scheme": str(source_video.get("content_fingerprint_scheme") or ""),
                }
                if source_video.get("content_fingerprint_sha256")
                else {}
            ),
        },
        "source_crs": "EPSG:4979",
        "height_reference": "WGS84_ELLIPSOID",
        "uv_origin": "top_left",
        "uv_units": "normalized",
        "image_space": "browser_display",
        "visibility": "first_surface_hit",
        "image_width_px": int(image_width_px),
        "image_height_px": int(image_height_px),
        **({"generation_id": generation_id} if generation_id else {}),
    }
    destination = destination.expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.stem}-",
        suffix=f"{destination.suffix}.tmp",
        dir=destination.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            prefix = json.dumps(header, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            handle.write(prefix[:-1])
            handle.write(',"frame_meshes":[')
            for index, mesh in enumerate(meshes):
                _check_cancelled(cancel_event)
                if index:
                    handle.write(",")
                json.dump(mesh, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                if handle.tell() > MAX_JSON_BYTES:
                    raise ProjectionError("三维网格 JSON 超过 60MB 安全上限；请降低网格密度或分段处理")
            handle.write("]}\n")
            _check_cancelled(cancel_event)
            handle.flush()
            os.fsync(handle.fileno())
        _check_cancelled(cancel_event)
        os.replace(temporary, destination)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return destination


def _path_is_ascii(path: Path) -> bool:
    try:
        os.fspath(path).encode("ascii")
    except UnicodeEncodeError:
        return False
    return True


def _colmap_workspace_parent_path(
    output_directory: Path,
    *,
    platform_name: str | None = None,
) -> Path:
    """Choose a same-volume path that native Windows COLMAP can open.

    COLMAP 4.1's bitmap reader enumerates filenames in a Unicode directory but
    then fails to open every image through its narrow filename API.  Keep the
    user-facing result directory unchanged and stage only native COLMAP files
    under an ASCII path.  On non-Windows platforms the local output directory
    remains preferable because native UTF-8 paths are supported there.
    """

    resolved_output = output_directory.expanduser().resolve()
    local_candidate = resolved_output / COLMAP_LOCAL_WORKSPACE_DIRECTORY
    current_platform = os.name if platform_name is None else platform_name
    if current_platform != "nt" or _path_is_ascii(local_candidate):
        return local_candidate

    anchor = resolved_output.anchor
    if not anchor:
        raise ProjectionError("无法确定输出目录所在磁盘，不能创建 COLMAP 纯英文工作区")
    volume_candidate = Path(anchor) / COLMAP_VOLUME_WORKSPACE_DIRECTORY
    if not _path_is_ascii(volume_candidate):
        raise ProjectionError(
            "输出位置的磁盘或网络共享名称包含非 ASCII 字符，Windows COLMAP 无法安全读取重建帧；"
            "请把输出目录选择到本地盘符（例如 E:）后重试"
        )
    return volume_candidate


def _create_colmap_workspace(
    output_directory: Path,
    *,
    source_fingerprint: str,
    generation_id: str,
) -> tuple[Path, Path]:
    parent = _colmap_workspace_parent_path(output_directory)
    try:
        parent.mkdir(parents=True, exist_ok=True)
        resolved_parent = parent.resolve()
        resolved_output = output_directory.expanduser().resolve()
        if os.name == "nt" and not _path_is_ascii(resolved_parent):
            raise ProjectionError(f"COLMAP 工作区不是纯 ASCII 路径：{resolved_parent}")
        if (
            os.name == "nt"
            and resolved_parent.anchor.casefold() != resolved_output.anchor.casefold()
        ):
            raise ProjectionError(
                f"COLMAP 工作区被重定向到其他磁盘：{resolved_parent}；"
                "为避免空间估算失真，已停止重建"
            )
        workspace = Path(tempfile.mkdtemp(
            prefix=f"job-{source_fingerprint[:12]}-{generation_id}-",
            dir=resolved_parent,
        )).resolve()
    except ProjectionError:
        raise
    except OSError as exc:
        raise ProjectionError(
            f"无法在输出磁盘创建 COLMAP 纯英文工作区：{parent}（{exc}）"
        ) from exc
    if os.name == "nt" and not _path_is_ascii(workspace):
        try:
            workspace.rmdir()
        except OSError:
            pass
        raise ProjectionError(f"COLMAP 工作区不是纯 ASCII 路径：{workspace}")
    return resolved_parent, workspace


def _cleanup_success_workspace(
    workspace: Path,
    *,
    expected_parent: Path | None = None,
) -> dict[str, Any]:
    """Remove large regenerable artifacts only after a validated mesh exists."""

    result: dict[str, Any] = {"removed": [], "warnings": []}
    resolved_workspace = workspace.resolve()
    resolved_parent = resolved_workspace.parent.resolve()
    if expected_parent is not None:
        safe_parent = expected_parent.resolve()
        parent_is_safe = resolved_parent == safe_parent
    else:
        parent_is_safe = resolved_parent.name in {
            "_AR重建工作区",
            COLMAP_LOCAL_WORKSPACE_DIRECTORY,
            COLMAP_VOLUME_WORKSPACE_DIRECTORY,
        }
    if not parent_is_safe:
        result["warnings"].append("工作区路径未通过清理安全校验，未自动删除中间文件")
        return result
    for name in ("images", "dense", "sparse", "database.db"):
        target = (resolved_workspace / name).resolve()
        if not target.is_relative_to(resolved_workspace) or not target.exists():
            continue
        try:
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
            result["removed"].append(name)
        except OSError as exc:
            result["warnings"].append(f"无法清理 {name}：{exc}")
    return result


def run_projection_reconstruction(
    video_path: Path,
    *,
    source_video: Mapping[str, Any],
    samples: Sequence[Mapping[str, Any]],
    output_directory: Path,
    options: ProjectionOptions,
    progress: ProgressCallback | None = None,
    cancel_event: threading.Event | None = None,
) -> ProjectionOutcome:
    """Run the optional reconstruction and always publish a quality report."""

    options.validate()
    output_directory = output_directory.expanduser().resolve()
    output_directory.mkdir(parents=True, exist_ok=True)
    prefix = video_path.stem
    fingerprint = str(source_video.get("content_fingerprint_sha256") or "").strip().casefold()
    if not (len(fingerprint) >= 12 and all(character in "0123456789abcdef" for character in fingerprint[:12])):
        fallback_identity = json.dumps(
            {
                "file_name": source_video.get("file_name"),
                "size_bytes": source_video.get("size_bytes"),
                "duration_ms": source_video.get("duration_ms"),
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        fingerprint = hashlib.sha256(fallback_identity.encode("utf-8")).hexdigest()
    telemetry_digest = hashlib.sha256()
    telemetry_digest.update(b"dji-video-ar-telemetry-v1\0")
    for sample in samples:
        telemetry_record = [
            sample.get("video_sample_index"),
            sample.get("video_time_ms"),
            sample.get("longitude"),
            sample.get("latitude"),
            sample.get("absolute_altitude_m"),
            sample.get("gps_altitude_m"),
            sample.get("relative_altitude_m"),
            sample.get("focal_length_35mm_equivalent_mm"),
            sample.get("digital_zoom_ratio"),
            sample.get("estimated_intrinsics"),
        ]
        telemetry_digest.update(json.dumps(
            telemetry_record,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=True,
        ).encode("utf-8"))
        telemetry_digest.update(b"\n")
    telemetry_fingerprint = telemetry_digest.hexdigest()
    generation_payload = {
        "pipeline": "dji-video-sfm-mvs-first-surface/v1",
        "source_fingerprint": fingerprint,
        "telemetry_fingerprint": telemetry_fingerprint,
        "height_mode": options.height_mode,
        "height_offset_m": options.height_offset_m,
        "mesh_fps": options.mesh_fps,
        "max_image_dimension": options.max_image_dimension,
        "grid_columns": options.grid_columns,
        "grid_rows": options.grid_rows,
    }
    generation_id = hashlib.sha256(json.dumps(
        generation_payload,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")).hexdigest()[:12]
    identity_suffix = f"_{fingerprint[:12]}_{generation_id}"
    report_path = output_directory / f"{prefix}{identity_suffix}_AR投影质量报告.json"
    mesh_path = output_directory / f"{prefix}{identity_suffix}_三维投影网格_请选择此文件.json"
    capabilities = projection_capabilities(options)
    report: dict[str, Any] = {
        "schema_version": "dji-video-ar-reconstruction-report/v1",
        "generator": "DJI 航拍视频 AR 数据提取器",
        "source_video": dict(source_video),
        "generation_id": generation_id,
        "telemetry_fingerprint_sha256": telemetry_fingerprint,
        "generation_parameters": generation_payload,
        "status": "checking",
        "capabilities": capabilities,
        "height_reference": {
            "output_crs": "EPSG:4979",
            "output_height_reference": "WGS84_ELLIPSOID",
            "mode": options.height_mode,
            "offset_or_takeoff_height_m": options.height_offset_m,
            "operator_confirmation_required": True,
        },
        "options": {
            "mesh_fps": options.mesh_fps,
            "max_image_dimension": options.max_image_dimension,
            "requested_grid_columns": options.grid_columns,
            "requested_grid_rows": options.grid_rows,
        },
    }
    workspace: Path | None = None
    mesh_existed_before_run = mesh_path.is_file()
    mesh_published_this_run = False
    try:
        if not capabilities["ready"]:
            raise ProjectionError("无法启动真实表面重建：" + "、".join(capabilities["missing"]))
        source_rotation = source_video.get("rotation_degrees")
        if isinstance(source_rotation, (int, float)) and math.isfinite(float(source_rotation)):
            source_normalized = float(source_rotation) % 360.0
            if not math.isclose(source_normalized, 0.0, abs_tol=0.01):
                raise ProjectionError(
                    "视频含非零旋转元数据；当前版本为避免 UV 与浏览器显示空间错位，"
                    "不会发布未经验证的三维投影网格。请先无损规范化为横屏像素方向后重试"
                )
        display_metadata = verify_browser_display_metadata(video_path)
        report["browser_display_verification"] = display_metadata
        normalized_rotation = float(display_metadata["rotation_degrees"]) % 360.0
        if isinstance(source_rotation, (int, float)) and math.isfinite(float(source_rotation)):
            rotation_delta = abs(((source_normalized - normalized_rotation + 180.0) % 360.0) - 180.0)
            if rotation_delta > 0.01:
                raise ProjectionError("视频头旋转信息来源不一致，不能安全绑定浏览器显示空间")
        if not math.isclose(normalized_rotation, 0.0, abs_tol=0.01):
            raise ProjectionError(
                "视频含非零旋转元数据；当前版本为避免 UV 与浏览器显示空间错位，"
                "不会发布未经验证的三维投影网格。请先无损规范化为横屏像素方向后重试"
            )
        prepared = _prepared_samples(samples, options)
        if len(prepared) != len(samples):
            raise ProjectionError(
                f"只有 {len(prepared)}/{len(samples)} 条遥测具备 GPS、精确 PTS 和已确认椭球高；不能伪造缺失帧"
            )
        duration_ms = int(source_video["duration_ms"])
        selected = select_projection_samples(prepared, duration_ms, options.mesh_fps)
        grid_columns, grid_rows = effective_grid(options.grid_columns, options.grid_rows, len(selected))
        source_width = source_video.get("width_px")
        source_height = source_video.get("height_px")
        if all(
            isinstance(value, (int, float)) and math.isfinite(float(value)) and float(value) > 0
            for value in (source_width, source_height)
        ):
            scale = min(1.0, options.max_image_dimension / max(float(source_width), float(source_height)))
            reconstruction_pixels = max(1, round(float(source_width) * scale)) * max(
                1, round(float(source_height) * scale)
            )
        else:
            reconstruction_pixels = options.max_image_dimension ** 2
        estimated_work_bytes = int(
            len(selected) * (reconstruction_pixels * 20 + 512 * 1024)
            + 2 * 1024 ** 3
        )
        planned_workspace_parent = _colmap_workspace_parent_path(output_directory)
        disk_probe = (
            planned_workspace_parent
            if planned_workspace_parent.exists()
            else Path(planned_workspace_parent.anchor or output_directory.anchor)
        )
        free_bytes = shutil.disk_usage(disk_probe).free
        report["resource_estimate"] = {
            "selected_frame_count": len(selected),
            "estimated_peak_workspace_bytes": estimated_work_bytes,
            "free_bytes_before_reconstruction": free_bytes,
            "workspace_volume": planned_workspace_parent.anchor,
            "producer_vertex_limit": MAX_TOTAL_VERTICES,
            "producer_triangle_limit": MAX_TOTAL_TRIANGLES,
            "json_limit_bytes": MAX_JSON_BYTES,
        }
        if free_bytes < estimated_work_bytes:
            raise ProjectionError(
                f"输出磁盘剩余 {free_bytes / 1024 ** 3:.1f}GB，估计至少需要 "
                f"{estimated_work_bytes / 1024 ** 3:.1f}GB 才能安全运行 SfM/MVS；请更换输出目录或分段视频"
            )
        workspace_parent, workspace = _create_colmap_workspace(
            output_directory,
            source_fingerprint=fingerprint,
            generation_id=generation_id,
        )
        _atomic_json(workspace / COLMAP_WORKSPACE_MARKER, {
            "schema_version": "cesium-ar-colmap-workspace/v1",
            "source_video": str(video_path),
            "source_fingerprint": fingerprint,
            "generation_id": generation_id,
            "result_directory": str(output_directory),
            "path_policy": "same-volume ASCII staging for native Windows COLMAP",
        })
        report["workspace_path_policy"] = {
            "colmap_requires_ascii_on_windows": os.name == "nt",
            "staging_parent": str(workspace_parent),
            "result_directory": str(output_directory),
            "same_volume": workspace_parent.anchor.casefold() == output_directory.anchor.casefold(),
        }
        _emit(progress, "prepare", f"AR 重建工作区：{workspace}", 0.0)
        frame_manifest, browser_width, browser_height = _extract_frames(
            video_path,
            selected,
            workspace / "images",
            options.max_image_dimension,
            progress,
            cancel_event,
        )
        _atomic_json(workspace / "frame_manifest.json", {
            "source_video": dict(source_video),
            "height_reference": "WGS84_ELLIPSOID",
            "frames": frame_manifest,
        })
        colmap_executable = Path(str(capabilities["colmap_executable"]))
        colmap_paths = _run_colmap(
            colmap_executable,
            workspace,
            frame_manifest,
            options.max_image_dimension,
            progress,
            cancel_event,
        )
        meshes, statistics = build_projection_meshes(
            frame_manifest,
            colmap_paths,
            grid_columns=grid_columns,
            grid_rows=grid_rows,
            progress=progress,
            cancel_event=cancel_event,
        )
        written = write_projection_mesh_sidecar(
            mesh_path,
            source_video=source_video,
            image_width_px=browser_width,
            image_height_px=browser_height,
            meshes=meshes,
            cancel_event=cancel_event,
            generation_id=generation_id,
        )
        mesh_published_this_run = True
        cleanup = _cleanup_success_workspace(workspace, expected_parent=workspace_parent)
        report.update({
            "status": "success",
            "message": "已生成逐帧可见表面 EPSG:4979 三维控制网格",
            "mesh_file": str(written),
            "workspace": str(workspace),
            "effective_grid_columns": grid_columns,
            "effective_grid_rows": grid_rows,
            "statistics": statistics,
            "workspace_cleanup": cleanup,
            "limitations": [
                "SfM/MVS 与 DJI GPS 相似变换属于摄影测量估计，不等同于 RTK/GCP 测绘成果",
                "水面、反光、运动物体、弱纹理和遮挡区域会留孔，不压平到地面",
                "深度突变处已断开三角形，visibility 固定为 first_surface_hit",
            ],
        })
        _atomic_json(report_path, report)
        _emit(progress, "complete", "真实表面 AR 网格生成完成", 1.0)
        return ProjectionOutcome("success", report_path, written, workspace, len(meshes), report["message"])
    except ProjectionCancelled as exc:
        report.update({
            "status": "cancelled",
            "message": str(exc),
            "workspace": str(workspace) if workspace else None,
        })
        _atomic_json(report_path, report)
        return ProjectionOutcome("cancelled", report_path, None, workspace, 0, str(exc))
    except BaseException as exc:
        mesh_exists_after_failure = mesh_path.is_file()
        # Never replace a previously validated mesh with an incomplete retry.
        report.update({
            "status": "failed",
            "message": str(exc),
            "workspace": str(workspace) if workspace else None,
            "error_type": type(exc).__name__,
            "traceback": traceback.format_exc(),
            "mesh_published": mesh_published_this_run and mesh_exists_after_failure,
            "previous_same_generation_mesh_preserved": mesh_existed_before_run and mesh_exists_after_failure,
            "safety_action": (
                "网格已完成原子校验发布，但后续报告/清理失败；文件仍按 generation_id 隔离"
                if mesh_published_this_run and mesh_exists_after_failure
                else "未发布空网格或估算地面网格；原有遥测输出仍可使用"
            ),
        })
        _atomic_json(report_path, report)
        _emit(progress, "failed", str(exc), None)
        return ProjectionOutcome("failed", report_path, None, workspace, 0, str(exc))
