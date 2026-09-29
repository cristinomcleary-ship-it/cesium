"""Runtime configuration for the DJI video AR backend.

Configuration is read from ``video_ar_backend/.env`` and then from the
process environment. Process environment values take precedence. Secrets are
never printed by :meth:`AppConfig.redacted_dict`.
"""
from __future__ import annotations

import math
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse


SERVICE_ROOT = Path(__file__).resolve().parent.parent


def _load_env_file() -> Path:
    configured = os.environ.get("DRONE_ENV_FILE", "").strip()
    env_path = Path(configured).expanduser() if configured else SERVICE_ROOT / ".env"
    if not env_path.is_absolute():
        env_path = (SERVICE_ROOT / env_path).resolve()
    if not env_path.is_file():
        return env_path

    for raw_line in env_path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if value and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        if key:
            os.environ.setdefault(key, value)
    return env_path


ENV_FILE = _load_env_file()


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _optional_env(name: str) -> Optional[str]:
    value = _env(name)
    return value or None


def _int_env(name: str, default: int) -> int:
    value = _env(name)
    if not value:
        return default
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"{name} 必须是整数，当前值为 {value!r}") from exc


def _float_env(name: str, default: float) -> float:
    value = _env(name)
    if not value:
        return default
    try:
        return float(value)
    except ValueError as exc:
        raise ValueError(f"{name} 必须是数字，当前值为 {value!r}") from exc


def _optional_float_env(name: str) -> Optional[float]:
    value = _env(name)
    if not value:
        return None
    try:
        result = float(value)
    except ValueError as exc:
        raise ValueError(f"{name} 必须是数字或留空，当前值为 {value!r}") from exc
    if not math.isfinite(result):
        raise ValueError(f"{name} 必须是有限数字或留空，当前值为 {value!r}")
    return result


def _bool_env(name: str, default: bool = False) -> bool:
    value = _env(name)
    if not value:
        return default
    normalized = value.lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} 必须是 true/false，当前值为 {value!r}")


def _path_env(name: str, default: Path) -> Path:
    value = _env(name)
    path = Path(value).expanduser() if value else default
    if not path.is_absolute():
        path = SERVICE_ROOT / path
    return path.resolve()


@dataclass
class MQTTConfig:
    """MQTT broker and DJI topic settings."""

    host: str = field(default_factory=lambda: _env("DRONE_MQTT_HOST"))
    port: int = field(default_factory=lambda: _int_env("DRONE_MQTT_PORT", 1883))
    username: Optional[str] = field(default_factory=lambda: _optional_env("DRONE_MQTT_USERNAME"))
    password: Optional[str] = field(default_factory=lambda: _optional_env("DRONE_MQTT_PASSWORD"))
    client_id: str = field(default_factory=lambda: _env("DRONE_MQTT_CLIENT_ID", "video-ar-recorder"))
    keepalive: int = field(default_factory=lambda: _int_env("DRONE_MQTT_KEEPALIVE", 60))
    connect_timeout: float = field(default_factory=lambda: _float_env("DRONE_MQTT_CONNECT_TIMEOUT", 8.0))
    tls: bool = field(default_factory=lambda: _bool_env("DRONE_MQTT_TLS", False))
    tls_insecure: bool = field(default_factory=lambda: _bool_env("DRONE_MQTT_TLS_INSECURE", False))
    ca_cert: Optional[str] = field(default_factory=lambda: _optional_env("DRONE_MQTT_CA_CERT"))


@dataclass
class RTMPConfig:
    """Video source URL.

    ``url_template`` should contain ``{device_sn}``, for example
    ``rtmp://127.0.0.1/live/{device_sn}-81-0-0``.
    """

    url_template: str = field(default_factory=lambda: _env("DRONE_RTMP_URL_TEMPLATE"))
    base_url: str = field(default_factory=lambda: _env("DRONE_RTMP_BASE_URL"))
    stream_suffix: str = field(default_factory=lambda: _env("DRONE_RTMP_STREAM_SUFFIX", "-81-0-0"))

    def get_stream_url(self, device_sn: str) -> str:
        if self.url_template:
            try:
                return self.url_template.format(device_sn=device_sn)
            except (KeyError, ValueError) as exc:
                raise ValueError("DRONE_RTMP_URL_TEMPLATE 只能使用 {device_sn} 占位符") from exc
        return f"{self.base_url.rstrip('/')}/{device_sn}{self.stream_suffix}"


