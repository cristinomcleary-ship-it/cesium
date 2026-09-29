from __future__ import annotations

import json
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any, Mapping
from unittest.mock import patch

from backend_v1 import dji_srt_exporter as exporter
from backend_v1 import dji_telemetry_extractor as telemetry


GENERIC_SUBTITLE = """1
00:00:00,000 --> 00:00:00,900
This is ordinary dialogue, not DJI telemetry.

2
00:00:00,900 --> 00:00:01,800
第二句普通字幕
"""


def _timecode(milliseconds: int) -> str:
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, millis = divmod(remainder, 1_000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def _dji_srt(
    *,
    sample_count: int = 6,
    first_start_ms: int = 0,
    step_ms: int = 33,
    latitude_offset: float = 0.0,
    include_pose: bool = True,
    include_lens: bool = True,
    reorder_last_two: bool = False,
) -> str:
    """Create a small DJI-shaped fixture without depending on removable files."""

    starts = [first_start_ms + index * step_ms for index in range(sample_count)]
    if reorder_last_two and len(starts) >= 2:
        starts[-2], starts[-1] = starts[-1], starts[-2]
    blocks: list[str] = []
    for index, start_ms in enumerate(starts):
        fields = [
            f"[latitude: {30.836687 + latitude_offset + index * 0.000001:.6f}]",
            f"[longitude: {120.890825 + index * 0.000001:.6f}]",
            "[rel_alt: 70.105 abs_alt: 99.221]",
        ]
        if include_pose:
            fields.append("[gb_yaw: -102.9 gb_pitch: -75.0 gb_roll: 0.1]")
        if include_lens:
            fields.extend(("[focal_len: 24.00]", "[dzoom_ratio: 1.00]"))
        blocks.append(
            "\n".join(
                (
                    str(index + 1),
                    f"{_timecode(start_ms)} --> {_timecode(start_ms + step_ms)}",
                    f"FrameCnt: {index} 2026-08-19 16:20:16.{562 + index:03d}",
                    " ".join(fields),
                )
            )
        )
    return "\n\n".join(blocks) + "\n"


def _probe_document(*stream_indexes: int, duration_seconds: float = 0.25) -> dict[str, Any]:
    streams: list[dict[str, Any]] = [
        {
            "index": 0,
            "codec_type": "video",
            "codec_name": "hevc",
            "width": 3840,
            "height": 2160,
            "avg_frame_rate": "30000/1001",
            "duration": str(duration_seconds),
        }
    ]
    streams.extend(
        {
            "index": index,
            "codec_type": "subtitle",
            "codec_name": "mov_text",
            "duration": str(duration_seconds),
            "tags": {"handler_name": f"subtitle-{index}"},
        }
        for index in stream_indexes
    )
    return {
        "format": {
            "filename": "DJI_0001.MP4",
            "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
            "duration": str(duration_seconds),
        },
        "streams": streams,
    }


def _value(record: Any, field: str, default: Any = None) -> Any:
    if isinstance(record, Mapping):
        return record.get(field, default)
    return getattr(record, field, default)


class CandidateValidationTests(unittest.TestCase):
    def test_dji_telemetry_scores_higher_than_ordinary_dialogue(self) -> None:
        valid = telemetry.parse_dji_srt(_dji_srt(), source_name="DJI_0001.srt")
        dialogue = telemetry.parse_dji_srt(GENERIC_SUBTITLE, source_name="captions.srt")

        self.assertGreater(
            exporter.score_srt_candidate(valid),
            exporter.score_srt_candidate(dialogue),
        )

    def test_ar_validation_requires_position_altitude_pose_and_lens(self) -> None:
        complete = telemetry.parse_dji_srt(_dji_srt())
        incomplete = telemetry.parse_dji_srt(
            _dji_srt(include_pose=False, include_lens=False)
        )

        complete_validation = exporter.validate_srt_for_ar(
            complete, video_duration_ms=250
        )
        incomplete_validation = exporter.validate_srt_for_ar(
            incomplete, video_duration_ms=250
        )

        self.assertTrue(_value(complete_validation, "ar_ready"))
        self.assertTrue(_value(complete_validation, "timeline_valid"))
        self.assertFalse(_value(incomplete_validation, "ar_ready"))
        issue_text = json.dumps(
            incomplete_validation
            if isinstance(incomplete_validation, Mapping)
            else getattr(incomplete_validation, "to_dict", lambda: {})(),
            ensure_ascii=False,
        ).lower()
        self.assertIn("gimbal", issue_text)
        self.assertIn("focal", issue_text)

    def test_validation_rejects_non_monotonic_and_out_of_video_timeline(self) -> None:
        reordered = telemetry.parse_dji_srt(_dji_srt(reorder_last_two=True))
        beyond_duration = telemetry.parse_dji_srt(
            _dji_srt(first_start_ms=5_000)
        )

        reordered_validation = exporter.validate_srt_for_ar(
            reordered, video_duration_ms=250
        )
        duration_validation = exporter.validate_srt_for_ar(
            beyond_duration, video_duration_ms=1_000
        )

        self.assertFalse(_value(reordered_validation, "timeline_valid"))
        self.assertFalse(_value(reordered_validation, "ar_ready"))
        self.assertFalse(_value(duration_validation, "timeline_valid"))
        self.assertFalse(_value(duration_validation, "ar_ready"))


class AtomicWriterTests(unittest.TestCase):
    def test_unicode_path_is_written_as_utf8_and_temp_file_is_removed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory) / "中文输出目录"
            root.mkdir()
            destination = root / "大疆航拍遥测.srt"
            content = _dji_srt()

            exporter.write_text_atomic(destination, content)

            self.assertEqual(destination.read_text(encoding="utf-8"), content)
            leftovers = [
                item
                for item in root.iterdir()
                if item != destination and ("tmp" in item.name.lower() or item.name.startswith("."))
            ]
            self.assertEqual(leftovers, [])

    def test_atomic_writer_does_not_overwrite_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            destination = Path(temporary_directory) / "DJI_0001.srt"
            destination.write_text("original", encoding="utf-8")

            with self.assertRaises(FileExistsError):
                exporter.write_text_atomic(destination, "replacement")

            self.assertEqual(destination.read_text(encoding="utf-8"), "original")


