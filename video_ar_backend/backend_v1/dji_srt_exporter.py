"""Detect, validate and safely export DJI telemetry subtitle streams.

This module deliberately does not manufacture telemetry.  It can reuse a
strictly paired sidecar SRT or export a standard subtitle stream that is
already present in an MP4/MOV container.  Proprietary DJI ``djmd`` data is
reported, but never disguised as SRT.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import statistics
import tempfile
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

from .dji_telemetry_extractor import (
    MAX_SRT_BYTES,
    ExtractionCancelled,
    ExtractionError,
    FFmpegNotFoundError,
    FFprobeExecutionError,
    FFprobeNotFoundError,
    SubtitleParseError,
    TelemetrySample,
    VideoOpenError,
    _check_cancellation,
    _decode_text_bytes,
    _extract_embedded_srt,
    _proprietary_metadata_stream_indexes,
    _subtitle_streams,
    parse_dji_srt,
    parse_ffprobe_document,
    probe_video,
)


SRT_EXPORT_SCHEMA_VERSION = "dji-srt-preparation/v1"
_REQUIRED_DIRECT_FIELDS = (
    "latitude",
    "longitude",
    "gimbal_yaw_deg",
    "gimbal_pitch_deg",
    "gimbal_roll_deg",
    "focal_length_35mm_equivalent_mm",
)
_ALTITUDE_FIELDS = (
    "absolute_altitude_m",
    "gps_altitude_m",
    "relative_altitude_m",
)


@dataclass(frozen=True)
class SrtValidation:
    sample_count: int
    ar_ready: bool
    timeline_valid: bool
    field_coverage: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    timeline: Mapping[str, Any] = field(default_factory=dict)
    missing_requirements: tuple[str, ...] = ()
    issues: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "sample_count": self.sample_count,
            "ar_ready": self.ar_ready,
            "timeline_valid": self.timeline_valid,
            "field_coverage": {
                name: dict(value) for name, value in self.field_coverage.items()
            },
            "timeline": dict(self.timeline),
            "missing_requirements": list(self.missing_requirements),
            "issues": list(self.issues),
        }


@dataclass(frozen=True)
class SrtPreparationResult:
    status: str
    message: str
    video_path: str
    output_srt: Optional[str] = None
    report_path: Optional[str] = None
    source_kind: Optional[str] = None
    selected_stream_index: Optional[int] = None
    ar_ready: bool = False
    validation: Optional[SrtValidation] = None
    candidates: tuple[Mapping[str, Any], ...] = ()
    warnings: tuple[str, ...] = ()
    video_fingerprint: Mapping[str, Any] = field(default_factory=dict)
    schema_version: str = SRT_EXPORT_SCHEMA_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "status": self.status,
            "message": self.message,
            "video": dict(self.video_fingerprint),
            "video_path": self.video_path,
            "output_srt": self.output_srt,
            "report_path": self.report_path,
            "source_kind": self.source_kind,
            "selected_stream_index": self.selected_stream_index,
            "ar_ready": self.ar_ready,
            "validation": self.validation.to_dict() if self.validation else None,
            "candidates": [dict(item) for item in self.candidates],
            "warnings": list(self.warnings),
        }


def _safe_ratio(count: int, total: int) -> float:
    return count / total if total else 0.0


def validate_srt_for_ar(
    samples: Sequence[TelemetrySample],
    video_duration_ms: Optional[int] = None,
) -> SrtValidation:
    """Validate the minimum telemetry contract needed by the AR pipeline.

    The check is intentionally strict: every sample needs WGS84 horizontal
    position, one height, all three gimbal axes and a 35 mm-equivalent focal
    length.  Missing lens distortion is solved later by the SfM calibration;
    it is not invented here.
    """

    sample_count = len(samples)
    issues: list[str] = []
    missing: list[str] = []
    coverage: dict[str, Mapping[str, Any]] = {}

    for name in _REQUIRED_DIRECT_FIELDS:
        count = sum(getattr(sample, name, None) is not None for sample in samples)
        coverage[name] = {
            "present": count,
            "total": sample_count,
            "ratio": _safe_ratio(count, sample_count),
        }
        if count != sample_count:
            missing.append(name)

    altitude_count = sum(
        any(getattr(sample, name, None) is not None for name in _ALTITUDE_FIELDS)
        for sample in samples
    )
    coverage["absolute_or_relative_altitude"] = {
        "present": altitude_count,
        "total": sample_count,
        "ratio": _safe_ratio(altitude_count, sample_count),
        "accepted_source_fields": list(_ALTITUDE_FIELDS),
    }
    if altitude_count != sample_count:
        missing.append("absolute_or_relative_altitude")

    starts = [sample.start_time_ms for sample in samples]
    ends = [sample.end_time_ms for sample in samples]
    timed = all(value is not None for value in (*starts, *ends))
    timeline_valid = timed and sample_count >= 2
    timeline: dict[str, Any] = {
        "video_duration_ms": video_duration_ms,
        "all_samples_timed": timed,
    }
    if sample_count < 2:
        issues.append("逐帧 AR 至少需要 2 条连续遥测样本")
    if not timed:
        issues.append("存在缺少 SRT PTS 起止时间的样本")

    if timed and sample_count:
        numeric_starts = [int(value) for value in starts if value is not None]
        numeric_ends = [int(value) for value in ends if value is not None]
        strictly_increasing = all(
            current > previous
            for previous, current in zip(numeric_starts, numeric_starts[1:])
        )
        nonnegative_durations = all(
            end >= start for start, end in zip(numeric_starts, numeric_ends)
        )
        intervals = [
            current - previous
            for previous, current in zip(numeric_starts, numeric_starts[1:])
        ]
        median_interval = statistics.median(intervals) if intervals else None
        max_gap = max(intervals) if intervals else None
        dense_enough = median_interval is not None and median_interval <= 250
        timeline.update(
            {
                "first_start_ms": numeric_starts[0],
                "last_end_ms": numeric_ends[-1],
                "strictly_increasing": strictly_increasing,
                "nonnegative_cue_durations": nonnegative_durations,
                "median_interval_ms": median_interval,
                "max_gap_ms": max_gap,
                "dense_enough_for_ar": dense_enough,
            }
        )
        if not strictly_increasing:
            timeline_valid = False
            issues.append("SRT PTS 不严格递增，可能乱序、重复或不是该视频的配套文件")
        if not nonnegative_durations:
            timeline_valid = False
            issues.append("SRT 存在结束时间早于开始时间的条目")
        if not dense_enough:
            timeline_valid = False
            issues.append("遥测采样间隔超过 250 ms，不满足逐帧 AR 的最低密度")

        if video_duration_ms is not None and video_duration_ms >= 0:
            tolerance_ms = max(
                500,
                int(round((median_interval or 0) * 4)),
            )
            start_delta = numeric_starts[0]
            end_delta = video_duration_ms - numeric_ends[-1]
            duration_matches = (
                -tolerance_ms <= start_delta <= tolerance_ms
                and abs(end_delta) <= tolerance_ms
            )
            timeline.update(
                {
                    "start_delta_ms": start_delta,
                    "end_delta_ms": end_delta,
                    "duration_tolerance_ms": tolerance_ms,
                    "matches_video_duration": duration_matches,
                }
            )
            if not duration_matches:
                timeline_valid = False
                issues.append(
                    "SRT 首尾 PTS 与视频时长不匹配，禁止自动绑定以避免错投影"
                )

    if not sample_count:
        timeline_valid = False
        issues.append("没有可解析的 SRT 条目")
    if missing:
        issues.append("AR 必需字段未达到 100% 覆盖：" + "、".join(missing))

    return SrtValidation(
        sample_count=sample_count,
        ar_ready=bool(sample_count >= 2 and timeline_valid and not missing),
        timeline_valid=bool(timeline_valid),
        field_coverage=coverage,
        timeline=timeline,
        missing_requirements=tuple(missing),
        issues=tuple(issues),
    )


def score_srt_candidate(samples: Sequence[TelemetrySample]) -> float:
    """Return a deterministic DJI/AR-likeness score for stream selection."""

    if not samples:
        return 0.0
    total = len(samples)
    weights = {
        "latitude": 20.0,
        "longitude": 20.0,
        "gimbal_yaw_deg": 12.0,
        "gimbal_pitch_deg": 12.0,
        "gimbal_roll_deg": 8.0,
        "focal_length_35mm_equivalent_mm": 12.0,
        "digital_zoom_ratio": 2.0,
        "frame_index": 4.0,
        "recorded_at": 2.0,
    }
    score = 0.0
    for name, weight in weights.items():
        present = sum(getattr(sample, name, None) is not None for sample in samples)
        score += weight * _safe_ratio(present, total)
    altitude_present = sum(
        any(getattr(sample, field_name, None) is not None for field_name in _ALTITUDE_FIELDS)
        for sample in samples
    )
    score += 10.0 * _safe_ratio(altitude_present, total)
    return round(score + min(total, 10_000) / 100_000.0, 6)


def write_text_atomic(
    destination: str | Path,
    text: str,
    *,
    overwrite: bool = False,
) -> Path:
    """Publish a complete UTF-8 text file without exposing a partial file."""

    target = Path(destination).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and not overwrite:
        raise FileExistsError(f"目标文件已存在，未覆盖：{target}")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".tmp", dir=target.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        if overwrite:
            os.replace(temporary, target)
        else:
            # Hard-link publication fails atomically if another process created
            # the target after the pre-check.  Both paths are on the same volume.
            os.link(temporary, target)
            temporary.unlink()
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return target


def _strict_sidecars(video_path: Path) -> list[Path]:
    try:
        return sorted(
            (
                path
                for path in video_path.parent.iterdir()
                if path.is_file()
                and path.suffix.casefold() == ".srt"
                and path.stem.casefold() == video_path.stem.casefold()
            ),
            key=lambda path: path.name.casefold(),
        )
    except OSError:
        return []


def _read_srt(path: Path) -> str:
    try:
        if path.stat().st_size > MAX_SRT_BYTES:
            raise SubtitleParseError(f"SRT 超过 64 MB，拒绝读取：{path}")
        return _decode_text_bytes(path.read_bytes(), str(path))
    except OSError as exc:
        raise SubtitleParseError(f"无法读取 SRT {path}：{exc}") from exc


def _video_fingerprint(path: Path) -> dict[str, Any]:
    stat = path.stat()
    digest = hashlib.sha256()
    sample_bytes = 1024 * 1024
    with path.open("rb") as handle:
        first = handle.read(sample_bytes)
        digest.update(first)
        if stat.st_size > sample_bytes:
            handle.seek(max(0, stat.st_size - sample_bytes))
            digest.update(handle.read(sample_bytes))
    digest.update(str(stat.st_size).encode("ascii"))
    return {
        "path": str(path),
        "name": path.name,
        "size_bytes": stat.st_size,
        "modified_time_ns": stat.st_mtime_ns,
        "sampled_sha256": digest.hexdigest(),
        "sampled_sha256_method": "first_1MiB+last_1MiB+size",
    }


def _duration_ms(document: Mapping[str, Any]) -> Optional[int]:
    try:
        return parse_ffprobe_document(document).duration_ms
    except ExtractionError:
        format_info = document.get("format")
        raw = format_info.get("duration") if isinstance(format_info, Mapping) else None
        try:
            seconds = float(raw)
        except (TypeError, ValueError):
            return None
        return round(seconds * 1000) if math.isfinite(seconds) and seconds >= 0 else None


def _candidate_record(
    stream: Mapping[str, Any],
    validation: Optional[SrtValidation],
    score: float,
    error: Optional[str] = None,
) -> dict[str, Any]:
    index = stream.get("index")
    return {
        "stream_index": int(index) if isinstance(index, int) else index,
        "codec_name": stream.get("codec_name"),
        "codec_long_name": stream.get("codec_long_name"),
        "tags": dict(stream.get("tags")) if isinstance(stream.get("tags"), Mapping) else {},
        "score": score,
        "ar_ready": bool(validation and validation.ar_ready),
        "validation": validation.to_dict() if validation else None,
        "error": error,
    }


def _unique_srt_path(output_directory: Path, stem: str) -> Path:
    base = output_directory / f"{stem}_内嵌遥测.srt"
    if not base.exists():
        return base
    for index in range(2, 10_000):
        candidate = output_directory / f"{stem}_内嵌遥测_{index}.srt"
        if not candidate.exists():
            return candidate
    raise FileExistsError("输出目录中同名 SRT 过多，请更换空目录")


def _write_report(output_directory: Path, video_stem: str, result: SrtPreparationResult) -> Path:
    target = output_directory / f"{video_stem}_SRT提取报告.json"
    payload = json.dumps(result.to_dict(), ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    return write_text_atomic(target, payload, overwrite=True)


def _finalize(
    output_directory: Path,
    video_stem: str,
    result: SrtPreparationResult,
) -> SrtPreparationResult:
    report = _write_report(output_directory, video_stem, result)
    return SrtPreparationResult(
        **{
            **result.__dict__,
            "report_path": str(report),
        }
    )


def prepare_dji_srt(
    video_path: str | Path,
    output_directory: str | Path,
    *,
    explicit_sidecar: str | Path | None = None,
    subtitle_stream_index: int | None = None,
    ffprobe_bin: str | Path = "ffprobe",
    ffmpeg_bin: str | Path = "ffmpeg",
    cancel_event: threading.Event | None = None,
    overwrite: bool = False,
) -> SrtPreparationResult:
    """Find or export the one DJI subtitle source that is safe for AR use."""

    _check_cancellation(cancel_event, None)
    video = Path(video_path).expanduser()
    if not video.is_file():
        raise VideoOpenError(f"视频文件不存在：{video}")
    video = video.resolve()
    output = Path(output_directory).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    fingerprint = _video_fingerprint(video)

    if explicit_sidecar is not None:
        sidecars = [Path(explicit_sidecar).expanduser()]
    else:
        sidecars = _strict_sidecars(video)
    if len(sidecars) > 1:
        result = SrtPreparationResult(
            status="ambiguous_streams",
            message="发现多个严格同名 SRT，无法自动判断，请手动选择正确文件。",
            video_path=str(video),
            candidates=tuple({"sidecar": str(path)} for path in sidecars),
            video_fingerprint=fingerprint,
        )
        return _finalize(output, video.stem, result)
    if sidecars:
        sidecar = sidecars[0]
        if not sidecar.is_file():
            raise SubtitleParseError(f"指定的 SRT 文件不存在：{sidecar}")
        sidecar = sidecar.resolve()
        text = _read_srt(sidecar)
        samples = parse_dji_srt(text, source_name=str(sidecar), source_kind="sidecar_srt")
        # A same-looking SRT can still belong to a trimmed, transcoded or
        # different video.  Probe the container even for an external sidecar
        # so AR readiness includes a real duration binding check.
        try:
            sidecar_document = probe_video(
                video,
                ffprobe_bin=ffprobe_bin,
                cancel_event=cancel_event,
            )
            sidecar_duration_ms = _duration_ms(sidecar_document)
        except FFprobeNotFoundError as exc:
            validation = validate_srt_for_ar(samples)
            result = SrtPreparationResult(
                status="tool_missing",
                message=(
                    "外置 SRT 字段可读取，但缺少 ffprobe，无法确认它与视频时长匹配；"
                    "为避免错投影，未标记 AR 就绪。"
                ),
                video_path=str(video),
                source_kind="sidecar_srt",
                ar_ready=False,
                validation=validation,
                warnings=(str(exc),),
                video_fingerprint=fingerprint,
            )
            return _finalize(output, video.stem, result)
        except FFprobeExecutionError as exc:
            validation = validate_srt_for_ar(samples)
            result = SrtPreparationResult(
                status="probe_failed",
                message=(
                    "外置 SRT 字段可读取，但视频容器无法检查，不能确认两者配套；"
                    "请使用未经损坏的原始视频。"
                ),
                video_path=str(video),
                source_kind="sidecar_srt",
                ar_ready=False,
                validation=validation,
                warnings=(str(exc),),
                video_fingerprint=fingerprint,
            )
            return _finalize(output, video.stem, result)
        if sidecar_duration_ms is None:
            validation = validate_srt_for_ar(samples)
            result = SrtPreparationResult(
                status="invalid_timeline",
                message="视频容器没有可验证的时长，无法把外置 SRT 安全绑定到原视频。",
                video_path=str(video),
                source_kind="sidecar_srt",
                ar_ready=False,
                validation=validation,
                video_fingerprint=fingerprint,
            )
            return _finalize(output, video.stem, result)
        validation = validate_srt_for_ar(samples, video_duration_ms=sidecar_duration_ms)
        status = (
            "existing_sidecar"
            if validation.ar_ready
            else "invalid_timeline"
            if not validation.timeline_valid
            else "extracted_not_ar_ready"
        )
        message = (
            "已找到并验证配套外置 SRT，可直接用于后续 AR 数据提取。"
            if validation.ar_ready
            else "外置 SRT 已读取，但未通过 AR 完整性校验；不会自动宣称精确投影可用。"
        )
        result = SrtPreparationResult(
            status=status,
            message=message,
            video_path=str(video),
            output_srt=str(sidecar) if validation.ar_ready else None,
            source_kind="sidecar_srt",
            ar_ready=validation.ar_ready,
            validation=validation,
            video_fingerprint=fingerprint,
        )
        return _finalize(output, video.stem, result)

    _check_cancellation(cancel_event, None)
    try:
        document = probe_video(video, ffprobe_bin=ffprobe_bin, cancel_event=cancel_event)
    except FFprobeNotFoundError as exc:
        result = SrtPreparationResult(
            status="tool_missing",
            message=str(exc),
            video_path=str(video),
            warnings=(str(exc),),
            video_fingerprint=fingerprint,
        )
        return _finalize(output, video.stem, result)
    except FFprobeExecutionError as exc:
        result = SrtPreparationResult(
            status="probe_failed",
            message=f"无法检查视频容器：{exc}",
            video_path=str(video),
            warnings=(str(exc),),
            video_fingerprint=fingerprint,
        )
        return _finalize(output, video.stem, result)

    duration_ms = _duration_ms(document)
    streams = list(_subtitle_streams(document))
    proprietary = _proprietary_metadata_stream_indexes(document)
    if subtitle_stream_index is not None:
        streams = [stream for stream in streams if stream.get("index") == subtitle_stream_index]
        if not streams:
            result = SrtPreparationResult(
                status="no_subtitle",
                message=f"视频中没有 stream index={subtitle_stream_index} 的标准字幕流。",
                video_path=str(video),
                selected_stream_index=subtitle_stream_index,
                video_fingerprint=fingerprint,
            )
            return _finalize(output, video.stem, result)

    if not streams:
        status = "unsupported_proprietary_metadata" if proprietary else "no_subtitle"
        message = (
            f"仅检测到 DJI 专有 djmd/数据流 {proprietary}；当前不能可靠转换为 SRT，已拒绝伪造。"
            if proprietary
            else "视频中没有标准内嵌字幕流，也没有严格同名外置 SRT；无法从画面恢复原始 DJI 遥测。"
        )
        result = SrtPreparationResult(
            status=status,
            message=message,
            video_path=str(video),
            candidates=tuple({"proprietary_stream_index": index} for index in proprietary),
            video_fingerprint=fingerprint,
        )
        return _finalize(output, video.stem, result)

    records: list[dict[str, Any]] = []
    extracted: list[tuple[Mapping[str, Any], str, list[TelemetrySample], SrtValidation, float]] = []
    warnings: list[str] = []
    for stream in streams:
        _check_cancellation(cancel_event, None)
        try:
            text = _extract_embedded_srt(
                video,
                stream,
                ffmpeg_bin,
                cancel_event=cancel_event,
            )
            stream_index = stream.get("index")
            samples = parse_dji_srt(
                text,
                source_name=f"{video.name}:subtitle:{stream_index}",
                stream_index=int(stream_index) if isinstance(stream_index, int) else None,
                source_kind="embedded_srt",
            )
            validation = validate_srt_for_ar(samples, video_duration_ms=duration_ms)
            score = score_srt_candidate(samples)
            records.append(_candidate_record(stream, validation, score))
            extracted.append((stream, text, samples, validation, score))
        except ExtractionCancelled:
            raise
        except FFmpegNotFoundError as exc:
            result = SrtPreparationResult(
                status="tool_missing",
                message=str(exc),
                video_path=str(video),
                selected_stream_index=subtitle_stream_index,
                candidates=tuple(records),
                warnings=(str(exc),),
                video_fingerprint=fingerprint,
            )
            return _finalize(output, video.stem, result)
        except ExtractionError as exc:
            warnings.append(str(exc))
            records.append(_candidate_record(stream, None, 0.0, str(exc)))

    ready = [item for item in extracted if item[3].ar_ready]
    if subtitle_stream_index is None and len(ready) > 1:
        result = SrtPreparationResult(
            status="ambiguous_streams",
            message="检测到多个满足 AR 条件的内嵌遥测流；请按报告中的 stream index 手动选择。",
            video_path=str(video),
            candidates=tuple(records),
            warnings=tuple(warnings),
            video_fingerprint=fingerprint,
        )
        return _finalize(output, video.stem, result)

    chosen = ready[0] if len(ready) == 1 else None
    if chosen is None:
        best = max(extracted, key=lambda item: item[4], default=None)
        validation = best[3] if best else None
        selected = (
            int(best[0].get("index"))
            if best and isinstance(best[0].get("index"), int)
            else subtitle_stream_index
        )
        # Ordinary dialogue can have a perfectly legitimate timeline that is
        # unrelated to the telemetry contract.  Reserve ``invalid_timeline``
        # for a DJI-shaped candidate; otherwise report the more useful fact
        # that the stream simply is not AR telemetry.
        status = (
            "invalid_timeline"
            if validation is not None
            and not validation.timeline_valid
            and best is not None
            and best[4] >= 50.0
            else "extracted_not_ar_ready"
        )
        result = SrtPreparationResult(
            status=status,
            message=(
                "字幕已读取，但 PTS 与视频不匹配或不连续，已拒绝发布以防止 AR 错位。"
                if status == "invalid_timeline"
                else "字幕流不是完整的 DJI AR 遥测（可能只是普通字幕或字段缺失），未生成 SRT。"
            ),
            video_path=str(video),
            source_kind="embedded_srt" if best else None,
            selected_stream_index=selected,
            ar_ready=False,
            validation=validation,
            candidates=tuple(records),
            warnings=tuple(warnings),
            video_fingerprint=fingerprint,
        )
        return _finalize(output, video.stem, result)

    stream, text, _samples, validation, _score = chosen
    stream_index_value = stream.get("index")
    selected_index = int(stream_index_value) if isinstance(stream_index_value, int) else None
    destination = output / f"{video.stem}_内嵌遥测.srt"
    if destination.exists() and not overwrite:
        destination = _unique_srt_path(output, video.stem)
    _check_cancellation(cancel_event, None)
    published = write_text_atomic(destination, text, overwrite=overwrite)
    # Once the complete file has been atomically published, a late cancel must
    # not retroactively turn the successful, durable output into a failure.
    result = SrtPreparationResult(
        status="extracted_embedded",
        message=f"已从标准内嵌字幕流 {selected_index} 导出并通过 AR 完整性校验。",
        video_path=str(video),
        output_srt=str(published),
        source_kind="embedded_srt",
        selected_stream_index=selected_index,
        ar_ready=True,
        validation=validation,
        candidates=tuple(records),
        warnings=tuple(warnings),
        video_fingerprint=fingerprint,
    )
    return _finalize(output, video.stem, result)


__all__ = [
    "SRT_EXPORT_SCHEMA_VERSION",
    "SrtPreparationResult",
    "SrtValidation",
    "prepare_dji_srt",
    "score_srt_candidate",
    "validate_srt_for_ar",
    "write_text_atomic",
]
