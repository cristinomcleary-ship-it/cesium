from __future__ import annotations
from pathlib import Path
import shutil
import yaml
from .io import load_json, write_json


def load_config(filename="ar_v2.project.yaml"):
    filename = Path(filename).resolve()
    config = yaml.safe_load(filename.read_text(encoding="utf-8-sig"))
    if not isinstance(config, dict) or config.get("schema_version") != "ar-v2-project/v1":
        raise ValueError("Expected ar-v2-project/v1 configuration")
    root = filename.parent
    resolve = lambda value: str((root / str(value)).resolve())
    config["config_path"], config["project_root"] = str(filename), str(root)
    data = Path(resolve(config.get("inputs", {}).get("project_data", "project-data")))
    inputs = config.setdefault("inputs", {})
    view = load_json(data / "view.json") if (data / "view.json").exists() else {}
    def record_file(record, slot):
        folder = data / "records" / record["id"] / slot
        result = (folder / record["files"][slot]["name"]).resolve()
        if not result.is_relative_to(folder.resolve()):
            raise ValueError("Invalid record file path")
        return str(result)
    active = None
    if not inputs.get("video") or not inputs.get("trajectory"):
        active_id = view.get("activeVideoId")
        if not isinstance(active_id, str) or any(c in active_id for c in "/\\:"):
            raise ValueError("Select a saved drone video or configure explicit video and trajectory paths")
        active = load_json(data / "records" / active_id / "record.json")
        if active.get("kind") != "Drone Video":
            raise ValueError("Active record is not a drone video")
    config["video_path"] = resolve(inputs["video"]) if inputs.get("video") else record_file(active, "video")
    config["trajectory_path"] = resolve(inputs["trajectory"]) if inputs.get("trajectory") else record_file(active, "source")
    if inputs.get("tileset"):
        config["tileset_path"] = resolve(inputs["tileset"])
    else:
        models = [load_json(f) for f in sorted((data / "records").glob("*/record.json"))]
        models = [r for r in models if r.get("kind") == "3D Tiles"]
        model_id = inputs.get("model_record_id")
        if model_id:
            models = [r for r in models if r.get("id") == model_id]
        if len(models) != 1:
            raise ValueError("Configure inputs.tileset or model_record_id when there is not exactly one saved model")
        config["tileset_path"] = record_file(models[0], "tiles")
    config["active_record_id"] = active.get("id") if active else None
    config["output_dir"] = resolve(config.get("output_dir", "output/ar-v2"))
    output = Path(config["output_dir"])
    if output.is_relative_to(data) or any(output.is_relative_to(Path(config[key]).parent) for key in ("video_path", "trajectory_path", "tileset_path")):
        raise ValueError("Output directory must be separate from original inputs")
    for key in ("video_path", "trajectory_path", "tileset_path"):
        if not Path(config[key]).is_file():
            raise FileNotFoundError(config[key])
    scene = config.setdefault("scene", {})
    origin = scene.get("origin_wgs84")
    if origin is None:
        trajectory = load_json(config["trajectory_path"])
        point = trajectory["trajectory_points"][0]
        position = point.get("position", point.get("coordinates"))
        origin = [position["longitude"], position["latitude"], 0.0]
        scene["origin_source"] = "Chosen ENU reference at trajectory longitude/latitude and ellipsoidal zero; not a surveyed ground height."
    config["origin_wgs84"] = origin
    for name in ("ffmpeg", "ffprobe", "node"):
        value = config.get("runtime", {}).get(name)
        candidate = root / "video_ar_backend" / "tools" / "FFmpeg" / "bin" / (name + ".exe")
        config[name + "_path"] = resolve(value) if value else shutil.which(name) or (str(candidate) if candidate.is_file() else None)
    weight_lock = Path(__file__).with_name("weights.lock.json")
    if weight_lock.is_file():
        config.setdefault("localization", {}).setdefault("weight_sha256", load_json(weight_lock)["weight_sha256"])
    return config


def save_resolved(config):
    path = Path(config["output_dir"]) / "resolved-config.json"
    write_json(path, config)
    return path