class SrtPreparationTests(unittest.TestCase):
    def _paths(self, root: Path, stem: str = "DJI_0001") -> tuple[Path, Path]:
        video = root / f"{stem}.MP4"
        output = root / "exported"
        video.write_bytes(b"video fixture; never decoded")
        output.mkdir()
        return video, output

    def test_strict_same_stem_sidecar_is_reused_after_video_duration_binding(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video, output = self._paths(root)
            exact_sidecar = root / "DJI_0001.SRT"
            exact_sidecar.write_text(_dji_srt(), encoding="utf-8")
            # A similarly named file must never win over the exact stem.
            (root / "DJI_0001_backup.srt").write_text(
                GENERIC_SUBTITLE, encoding="utf-8"
            )
            with (
                patch.object(
                    exporter, "probe_video", return_value=_probe_document()
                ) as probe,
                patch.object(exporter, "_extract_embedded_srt") as extract,
            ):
                result = exporter.prepare_dji_srt(video, output)

        self.assertEqual(result.status, "existing_sidecar")
        self.assertTrue(result.ar_ready)
        self.assertEqual(Path(result.output_srt).resolve(), exact_sidecar.resolve())
        self.assertIsNone(result.selected_stream_index)
        probe.assert_called_once()
        extract.assert_not_called()
        json.dumps(result.to_dict(), ensure_ascii=False, allow_nan=False)

    def test_similarly_named_sidecar_is_not_accepted_as_a_pair(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video, output = self._paths(root)
            (root / "DJI_0001_backup.srt").write_text(
                _dji_srt(), encoding="utf-8"
            )
            with patch.object(
                exporter, "probe_video", return_value=_probe_document()
            ):
                result = exporter.prepare_dji_srt(video, output)

        self.assertEqual(result.status, "no_subtitle")
        self.assertFalse(result.ar_ready)
        self.assertIsNone(result.output_srt)

    def test_same_stem_sidecar_with_wrong_video_duration_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video, output = self._paths(root)
            exact_sidecar = root / "DJI_0001.SRT"
            exact_sidecar.write_text(_dji_srt(), encoding="utf-8")
            with patch.object(
                exporter,
                "probe_video",
                return_value=_probe_document(duration_seconds=10.0),
            ):
                result = exporter.prepare_dji_srt(video, output)

        self.assertEqual(result.status, "invalid_timeline")
        self.assertFalse(result.ar_ready)
        self.assertIsNone(result.output_srt)

    def test_explicit_sidecar_may_have_a_different_name(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video, output = self._paths(root)
            explicit = root / "飞行任务遥测.SRT"
            explicit.write_text(_dji_srt(), encoding="utf-8")
            with patch.object(
                exporter, "probe_video", return_value=_probe_document()
            ) as probe:
                result = exporter.prepare_dji_srt(
                    video, output, explicit_sidecar=explicit
                )

        self.assertEqual(result.status, "existing_sidecar")
        self.assertTrue(result.ar_ready)
        self.assertEqual(Path(result.output_srt).resolve(), explicit.resolve())
        probe.assert_called_once()

    def test_unique_ar_ready_embedded_stream_is_exported(self) -> None:
        embedded_text = _dji_srt()
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video, output = self._paths(root)
            with (
                patch.object(
                    exporter, "probe_video", return_value=_probe_document(2)
                ),
                patch.object(
                    exporter, "_extract_embedded_srt", return_value=embedded_text
                ) as extract,
            ):
                result = exporter.prepare_dji_srt(video, output)

            exported = Path(result.output_srt)
            self.assertTrue(exported.is_file())
            self.assertEqual(exported.read_text(encoding="utf-8"), embedded_text)

        self.assertEqual(result.status, "extracted_embedded")
        self.assertTrue(result.ar_ready)
        self.assertEqual(result.selected_stream_index, 2)
        extract.assert_called_once()
        called_stream = (
            extract.call_args.args[1]
            if len(extract.call_args.args) > 1
            else extract.call_args.kwargs["stream"]
        )
        self.assertEqual(called_stream["index"], 2)

    def test_ordinary_subtitle_is_not_published_as_ar_telemetry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video, output = self._paths(root)
            with (
                patch.object(
                    exporter, "probe_video", return_value=_probe_document(2)
                ),
                patch.object(
                    exporter,
                    "_extract_embedded_srt",
                    return_value=GENERIC_SUBTITLE,
                ),
            ):
                result = exporter.prepare_dji_srt(
                    video, output, subtitle_stream_index=2
                )

            self.assertEqual(list(output.glob("*.srt")), [])

        self.assertEqual(result.status, "extracted_not_ar_ready")
        self.assertFalse(result.ar_ready)
        self.assertIsNone(result.output_srt)
        self.assertEqual(result.selected_stream_index, 2)

    def test_two_ar_ready_streams_are_reported_as_ambiguous(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video, output = self._paths(root)

            def stream_text(
                _video: Path,
                stream: Mapping[str, Any],
                _ffmpeg: str = "ffmpeg",
                **_kwargs: Any,
            ) -> str:
                return _dji_srt(latitude_offset=float(stream["index"]) / 100.0)

            with (
                patch.object(
                    exporter, "probe_video", return_value=_probe_document(2, 4)
                ),
                patch.object(
                    exporter, "_extract_embedded_srt", side_effect=stream_text
                ),
            ):
                result = exporter.prepare_dji_srt(video, output)

            self.assertEqual(list(output.glob("*.srt")), [])

        self.assertEqual(result.status, "ambiguous_streams")
        self.assertFalse(result.ar_ready)
        self.assertIsNone(result.output_srt)
        self.assertIsNone(result.selected_stream_index)

    def test_explicit_stream_index_resolves_ambiguity_and_only_extracts_that_stream(self) -> None:
        selected_text = _dji_srt(latitude_offset=0.04)
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video, output = self._paths(root)
            with (
                patch.object(
                    exporter, "probe_video", return_value=_probe_document(2, 4)
                ),
                patch.object(
                    exporter,
                    "_extract_embedded_srt",
                    return_value=selected_text,
                ) as extract,
            ):
                result = exporter.prepare_dji_srt(
                    video, output, subtitle_stream_index=4
                )

        self.assertEqual(result.status, "extracted_embedded")
        self.assertTrue(result.ar_ready)
        self.assertEqual(result.selected_stream_index, 4)
        self.assertEqual(extract.call_count, 1)
        called_stream = (
            extract.call_args.args[1]
            if len(extract.call_args.args) > 1
            else extract.call_args.kwargs["stream"]
        )
        self.assertEqual(called_stream["index"], 4)

    def test_no_subtitle_stream_returns_diagnostic_without_calling_ffmpeg(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video, output = self._paths(root)
            with (
                patch.object(
                    exporter, "probe_video", return_value=_probe_document()
                ),
                patch.object(exporter, "_extract_embedded_srt") as extract,
            ):
                result = exporter.prepare_dji_srt(video, output)

        self.assertEqual(result.status, "no_subtitle")
        self.assertFalse(result.ar_ready)
        self.assertIsNone(result.output_srt)
        extract.assert_not_called()

    def test_djmd_only_video_is_reported_as_unsupported_proprietary_metadata(self) -> None:
        document = _probe_document()
        document["streams"].append(
            {
                "index": 5,
                "codec_type": "data",
                "codec_name": "bin_data",
                "codec_tag_string": "djmd",
                "tags": {"handler_name": "DJI meta"},
            }
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video, output = self._paths(root)
            with patch.object(exporter, "probe_video", return_value=document):
                result = exporter.prepare_dji_srt(video, output)

        self.assertEqual(result.status, "unsupported_proprietary_metadata")
        self.assertFalse(result.ar_ready)
        self.assertIsNone(result.output_srt)

    def test_missing_ffprobe_is_returned_as_tool_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video, output = self._paths(root)
            with patch.object(
                exporter,
                "probe_video",
                side_effect=telemetry.FFprobeNotFoundError("ffprobe missing"),
            ):
                result = exporter.prepare_dji_srt(video, output)

        self.assertEqual(result.status, "tool_missing")
        self.assertFalse(result.ar_ready)
        self.assertIsNone(result.output_srt)

    def test_missing_ffmpeg_is_returned_as_tool_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video, output = self._paths(root)
            with (
                patch.object(
                    exporter, "probe_video", return_value=_probe_document(2)
                ),
                patch.object(
                    exporter,
                    "_extract_embedded_srt",
                    side_effect=telemetry.FFmpegNotFoundError("ffmpeg missing"),
                ),
            ):
                result = exporter.prepare_dji_srt(video, output)

        self.assertEqual(result.status, "tool_missing")
        self.assertFalse(result.ar_ready)
        self.assertIsNone(result.output_srt)

    def test_invalid_embedded_timeline_is_not_published(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video, output = self._paths(root)
            with (
                patch.object(
                    exporter, "probe_video", return_value=_probe_document(2)
                ),
                patch.object(
                    exporter,
                    "_extract_embedded_srt",
                    return_value=_dji_srt(reorder_last_two=True),
                ),
            ):
                result = exporter.prepare_dji_srt(
                    video, output, subtitle_stream_index=2
                )

            self.assertEqual(list(output.glob("*.srt")), [])

        self.assertEqual(result.status, "invalid_timeline")
        self.assertFalse(result.ar_ready)
        self.assertIsNone(result.output_srt)

    def test_existing_export_is_never_replaced_without_overwrite(self) -> None:
        first_text = _dji_srt(latitude_offset=0.0)
        second_text = _dji_srt(latitude_offset=0.01)
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video, output = self._paths(root)
            probe_patch = patch.object(
                exporter, "probe_video", return_value=_probe_document(2)
            )
            with probe_patch, patch.object(
                exporter,
                "_extract_embedded_srt",
                side_effect=[first_text, second_text],
            ):
                first = exporter.prepare_dji_srt(video, output)
                first_path = Path(first.output_srt)
                self.assertEqual(first_path.read_text(encoding="utf-8"), first_text)
                try:
                    second = exporter.prepare_dji_srt(video, output, overwrite=False)
                except FileExistsError:
                    second = None

            # Either refuse the second export or choose another target.  Both
            # policies are safe; silently replacing the first file is not.
            self.assertEqual(first_path.read_text(encoding="utf-8"), first_text)
            if second is not None and second.output_srt is not None:
                second_path = Path(second.output_srt)
                self.assertNotEqual(second_path.resolve(), first_path.resolve())
                self.assertEqual(second_path.read_text(encoding="utf-8"), second_text)

    def test_cancellation_never_publishes_a_partial_srt(self) -> None:
        cancel_event = threading.Event()

        def cancel_during_extract(*_args: Any, **_kwargs: Any) -> str:
            cancel_event.set()
            raise telemetry.ExtractionCancelled("cancelled")

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video, output = self._paths(root)
            with (
                patch.object(
                    exporter, "probe_video", return_value=_probe_document(2)
                ),
                patch.object(
                    exporter,
                    "_extract_embedded_srt",
                    side_effect=cancel_during_extract,
                ),
            ):
                with self.assertRaises(telemetry.ExtractionCancelled):
                    exporter.prepare_dji_srt(
                        video, output, cancel_event=cancel_event
                    )

            published = list(output.glob("*.srt"))
            temporary = [
                item
                for item in output.iterdir()
                if "tmp" in item.name.lower() or item.name.startswith(".")
            ]

        self.assertEqual(published, [])
        self.assertEqual(temporary, [])


if __name__ == "__main__":
    unittest.main()
