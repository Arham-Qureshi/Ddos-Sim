from app.schemas import TelemetryFrame, RecentBlock, Metrics
import json

def test_parse_real_cpp_frame():
    raw = json.dumps({
        "timestamp": 1700000000,
        "metrics": {"normal_rps": 18, "attack_rps": 0, "blocked_rps": 400,
                    "cpu_load_pct": 12, "active_connections": 3},
        "recent_blocks": [{"vip": "10.0.0.55", "unblock_ts": 17000000001000}],
        "future_unknown_field": {"x": 1},
    })
    f = TelemetryFrame.model_validate_json(raw)
    assert f.metrics.attack_rps == 0
    assert f.metrics.blocked_rps == 400
    assert f.recent_blocks[0].vip == "10.0.0.55"

def test_missing_metrics_default_to_zero():
    f = TelemetryFrame.model_validate_json(json.dumps({"timestamp": 1}))
    assert f.metrics.normal_rps == 0
    assert f.metrics.active_connections == 0
    assert f.recent_blocks == []

def test_parse_decisions_and_algorithm():
    raw = json.dumps({
        "timestamp": 1,
        "metrics": {"normal_rps": 0},
        "algorithm": "sliding_window",
        "decisions": [
            {"vip": "10.0.0.5", "allowed": False, "ts_ms": 1723,
             "tokens": 0.0, "window_count": 4}
        ],
    })
    f = TelemetryFrame.model_validate_json(raw)
    assert f.algorithm == "sliding_window"
    assert len(f.decisions) == 1
    d = f.decisions[0]
    assert d.vip == "10.0.0.5"
    assert d.allowed is False
    assert d.ts_ms == 1723
    assert d.tokens == 0.0
    assert d.window_count == 4


def test_missing_decisions_default_empty():
    f = TelemetryFrame.model_validate_json(json.dumps({"timestamp": 1}))
    assert f.algorithm == "token_bucket"
    assert f.decisions == []
