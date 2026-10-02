from __future__ import annotations
import hashlib
import json
import os
import time
from pathlib import Path
from datetime import datetime, timezone


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def load_json(path):
    with Path(path).open(encoding="utf-8-sig") as stream:
        return json.load(stream, parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Non-finite JSON: " + value)))


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Atomic metadata replacement; readers never see partial job/manifest documents.
    temporary = path.with_suffix(path.suffix + "." + str(os.getpid()) + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    for attempt in range(8):
        try:
            temporary.replace(path)
            break
        except PermissionError:
            if attempt == 7:
                raise
            time.sleep(.025 * (attempt + 1))


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def content_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def contained(root, relative):
    root, target = Path(root).resolve(), (Path(root) / relative).resolve()
    if not target.is_relative_to(root):
        raise ValueError("Path is outside the configured artifact directory")
    return target


def progress(config, phase, completed, total, details=None):
    """Publish measured job progress; never substitute acceptance for process completion."""
    now = time.monotonic()
    if completed < total and now - config.get("_last_progress_write", 0) < .3:
        return
    config["_last_progress_write"] = now
    status_path = config.get("_job_status_path")
    if not status_path:
        return
    path = Path(status_path)
    status = load_json(path)
    status.update(phase=phase, progress={"kind": phase, "completed": int(completed), "total": int(total)}, updated_at=utc_now())
    if details is not None:
        status["details"] = details
    write_json(path, status)