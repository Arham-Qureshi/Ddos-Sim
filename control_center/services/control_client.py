from __future__ import annotations
import asyncio
import contextlib
import logging

logger = logging.getLogger(__name__)


class EngineUnavailable(Exception):
    """the C++ engine's control channel is unreachable (not running?)"""


# bound concurrent control connections: each command is its own short TCP
# round-trip, so a flood of them must not pile up open sockets. A running-loop
# capture keeps the semaphore bound to the loop that actually calls us (a
# plain module-level Semaphore would bind to a stale import-time loop and hang).
_loop_sems: dict[int, asyncio.Semaphore] = {}


def _capture_sem() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    key = id(loop)
    sem = _loop_sems.get(key)
    if sem is None:
        sem = asyncio.Semaphore(4)
        _loop_sems[key] = sem
    return sem

_MAX_REPLY_BYTES = 1024


async def _roundtrip(cmd: str, host: str, port: int) -> str:
    reader, writer = await asyncio.open_connection(host, port)
    try:
        writer.write(cmd.encode() + b"\n")
        await writer.drain()
        line = await reader.readline()
        if not line:
            raise EngineUnavailable("engine closed the control channel")
        return line.decode("utf-8", errors="replace").strip()[:_MAX_REPLY_BYTES]
    finally:
        writer.close()
        with contextlib.suppress(Exception):
            await writer.wait_closed()


async def send_command(cmd: str, host: str, port: int, timeout: float = 2.0) -> str:
    """send one STRING command, return the reply line, or raise EngineUnavailable."""
    async with _capture_sem():
        try:
            return await asyncio.wait_for(_roundtrip(cmd, host, port), timeout=timeout)
        except (OSError, asyncio.TimeoutError) as exc:
            raise EngineUnavailable(f"engine control channel unreachable ({exc})") from exc