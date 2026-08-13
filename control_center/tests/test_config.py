from app.config import load_settings, Settings

def test_loads_udp_port_and_rate_limit_from_repo_config(tmp_path, monkeypatch):
    cfg = tmp_path / "config" / "ddos_sim_config.json"
    cfg.parent.mkdir(parents=True)
    cfg.write_text('{"telemetry_udp_port": 19090, "rate_limit_max_rps": 42,'
                   ' "rate_limit_block_seconds": 7}')
    monkeypatch.setattr("app.config.REPO_ROOT", tmp_path)
    s = load_settings()
    assert s.udp_port == 19090
    assert s.rate_limit_max_rps == 42
    assert s.rate_limit_block_seconds == 7

def test_defaults_when_config_missing(tmp_path, monkeypatch):
    monkeypatch.setattr("app.config.REPO_ROOT", tmp_path / "nope")
    s = load_settings()
    assert s.udp_port == 9090
    assert s.stale_threshold_s == 2.5
    assert s.history_len == 120
    assert s.blocks_cap == 64
    assert s.rate_limit_max_rps == 2
    assert s.rate_limit_block_seconds == 10
