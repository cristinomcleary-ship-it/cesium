"""DJI Cloud API MQTT client with bounded, thread-safe event delivery."""
from __future__ import annotations

import asyncio
import copy
import inspect
import json
import logging
import threading
import time
from typing import Any, Awaitable, Callable, Dict, Optional

from paho.mqtt import client as mqtt

from .config import config
from .models import DroneCoordinates, DroneStatus, GimbalAttitude, GroundFootprintWGS84


logger = logging.getLogger(__name__)
StatusCallback = Callable[[DroneStatus], Optional[Awaitable[None]]]
_FOOTPRINT_KEYS = ("ground_footprint_wgs84", "footprint_wgs84")


def _number(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
        return result if result == result and result not in {float("inf"), float("-inf")} else default
    except (TypeError, ValueError):
        return default


def _payload_time(payload: Dict[str, Any]) -> float:
    raw = _number(payload.get("timestamp"), 0.0)
    if raw <= 0:
        return time.time()
    if raw > 100_000_000_000_000:
        return raw / 1_000_000.0
    if raw > 100_000_000_000:
        return raw / 1_000.0
    return raw


class MQTTClient:
    """Receive OSD/state messages for one configured DJI device."""

    def __init__(self) -> None:
        self.client: Optional[mqtt.Client] = None
        self.is_connected = False
        self.status_callback: Optional[StatusCallback] = None
        self.current_status = DroneStatus(device_sn=config.target_device_sn)
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._connected_event = threading.Event()
        self._connect_error: Optional[str] = None
        self._manual_disconnect = False
        self._delivery_lock = threading.Lock()
        self._pending_status: Optional[DroneStatus] = None
        self._delivery_scheduled = False
        self.device_online_status: Dict[str, Dict[str, Any]] = {}
        self.device_live_status: Dict[str, Dict[str, Any]] = {}

    def set_event_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def set_status_callback(self, callback: StatusCallback) -> None:
        self.status_callback = callback

    def connect(self) -> bool:
        """Connect and wait for CONNACK instead of reporting a false success."""
        try:
            self._connected_event.clear()
            self._connect_error = None
            self._manual_disconnect = False
            self.client = mqtt.Client(
                callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
                client_id=config.mqtt.client_id,
                protocol=mqtt.MQTTv311,
            )
            self.client.on_connect = self._on_connect
            self.client.on_disconnect = self._on_disconnect
            self.client.on_message = self._on_message
            self.client.reconnect_delay_set(min_delay=1, max_delay=30)

            if config.mqtt.username:
                self.client.username_pw_set(config.mqtt.username, config.mqtt.password)
            if config.mqtt.tls:
                self.client.tls_set(ca_certs=config.mqtt.ca_cert or None)
                self.client.tls_insecure_set(config.mqtt.tls_insecure)

            logger.info("连接 MQTT 服务器 %s:%s", config.mqtt.host, config.mqtt.port)
            result = self.client.connect(config.mqtt.host, config.mqtt.port, config.mqtt.keepalive)
            if result != mqtt.MQTT_ERR_SUCCESS:
                raise RuntimeError(mqtt.error_string(result))
            self.client.loop_start()

            if not self._connected_event.wait(config.mqtt.connect_timeout):
                self._connect_error = f"等待 CONNACK 超时（{config.mqtt.connect_timeout:g} 秒）"
            if not self.is_connected:
                logger.error("MQTT 连接失败: %s", self._connect_error or "未知错误")
                self.disconnect()
                return False
            return True
        except Exception as exc:
            logger.error("MQTT 连接失败: %s", exc)
            self.disconnect()
            return False

    def disconnect(self) -> None:
        client, self.client = self.client, None
        self._manual_disconnect = True
        self.is_connected = False
        if not client:
            return
        try:
            client.disconnect()
        except Exception:
            logger.debug("MQTT disconnect 调用失败", exc_info=True)
        try:
            client.loop_stop()
        except Exception:
            logger.debug("MQTT loop_stop 调用失败", exc_info=True)

    @staticmethod
    def _reason_failed(reason_code: Any) -> bool:
        if hasattr(reason_code, "is_failure"):
            return bool(reason_code.is_failure)
        try:
            return int(reason_code) != 0
        except (TypeError, ValueError):
            return bool(reason_code)

    def _on_connect(self, client, userdata, flags, reason_code, properties) -> None:
        if not self._reason_failed(reason_code):
            self.is_connected = True
            logger.info("MQTT 连接成功")
            self._subscribe_topics()
        else:
            self._connect_error = str(reason_code)
            logger.error("MQTT CONNACK 被拒绝: %s", reason_code)
        self._connected_event.set()

    def _on_disconnect(self, client, userdata, disconnect_flags, reason_code, properties) -> None:
        was_connected = self.is_connected
        self.is_connected = False
        if was_connected or self._reason_failed(reason_code):
            logger.warning("MQTT 连接断开: %s", reason_code)
        if was_connected and not self._manual_disconnect:
            self.current_status.is_online = False
            self.current_status.ground_footprint_wgs84 = None
            self.current_status.timestamp = time.time()
            self.device_online_status[config.target_device_sn] = {
                "online": False,
                "timestamp": self.current_status.timestamp,
            }
            self._emit_status()

    def _subscribe_topics(self) -> None:
        if not self.client:
            return
        device_sn = config.target_device_sn
        topics = (
            f"thing/product/{device_sn}/osd",
            f"thing/product/{device_sn}/state",
            f"sys/product/{device_sn}/status",
        )
        for topic in topics:
            result, _mid = self.client.subscribe(topic, qos=0)
            if result == mqtt.MQTT_ERR_SUCCESS:
                logger.info("订阅主题: %s", topic)
            else:
                logger.error("订阅主题失败 %s: %s", topic, mqtt.error_string(result))

    @staticmethod
    def _topic_device_sn(topic: str) -> str:
        parts = topic.split("/")
        return parts[2] if len(parts) >= 4 and parts[1] == "product" else ""

    def _on_message(self, client, userdata, msg) -> None:
        try:
            topic = msg.topic
            topic_device = self._topic_device_sn(topic)
            if topic_device and topic_device != config.target_device_sn:
                logger.debug("忽略其他设备消息: %s", topic_device)
                return
            payload = json.loads(msg.payload.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("消息根节点不是 JSON 对象")
            if topic.endswith("/osd"):
                self._handle_osd_message(payload)
            elif topic.endswith("/status"):
                self._handle_status_message(payload)
            elif topic.endswith("/state"):
                self._handle_state_message(payload)
        except Exception as exc:
            logger.error("处理 MQTT 消息失败（%s）: %s", getattr(msg, "topic", "?"), exc)

    def _handle_osd_message(self, payload: Dict[str, Any]) -> None:
        data = payload.get("data", {})
        if not isinstance(data, dict):
            logger.warning("OSD data 不是对象，已忽略")
            return
        source_time = _payload_time(payload)
        previous = self.current_status
        coordinates = copy.deepcopy(previous.coordinates)

        altitude_field = config.telemetry.altitude_field
        coordinate_keys = {
            "latitude", "longitude", altitude_field, "height", "altitude",
            "attitude_head", "attitude_pitch", "attitude_roll",
        }
        coordinates_changed = any(key in data for key in coordinate_keys)
        if "latitude" in data:
            coordinates.latitude = _number(data.get("latitude"), coordinates.latitude)
        if "longitude" in data:
            coordinates.longitude = _number(data.get("longitude"), coordinates.longitude)
        altitude_value = data.get(altitude_field, data.get("height", data.get("altitude")))
        if altitude_value is not None:
            coordinates.altitude = _number(altitude_value, coordinates.altitude) + config.telemetry.altitude_offset_m
        if "attitude_head" in data:
            coordinates.heading = _number(data.get("attitude_head"), coordinates.heading)
        if "attitude_pitch" in data:
            coordinates.pitch = _number(data.get("attitude_pitch"), coordinates.pitch)
        if "attitude_roll" in data:
            coordinates.roll = _number(data.get("attitude_roll"), coordinates.roll)
        if coordinates_changed:
            coordinates.timestamp = source_time

        gimbal = copy.deepcopy(previous.gimbal_attitude)
        payload_data: Optional[Dict[str, Any]] = None
        if config.telemetry.payload_index:
            candidate = data.get(config.telemetry.payload_index)
            if isinstance(candidate, dict):
                payload_data = candidate
        if payload_data is None:
            for value in data.values():
                if isinstance(value, dict) and any(key in value for key in ("gimbal_pitch", "gimbal_roll", "gimbal_yaw")):
                    payload_data = value
                    break
        if payload_data is not None:
            gimbal.pitch = _number(payload_data.get("gimbal_pitch"), gimbal.pitch)
            gimbal.roll = _number(payload_data.get("gimbal_roll"), gimbal.roll)
            gimbal.yaw = _number(payload_data.get("gimbal_yaw"), gimbal.yaw)
            gimbal.timestamp = source_time

        previous.coordinates = coordinates
        previous.gimbal_attitude = gimbal
        self._apply_ground_footprint(payload)
        previous.is_online = True
        previous.timestamp = source_time
        battery = data.get("battery")
        if isinstance(battery, dict):
            if "capacity_percent" in battery:
                previous.battery_level = int(_number(battery.get("capacity_percent"), previous.battery_level))
            elif isinstance(battery.get("batteries"), list) and battery["batteries"]:
                levels = [
                    int(_number(item.get("capacity_percent"), 0))
                    for item in battery["batteries"]
                    if isinstance(item, dict)
                ]
                if levels:
                    previous.battery_level = min(levels)
        if "mode_code" in data:
            previous.flight_mode = str(data["mode_code"])
        elif "gear" in data:
            previous.flight_mode = str(data["gear"])
        self._emit_status()

    @staticmethod
    def _extract_online(data: Any) -> Optional[bool]:
        if isinstance(data, dict):
            for key in ("online", "is_online", "online_status"):
                if key in data:
                    value = data[key]
                    if isinstance(value, str):
                        return value.lower() in {"online", "true", "1", "connected"}
                    return bool(value)
            if "status" in data:
                value = data["status"]
                if isinstance(value, str) and value.lower() in {"online", "offline", "connected", "disconnected"}:
                    return value.lower() in {"online", "connected"}
                if isinstance(value, bool):
                    return value
            for value in data.values():
                nested = MQTTClient._extract_online(value)
                if nested is not None:
                    return nested
        elif isinstance(data, list):
            for value in data:
                nested = MQTTClient._extract_online(value)
                if nested is not None:
                    return nested
        return None

    def _handle_status_message(self, payload: Dict[str, Any]) -> None:
        source_time = _payload_time(payload)
        self._apply_ground_footprint(payload)
        online = self._extract_online(payload.get("data", {}))
        if online is None:
            online = True
        self.current_status.is_online = online
        if not online:
            self.current_status.ground_footprint_wgs84 = None
        self.current_status.timestamp = source_time
        self.device_online_status[config.target_device_sn] = {"online": online, "timestamp": source_time}
        self._emit_status()

    @staticmethod
    def _nested_dicts(value: Any, max_depth: int = 3, max_nodes: int = 128) -> list[Dict[str, Any]]:
        """Return bounded payload dictionaries without walking arbitrary user depth."""
        if not isinstance(value, dict):
            return []
        result: list[Dict[str, Any]] = []
        queue: list[tuple[Dict[str, Any], int]] = [(value, 0)]
        seen: set[int] = set()
        while queue and len(result) < max_nodes:
            current, depth = queue.pop(0)
            identity = id(current)
            if identity in seen:
                continue
            seen.add(identity)
            result.append(current)
            if depth >= max_depth:
                continue
            for child in current.values():
                if isinstance(child, dict):
                    queue.append((child, depth + 1))
                elif isinstance(child, list):
                    queue.extend((item, depth + 1) for item in child if isinstance(item, dict))
        return result

    def _apply_ground_footprint(self, payload: Dict[str, Any]) -> None:
        """Validate optional upstream metadata; never derive corners from aircraft pose."""
        containers = self._nested_dicts(payload)
        candidates: list[tuple[Any, Any, Any]] = []
        root_data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        fallback_crs = root_data.get("source_crs", payload.get("source_crs"))
        fallback_timestamp = root_data.get(
            "footprint_timestamp_ms",
            payload.get("footprint_timestamp_ms"),
        )

        explicit_device_values = {
            str(container["device_sn"])
            for container in (payload, root_data)
            if "device_sn" in container and container["device_sn"] not in (None, "")
        }
        footprint_present = False
        for container in containers:
            for key in _FOOTPRINT_KEYS:
                if key not in container:
                    continue
                footprint_present = True
                if container.get("device_sn") not in (None, ""):
                    explicit_device_values.add(str(container["device_sn"]))
                raw_footprint = container[key]
                if isinstance(raw_footprint, dict) and raw_footprint.get("device_sn") not in (None, ""):
                    explicit_device_values.add(str(raw_footprint["device_sn"]))
                candidates.append(
                    (
                        raw_footprint,
                        container.get("source_crs", fallback_crs),
                        container.get("footprint_timestamp_ms", fallback_timestamp),
                    )
                )

        if not footprint_present:
            return
        if explicit_device_values and explicit_device_values != {config.target_device_sn}:
            self.current_status.ground_footprint_wgs84 = None
            logger.warning("Rejected WGS84 footprint for a different device")
            return

        try:
            parsed = [
                GroundFootprintWGS84.from_payload(
                    footprint,
                    source_crs=source_crs,
                    footprint_timestamp_ms=timestamp_ms,
                )
                for footprint, source_crs, timestamp_ms in candidates
            ]
            if not parsed or any(candidate != parsed[0] for candidate in parsed[1:]):
                raise ValueError("conflicting footprint_wgs84 values")
            self.current_status.ground_footprint_wgs84 = parsed[0]
        except (TypeError, ValueError) as exc:
            self.current_status.ground_footprint_wgs84 = None
            logger.warning("Rejected invalid WGS84 ground footprint: %s", exc)

    @staticmethod
    def _find_live_status(data: Any) -> tuple[Optional[bool], int]:
        if isinstance(data, dict):
            for key, value in data.items():
                if "live" in key.lower():
                    if isinstance(value, bool):
                        return value, 0
                    if isinstance(value, dict):
                        status = value.get("status")
                        quality = int(_number(value.get("video_quality"), 0))
                        if status is not None:
                            return bool(status) and (quality > 0 or "video_quality" not in value), quality
                    if isinstance(value, list):
                        for item in value:
                            found, quality = MQTTClient._find_live_status({key: item})
                            if found is not None:
                                return found, quality
                found, quality = MQTTClient._find_live_status(value)
                if found is not None:
                    return found, quality
        elif isinstance(data, list):
            for value in data:
                found, quality = MQTTClient._find_live_status(value)
                if found is not None:
                    return found, quality
        return None, 0

    def _handle_state_message(self, payload: Dict[str, Any]) -> None:
        source_time = _payload_time(payload)
        live, quality = self._find_live_status(payload.get("data", {}))
        if live is not None:
            self.current_status.is_live = live
            self.device_live_status[config.target_device_sn] = {
                "is_live": live,
                "video_quality": quality,
                "timestamp": source_time,
            }
        self.current_status.timestamp = source_time
        self._emit_status()

    def _emit_status(self) -> None:
        callback = self.status_callback
        if not callback:
            return
        snapshot = copy.deepcopy(self.current_status)
        loop = self._loop
        if loop and loop.is_running():
            with self._delivery_lock:
                self._pending_status = snapshot
                if self._delivery_scheduled:
                    return
                self._delivery_scheduled = True
            loop.call_soon_threadsafe(self._start_delivery)
            return
        result = callback(snapshot)
        if inspect.isawaitable(result):
            logger.error("状态回调需要运行中的 asyncio 事件循环")
            result.close()

    def _start_delivery(self) -> None:
        callback = self.status_callback
        with self._delivery_lock:
            snapshot = self._pending_status
            self._pending_status = None
        if not callback or snapshot is None:
            with self._delivery_lock:
                self._delivery_scheduled = False
            return
        try:
            result = callback(snapshot)
            if inspect.isawaitable(result):
                task = asyncio.create_task(result)
                task.add_done_callback(self._delivery_finished)
            else:
                self._delivery_finished(None)
        except Exception:
            logger.exception("创建状态回调失败")
            self._delivery_finished(None)

    def _delivery_finished(self, task) -> None:
        if task is not None:
            try:
                task.result()
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception("状态回调执行失败")
        loop = self._loop
        with self._delivery_lock:
            has_pending = self._pending_status is not None
            if not has_pending:
                self._delivery_scheduled = False
        if has_pending and loop and loop.is_running():
            loop.call_soon(self._start_delivery)

    def check_device_online(self, device_sn: str) -> bool:
        status = self.device_online_status.get(device_sn)
        return bool(status and time.time() - status["timestamp"] <= 60 and status["online"])

    def check_device_live(self, device_sn: str) -> bool:
        return bool(self.device_live_status.get(device_sn, {}).get("is_live", False))

    def get_current_status(self) -> DroneStatus:
        return copy.deepcopy(self.current_status)
