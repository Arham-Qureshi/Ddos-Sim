from app.state import AppState
from app.schemas import TelemetryFrame, Metrics
from app.config import Settings


def frame(ts: int) -> TelemetryFrame:
    return TelemetryFrame(timestamp=ts, metrics=Metrics(normal_rps=ts))


async def test_update_sets_latest_and_caps_history():
    s = AppState(Settings(history_len=3))
    for i in range(5):
        await s.update(frame(i))
    assert s.latest is not None and s.latest.timestamp == 4
    assert [f.timestamp for f in s.history_snapshot()] == [2, 3, 4]  # capped at 3


async def test_engine_connected_when_fresh_and_lost_when_stale():
    s = AppState(Settings(stale_threshold_s=2.5))
    await s.update(frame(1), now=1000.0)
    assert s.engine_connected(now=1002.0) is True
    assert s.engine_connected(now=1003.0) is False  # > 2.5s
    assert s.last_rx_age_s(now=1003.0) == 3.0


async def test_engine_never_seen_is_disconnected():
    s = AppState(Settings(stale_threshold_s=2.5))
    assert s.engine_connected(now=1000.0) is False


async def test_record_dropped_and_blocks_ledger_capped():
    s = AppState(Settings(blocks_cap=2))
    await s.record_dropped()
    assert s.dropped_frames == 1
    await s.update(frame(1), now=1.0)
    await s.record_blocks([{"vip": "10.0.0.1", "unblock_ts": 100}], now=1.0)
    await s.record_blocks([{"vip": "10.0.0.2", "unblock_ts": 100}], now=1.0)
    await s.record_blocks([{"vip": "10.0.0.3", "unblock_ts": 100}], now=1.0)
    snap = s.recent_blocks_snapshot()
    assert [b.vip for b in snap] == ["10.0.0.2", "10.0.0.3"]
