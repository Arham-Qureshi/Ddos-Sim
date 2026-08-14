import asyncio
import socket
from contextlib import asynccontextmanager

import pytest
from fastapi.testclient import TestClient

from api import v1 as _v1mod  # noqa: F401  (ensures router import path)
import services.control_client as cc
from app.config import Settings
from app.main import create_app


def _free_udp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _app(monkeypatch, responder):
    calls = []

    async def fake(cmd, host, port, timeout=2.0):
        calls.append(cmd)
        if callable(responder):
            return responder(cmd)
        return "OK:DUMMY"

    monkeypatch.setattr("api.v1.control.send_command", fake)
    app = create_app(Settings(udp_port=_free_udp_port(), control_port=9091))
    app.test_calls = calls
    return app


# ---- send_command unit tests (real loopback sockets, no C++ engine) ----

@asynccontextmanager
async def _echo_server():
    async def handle(reader, writer):
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                writer.write(line)
                await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()
    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        yield "127.0.0.1", port
    finally:
        server.close()
        await server.wait_closed()


async def test_send_command_roundtrip_framing():
    async with _echo_server() as (host, port):
        reply = await cc.send_command("CMD_GET_STATUS", host, port, timeout=2.0)
        assert reply == "CMD_GET_STATUS"


async def test_send_command_engine_dark_raises():
    # grab an ephemeral port then release it so nothing is listening
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    with pytest.raises(cc.EngineUnavailable):
        await cc.send_command("CMD_GET_STATUS", "127.0.0.1", port, timeout=0.5)


# ---- /api/control endpoints ----

def test_attack_ok_maps_reply(monkeypatch):
    app = _app(monkeypatch, lambda cmd: "OK:ATTACK_STARTED 123")
    with TestClient(app) as c:
        r = c.post("/api/control/attack",
                   json={"rps": 200, "threads": 4, "duration": 3})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["reply"] == "OK:ATTACK_STARTED 123"
    assert app.test_calls == ["CMD_START_ATTACK 200 4 3"]


def test_attack_second_start_hits_cooldown(monkeypatch):
    app = _app(monkeypatch, lambda cmd: "OK:ATTACK_STARTED 9")
    with TestClient(app) as c:
        first = c.post("/api/control/attack", json={"rps": 100, "threads": 2, "duration": 2})
        second = c.post("/api/control/attack", json={"rps": 100, "threads": 2, "duration": 2})
    assert first.status_code == 200
    assert second.status_code == 429
    assert "cooldown" in second.json()["detail"]["reply"]


def test_attack_rps_below_min_rejected(monkeypatch):
    app = _app(monkeypatch, lambda cmd: "OK:DUMMY")
    with TestClient(app) as c:
        r = c.post("/api/control/attack", json={"rps": 5, "threads": 4, "duration": 3})
    assert r.status_code == 422
    assert app.test_calls == []  # engine never contacted


def test_attack_rps_above_cap_rejected(monkeypatch):
    app = _app(monkeypatch, lambda cmd: "OK:DUMMY")
    with TestClient(app) as c:
        r = c.post("/api/control/attack", json={"rps": 2000, "threads": 4, "duration": 3})
    assert r.status_code == 422


def test_engine_offline_gives_503(monkeypatch):
    app = _app(monkeypatch, lambda cmd: (_ for _ in ()).throw(cc.EngineUnavailable("down")))
    with TestClient(app) as c:
        r = c.post("/api/control/attack", json={"rps": 100, "threads": 2, "duration": 2})
    assert r.status_code == 503
    assert r.json()["detail"]["engine_reachable"] is False


def test_attack_stop_maps_reply(monkeypatch):
    app = _app(monkeypatch, lambda cmd: "ERR:NO_ATTACK_RUNNING")
    with TestClient(app) as c:
        r = c.post("/api/control/attack/stop")
    assert r.status_code == 200
    assert r.json() == {"ok": False, "reply": "ERR:NO_ATTACK_RUNNING",
                        "engine_reachable": True}


def test_mitigation_toggle_sends_off(monkeypatch):
    app = _app(monkeypatch, lambda cmd: "OK:MITIGATION off")
    with TestClient(app) as c:
        r = c.post("/api/control/mitigation", json={"enabled": False})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert app.test_calls == ["CMD_SET_MITIGATION off"]


def test_ban_rejects_invalid_vip(monkeypatch):
    app = _app(monkeypatch, lambda cmd: "OK:DUMMY")
    with TestClient(app) as c:
        bad1 = c.post("/api/control/vips/ban", json={"vip": "999.1.1.1"})
        bad2 = c.post("/api/control/vips/ban", json={"vip": "127.0.0.1"})
        good = c.post("/api/control/vips/ban", json={"vip": "10.0.0.9"})
    assert bad1.status_code == 422
    assert bad2.status_code == 422
    assert good.status_code == 200
    assert app.test_calls == ["CMD_BAN_VIP 10.0.0.9"]


