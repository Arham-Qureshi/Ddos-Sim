from __future__ import annotations
import asyncio
import logging
import time
from collections import deque

from app.config import Settings
from app.schemas import BlockRecord, TelemetryFrame

logger = logging.getLogger(__name__)

ATTACK_COOLDOWN_S = 5.0


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
        self._last_attack_at = 0.0

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
                unblock_ts = e.get("unblock_ts", 0)
                prev = self._blocks.get(vip)
                # anchor the ban clock only on first sight or re-ban (unblock_ts
                # changed); keep it stable while the same block keeps streaming in
                if prev is None or prev.unblock_ts != unblock_ts:
                    blocked_at_ms = e.get("blocked_at_ms", int(now * 1000))
                else:
                    blocked_at_ms = prev.blocked_at_ms
                rec = BlockRecord(
                    vip=vip,
                    blocked_at_ms=blocked_at_ms,
                    unblock_ts=unblock_ts,
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

    def recent_blocks_snapshot(self, now: float | None = None) -> list[BlockRecord]:
        now = now if now is not None else time.monotonic()
        now_ms = now * 1000
        snap = []
        for b in self._blocks.values():
            remaining = None
            # permanent bans (unblock_ts == 0) never expire
            if b.unblock_ts != 0 and b.blocked_at_ms is not None:
                remaining = max(
                    0.0,
                    self._settings.rate_limit_block_seconds
                    - (now_ms - b.blocked_at_ms) / 1000.0,
                )
            snap.append(
                BlockRecord(
                    vip=b.vip,
                    blocked_at_ms=b.blocked_at_ms,
                    unblock_ts=b.unblock_ts,
                    remaining_s=remaining,
                )
            )
        return snap

    async def cooldown_remaining(self, now: float | None = None) -> float:
        now = now if now is not None else time.monotonic()
        async with self._lock:
            if self._last_attack_at == 0:
                return 0.0
            return max(0.0, self._last_attack_at + ATTACK_COOLDOWN_S - now)

    async def note_attack_started(self, now: float | None = None) -> None:
        now = now if now is not None else time.monotonic()
        async with self._lock:
            self._last_attack_at = now
