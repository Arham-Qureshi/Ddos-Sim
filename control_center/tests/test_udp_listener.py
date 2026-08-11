import json
import asyncio
import socket
import contextlib
from app.schemas import TelemetryFrame
from app.state import AppState
from app.config import Settings
from services.udp_listener import parse_frame, run_udp_listener


def _free_udp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_parse_frame_valid():
    f = parse_frame(json.dumps({
        "timestamp": 1,
        "metrics": {"normal_rps": 1, "attack_rps": 0, "blocked_rps": 0,
                    "cpu_load_pct": 1, "active_connections": 1},
        "recent_blocks": [],
    }).encode())
    assert isinstance(f, TelemetryFrame)


def test_parse_frame_garbage_returns_none():
    assert parse_frame(b"not json {{{") is None
    assert parse_frame(b"") is None


def test_run_udp_listener_end_to_end():
    async def scenario():
        state = AppState(Settings())
        port = _free_udp_port()
        task = asyncio.create_task(run_udp_listener(state, Settings(udp_port=port)))
        await asyncio.sleep(0.05)
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        payload = json.dumps({"timestamp": 7, "metrics": {
            "normal_rps": 3, "attack_rps": 0, "blocked_rps": 0,
            "cpu_load_pct": 0, "active_connections": 2}, "recent_blocks": []})
        sock.sendto(payload.encode(), ("127.0.0.1", port))
        for _ in range(100):
            if state.latest is not None:
                break
            await asyncio.sleep(0.01)
        sock.sendto(b"garbage###", ("127.0.0.1", port))
        await asyncio.sleep(0.05)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        assert state.latest is not None and state.latest.timestamp == 7
        assert state.dropped_frames == 1

    asyncio.run(scenario())


def test_bind_failure_sets_listener_down():
    async def scenario():
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as blocker:
            blocker.bind(("127.0.0.1", 0))
            port = blocker.getsockname()[1]
            state = AppState(Settings())
            await run_udp_listener(state, Settings(udp_port=port))
        assert state.listener_up is False

    asyncio.run(scenario())