@dataclass
class WebSocketConfig:
    """WebSocket endpoints consumed by the Cesium video AR panel."""

    host: str = field(default_factory=lambda: _env("DRONE_WS_HOST", "127.0.0.1"))
    status_port: int = field(default_factory=lambda: _int_env("DRONE_WS_STATUS_PORT", 8765))
    video_port: int = field(default_factory=lambda: _int_env("DRONE_WS_VIDEO_PORT", 8766))
    max_size: int = field(default_factory=lambda: _int_env("DRONE_WS_MAX_MESSAGE_BYTES", 10 * 1024 * 1024))
    send_timeout: float = field(default_factory=lambda: _float_env("DRONE_WS_SEND_TIMEOUT", 0.5))

    @property
    def port(self) -> int:
        """Backward-compatible alias used by the original status server."""
        return self.status_port


@dataclass
class VideoConfig:
    """Bounded video decoding, persistence, and broadcast settings."""

    frame_width: int = field(default_factory=lambda: _int_env("DRONE_FRAME_WIDTH", 1280))
    frame_height: int = field(default_factory=lambda: _int_env("DRONE_FRAME_HEIGHT", 720))
    save_fps: float = field(default_factory=lambda: _float_env("DRONE_SAVE_FPS", 2.0))
    broadcast_fps: float = field(default_factory=lambda: _float_env("DRONE_BROADCAST_FPS", 10.0))
    quality: int = field(default_factory=lambda: _int_env("DRONE_JPEG_QUALITY", 80))
    open_timeout_ms: int = field(default_factory=lambda: _int_env("DRONE_VIDEO_OPEN_TIMEOUT_MS", 10_000))
    read_timeout_ms: int = field(default_factory=lambda: _int_env("DRONE_VIDEO_READ_TIMEOUT_MS", 5_000))
    retry_interval: float = field(default_factory=lambda: _float_env("DRONE_VIDEO_RETRY_SECONDS", 5.0))
    max_retries: int = field(default_factory=lambda: _int_env("DRONE_VIDEO_MAX_RETRIES", 0))
    cache_max_frames: int = field(default_factory=lambda: _int_env("DRONE_VIDEO_CACHE_MAX_FRAMES", 600))
    frame_match_max_age_ms: int = field(default_factory=lambda: _int_env("DRONE_FRAME_MATCH_MAX_AGE_MS", 1500))

    @property
    def fps(self) -> float:
        """Backward-compatible alias for old code."""
        return self.broadcast_fps


@dataclass
class TelemetryConfig:
    """DJI OSD field selection and height calibration."""

    altitude_field: str = field(default_factory=lambda: _env("DRONE_ALTITUDE_FIELD", "height"))
    altitude_offset_m: float = field(default_factory=lambda: _float_env("DRONE_ALTITUDE_OFFSET_M", 0.0))
    ground_altitude_m: Optional[float] = field(default_factory=lambda: _optional_float_env("DRONE_GROUND_ALTITUDE_M"))
    payload_index: Optional[str] = field(default_factory=lambda: _optional_env("DRONE_PAYLOAD_INDEX"))


@dataclass
class StorageConfig:
    """Runtime data paths, all isolated from the Vite/Cesium source tree."""

    root: Path = field(default_factory=lambda: _path_env("DRONE_DATA_DIR", SERVICE_ROOT / "data"))
    auto_zip: bool = field(default_factory=lambda: _bool_env("DRONE_AUTO_ZIP", False))
    checkpoint_seconds: float = field(default_factory=lambda: _float_env("DRONE_CHECKPOINT_SECONDS", 30.0))
    log_max_bytes: int = field(default_factory=lambda: _int_env("DRONE_LOG_MAX_BYTES", 5 * 1024 * 1024))
    log_backups: int = field(default_factory=lambda: _int_env("DRONE_LOG_BACKUPS", 3))

    @property
    def video_cache_dir(self) -> Path:
        return self.root / "video_cache"

    @property
    def trajectory_dir(self) -> Path:
        return self.root / "trajectory"

    @property
    def log_dir(self) -> Path:
        return self.root / "logs"

    @property
    def log_file(self) -> Path:
        return self.log_dir / "drone_backend.log"

    def ensure_directories(self) -> None:
        for directory in (self.root, self.video_cache_dir, self.trajectory_dir, self.log_dir):
            directory.mkdir(parents=True, exist_ok=True)


