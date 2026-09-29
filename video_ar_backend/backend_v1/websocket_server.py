"""Status WebSocket server consumed by the Cesium video AR panel."""
from __future__ import annotations

import asyncio
import logging
from typing import Set

from websockets.exceptions import ConnectionClosed
from websockets.legacy.server import WebSocketServerProtocol, serve

from .config import config
from .models import DroneStatus, MessageType, WebSocketMessage


logger = logging.getLogger(__name__)


class WebSocketServer:
    def __init__(self) -> None:
        self.clients: Set[WebSocketServerProtocol] = set()
        self.server = None
        self.is_running = False

    async def start_server(self) -> None:
        logger.info(
            "启动状态 WebSocket: ws://%s:%s",
            config.websocket.host,
            config.websocket.status_port,
        )
        self.server = await serve(
            self.handle_client,
            config.websocket.host,
            config.websocket.status_port,
            max_size=config.websocket.max_size,
            max_queue=8,
            ping_interval=20,
            ping_timeout=10,
            close_timeout=3,
        )
        self.is_running = True

    async def stop_server(self) -> None:
        self.is_running = False
        clients = tuple(self.clients)
        self.clients.clear()
        if clients:
            await asyncio.gather(*(client.close(code=1001) for client in clients), return_exceptions=True)
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            self.server = None
        logger.info("状态 WebSocket 已停止")

    async def handle_client(self, websocket: WebSocketServerProtocol, _path: str = "") -> None:
        client_address = self._client_address(websocket)
        self.clients.add(websocket)
        logger.info("状态客户端连接: %s", client_address)
        try:
            await self.send_to_client(
                websocket,
                WebSocketMessage(
                    type=MessageType.CONNECTION_STATUS,
                    data={"status": "connected", "message": "状态 WebSocket 连接成功"},
                ).to_json(),
            )
            async for raw_message in websocket:
                try:
                    message = WebSocketMessage.from_json(raw_message)
                    if message.type == "ping":
                        await self.send_to_client(
                            websocket,
                            WebSocketMessage(type="pong", data={"timestamp": message.timestamp}).to_json(),
                        )
                except Exception as exc:
                    await self.send_to_client(
                        websocket,
                        WebSocketMessage(type=MessageType.ERROR, data={"error": str(exc)}).to_json(),
                    )
        except ConnectionClosed:
            pass
        except Exception:
            logger.exception("状态客户端处理失败: %s", client_address)
        finally:
            self.clients.discard(websocket)
            logger.info("状态客户端断开: %s", client_address)

    @staticmethod
    def _client_address(websocket: WebSocketServerProtocol) -> str:
        address = websocket.remote_address
        return f"{address[0]}:{address[1]}" if isinstance(address, tuple) and len(address) >= 2 else "unknown"

    async def send_to_client(self, websocket: WebSocketServerProtocol, payload: str) -> bool:
        try:
            await asyncio.wait_for(websocket.send(payload), timeout=config.websocket.send_timeout)
            return True
        except (ConnectionClosed, asyncio.TimeoutError):
            return False
        except Exception:
            logger.debug("状态消息发送失败", exc_info=True)
            return False

    async def broadcast_drone_status(self, status: DroneStatus) -> None:
        payload = status.to_dict()
        payload["coordinates"] = self._coordinates_payload(status)
        await self.broadcast_message(
            WebSocketMessage(type=MessageType.DRONE_STATUS, data=payload).to_json()
        )

    async def broadcast_coordinates(self, status: DroneStatus) -> None:
        await self.broadcast_message(
            WebSocketMessage(
                type=MessageType.COORDINATES,
                data={
                    "device_sn": status.device_sn,
                    "coordinates": self._coordinates_payload(status),
                    "timestamp": status.timestamp,
                },
            ).to_json()
        )

    @staticmethod
    def _coordinates_payload(status: DroneStatus) -> dict:
        coordinates = status.coordinates.to_dict()
        ground_altitude_m = config.telemetry.ground_altitude_m
        if ground_altitude_m is not None:
            coordinates.update(
                {
                    "ground_altitude_m": ground_altitude_m,
                    "relative_altitude": status.coordinates.altitude - ground_altitude_m,
                }
            )
        return coordinates

    async def broadcast_gimbal_attitude(self, status: DroneStatus) -> None:
        await self.broadcast_message(
            WebSocketMessage(
                type=MessageType.GIMBAL_ATTITUDE,
                data={
                    "device_sn": status.device_sn,
                    "gimbal_attitude": status.gimbal_attitude.to_dict(),
                    "timestamp": status.timestamp,
                },
            ).to_json()
        )

    async def broadcast_message(self, payload: str) -> None:
        clients = tuple(self.clients)
        if not clients:
            return
        results = await asyncio.gather(
            *(self.send_to_client(client, payload) for client in clients),
            return_exceptions=False,
        )
        for client, sent in zip(clients, results):
            if not sent:
                self.clients.discard(client)

    def get_client_count(self) -> int:
        return len(self.clients)
