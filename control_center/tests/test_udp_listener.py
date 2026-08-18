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
        "algorithm": "token_bucket",
        "decisions": [{"vip": "10.0.0.7", "allowed": True, "ts_ms": 100,
                       "tokens": 1.5, "window_count": 0}],
    }).encode())
    assert isinstance(f, TelemetryFrame)
    assert f.algorithm == "token_bucket"
    assert f.decisions[0].vip == "10.0.0.7"


def test_parse_frame_vip_stats():
    f = parse_frame(json.dumps({
        "timestamp": 1,
        "metrics": {"normal_rps": 1, "attack_rps": 0, "blocked_rps": 0,
                    "cpu_load_pct": 1, "active_connections": 1},
        "recent_blocks": [],
        "algorithm": "token_bucket",
        "decisions": [],
        "vip_stats": [{"vip": "10.0.0.7", "active_rps": 18, "sent": 142,
                       "blocked": 127, "worker_id": 2}],
    }).encode())
    assert isinstance(f, TelemetryFrame)
    assert len(f.vip_stats) == 1
    s = f.vip_stats[0]
    assert s.vip == "10.0.0.7"
    assert s.active_rps == 18
    assert s.sent == 142
    assert s.blocked == 127
    assert s.worker_id == 2


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


def test_recent_blocks_populate_ledger():
    def payload(ts, blocks):
        return json.dumps({"timestamp": ts, "metrics": {
            "normal_rps": 1, "attack_rps": 0, "blocked_rps": 0,
            "cpu_load_pct": 0, "active_connections": 1},
            "recent_blocks": blocks}).encode()

    async def wait_for(predicate, timeout_s=1.0):
        elapsed = 0.0
        while elapsed < timeout_s:
            if predicate():
                return
            await asyncio.sleep(0.01)
            elapsed += 0.01
        raise AssertionError("timed out waiting for condition")

    async def scenario():
        state = AppState(Settings())
        port = _free_udp_port()
        task = asyncio.create_task(run_udp_listener(state, Settings(udp_port=port)))
        await asyncio.sleep(0.05)
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.sendto(payload(1, [{"vip": "10.0.0.1", "unblock_ts": 100},
                               {"vip": "10.0.0.2", "unblock_ts": 200}]),
                    ("127.0.0.1", port))
        await wait_for(lambda: len(state.recent_blocks_snapshot()) >= 2)
        sock.sendto(payload(2, [{"vip": "10.0.0.3", "unblock_ts": 300}]),
                    ("127.0.0.1", port))
        await wait_for(lambda: len(state.recent_blocks_snapshot()) >= 3)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        return state

    state = asyncio.run(scenario())
    ledger = state.recent_blocks_snapshot()
    vips = {b.vip for b in ledger}
    assert vips == {"10.0.0.1", "10.0.0.2", "10.0.0.3"}
    assert {b.unblock_ts for b in ledger} == {100, 200, 300}
