import importlib.metadata
import platform
import subprocess
import sys
from pathlib import Path
from .io import file_hash, load_json, write_json, utc_now


def doctor(config):
    output = Path(config["output_dir"])
    packages = {}
    for name in ("numpy", "opencv-python", "scipy", "av", "torch", "torchvision", "lightglue", "PyYAML", "jsonschema"):
        try:
            packages[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            packages[name] = None
    gpu = {}
    try:
        import torch
        gpu = {"cuda_available": torch.cuda.is_available(), "cuda_runtime": torch.version.cuda,
               "devices": [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())]}
    except Exception as error:
        gpu = {"error": str(error)}
    inputs = {key: {"path": config[key], "bytes": Path(config[key]).stat().st_size, "sha256": file_hash(config[key])}
              for key in ("video_path", "trajectory_path", "tileset_path")}
    model = load_json(config["tileset_path"])
    tools = {}
    for name in ("ffmpeg", "ffprobe", "node"):
        program = config.get(name + "_path")
        try:
            result = subprocess.run([program, "--version" if name == "node" else "-version"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15)
            tools[name] = {"path": program, "ok": result.returncode == 0, "version": result.stdout.splitlines()[0]}
        except Exception as error:
            tools[name] = {"path": program, "ok": False, "error": str(error)}
    report = {"schema_version": "ar-v2-doctor/v1", "captured_at": utc_now(), "platform": platform.platform(), "python": sys.version,
              "packages": packages, "gpu": gpu, "tools": tools, "inputs": inputs,
              "model": {"asset": model.get("asset"), "root_child_count": len(model.get("root", {}).get("children", [])),
                        "complete_texture_geometry_checked": False},
              "webgl": {"status": "not-probed", "required": "WebGL2, EXT_color_buffer_float, complete R32F FBO and known-distance readback"},
              "real_registration": "not-validated", "checkpoints": "not-supplied"}
    try:
        from .references import render_request, run_renderer
        run_renderer(config, render_request(config))
        report["webgl"] = load_json(output / "environment/webgl-probe.json")
        report["renderer_regression"] = load_json(output / "environment/renderer-regression.json")
    except Exception as error:
        report["webgl"] = {"status": "FAILED", "error": str(error)}
    write_json(output / "doctor.json", report)
    (output / "environment").mkdir(parents=True, exist_ok=True)
    frozen = subprocess.run([sys.executable, "-m", "pip", "freeze"], capture_output=True, text=True, timeout=30)
    (output / "environment" / "python-freeze.txt").write_text(frozen.stdout, encoding="utf-8")
    return report
