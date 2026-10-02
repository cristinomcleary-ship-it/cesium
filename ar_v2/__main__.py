from __future__ import annotations
import argparse
import importlib
import os
import sys
import traceback
import uuid
from pathlib import Path
from .config import load_config, save_resolved
from .io import utc_now, write_json

COMMANDS = {
    "doctor": ("doctor", "doctor"), "prepare-scene": ("scene", "prepare_scene"),
    "extract-frames": ("media", "extract_frames"), "build-references": ("references", "build_references"),
    "localize": ("localization", "localize"), "refine": ("localization", "refine"),
    "track": ("localization", "track"), "validate": ("validation", "validate"),
}


def main():
    parser = argparse.ArgumentParser(description="AR V2: independent model-relative visual localization")
    parser.add_argument("command", choices=[*COMMANDS, "serve"])
    parser.add_argument("--config", default="ar_v2.project.yaml")
    parser.add_argument("--time", type=float, default=10.01)
    parser.add_argument("--matcher", choices=["sift", "aliked-lightglue"])
    parser.add_argument("--job-id")
    args = parser.parse_args()
    config = load_config(args.config)
    if args.matcher:
        config.setdefault("localization", {})["matcher"] = args.matcher
    save_resolved(config)
    os.environ.setdefault("TORCH_HOME", str(Path(config["output_dir"]) / "weights"))
    if args.command == "serve":
        from .server import serve
        return serve(config)
    job_id = args.job_id or str(uuid.uuid4())
    if any(c not in "0123456789abcdef-" for c in job_id):
        raise ValueError("Invalid job id")
    status_path = Path(config["output_dir"]) / "jobs" / job_id / "status.json"
    status = {"job_id": job_id, "command": args.command, "status": "RUNNING", "started_at": utc_now(),
              "phase": args.command, "progress": {"kind": "stage", "completed": 0, "total": 1}, "acceptance": "not-validated"}
    config["_job_status_path"] = str(status_path)
    write_json(status_path, status)
    print(f"JOB {job_id} {args.command}", flush=True)
    try:
        module_name, function_name = COMMANDS[args.command]
        module = importlib.import_module("ar_v2." + module_name)
        function = getattr(module, function_name)
        result = function(config, time_seconds=args.time) if args.command == "localize" else function(config)
        status.update(status="COMPLETED", finished_at=utc_now(), progress={"kind": "stage", "completed": 1, "total": 1}, result=result)
        print("COMPLETED " + str(status_path), flush=True)
    except Exception as error:
        status.update(status="FAILED", finished_at=utc_now(), error=str(error), traceback=traceback.format_exc())
        traceback.print_exc()
        return_code = 1
    else:
        return_code = 0
    finally:
        write_json(status_path, status)
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
