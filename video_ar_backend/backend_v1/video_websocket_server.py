"""Dedicated, backpressure-aware video WebSocket server."""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from typing import Set

from websockets.exceptions import ConnectionClosed
from websockets.legacy.server import WebSocketServerProtocol, serve

from .config import config
from .models import VideoFrame


logger = logging.getLogger(__name__)


class VideoWebSocketServer:
    def __init__(self, host: str | None = None, port: int | None = None) -> None:
        self.host = host if host is not None else config.websocket.host
        self.port = port if port is not None else config.websocket.video_port
        self.server = None
        self.clients: Set[WebSocketServerProtocol] = set()
        self.is_running = False
        self.stats = {
            "clients_count": 0,
            "frames_sent": 0,
            "frames_dropped": 0,
            "bytes_sent": 0,
            "last_frame_time": None,
        }

    async def start(self) -> None:
        logger.info("启动视频 WebSocket: ws://%s:%s", self.host, self.port)
        self.server = await serve(
            self.handle_client,
            self.host,
            self.port,
            max_size=128 * 1024,
            max_queue=2,
            ping_interval=20,
            ping_timeout=10,
            close_timeout=3,
        )
        self.is_running = True

    async def stop(self) -> None:
        self.is_running = False
        clients = tuple(self.clients)
        self.clients.clear()
        if clients:
            await asyncio.gather(*(client.close(code=1001) for client in clients), return_exceptions=True)
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            self.server = None
        self.stats["clients_count"] = 0
        logger.info("视频 WebSocket 已停止")

    async def handle_client(self, websocket: WebSocketServerProtocol, _path: str = "") -> None:
        client_address = self._client_address(websocket)
        self.clients.add(websocket)
        self.stats["clients_count"] = len(self.clients)
        logger.info("视频客户端连接: %s", client_address)
        try:
            await self.send_to_client(
                websocket,
                json.dumps(
                    {
                        "type": "connection_established",
                        "data": {"server_type": "video_stream", "timestamp": time.time()},
                    },
                    separators=(",", ":"),
                ),
            )
            async for raw_message in websocket:
                try:
                    message = json.loads(raw_message)
                except (json.JSONDecodeError, TypeError):
                    continue
                if message.get("type") == "ping":
                    await self.send_to_client(
                        websocket,
                        json.dumps({"type": "pong", "data": {"timestamp": time.time()}}, separators=(",", ":")),
                    )
                elif message.get("type") == "get_stats":
                    await self.send_to_client(
                        websocket,
                        json.dumps({"type": "stats", "data": self.get_stats()}, separators=(",", ":")),
                    )
        except ConnectionClosed:
            pass
        except Exception:
            logger.exception("视频客户端处理失败: %s", client_address)
        finally:
            self.clients.discard(websocket)
            self.stats["clients_count"] = len(self.clients)
            logger.info("视频客户端断开: %s", client_address)

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
            logger.debug("视频帧发送失败", exc_info=True)
            return False

    async def broadcast_video_frame(self, device_sn: str, frame: VideoFrame) -> None:
        clients = tuple(self.clients)
        if not clients:
            return
        frame_base64 = base64.b64encode(frame.frame_data).decode("ascii")
        frame_payload = {
            "device_sn": device_sn,
            "frame": frame_base64,
            "timestamp": frame.timestamp,
            "width": frame.width,
            "height": frame.height,
            "format": frame.format,
        }
        if frame.ground_footprint_wgs84 is not None:
            frame_payload.update(frame.ground_footprint_wgs84.wire_metadata())
        payload = json.dumps(
            {
                "type": "video_frame",
                "data": frame_payload,
            },
            separators=(",", ":"),
        )
        results = await asyncio.gather(
            *(self.send_to_client(client, payload) for client in clients),
            return_exceptions=False,
        )
        sent_count = 0
        for client, sent in zip(clients, results):
            if sent:
                sent_count += 1
            else:
                self.clients.discard(client)
        if sent_count:
            self.stats["frames_sent"] += 1
            self.stats["bytes_sent"] += len(frame.frame_data) * sent_count
            self.stats["last_frame_time"] = time.time()
        else:
            self.stats["frames_dropped"] += 1
        self.stats["clients_count"] = len(self.clients)

    def get_stats(self) -> dict:
        return self.stats.copy()

    def get_client_count(self) -> int:
        return len(self.clients)
