"""Create browser-loadable ZIP packages from completed flight folders."""
from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Optional

from .config import config


def is_flight_directory(path: Path) -> bool:
    return path.is_dir() and any(path.glob("trajectory_*.json")) and (path / "video_frames").is_dir()


def latest_flight_directory() -> Optional[Path]:
    root = config.storage.trajectory_dir
    candidates = [path for path in root.glob("flight_*") if is_flight_directory(path)]
    return max(candidates, key=lambda path: path.stat().st_mtime) if candidates else None


def package_flight(flight_directory: Path) -> Path:
    flight_directory = flight_directory.resolve()
    trajectory_root = config.storage.trajectory_dir.resolve()
    if flight_directory.parent != trajectory_root:
        raise ValueError(f"航次目录必须直接位于 {trajectory_root}")
    if not is_flight_directory(flight_directory):
        raise ValueError(f"不是完整航次目录: {flight_directory}")

    destination = trajectory_root / f"{flight_directory.name}.zip"
    temporary_base = trajectory_root / f".{flight_directory.name}.packaging"
    temporary_zip = Path(f"{temporary_base}.zip")
    temporary_zip.unlink(missing_ok=True)
    try:
        archive = Path(
            shutil.make_archive(
                str(temporary_base),
                "zip",
                root_dir=trajectory_root,
                base_dir=flight_directory.name,
            )
        )
        os.replace(archive, destination)
    finally:
        temporary_zip.unlink(missing_ok=True)
    return destination
