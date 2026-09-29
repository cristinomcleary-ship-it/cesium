#!/usr/bin/env python3
"""Command-line entry point for the isolated video AR backend."""
from __future__ import annotations

import argparse
import asyncio
import importlib
import importlib.metadata
import json
import os
import socket
import sys
import tempfile
from pathlib import Path
from typing import Sequence


SERVICE_ROOT = Path(__file__).resolve().parent


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="DJI 飞行轨迹与视频 AR 后端")
    parser.add_argument("--env", type=Path, help="使用指定 .env 文件（默认读取当前目录下的 .env）")
    parser.add_argument("--check", action="store_true", help="只检查配置、依赖、端口与数据目录，不连接设备")
    parser.add_argument("--print-config", action="store_true", help="打印脱敏后的有效配置并退出")
    package_group = parser.add_mutually_exclusive_group()
    package_group.add_argument("--package-latest", action="store_true", help="把最新完整航次打包为 ZIP")
    package_group.add_argument("--package", type=Path, metavar="FLIGHT_DIR", help="把指定航次目录打包为 ZIP")
    return parser


def _prepare_environment(env_file: Path | None) -> None:
    os.chdir(SERVICE_ROOT)
    if env_file:
        resolved = env_file.expanduser()
        if not resolved.is_absolute():
            resolved = (Path.cwd() / resolved).resolve()
        os.environ["DRONE_ENV_FILE"] = str(resolved)
    sys.path.insert(0, str(SERVICE_ROOT))


def _dependency_report() -> tuple[list[str], list[str]]:
    required = {
        "websockets": "websockets",
        "opencv-python-headless": "cv2",
        "paho-mqtt": "paho.mqtt.client",
        "numpy": "numpy",
    }
    errors: list[str] = []
    details: list[str] = []
    for distribution, module in required.items():
        try:
            importlib.import_module(module)
            try:
                version = importlib.metadata.version(distribution)
            except importlib.metadata.PackageNotFoundError:
                if distribution == "opencv-python-headless":
                    try:
                        version = importlib.metadata.version("opencv-python")
                    except importlib.metadata.PackageNotFoundError:
                        version = "已安装（版本未知）"
                else:
                    version = "已安装（版本未知）"
            details.append(f"{distribution}: {version}")
        except Exception as exc:
            errors.append(f"缺少或无法导入 {distribution}: {exc}")
    return errors, details


def _opencv_has_ffmpeg() -> bool:
    try:
        import cv2

        for line in cv2.getBuildInformation().splitlines():
            if line.strip().startswith("FFMPEG:"):
                return line.split(":", 1)[1].strip().upper().startswith("YES")
    except Exception:
        return False
    return False


def _check_port(host: str, port: int) -> str | None:
    family = socket.AF_INET6 if ":" in host and host != "0.0.0.0" else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind((host, port))
        return None
    except OSError as exc:
        return f"WebSocket 端口不可用 {host}:{port}: {exc}"


def run_checks() -> tuple[list[str], list[str], list[str]]:
    from backend_v1.config import config

    errors = config.validation_errors()
    warnings = config.validation_warnings()
    dependency_errors, details = _dependency_report()
    errors.extend(dependency_errors)
    if not dependency_errors and not _opencv_has_ffmpeg():
        errors.append("当前 OpenCV 未启用 FFmpeg，无法读取 RTMP/RTSP 视频流")
    errors.extend(
        result
        for result in (
            _check_port(config.websocket.host, config.websocket.status_port),
            _check_port(config.websocket.host, config.websocket.video_port),
        )
        if result
    )
    try:
        config.storage.ensure_directories()
        with tempfile.NamedTemporaryFile(prefix="write-check-", dir=config.storage.root, delete=True):
            pass
    except OSError as exc:
        errors.append(f"数据目录不可写 {config.storage.root}: {exc}")
    return errors, warnings, details


def print_check_report(errors: Sequence[str], warnings: Sequence[str], details: Sequence[str]) -> None:
    print("\n依赖:")
    for detail in details:
        print(f"  [OK] {detail}")
    if warnings:
        print("\n提醒:")
        for warning in warnings:
            print(f"  [WARN] {warning}")
    if errors:
        print("\n需要处理:")
        for error in errors:
            print(f"  [ERROR] {error}")
    else:
        print("\n[OK] 配置、依赖、端口和数据目录检查通过")


def package_flight(argument: Path | None) -> int:
    from backend_v1.config import config
    from backend_v1.packager import latest_flight_directory, package_flight as create_package

    config.storage.ensure_directories()
    if argument is None:
        target = latest_flight_directory()
        if target is None:
            print(f"没有找到完整航次: {config.storage.trajectory_dir}", file=sys.stderr)
            return 2
    else:
        target = argument.expanduser()
        if not target.is_absolute():
            target = config.storage.trajectory_dir / target
    try:
        archive = create_package(target)
    except Exception as exc:
        print(f"打包失败: {exc}", file=sys.stderr)
        return 2
    print(f"航次 ZIP: {archive}")
    return 0


def cli(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    _prepare_environment(args.env)

    from backend_v1.config import config

    if args.print_config:
        print(json.dumps(config.redacted_dict(), ensure_ascii=False, indent=2, default=str))
        return 0
    if args.package_latest:
        return package_flight(None)
    if args.package:
        return package_flight(args.package)

    errors, warnings, details = run_checks()
    print_check_report(errors, warnings, details)
    if errors:
        print("\n请复制 .env.example 为 .env 并填写真实连接参数。", file=sys.stderr)
        return 2
    if args.check:
        return 0

    from backend_v1.main import main as backend_main

    print("\nDJI 视频 AR 后端启动")
    print(f"  状态流: ws://{config.websocket.host}:{config.websocket.status_port}")
    print(f"  视频流: ws://{config.websocket.host}:{config.websocket.video_port}")
    print(f"  数据目录: {config.storage.root}")
    print("  按 Ctrl+C 安全停止并保存当前航次\n")
    try:
        asyncio.run(backend_main())
    except KeyboardInterrupt:
        print("\n服务已停止")
    except Exception as exc:
        print(f"\n服务启动或运行失败: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(cli())
