"""Data models exchanged between MQTT, recording, and WebSocket layers."""
from __future__ import annotations

import json
import math
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, Mapping, Optional


WGS84_CORNER_NAMES = ("top_left", "top_right", "bottom_right", "bottom_left")
_CORNER_ALIASES = {
    "top_left": ("top_left", "topLeft", "TL", "tl"),
    "top_right": ("top_right", "topRight", "TR", "tr"),
    "bottom_right": ("bottom_right", "bottomRight", "BR", "br"),
    "bottom_left": ("bottom_left", "bottomLeft", "BL", "bl"),
}
_EARTH_RADIUS_M = 6_378_137.0
_MAX_FOOTPRINT_SPAN_M = 250_000.0


def _strict_finite_number(value: Any, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field_name} must be a JSON number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{field_name} must be finite")
    return result


def _one_alias(mapping: Mapping[str, Any], aliases: tuple[str, ...], field_name: str) -> Any:
    present = [alias for alias in aliases if alias in mapping]
    if len(present) != 1:
        raise ValueError(f"{field_name} must be provided exactly once")
    return mapping[present[0]]


def _normalise_wgs84_crs(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("source_crs is required")
    compact = "".join(value.upper().split())
    accepted = {
        "WGS84",
        "WGS_84",
        "EPSG:4326",
        "CRS84",
        "OGC:CRS84",
        "URN:OGC:DEF:CRS:EPSG::4326",
        "URN:OGC:DEF:CRS:OGC:1.3:CRS84",
    }
    if compact not in accepted:
        raise ValueError("source_crs must identify WGS84 / EPSG:4326")
    return "EPSG:4326"


@dataclass(frozen=True)
class WGS84Point:
    latitude: float
    longitude: float
    altitude: Optional[float] = None

    @classmethod
    def from_mapping(cls, value: Any, field_name: str) -> "WGS84Point":
        if not isinstance(value, Mapping):
            raise ValueError(f"{field_name} must be an object")
        latitude = _strict_finite_number(
            _one_alias(value, ("latitude", "lat"), f"{field_name}.latitude"),
            f"{field_name}.latitude",
        )
        longitude = _strict_finite_number(
            _one_alias(value, ("longitude", "lon", "lng"), f"{field_name}.longitude"),
            f"{field_name}.longitude",
        )
        if not -90.0 <= latitude <= 90.0:
            raise ValueError(f"{field_name}.latitude is outside [-90, 90]")
        if not -180.0 <= longitude <= 180.0:
            raise ValueError(f"{field_name}.longitude is outside [-180, 180]")

        altitude_keys = [key for key in ("altitude", "height", "height_m") if key in value]
        if len(altitude_keys) > 1:
            raise ValueError(f"{field_name}.altitude must be provided at most once")
        altitude = (
            _strict_finite_number(value[altitude_keys[0]], f"{field_name}.altitude")
            if altitude_keys
            else None
        )
        return cls(latitude=latitude, longitude=longitude, altitude=altitude)

    def to_dict(self) -> Dict[str, float]:
        result = {"latitude": self.latitude, "longitude": self.longitude}
        if self.altitude is not None:
            result["altitude"] = self.altitude
        return result


@dataclass(frozen=True)
class GroundFootprintWGS84:
    top_left: WGS84Point
    top_right: WGS84Point
    bottom_right: WGS84Point
    bottom_left: WGS84Point
    timestamp_ms: int
    source_crs: str = "EPSG:4326"

    @classmethod
    def from_payload(
        cls,
        value: Any,
        *,
        source_crs: Any = None,
        footprint_timestamp_ms: Any = None,
    ) -> "GroundFootprintWGS84":
        if not isinstance(value, Mapping):
            raise ValueError("footprint must be an object")
        corners_value: Any = value.get("corners", value)
        if not isinstance(corners_value, Mapping):
            raise ValueError("footprint.corners must be an object")
        crs = _normalise_wgs84_crs(value.get("source_crs", source_crs))
        timestamp_value = value.get("footprint_timestamp_ms", value.get("timestamp_ms", footprint_timestamp_ms))
        timestamp = _strict_finite_number(timestamp_value, "footprint_timestamp_ms")
        if timestamp <= 0 or timestamp > 9_007_199_254_740_991:
            raise ValueError("footprint_timestamp_ms must be a positive safe integer")
        rounded_timestamp = round(timestamp)
        if abs(timestamp - rounded_timestamp) > 1e-6:
            raise ValueError("footprint_timestamp_ms must be an integer")

        points: Dict[str, WGS84Point] = {}
        for corner_name in WGS84_CORNER_NAMES:
            raw_corner = _one_alias(corners_value, _CORNER_ALIASES[corner_name], corner_name)
            points[corner_name] = WGS84Point.from_mapping(raw_corner, corner_name)
        cls._validate_geometry(tuple(points[name] for name in WGS84_CORNER_NAMES))
        return cls(
            top_left=points["top_left"],
            top_right=points["top_right"],
            bottom_right=points["bottom_right"],
            bottom_left=points["bottom_left"],
            timestamp_ms=rounded_timestamp,
            source_crs=crs,
        )

    @staticmethod
    def _validate_geometry(points: tuple[WGS84Point, ...]) -> None:
        mean_latitude = math.radians(sum(point.latitude for point in points) / len(points))
        reference_longitude = points[0].longitude

        def local_xy(point: WGS84Point) -> tuple[float, float]:
            longitude_delta = (point.longitude - reference_longitude + 180.0) % 360.0 - 180.0
            return (
                _EARTH_RADIUS_M * math.radians(longitude_delta) * math.cos(mean_latitude),
                _EARTH_RADIUS_M * math.radians(point.latitude - points[0].latitude),
            )

        xy = tuple(local_xy(point) for point in points)
        max_span = max(
            math.hypot(xy[index][0] - xy[other][0], xy[index][1] - xy[other][1])
            for index in range(len(xy))
            for other in range(index + 1, len(xy))
        )
        if max_span > _MAX_FOOTPRINT_SPAN_M:
            raise ValueError("footprint span exceeds 250 km")

        crosses = []
        for index in range(4):
            previous = xy[index]
            current = xy[(index + 1) % 4]
            following = xy[(index + 2) % 4]
            crosses.append(
                (current[0] - previous[0]) * (following[1] - current[1])
                - (current[1] - previous[1]) * (following[0] - current[0])
            )
        if any(abs(value) < 1e-4 for value in crosses) or not (
            all(value > 0 for value in crosses) or all(value < 0 for value in crosses)
        ):
            raise ValueError("footprint corners must form a non-degenerate convex TL/TR/BR/BL quadrilateral")

        doubled_area = abs(
            sum(
                xy[index][0] * xy[(index + 1) % 4][1]
                - xy[(index + 1) % 4][0] * xy[index][1]
                for index in range(4)
            )
        )
        if doubled_area < 0.02:
            raise ValueError("footprint area is too small")

    def corners_dict(self) -> Dict[str, Dict[str, float]]:
        return {name: getattr(self, name).to_dict() for name in WGS84_CORNER_NAMES}

    def wire_metadata(self) -> Dict[str, Any]:
        return {
            "ground_footprint_wgs84": self.corners_dict(),
            "source_crs": self.source_crs,
            "footprint_timestamp_ms": self.timestamp_ms,
        }


@dataclass
class DroneCoordinates:
    latitude: float = 0.0
    longitude: float = 0.0
    altitude: float = 0.0
    heading: float = 0.0
    pitch: float = 0.0
    roll: float = 0.0
    timestamp: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class GimbalAttitude:
    pitch: float = 0.0
    roll: float = 0.0
    yaw: float = 0.0
    timestamp: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class DroneStatus:
    device_sn: str = ""
    is_online: bool = False
    is_live: bool = False
    battery_level: int = 0
    flight_mode: str = "unknown"
    coordinates: DroneCoordinates = field(default_factory=DroneCoordinates)
    gimbal_attitude: GimbalAttitude = field(default_factory=GimbalAttitude)
    timestamp: float = field(default_factory=time.time)
    ground_footprint_wgs84: Optional[GroundFootprintWGS84] = None

    def to_dict(self) -> Dict[str, Any]:
        result = asdict(self)
        result.pop("ground_footprint_wgs84", None)
        if self.ground_footprint_wgs84 is not None:
            result.update(self.ground_footprint_wgs84.wire_metadata())
        return result


@dataclass
class VideoFrame:
    frame_data: bytes
    timestamp: float
    width: int
    height: int
    format: str = "jpeg"
    ground_footprint_wgs84: Optional[GroundFootprintWGS84] = None

    def to_dict(self) -> Dict[str, Any]:
        result = {
            "timestamp": self.timestamp,
            "width": self.width,
            "height": self.height,
            "format": self.format,
            "size": len(self.frame_data),
        }
        if self.ground_footprint_wgs84 is not None:
            result.update(self.ground_footprint_wgs84.wire_metadata())
        return result


@dataclass
class WebSocketMessage:
    type: str
    data: Dict[str, Any]
    timestamp: float = field(default_factory=time.time)

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, separators=(",", ":"))

    @classmethod
    def from_json(cls, json_str: str) -> "WebSocketMessage":
        data = json.loads(json_str)
        return cls(**data)


class MessageType:
    DRONE_STATUS = "drone_status"
    VIDEO_FRAME = "video_frame"
    COORDINATES = "coordinates"
    GIMBAL_ATTITUDE = "gimbal_attitude"
    CONNECTION_STATUS = "connection_status"
    ERROR = "error"