@dataclass
class AppConfig:
    """Top-level application configuration."""

    target_device_sn: str = field(default_factory=lambda: _env("DRONE_DEVICE_SN"))
    log_level: str = field(default_factory=lambda: _env("DRONE_LOG_LEVEL", "INFO").upper())
    mqtt: MQTTConfig = field(default_factory=MQTTConfig)
    rtmp: RTMPConfig = field(default_factory=RTMPConfig)
    websocket: WebSocketConfig = field(default_factory=WebSocketConfig)
    video: VideoConfig = field(default_factory=VideoConfig)
    telemetry: TelemetryConfig = field(default_factory=TelemetryConfig)
    storage: StorageConfig = field(default_factory=StorageConfig)

    def validation_errors(self) -> list[str]:
        errors: list[str] = []
        placeholders = {"", "XXXXXXXXXXXXXXXX", "REPLACE_ME", "请填写"}
        if self.target_device_sn.upper() in placeholders or "REPLACE" in self.target_device_sn.upper():
            errors.append("DRONE_DEVICE_SN 未填写")
        elif not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", self.target_device_sn):
            errors.append("DRONE_DEVICE_SN 只能包含字母、数字、点、下划线和连字符")
        if (
            self.mqtt.host.upper() in placeholders
            or "XXXX" in self.mqtt.host.upper()
            or "REPLACE" in self.mqtt.host.upper()
        ):
            errors.append("DRONE_MQTT_HOST 未填写")
        if self.mqtt.password and not self.mqtt.username:
            errors.append("设置 DRONE_MQTT_PASSWORD 时也必须设置 DRONE_MQTT_USERNAME")
        if self.mqtt.tls_insecure and not self.mqtt.tls:
            errors.append("DRONE_MQTT_TLS_INSECURE=true 仅能与 DRONE_MQTT_TLS=true 一起使用")
        if self.mqtt.ca_cert and not Path(self.mqtt.ca_cert).expanduser().is_file():
            errors.append(f"DRONE_MQTT_CA_CERT 文件不存在: {self.mqtt.ca_cert}")

        try:
            stream_url = self.rtmp.get_stream_url(self.target_device_sn or "DEVICE_SN")
        except ValueError as exc:
            errors.append(str(exc))
            stream_url = ""
        if not self.rtmp.url_template and not self.rtmp.base_url:
            errors.append("DRONE_RTMP_URL_TEMPLATE 未填写")
        elif "XXXX" in stream_url.upper() or "REPLACE" in stream_url.upper():
            errors.append("RTMP 地址仍包含占位值")
        elif urlparse(stream_url).scheme.lower() not in {"rtmp", "rtmps", "rtsp", "http", "https"}:
            errors.append("视频流地址必须以 rtmp://、rtmps://、rtsp://、http:// 或 https:// 开头")

        for name, port in (
            ("DRONE_MQTT_PORT", self.mqtt.port),
            ("DRONE_WS_STATUS_PORT", self.websocket.status_port),
            ("DRONE_WS_VIDEO_PORT", self.websocket.video_port),
        ):
            if not 1 <= port <= 65535:
                errors.append(f"{name} 必须在 1 到 65535 之间")
        if self.websocket.status_port == self.websocket.video_port:
            errors.append("状态 WebSocket 与视频 WebSocket 不能使用同一端口")
        if not 160 <= self.video.frame_width <= 4096 or not 120 <= self.video.frame_height <= 2160:
            errors.append("视频输出分辨率不在安全范围内")
        if not 0 <= self.video.save_fps <= 30:
            errors.append("DRONE_SAVE_FPS 必须在 0 到 30 之间")
        if not 1 <= self.video.broadcast_fps <= 30:
            errors.append("DRONE_BROADCAST_FPS 必须在 1 到 30 之间")
        if not 30 <= self.video.quality <= 95:
            errors.append("DRONE_JPEG_QUALITY 必须在 30 到 95 之间")
        if self.video.cache_max_frames < 20:
            errors.append("DRONE_VIDEO_CACHE_MAX_FRAMES 不能小于 20")
        if not 100 <= self.video.frame_match_max_age_ms <= 10_000:
            errors.append("DRONE_FRAME_MATCH_MAX_AGE_MS 必须在 100 到 10000 之间")
        if self.log_level not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
            errors.append("DRONE_LOG_LEVEL 必须是 DEBUG/INFO/WARNING/ERROR/CRITICAL")
        return errors

    def validation_warnings(self) -> list[str]:
        warnings: list[str] = []
        if self.websocket.host in {"0.0.0.0", "::"}:
            warnings.append("WebSocket 正在监听所有网卡；请通过防火墙限制 8765/8766 的访问")
        if self.mqtt.tls_insecure:
            warnings.append("MQTT TLS 证书校验已关闭，仅建议用于受控测试环境")
        if self.video.save_fps > 10:
            warnings.append("高于 10 FPS 的逐帧保存会显著增加磁盘压力")
        if (
            self.telemetry.altitude_field == "height"
            and self.telemetry.altitude_offset_m == 0
            and self.telemetry.ground_altitude_m is None
        ):
            warnings.append("DJI height 常为相对起飞点高度；请确认 Cesium 所需高程基准")
        return warnings

    def redacted_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["mqtt"]["password"] = "***" if self.mqtt.password else None
        payload["storage"]["root"] = str(self.storage.root)
        payload["env_file"] = str(ENV_FILE)
        return payload


config = AppConfig()
