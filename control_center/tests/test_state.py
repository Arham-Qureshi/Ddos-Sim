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
    snap = s.recent_blocks_snapshot(now=2.0)
    assert [b.vip for b in snap] == ["10.0.0.2", "10.0.0.3"]


async def test_block_anchor_is_stable_while_streaming():
    s = AppState(Settings(rate_limit_block_seconds=10))
    # first sight anchors the clock
    await s.record_blocks([{"vip": "10.0.0.9", "unblock_ts": 500}], now=10.0)
    first_at = s.recent_blocks_snapshot(now=11.0)[0].blocked_at_ms
    # repeat frames of the same block must NOT re-anchor
    await s.record_blocks([{"vip": "10.0.0.9", "unblock_ts": 500}], now=12.0)
    await s.record_blocks([{"vip": "10.0.0.9", "unblock_ts": 500}], now=14.0)
    assert s.recent_blocks_snapshot(now=15.0)[0].blocked_at_ms == first_at


async def test_reban_reanchors_clock():
    s = AppState(Settings(rate_limit_block_seconds=10))
    await s.record_blocks([{"vip": "10.0.0.9", "unblock_ts": 500}], now=10.0)
    # a fresh ban with a new unblock_ts resets the countdown
    await s.record_blocks([{"vip": "10.0.0.9", "unblock_ts": 900}], now=20.0)
    assert s.recent_blocks_snapshot(now=21.0)[0].blocked_at_ms == 20000


async def test_remaining_s_counts_down_and_lifted_ban_leaves_snapshot():
    s = AppState(Settings(rate_limit_block_seconds=10))
    await s.record_blocks([{"vip": "10.0.0.9", "unblock_ts": 500}], now=10.0)
    # anchored at 10s, block lasts 10s -> 9s left at now=11s
    assert s.recent_blocks_snapshot(now=11.0)[0].remaining_s == 9.0
    # once the countdown hits zero the ban has been lifted: it leaves the list
    assert s.recent_blocks_snapshot(now=30.0) == []


async def test_expired_temp_ban_leaves_but_permanent_ban_stays():
    s = AppState(Settings(rate_limit_block_seconds=10))
    await s.record_blocks([{"vip": "10.0.0.9", "unblock_ts": 500}], now=10.0)
    await s.record_blocks([{"vip": "10.0.0.8", "unblock_ts": 0}], now=10.0)
    vips = {b.vip for b in s.recent_blocks_snapshot(now=30.0)}
    assert vips == {"10.0.0.8"}  # temp expired away, manual permanent stays


async def test_permanent_ban_has_no_countdown():
    s = AppState(Settings(rate_limit_block_seconds=10))
    await s.record_blocks([{"vip": "10.0.0.9", "unblock_ts": 0}], now=10.0)
    assert s.recent_blocks_snapshot()[0].remaining_s is None
