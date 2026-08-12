import socket
import time

from starlette.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.schemas import Metrics, TelemetryFrame


def _free_udp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _app_with_frame():
    app = create_app(Settings(udp_port=_free_udp_port()))
    return app


def _pump(app, n=1):
    now = time.monotonic()
    for i in range(n):
        frame = TelemetryFrame(
            timestamp=int(now) + i,
            metrics=Metrics(normal_rps=2 + i, attack_rps=100 * i, blocked_rps=5),
        )
        app.state.state._history.append(frame)
        app.state.state.latest = frame


def test_ws_telemetry_pushes_live_frames():
    app = _app_with_frame()
    _pump(app)
    with TestClient(app) as c:
        with c.websocket_connect("/api/ws/telemetry") as ws:
            data = ws.receive_json()
            assert data is not None
            for key in ("ts", "normal_rps", "attack_rps", "blocked_rps",
                        "cpu_load_pct", "active_connections", "blocks"):
                assert key in data


def test_ws_telemetry_ticks_at_2hz():
    app = _app_with_frame()
    _pump(app, n=2)
    with TestClient(app) as c:
        with c.websocket_connect("/api/ws/telemetry") as ws:
            start = time.monotonic()
            for _ in range(3):
                ws.receive_json()
            elapsed = time.monotonic() - start
            # 3 frames at ~0.5s spacing => between ~1.0s and ~2.5s
            assert 1.0 <= elapsed <= 2.5


def test_ws_telemetry_frame_tracks_latest():
    app = _app_with_frame()
    _pump(app)
    with TestClient(app) as c:
        with c.websocket_connect("/api/ws/telemetry") as ws:
            got = ws.receive_json()
            assert got["attack_rps"] == 0


def test_ws_telemetry_starts_null_without_data():
    with TestClient(create_app(Settings(udp_port=_free_udp_port()))) as c:
        with c.websocket_connect("/api/ws/telemetry") as ws:
            assert ws.receive_json() is None


def test_ws_telemetry_disconnect_is_clean():
    app = _app_with_frame()
    with TestClient(app) as c:
        with c.websocket_connect("/api/ws/telemetry") as ws:
            ws.receive_json()
        # exiting the context manager closed the socket; app stays healthy
        assert c.get("/api/health").status_code == 200


def test_cors_headers_present():
    with TestClient(create_app(Settings(udp_port=_free_udp_port()))) as c:
        r = c.get("/api/health", headers={"Origin": "http://localhost:8081"})
        assert "access-control-allow-origin" in r.headers


def test_ws_telemetry_route_is_listed():
    app = create_app(Settings(udp_port=_free_udp_port()))
    assert app.url_path_for("ws_telemetry") == "/api/ws/telemetry"