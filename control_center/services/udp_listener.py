from __future__ import annotations
import asyncio
import contextlib
import json
import logging
import time

from app.config import Settings
from app.schemas import TelemetryFrame
from app.state import AppState

logger = logging.getLogger(__name__)

_QUEUE_MAX = 1000


def parse_frame(data: bytes) -> TelemetryFrame | None:
    if not data:
        return None
    try:
        payload = json.loads(data.decode("utf-8", errors="replace"))
        return TelemetryFrame.model_validate(payload)
    except (ValueError, UnicodeDecodeError):
        return None


class _Protocol(asyncio.DatagramProtocol):
    def __init__(self, state: AppState, queue: asyncio.Queue) -> None:
        self.state = state
        self.queue = queue
        self.done = asyncio.get_running_loop().create_future()

    def datagram_received(self, data: bytes, addr) -> None:
        try:
            self.queue.put_nowait(data)
        except asyncio.QueueFull:
            self.state.dropped_frames += 1


async def _consume(state: AppState, queue: asyncio.Queue) -> None:
    last_log = 0.0
    malformed = 0
    while True:
        data = await queue.get()
        frame = parse_frame(data)
        if frame is None:
            malformed += 1
            await state.record_dropped()
            now = time.monotonic()
            if now - last_log >= 1.0:
                logger.warning("ignored %d malformed telemetry frame(s)", malformed)
                last_log = now
                malformed = 0
            continue
        await state.update(frame)
        if frame.recent_blocks:
            await state.record_blocks([b.model_dump() for b in frame.recent_blocks])


async def run_udp_listener(state: AppState, settings: Settings) -> None:
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=_QUEUE_MAX)
    try:
        transport, protocol = await loop.create_datagram_endpoint(
            lambda: _Protocol(state, queue),
            local_addr=(settings.udp_host, settings.udp_port),
        )
    except OSError as exc:
        logger.warning("udp_listener failed to bind %s:%s: %s",
                       settings.udp_host, settings.udp_port, exc)
        state.listener_up = False
        return
    logger.info("udp_listener bound to %s:%s", settings.udp_host, settings.udp_port)
    consumer = asyncio.create_task(_consume(state, queue))
    try:
        await protocol.done
    finally:
        consumer.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await consumer
        transport.close()