def test_unban_sends_command(monkeypatch):
    app = _app(monkeypatch, lambda cmd: "OK:UNBANNED 10.0.0.9")
    with TestClient(app) as c:
        r = c.post("/api/control/vips/unban", json={"vip": "10.0.0.9"})
    assert r.json()["reply"] == "OK:UNBANNED 10.0.0.9"
    assert app.test_calls == ["CMD_UNBAN_VIP 10.0.0.9"]


def test_status_parses_engine_reply(monkeypatch):
    app = _app(monkeypatch, lambda cmd: 'OK:STATUS {"mitigation":true,"algorithm":"token_bucket","attack_running":true,"pid":42,"baseline_running":false,"baseline_bots":0,"attack_params":{"rps":200,"threads":4,"duration":3}}')
    with TestClient(app) as c:
        r = c.get("/api/control/status")
    assert r.status_code == 200
    assert r.json() == {"mitigation_on": True, "algorithm": "token_bucket",
                        "attack_running": True, "pid": 42,
                        "baseline_running": False, "baseline_bots": 0,
                        "attack_params": {"rps": 200, "threads": 4, "duration": 3},
                        "engine_reachable": True}


def test_status_reports_engine_down(monkeypatch):
    app = _app(monkeypatch, lambda cmd: (_ for _ in ()).throw(cc.EngineUnavailable("down")))
    with TestClient(app) as c:
        r = c.get("/api/control/status")
    assert r.status_code == 200
    assert r.json()["engine_reachable"] is False
    assert r.json()["attack_running"] is False


def test_status_parses_algorithm_and_baseline(monkeypatch):
    app = _app(monkeypatch, lambda cmd: (
        'OK:STATUS {"mitigation":true,"algorithm":"sliding_window",'
        '"attack_running":false,"pid":0,"baseline_running":true,'
        '"baseline_bots":6,"attack_params":{"rps":200,"threads":4,"duration":3}}'))
    with TestClient(app) as c:
        r = c.get("/api/control/status")
    assert r.status_code == 200
    body = r.json()
    assert body["algorithm"] == "sliding_window"
    assert body["baseline_running"] is True
    assert body["baseline_bots"] == 6
    assert body["attack_params"] == {"rps": 200, "threads": 4, "duration": 3}


def test_algorithm_switch_maps_payload(monkeypatch):
    app = _app(monkeypatch, lambda cmd: "OK:ALGORITHM sliding_window")
    with TestClient(app) as c:
        r = c.post("/api/control/algorithm", json={"algorithm": "sliding_window"})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert app.test_calls == ["CMD_SET_ALGORITHM sliding_window"]


def test_algorithm_invalid_rejected(monkeypatch):
    app = _app(monkeypatch, lambda cmd: "OK:DUMMY")
    with TestClient(app) as c:
        r = c.post("/api/control/algorithm", json={"algorithm": "leap_year"})
    assert r.status_code == 422
    assert app.test_calls == []  # engine never contacted


def test_baseline_on_maps_payload(monkeypatch):
    app = _app(monkeypatch, lambda cmd: "OK:BASELINE_STARTED 99")
    with TestClient(app) as c:
        r = c.post("/api/control/baseline", json={"enabled": True, "bots": 6})
    assert r.status_code == 200
    assert app.test_calls == ["CMD_SET_BASELINE on 6"]


def test_baseline_off_maps_payload(monkeypatch):
    app = _app(monkeypatch, lambda cmd: "OK:BASELINE_STOPPED")
    with TestClient(app) as c:
        r = c.post("/api/control/baseline", json={"enabled": False})
    assert r.status_code == 200
    assert app.test_calls == ["CMD_SET_BASELINE off"]


def test_baseline_bots_out_of_range_rejected(monkeypatch):
    app = _app(monkeypatch, lambda cmd: "OK:DUMMY")
    with TestClient(app) as c:
        r = c.post("/api/control/baseline", json={"enabled": True, "bots": 0})
    assert r.status_code == 422
    assert app.test_calls == []


def test_emergency_stop_maps_payload(monkeypatch):
    app = _app(monkeypatch, lambda cmd: "OK:EMERGENCY_STOP")
    with TestClient(app) as c:
        r = c.post("/api/control/emergency-stop")
    assert r.status_code == 200 and r.json()["ok"] is True
    assert app.test_calls == ["CMD_EMERGENCY_STOP"]


def test_new_endpoints_engine_dark_gives_503(monkeypatch):
    app = _app(monkeypatch, lambda cmd: (_ for _ in ()).throw(cc.EngineUnavailable("down")))
    with TestClient(app) as c:
        algo = c.post("/api/control/algorithm", json={"algorithm": "token_bucket"})
        base = c.post("/api/control/baseline", json={"enabled": True, "bots": 4})
        stop = c.post("/api/control/emergency-stop")
    for r in (algo, base, stop):
        assert r.status_code == 503
        assert r.json()["detail"]["engine_reachable"] is False