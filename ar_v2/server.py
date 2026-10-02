from __future__ import annotations
import json
import subprocess
import sys
import threading
import uuid
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit, unquote, parse_qs
from .io import contained, load_json, write_json, utc_now


def serve(config):
    root = Path(config["output_dir"])
    processes = {}
    lock = threading.Lock()
    allowed = {"doctor", "prepare-scene", "extract-frames", "build-references", "localize", "refine", "track", "validate"}
    origins = {f"http://{host}:{port}" for host in ("localhost", "127.0.0.1") for port in (5173, 5198, 5199)}

    class Handler(BaseHTTPRequestHandler):
        def end_headers(self):
            origin = self.headers.get("Origin")
            if origin in origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            super().end_headers()

        def send_json(self, code, value):
            payload = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_OPTIONS(self):
            if self.headers.get("Origin") not in origins:
                return self.send_json(403, {"error": "Unknown origin"})
            self.send_response(204)
            self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_GET(self):
            pathname = unquote(urlsplit(self.path).path)
            if pathname == "/api/status":
                products = {}
                for name in ("doctor.json", "scene/scene_manifest.json", "media/video_manifest.json", "media/camera_profiles.json", "validation/report.json"):
                    if (root / name).is_file():
                        try:
                            product = load_json(root / name)
                            if name == "scene/scene_manifest.json":
                                product = {**{key: product.get(key) for key in ("status", "geometry_version", "appearance_version", "bounds", "geometry")},
                                           "chunks": [{"uri": chunk["uri"]} for chunk in product.get("chunks", [])]}
                            products[name] = product
                        except Exception as error:
                            products[name] = {"error": str(error)}
                jobs = [load_json(p) for p in sorted((root / "jobs").glob("*/status.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:20]]
                for job in jobs:
                    if "result" in job:
                        result = job.pop("result")
                        job["result_summary"] = {key: result.get(key) for key in ("status", "acceptance_status", "metrics") if key in result} if isinstance(result, dict) else None
                    job.pop("traceback", None)
                return self.send_json(200, {"schema_version": "ar-v2-status/v1", "products": products, "jobs": jobs,
                    "input_names": {key: Path(config[key]).name for key in ("video_path", "trajectory_path", "tileset_path")}})
            if pathname == "/api/poses":
                poses = []
                for file in sorted(root.glob("localization/**/pose.json")) + sorted(root.glob("tracking/**/pose.json")) + sorted(root.glob("refinement/**/pose.json")):
                    pose = load_json(file)
                    for key, value in pose.get("artifacts", {}).items():
                        path = Path(value)
                        if path.is_absolute():
                            pose["artifacts"][key] = path.resolve().relative_to(root.resolve()).as_posix()
                    poses.append({"path": file.relative_to(root).as_posix(), "pose": pose})
                return self.send_json(200, {"poses": poses})
            if pathname == "/api/frame":
                try:
                    query = parse_qs(urlsplit(self.path).query)
                    pts = int(query["pts"][0])
                    profile_id = query["profile"][0]
                    from .media import find_extracted_frame
                    frame = find_extracted_frame(config, pts, profile_id)
                    return self.send_json(200, frame)
                except Exception as error:
                    return self.send_json(400, {"error": str(error)})
            if pathname.startswith("/artifacts/"):
                try:
                    file = contained(root, pathname[len("/artifacts/"):])
                    if not file.is_file():
                        return self.send_json(404, {"error": "Artifact not found"})
                    import mimetypes
                    self.send_response(200)
                    self.send_header("Content-Type", mimetypes.guess_type(file.name)[0] or "application/octet-stream")
                    self.send_header("Content-Length", str(file.stat().st_size))
                    self.end_headers()
                    with file.open("rb") as stream:
                        while block := stream.read(1024 * 1024):
                            self.wfile.write(block)
                except (ValueError, OSError) as error:
                    return self.send_json(400, {"error": str(error)})
                return
            self.send_json(404, {"error": "Unknown endpoint"})

        def do_POST(self):
            if self.headers.get("Origin") and self.headers["Origin"] not in origins:
                return self.send_json(403, {"error": "Unknown origin"})
            try:
                length = int(self.headers.get("Content-Length", 0))
                if not 0 < length < 65536:
                    raise ValueError("Invalid request size")
                request = json.loads(self.rfile.read(length))
                pathname = urlsplit(self.path).path
                if pathname == "/api/jobs":
                    command = request.get("command")
                    if command not in allowed:
                        raise ValueError("Unknown command")
                    with lock:
                        if any(process.poll() is None for process in processes.values()):
                            return self.send_json(409, {"error": "已有任务运行，先等待或取消，避免缓存并发写入"})
                        job_id = str(uuid.uuid4())
                        folder = root / "jobs" / job_id
                        folder.mkdir(parents=True)
                        argv = [sys.executable, "-m", "ar_v2", command, "--config", config["config_path"], "--job-id", job_id]
                        if command == "localize":
                            argv += ["--time", str(float(request.get("time", 10.01)))]
                        if request.get("matcher") in ("sift", "aliked-lightglue"):
                            argv += ["--matcher", request["matcher"]]
                        write_json(folder / "status.json", {"job_id": job_id, "command": command, "status": "QUEUED", "started_at": utc_now()})
                        with (folder / "run.log").open("wb") as log:
                            process = subprocess.Popen(argv, cwd=config["project_root"], stdout=log, stderr=subprocess.STDOUT,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                        processes[job_id] = process
                    return self.send_json(202, {"job_id": job_id})
                if pathname == "/api/cancel":
                    job_id = request.get("job_id")
                    with lock:
                        process = processes.get(job_id)
                        if process is None or process.poll() is not None:
                            raise ValueError("No running job with that ID")
                        if sys.platform == "win32":
                            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, check=True)
                        else:
                            process.terminate()
                        process.wait(timeout=10)
                        status_path = root / "jobs" / job_id / "status.json"
                        status = load_json(status_path) if status_path.exists() else {"job_id": job_id}
                        status.update(status="CANCELLED", finished_at=utc_now())
                        write_json(status_path, status)
                    return self.send_json(200, status)
                self.send_json(404, {"error": "Unknown endpoint"})
            except Exception as error:
                self.send_json(400, {"error": str(error)})

    port = int(config.get("runtime", {}).get("api_port", 5199))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"AR V2 API http://127.0.0.1:{port} | viewer http://127.0.0.1:5173/ar-v2.html", flush=True)
    try:
        server.serve_forever()
    finally:
        for process in processes.values():
            if process.poll() is None:
                process.terminate()
        server.server_close()
