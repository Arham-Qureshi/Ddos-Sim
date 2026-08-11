from __future__ import annotations
import asyncio
import logging
import time
from collections import deque

from app.config import Settings
from app.schemas import BlockRecord, TelemetryFrame

logger = logging.getLogger(__name__)


class AppState:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._lock = asyncio.Lock()
        self.latest: TelemetryFrame | None = None
        self._history: deque[TelemetryFrame] = deque(maxlen=settings.history_len)
        self._blocks: dict[str, BlockRecord] = {}
        self.dropped_frames = 0
        self.listener_up = True
        self.started_at = time.monotonic()
        self._last_rx: float | None = None

    async def update(self, frame: TelemetryFrame, now: float | None = None) -> None:
        now = now if now is not None else time.monotonic()
        async with self._lock:
            self.latest = frame
            self._history.append(frame)
            self._last_rx = now

    async def record_dropped(self) -> None:
        async with self._lock:
            self.dropped_frames += 1

    async def record_blocks(self, entries: list[dict], now: float | None = None) -> None:
        now = now if now is not None else time.monotonic()
        async with self._lock:
            for e in entries:
                vip = e.get("vip")
                if not vip:
                    continue
                rec = BlockRecord(
                    vip=vip,
                    blocked_at_ms=e.get("blocked_at_ms", int(now * 1000)),
                    unblock_ts=e.get("unblock_ts", 0),
                )
                self._blocks[vip] = rec
            while len(self._blocks) > self._settings.blocks_cap:
                self._blocks.pop(next(iter(self._blocks)))

    def engine_connected(self, now: float | None = None) -> bool:
        now = now if now is not None else time.monotonic()
        if self._last_rx is None:
            return False
        return (now - self._last_rx) <= self._settings.stale_threshold_s

    def last_rx_age_s(self, now: float | None = None) -> float | None:
        now = now if now is not None else time.monotonic()
        return None if self._last_rx is None else now - self._last_rx

    def history_snapshot(self) -> list[TelemetryFrame]:
        return list(self._history)

    def recent_blocks_snapshot(self) -> list[BlockRecord]:
        return list(self._blocks.values())
