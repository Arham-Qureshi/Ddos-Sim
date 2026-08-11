from __future__ import annotations
import asyncio
import json
import logging

from app.config import Settings
from app.schemas import TelemetryFrame
from app.state import AppState

logger = logging.getLogger(__name__)


def parse_frame(data: bytes) -> TelemetryFrame | None:
    if not data:
        return None
    try:
        payload = json.loads(data.decode("utf-8", errors="replace"))
        return TelemetryFrame.model_validate(payload)
    except (ValueError, UnicodeDecodeError) as exc:
        logger.warning("ignoring malformed telemetry frame: %s", exc)
        return None


class _Protocol(asyncio.DatagramProtocol):
    def __init__(self, state: AppState) -> None:
        self.state = state
        self.done = asyncio.get_running_loop().create_future()

    def datagram_received(self, data: bytes, addr) -> None:
        frame = parse_frame(data)
        if frame is None:
            asyncio.create_task(self.state.record_dropped())
        else:
            asyncio.create_task(self.state.update(frame))
            if frame.recent_blocks:
                asyncio.create_task(self.state.record_blocks(
                    [b.model_dump() for b in frame.recent_blocks]))


async def run_udp_listener(state: AppState, settings: Settings) -> None:
    loop = asyncio.get_running_loop()
    try:
        transport, protocol = await loop.create_datagram_endpoint(
            lambda: _Protocol(state),
            local_addr=(settings.udp_host, settings.udp_port),
        )
    except OSError as exc:
        logger.warning("udp_listener failed to bind %s:%s: %s",
                       settings.udp_host, settings.udp_port, exc)
        state.listener_up = False
        return
    logger.info("udp_listener bound to %s:%s", settings.udp_host, settings.udp_port)
    try:
        await protocol.done
    finally:
        transport.close()
